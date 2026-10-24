//! Swap parameters and the timing rules of PROTOCOL.md.
//!
//! All BTC timing is in confirmations of the transaction that starts the relative
//! timelock: `lock_confs` for T1 (lock output), `cancel_confs` for T2 (cancel output).
//! A spend with `CSV t` enters the mempool once its parent has `t` confirmations.

use ferry_btc::bitcoin::{Amount, Network};
use ferry_btc::tx::DUST_LIMIT;
use serde::{Deserialize, Serialize};

use crate::Error;

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
    pub fn validate(&self) -> Result<(), Error> {
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
