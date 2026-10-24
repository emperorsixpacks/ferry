//! FerryLock events for one swap, and the shares that claims and refunds reveal.

use alloy::primitives::{Address, B256, U256};
use alloy::rpc::types::{Filter, Log};
use alloy::sol_types::{SolEvent, SolEventInterface, SolInterface};

use crate::bindings::FerryLock;
use crate::{address, Error, EvmClient, Terms};

/// What happened to a swap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapEventKind {
    Locked(Terms),
    Ready,
    /// Z's share `z` (big-endian secp256k1 scalar), public from here on.
    Claimed {
        z: [u8; 32],
        caller: Address,
        tip: U256,
    },
    /// B's share `b` (big-endian secp256k1 scalar), public from here on.
    Refunded {
        b: [u8; 32],
    },
    Punished,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapEvent {
    pub id: B256,
    pub kind: SwapEventKind,
    pub block_number: u64,
    pub tx_hash: B256,
    pub log_index: u64,
}

impl SwapEvent {
    /// Decode a FerryLock log (None for logs of other contracts or events).
    pub fn from_log(log: &Log) -> Option<SwapEvent> {
        let decoded = FerryLock::FerryLockEvents::decode_log(&log.inner).ok()?;
        let (id, kind) = match decoded.data {
            FerryLock::FerryLockEvents::Locked(e) => (
                e.id,
                SwapEventKind::Locked(Terms {
                    token: e.token,
                    amount: e.amount,
                    zAddr: e.zAddr,
                    bAddr: e.bAddr,
                    claimer: e.claimer,
                    refunder: e.refunder,
                    t1: e.t1,
                    t2: e.t2,
                    maxTip: e.maxTip,
                }),
            ),
            FerryLock::FerryLockEvents::Ready(e) => (e.id, SwapEventKind::Ready),
            FerryLock::FerryLockEvents::Claimed(e) => (
                e.id,
                SwapEventKind::Claimed {
                    z: e.z.to_be_bytes(),
                    caller: e.caller,
                    tip: e.tip,
                },
            ),
            FerryLock::FerryLockEvents::Refunded(e) => (
                e.id,
                SwapEventKind::Refunded {
                    b: e.b.to_be_bytes(),
                },
            ),
            FerryLock::FerryLockEvents::Punished(e) => (e.id, SwapEventKind::Punished),
        };
        Some(SwapEvent {
            id,
            kind,
            block_number: log.block_number?,
            tx_hash: log.transaction_hash?,
            log_index: log.log_index?,
        })
    }

    /// The share this event reveals, checked against the address the lock committed to
    /// (`terms.zAddr` for a claim, `terms.bAddr` for a refund).
    pub fn revealed_share(&self, terms: &Terms) -> Result<Option<[u8; 32]>, Error> {
        let (k, expected) = match &self.kind {
            SwapEventKind::Claimed { z, .. } => (*z, terms.zAddr),
            SwapEventKind::Refunded { b } => (*b, terms.bAddr),
            _ => return Ok(None),
        };
        address::verify_share(&k, expected)?;
        Ok(Some(k))
    }
}

/// A share in a claim or refund transaction's input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Revealed {
    Claim { id: B256, z: [u8; 32] },
    Refund { id: B256, b: [u8; 32] },
}

impl Revealed {
    pub fn id(&self) -> B256 {
        match self {
            Revealed::Claim { id, .. } | Revealed::Refund { id, .. } => *id,
        }
    }

    pub fn scalar(&self) -> [u8; 32] {
        match self {
            Revealed::Claim { z, .. } => *z,
            Revealed::Refund { b, .. } => *b,
        }
    }
}

/// Decode a `claim` or `refund` call. The scalar is public as soon as the transaction is,
/// whether or not it succeeds, which is why the daemon's timing rules exist.
pub fn revealed_in_calldata(input: &[u8]) -> Option<Revealed> {
    match FerryLock::FerryLockCalls::abi_decode(input).ok()? {
        FerryLock::FerryLockCalls::claim(c) => Some(Revealed::Claim {
            id: c.id,
            z: c.z.to_be_bytes(),
        }),
        FerryLock::FerryLockCalls::refund(c) => Some(Revealed::Refund {
            id: c.id,
            b: c.b.to_be_bytes(),
        }),
        _ => None,
    }
}

/// Polls the contract's logs for one swap, block range by block range, reporting each event
/// once it has `confirmations` confirmations.
#[derive(Clone, Debug)]
pub struct SwapWatcher {
    id: B256,
    next_block: u64,
    confirmations: u64,
}

impl SwapWatcher {
    /// Watch `id` from `from_block` (the lock's block, or the block before it was sent).
    pub fn new(id: B256, from_block: u64, confirmations: u64) -> Self {
        SwapWatcher {
            id,
            next_block: from_block,
            confirmations: confirmations.max(1),
        }
    }

    pub fn next_block(&self) -> u64 {
        self.next_block
    }

    /// New events since the last poll, oldest first.
    pub async fn poll(&mut self, client: &EvmClient) -> Result<Vec<SwapEvent>, Error> {
        let head = client.block_number().await?;
        let Some(to) = (head + 1).checked_sub(self.confirmations) else {
            return Ok(vec![]);
        };
        if to < self.next_block {
            return Ok(vec![]);
        }
        let events = client.events(self.id, self.next_block, to).await?;
        self.next_block = to + 1;
        Ok(events)
    }
}

impl EvmClient {
    /// The swap's events in `[from, to]`, queried in chunks public RPCs accept.
    pub async fn events(&self, id: B256, from: u64, to: u64) -> Result<Vec<SwapEvent>, Error> {
        use alloy::providers::Provider;
        let mut out = vec![];
        let mut start = from;
        while start <= to {
            let end = to.min(start.saturating_add(self.log_chunk - 1));
            let filter = Filter::new()
                .address(self.contract())
                .event_signature(vec![
                    FerryLock::Locked::SIGNATURE_HASH,
                    FerryLock::Ready::SIGNATURE_HASH,
                    FerryLock::Claimed::SIGNATURE_HASH,
                    FerryLock::Refunded::SIGNATURE_HASH,
                    FerryLock::Punished::SIGNATURE_HASH,
                ])
                .topic1(id)
                .from_block(start)
                .to_block(end);
            let logs = self.provider().get_logs(&filter).await?;
            out.extend(logs.iter().filter_map(SwapEvent::from_log));
            start = end + 1;
        }
        out.sort_by_key(|e| (e.block_number, e.log_index));
        Ok(out)
    }

    /// The share revealed by a claim or refund transaction's input, if `tx` is one (mined,
    /// pending or reverted alike).
    pub async fn revealed_in_tx(&self, tx: B256) -> Result<Option<Revealed>, Error> {
        use alloy::consensus::Transaction as _;
        use alloy::providers::Provider;
        let Some(tx) = self.provider().get_transaction_by_hash(tx).await? else {
            return Ok(None);
        };
        if tx.inner.to() != Some(self.contract()) {
            return Ok(None);
        }
        Ok(revealed_in_calldata(tx.inner.input()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::sol_types::SolCall;

    #[test]
    fn calldata_roundtrip() {
        let id = B256::repeat_byte(7);
        let z = U256::from(0xdead_beef_u64) << 200;
        let claim = FerryLock::claimCall {
            id,
            z,
            tip: U256::from(5),
        }
        .abi_encode();
        assert_eq!(
            revealed_in_calldata(&claim),
            Some(Revealed::Claim {
                id,
                z: z.to_be_bytes()
            })
        );
        let refund = FerryLock::refundCall { id, b: z }.abi_encode();
        let r = revealed_in_calldata(&refund).unwrap();
        assert_eq!((r.id(), r.scalar()), (id, z.to_be_bytes()));
        assert_eq!(
            revealed_in_calldata(&FerryLock::punishCall { id }.abi_encode()),
            None
        );
        assert_eq!(revealed_in_calldata(&[1, 2, 3]), None);
    }

    #[test]
    fn revealed_share_is_checked() {
        let k = alloy::signers::local::PrivateKeySigner::random();
        let scalar: [u8; 32] = k.credential().to_bytes().into();
        let terms = Terms {
            token: Address::ZERO,
            amount: U256::ZERO,
            zAddr: k.address(),
            bAddr: Address::repeat_byte(1),
            claimer: Address::ZERO,
            refunder: Address::ZERO,
            t1: 0,
            t2: 0,
            maxTip: U256::ZERO,
        };
        let ev = |kind| SwapEvent {
            id: B256::ZERO,
            kind,
            block_number: 1,
            tx_hash: B256::ZERO,
            log_index: 0,
        };
        let claimed = ev(SwapEventKind::Claimed {
            z: scalar,
            caller: Address::ZERO,
            tip: U256::ZERO,
        });
        assert_eq!(claimed.revealed_share(&terms).unwrap(), Some(scalar));
        // The same scalar as a refund is checked against bAddr and refused.
        let refunded = ev(SwapEventKind::Refunded { b: scalar });
        assert!(refunded.revealed_share(&terms).is_err());
        assert_eq!(
            ev(SwapEventKind::Ready).revealed_share(&terms).unwrap(),
            None
        );
    }
}
