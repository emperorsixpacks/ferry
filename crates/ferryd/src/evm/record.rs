//! Persistent per-swap record of an EVM swap: the state machine plus everything needed to
//! resume and to render the UI view. One JSON file per swap under `<data-dir>/evm-swaps`.

use std::path::{Path, PathBuf};

use ferry_core::evm::{EvmAction, EvmEnvelope, EvmMessage, EvmSwap, LockTerms};
use ferry_core::{Role, Secret32};
use serde::{Deserialize, Serialize};

use crate::record::{private_dir, state_label, write_private, TimelineEntry};

/// An [`EvmAction`] not executed yet, in a form that survives a restart.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvmPending {
    Send {
        envelope: Box<EvmEnvelope>,
    },
    Lock {
        salt: String,
        terms: LockTerms,
    },
    SignReady {
        digest: String,
    },
    Claim {
        id: String,
        z: Secret32,
        ready_sig: String,
        not_after: u64,
    },
    Refund {
        id: String,
        b: Secret32,
        not_before: u64,
        not_after: u64,
    },
    Punish {
        id: String,
    },
    SendZec {
        fvk: String,
        amount: u64,
    },
    SweepZec {
        fvk: String,
        ask: Secret32,
    },
}

impl EvmPending {
    /// Needs no chain, node or wallet: a message to the peer, or signing Ready(id) with our key.
    /// The only kinds a peer or API handler runs itself (see `EvmDaemon::drive_local`).
    pub fn is_local(&self) -> bool {
        matches!(self, EvmPending::Send { .. } | EvmPending::SignReady { .. })
    }

    pub fn is_zec(&self) -> bool {
        matches!(
            self,
            EvmPending::SendZec { .. } | EvmPending::SweepZec { .. }
        )
    }
}

impl From<EvmAction> for EvmPending {
    fn from(a: EvmAction) -> EvmPending {
        match a {
            EvmAction::SendMessage(envelope) => EvmPending::Send {
                envelope: Box::new(envelope),
            },
            EvmAction::Lock { salt, terms } => EvmPending::Lock {
                salt: hex::encode(salt),
                terms,
            },
            EvmAction::SignReady { digest } => EvmPending::SignReady {
                digest: hex::encode(digest),
            },
            EvmAction::Claim {
                id,
                z,
                ready_sig,
                not_after,
            } => EvmPending::Claim {
                id: hex::encode(id),
                z,
                ready_sig: hex::encode(ready_sig),
                not_after,
            },
            EvmAction::Refund {
                id,
                b,
                not_before,
                not_after,
            } => EvmPending::Refund {
                id: hex::encode(id),
                b,
                not_before,
                not_after,
            },
            EvmAction::Punish { id } => EvmPending::Punish {
                id: hex::encode(id),
            },
            EvmAction::SendZec { joint_fvk, amount } => EvmPending::SendZec {
                fvk: hex::encode(joint_fvk),
                amount,
            },
            EvmAction::SweepZec { joint_fvk, ask } => EvmPending::SweepZec {
                fvk: hex::encode(joint_fvk),
                ask,
            },
        }
    }
}

pub fn bytes<const N: usize>(s: &str) -> [u8; N] {
    hex::decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .expect("hex recorded by us")
}

/// An EVM transaction of the swap, ours or seen.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EvmTx {
    pub hash: String,
    pub block: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmRecord {
    pub id: String,
    pub swap: EvmSwap,
    pub counterparty: String,
    pub taker: bool,
    pub outbox: Vec<EvmEnvelope>,
    pub sent: usize,
    pub peer_seen: usize,
    pub received: Vec<String>,
    #[serde(default)]
    pub rejected: u32,
    pub pending: Vec<EvmPending>,
    pub timeline: Vec<TimelineEntry>,
    /// Demo fault: act on nothing, only observe.
    pub stalled: bool,
    /// Z's stall ends once the claim window has closed (t1).
    pub resume_at_t1: bool,
    /// First block to scan for the swap's events (the head when the swap was created).
    pub from_block: u64,
    /// Latest block time seen.
    #[serde(default)]
    pub now: u64,
    /// The swap's EVM transactions, keyed lock / claim / refund / punish.
    #[serde(default)]
    pub evm_txs: Vec<(String, EvmTx)>,
    pub zec_lock_txid: Option<String>,
    pub zec_sweep_txid: Option<String>,
    #[serde(default)]
    pub zec_spent_by: Option<String>,
    #[serde(default)]
    pub sweep_not_before: Option<u64>,
    #[serde(default)]
    pub zec_send_intent: bool,
    #[serde(default)]
    pub created_ms: u64,
    pub mine_revealed: bool,
    pub peer_learned: bool,
    pub zec_joint: String,
    pub observer_evm: Vec<(String, String)>,
    pub observer_zec: Vec<(String, String)>,
    /// Our package at the watchtower (--watchtower), if one is configured.
    #[serde(default)]
    pub watchtower: Option<crate::tower::TowerState>,
}

impl EvmRecord {
    pub fn new(
        id: String,
        swap: EvmSwap,
        counterparty: String,
        taker: bool,
        zec_joint: String,
        from_block: u64,
    ) -> Self {
        EvmRecord {
            id,
            swap,
            counterparty,
            taker,
            outbox: vec![],
            sent: 0,
            peer_seen: 0,
            received: vec![],
            rejected: 0,
            pending: vec![],
            timeline: vec![],
            stalled: false,
            resume_at_t1: false,
            from_block,
            now: 0,
            evm_txs: vec![],
            zec_lock_txid: None,
            zec_sweep_txid: None,
            zec_spent_by: None,
            sweep_not_before: None,
            zec_send_intent: false,
            created_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            mine_revealed: false,
            peer_learned: false,
            zec_joint,
            observer_evm: vec![],
            observer_zec: vec![],
            watchtower: None,
        }
    }

    pub fn role(&self) -> Role {
        self.swap.role()
    }

    pub fn state(&self) -> String {
        state_label(&self.swap.state_name())
    }

    pub fn log(&mut self, chain: &str, kind: &str, label: impl Into<String>, txid: Option<String>) {
        self.timeline.push(TimelineEntry {
            at: humantime::format_rfc3339_seconds(std::time::SystemTime::now()).to_string(),
            chain: chain.into(),
            kind: kind.into(),
            label: label.into(),
            txid,
            height: None,
        });
    }

    pub fn has(&self, kind: &str) -> bool {
        self.timeline.iter().any(|e| e.kind == kind)
    }

    /// How many of our outbox messages may reach the peer now: all, except that B's Ready(id)
    /// signature (its last message) is handed over only while B waits for Z's claim and nobody
    /// has spent the lock note (see the Bitcoin record's `deliverable`).
    pub fn deliverable(&self) -> usize {
        let may = |env: &EvmEnvelope| match env.message {
            EvmMessage::ReadySig { .. } => {
                self.state() == "ReadySent" && self.zec_spent_by.is_none()
            }
            _ => true,
        };
        self.outbox
            .iter()
            .position(|e| !may(e))
            .unwrap_or(self.outbox.len())
    }

    pub fn evm_tx(&self, key: &str) -> Option<&EvmTx> {
        self.evm_txs.iter().find(|(k, _)| k == key).map(|(_, t)| t)
    }

    /// Record a transaction of the swap; returns true the first time.
    pub fn set_evm_tx(&mut self, key: &str, hash: String, block: Option<u64>) -> bool {
        if let Some((_, t)) = self.evm_txs.iter_mut().find(|(k, _)| k == key) {
            if t.hash == hash && block.is_some() {
                t.block = block;
            }
            return false;
        }
        self.evm_txs.push((key.into(), EvmTx { hash, block }));
        true
    }

    pub fn outcome(&self) -> Option<&'static str> {
        match (self.role(), self.state().as_str()) {
            (Role::B, "ZecSwept") | (Role::Z, "Claimed") => Some("swapped"),
            (Role::B, "Refunded") | (Role::Z, "ZecReclaimed" | "Refunded") => Some("refunded"),
            (_, "Punished") => Some("punished"),
            _ => None,
        }
    }

    /// Nothing left to do or to fill in.
    pub fn settled(&self) -> bool {
        let sweep_expected =
            matches!(self.outcome(), Some("swapped" | "refunded")) && self.zec_lock_txid.is_some();
        let late_note_possible = self.role() == Role::Z
            && self.state() == "Refunded"
            && (self.zec_send_intent
                || self.has("zec_lock_refused")
                || self.has("zec_send_uncertain"));
        !late_note_possible
            && self.swap.is_final()
            && self.pending.is_empty()
            && (!sweep_expected || self.observer_zec.iter().any(|(k, _)| k == "sweep"))
            && self
                .timeline
                .iter()
                .all(|e| e.txid.is_none() || e.height.is_some())
    }

    pub fn set_observer(list: &mut Vec<(String, String)>, key: &str, line: String) {
        if !list.iter().any(|(k, _)| k == key) {
            list.push((key.into(), line));
        }
    }
}

/// One JSON file per EVM swap under `<data-dir>/evm-swaps`, written atomically.
#[derive(Clone)]
pub struct EvmStore {
    dir: PathBuf,
}

impl EvmStore {
    /// Records hold secret key shares: the directory is 0700 and every file 0600.
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        private_dir(data_dir)?;
        let dir = data_dir.join("evm-swaps");
        private_dir(&dir)?;
        Ok(EvmStore { dir })
    }

    pub fn save(&self, rec: &EvmRecord) -> std::io::Result<()> {
        let tmp = self.dir.join(format!(".{}.json.tmp", rec.id));
        write_private(&tmp, &serde_json::to_vec_pretty(rec)?)?;
        std::fs::rename(tmp, self.dir.join(format!("{}.json", rec.id)))?;
        std::fs::File::open(&self.dir)?.sync_all()
    }

    pub fn load_all(&self) -> std::io::Result<Vec<EvmRecord>> {
        let mut out = vec![];
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json")
                && !path.file_name().unwrap().to_string_lossy().starts_with('.')
            {
                let rec: EvmRecord = serde_json::from_slice(&std::fs::read(&path)?)
                    .map_err(|e| std::io::Error::other(format!("{}: {e}", path.display())))?;
                out.push(rec);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferry_core::evm::{
        evm_accept, EvmChainEvent, EvmEvent, EvmObservation, EvmParams, EvmProposal, ObservedLock,
        ANVIL_CHAIN_ID,
    };
    use ferry_evm::{PrivateKeySigner, B256};

    fn observed(now: u64, terms: &LockTerms) -> EvmEvent {
        EvmEvent::Chain(EvmChainEvent::Observed(EvmObservation {
            now,
            lock: Some(ObservedLock {
                terms: terms.clone(),
                confs: 1,
            }),
            ..Default::default()
        }))
    }

    /// B as the taker (buying ZEC from a Z maker), driven to ReadySent: its outbox holds the
    /// Ready(id) signature.
    fn b_taker_with_ready() -> EvmRecord {
        let params = EvmParams {
            chain_id: ANVIL_CHAIN_ID,
            contract: [0x11; 20],
            token: [0x22; 20],
            token_amount: 40_000_000,
            token_symbol: "USDC".into(),
            token_decimals: 6,
            zec_amount: 100_000_000,
            t1: 10_000,
            t2: 20_000,
            claim_margin: 600,
            refund_margin: 600,
            lock_confirmations: 1,
            zec_confirmations: 1,
            max_tip: 0,
        };
        let b_key = PrivateKeySigner::random();
        let z_addr = PrivateKeySigner::random().address().0 .0;
        let mut rng = rand_core::OsRng;
        let (proposal, propose) =
            EvmProposal::new(&mut rng, [6; 32], Role::B, params, b_key.address().0 .0).unwrap();
        let (_z, z_actions) = evm_accept(&mut rng, &propose, z_addr).unwrap();
        let EvmAction::SendMessage(acc) = &z_actions[0] else {
            panic!("expected Accept")
        };
        let (mut b, b_actions) = proposal.on_accept(&mut rng, acc).unwrap();
        let Some(EvmAction::Lock { terms, .. }) = b_actions.first().cloned() else {
            panic!("expected Lock")
        };
        b.handle(observed(1_000, &terms)).unwrap();
        let actions = b
            .handle(EvmEvent::Chain(EvmChainEvent::ZecNoteSeen {
                value: 100_000_000,
                confs: 1,
                spent: false,
            }))
            .unwrap();
        let Some(EvmAction::SignReady { digest }) = actions.first().cloned() else {
            panic!("expected SignReady")
        };
        let sig = ferry_evm::sign_ready_digest(&b_key, &B256::from(digest));
        let mut outbox = vec![];
        for a in b.handle(EvmEvent::ReadySigned { sig }).unwrap() {
            if let EvmAction::SendMessage(env) = a {
                outbox.push(env);
            }
        }
        assert_eq!(b.state_name(), "ReadySent");
        let mut rec = EvmRecord::new(
            "06".repeat(32),
            b,
            "http://maker".into(),
            true,
            "u1".into(),
            1,
        );
        rec.outbox = outbox;
        rec
    }

    /// B hands over Ready(id) only while it waits for Z's claim with the lock note unspent,
    /// whichever side took the swap.
    #[test]
    fn ready_leaves_only_while_b_waits_for_the_claim() {
        let rec = b_taker_with_ready();
        assert_eq!(rec.outbox.len(), 1);
        assert!(matches!(rec.outbox[0].message, EvmMessage::ReadySig { .. }));
        assert_eq!(rec.deliverable(), 1);

        let mut spent = rec.clone();
        spent.zec_spent_by = Some("someone-else".into());
        assert_eq!(spent.deliverable(), 0, "a spent lock note keeps it back");

        // t1 passes without a claim: B refunds, and Ready stays back.
        let mut late = rec.clone();
        let terms = late.swap.session().lock_terms().unwrap();
        late.swap.handle(observed(10_001, &terms)).unwrap();
        assert_eq!(late.state(), "Refunding");
        assert_eq!(late.deliverable(), 0);
    }
}
