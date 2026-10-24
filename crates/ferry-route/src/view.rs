//! `RouteView`: what `GET /api/routes` and `event: route` carry (spec section 6), and the one
//! plain-language line that says where the user's money is.

use serde::Serialize;

use crate::legs::Role;
use crate::route::{
    in_about, units_str, zec_str, Entry, Maker, Outcome, Part, PartStatus, Phase, Policy, Route,
    Unit,
};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RouteView {
    pub id: String,
    pub from: String,
    pub to: String,
    /// `leg1 | settling | pausing | leg2 | done | holding | failed`. With parts of both legs
    /// running at once, the later leg.
    pub state: &'static str,
    /// The exact state machine phase (`leg1_starting`, `leg2_starting`, ...).
    pub phase: Phase,
    /// `swapped | holding_zec | refunded | punished | not_started`, or null while running.
    pub outcome: Option<Outcome>,
    /// The route is split into parts of standard sizes (`privacy.denominations_zat`).
    pub standard_amounts: bool,
    pub amounts: Amounts,
    pub privacy: Privacy,
    pub zec: Zec,
    /// Each leg as a whole: its current part's swap, and what all its parts paid or received.
    pub legs: [LegView; 2],
    /// Every part of both legs, leg 1 first, each in its plan's order.
    pub parts: Vec<PartView>,
    /// Where leg 2 pays coin C, as the request named it (null: the leg-2 wallet).
    pub payout_to: Option<String>,
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
    /// Most units of coin A leg 1 may cost (its parts' ceilings).
    pub in_max: u64,
    /// What leg 1 buys (the request rounded down to standard sizes).
    pub zec_zat: u64,
    /// What leg 2 sells (its current plan).
    pub zec2_zat: u64,
    /// Least units of coin C leg 2 may bring (its parts' floors).
    pub out_min: u64,
    /// The privacy jitter left in the wallet (standard amounts off).
    pub keep_zat: u64,
    /// What the request asked leg 1 to buy.
    pub asked_zat: u64,
    /// What leg 2's plan leaves of the route's ZEC, fees included: it stays in the wallet.
    pub left_zat: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Privacy {
    /// Each part's random gap before it starts, seconds.
    pub delay_secs: [u64; 2],
    /// When the next scheduled part starts (null when none waits).
    pub not_before: Option<u64>,
    /// The sizes the route is split into (empty: standard amounts off).
    pub denominations_zat: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Zec {
    /// The leg-1 sweep settling now (else the latest).
    pub sweep_txid: Option<String>,
    pub sweep_confs: u32,
    pub needed_confs: u32,
    pub spendable_zat: Option<u64>,
    /// What L2 must be able to spend before the next leg-2 part starts (its amount plus the lock
    /// reserve).
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
    /// The current part's partner's name (or host).
    pub maker: Option<String>,
    pub maker_url: Option<String>,
    /// The current part's label, swap and state.
    pub label: Option<String>,
    pub swap_id: Option<String>,
    pub state: Option<String>,
    pub outcome: Option<String>,
    /// ZEC and counter-coin units of every part that has a swap (leg 1: paid; leg 2: received).
    pub zec_zat: Option<u64>,
    pub counter_units: Option<u64>,
    pub watchtower: Option<serde_json::Value>,
    /// The leg's other swaps (its other parts, earlier tries).
    pub earlier_swaps: Vec<String>,
    /// Parts in the leg's plan, and how many are through (leg 1: bought; leg 2: sold).
    pub parts: u32,
    pub parts_done: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PartView {
    pub leg: u8,
    /// Unique within its leg (the label's last segment).
    pub n: u32,
    /// "part idx of of" in its leg's plan.
    pub idx: u32,
    pub of: u32,
    pub label: String,
    pub zec_zat: u64,
    /// One of the standard sizes.
    pub standard: bool,
    /// `planned | waiting | starting | running | swapped | refunded | punished | not_started`.
    pub status: PartStatus,
    /// When it starts (drawn once, after its random gap).
    pub not_before: Option<u64>,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    /// The partner's name (or host); never its URL.
    pub maker: Option<String>,
    pub swap_id: Option<String>,
    pub state: Option<String>,
    pub outcome: Option<String>,
    pub counter_units: Option<u64>,
    /// Leg 1: most units of coin A it may cost. Leg 2: least units of coin C it may bring.
    pub limit: u64,
    /// Leg 1: its sweep's confirmations, and whether leg 2 may spend its ZEC.
    pub sweep_confs: Option<u32>,
    pub spendable: Option<bool>,
    /// Why it didn't swap.
    pub note: Option<String>,
}

/// A plan as `POST /api/routes/plan` shows it, before anything starts.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PlanView {
    pub standard_amounts: bool,
    pub amounts: Amounts,
    pub privacy: Privacy,
    pub parts: Vec<PartView>,
    /// The plan in words.
    pub note: String,
}

fn part_view(r: &Route, p: &Part) -> PartView {
    PartView {
        leg: p.leg,
        n: p.n,
        idx: p.idx,
        of: p.of,
        label: p.label.clone(),
        zec_zat: p.zec_zat,
        standard: p.standard,
        status: p.status,
        not_before: p.not_before,
        started_at: p.started_at,
        ended_at: p.ended_at,
        maker: p.maker.as_ref().map(Maker::display),
        swap_id: p.swap_id.clone(),
        state: p.state.clone(),
        outcome: p.outcome.clone(),
        counter_units: p.counter_units,
        limit: r.limit(p),
        sweep_confs: (p.leg == 1).then_some(p.sweep_confs),
        spendable: (p.leg == 1).then_some(p.spendable),
        note: p.note.clone(),
    }
}

/// A leg's current part: the one holding its daemon if its swap exists, else the latest with a
/// swap, else the next to start.
fn current(r: &Route, leg: u8) -> Option<&Part> {
    let lane = r.lane(leg).map(|i| &r.parts[i]);
    lane.filter(|p| p.swap_id.is_some())
        .or_else(|| {
            r.parts
                .iter()
                .filter(|p| p.leg == leg && p.swap_id.is_some())
                .max_by_key(|p| (p.started_at, p.n))
        })
        .or(lane)
        .or_else(|| r.plan(leg).next())
}

fn amounts(r: &Route) -> Amounts {
    Amounts {
        in_max: r.in_max(),
        zec_zat: r.zec_zat,
        zec2_zat: r.zec2_zat(),
        out_min: r.out_min(),
        keep_zat: r.keep_zat,
        asked_zat: r.asked_zat,
        left_zat: r.left_zat,
    }
}

fn privacy(r: &Route) -> Privacy {
    Privacy {
        delay_secs: r.delay_secs,
        not_before: r
            .parts
            .iter()
            .filter(|p| p.status == PartStatus::Waiting)
            .filter_map(|p| p.not_before)
            .min(),
        denominations_zat: r.denominations.clone(),
    }
}

fn ordered(r: &Route) -> Vec<PartView> {
    let mut parts: Vec<&Part> = r.parts.iter().collect();
    parts.sort_by_key(|p| (p.leg, p.n));
    parts.iter().map(|p| part_view(r, p)).collect()
}

pub fn plan_view(r: &Route) -> PlanView {
    let mut parts = ordered(r);
    for p in parts.iter_mut() {
        p.label.clear();
    }
    PlanView {
        standard_amounts: r.standard(),
        amounts: amounts(r),
        privacy: privacy(r),
        parts,
        note: r
            .timeline
            .first()
            .map(|e| e.label.clone())
            .unwrap_or_default(),
    }
}

pub fn route_view(r: &Route, policy: &Policy, now: u64) -> RouteView {
    let legs = [1u8, 2].map(|leg| {
        let l = &r.legs[usize::from(leg - 1)];
        let cur = current(r, leg);
        let with_swap: Vec<&Part> = r
            .parts
            .iter()
            .filter(|p| p.leg == leg && p.swap_id.is_some())
            .collect();
        let maker = cur.and_then(|p| p.maker.clone()).or_else(|| {
            let list = if leg == 1 { &r.maker1 } else { &r.maker2 };
            let idx = cur.map_or(0, |p| p.starting.maker_idx);
            list.get(idx % list.len().max(1)).cloned()
        });
        let swap_id = cur.and_then(|p| p.swap_id.clone());
        LegView {
            n: leg,
            pair: l.pair.clone(),
            role: l.role,
            unit: l.unit.clone(),
            wallet: l.wallet.clone(),
            maker: maker.as_ref().map(Maker::display),
            maker_url: maker.as_ref().map(|m| m.url.clone()),
            label: cur.map(|p| p.label.clone()),
            swap_id: swap_id.clone(),
            state: cur.and_then(|p| p.state.clone()),
            outcome: cur.and_then(|p| p.outcome.clone()),
            zec_zat: (!with_swap.is_empty()).then(|| with_swap.iter().map(|p| p.zec_zat).sum()),
            counter_units: with_swap
                .iter()
                .any(|p| p.counter_units.is_some())
                .then(|| with_swap.iter().filter_map(|p| p.counter_units).sum()),
            watchtower: cur.and_then(|p| p.watchtower.clone()),
            earlier_swaps: with_swap
                .iter()
                .filter_map(|p| p.swap_id.clone())
                .filter(|id| Some(id) != swap_id.as_ref())
                .collect(),
            parts: r.plan(leg).count() as u32,
            parts_done: r
                .plan(leg)
                .filter(|p| p.status == PartStatus::Swapped)
                .count() as u32,
        }
    });
    let settling = r
        .parts
        .iter()
        .filter(|p| p.leg == 1 && p.status == PartStatus::Swapped)
        .min_by_key(|p| (p.spendable, std::cmp::Reverse(p.ended_at)));
    let next_sell = r
        .parts
        .iter()
        .find(|p| {
            p.leg == 2
                && matches!(
                    p.status,
                    PartStatus::Planned | PartStatus::Waiting | PartStatus::Starting
                )
        })
        .map_or(r.zec2_zat(), |p| p.zec_zat);
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
        standard_amounts: r.standard(),
        amounts: amounts(r),
        privacy: privacy(r),
        zec: Zec {
            sweep_txid: settling.and_then(|p| p.sweep_txid.clone()),
            sweep_confs: settling.map_or(0, |p| p.sweep_confs),
            needed_confs: policy.needed_confs,
            spendable_zat: r.zec.spendable_zat,
            need_zat: next_sell + policy.lock_reserve_zat,
            held_zat: r.held_zat,
        },
        legs,
        parts: ordered(r),
        payout_to: r.payout_to.clone(),
        timeline: r.timeline.clone(),
        note: note(r, policy, now),
        problem: r.problem.clone(),
        stop_requested: r.stop_requested,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

fn maker_name(r: &Route, p: &Part) -> String {
    p.maker
        .as_ref()
        .or_else(|| {
            let list = if p.leg == 1 { &r.maker1 } else { &r.maker2 };
            list.get(p.starting.maker_idx % list.len().max(1))
        })
        .map(Maker::display)
        .unwrap_or_else(|| "your partner".into())
}

pub fn note(r: &Route, policy: &Policy, now: u64) -> String {
    if matches!(r.phase, Phase::Done | Phase::Holding | Phase::Failed) {
        return r.reason.clone().unwrap_or_default();
    }
    if r.plan(1).count() <= 1 && r.plan(2).count() <= 1 {
        one_each(r, policy, now)
    } else {
        in_parts(r, policy, now)
    }
}

/// A route of one swap each way, as it has always read.
fn one_each(r: &Route, policy: &Policy, now: u64) -> String {
    let (a, c) = (&r.legs[0].unit.ticker, &r.legs[1].unit.ticker);
    let stopping = if r.stop_requested {
        " You asked to stop: swap 2 won't run, and you keep the ZEC."
    } else {
        ""
    };
    let p1 = r
        .plan(1)
        .next()
        .or_else(|| r.parts.iter().find(|p| p.leg == 1));
    let p2 = r.plan(2).next();
    let maker = |p: Option<&Part>| p.map_or_else(|| "your partner".into(), |p| maker_name(r, p));
    let zec2 = r.zec2_zat();
    let wallet = r.zec_wallet();
    match r.phase {
        Phase::Leg1Starting => format!(
            "Starting swap 1 of 2: your {a} for {} with {}.{stopping}",
            zec_str(r.zec_zat),
            maker(p1)
        ),
        Phase::Leg1 => format!(
            "Swap 1 of 2: buying {} with your {a} from {}. Then it is sold for {c}.{stopping}",
            zec_str(r.zec_zat),
            maker(p1)
        ),
        Phase::Settling => match p1 {
            Some(p) if p.outcome.as_deref() != Some("swapped") => {
                format!("Swap 1 is done. Your ZEC is on its way to {wallet}.")
            }
            Some(p) if !p.spendable => format!(
                "Your ZEC is in {wallet}: {} of {} confirmations before it can be spent.",
                p.sweep_confs, policy.needed_confs
            ),
            _ => format!(
                "Your ZEC is in {wallet}; waiting for the wallet to show {} as spendable.",
                zec_str(zec2 + policy.lock_reserve_zat)
            ),
        },
        Phase::Pausing => {
            let at = p2.and_then(|p| p.not_before).unwrap_or(now);
            format!(
                "Your ZEC is in {wallet}. Privacy pause: selling it for {c} {}.",
                in_about(at.saturating_sub(now))
            )
        }
        Phase::Leg2Starting => {
            let mut s = format!(
                "Your ZEC is in {wallet}. Looking for a partner to sell {} for at least {}.",
                zec_str(zec2),
                units_str(r.out_min(), &r.legs[1].unit)
            );
            if let Some(e) = p2.and_then(|p| p.starting.last_error.as_ref()) {
                s.push_str(&format!(" Last answer: {e}."));
            }
            s + stopping
        }
        Phase::Leg2 => format!(
            "Swap 2 of 2: selling {} for {c} with {}. If it can't finish, its refund returns your ZEC to {wallet}.",
            zec_str(zec2),
            maker(p2)
        ),
        Phase::Done | Phase::Holding | Phase::Failed => r.reason.clone().unwrap_or_default(),
    }
}

/// A route in parts: how far each leg is, and what each leg's daemon does now.
fn in_parts(r: &Route, policy: &Policy, now: u64) -> String {
    let (a, c) = (&r.legs[0].unit.ticker, &r.legs[1].unit.ticker);
    let wallet = r.zec_wallet();
    let count = |leg: u8| {
        (
            r.plan(leg)
                .filter(|p| p.status == PartStatus::Swapped)
                .count(),
            r.plan(leg).count(),
        )
    };
    let ((b, k1), (s, k2)) = (count(1), count(2));
    let mut out = format!("Swap 1: {b} of {k1} parts bought. Swap 2: {s} of {k2} parts sold.");
    if let Some(i) = r.lane(1) {
        let p = &r.parts[i];
        let name = r.part_name(p);
        out.push_str(&match p.status {
            PartStatus::Waiting => format!(
                " {name} ({}) starts {}.",
                zec_str(p.zec_zat),
                in_about(p.not_before.unwrap_or(now).saturating_sub(now))
            ),
            PartStatus::Starting => format!(
                " Starting {}: your {a} for {} with {}.",
                lower(&name),
                zec_str(p.zec_zat),
                maker_name(r, p)
            ),
            PartStatus::Running => format!(
                " {name}: buying {} with your {a} from {}.",
                zec_str(p.zec_zat),
                maker_name(r, p)
            ),
            _ => format!(" {name} is done; its ZEC is on its way to {wallet}."),
        });
    }
    if let Some(p) = r.parts.iter().find(|p| {
        p.leg == 1
            && p.status == PartStatus::Swapped
            && p.outcome.as_deref() == Some("swapped")
            && !p.spendable
    }) {
        out.push_str(&format!(
            " The ZEC from {} is in {wallet}: {} of {} confirmations before it can be spent.",
            lower(&r.part_name(p)),
            p.sweep_confs,
            policy.needed_confs
        ));
    }
    if let Some(i) = r.lane(2) {
        let p = &r.parts[i];
        let name = r.part_name(p);
        out.push_str(&match p.status {
            PartStatus::Waiting => format!(
                " {name} ({}) starts {}.",
                zec_str(p.zec_zat),
                in_about(p.not_before.unwrap_or(now).saturating_sub(now))
            ),
            PartStatus::Starting => {
                let mut s = format!(
                    " Looking for a partner for {}: {} for at least {}.",
                    lower(&name),
                    zec_str(p.zec_zat),
                    units_str(r.limit(p), &r.legs[1].unit)
                );
                if let Some(e) = &p.starting.last_error {
                    s.push_str(&format!(" Last answer: {e}."));
                }
                s
            }
            _ => format!(
                " {name}: selling {} for {c} with {}. If it can't finish, its refund returns the ZEC to {wallet}.",
                zec_str(p.zec_zat),
                maker_name(r, p)
            ),
        });
    }
    if r.stop_requested {
        out.push_str(
            " You asked to stop: the parts not yet started won't run, and you keep the ZEC.",
        );
    } else if let Some(h) = &r.hold {
        out.push_str(&format!(
            " On hold: {h}. Nothing new starts until you continue."
        ));
    }
    out
}

fn lower(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().chain(c).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route::tests::{new_route, params, T0};
    use crate::route::{NewRoute, DENOMINATIONS_ZAT};

    #[test]
    fn view_shape_and_notes() {
        let policy = Policy::default();
        let mut r = new_route(&policy);
        let v = route_view(&r, &policy, T0);
        assert_eq!((v.state, v.outcome), ("leg1", None));
        assert_eq!(v.amounts.zec2_zat, 99_940_000);
        assert_eq!((v.amounts.in_max, v.amounts.out_min), (412_500, 39_200_000));
        assert_eq!(v.zec.needed_confs, 10);
        assert_eq!(v.legs[1].unit.ticker, "USDC");
        assert!(!v.standard_amounts);
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
        assert_eq!(json["legs"][0]["label"], "r0123456789abcdef/1/1");
        assert_eq!(json["parts"][0]["status"], "starting");
        assert_eq!(json["parts"][1]["status"], "planned");
        assert!(
            json.get("sweep_to").is_none(),
            "the leg-2 address is not shown"
        );
        assert!(
            json["parts"][0].get("maker_url").is_none(),
            "a part names its partner, never its URL"
        );

        r.phase = Phase::Settling;
        r.parts[0].status = PartStatus::Swapped;
        r.parts[0].outcome = Some("swapped".into());
        r.parts[0].sweep_confs = 7;
        assert_eq!(
            note(&r, &policy, T0),
            "Your ZEC is in your wallet \"user-z\": 7 of 10 confirmations before it can be spent."
        );
        r.phase = Phase::Pausing;
        r.parts[0].spendable = true;
        r.parts[1].status = PartStatus::Waiting;
        r.parts[1].not_before = Some(T0 + 12 * 60);
        assert_eq!(
            note(&r, &policy, T0),
            "Your ZEC is in your wallet \"user-z\". Privacy pause: selling it for USDC in about 12 minutes."
        );
        let v = route_view(&r, &policy, T0);
        assert_eq!((v.state, v.privacy.not_before), ("pausing", Some(T0 + 720)));
    }

    #[test]
    fn a_route_in_parts_shows_each_part() {
        let policy = Policy::default();
        let mut r = Route::new(
            NewRoute {
                zec_zat: 85_000_000,
                denominations: DENOMINATIONS_ZAT.to_vec(),
                spare_zat: 100_000,
                ..params()
            },
            &policy,
        )
        .unwrap();
        let v = route_view(&r, &policy, T0);
        assert!(v.standard_amounts);
        assert_eq!(v.privacy.denominations_zat, DENOMINATIONS_ZAT.to_vec());
        assert_eq!(
            (v.amounts.asked_zat, v.amounts.zec_zat, v.amounts.zec2_zat),
            (85_000_000, 85_000_000, 85_000_000)
        );
        assert_eq!(v.parts.len(), 6);
        assert_eq!((v.legs[0].parts, v.legs[1].parts), (3, 3));
        assert!(v
            .parts
            .iter()
            .all(|p| p.standard && p.zec_zat >= 10_000_000));
        assert_eq!(
            v.parts
                .iter()
                .map(|p| (p.leg, p.idx, p.of))
                .collect::<Vec<_>>(),
            [
                (1, 1, 3),
                (1, 2, 3),
                (1, 3, 3),
                (2, 1, 3),
                (2, 2, 3),
                (2, 3, 3)
            ]
        );
        assert_eq!(
            v.amounts.in_max,
            v.parts
                .iter()
                .filter(|p| p.leg == 1)
                .map(|p| p.limit)
                .sum::<u64>()
        );
        assert!(v.note.starts_with("Swap 1: 0 of 3 parts bought. Swap 2: 0 of 3 parts sold. Starting swap 1, part 1 of 3"), "{}", v.note);

        // Part 1 bought and settling, part 2 waiting its gap, a sell running.
        r.parts[0].status = PartStatus::Swapped;
        r.parts[0].swap_id = Some("a".into());
        r.parts[0].outcome = Some("swapped".into());
        r.parts[0].counter_units = Some(100);
        r.parts[0].sweep_confs = 4;
        r.parts[1].status = PartStatus::Waiting;
        r.parts[1].not_before = Some(T0 + 300);
        r.parts[3].status = PartStatus::Running;
        r.parts[3].swap_id = Some("b".into());
        r.phase = Phase::Leg2;
        let v = route_view(&r, &policy, T0);
        assert_eq!(v.state, "leg2");
        assert_eq!(
            (v.legs[0].swap_id.as_deref(), v.legs[0].counter_units),
            (Some("a"), Some(100))
        );
        assert_eq!(v.legs[1].swap_id.as_deref(), Some("b"));
        assert_eq!(v.privacy.not_before, Some(T0 + 300));
        assert_eq!((v.zec.sweep_confs, v.parts[0].sweep_confs), (4, Some(4)));
        assert_eq!(v.parts[3].sweep_confs, None);
        assert!(v.note.contains("Swap 1, part 2 of 3"), "{}", v.note);
        assert!(v.note.contains("starts in about 5 minutes"), "{}", v.note);
        assert!(v.note.contains("4 of 10 confirmations"), "{}", v.note);
        assert!(
            v.note.contains("Swap 2, part 1 of 3: selling"),
            "{}",
            v.note
        );
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["parts"][3]["status"], "running");
        assert_eq!(json["timeline"][0]["kind"], "created");

        // The plan view: the same parts without labels.
        let plan = plan_view(&r);
        assert!(plan.parts.iter().all(|p| p.label.is_empty()));
        assert!(plan.note.starts_with("Route created"), "{}", plan.note);
    }
}
