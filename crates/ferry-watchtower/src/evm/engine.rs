//! The tower's rules for FerryLock swaps (pure, so they can be tested without a node).
//!
//! FerryLock's windows are absolute block timestamps: claim before t1, refund in [t1, t2),
//! punish from t2. `now` is always the latest block's timestamp, never the local clock. The
//! next block's timestamp is at least `now`, so a call sent at `now` lands at or after it.
//!
//! - B: `refund` once `now ≥ t1` and while `now < t2 − Δ`. A refund that lands outside [t1, t2)
//!   reverts but still publishes `b` in its calldata: before t1 Z could then claim the tokens
//!   and reclaim its ZEC; after t2 Z could punish and reclaim. Δ covers inclusion delay;
//! - B: never refund from a node whose latest block is stale by the local clock: it could
//!   show a time before t2 − Δ when the chain is past it;
//! - Z: `punish` once `now ≥ t2`;
//! - stop as soon as the contract shows the swap claimed, refunded or punished, whoever did it;
//! - hold while our own call is pending; send again if it is dropped or reverts, while the
//!   rule still allows it (each send is simulated first).

use ferry_btc::Role;
use ferry_evm::SwapState;
use serde::{Deserialize, Serialize};

use crate::engine::{Outcome, Status};

/// The timing terms of one swap, as the owner agreed them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmRules {
    pub role: Role,
    pub t1: u64,
    pub t2: u64,
    /// Δ: no refund once `now ≥ t2 − refund_margin`.
    pub refund_margin: u64,
}

impl EvmRules {
    pub fn can_refund(&self, now: u64) -> bool {
        now >= self.t1 && now.saturating_add(self.refund_margin) < self.t2
    }

    pub fn can_punish(&self, now: u64) -> bool {
        now >= self.t2
    }

    /// The call this role delegates.
    pub fn call(&self) -> EvmCall {
        match self.role {
            Role::B => EvmCall::Refund,
            Role::Z => EvmCall::Punish,
        }
    }

    fn sent_status(&self) -> Status {
        match self.role {
            Role::B => Status::RefundBroadcast,
            Role::Z => Status::PunishBroadcast,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvmCall {
    Refund,
    Punish,
}

impl EvmCall {
    pub fn name(self) -> &'static str {
        match self {
            EvmCall::Refund => "refund",
            EvmCall::Punish => "punish",
        }
    }
}

/// One poll's view of the swap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvmObservation {
    /// Timestamp of the latest block.
    pub now: u64,
    /// `FerryLock.getSwap(id).state`.
    pub state: SwapState,
    /// The terms on chain are the package's (always true while the swap does not exist).
    pub terms_match: bool,
    /// The latest block is recent by the local clock.
    pub node_fresh: bool,
    /// Our call is out and may still land: pending, or mined while the state read lags.
    pub in_flight: bool,
}

/// What to do after one poll.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmDecision {
    /// The stage the chain shows (the stored status never moves back).
    pub status: Status,
    pub call: Option<EvmCall>,
    pub outcome: Option<Outcome>,
    pub note: String,
}

fn wait(status: Status, note: impl Into<String>) -> EvmDecision {
    EvmDecision {
        status,
        call: None,
        outcome: None,
        note: note.into(),
    }
}

fn done(outcome: Outcome, note: impl Into<String>) -> EvmDecision {
    EvmDecision {
        status: Status::Done,
        call: None,
        outcome: Some(outcome),
        note: note.into(),
    }
}

pub fn decide(r: &EvmRules, o: &EvmObservation) -> EvmDecision {
    use Status::*;
    if !o.terms_match {
        return done(
            Outcome::LockMismatch,
            "the swap on chain does not have the package's terms",
        );
    }
    match o.state {
        SwapState::None => return wait(Armed, "waiting for the lock on chain"),
        SwapState::Claimed => return done(Outcome::Redeemed, "Z claimed the tokens"),
        SwapState::Refunded => return done(Outcome::Refunded, "the swap was refunded to B"),
        SwapState::Punished => return done(Outcome::Punished, "the swap was punished"),
        SwapState::Locked => {}
    }
    if o.in_flight {
        return wait(
            r.sent_status(),
            format!("our {} is out; waiting for it to be mined", r.call().name()),
        );
    }
    let now = o.now;
    match r.role {
        Role::B if now < r.t1 => wait(
            Armed,
            format!(
                "claim window open: refund from t1 ({}s from now)",
                r.t1 - now
            ),
        ),
        Role::B if !r.can_refund(now) => wait(
            Armed,
            format!(
                "refund window closed at t2 − Δ ({}): refund is held back, since it would \
                 reveal b while punish is possible",
                r.t2.saturating_sub(r.refund_margin)
            ),
        ),
        Role::B if !o.node_fresh => wait(
            Armed,
            "the node's latest block is stale by the local clock: holding the refund",
        ),
        Role::B => EvmDecision {
            status: RefundBroadcast,
            call: Some(EvmCall::Refund),
            outcome: None,
            note: format!(
                "t1 passed with no claim ({}s left before t2 − Δ): refund",
                r.t2 - r.refund_margin - now
            ),
        },
        Role::Z if !r.can_punish(now) => {
            wait(Armed, format!("punish from t2 ({}s from now)", r.t2 - now))
        }
        Role::Z => EvmDecision {
            status: PunishBroadcast,
            call: Some(EvmCall::Punish),
            outcome: None,
            note: "t2 passed with the tokens still locked: punish".into(),
        },
    }
}

/// What the owner should do next (nothing here has a deadline).
pub fn advice(outcome: Outcome, role: Role) -> &'static str {
    match (outcome, role) {
        (Outcome::Redeemed, Role::B) => {
            "Z claimed the tokens and revealed z: run your Ferry again to sweep the ZEC \
             (no deadline)"
        }
        (Outcome::Redeemed, Role::Z) => "the tokens were claimed",
        (Outcome::Refunded, Role::B) => "your tokens are refunded",
        (Outcome::Refunded, Role::Z) => {
            "B refunded and revealed its key share: run your Ferry again to reclaim the ZEC \
             (no deadline)"
        }
        (Outcome::Punished, Role::B) => "Z took the tokens after t2 (punish)",
        (Outcome::Punished, Role::Z) => "the punish paid you the tokens",
        (Outcome::LockMismatch, _) => {
            "the swap on chain does not match this package; nothing will be sent"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // t1 = 1000, t2 = 2000, Δ = 100: refund window is now in [1000, 1900).
    fn rules(role: Role) -> EvmRules {
        EvmRules {
            role,
            t1: 1_000,
            t2: 2_000,
            refund_margin: 100,
        }
    }

    fn at(now: u64) -> EvmObservation {
        EvmObservation {
            now,
            state: SwapState::Locked,
            terms_match: true,
            node_fresh: true,
            in_flight: false,
        }
    }

    #[test]
    fn b_refunds_only_inside_t1_to_t2_minus_delta() {
        let r = rules(Role::B);
        let call = |now| decide(&r, &at(now)).call;
        for now in [0, 500, 999] {
            assert_eq!(call(now), None, "before t1 ({now})");
        }
        for now in [1_000, 1_500, 1_899] {
            assert_eq!(
                call(now),
                Some(EvmCall::Refund),
                "inside the window ({now})"
            );
            assert_eq!(decide(&r, &at(now)).status, Status::RefundBroadcast);
        }
        for now in [1_900, 1_999, 2_000, 5_000] {
            assert_eq!(call(now), None, "at/after t2 − Δ ({now})");
        }
        assert!(decide(&r, &at(1_950)).note.contains("window closed"));
        assert!(decide(&r, &at(10)).note.contains("claim window open"));
    }

    #[test]
    fn z_punishes_only_from_t2() {
        let r = rules(Role::Z);
        for now in [0, 999, 1_000, 1_899, 1_999] {
            let d = decide(&r, &at(now));
            assert_eq!((d.call, d.status), (None, Status::Armed), "{now}");
        }
        for now in [2_000, 2_001, 9_000] {
            let d = decide(&r, &at(now));
            assert_eq!(d.call, Some(EvmCall::Punish), "{now}");
            assert_eq!(d.status, Status::PunishBroadcast);
        }
    }

    #[test]
    fn never_acts_on_a_settled_swap() {
        for role in [Role::B, Role::Z] {
            for (state, outcome) in [
                (SwapState::Claimed, Outcome::Redeemed),
                (SwapState::Refunded, Outcome::Refunded),
                (SwapState::Punished, Outcome::Punished),
            ] {
                // Inside B's refund window and past t2 alike.
                for now in [1_500, 2_500] {
                    let d = decide(&rules(role), &EvmObservation { state, ..at(now) });
                    assert_eq!(d.call, None, "{role:?} {state:?} {now}");
                    assert_eq!((d.status, d.outcome), (Status::Done, Some(outcome)));
                }
            }
        }
    }

    #[test]
    fn waits_for_the_lock() {
        for role in [Role::B, Role::Z] {
            let d = decide(
                &rules(role),
                &EvmObservation {
                    state: SwapState::None,
                    ..at(2_500)
                },
            );
            assert_eq!((d.call, d.outcome, d.status), (None, None, Status::Armed));
        }
    }

    #[test]
    fn mismatched_terms_are_terminal() {
        for now in [1_500, 2_500] {
            let d = decide(
                &rules(Role::B),
                &EvmObservation {
                    terms_match: false,
                    ..at(now)
                },
            );
            assert_eq!((d.call, d.outcome), (None, Some(Outcome::LockMismatch)));
        }
    }

    #[test]
    fn holds_while_our_call_is_in_flight() {
        let d = decide(
            &rules(Role::B),
            &EvmObservation {
                in_flight: true,
                ..at(1_500)
            },
        );
        assert_eq!((d.call, d.status), (None, Status::RefundBroadcast));
        // Still held (not re-sent) once the window closes behind it.
        let d = decide(
            &rules(Role::B),
            &EvmObservation {
                in_flight: true,
                ..at(1_950)
            },
        );
        assert_eq!(d.call, None);
        let d = decide(
            &rules(Role::Z),
            &EvmObservation {
                in_flight: true,
                ..at(2_500)
            },
        );
        assert_eq!((d.call, d.status), (None, Status::PunishBroadcast));
    }

    #[test]
    fn a_stale_node_holds_the_refund_but_not_the_punish() {
        let stale = |now| EvmObservation {
            node_fresh: false,
            ..at(now)
        };
        assert_eq!(decide(&rules(Role::B), &stale(1_500)).call, None);
        assert!(decide(&rules(Role::B), &stale(1_500))
            .note
            .contains("stale"));
        // A punish is harmless late: the contract accepts it any time from t2.
        assert_eq!(
            decide(&rules(Role::Z), &stale(2_500)).call,
            Some(EvmCall::Punish)
        );
    }
}
