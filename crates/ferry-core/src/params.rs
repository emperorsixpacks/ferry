//! Swap parameters and the timing rules of PROTOCOL.md.
//!
//! All BTC timing is in confirmations of the transaction that starts the relative
//! timelock: `lock_confs` for T1 (lock output), `cancel_confs` for T2 (cancel output).
//! A spend with `CSV t` enters the mempool once its parent has `t` confirmations.

use ferry_btc::bitcoin::{Amount, Network};
use ferry_btc::tx::DUST_LIMIT;
use serde::{Deserialize, Serialize};

use crate::Error;

/// Upper bound on the vsize of a presigned spend (script path, two signatures).
pub const MAX_SPEND_VSIZE: u64 = 200;
/// Relay floor assumed for presigned fees (sat/vB).
pub const RELAY_FLOOR_SAT_PER_VB: u64 = 1;
/// A presigned fee may take at most this share of the BTC amount (percent).
pub const MAX_FEE_PERCENT: u64 = 5;

/// Local minimums a party enforces on any terms it signs up to (its own or a maker's).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Both Δ margins (blocks).
    pub min_margin: u16,
    pub min_btc_lock_confirmations: u32,
    pub min_zec_confirmations: u32,
    pub min_cancel_confirmations: u32,
}

impl Policy {
    /// Mainnet is strict and the public test networks are a bit looser. Regtest is only
    /// accepted with `dev`, which drops the minimums to what a local demo needs.
    pub fn for_network(network: Network, dev: bool) -> Result<Policy, Error> {
        match (network, dev) {
            (Network::Regtest, true) => Ok(Policy {
                min_margin: 1,
                min_btc_lock_confirmations: 1,
                min_zec_confirmations: 1,
                min_cancel_confirmations: 1,
            }),
            (Network::Regtest, false) => Err(Error::Policy(
                "regtest needs the explicit dev policy".into(),
            )),
            (_, true) => Err(Error::Policy("the dev policy is only for regtest".into())),
            (Network::Bitcoin, false) => Ok(Policy {
                min_margin: 3,
                min_btc_lock_confirmations: 2,
                min_zec_confirmations: 10,
                min_cancel_confirmations: 2,
            }),
            (_, false) => Ok(Policy {
                min_margin: 2,
                min_btc_lock_confirmations: 1,
                min_zec_confirmations: 3,
                min_cancel_confirmations: 1,
            }),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwapParams {
    pub network: Network,
    /// BTC B locks (sats). Z receives `btc_amount - fee`.
    pub btc_amount: u64,
    /// ZEC Z locks (zatoshi).
    pub zec_amount: u64,
    /// Cancel timelock on the lock output (blocks).
    pub t1: u16,
    /// Punish timelock on the cancel output (blocks).
    pub t2: u16,
    /// Fixed fee per presigned BTC transaction (sats).
    pub btc_fee: u64,
    /// Lock confirmations Z waits for before locking ZEC.
    pub btc_lock_confirmations: u32,
    /// Zcash confirmations (N) B waits for on the lock note before sending the redeem adaptor.
    pub zec_confirmations: u32,
    /// Cancel confirmations (k) B waits for before broadcasting the refund.
    pub cancel_confirmations: u32,
    /// Δ for redeem: Z never broadcasts tx_redeem once `lock_confs >= t1 - redeem_margin`.
    pub redeem_margin: u16,
    /// Δ for refund: B never broadcasts tx_refund once `cancel_confs >= t2 - refund_margin`.
    pub refund_margin: u16,
    /// Redeem through the MuSig2 key path (the lock's internal key is `KeyAgg(kb, kz)`).
    #[serde(default)]
    pub keypath: bool,
}

impl SwapParams {
    /// Hard sanity checks, independent of any policy.
    pub fn validate(&self) -> Result<(), Error> {
        if self.btc_fee < RELAY_FLOOR_SAT_PER_VB * MAX_SPEND_VSIZE {
            return Err(Error::InvalidParams(
                "btc_fee is below the relay floor for a presigned spend",
            ));
        }
        if self.btc_fee.saturating_mul(100) > self.btc_amount.saturating_mul(MAX_FEE_PERCENT) {
            return Err(Error::InvalidParams(
                "btc_fee is more than 5% of btc_amount",
            ));
        }
        if self.redeem_margin == 0 || self.refund_margin == 0 {
            return Err(Error::InvalidParams(
                "the Δ margins must be at least one block",
            ));
        }
        let fee = Amount::from_sat(self.btc_fee);
        let after_fees = Amount::from_sat(self.btc_amount).checked_sub(fee * 2);
        if after_fees.is_none_or(|v| v < DUST_LIMIT) {
            return Err(Error::InvalidParams(
                "btc_amount does not cover two fees plus dust",
            ));
        }
        if self.zec_amount == 0 {
            return Err(Error::InvalidParams("zec_amount is zero"));
        }
        if self.zec_confirmations == 0
            || self.cancel_confirmations == 0
            || self.btc_lock_confirmations == 0
        {
            return Err(Error::InvalidParams(
                "confirmation targets must be at least 1",
            ));
        }
        if u32::from(self.t1) <= u32::from(self.redeem_margin) + self.btc_lock_confirmations {
            return Err(Error::InvalidParams(
                "t1 leaves no window to lock ZEC and redeem",
            ));
        }
        if u32::from(self.t2) <= u32::from(self.refund_margin) + self.cancel_confirmations {
            return Err(Error::InvalidParams("t2 leaves no refund window"));
        }
        Ok(())
    }

    /// [`SwapParams::validate`] plus the local [`Policy`] minimums.
    pub fn check_policy(&self, policy: &Policy) -> Result<(), Error> {
        self.validate()?;
        let checks = [
            (
                "redeem margin",
                u32::from(self.redeem_margin),
                u32::from(policy.min_margin),
            ),
            (
                "refund margin",
                u32::from(self.refund_margin),
                u32::from(policy.min_margin),
            ),
            (
                "BTC lock confirmations",
                self.btc_lock_confirmations,
                policy.min_btc_lock_confirmations,
            ),
            (
                "ZEC confirmations",
                self.zec_confirmations,
                policy.min_zec_confirmations,
            ),
            (
                "cancel confirmations",
                self.cancel_confirmations,
                policy.min_cancel_confirmations,
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

    pub fn btc_amount(&self) -> Amount {
        Amount::from_sat(self.btc_amount)
    }

    pub fn btc_fee(&self) -> Amount {
        Amount::from_sat(self.btc_fee)
    }

    /// tx_cancel is valid (BIP68) once the lock has T1 confirmations.
    pub fn can_cancel(&self, lock_confs: u32) -> bool {
        lock_confs >= u32::from(self.t1)
    }

    /// Z may broadcast tx_redeem only while `lock_confs < T1 − Δ`.
    pub fn can_redeem(&self, lock_confs: u32) -> bool {
        lock_confs < u32::from(self.t1 - self.redeem_margin)
    }

    /// Z locks ZEC once the BTC lock is buried enough and there is still time to redeem.
    pub fn can_lock_zec(&self, lock_confs: u32) -> bool {
        lock_confs >= self.btc_lock_confirmations && self.can_redeem(lock_confs)
    }

    /// B may broadcast tx_refund only when the cancel has k confirmations and `< T2 − Δ`.
    pub fn can_refund(&self, cancel_confs: u32) -> bool {
        cancel_confs >= self.cancel_confirmations
            && cancel_confs < u32::from(self.t2 - self.refund_margin)
    }

    /// tx_punish is valid (BIP68) once the cancel has T2 confirmations.
    pub fn can_punish(&self, cancel_confs: u32) -> bool {
        cancel_confs >= u32::from(self.t2)
    }
}

#[cfg(test)]
pub(crate) fn test_params() -> SwapParams {
    SwapParams {
        network: Network::Regtest,
        btc_amount: 100_000_000,
        zec_amount: 5_000_000_000,
        t1: 12,
        t2: 12,
        btc_fee: 2_000,
        btc_lock_confirmations: 1,
        zec_confirmations: 1,
        cancel_confirmations: 1,
        redeem_margin: 3,
        refund_margin: 3,
        keypath: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timing_windows() {
        let p = test_params();
        p.validate().unwrap();
        assert!(p.can_redeem(8) && !p.can_redeem(9));
        assert!(!p.can_cancel(11) && p.can_cancel(12));
        assert!(!p.can_refund(0) && p.can_refund(1) && p.can_refund(8) && !p.can_refund(9));
        assert!(!p.can_punish(11) && p.can_punish(12));
        assert!(!p.can_lock_zec(0) && p.can_lock_zec(1) && !p.can_lock_zec(9));
    }

    #[test]
    fn fee_and_margin_floors() {
        let p = test_params();
        for bad in [
            SwapParams {
                btc_fee: 0,
                ..p.clone()
            },
            SwapParams {
                btc_fee: 199,
                ..p.clone()
            },
            SwapParams {
                btc_fee: p.btc_amount / 10,
                ..p.clone()
            },
            SwapParams {
                redeem_margin: 0,
                ..p.clone()
            },
            SwapParams {
                refund_margin: 0,
                ..p.clone()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
        assert!(SwapParams {
            btc_fee: p.btc_amount / 20,
            ..p.clone()
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn network_policies() {
        let p = test_params();
        assert!(Policy::for_network(Network::Regtest, false).is_err());
        assert!(Policy::for_network(Network::Signet, true).is_err());
        let dev = Policy::for_network(Network::Regtest, true).unwrap();
        p.check_policy(&dev).unwrap();

        let signet = Policy::for_network(Network::Signet, false).unwrap();
        let low = SwapParams {
            network: Network::Signet,
            zec_confirmations: 1,
            ..p.clone()
        };
        let err = low.check_policy(&signet).unwrap_err().to_string();
        assert!(
            err.contains("ZEC confirmations is 1, we require at least 3"),
            "{err}"
        );

        let main = Policy::for_network(Network::Bitcoin, false).unwrap();
        let thin = SwapParams {
            network: Network::Bitcoin,
            redeem_margin: 2,
            zec_confirmations: 10,
            ..p
        };
        assert!(thin.check_policy(&main).is_err());
    }

    #[test]
    fn rejects_bad_params() {
        let mut p = test_params();
        p.t1 = 4;
        assert!(p.validate().is_err());
        let mut p = test_params();
        p.btc_amount = 4_100;
        assert!(p.validate().is_err());
        let mut p = test_params();
        p.t2 = 4;
        assert!(p.validate().is_err());
    }
}
