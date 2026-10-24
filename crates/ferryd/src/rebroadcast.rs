//! When to rebroadcast a presigned spend (pure, so it can be tested without a node).

use std::collections::HashMap;

use ferry_btc::bitcoin::{Transaction, Txid};
use ferry_btc::SwapTxs;
use ferry_core::{Spend, SwapParams};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RebroadcastDecision {
    /// It, or a conflicting spend of the same output, is buried: forget it.
    Done,
    /// Already known to the node, or not allowed right now: keep it, don't send.
    Wait,
    /// Unknown to the node and allowed by the timing rules: send it again.
    Send,
}

pub struct Rebroadcaster<'a> {
    pub params: &'a SwapParams,
    pub lock: Txid,
    pub txs: &'a SwapTxs,
    /// Confirmations of every swap transaction the node knows (0 = mempool).
    pub confs: &'a HashMap<Txid, u32>,
}

impl Rebroadcaster<'_> {
    pub fn decide(&self, tx: &Transaction) -> RebroadcastDecision {
        let k = self.params.cancel_confirmations.max(1);
        let buried = |t: &Txid| self.confs.get(t).is_some_and(|c| *c >= k);
        let known = |t: &Txid| self.confs.contains_key(t);
        let [cancel, redeem, refund, punish] =
            [Spend::Cancel, Spend::Redeem, Spend::Refund, Spend::Punish].map(|s| self.txs.txid(s));
        let spend = self.txs.classify(tx);
        let done = match spend {
            // The lock: done once buried or already spent.
            None => buried(&self.lock) || known(&cancel) || known(&redeem),
            Some(Spend::Cancel | Spend::Redeem) => buried(&cancel) || buried(&redeem),
            Some(Spend::Refund | Spend::Punish) => buried(&refund) || buried(&punish),
        };
        if done {
            return RebroadcastDecision::Done;
        }
        if known(&tx.compute_txid()) {
            return RebroadcastDecision::Wait;
        }
        let lock_confs = self.confs.get(&self.lock).copied().unwrap_or(0);
        let cancel_confs = self.confs.get(&cancel).copied().unwrap_or(0);
        // The same timing rules as the first broadcast (PROTOCOL.md): a late redeem or refund
        // would show a key share while the other party can still take the other path.
        let allowed = match spend {
            None => true,
            Some(Spend::Cancel) => self.params.can_cancel(lock_confs),
            Some(Spend::Redeem) => lock_confs > 0 && self.params.can_redeem(lock_confs),
            Some(Spend::Refund) => self.params.can_refund(cancel_confs),
            Some(Spend::Punish) => self.params.can_punish(cancel_confs),
        };
        if allowed {
            RebroadcastDecision::Send
        } else {
            RebroadcastDecision::Wait
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferry_btc::bitcoin::hashes::Hash;
    use ferry_btc::bitcoin::{Amount, Network, OutPoint, ScriptBuf};
    use ferry_btc::{BtcKey, SwapScripts};
    use RebroadcastDecision::*;

    fn fixture() -> (SwapParams, SwapTxs, Txid) {
        let params = SwapParams {
            network: Network::Regtest,
            btc_amount: 1_000_000,
            zec_amount: 1,
            t1: 12,
            t2: 12,
            btc_fee: 2_000,
            btc_lock_confirmations: 1,
            zec_confirmations: 1,
            cancel_confirmations: 1,
            redeem_margin: 3,
            refund_margin: 3,
            keypath: false,
        };
        let (b, z) = (BtcKey::random(), BtcKey::random());
        let lock = Txid::from_byte_array([7; 32]);
        let txs = SwapTxs::new(
            SwapScripts::new(b.xonly(), z.xonly(), 12, 12, false),
            OutPoint {
                txid: lock,
                vout: 0,
            },
            Amount::from_sat(params.btc_amount),
            Amount::from_sat(params.btc_fee),
            ScriptBuf::new(),
            ScriptBuf::new(),
            ScriptBuf::new(),
        )
        .unwrap();
        (params, txs, lock)
    }

    fn decide(
        f: &(SwapParams, SwapTxs, Txid),
        confs: &[(Txid, u32)],
        spend: Spend,
    ) -> RebroadcastDecision {
        let (params, txs, lock) = f;
        let confs: HashMap<Txid, u32> = confs.iter().copied().collect();
        Rebroadcaster {
            params,
            lock: *lock,
            txs,
            confs: &confs,
        }
        .decide(txs.tx(spend))
    }

    #[test]
    fn rejected_refund_is_retried_inside_its_window_only() {
        let f = fixture();
        let (txs, lock) = (&f.1, f.2);
        let (cancel, refund, punish) = (
            txs.txid(Spend::Cancel),
            txs.txid(Spend::Refund),
            txs.txid(Spend::Punish),
        );
        // Cancel buried at 1..8 confs, refund unknown to the node (rejected/evicted): resend.
        assert_eq!(decide(&f, &[(lock, 20), (cancel, 1)], Spend::Refund), Send);
        assert_eq!(decide(&f, &[(lock, 20), (cancel, 8)], Spend::Refund), Send);
        // Past T2 − Δ: never again.
        assert_eq!(decide(&f, &[(lock, 20), (cancel, 9)], Spend::Refund), Wait);
        // In the mempool: leave it.
        assert_eq!(
            decide(&f, &[(lock, 20), (cancel, 2), (refund, 0)], Spend::Refund),
            Wait
        );
        // Refund or a conflicting punish buried: done.
        assert_eq!(
            decide(&f, &[(lock, 20), (cancel, 3), (refund, 1)], Spend::Refund),
            Done
        );
        assert_eq!(
            decide(&f, &[(lock, 30), (cancel, 13), (punish, 1)], Spend::Refund),
            Done
        );
    }

    #[test]
    fn cancel_redeem_and_punish_follow_their_timelocks() {
        let f = fixture();
        let (txs, lock) = (&f.1, f.2);
        let (cancel, redeem) = (txs.txid(Spend::Cancel), txs.txid(Spend::Redeem));
        assert_eq!(decide(&f, &[(lock, 11)], Spend::Cancel), Wait);
        assert_eq!(decide(&f, &[(lock, 12)], Spend::Cancel), Send);
        assert_eq!(decide(&f, &[(lock, 12), (redeem, 1)], Spend::Cancel), Done);
        assert_eq!(decide(&f, &[(lock, 8)], Spend::Redeem), Send);
        assert_eq!(
            decide(&f, &[(lock, 9)], Spend::Redeem),
            Wait,
            "no redeem at T1 − Δ"
        );
        assert_eq!(decide(&f, &[(lock, 12), (cancel, 1)], Spend::Redeem), Done);
        assert_eq!(decide(&f, &[(lock, 30), (cancel, 11)], Spend::Punish), Wait);
        assert_eq!(decide(&f, &[(lock, 30), (cancel, 12)], Spend::Punish), Send);
    }
}
