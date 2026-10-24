//! EVM swap parameters and the timing rules of docs/EVM.md.
//!
//! All EVM timing is in block timestamps (unix seconds), which is what FerryLock compares:
//! claim in `[lock, t1)`, refund in `[t1, t2)`, punish from `t2`. `now` is always the latest
//! block's timestamp, never the local clock.

use serde::{Deserialize, Serialize};

use crate::Error;

/// Anvil's chain id (local development).
pub const ANVIL_CHAIN_ID: u64 = 31337;
pub const BASE_CHAIN_ID: u64 = 8453;
pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmParams {
    pub chain_id: u64,
    /// The FerryLock deployment both parties use.
    #[serde(with = "crate::hex_serde")]
    pub contract: [u8; 20],
    /// The ERC-20 B locks (USDC, WETH).
    #[serde(with = "crate::hex_serde")]
    pub token: [u8; 20],
    /// Token base units B locks (USDC: 10^-6, WETH: 10^-18). Z receives this minus any relayer
    /// tip. A u64, so one swap carries at most about 18.44 WETH (FerryLock itself takes any
    /// uint256); kept so the wire format stays the same for USDC peers.
    pub token_amount: u64,
    /// Agreed (and part of the transcript) so both sides name, scale and show the same token;
    /// each daemon checks them against the token's own `symbol()` and `decimals()` at startup.
    pub token_symbol: String,
    pub token_decimals: u8,
    /// ZEC Z locks (zatoshi).
    pub zec_amount: u64,
    /// Claims are valid before t1 (unix seconds, block time).
    pub t1: u64,
    /// Refunds are valid in [t1, t2); punish from t2.
    pub t2: u64,
    /// Δ for claims: Z never sends a claim once `now >= t1 - claim_margin`.
    pub claim_margin: u64,
    /// Δ for refunds: B never sends a refund once `now >= t2 - refund_margin`.
    pub refund_margin: u64,
    /// Confirmations of the EVM lock Z waits for before locking ZEC.
    pub lock_confirmations: u32,
    /// Zcash confirmations (N) B waits for on the lock note before signing Ready(id).
    pub zec_confirmations: u32,
    /// Largest tip (token base units) a claim may pay its sender (a relayer).
    pub max_tip: u64,
}

impl EvmParams {
    /// Hard sanity checks, independent of any policy.
    pub fn validate(&self) -> Result<(), Error> {
        if self.token_amount == 0 {
            return Err(Error::InvalidParams("token_amount is zero"));
        }
        if self.zec_amount == 0 {
            return Err(Error::InvalidParams("zec_amount is zero"));
        }
        if self.max_tip > self.token_amount {
            return Err(Error::InvalidParams("max_tip exceeds token_amount"));
        }
        if self.token_symbol.is_empty()
            || self.token_symbol.len() > 11
            || !self.token_symbol.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return Err(Error::InvalidParams("token_symbol"));
        }
        if self.token_decimals > 18 {
            return Err(Error::InvalidParams("token_decimals"));
        }
        if self.claim_margin == 0 || self.refund_margin == 0 {
            return Err(Error::InvalidParams(
                "the Δ margins must be at least one second",
            ));
        }
        if self.lock_confirmations == 0 || self.zec_confirmations == 0 {
            return Err(Error::InvalidParams(
                "confirmation targets must be at least 1",
            ));
        }
        if self.t1 <= self.claim_margin {
            return Err(Error::InvalidParams("t1 leaves no claim window"));
        }
        if self.t2 <= self.t1.saturating_add(self.refund_margin) {
            return Err(Error::InvalidParams("t2 leaves no refund window"));
        }
        if self.contract == [0; 20] || self.token == [0; 20] {
            return Err(Error::InvalidParams("zero contract or token address"));
        }
        Ok(())
    }

    /// [`EvmParams::validate`], the local [`EvmPolicy`] minimums, and enough time left at `now`.
    pub fn check_policy(&self, policy: &EvmPolicy, now: u64) -> Result<(), Error> {
        self.validate()?;
        let checks = [
            (
                "claim margin (s)",
                self.claim_margin,
                policy.min_margin_secs,
            ),
            (
                "refund margin (s)",
                self.refund_margin,
                policy.min_margin_secs,
            ),
            (
                "EVM lock confirmations",
                u64::from(self.lock_confirmations),
                u64::from(policy.min_lock_confirmations),
            ),
            (
                "ZEC confirmations",
                u64::from(self.zec_confirmations),
                u64::from(policy.min_zec_confirmations),
            ),
            (
                "claim window (s)",
                self.t1
                    .saturating_sub(self.claim_margin)
                    .saturating_sub(now),
                policy.min_claim_window_secs,
            ),
            (
                "refund window (s)",
                self.t2 - self.t1 - self.refund_margin,
                policy.min_margin_secs,
            ),
        ];
        for (name, got, min) in checks {
            if got < min {
                return Err(Error::Policy(format!(
                    "{name} is {got}, we require at least {min}"
                )));
            }
        }
        Ok(())
    }

    /// Z may send a claim only while `now < t1 − Δ`.
    pub fn can_claim(&self, now: u64) -> bool {
        now.saturating_add(self.claim_margin) < self.t1
    }

    /// Z locks ZEC once the EVM lock is buried enough and there is still time to claim.
    pub fn can_lock_zec(&self, lock_confs: u32, now: u64) -> bool {
        lock_confs >= self.lock_confirmations && self.can_claim(now)
    }

    /// No claim can land any more (FerryLock refuses claims from t1).
    pub fn claim_closed(&self, now: u64) -> bool {
        now >= self.t1
    }

    /// B may send a refund only in `[t1, t2 − Δ)`.
    pub fn can_refund(&self, now: u64) -> bool {
        now >= self.t1 && now.saturating_add(self.refund_margin) < self.t2
    }

    pub fn can_punish(&self, now: u64) -> bool {
        now >= self.t2
    }
}

/// Local minimums a party enforces on any EVM terms it signs up to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvmPolicy {
    /// Both Δ margins, and the smallest refund window (seconds).
    pub min_margin_secs: u64,
    pub min_lock_confirmations: u32,
    pub min_zec_confirmations: u32,
    /// Time from the proposal to `t1 − Δ`: enough to lock, lock ZEC, confirm it and claim.
    pub min_claim_window_secs: u64,
}

impl EvmPolicy {
    /// Anvil is only accepted with `dev`. Base mainnet is strict (its single sequencer can
    /// delay inclusion, so the margins are long); other chains (Base Sepolia) are looser.
    pub fn for_chain(chain_id: u64, dev: bool) -> Result<EvmPolicy, Error> {
        match (chain_id, dev) {
            (ANVIL_CHAIN_ID, true) => Ok(EvmPolicy {
                min_margin_secs: 2,
                min_lock_confirmations: 1,
                min_zec_confirmations: 1,
                min_claim_window_secs: 10,
            }),
            (ANVIL_CHAIN_ID, false) => {
                Err(Error::Policy("anvil needs the explicit dev policy".into()))
            }
            (_, true) => Err(Error::Policy(
                "the dev policy is only for anvil (chain 31337)".into(),
            )),
            (BASE_CHAIN_ID, false) => Ok(EvmPolicy {
                min_margin_secs: 3_600,
                min_lock_confirmations: 30,
                min_zec_confirmations: 10,
                min_claim_window_secs: 4 * 3_600,
            }),
            (_, false) => Ok(EvmPolicy {
                min_margin_secs: 120,
                min_lock_confirmations: 2,
                min_zec_confirmations: 3,
                min_claim_window_secs: 1_200,
            }),
        }
    }
}

#[cfg(test)]
pub(crate) fn test_params() -> EvmParams {
    EvmParams {
        chain_id: ANVIL_CHAIN_ID,
        contract: [0x11; 20],
        token: [0x22; 20],
        token_amount: 250_000_000,
        token_symbol: "USDC".into(),
        token_decimals: 6,
        zec_amount: 500_000_000,
        t1: 1_000,
        t2: 2_000,
        claim_margin: 100,
        refund_margin: 100,
        lock_confirmations: 1,
        zec_confirmations: 2,
        max_tip: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows() {
        let p = test_params();
        p.validate().unwrap();
        assert!(p.can_claim(899) && !p.can_claim(900));
        assert!(!p.claim_closed(999) && p.claim_closed(1_000));
        assert!(!p.can_refund(999) && p.can_refund(1_000) && p.can_refund(1_899));
        assert!(!p.can_refund(1_900));
        assert!(!p.can_punish(1_999) && p.can_punish(2_000));
        assert!(p.can_lock_zec(1, 0) && !p.can_lock_zec(0, 0) && !p.can_lock_zec(1, 900));
    }

    #[test]
    fn rejects_bad_params() {
        let p = test_params();
        for bad in [
            EvmParams {
                token_amount: 0,
                ..p.clone()
            },
            EvmParams {
                max_tip: p.token_amount + 1,
                ..p.clone()
            },
            EvmParams {
                t2: 1_100,
                ..p.clone()
            },
            EvmParams {
                claim_margin: 0,
                ..p.clone()
            },
            EvmParams {
                token_symbol: "US DC".into(),
                ..p.clone()
            },
            EvmParams {
                contract: [0; 20],
                ..p.clone()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn policies() {
        let p = test_params();
        assert!(EvmPolicy::for_chain(ANVIL_CHAIN_ID, false).is_err());
        assert!(EvmPolicy::for_chain(BASE_SEPOLIA_CHAIN_ID, true).is_err());
        let dev = EvmPolicy::for_chain(ANVIL_CHAIN_ID, true).unwrap();
        p.check_policy(&dev, 0).unwrap();
        // Too little time left before t1 − Δ.
        assert!(p.check_policy(&dev, 895).is_err());
        let sepolia = EvmPolicy::for_chain(BASE_SEPOLIA_CHAIN_ID, false).unwrap();
        let err = p.check_policy(&sepolia, 0).unwrap_err().to_string();
        assert!(err.contains("claim margin"), "{err}");
    }
}
