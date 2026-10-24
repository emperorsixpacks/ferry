//! `RouteView`: what `GET /api/routes` and `event: route` carry (spec section 6), and the one
//! plain-language line that says where the user's money is.

use serde::Serialize;

use crate::legs::Role;
use crate::route::{
    in_about, units_str, zec_str, Entry, Maker, Outcome, Phase, Policy, Route, Unit,
};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RouteView {
    pub id: String,
    pub from: String,
    pub to: String,
    /// `leg1 | settling | pausing | leg2 | done | holding | failed`.
    pub state: &'static str,
    /// The exact state machine phase (`leg1_starting`, `leg2_starting`, ...).
    pub phase: Phase,
    /// `swapped | holding_zec | refunded | punished | not_started`, or null while running.
    pub outcome: Option<Outcome>,
    pub amounts: Amounts,
    pub privacy: Privacy,
    pub zec: Zec,
    pub legs: [LegView; 2],
    pub timeline: Vec<Entry>,
    /// Where the money is and what happens next, in one or two sentences.
    pub note: String,
    /// A passing problem (a daemon unreachable, a start refused and being retried).
    pub problem: Option<String>,
    pub stop_requested: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Amounts {
    /// Most units of coin A leg 1 may cost.
    pub in_max: u64,
    pub zec_zat: u64,
    pub zec2_zat: u64,
    /// Least units of coin C leg 2 may pay.
    pub out_min: u64,
    /// The privacy jitter left in the wallet.
    pub keep_zat: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Privacy {
    pub delay_secs: [u64; 2],
    pub not_before: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Zec {
    pub sweep_txid: Option<String>,
    pub sweep_confs: u32,
    pub needed_confs: u32,
    pub spendable_zat: Option<u64>,
    /// What L2 must be able to spend before leg 2 starts (amount plus the lock reserve).
    pub need_zat: u64,
    /// About how much of the route's ZEC rests in the wallet now.
    pub held_zat: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LegView {
    pub n: u8,
    pub pair: String,
    pub role: Role,
    pub unit: Unit,
    pub wallet: String,
    /// The partner's name (or host).
    pub maker: Option<String>,
    pub maker_url: Option<String>,
    pub label: Option<String>,
    pub swap_id: Option<String>,
    pub state: Option<String>,
    pub outcome: Option<String>,
    pub zec_zat: Option<u64>,
    pub counter_units: Option<u64>,
    pub watchtower: Option<serde_json::Value>,
    pub earlier_swaps: Vec<String>,
}

pub fn route_view(r: &Route, policy: &Policy, now: u64) -> RouteView {
    let legs = [0usize, 1].map(|i| {
        let l = &r.legs[i];
        LegView {
            n: i as u8 + 1,
            pair: l.pair.clone(),
            role: l.role,
            unit: l.unit.clone(),
            wallet: l.wallet.clone(),
            maker: l.maker.as_ref().map(Maker::display),
            maker_url: l.maker.as_ref().map(|m| m.url.clone()),
            label: l.label.clone(),
            swap_id: l.swap_id.clone(),
            state: l.state.clone(),
            outcome: l.outcome.clone(),
            zec_zat: l.zec_zat,
            counter_units: l.counter_units,
            watchtower: l.watchtower.clone(),
            earlier_swaps: l.earlier.clone(),
        }
    });
    RouteView {
        id: r.id.clone(),
        from: r.from.clone(),
        to: r.to.clone(),
        state: match r.phase {
            Phase::Leg1Starting | Phase::Leg1 => "leg1",
            Phase::Settling => "settling",
            Phase::Pausing => "pausing",
            Phase::Leg2Starting | Phase::Leg2 => "leg2",
            Phase::Done => "done",
            Phase::Holding => "holding",
            Phase::Failed => "failed",
        },
        phase: r.phase,
        outcome: r.outcome,
        amounts: Amounts {
            in_max: r.max_in,
            zec_zat: r.zec_zat,
            zec2_zat: r.zec2_zat,
            out_min: r.out_min(),
            keep_zat: r.keep_zat,
        },
        privacy: Privacy {
            delay_secs: r.delay_secs,
            not_before: r.not_before,
        },
        zec: Zec {
            sweep_txid: r.zec.sweep_txid.clone(),
            sweep_confs: r.zec.sweep_confs,
            needed_confs: policy.needed_confs,
            spendable_zat: r.zec.spendable_zat,
            need_zat: r.zec2_zat + policy.lock_reserve_zat,
            held_zat: r.held_zat,
        },
        legs,
        timeline: r.timeline.clone(),
        note: note(r, policy, now),
        problem: r.problem.clone(),
        stop_requested: r.stop_requested,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

/// Leg `i`'s partner: the one its swap runs with, else the one it will try next.
fn maker_of(r: &Route, i: usize) -> String {
    let next = match i {
        0 => Some(&r.maker1),
        _ => r.maker2.get(r.starting.maker_idx % r.maker2.len().max(1)),
    };
    r.legs[i]
        .maker
        .as_ref()
        .or(next)
        .map(Maker::display)
        .unwrap_or_else(|| "your partner".into())
}

pub fn note(r: &Route, policy: &Policy, now: u64) -> String {
    let (a, c) = (&r.legs[0].unit.ticker, &r.legs[1].unit.ticker);
    let stopping = if r.stop_requested {
        " You asked to stop: swap 2 won't run, and you keep the ZEC."
    } else {
        ""
    };
    match r.phase {
        Phase::Leg1Starting => format!(
            "Starting swap 1 of 2: your {a} for {} with {}.{stopping}",
            zec_str(r.zec_zat),
            maker_of(r, 0)
        ),
        Phase::Leg1 => format!(
            "Swap 1 of 2: buying {} with your {a} from {}. Then it is sold for {c}.{stopping}",
            zec_str(r.zec_zat),
            maker_of(r, 0)
        ),
        Phase::Settling => {
            let wallet = r.zec_wallet();
            if r.legs[0].outcome.as_deref() != Some("swapped") {
                format!("Swap 1 is done. Your ZEC is on its way to {wallet}.")
            } else if r.zec.sweep_confs < policy.needed_confs {
                format!(
                    "Your ZEC is in {wallet}: {} of {} confirmations before it can be spent.",
                    r.zec.sweep_confs, policy.needed_confs
                )
            } else {
                format!(
                    "Your ZEC is in {wallet}; waiting for the wallet to show {} as spendable.",
                    zec_str(r.zec2_zat + policy.lock_reserve_zat)
                )
            }
        }
        Phase::Pausing => {
            let left = r.not_before.unwrap_or(now).saturating_sub(now);
            format!(
                "Your ZEC is in {}. Privacy pause: selling it for {c} {}.",
                r.zec_wallet(),
                in_about(left)
            )
        }
        Phase::Leg2Starting => {
            let mut s = format!(
                "Your ZEC is in {}. Looking for a partner to sell {} for at least {}.",
                r.zec_wallet(),
                zec_str(r.zec2_zat),
                units_str(r.out_min(), &r.legs[1].unit)
            );
            if let Some(e) = &r.starting.last_error {
                s.push_str(&format!(" Last answer: {e}."));
            }
            s + stopping
        }
        Phase::Leg2 => format!(
            "Swap 2 of 2: selling {} for {c} with {}. If it can't finish, its refund returns your ZEC to {}.",
            zec_str(r.zec2_zat),
            maker_of(r, 1),
            r.zec_wallet()
        ),
        Phase::Done | Phase::Holding | Phase::Failed => r.reason.clone().unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route::tests::{new_route, T0};

    #[test]
    fn view_shape_and_notes() {
        let policy = Policy::default();
        let mut r = new_route(&policy);
        let v = route_view(&r, &policy, T0);
        assert_eq!((v.state, v.outcome), ("leg1", None));
        assert_eq!(v.amounts.zec2_zat, 99_940_000);
        assert_eq!(v.zec.needed_confs, 10);
        assert_eq!(v.legs[1].unit.ticker, "USDC");
        assert!(
            v.note
                .starts_with("Starting swap 1 of 2: your BTC for 1 ZEC with Kestrel"),
            "{}",
            v.note
        );
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["state"], "leg1");
        assert_eq!(json["phase"], "leg1_starting");
        assert_eq!(json["legs"][0]["role"], "B");
        assert!(
            json.get("sweep_to").is_none(),
            "the leg-2 address is not shown"
        );

        r.phase = Phase::Settling;
        r.legs[0].outcome = Some("swapped".into());
        r.zec.sweep_confs = 7;
        assert_eq!(
            note(&r, &policy, T0),
            "Your ZEC is in your wallet \"user-z\": 7 of 10 confirmations before it can be spent."
        );
        r.phase = Phase::Pausing;
        r.not_before = Some(T0 + 12 * 60);
        assert_eq!(
            note(&r, &policy, T0),
            "Your ZEC is in your wallet \"user-z\". Privacy pause: selling it for USDC in about 12 minutes."
        );
        assert_eq!(route_view(&r, &policy, T0).state, "pausing");
    }
}
