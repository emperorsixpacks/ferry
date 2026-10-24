//! The tower's rules (pure, so they can be tested without a node).
//!
//! Timing follows docs/PROTOCOL.md and `ferry_core::SwapParams`: T1 and T2 are relative
//! timelocks, counted in confirmations of the lock (T1) and of tx_cancel (T2). A spend with
//! `CSV t` is accepted into the mempool once its parent has `t` confirmations.
//!
//! - tx_cancel once the lock has T1 confirmations and the lock output is still unspent;
//! - B: tx_refund once tx_cancel has k confirmations and fewer than T2 − Δ;
//! - Z: tx_punish once tx_cancel has T2 confirmations and its output is still unspent;
//! - stop as soon as the relevant output is spent in a block by anything;
//! - a transaction that drops out of the mempool is sent again while its rule still allows it.

use ferry_btc::{Role, Spend};
use serde::{Deserialize, Serialize};

/// The timing terms of one swap, as the owner agreed them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rules {
    /// Whose package this is.
    pub role: Role,
    pub t1: u16,
    pub t2: u16,
    /// k: tx_cancel confirmations before tx_refund.
    pub cancel_confirmations: u32,
    /// Δ: no tx_refund once tx_cancel has `t2 − refund_margin` confirmations.
    pub refund_margin: u16,
}

impl Rules {
    pub fn can_cancel(&self, lock_confs: u32) -> bool {
        lock_confs >= u32::from(self.t1)
    }

    pub fn can_refund(&self, cancel_confs: u32) -> bool {
        cancel_confs >= self.cancel_confirmations
            && cancel_confs < u32::from(self.t2.saturating_sub(self.refund_margin))
    }

    pub fn can_punish(&self, cancel_confs: u32) -> bool {
        cancel_confs >= u32::from(self.t2)
    }

    /// The transaction this role delegates besides tx_cancel.
    pub fn final_spend(&self) -> Spend {
        match self.role {
            Role::B => Spend::Refund,
            Role::Z => Spend::Punish,
        }
    }

    fn final_status(&self) -> Status {
        match self.role {
            Role::B => Status::RefundBroadcast,
            Role::Z => Status::PunishBroadcast,
        }
    }
}

/// What the node says about one output (the lock output or the cancel output).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum OutputState {
    /// The transaction that creates it is not known (yet).
    Unknown,
    /// Unspent, also in the mempool. `confs = 0` while its parent is in the mempool.
    Unspent { confs: u32 },
    /// A mempool transaction spends it.
    SpentInMempool,
    /// A block spends it.
    SpentInBlock,
}

/// One poll's view of the chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    pub lock: OutputState,
    /// The lock output exists but its script or value is not what the package says.
    pub lock_mismatch: bool,
    /// Confirmations of the package's tx_cancel (None: unknown or conflicted out).
    pub cancel_confs: Option<u32>,
    /// The output of tx_cancel.
    pub cancel_out: OutputState,
    /// Confirmations of the package's tx_refund (B) or tx_punish (Z).
    pub final_confs: Option<u32>,
    /// The node is out of initial block download (its confirmation counts are current).
    pub node_synced: bool,
    /// The tower's watch wallet has processed the node's tip, so "this txid is unknown"
    /// means it really is not ours.
    pub wallet_synced: bool,
}

/// Where a package stands. Ordered: a package only moves forward.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Validated and watched; nothing broadcast yet.
    Armed,
    /// tx_cancel is out (broadcast by the tower or anyone else).
    CancelBroadcast,
    /// B's tx_refund is out.
    RefundBroadcast,
    /// Z's tx_punish is out.
    PunishBroadcast,
    /// Nothing more to do: see the outcome.
    Done,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Armed => "armed",
            Status::CancelBroadcast => "cancel_broadcast",
            Status::RefundBroadcast => "refund_broadcast",
            Status::PunishBroadcast => "punish_broadcast",
            Status::Done => "done",
        }
    }
}

/// How the BTC side ended, from the swap's point of view.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The lock was spent by something other than tx_cancel: Z's redeem.
    Redeemed,
    /// tx_refund spent the cancel output: B has its BTC back, and `b` is public.
    Refunded,
    /// tx_punish spent the cancel output: Z has the BTC.
    Punished,
    /// The lock output does not match the package; the presigned spends can never be valid.
    LockMismatch,
}

impl Outcome {
    /// What the owner should do next (nothing here has a deadline).
    pub fn advice(self, role: Role) -> &'static str {
        match (self, role) {
            (Outcome::Redeemed, Role::B) => {
                "Z redeemed the BTC: run your Ferry again to sweep the ZEC (no deadline)"
            }
            (Outcome::Redeemed, Role::Z) => "the BTC was redeemed",
            (Outcome::Refunded, Role::B) => "your BTC is refunded",
            (Outcome::Refunded, Role::Z) => {
                "B refunded and revealed its key share: run your Ferry again to reclaim the ZEC \
                 (no deadline)"
            }
            (Outcome::Punished, Role::B) => "Z took the BTC after T2 (punish)",
            (Outcome::Punished, Role::Z) => "the punish paid you the BTC",
            (Outcome::LockMismatch, _) => {
                "the lock output does not match this package; nothing can be broadcast"
            }
        }
    }
}

/// What to do after one poll.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    /// The stage the chain shows (the stored status never moves back).
    pub status: Status,
    pub broadcast: Option<Spend>,
    pub outcome: Option<Outcome>,
    pub note: String,
}

pub fn spend_name(spend: Spend) -> &'static str {
    match spend {
        Spend::Cancel => "tx_cancel",
        Spend::Redeem => "tx_redeem",
        Spend::Refund => "tx_refund",
        Spend::Punish => "tx_punish",
    }
}

fn wait(status: Status, note: impl Into<String>) -> Decision {
    Decision {
        status,
        broadcast: None,
        outcome: None,
        note: note.into(),
    }
}

fn send(status: Status, spend: Spend, note: impl Into<String>) -> Decision {
    Decision {
        status,
        broadcast: Some(spend),
        outcome: None,
        note: note.into(),
    }
}

fn done(outcome: Outcome, note: impl Into<String>) -> Decision {
    Decision {
        status: Status::Done,
        broadcast: None,
        outcome: Some(outcome),
        note: note.into(),
    }
}

pub fn decide(r: &Rules, o: &Observation) -> Decision {
    use OutputState::*;
    use Status::*;
    if o.lock_mismatch {
        return done(
            Outcome::LockMismatch,
            "the lock output does not match the package",
        );
    }
    // Only conclude "spent by someone else" from a wallet that has seen the spending block.
    let spent_elsewhere_ok = o.wallet_synced;
    let cancel_confs = match (o.lock, o.cancel_confs) {
        (Unknown, _) => return wait(Armed, "waiting for the lock transaction"),
        (Unspent { confs }, _) if r.can_cancel(confs) => {
            return send(
                CancelBroadcast,
                Spend::Cancel,
                format!(
                    "T1 reached ({confs}/{} lock confirmations): tx_cancel",
                    r.t1
                ),
            )
        }
        (Unspent { confs }, _) => {
            return wait(
                Armed,
                format!("lock has {confs} of {} confirmations for T1", r.t1),
            )
        }
        (SpentInMempool, None) => {
            return wait(
                Armed,
                "another transaction (redeem?) spends the lock in the mempool",
            )
        }
        (SpentInBlock, None) if spent_elsewhere_ok => {
            return done(Outcome::Redeemed, "the lock was spent by tx_redeem")
        }
        (SpentInBlock, None) => {
            return wait(
                Armed,
                "the lock is spent; waiting for the wallet to catch up",
            )
        }
        (_, Some(c)) => c,
    };
    let k = r.cancel_confirmations;
    match o.cancel_out {
        Unknown => wait(CancelBroadcast, "tx_cancel is out; waiting for its output"),
        Unspent { .. } => match r.role {
            Role::B if r.can_refund(cancel_confs) && !o.node_synced => wait(
                CancelBroadcast,
                "the node is still syncing: holding tx_refund",
            ),
            Role::B if r.can_refund(cancel_confs) => send(
                RefundBroadcast,
                Spend::Refund,
                format!("tx_cancel has {cancel_confs} confirmations (k = {k}): tx_refund"),
            ),
            Role::B if cancel_confs < k => wait(
                CancelBroadcast,
                format!("tx_cancel has {cancel_confs} of {k} confirmations before tx_refund"),
            ),
            Role::B => wait(
                CancelBroadcast,
                format!(
                    "refund window closed at T2 − Δ ({} confirmations): tx_refund is held back, \
                     since it would reveal b while tx_punish is possible",
                    r.t2.saturating_sub(r.refund_margin)
                ),
            ),
            Role::Z if r.can_punish(cancel_confs) => send(
                PunishBroadcast,
                Spend::Punish,
                format!(
                    "T2 reached ({cancel_confs}/{} cancel confirmations): tx_punish",
                    r.t2
                ),
            ),
            Role::Z => wait(
                CancelBroadcast,
                format!(
                    "tx_cancel has {cancel_confs} of {} confirmations for T2",
                    r.t2
                ),
            ),
        },
        SpentInMempool if o.final_confs == Some(0) => wait(
            r.final_status(),
            format!("{} is in the mempool", spend_name(r.final_spend())),
        ),
        SpentInMempool => wait(
            CancelBroadcast,
            "another transaction spends the cancel output in the mempool",
        ),
        SpentInBlock if o.final_confs.is_some_and(|c| c >= 1) => match r.role {
            Role::B => done(Outcome::Refunded, "tx_refund confirmed"),
            Role::Z => done(Outcome::Punished, "tx_punish confirmed"),
        },
        SpentInBlock if !spent_elsewhere_ok => wait(
            CancelBroadcast,
            "the cancel output is spent; waiting for the wallet to catch up",
        ),
        SpentInBlock => match r.role {
            Role::B => done(Outcome::Punished, "Z's tx_punish spent the cancel output"),
            Role::Z => done(Outcome::Refunded, "B's tx_refund spent the cancel output"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use OutputState::*;

    // t1 = 6, t2 = 10, k = 2, Δ = 3: refund window is cancel_confs in [2, 7).
    fn rules(role: Role) -> Rules {
        Rules {
            role,
            t1: 6,
            t2: 10,
            cancel_confirmations: 2,
            refund_margin: 3,
        }
    }

    fn obs() -> Observation {
        Observation {
            lock: Unknown,
            lock_mismatch: false,
            cancel_confs: None,
            cancel_out: Unknown,
            final_confs: None,
            node_synced: true,
            wallet_synced: true,
        }
    }

    fn cancelled(cancel_confs: u32, out: OutputState) -> Observation {
        Observation {
            lock: if cancel_confs == 0 {
                SpentInMempool
            } else {
                SpentInBlock
            },
            cancel_confs: Some(cancel_confs),
            cancel_out: out,
            ..obs()
        }
    }

    #[test]
    fn waits_for_the_lock_then_cancels_at_t1() {
        for role in [Role::B, Role::Z] {
            let r = rules(role);
            let d = decide(&r, &obs());
            assert_eq!((d.status, d.broadcast), (Status::Armed, None));
            for confs in [0, 1, 5] {
                let d = decide(
                    &r,
                    &Observation {
                        lock: Unspent { confs },
                        ..obs()
                    },
                );
                assert_eq!(d.broadcast, None, "{role:?} {confs}");
                assert_eq!(d.status, Status::Armed);
            }
            for confs in [6, 7, 100] {
                let d = decide(
                    &r,
                    &Observation {
                        lock: Unspent { confs },
                        ..obs()
                    },
                );
                assert_eq!(d.broadcast, Some(Spend::Cancel), "{role:?} {confs}");
                assert_eq!(d.status, Status::CancelBroadcast);
            }
        }
    }

    #[test]
    fn evicted_cancel_is_sent_again() {
        // tx_cancel dropped out of the mempool: the node shows the lock unspent again.
        let d = decide(
            &rules(Role::B),
            &Observation {
                lock: Unspent { confs: 9 },
                cancel_confs: None,
                ..obs()
            },
        );
        assert_eq!(d.broadcast, Some(Spend::Cancel));
    }

    #[test]
    fn cancel_in_mempool_is_left_alone() {
        for role in [Role::B, Role::Z] {
            let d = decide(&rules(role), &cancelled(0, Unspent { confs: 0 }));
            assert_eq!((d.status, d.broadcast), (Status::CancelBroadcast, None));
        }
    }

    #[test]
    fn refund_only_inside_k_to_t2_minus_delta() {
        let r = rules(Role::B);
        let expect = |c: u32| decide(&r, &cancelled(c, Unspent { confs: c })).broadcast;
        assert_eq!(expect(1), None, "before k");
        for c in 2..7 {
            assert_eq!(expect(c), Some(Spend::Refund), "inside the window at {c}");
        }
        for c in [7, 9, 10, 50] {
            assert_eq!(expect(c), None, "at/after T2 − Δ ({c})");
        }
        let late = decide(&r, &cancelled(8, Unspent { confs: 8 }));
        assert!(late.note.contains("window closed"), "{}", late.note);
    }

    #[test]
    fn refund_waits_for_a_synced_node() {
        let r = rules(Role::B);
        let d = decide(
            &r,
            &Observation {
                node_synced: false,
                ..cancelled(3, Unspent { confs: 3 })
            },
        );
        assert_eq!(d.broadcast, None);
        // tx_cancel and tx_punish are harmless early or late, so they don't wait for it.
        let d = decide(
            &rules(Role::Z),
            &Observation {
                node_synced: false,
                ..cancelled(10, Unspent { confs: 10 })
            },
        );
        assert_eq!(d.broadcast, Some(Spend::Punish));
    }

    #[test]
    fn punish_only_from_t2() {
        let r = rules(Role::Z);
        for c in [1, 2, 6, 9] {
            let d = decide(&r, &cancelled(c, Unspent { confs: c }));
            assert_eq!(d.broadcast, None, "{c}");
            assert_eq!(d.status, Status::CancelBroadcast);
        }
        for c in [10, 11, 40] {
            let d = decide(&r, &cancelled(c, Unspent { confs: c }));
            assert_eq!(d.broadcast, Some(Spend::Punish), "{c}");
            assert_eq!(d.status, Status::PunishBroadcast);
        }
    }

    #[test]
    fn own_final_tx_pending_then_done() {
        let b = rules(Role::B);
        let pending = Observation {
            final_confs: Some(0),
            ..cancelled(3, SpentInMempool)
        };
        let d = decide(&b, &pending);
        assert_eq!((d.status, d.broadcast), (Status::RefundBroadcast, None));
        let d = decide(
            &b,
            &Observation {
                final_confs: Some(1),
                ..cancelled(4, SpentInBlock)
            },
        );
        assert_eq!(
            (d.status, d.outcome),
            (Status::Done, Some(Outcome::Refunded))
        );

        let z = rules(Role::Z);
        let d = decide(
            &z,
            &Observation {
                final_confs: Some(0),
                ..cancelled(10, SpentInMempool)
            },
        );
        assert_eq!(d.status, Status::PunishBroadcast);
        let d = decide(
            &z,
            &Observation {
                final_confs: Some(2),
                ..cancelled(12, SpentInBlock)
            },
        );
        assert_eq!(d.outcome, Some(Outcome::Punished));
    }

    #[test]
    fn stops_when_the_other_side_spends() {
        // Lock spent in a block by something other than tx_cancel: Z redeemed.
        for role in [Role::B, Role::Z] {
            let d = decide(
                &rules(role),
                &Observation {
                    lock: SpentInBlock,
                    ..obs()
                },
            );
            assert_eq!(d.outcome, Some(Outcome::Redeemed), "{role:?}");
            assert_eq!(d.broadcast, None);
        }
        // Cancel output spent by the counterparty's transaction.
        let d = decide(&rules(Role::B), &cancelled(11, SpentInBlock));
        assert_eq!(d.outcome, Some(Outcome::Punished));
        let d = decide(&rules(Role::Z), &cancelled(3, SpentInBlock));
        assert_eq!(d.outcome, Some(Outcome::Refunded));
    }

    #[test]
    fn mempool_spends_by_others_hold_without_stopping() {
        // A redeem in the mempool: don't fight it, don't stop either (it could be evicted).
        for role in [Role::B, Role::Z] {
            let d = decide(
                &rules(role),
                &Observation {
                    lock: SpentInMempool,
                    ..obs()
                },
            );
            assert_eq!(
                (d.status, d.broadcast, d.outcome),
                (Status::Armed, None, None)
            );
        }
        let d = decide(&rules(Role::B), &cancelled(10, SpentInMempool));
        assert_eq!((d.broadcast, d.outcome), (None, None));
    }

    #[test]
    fn never_concludes_from_a_lagging_wallet() {
        let lagging = |o: Observation| Observation {
            wallet_synced: false,
            ..o
        };
        for role in [Role::B, Role::Z] {
            let d = decide(
                &rules(role),
                &lagging(Observation {
                    lock: SpentInBlock,
                    ..obs()
                }),
            );
            assert_eq!(d.outcome, None, "{role:?}");
            let d = decide(&rules(role), &lagging(cancelled(5, SpentInBlock)));
            assert_eq!(d.outcome, None, "{role:?}");
        }
        // Our own confirmed transaction is still recognised.
        let d = decide(
            &rules(Role::B),
            &lagging(Observation {
                final_confs: Some(1),
                ..cancelled(4, SpentInBlock)
            }),
        );
        assert_eq!(d.outcome, Some(Outcome::Refunded));
    }

    #[test]
    fn lock_mismatch_is_terminal() {
        let d = decide(
            &rules(Role::B),
            &Observation {
                lock: Unspent { confs: 50 },
                lock_mismatch: true,
                ..obs()
            },
        );
        assert_eq!(
            (d.broadcast, d.outcome),
            (None, Some(Outcome::LockMismatch))
        );
    }

    #[test]
    fn statuses_are_ordered() {
        assert!(Status::Armed < Status::CancelBroadcast);
        assert!(Status::CancelBroadcast < Status::RefundBroadcast);
        assert!(Status::RefundBroadcast < Status::Done);
        assert!(Status::PunishBroadcast < Status::Done);
    }
}
