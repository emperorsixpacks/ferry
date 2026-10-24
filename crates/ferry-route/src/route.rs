//! A route and its state machine.
//!
//! A route buys ZEC with coin A (leg 1, on the user's B daemon, whose sweeps pay the user's Z
//! daemon) and sells it for coin C (leg 2, on that Z daemon). Each leg is a list of **parts**,
//! each part one ordinary Ferry swap under its own label, `<route>/<leg>/<n>`.
//!
//! **Standard amounts** (the default) split both legs into parts of fixed sizes, the firm-quote
//! buckets ([`DENOMINATIONS_ZAT`]), so every amount on chains A and C is one that every swap of
//! that size shares, and each part starts after its own random gap. Leg 1 buys the largest
//! standard amount within the request, in the fewest parts ([`split_standard`]). Leg 2 sells
//! standard parts too ([`plan_sells`]): the same sizes when the leg-2 wallet has a little spare
//! ZEC for the fees, otherwise the most that fits after them, and the rest stays in the wallet
//! as shielded ZEC, where it pays the fees of the next route. A route that pays out to an address
//! (`payout_to`, a NEAR Intents deposit address) sells in one part: a deposit address takes one
//! deposit before its deadline. With standard amounts off, each leg is one part and leg 2 sells
//! what leg 1 bought less the fees, as before.
//!
//! The two legs run on two daemons, one swap at a time each, so one part of each leg can run at
//! once: leg 2 sells as soon as enough of leg 1's ZEC can be spent, while leg 1 is still buying.
//!
//! [`step`] is pure, in the style of ferry-core: the driver feeds it one observation at a time
//! (what a daemon said, the result of a command, a user request) and runs the command it returns
//! only after the returned route is on disk. A transition can safely repeat.
//!
//! ```text
//! a part: planned → waiting (its gap) → starting → running → swapped
//!                                          │          └→ refunded | punished | not_started
//!                                          └→ not_started (refused, called off, stopped)
//! a route: leg1_starting | leg1 | settling | pausing | leg2_starting | leg2 → done | holding | failed
//! ```
//!
//! The only command starts one part. Each part starts at most once: it persists
//! `inflight_since` before the call, and before every start the driver looks for a swap carrying
//! the part's label on that daemon and adopts it instead.

use serde::{Deserialize, Serialize};

use crate::legs::{LegSwap, Role, StartError, StartSwap};

/// The standard amounts: ferryd's firm-quote buckets (`crates/ferryd/src/quote.rs`
/// `BUCKETS_ZAT`, `web/server/quotes.mjs`), 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50 and 100 ZEC.
pub const DENOMINATIONS_ZAT: [u64; 10] = [
    10_000_000,
    25_000_000,
    50_000_000,
    100_000_000,
    250_000_000,
    500_000_000,
    1_000_000_000,
    2_500_000_000,
    5_000_000_000,
    10_000_000_000,
];

/// Most parts per leg, by default.
pub const MAX_PARTS: usize = 8;
/// The most `--max-parts` may be.
pub const MAX_PARTS_LIMIT: usize = 16;

/// A maker as the UI server resolved it: an allowlisted peer URL and, if known, its name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Maker {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Maker {
    pub fn display(&self) -> String {
        self.name
            .clone()
            .or_else(|| host_port(&self.url).map(|(h, p)| format!("{h}:{p}")))
            .unwrap_or_else(|| self.url.clone())
    }

    /// The same partner, as far as the router can tell: the same name, or the same URL host.
    /// On a loopback host (a local demo runs every maker on one machine) the port must match too.
    /// Two names can still be one operator; that is disclosed, not detected.
    pub fn same_partner(&self, other: &Maker) -> bool {
        let norm = |n: &Option<String>| n.as_ref().map(|n| n.trim().to_lowercase());
        if norm(&self.name).is_some() && norm(&self.name) == norm(&other.name) {
            return true;
        }
        match (host_port(&self.url), host_port(&other.url)) {
            (Some((h1, p1)), Some((h2, p2))) => h1 == h2 && (!is_loopback(&h1) || p1 == p2),
            _ => self.url.trim_end_matches('/') == other.url.trim_end_matches('/'),
        }
    }
}

fn host_port(url: &str) -> Option<(String, u16)> {
    let u = reqwest::Url::parse(url).ok()?;
    Some((u.host_str()?.to_lowercase(), u.port_or_known_default()?))
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The route as a whole: which leg is moving, or how it ended. With parts of both legs running
/// at once it names the later one (a leg-2 part over a leg-1 part).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Leg1Starting,
    Leg1,
    /// Waiting for leg 1's ZEC to be spendable.
    Settling,
    /// A part waits out its random gap.
    Pausing,
    Leg2Starting,
    Leg2,
    Done,
    Holding,
    Failed,
}

impl Phase {
    /// Nothing more will happen.
    pub fn is_final(self) -> bool {
        matches!(self, Phase::Done | Phase::Failed)
    }

    /// The driver works on it every tick (holding waits for the user).
    pub fn is_active(self) -> bool {
        !self.is_final() && self != Phase::Holding
    }
}

/// What the user ended up with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Coin C received (for everything the route sold).
    Swapped,
    /// Some of the ZEC leg 1 bought wasn't sold: it is shielded ZEC in L2's wallet.
    HoldingZec,
    /// Leg 1 was refunded: coin A back, minus fees.
    Refunded,
    /// Leg 1 was punished: coin A lost (offline past the refund deadline).
    Punished,
    /// Leg 1 never started or was called off before anything was locked.
    NotStarted,
}

/// Router settings that shape every route (spec section 3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Confirmations the swept note needs before L2 can spend it.
    pub needed_confs: u32,
    /// One Ironwood transaction's fee allowance (a sweep, a lock, a reclaim).
    pub zec_fee_zat: u64,
    /// What L2 keeps spare for its lock's fee (ferryd's `SEND_FEE_RESERVE`).
    pub lock_reserve_zat: u64,
    /// Leg 1: how long to keep retrying while L1 answers 409 (busy) before failing.
    pub leg1_busy_secs: u64,
    /// Leg 2: how long to keep trying to start a part before holding.
    pub leg2_window_secs: u64,
    pub retry_secs: u64,
    /// After a start whose answer was lost, how long to wait for the swap to show up (ferryd
    /// may still be talking to the maker) before starting again under the same label.
    pub start_grace_secs: u64,
    /// Leg 1 is through and its ZEC buried, but L2 still can't spend the next part: hold after
    /// this long.
    pub spendable_grace_secs: u64,
}

impl Default for Policy {
    fn default() -> Policy {
        Policy {
            needed_confs: 10,
            zec_fee_zat: 10_000,
            lock_reserve_zat: 50_000,
            leg1_busy_secs: 300,
            leg2_window_secs: 2 * 3600,
            retry_secs: 60,
            start_grace_secs: 120,
            spendable_grace_secs: 30 * 60,
        }
    }
}

impl Policy {
    /// What one leg-2 swap of everything leg 1 bought could sell: the amount less the sweep fee
    /// and the lock reserve. It is the basis of the request's `min_out`.
    pub fn leg2_basis(&self, zec_zat: u64) -> Option<u64> {
        zec_zat
            .checked_sub(self.zec_fee_zat.saturating_add(self.lock_reserve_zat))
            .filter(|z| *z > 0)
    }

    /// What the last lock needs spare besides its fee.
    fn slack(&self) -> u64 {
        self.lock_reserve_zat.saturating_sub(self.zec_fee_zat)
    }
}

/// How amounts of a counter coin are written.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unit {
    pub ticker: String,
    pub decimals: u8,
}

/// One leg's daemon.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Leg {
    pub pair: String,
    pub role: Role,
    #[serde(default)]
    pub unit: Unit,
    /// The daemon's name (`/api/status`), for "You hold ... in <wallet>".
    #[serde(default)]
    pub wallet: String,
}

/// Where a part is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartStatus {
    /// Not scheduled yet: it waits for its leg's daemon, and (leg 2) for leg 1's ZEC.
    #[default]
    Planned,
    /// Scheduled: it starts at `not_before`, after its random gap.
    Waiting,
    /// Being started (a start in flight, or retried after a refusal).
    Starting,
    /// Its swap runs.
    Running,
    /// Leg 1: the ZEC is the user's (on its way to, or in, the leg-2 wallet). Leg 2: coin C
    /// received (or claimed as the penalty).
    Swapped,
    /// Called off and refunded. Leg 1: coin A back. Leg 2: the ZEC back.
    Refunded,
    /// Leg 1: coin A lost (offline past the refund deadline).
    Punished,
    /// Never started, or called off before anything was locked: nothing moved.
    NotStarted,
}

/// Starting a part: the in-flight marker and the retry schedule.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Starting {
    /// A start was sent (or was about to be) and its answer is unknown.
    pub inflight_since: Option<u64>,
    /// Earliest next start.
    pub next_at: u64,
    /// Leg 1: stop retrying a busy daemon. Leg 2: hold after this.
    pub window_ends: Option<u64>,
    pub attempts: u32,
    /// The next maker to try (index into the leg's makers, wrapping).
    pub maker_idx: usize,
    pub last_error: Option<String>,
    /// Leg 1: definite refusals so far (each moves on to the next listed maker).
    #[serde(default)]
    pub refused: u32,
}

/// One part of a leg: one swap.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Part {
    pub leg: u8,
    /// Unique within its leg; part of the label.
    pub n: u32,
    /// Its place in its leg's plan, for "part 2 of 3" (a `continue` makes a new plan).
    pub idx: u32,
    pub of: u32,
    /// The idempotency key of its swap, stored by ferryd as `SwapView.route`.
    pub label: String,
    pub zec_zat: u64,
    /// One of the route's denominations.
    pub standard: bool,
    pub status: PartStatus,
    /// When it may start: drawn once, persisted, never redrawn.
    #[serde(default)]
    pub not_before: Option<u64>,
    #[serde(default)]
    pub starting: Starting,
    #[serde(default)]
    pub maker: Option<Maker>,
    #[serde(default)]
    pub swap_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    /// Counter-coin units the swap pays (leg 1) or receives (leg 2).
    #[serde(default)]
    pub counter_units: Option<u64>,
    #[serde(default)]
    pub watchtower: Option<serde_json::Value>,
    /// Leg 1: the latest broadcast of its sweep into the leg-2 wallet.
    #[serde(default)]
    pub sweep_txid: Option<String>,
    #[serde(default)]
    pub sweep_height: Option<u64>,
    #[serde(default)]
    pub sweep_confs: u32,
    /// Leg 1: the swept ZEC can be spent (swapped, and the sweep has its confirmations).
    #[serde(default)]
    pub spendable: bool,
    /// Leg 2: the ZEC was locked and swept back (two Zcash fees spent).
    #[serde(default)]
    pub reclaimed: bool,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub ended_at: Option<u64>,
    /// Why it didn't swap, in plain words.
    #[serde(default)]
    pub note: Option<String>,
}

impl Part {
    fn new(
        leg: u8,
        n: u32,
        idx: u32,
        of: u32,
        label: String,
        zec_zat: u64,
        standard: bool,
    ) -> Part {
        Part {
            leg,
            n,
            idx,
            of,
            label,
            zec_zat,
            standard,
            ..Part::default()
        }
    }

    /// Leg 1: it bought nothing. Leg 2: it sold nothing.
    pub fn failed(&self) -> bool {
        matches!(
            self.status,
            PartStatus::Refunded | PartStatus::Punished | PartStatus::NotStarted
        )
    }

    /// Leg 2: its ZEC is (or may be) locked or sold.
    fn committed(&self) -> bool {
        match self.status {
            PartStatus::Running | PartStatus::Swapped => true,
            PartStatus::Starting => self.starting.inflight_since.is_some(),
            _ => false,
        }
    }

    /// No start was ever sent for it.
    fn never_sent(&self) -> bool {
        matches!(
            self.status,
            PartStatus::Planned | PartStatus::Waiting | PartStatus::Starting
        ) && self.starting.attempts == 0
            && self.starting.inflight_since.is_none()
    }

    /// It holds its leg's daemon (one swap at a time): scheduled, starting, running, or (leg 1)
    /// swapped but its sweep not yet out.
    fn holds_lane(&self) -> bool {
        match self.status {
            PartStatus::Waiting | PartStatus::Starting | PartStatus::Running => true,
            PartStatus::Swapped => {
                self.leg == 1 && self.swap_id.is_some() && self.outcome.is_none()
            }
            _ => false,
        }
    }

    /// The driver reads its swap every tick.
    pub fn followed(&self) -> bool {
        self.status == PartStatus::Running
            || (self.leg == 1 && self.status == PartStatus::Swapped && !self.spendable)
    }

    /// A start command may come out of the next lookup (the driver re-checks the daemon first).
    pub fn start_due(&self, now: u64, policy: &Policy) -> bool {
        self.status == PartStatus::Starting
            && match self.starting.inflight_since {
                Some(t) => now >= t.saturating_add(policy.start_grace_secs),
                None => now >= self.starting.next_at,
            }
    }
}

/// The ZEC side as last read.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZecProgress {
    /// The Zcash tip (the lower of the two daemons').
    pub tip: Option<u64>,
    /// L2's spendable shielded balance when last seen.
    pub spendable_zat: Option<u64>,
    /// Since when leg 1 is through but L2 can't spend the next part.
    pub short_since: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub at: String,
    pub kind: String,
    pub label: String,
    /// The leg and part (`n`) the entry is about, if one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leg: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<u32>,
}

/// One route: persisted as `<data-dir>/routes/<id>.json`. It links both legs, so it is kept
/// private like a swap record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Route {
    pub id: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// Pair A (leg 1, the user is B) and pair C (leg 2, the user is Z).
    pub from: String,
    pub to: String,
    /// What the request asked leg 1 to buy.
    pub asked_zat: u64,
    /// X: what leg 1 buys, the sum of its parts (standard amounts round the request down).
    pub zec_zat: u64,
    /// The sizes this route is split into; empty when standard amounts are off.
    pub denominations: Vec<u64>,
    pub max_parts: usize,
    /// Standard amounts: what L2 could spend besides this route when it was created. It may pay
    /// this route's fees (one Zcash fee per part), never more.
    pub spare_zat: u64,
    /// Standard amounts off: the privacy jitter kept back (`keep_bps`), drawn once.
    pub keep_zat: u64,
    /// What leg 2's current plan leaves of the route's ZEC (fees included).
    pub left_zat: u64,
    /// About how much of the route's ZEC sits in L2's wallet now.
    pub held_zat: u64,
    /// Leg 1: pay at most `max_in` units of coin A per `max_in_basis_zat` ZEC (a rate ceiling).
    pub max_in: u64,
    pub max_in_basis_zat: u64,
    /// Leg 2: receive at least `min_out` units of coin C per `min_out_basis_zat` sold (a rate
    /// floor), whatever the parts' sizes.
    pub min_out: u64,
    pub min_out_basis_zat: u64,
    /// Each part's random gap before it starts, seconds.
    pub delay_secs: [u64; 2],
    /// L2's own shielded address: where leg 1's sweeps pay.
    pub sweep_to: String,
    /// Where leg 2's redeem (EVM: claim) pays coin C instead of L2's own wallet, as the request
    /// gave it (a NEAR Intents 1Click deposit address, say). ferryd checks it for its chain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payout_to: Option<String>,
    /// Leg 1's partners: part n starts with the n-th (wrapping), and a refusal moves on.
    pub maker1: Vec<Maker>,
    /// Leg 2's partners, likewise.
    pub maker2: Vec<Maker>,
    pub phase: Phase,
    pub outcome: Option<Outcome>,
    pub legs: [Leg; 2],
    pub parts: Vec<Part>,
    /// No new part starts until `continue` (no partner at the price, the wallet short ...).
    pub hold: Option<String>,
    /// The next leg-2 part starts without a gap (after `continue`).
    pub no_gap: bool,
    pub stop_requested: bool,
    /// A leg-1 sweep did not pay L2 (the daemon ignored `sweep_to`): that ZEC is in L1's wallet.
    pub zec_elsewhere: bool,
    /// What leg 1 was expected to buy when leg 2 was last planned: leg 2 is planned again when
    /// leg 1 ends with less.
    pub planned_for: Option<u64>,
    pub zec: ZecProgress,
    /// Why the route ended where it did, in plain words.
    pub reason: Option<String>,
    /// A transient problem (a daemon unreachable, a start refused), cleared when things move.
    pub problem: Option<String>,
    pub timeline: Vec<Entry>,
}

/// What [`Route::new`] needs; validated by the API before.
#[derive(Clone, Debug)]
pub struct NewRoute {
    pub id: String,
    pub now: u64,
    /// Fresh randomness: the order of the parts.
    pub rand: u64,
    pub from: Leg,
    pub to: Leg,
    /// What the request asks leg 1 to buy.
    pub zec_zat: u64,
    /// Standard amounts: the sizes to split into (empty: off).
    pub denominations: Vec<u64>,
    pub max_parts: usize,
    /// What L2 can spend besides the ZEC of other routes (standard amounts only).
    pub spare_zat: u64,
    pub keep_zat: u64,
    pub max_in: u64,
    pub min_out: u64,
    pub delay_secs: [u64; 2],
    pub sweep_to: String,
    pub payout_to: Option<String>,
    pub maker1: Vec<Maker>,
    pub maker2: Vec<Maker>,
}

impl Route {
    pub fn new(p: NewRoute, policy: &Policy) -> Result<Route, String> {
        let standard = !p.denominations.is_empty();
        let buys = if standard {
            let b = split_standard(p.zec_zat, &p.denominations, p.max_parts);
            if b.is_empty() {
                let least = p.denominations.iter().min().copied().unwrap_or(0);
                return Err(format!(
                    "{} is less than the smallest standard amount, {}",
                    zec_str(p.zec_zat),
                    zec_str(least)
                ));
            }
            b
        } else {
            vec![p.zec_zat]
        };
        let x: u64 = buys.iter().sum();
        let basis = policy.leg2_basis(p.zec_zat).ok_or_else(|| {
            format!(
                "{} is too little to route: {} zat of it pay the sweep fee and leg 2's lock reserve",
                zec_str(p.zec_zat),
                policy.zec_fee_zat + policy.lock_reserve_zat
            )
        })?;
        let mut r = Route {
            id: p.id,
            created_at: p.now,
            updated_at: p.now,
            from: p.from.pair.clone(),
            to: p.to.pair.clone(),
            asked_zat: p.zec_zat,
            zec_zat: x,
            denominations: if standard { p.denominations } else { vec![] },
            max_parts: p.max_parts.max(1),
            spare_zat: if standard { p.spare_zat } else { 0 },
            keep_zat: p.keep_zat,
            left_zat: 0,
            held_zat: 0,
            max_in: p.max_in,
            max_in_basis_zat: p.zec_zat,
            min_out: p.min_out,
            min_out_basis_zat: basis,
            delay_secs: p.delay_secs,
            sweep_to: p.sweep_to,
            payout_to: p.payout_to,
            maker1: p.maker1,
            maker2: p.maker2,
            phase: Phase::Leg1Starting,
            outcome: None,
            legs: [p.from, p.to],
            parts: vec![],
            hold: None,
            no_gap: false,
            stop_requested: false,
            zec_elsewhere: false,
            planned_for: None,
            zec: ZecProgress::default(),
            reason: None,
            problem: None,
            timeline: vec![],
        };
        let mut buys = buys;
        if standard {
            shuffle(&mut buys, p.rand);
        }
        let k = buys.len() as u32;
        for (i, z) in buys.into_iter().enumerate() {
            let n = i as u32 + 1;
            let (label, std) = (r.label(1, n), r.is_denomination(z));
            r.parts.push(Part::new(1, n, n, k, label, z, std));
        }
        r.replan(None, policy, p.rand.rotate_left(17));
        let sells: Vec<u64> = r.plan(2).map(|p| p.zec_zat).collect();
        if sells.is_empty() {
            return Err(if standard {
                format!(
                    "with standard amounts, {} leaves no standard amount for swap 2 to sell once the fees are paid; route more, or turn standard amounts off",
                    zec_str(x)
                )
            } else {
                "the ZEC kept back leaves nothing for leg 2".into()
            });
        }
        // The first part of leg 1 starts now, so a refusal shows up in the answer.
        let first = &mut r.parts[0];
        first.status = PartStatus::Starting;
        first.starting = Starting {
            next_at: p.now,
            window_ends: Some(p.now + policy.leg1_busy_secs),
            ..Starting::default()
        };
        let (a, c) = (&r.legs[0].unit.ticker, &r.legs[1].unit.ticker);
        let label = if standard {
            let mut s = format!(
                "Route created: {a} → shielded ZEC → {c} in standard amounts: buying {} in {} and selling {} in {}",
                zec_str(x),
                parts_str(&r.plan(1).map(|p| p.zec_zat).collect::<Vec<_>>()),
                zec_str(sells.iter().sum()),
                parts_str(&sells),
            );
            if p.zec_zat != x {
                s.push_str(&format!(
                    ". You asked for {}: standard amounts round down, and the rest of your {a} stays in your wallet",
                    zec_str(p.zec_zat)
                ));
            }
            let stays = r.left_after_fees(policy);
            if stays >= 100_000 {
                s.push_str(&format!(
                    ". About {} stays in your wallet \"{}\" afterwards: it pays the fees of your next routes",
                    zec_str(stays),
                    r.legs[1].wallet
                ));
            }
            s
        } else {
            format!(
                "Route created: {a} → shielded ZEC → {c}, buying {} on the way",
                zec_str(x)
            )
        };
        log(&mut r, p.now, "created", label);
        r.held_zat = r.held_estimate(policy);
        Ok(r)
    }

    pub fn label(&self, leg: u8, n: u32) -> String {
        format!("{}/{leg}/{n}", self.id)
    }

    pub fn standard(&self) -> bool {
        !self.denominations.is_empty()
    }

    fn is_denomination(&self, z: u64) -> bool {
        self.denominations.contains(&z)
    }

    /// A leg's current plan: its parts that have not failed.
    pub fn plan(&self, leg: u8) -> impl Iterator<Item = &Part> {
        self.parts
            .iter()
            .filter(move |p| p.leg == leg && !p.failed())
    }

    /// What leg 2 sells (its current plan, sold parts included).
    pub fn zec2_zat(&self) -> u64 {
        self.plan(2).map(|p| p.zec_zat).sum()
    }

    /// Leg 1: most coin A for a part (rounded down, so never past the user's rate). Leg 2: least
    /// coin C for a part (rounded up, so never below it).
    pub fn limit(&self, p: &Part) -> u64 {
        let v = if p.leg == 1 {
            u128::from(self.max_in) * u128::from(p.zec_zat)
                / u128::from(self.max_in_basis_zat.max(1))
        } else {
            (u128::from(self.min_out) * u128::from(p.zec_zat))
                .div_ceil(u128::from(self.min_out_basis_zat.max(1)))
        };
        u64::try_from(v).unwrap_or(u64::MAX)
    }

    /// Most coin A leg 1 may cost (its parts' ceilings).
    pub fn in_max(&self) -> u64 {
        self.parts
            .iter()
            .filter(|p| p.leg == 1)
            .map(|p| self.limit(p))
            .sum()
    }

    /// Least coin C leg 2's plan may bring (its parts' floors).
    pub fn out_min(&self) -> u64 {
        self.plan(2).map(|p| self.limit(p)).sum()
    }

    pub fn part(&self, leg: u8, n: u32) -> Option<usize> {
        self.parts.iter().position(|p| p.leg == leg && p.n == n)
    }

    /// The part holding a leg's daemon, if one.
    pub fn lane(&self, leg: u8) -> Option<usize> {
        self.parts
            .iter()
            .position(|p| p.leg == leg && p.holds_lane())
    }

    /// "Swap 1" for a leg in one part, "Swap 1, part 2 of 3" otherwise.
    pub fn part_name(&self, p: &Part) -> String {
        if p.of <= 1 {
            format!("Swap {}", p.leg)
        } else {
            format!("Swap {}, part {} of {}", p.leg, p.idx, p.of)
        }
    }

    fn start_request(&self, p: &Part, maker: &Maker) -> StartSwap {
        match p.leg {
            1 => StartSwap {
                maker: maker.url.clone(),
                zec_zat: p.zec_zat,
                route: p.label.clone(),
                sweep_to: Some(self.sweep_to.clone()),
                max_counter: Some(self.limit(p)),
                min_counter: None,
                payout_to: None,
            },
            _ => StartSwap {
                maker: maker.url.clone(),
                zec_zat: p.zec_zat,
                route: p.label.clone(),
                sweep_to: None,
                max_counter: None,
                min_counter: Some(self.limit(p)),
                payout_to: self.payout_to.clone(),
            },
        }
    }

    /// Where the route's ZEC rests, in words.
    pub fn zec_wallet(&self) -> String {
        let leg = &self.legs[usize::from(!self.zec_elsewhere)];
        if leg.wallet.is_empty() {
            format!("your {} wallet", leg.pair)
        } else {
            format!("your wallet \"{}\"", leg.wallet)
        }
    }

    /// What the route has (or, for leg-1 parts not yet through, will have) bought and not sold,
    /// and about how much ZEC L2 holds for it, the spare included.
    fn sell_room(&self, policy: &Policy) -> (u64, u64) {
        let f = policy.zec_fee_zat;
        let (mut bought, mut sweeps) = (0u64, 0u64);
        for p in self.plan(1) {
            bought += p.zec_zat;
            sweeps += 1;
        }
        let (mut sold, mut spent) = (0u64, 0u64);
        for p in self.parts.iter().filter(|p| p.leg == 2) {
            if p.committed() {
                sold += p.zec_zat;
                spent += p.zec_zat + f;
            }
            if p.reclaimed {
                spent += 2 * f;
            }
        }
        let wallet = (self.spare_zat + bought).saturating_sub(sweeps * f + spent);
        (bought.saturating_sub(sold), wallet)
    }

    /// About how much of the route's ZEC is in L2's wallet now: what leg 1 swept, less what leg
    /// 2 locked or sold and the fees.
    fn held_estimate(&self, policy: &Policy) -> u64 {
        let f = policy.zec_fee_zat;
        let mut held: u64 = 0;
        let mut spent: u64 = 0;
        for p in self.parts.iter() {
            match (p.leg, p.status) {
                (1, PartStatus::Swapped) => held += p.zec_zat.saturating_sub(f),
                (2, _) if p.committed() && p.status != PartStatus::Starting => {
                    spent += p.zec_zat + f
                }
                _ => {}
            }
            if p.leg == 2 && p.reclaimed {
                spent += 2 * f;
            }
        }
        held.saturating_sub(spent)
    }

    /// The route's own ZEC its plan leaves in the wallet once every fee is paid.
    fn left_after_fees(&self, policy: &Policy) -> u64 {
        let f = policy.zec_fee_zat;
        let n = self.parts.iter().filter(|p| !p.failed()).count() as u64;
        self.left_zat.saturating_sub(n * f)
    }

    /// Replace leg 2's parts that never started with a plan for what the route bought (or will)
    /// and hasn't sold. `amount`: the user's own figure (`continue`).
    fn replan(&mut self, amount: Option<u64>, policy: &Policy, rand: u64) {
        self.parts.retain(|p| !(p.leg == 2 && p.never_sent()));
        for p in self.parts.iter_mut().filter(|p| {
            p.leg == 2
                && matches!(
                    p.status,
                    PartStatus::Planned | PartStatus::Waiting | PartStatus::Starting
                )
                && p.starting.inflight_since.is_none()
        }) {
            p.status = PartStatus::NotStarted;
            p.note
                .get_or_insert_with(|| "Replaced by a new plan".into());
        }
        let (unsold, wallet) = self.sell_room(policy);
        let one = || unsold.min(wallet.saturating_sub(policy.zec_fee_zat + policy.slack()));
        let mut sizes: Vec<u64> = match amount {
            Some(z) if self.standard() => split_standard(z, &self.denominations, self.max_parts),
            Some(z) => vec![z],
            None if self.standard() && self.payout_to.is_none() => {
                plan_sells(unsold, wallet, &self.denominations, self.max_parts, policy)
            }
            None if self.standard() => vec![one()],
            None => vec![one().saturating_sub(self.keep_zat)],
        };
        sizes.retain(|z| *z > 0);
        if self.standard() {
            shuffle(&mut sizes, rand);
        }
        let next = self
            .parts
            .iter()
            .filter(|p| p.leg == 2)
            .map(|p| p.n)
            .max()
            .unwrap_or(0);
        let of = sizes.len() as u32;
        for (i, z) in sizes.iter().enumerate() {
            let n = next + 1 + i as u32;
            let (label, std) = (self.label(2, n), self.is_denomination(*z));
            self.parts
                .push(Part::new(2, n, i as u32 + 1, of, label, *z, std));
        }
        self.left_zat = unsold.saturating_sub(sizes.iter().sum());
        self.planned_for = Some(self.plan(1).map(|p| p.zec_zat).sum());
    }

    /// Leg 1's ZEC that leg 2 may sell now: what can be spent, less what leg 2 has taken.
    fn earned(&self) -> u64 {
        let ready: u64 = self
            .parts
            .iter()
            .filter(|p| p.leg == 1 && p.status == PartStatus::Swapped && p.spendable)
            .map(|p| p.zec_zat)
            .sum();
        let taken: u64 = self
            .parts
            .iter()
            .filter(|p| {
                p.leg == 2
                    && matches!(
                        p.status,
                        PartStatus::Waiting
                            | PartStatus::Starting
                            | PartStatus::Running
                            | PartStatus::Swapped
                    )
            })
            .map(|p| p.zec_zat)
            .sum();
        ready.saturating_sub(taken)
    }

    /// Leg 1 will bring no more ZEC: no part waits, starts, runs or is still settling.
    fn leg1_through(&self) -> bool {
        !self.parts.iter().any(|p| {
            p.leg == 1
                && (matches!(
                    p.status,
                    PartStatus::Planned
                        | PartStatus::Waiting
                        | PartStatus::Starting
                        | PartStatus::Running
                ) || (p.status == PartStatus::Swapped && !p.spendable))
        })
    }

    fn resting(&self) -> bool {
        self.hold.is_some() || self.stop_requested || self.zec_elsewhere
    }
}

/// What the driver saw this tick, or what the user asked.
#[derive(Clone, Debug, PartialEq)]
pub enum Obs {
    /// Time passed; nothing was read.
    Tick,
    /// Before starting a part: its daemon's swap carrying the part's label, if any.
    Lookup {
        leg: u8,
        part: u32,
        swap: Option<LegSwap>,
    },
    /// A part's swap as its daemon shows it.
    Swap { leg: u8, part: u32, swap: LegSwap },
    /// The Zcash tip (the lower of the two daemons') and L2's spendable balance.
    Zec { tip: u64, spendable_zat: u64 },
    /// The answer to [`Command::Start`].
    Started {
        leg: u8,
        part: u32,
        result: Result<String, StartError>,
    },
    /// A leg's daemon could not be read (or is not the daemon the route needs).
    Unreachable { leg: u8, error: String },
    /// `POST /api/routes/:id/continue`.
    Continue(ContinueReq),
    /// `POST /api/routes/:id/stop`.
    Stop,
}

/// `continue` overrides, validated by the API.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContinueReq {
    #[serde(default)]
    pub maker2: Option<Vec<Maker>>,
    /// The least coin C for `zec_zat` (or for what is left to sell).
    #[serde(default)]
    pub min_out: Option<u64>,
    /// What leg 2 sells from now on (e.g. when fees left the wallet short); standard amounts
    /// round it down.
    #[serde(default)]
    pub zec_zat: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Start {
        leg: u8,
        part: u32,
        request: StartSwap,
    },
}

/// A user request the route's state does not allow (HTTP 409).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused(pub String);

pub struct Ctx<'a> {
    /// Unix seconds.
    pub now: u64,
    /// Fresh randomness: the parts' gaps (and the order of re-planned parts).
    pub rand: u64,
    pub policy: &'a Policy,
}

pub fn step(route: &Route, obs: &Obs, ctx: &Ctx) -> Result<(Route, Option<Command>), Refused> {
    let mut r = route.clone();
    let cmd = match obs {
        Obs::Continue(req) => {
            resume(&mut r, req, ctx)?;
            None
        }
        Obs::Stop => {
            stop(&mut r, ctx)?;
            None
        }
        Obs::Unreachable { leg, error } => {
            let pair = &r.legs[usize::from(*leg == 2)].pair;
            r.problem = Some(format!("Can't use your {pair} daemon: {error}"));
            None
        }
        Obs::Lookup { leg, part, swap } => match r.part(*leg, *part) {
            Some(i) => lookup(&mut r, i, swap.as_ref(), ctx),
            None => None,
        },
        Obs::Started { leg, part, result } => {
            if let Some(i) = r.part(*leg, *part) {
                started(&mut r, i, result, ctx);
            }
            None
        }
        Obs::Swap { leg, part, swap } => {
            if let Some(i) = r.part(*leg, *part) {
                if r.parts[i].followed() {
                    on_swap(&mut r, i, swap, ctx);
                }
            }
            None
        }
        Obs::Zec { tip, spendable_zat } => {
            r.zec.tip = Some(*tip);
            r.zec.spendable_zat = Some(*spendable_zat);
            for i in 0..r.parts.len() {
                if r.parts[i].leg == 1 {
                    confirmations(&mut r, i, ctx);
                }
            }
            None
        }
        Obs::Tick => None,
    };
    advance(&mut r, ctx);
    if r != *route {
        r.updated_at = ctx.now;
    }
    Ok((r, cmd))
}

fn log(r: &mut Route, now: u64, kind: &str, label: impl Into<String>) {
    log_part(r, now, kind, label, None);
}

fn log_part(
    r: &mut Route,
    now: u64,
    kind: &str,
    label: impl Into<String>,
    part: Option<(u8, u32)>,
) {
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(now);
    r.timeline.push(Entry {
        at: humantime::format_rfc3339_seconds(at).to_string(),
        kind: kind.into(),
        label: label.into(),
        leg: part.map(|(l, _)| l),
        part: part.map(|(_, n)| n),
    });
}

fn log_at(r: &mut Route, i: usize, now: u64, kind: &str, label: impl Into<String>) {
    let key = (r.parts[i].leg, r.parts[i].n);
    log_part(r, now, kind, label, Some(key));
}

/// The maker a part's next start goes to.
fn maker_for(r: &Route, p: &Part) -> Option<Maker> {
    let list = if p.leg == 1 { &r.maker1 } else { &r.maker2 };
    (!list.is_empty()).then(|| list[p.starting.maker_idx % list.len()].clone())
}

fn lookup(r: &mut Route, i: usize, swap: Option<&LegSwap>, ctx: &Ctx) -> Option<Command> {
    if r.parts[i].status != PartStatus::Starting {
        return None;
    }
    r.problem = None;
    if let Some(s) = swap {
        adopt(r, i, s, ctx);
        return None;
    }
    if let Some(t) = r.parts[i].starting.inflight_since {
        // ferryd may still be negotiating with the maker: give it time to finish before
        // starting again under the same label.
        if ctx.now < t.saturating_add(ctx.policy.start_grace_secs) {
            return None;
        }
        r.parts[i].starting.inflight_since = None;
    }
    if r.resting() {
        // stop cancels it, a hold sets it back (advance)
        return None;
    }
    if r.parts[i].leg == 2 && leg2_window(r, i, ctx) {
        return None;
    }
    if ctx.now < r.parts[i].starting.next_at {
        return None;
    }
    let p = r.parts[i].clone();
    let Some(maker) = maker_for(r, &p) else {
        r.hold = Some(format!("There is no partner for swap {}", p.leg));
        return None;
    };
    let request = r.start_request(&p, &maker);
    if p.starting.attempts == 0 {
        let name = r.part_name(&p);
        let what = match p.leg {
            1 => format!(
                "Starting {} with {}: your {} for {}",
                lower(&name),
                maker.display(),
                r.legs[0].unit.ticker,
                zec_str(p.zec_zat)
            ),
            _ => format!(
                "Starting {} with {}: {} for your {}",
                lower(&name),
                maker.display(),
                zec_str(p.zec_zat),
                r.legs[1].unit.ticker
            ),
        };
        let what = if p.of <= 1 {
            // "Starting swap 1 of 2 with ...", as a route in one part each always said.
            what.replacen(
                &format!("swap {}", p.leg),
                &format!("swap {} of 2", p.leg),
                1,
            )
        } else {
            what
        };
        log_at(r, i, ctx.now, &format!("leg{}_starting", p.leg), what);
    }
    let part = &mut r.parts[i];
    part.starting.inflight_since = Some(ctx.now);
    part.starting.attempts += 1;
    part.maker = Some(maker);
    Some(Command::Start {
        leg: p.leg,
        part: p.n,
        request,
    })
}

fn lower(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().chain(c).collect(),
        None => String::new(),
    }
}

fn started(r: &mut Route, i: usize, result: &Result<String, StartError>, ctx: &Ctx) {
    if r.parts[i].status != PartStatus::Starting {
        return;
    }
    match result {
        Ok(id) => {
            r.problem = None;
            let s = LegSwap {
                id: id.clone(),
                role: r.legs[usize::from(r.parts[i].leg - 1)].role,
                state: "Negotiated".into(),
                ..LegSwap::default()
            };
            adopt(r, i, &s, ctx);
        }
        // The swap may exist, and ferryd may still be working on it: the grace period counts
        // from now, and the next lookups decide.
        Err(StartError::Unknown(e)) => {
            r.parts[i].starting.inflight_since = Some(ctx.now);
            let name = lower(&r.part_name(&r.parts[i]));
            r.problem = Some(format!(
                "No answer when starting {name} ({e}); checking whether it started"
            ));
        }
        Err(StartError::Refused { status, message }) => {
            r.parts[i].starting.inflight_since = None;
            refused(r, i, *status, message, ctx);
        }
    }
}

/// A definite refusal: nothing was created.
fn refused(r: &mut Route, i: usize, status: u16, message: &str, ctx: &Ctx) {
    let p = r.parts[i].clone();
    let maker = p.maker.as_ref().map(Maker::display).unwrap_or_default();
    let name = r.part_name(&p);
    if p.leg == 1 {
        // 409: L1 is busy with another swap; that clears up.
        let busy_until = p.starting.window_ends.unwrap_or(0);
        if status == 409 && ctx.now < busy_until {
            r.parts[i].starting.next_at = ctx.now + ctx.policy.retry_secs;
            r.problem = Some(format!(
                "Your {} daemon is busy with another swap; trying again",
                r.from
            ));
            return;
        }
        // Another listed partner may take it.
        let part = &mut r.parts[i];
        part.starting.refused += 1;
        part.starting.last_error = Some(message.to_string());
        if (part.starting.refused as usize) < r.maker1.len() {
            part.starting.maker_idx = part.starting.maker_idx.wrapping_add(1);
            part.starting.next_at = ctx.now;
            r.problem = Some(format!("{name} with {maker} didn't start: {message}"));
            return;
        }
        let bought = r
            .parts
            .iter()
            .any(|q| q.leg == 1 && q.status == PartStatus::Swapped);
        let note = if bought {
            format!("{name} with {maker} didn't start: {message}. The rest of swap 1 is called off; its {} stayed in your wallet", r.legs[0].unit.ticker)
        } else {
            format!("{name} with {maker} didn't start: {message}. Nothing moved.")
        };
        end_part(r, i, PartStatus::NotStarted, Some(note), ctx);
        stop_buying(r, ctx);
        return;
    }
    if p.starting.last_error.as_deref() != Some(message) {
        log_at(
            r,
            i,
            ctx.now,
            "leg2_refused",
            format!(
                "{name} with {maker} didn't start: {message}. Your ZEC stays put; trying again."
            ),
        );
    }
    let part = &mut r.parts[i];
    part.starting.last_error = Some(message.to_string());
    part.starting.next_at = ctx.now + ctx.policy.retry_secs;
    part.starting.maker_idx = part.starting.maker_idx.wrapping_add(1);
    r.problem = Some(format!("{name} with {maker} didn't start: {message}"));
}

/// A leg-2 part's window is over (and at least one start was tried): it ends, and the route
/// holds. True if it did.
fn leg2_window(r: &mut Route, i: usize, ctx: &Ctx) -> bool {
    let s = &r.parts[i].starting;
    let over = s.window_ends.is_some_and(|t| ctx.now >= t);
    if !over || s.inflight_since.is_some() || s.attempts == 0 {
        return false;
    }
    let mins = ctx.policy.leg2_window_secs / 60;
    let why = match &s.last_error {
        Some(e) => format!(
            "No partner took your ZEC at your price within {mins} minutes (last answer: {e})"
        ),
        None => format!("No partner took your ZEC at your price within {mins} minutes"),
    };
    end_part(r, i, PartStatus::NotStarted, Some(why.clone()), ctx);
    r.hold = Some(why);
    true
}

/// A part's swap exists: follow it from now on.
fn adopt(r: &mut Route, i: usize, s: &LegSwap, ctx: &Ctx) {
    let found = r
        .maker1
        .iter()
        .chain(r.maker2.iter())
        .find(|m| !s.counterparty.is_empty() && m.url.trim_end_matches('/') == s.counterparty)
        .cloned();
    let part = &mut r.parts[i];
    part.starting.inflight_since = None;
    part.swap_id = Some(s.id.clone());
    part.status = PartStatus::Running;
    part.started_at.get_or_insert(ctx.now);
    if let Some(m) = found {
        part.maker = Some(m);
    }
    let p = r.parts[i].clone();
    let maker = p.maker.as_ref().map(Maker::display).unwrap_or_default();
    let text = if p.of <= 1 {
        format!("Swap {} of 2 started with {maker}", p.leg)
    } else {
        format!(
            "{} started with {maker}: {}",
            r.part_name(&p),
            zec_str(p.zec_zat)
        )
    };
    log_at(r, i, ctx.now, &format!("leg{}_started", p.leg), text);
    on_swap(r, i, s, ctx);
}

fn on_swap(r: &mut Route, i: usize, s: &LegSwap, ctx: &Ctx) {
    r.problem = None;
    let part = &mut r.parts[i];
    part.state = Some(s.state.clone());
    part.outcome = s.outcome.clone();
    if s.amounts.zec_zat > 0 {
        part.counter_units = Some(s.amounts.btc_sat);
    }
    part.watchtower = s.watchtower.clone();
    check_terms(r, i, s, ctx);
    if r.parts[i].leg == 1 {
        on_leg1(r, i, s, ctx);
    } else {
        on_leg2(r, i, s, ctx);
    }
}

/// The daemon shows terms the route did not ask for. The swap runs regardless (the router
/// cannot stop it), so say so plainly. A daemon that speaks the route contract never does this.
fn check_terms(r: &mut Route, i: usize, s: &LegSwap, ctx: &Ctx) {
    if s.amounts.zec_zat == 0 {
        return; // not read yet (a swap we only know the id of)
    }
    let p = r.parts[i].clone();
    let mut warn = vec![];
    if s.route.as_deref() != Some(p.label.as_str()) {
        warn.push(format!("it does not carry the route label {}", p.label));
    }
    let (unit, units, limit) = (
        r.legs[usize::from(p.leg - 1)].unit.clone(),
        s.amounts.btc_sat,
        r.limit(&p),
    );
    if s.amounts.zec_zat != p.zec_zat {
        let verb = if p.leg == 1 { "buys" } else { "sells" };
        warn.push(format!(
            "it {verb} {} instead of {}",
            zec_str(s.amounts.zec_zat),
            zec_str(p.zec_zat)
        ));
    }
    if p.leg == 1 {
        if units > limit {
            warn.push(format!(
                "it pays {} (your limit is {})",
                units_str(units, &unit),
                units_str(limit, &unit)
            ));
        }
        if s.sweep_to.as_deref() != Some(r.sweep_to.as_str()) && !r.zec_elsewhere {
            r.zec_elsewhere = true;
            r.hold = Some(format!(
                "{} paid the ZEC to its own wallet instead of your leg-2 wallet, so swap 2 can't use it",
                r.part_name(&p)
            ));
            warn.push("its ZEC goes to its own wallet, not your leg-2 wallet".into());
        }
    } else {
        if units < limit {
            warn.push(format!(
                "it receives {} (your minimum is {})",
                units_str(units, &unit),
                units_str(limit, &unit)
            ));
        }
        // ferryd writes the address in its chain's normal form (lowercase bech32, checksummed
        // hex), so compare without case.
        let same = |a: &Option<String>, b: &Option<String>| match (a, b) {
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
            (None, None) => true,
            _ => false,
        };
        if !same(&s.payout_to, &r.payout_to) {
            warn.push(match &r.payout_to {
                Some(to) => format!(
                    "its {} doesn't go to {to}, your payout address",
                    unit.ticker
                ),
                None => format!(
                    "its {} goes to another address than your wallet",
                    unit.ticker
                ),
            });
        }
    }
    let text = format!(
        "{} doesn't match the route: {}",
        r.part_name(&p),
        warn.join("; ")
    );
    if !warn.is_empty() && !r.timeline.iter().any(|e| e.label == text) {
        log_at(r, i, ctx.now, "warning", text);
    }
}

fn on_leg1(r: &mut Route, i: usize, s: &LegSwap, ctx: &Ctx) {
    if let Some((txid, height)) = s.sweep() {
        r.parts[i].sweep_txid = Some(txid);
        r.parts[i].sweep_height = height;
    }
    let name = r.part_name(&r.parts[i]);
    let ticker = r.legs[0].unit.ticker.clone();
    let alone = r.parts[i].of <= 1;
    match s.outcome.as_deref() {
        Some("swapped") => {}
        Some("refunded") => {
            let note = if alone {
                format!("{name} was called off and refunded: your {ticker} is back in your wallet, minus network fees. Swap 2 never started.")
            } else {
                format!("{name} was called off and refunded: its {ticker} is back in your wallet, minus network fees")
            };
            end_part(r, i, PartStatus::Refunded, Some(note), ctx);
            return stop_buying(r, ctx);
        }
        Some("punished") => {
            let note = if alone {
                format!("{name} failed and your {ticker} was lost: it was not refunded before the deadline, so the partner took it as the penalty. Swap 2 never started.")
            } else {
                format!("{name} failed and its {ticker} was lost: it was not refunded before the deadline, so the partner took it as the penalty")
            };
            end_part(r, i, PartStatus::Punished, Some(note), ctx);
            return stop_buying(r, ctx);
        }
        _ if s.aborted() => {
            let note = if alone {
                format!("{name} was called off before anything was locked. Nothing moved.")
            } else {
                format!("{name} was called off before anything was locked")
            };
            end_part(r, i, PartStatus::NotStarted, Some(note), ctx);
            return stop_buying(r, ctx);
        }
        _ if s.redeemed() => {}
        _ => return,
    }
    // The partner took coin A: the ZEC is the user's whatever happens next.
    if r.parts[i].status == PartStatus::Running {
        r.parts[i].status = PartStatus::Swapped;
        r.parts[i].ended_at = Some(ctx.now);
        let to = r.zec_wallet();
        let zat = r.parts[i].zec_zat.saturating_sub(ctx.policy.zec_fee_zat);
        log_at(
            r,
            i,
            ctx.now,
            "leg1_swapped",
            format!(
                "{name} is done: about {} is on its way to {to}",
                zec_str(zat)
            ),
        );
    }
    confirmations(r, i, ctx);
}

/// A leg-1 part's sweep depth, and whether leg 2 may spend its ZEC.
fn confirmations(r: &mut Route, i: usize, ctx: &Ctx) {
    let tip = r.zec.tip;
    let p = &mut r.parts[i];
    if p.status != PartStatus::Swapped || p.spendable {
        return;
    }
    if let (Some(h), Some(tip)) = (p.sweep_height, tip) {
        p.sweep_confs = if tip >= h {
            u32::try_from(tip - h + 1).unwrap_or(u32::MAX)
        } else {
            0
        };
    }
    if p.outcome.as_deref() == Some("swapped")
        && p.sweep_height.is_some()
        && p.sweep_confs >= ctx.policy.needed_confs
        && !r.zec_elsewhere
    {
        p.spendable = true;
        let text = if p.of <= 1 {
            format!("Your ZEC is in {} and can be spent", r.zec_wallet())
        } else {
            let name = r.part_name(&r.parts[i]);
            format!("The ZEC from {} can be spent", lower(&name))
        };
        log_at(r, i, ctx.now, "zec_spendable", text);
    }
}

fn on_leg2(r: &mut Route, i: usize, s: &LegSwap, ctx: &Ctx) {
    let name = r.part_name(&r.parts[i]);
    let got = units_str(s.amounts.btc_sat, &r.legs[1].unit);
    let alone = r.parts[i].of <= 1;
    match s.outcome.as_deref() {
        Some("swapped") => {
            end_part(r, i, PartStatus::Swapped, None, ctx);
            if !alone {
                let text = match &r.payout_to {
                    None => format!("{name} is done: you received {got}"),
                    Some(to) => format!("{name} is done: {got} went to {to}"),
                };
                log_at(r, i, ctx.now, "leg2_swapped", text);
            }
        }
        Some("punished") => {
            end_part(r, i, PartStatus::Swapped, None, ctx);
            if !alone {
                log_at(r, i, ctx.now, "leg2_swapped", format!("{name} is done: your partner vanished after locking, so you claimed their {got} as the penalty"));
            }
        }
        Some("refunded") => {
            r.parts[i].reclaimed = s.reclaimed();
            let note = format!("{name} was called off and refunded");
            end_part(r, i, PartStatus::Refunded, Some(note.clone()), ctx);
            if !alone {
                log_at(
                    r,
                    i,
                    ctx.now,
                    "leg2_refunded",
                    format!("{note}: its ZEC is back in {}", r.zec_wallet()),
                );
            }
        }
        _ if s.aborted() => {
            let note = format!("{name} was called off before anything was locked");
            end_part(r, i, PartStatus::NotStarted, Some(note.clone()), ctx);
            if !alone {
                log_at(r, i, ctx.now, "leg2_not_started", note);
            }
        }
        _ => {}
    }
}

fn end_part(r: &mut Route, i: usize, status: PartStatus, note: Option<String>, ctx: &Ctx) {
    let p = &mut r.parts[i];
    p.status = status;
    p.ended_at = Some(ctx.now);
    p.starting.inflight_since = None;
    if note.is_some() {
        p.note = note;
    }
    let (leg, multi, note) = (p.leg, p.of > 1, p.note.clone());
    if leg == 1 && status != PartStatus::Swapped && multi {
        if let Some(n) = note {
            let kind = match status {
                PartStatus::Refunded => "leg1_refunded",
                PartStatus::Punished => "leg1_punished",
                _ => "leg1_not_started",
            };
            log_at(r, i, ctx.now, kind, n);
        }
    }
}

/// A leg-1 part didn't buy: no further leg-1 part starts (what was bought is still sold).
fn stop_buying(r: &mut Route, ctx: &Ctx) {
    let ticker = r.legs[0].unit.ticker.clone();
    for i in 0..r.parts.len() {
        let p = &r.parts[i];
        if p.leg == 1 && p.never_sent() {
            let note = format!("Not started: an earlier part of swap 1 failed, so its {ticker} stayed in your wallet");
            r.parts[i].status = PartStatus::NotStarted;
            r.parts[i].ended_at = Some(ctx.now);
            r.parts[i].note = Some(note);
        }
    }
}

/// After every observation: stop, hold, schedule the next parts, plan leg 2 again if leg 1
/// ended short, and settle the route's phase.
fn advance(r: &mut Route, ctx: &Ctx) {
    let now = ctx.now;
    // A leg-2 part whose window is over ends, and the route holds.
    if let Some(i) = r
        .parts
        .iter()
        .position(|p| p.leg == 2 && p.status == PartStatus::Starting)
    {
        leg2_window(r, i, ctx);
    }
    // Stop: what hasn't started won't.
    if r.stop_requested {
        for p in r.parts.iter_mut() {
            let unstarted = matches!(p.status, PartStatus::Planned | PartStatus::Waiting)
                || (p.status == PartStatus::Starting && p.starting.inflight_since.is_none());
            if unstarted {
                p.status = PartStatus::NotStarted;
                p.ended_at = Some(now);
                p.note
                    .get_or_insert_with(|| "You stopped the route before it started".into());
            }
        }
    }
    // Holding: nothing new starts until continue; scheduled parts go back to the plan.
    if r.hold.is_some() || r.zec_elsewhere {
        for p in r.parts.iter_mut() {
            let unsent = p.status == PartStatus::Waiting
                || (p.status == PartStatus::Starting && p.starting.inflight_since.is_none());
            if unsent {
                p.status = PartStatus::Planned;
                p.not_before = None;
                p.starting.window_ends = None;
            }
        }
    }
    if !r.resting() {
        schedule(r, 1, ctx);
    }
    // Leg 1 is through: if it bought less than planned, leg 2 sells what it did buy.
    if r.leg1_through() && !r.stop_requested {
        let bought: u64 = r.plan(1).map(|p| p.zec_zat).sum();
        if r.planned_for != Some(bought) {
            r.planned_for = Some(bought);
            if bought == 0 {
                for p in r.parts.iter_mut().filter(|p| p.leg == 2 && p.never_sent()) {
                    p.status = PartStatus::NotStarted;
                    p.note = Some("Not started: swap 1 bought nothing".into());
                }
            } else {
                r.replan(None, ctx.policy, ctx.rand);
                let sells: Vec<u64> = r
                    .plan(2)
                    .filter(|p| p.status == PartStatus::Planned)
                    .map(|p| p.zec_zat)
                    .collect();
                let text = format!(
                    "Swap 1 bought {} of the planned {}: swap 2 now sells {} in {}",
                    zec_str(bought),
                    zec_str(r.zec_zat),
                    zec_str(sells.iter().sum()),
                    parts_str(&sells)
                );
                log(r, now, "replanned", text);
            }
        }
    }
    if !r.resting() {
        schedule(r, 2, ctx);
    }
    summarize(r, ctx);
}

/// A leg's next part: promote a scheduled one whose gap is over, or schedule the next one.
fn schedule(r: &mut Route, leg: u8, ctx: &Ctx) {
    let now = ctx.now;
    if r.lane(leg).is_none() {
        let next = match leg {
            1 => r
                .parts
                .iter()
                .position(|p| p.leg == 1 && p.status == PartStatus::Planned),
            _ => pick_sell(r, ctx),
        };
        let Some(i) = next else { return };
        let gap = if leg == 2 && r.no_gap {
            r.no_gap = false;
            0
        } else {
            let salt = (u64::from(leg) << 32) | u64::from(r.parts[i].n);
            draw(ctx.rand, salt, r.delay_secs)
        };
        let p = &mut r.parts[i];
        p.status = PartStatus::Waiting;
        p.not_before = Some(now.saturating_add(gap));
        if gap > 0 {
            let p = r.parts[i].clone();
            let text = if leg == 2 && p.of <= 1 {
                format!(
                    "Your ZEC is in {}. Privacy pause: swap 2 starts {}",
                    r.zec_wallet(),
                    in_about(gap)
                )
            } else {
                format!(
                    "{} ({}) starts {}, after a random gap",
                    r.part_name(&p),
                    zec_str(p.zec_zat),
                    in_about(gap)
                )
            };
            log_at(r, i, now, "pause", text);
        }
    }
    let Some(i) = r.lane(leg) else { return };
    let p = &mut r.parts[i];
    if p.status == PartStatus::Waiting && p.not_before.is_none_or(|t| now >= t) {
        p.status = PartStatus::Starting;
        let window = if leg == 1 {
            ctx.policy.leg1_busy_secs
        } else {
            ctx.policy.leg2_window_secs
        };
        p.starting.inflight_since = None;
        p.starting.next_at = now;
        p.starting.window_ends = Some(now.saturating_add(window));
        if p.starting.attempts == 0 {
            // Each part starts with its own partner where several are listed.
            p.starting.maker_idx = (p.n as usize).saturating_sub(1);
        }
    }
}

/// The next leg-2 part that leg 1's spendable ZEC covers and the wallet can lock now.
fn pick_sell(r: &mut Route, ctx: &Ctx) -> Option<usize> {
    let earned = r.earned();
    let spendable = r.zec.spendable_zat.unwrap_or(0);
    let reserve = ctx.policy.lock_reserve_zat;
    let mut short: Option<u64> = None;
    for (i, p) in r.parts.iter().enumerate() {
        if p.leg != 2 || p.status != PartStatus::Planned || p.zec_zat > earned {
            continue;
        }
        if r.zec.spendable_zat.is_some() && spendable >= p.zec_zat + reserve {
            r.zec.short_since = None;
            return Some(i);
        }
        short.get_or_insert(p.zec_zat + reserve);
    }
    match short {
        // More ZEC is coming from leg 1: wait for it.
        Some(_) if !r.leg1_through() => r.zec.short_since = None,
        Some(need) if r.zec.spendable_zat.is_some() => {
            let since = *r.zec.short_since.get_or_insert(ctx.now);
            if ctx.now >= since.saturating_add(ctx.policy.spendable_grace_secs) {
                r.hold = Some(format!(
                    "Your wallet can spend only {}, and swap 2 needs {} (its amount plus fees)",
                    zec_str(spendable),
                    zec_str(need)
                ));
            }
        }
        _ => {}
    }
    None
}

/// The route's phase from its parts; when nothing moves any more, how it ended.
fn summarize(r: &mut Route, ctx: &Ctx) {
    r.held_zat = r.held_estimate(ctx.policy);
    let resting = r.resting();
    let moving = r.parts.iter().any(|p| match p.status {
        PartStatus::Running => true,
        PartStatus::Starting => p.starting.inflight_since.is_some() || !resting,
        PartStatus::Waiting | PartStatus::Planned => !resting,
        _ => false,
    });
    if moving {
        let any = |leg: u8, s: PartStatus| r.parts.iter().any(|p| p.leg == leg && p.status == s);
        r.phase = if any(2, PartStatus::Running) {
            Phase::Leg2
        } else if any(2, PartStatus::Starting) {
            Phase::Leg2Starting
        } else if any(1, PartStatus::Running) {
            Phase::Leg1
        } else if any(1, PartStatus::Starting) {
            Phase::Leg1Starting
        } else if any(1, PartStatus::Waiting) || any(2, PartStatus::Waiting) {
            Phase::Pausing
        } else {
            Phase::Settling
        };
        r.outcome = None;
        return;
    }
    let (phase, outcome, why) = rest(r, ctx.policy);
    if r.phase != phase || r.reason.as_deref() != Some(why.as_str()) {
        let kind = match phase {
            Phase::Done => "done",
            Phase::Failed => "failed",
            _ => "holding",
        };
        log(r, ctx.now, kind, why.clone());
    }
    r.phase = phase;
    r.outcome = Some(outcome);
    r.reason = Some(why);
}

/// How a route that no longer moves ended.
fn rest(r: &Route, policy: &Policy) -> (Phase, Outcome, String) {
    let bought: u64 = r
        .parts
        .iter()
        .filter(|p| p.leg == 1 && p.status == PartStatus::Swapped)
        .map(|p| p.zec_zat)
        .sum();
    let leg1 = || r.parts.iter().filter(|p| p.leg == 1);
    if bought == 0 {
        let outcome = if leg1().any(|p| p.status == PartStatus::Punished) {
            Outcome::Punished
        } else if leg1().any(|p| p.status == PartStatus::Refunded) {
            Outcome::Refunded
        } else {
            Outcome::NotStarted
        };
        let why = if r.stop_requested && leg1().all(|p| p.swap_id.is_none()) {
            "You stopped the route before anything moved.".to_string()
        } else {
            leg1()
                .filter(|p| {
                    p.status != PartStatus::NotStarted
                        || p.swap_id.is_some()
                        || p.starting.attempts > 0
                })
                .find_map(|p| p.note.clone())
                .unwrap_or_else(|| "Nothing moved.".into())
        };
        return (Phase::Failed, outcome, why);
    }
    let sold: u64 = r
        .parts
        .iter()
        .filter(|p| p.leg == 2 && p.status == PartStatus::Swapped)
        .map(|p| p.zec_zat)
        .sum();
    if bought.saturating_sub(sold) <= r.left_zat && !r.zec_elsewhere {
        return (Phase::Done, Outcome::Swapped, done_text(r, policy));
    }
    (Phase::Holding, Outcome::HoldingZec, holding_text(r))
}

fn received(r: &Route) -> (u64, u64, usize) {
    let sold: Vec<&Part> = r
        .parts
        .iter()
        .filter(|p| p.leg == 2 && p.status == PartStatus::Swapped)
        .collect();
    (
        sold.iter().map(|p| p.counter_units.unwrap_or(0)).sum(),
        sold.iter().map(|p| p.zec_zat).sum(),
        sold.len(),
    )
}

fn done_text(r: &Route, policy: &Policy) -> String {
    let (units, zat, n) = received(r);
    let got = units_str(units, &r.legs[1].unit);
    let penalty = r.parts.iter().any(|p| {
        p.leg == 2 && p.status == PartStatus::Swapped && p.outcome.as_deref() == Some("punished")
    });
    let mut s = if n <= 1 {
        match (&r.payout_to, penalty) {
            (_, true) => format!(
                "Done: your partner vanished after locking, so you claimed their {got} as the penalty."
            ),
            (None, _) => format!("Done: you received {got}."),
            (Some(to), _) => format!("Done: {got} went to {to}, your payout address."),
        }
    } else {
        let mut s = match &r.payout_to {
            None => format!(
                "Done: you received {got} for {} in {n} parts.",
                zec_str(zat)
            ),
            Some(to) => format!(
                "Done: {got} went to {to}, your payout address, for {} in {n} parts.",
                zec_str(zat)
            ),
        };
        if penalty {
            s.push_str(
                " A partner vanished after locking, so you claimed its coin as the penalty.",
            );
        }
        s
    };
    for p in r
        .parts
        .iter()
        .filter(|p| p.leg == 1 && p.failed() && p.swap_id.is_some())
    {
        if let Some(note) = &p.note {
            s.push_str(&format!(" {note}."));
        }
    }
    if let Some(p) = r.parts.iter().find(|p| {
        p.leg == 1
            && p.status == PartStatus::NotStarted
            && p.swap_id.is_none()
            && p.starting.refused > 0
    }) {
        if let Some(note) = &p.note {
            s.push_str(&format!(" {note}."));
        }
    }
    let stays = r.held_zat;
    if r.standard() && stays > 10 * policy.zec_fee_zat {
        s.push_str(&format!(
            " About {} stays in {}: your next route uses it for fees.",
            zec_str(stays),
            r.zec_wallet()
        ));
    }
    s
}

fn holding_text(r: &Route) -> String {
    let why = if let Some(h) = &r.hold {
        h.clone()
    } else if r.stop_requested {
        let leg2_started = r.parts.iter().any(|p| p.leg == 2 && p.swap_id.is_some());
        if leg2_started {
            "You stopped the route".into()
        } else {
            "You stopped the route before swap 2".into()
        }
    } else {
        let notes: Vec<String> = r
            .parts
            .iter()
            .filter(|p| {
                p.leg == 2 && p.failed() && p.note.as_deref() != Some("Replaced by a new plan")
            })
            .filter_map(|p| p.note.clone())
            .collect();
        notes
            .last()
            .cloned()
            .unwrap_or_else(|| "Swap 2 didn't finish".into())
    };
    let held = units_str(
        r.held_zat,
        &Unit {
            ticker: String::new(),
            decimals: 8,
        },
    );
    let (units, zat, n) = received(r);
    if n > 0 {
        format!(
            "{why}. You received {} for {} so far, and hold about {held} shielded ZEC in {}.",
            units_str(units, &r.legs[1].unit),
            zec_str(zat),
            r.zec_wallet()
        )
    } else {
        format!(
            "{why}. You hold about {held} shielded ZEC in {}.",
            r.zec_wallet()
        )
    }
}

fn stop(r: &mut Route, ctx: &Ctx) -> Result<(), Refused> {
    match r.phase {
        Phase::Done | Phase::Failed => return Err(Refused("The route is over".into())),
        Phase::Holding => return Ok(()),
        _ => {}
    }
    let cancellable = r.parts.iter().any(|p| {
        matches!(
            p.status,
            PartStatus::Planned | PartStatus::Waiting | PartStatus::Starting
        )
    });
    if !cancellable {
        return Err(Refused(
            "Swap 2 is running and can't be stopped; if it fails, its refund returns your ZEC"
                .into(),
        ));
    }
    let in_flight = r.parts.iter().any(|p| {
        p.status == PartStatus::Running
            || (p.status == PartStatus::Starting && p.starting.inflight_since.is_some())
    });
    if !r.stop_requested && in_flight {
        let text = if r.plan(2).count() <= 1 && r.plan(1).count() <= 1 {
            "Stopping: swap 2 won't run. If swap 1 completes, you keep the ZEC."
        } else {
            "Stopping: the parts not yet started won't run. Parts under way finish, and you keep the ZEC they bring."
        };
        log(r, ctx.now, "stop_requested", text);
    }
    r.stop_requested = true;
    Ok(())
}

fn resume(r: &mut Route, req: &ContinueReq, ctx: &Ctx) -> Result<(), Refused> {
    match r.phase {
        Phase::Pausing => {
            apply_overrides(r, req, false)?;
            for p in r
                .parts
                .iter_mut()
                .filter(|p| p.status == PartStatus::Waiting)
            {
                p.not_before = Some(ctx.now);
            }
            log(
                r,
                ctx.now,
                "pause_skipped",
                "Privacy pause skipped at your request: a short gap between the swaps makes them easier to link.",
            );
            Ok(())
        }
        Phase::Holding => {
            if r.zec_elsewhere {
                return Err(Refused(format!(
                    "The ZEC is in {}, which swap 2 can't spend from",
                    r.zec_wallet()
                )));
            }
            if let Some(z) = req.zec_zat {
                let (unsold, _) = r.sell_room(ctx.policy);
                if z == 0 {
                    return Err(Refused("zec_zat must be positive".into()));
                }
                if z > unsold {
                    return Err(Refused(format!(
                        "zec_zat is more than the {} this route bought and hasn't sold",
                        zec_str(unsold)
                    )));
                }
            }
            let before = r.clone();
            r.hold = None;
            r.stop_requested = false;
            r.zec.short_since = None;
            r.reason = None;
            r.outcome = None;
            r.replan(req.zec_zat, ctx.policy, ctx.rand);
            if !r
                .parts
                .iter()
                .any(|p| p.leg == 2 && p.status == PartStatus::Planned)
            {
                *r = before;
                return Err(Refused(format!(
                    "Nothing left to sell: {} is less than the smallest standard amount once fees are paid",
                    zec_str(r.held_zat)
                )));
            }
            apply_overrides(r, req, true)?;
            r.no_gap = true;
            let sells: Vec<u64> = r
                .parts
                .iter()
                .filter(|p| p.leg == 2 && p.status == PartStatus::Planned)
                .map(|p| p.zec_zat)
                .collect();
            let floor: u64 = r
                .parts
                .iter()
                .filter(|p| p.leg == 2 && p.status == PartStatus::Planned)
                .map(|p| r.limit(p))
                .sum();
            let text = if sells.len() == 1 {
                format!(
                    "Trying swap 2 again: {} for at least {}",
                    zec_str(sells[0]),
                    units_str(floor, &r.legs[1].unit)
                )
            } else {
                format!(
                    "Trying swap 2 again: {} in {} for at least {}",
                    zec_str(sells.iter().sum()),
                    parts_str(&sells),
                    units_str(floor, &r.legs[1].unit)
                )
            };
            log(r, ctx.now, "continued", text);
            Ok(())
        }
        Phase::Settling => Err(Refused(
            "Your ZEC can't be spent yet; swap 2 starts by itself once it can".into(),
        )),
        Phase::Leg1Starting | Phase::Leg1 => Err(Refused("Swap 1 is still running".into())),
        Phase::Leg2Starting | Phase::Leg2 => Err(Refused("Swap 2 is already under way".into())),
        Phase::Done | Phase::Failed => Err(Refused("The route is over".into())),
    }
}

fn apply_overrides(r: &mut Route, req: &ContinueReq, holding: bool) -> Result<(), Refused> {
    if req.zec_zat.is_some() && !holding {
        return Err(Refused("The amount can change only while holding".into()));
    }
    if let Some(list) = &req.maker2 {
        if list.is_empty() {
            return Err(Refused("maker2 is empty".into()));
        }
        r.maker2 = list.clone();
    }
    if let Some(m) = req.min_out {
        if m == 0 {
            return Err(Refused("min_out must be positive".into()));
        }
        // For what is left to sell.
        let left: u64 = r
            .parts
            .iter()
            .filter(|p| p.leg == 2 && matches!(p.status, PartStatus::Planned | PartStatus::Waiting))
            .map(|p| p.zec_zat)
            .sum();
        r.min_out = m;
        r.min_out_basis_zat = if left > 0 { left } else { r.zec2_zat() };
    }
    Ok(())
}

/// Denominations a router may use: 1 to 16 sizes, each a whole multiple of 0.001 ZEC, the
/// largest at most 100 000 times their greatest common divisor (which bounds [`split_standard`]).
pub fn check_denominations(d: &[u64]) -> Result<Vec<u64>, String> {
    let mut d = d.to_vec();
    d.sort_unstable();
    d.dedup();
    if d.is_empty() || d.len() > 16 {
        return Err("give 1 to 16 denominations".into());
    }
    if let Some(x) = d.iter().find(|x| **x == 0 || **x % 100_000 != 0) {
        return Err(format!(
            "{} is not a positive whole multiple of 0.001 ZEC",
            zec_str(*x)
        ));
    }
    let g = d.iter().fold(0, |a, b| gcd(a, *b));
    if d[d.len() - 1] / g > 100_000 {
        return Err(
            "the largest denomination is more than 100 000 times their common divisor".into(),
        );
    }
    Ok(d)
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// The fewest parts summing to each amount up to a cap, in units of the denominations' common
/// divisor.
struct Sums<'a> {
    denoms: &'a [u64],
    unit: u64,
    /// fewest[v]: fewest parts summing to v units (u8::MAX: none within max_parts).
    fewest: Vec<u8>,
    /// last[v]: one part of such a sum (index into denoms).
    last: Vec<u8>,
}

impl<'a> Sums<'a> {
    fn new(cap: u64, denoms: &'a [u64], max_parts: usize) -> Sums<'a> {
        let unit = denoms.iter().fold(0, |a, b| gcd(a, *b)).max(1);
        let top = denoms.iter().copied().max().unwrap_or(0);
        let cap = cap.min(top.saturating_mul(max_parts as u64));
        let units = usize::try_from(cap / unit).unwrap_or(0);
        let max = u8::try_from(max_parts.min(MAX_PARTS_LIMIT)).unwrap_or(16);
        let mut fewest = vec![u8::MAX; units + 1];
        let mut last = vec![0u8; units + 1];
        fewest[0] = 0;
        // Larger denominations first, so equal counts prefer them.
        let mut order: Vec<usize> = (0..denoms.len()).collect();
        order.sort_by_key(|&i| std::cmp::Reverse(denoms[i]));
        for v in 1..=units {
            for &i in &order {
                let u = usize::try_from(denoms[i] / unit).unwrap_or(usize::MAX);
                if u > v {
                    continue;
                }
                let prev = fewest[v - u];
                if prev < max && prev + 1 < fewest[v] {
                    fewest[v] = prev + 1;
                    last[v] = i as u8;
                }
            }
        }
        Sums {
            denoms,
            unit,
            fewest,
            last,
        }
    }

    /// The largest sum at most `budget` in at most `max_parts` parts, largest first.
    fn best(&self, budget: u64, max_parts: usize) -> Vec<u64> {
        let top = usize::try_from(budget / self.unit)
            .unwrap_or(usize::MAX)
            .min(self.fewest.len().saturating_sub(1));
        for v in (1..=top).rev() {
            if usize::from(self.fewest[v]) <= max_parts {
                let mut out = vec![];
                let mut w = v;
                while w > 0 {
                    let d = self.denoms[usize::from(self.last[w])];
                    out.push(d);
                    w -= usize::try_from(d / self.unit).unwrap_or(w);
                }
                out.sort_unstable_by(|a, b| b.cmp(a));
                return out;
            }
        }
        vec![]
    }
}

/// The largest amount at most `budget` that is a sum of at most `max_parts` denominations, as
/// its fewest parts, largest first; empty when not even the smallest fits. 0.3 ZEC is three 0.1
/// parts (a greedy split would take 0.25 and be stuck with 0.05).
pub fn split_standard(budget: u64, denoms: &[u64], max_parts: usize) -> Vec<u64> {
    if denoms.is_empty() || max_parts == 0 {
        return vec![];
    }
    Sums::new(budget, denoms, max_parts).best(budget, max_parts)
}

/// Leg 2's standard parts: the most ZEC, in standard sizes, that `unsold` (what the route
/// bought and hasn't sold) holds and `wallet` (about what L2 holds for the route, the spare
/// included) can pay for. Each part's lock costs a fee and the last lock needs the reserve spare
/// at its start. Ties go to fewer parts.
pub fn plan_sells(
    unsold: u64,
    wallet: u64,
    denoms: &[u64],
    max_parts: usize,
    policy: &Policy,
) -> Vec<u64> {
    if denoms.is_empty() || max_parts == 0 {
        return vec![];
    }
    let room = |n: usize| {
        let fees = (n as u64).saturating_mul(policy.zec_fee_zat) + policy.slack();
        unsold.min(wallet.saturating_sub(fees))
    };
    let sums = Sums::new(room(1), denoms, max_parts);
    let mut best: Vec<u64> = vec![];
    for n in 1..=max_parts {
        let parts = sums.best(room(n), n);
        if parts.iter().sum::<u64>() > best.iter().sum::<u64>() {
            best = parts;
        }
    }
    best
}

/// SplitMix64: one well-mixed word from another.
fn mix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// A gap drawn uniformly from `[lo, hi]` seconds; `salt` keeps draws in one step apart.
pub fn draw(rand: u64, salt: u64, [lo, hi]: [u64; 2]) -> u64 {
    let span = hi.saturating_sub(lo).saturating_add(1);
    lo.saturating_add(mix(rand ^ mix(salt)) % span)
}

fn shuffle(v: &mut [u64], seed: u64) {
    for i in (1..v.len()).rev() {
        let j = (mix(seed ^ mix(i as u64)) % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
}

/// "3 parts (0.5, 0.25 and 0.1 ZEC)", "1 part".
fn parts_str(sizes: &[u64]) -> String {
    let each: Vec<String> = sizes
        .iter()
        .map(|z| {
            units_str(
                *z,
                &Unit {
                    ticker: String::new(),
                    decimals: 8,
                },
            )
        })
        .collect();
    match each.len() {
        0 => "no parts".into(),
        1 => "1 part".into(),
        n => {
            let (head, last) = each.split_at(n - 1);
            format!("{n} parts ({} and {} ZEC)", head.join(", "), last[0])
        }
    }
}

/// "0.25" (ZEC, at most 8 decimals) → `25_000_000` zat.
pub fn parse_zec(s: &str) -> Option<u64> {
    let s = s.trim();
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty() && frac.is_empty()
        || frac.len() > 8
        || !whole
            .bytes()
            .chain(frac.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let whole: u64 = if whole.is_empty() {
        0
    } else {
        whole.parse().ok()?
    };
    let frac: u64 = format!("{frac:0<8}").parse().ok()?;
    whole.checked_mul(100_000_000)?.checked_add(frac)
}

/// `123_450_000` → "1.2345 ZEC".
pub fn zec_str(zat: u64) -> String {
    units_str(
        zat,
        &Unit {
            ticker: "ZEC".into(),
            decimals: 8,
        },
    )
}

/// Base units in whole coins, trailing zeros trimmed: `3_910_000` USDC (6) → "3.91 USDC".
pub fn units_str(units: u64, unit: &Unit) -> String {
    let d = u32::from(unit.decimals.min(19));
    let scale = 10u128.pow(d);
    let (whole, frac) = (u128::from(units) / scale, u128::from(units) % scale);
    let mut s = whole.to_string();
    if frac > 0 {
        let f = format!("{frac:0width$}", width = d as usize);
        s.push('.');
        s.push_str(f.trim_end_matches('0'));
    }
    if unit.ticker.is_empty() {
        s
    } else {
        format!("{s} {}", unit.ticker)
    }
}

/// "in less than a minute", "in about 12 minutes".
pub fn in_about(secs: u64) -> String {
    if secs < 60 {
        "in less than a minute".into()
    } else {
        format!("in about {}", duration_str(secs))
    }
}

pub fn duration_str(secs: u64) -> String {
    match secs {
        0..=89 => "1 minute".into(),
        90..=5399 => format!("{} minutes", (secs + 30) / 60),
        _ => {
            let (h, m) = (secs / 3600, (secs % 3600 + 30) / 60);
            if m == 0 || m == 60 {
                format!("{} h", h + u64::from(m == 60))
            } else {
                format!("{h} h {m} min")
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::legs::{SwapAmounts, SwapEntry};

    pub(crate) const T0: u64 = 1_800_000_000;
    pub(crate) const X: u64 = 100_000_000;
    const ZEC: u64 = 100_000_000;

    pub(crate) fn maker(url: &str, name: &str) -> Maker {
        Maker {
            url: url.into(),
            name: Some(name.into()),
        }
    }

    /// One swap each way, standard amounts off (the router's `--standard-amounts off`).
    pub(crate) fn params() -> NewRoute {
        NewRoute {
            id: "r0123456789abcdef".into(),
            now: T0,
            rand: 5,
            from: Leg {
                pair: "btc".into(),
                role: Role::B,
                unit: Unit {
                    ticker: "BTC".into(),
                    decimals: 8,
                },
                wallet: "user-b".into(),
            },
            to: Leg {
                pair: "usdc-base".into(),
                role: Role::Z,
                unit: Unit {
                    ticker: "USDC".into(),
                    decimals: 6,
                },
                wallet: "user-z".into(),
            },
            zec_zat: X,
            denominations: vec![],
            max_parts: MAX_PARTS,
            spare_zat: 0,
            keep_zat: 0,
            max_in: 412_500,
            min_out: 39_200_000,
            delay_secs: [300, 1800],
            sweep_to: "utest1l2".into(),
            payout_to: None,
            maker1: vec![maker("http://127.0.0.1:7111", "Kestrel")],
            maker2: vec![
                maker("http://127.0.0.1:7912", "Heron"),
                maker("http://127.0.0.1:7913", "Egret"),
            ],
        }
    }

    pub(crate) fn new_route(policy: &Policy) -> Route {
        Route::new(params(), policy).unwrap()
    }

    /// Standard amounts: `zec` asked, `spare` already in the leg-2 wallet.
    fn std_params(zec: u64, spare: u64) -> NewRoute {
        NewRoute {
            zec_zat: zec,
            denominations: DENOMINATIONS_ZAT.to_vec(),
            spare_zat: spare,
            ..params()
        }
    }

    fn std_route(zec: u64, spare: u64) -> Route {
        Route::new(std_params(zec, spare), &Policy::default()).unwrap()
    }

    fn sizes(r: &Route, leg: u8) -> Vec<u64> {
        let mut v: Vec<u64> = r.plan(leg).map(|p| p.zec_zat).collect();
        v.sort_unstable_by(|a, b| b.cmp(a));
        v
    }

    fn pi(r: &Route, leg: u8, n: u32) -> &Part {
        &r.parts[r.part(leg, n).expect("part")]
    }

    /// A swap as part (leg, n)'s daemon would show it, terms matching the route.
    pub(crate) fn swap(r: &Route, leg: u8, n: u32, state: &str, outcome: Option<&str>) -> LegSwap {
        let p = pi(r, leg, n);
        let (role, units, sweep_to, payout_to) = match leg {
            1 => (Role::B, r.limit(p), Some(r.sweep_to.clone()), None),
            _ => (Role::Z, r.limit(p) + 1, None, r.payout_to.clone()),
        };
        LegSwap {
            id: format!("swap{leg}-{n}"),
            role,
            counterparty: p.maker.as_ref().map(|m| m.url.clone()).unwrap_or_default(),
            state: state.into(),
            outcome: outcome.map(Into::into),
            amounts: SwapAmounts {
                zec_zat: p.zec_zat,
                btc_sat: units,
            },
            timeline: vec![],
            watchtower: None,
            route: Some(p.label.clone()),
            sweep_to,
            payout_to,
        }
    }

    pub(crate) fn swept(r: &Route, n: u32, height: Option<u64>) -> LegSwap {
        let mut s = swap(r, 1, n, "ZecSwept", Some("swapped"));
        s.timeline.push(SwapEntry {
            at: String::new(),
            kind: "zec_sweep_broadcast".into(),
            txid: Some(format!("sweep{n}")),
            height,
        });
        s
    }

    fn salt(leg: u8, n: u32) -> u64 {
        (u64::from(leg) << 32) | u64::from(n)
    }

    fn waiting_at(r: &Route) -> Option<u64> {
        r.parts
            .iter()
            .filter(|p| p.status == PartStatus::Waiting)
            .filter_map(|p| p.not_before)
            .min()
    }

    struct Run {
        policy: Policy,
        now: u64,
        rand: u64,
    }

    impl Run {
        fn new() -> Run {
            Run {
                policy: Policy::default(),
                now: T0,
                rand: 7,
            }
        }

        fn ctx(&self) -> Ctx<'_> {
            Ctx {
                now: self.now,
                rand: self.rand,
                policy: &self.policy,
            }
        }

        fn step(&self, r: &Route, obs: Obs) -> (Route, Option<Command>) {
            step(r, &obs, &self.ctx()).expect("not refused")
        }

        fn user(&self, r: &Route, obs: Obs) -> Result<Route, Refused> {
            step(r, &obs, &self.ctx()).map(|(r, _)| r)
        }

        fn lookup(&self, r: &Route, leg: u8, n: u32) -> (Route, Option<Command>) {
            self.step(
                r,
                Obs::Lookup {
                    leg,
                    part: n,
                    swap: None,
                },
            )
        }

        fn started(&self, r: &Route, leg: u8, n: u32) -> Route {
            let id = format!("swap{leg}-{n}");
            self.step(
                r,
                Obs::Started {
                    leg,
                    part: n,
                    result: Ok(id),
                },
            )
            .0
        }

        fn sw(&self, r: &Route, leg: u8, n: u32, state: &str, outcome: Option<&str>) -> Route {
            let s = swap(r, leg, n, state, outcome);
            self.step(
                r,
                Obs::Swap {
                    leg,
                    part: n,
                    swap: s,
                },
            )
            .0
        }

        /// Drive a route in one part each way to the given phase along the happy path.
        fn to(&mut self, target: Phase) -> Route {
            self.drive_to(new_route(&self.policy), target)
        }

        fn drive_to(&mut self, mut r: Route, target: Phase) -> Route {
            let path = [
                Phase::Leg1Starting,
                Phase::Leg1,
                Phase::Settling,
                Phase::Pausing,
                Phase::Leg2Starting,
                Phase::Leg2,
            ];
            for p in path {
                if r.phase == target {
                    return r;
                }
                assert_eq!(r.phase, p, "{:?}", r.timeline);
                r = match p {
                    Phase::Leg1Starting => {
                        let (r, _) = self.lookup(&r, 1, 1);
                        self.started(&r, 1, 1)
                    }
                    Phase::Leg1 => self.sw(&r, 1, 1, "BtcRedeemed", None),
                    Phase::Settling => {
                        let s = swept(&r, 1, Some(100));
                        let (r, _) = self.step(
                            &r,
                            Obs::Swap {
                                leg: 1,
                                part: 1,
                                swap: s,
                            },
                        );
                        let need = r.zec2_zat() + 50_000;
                        self.step(
                            &r,
                            Obs::Zec {
                                tip: 109,
                                spendable_zat: need,
                            },
                        )
                        .0
                    }
                    Phase::Pausing => {
                        self.now = waiting_at(&r).unwrap();
                        self.step(&r, Obs::Tick).0
                    }
                    Phase::Leg2Starting => {
                        let n = r.plan(2).next().unwrap().n;
                        let (r, _) = self.lookup(&r, 2, n);
                        self.started(&r, 2, n)
                    }
                    _ => unreachable!(),
                };
            }
            assert_eq!(r.phase, target);
            r
        }
    }

    fn roundtrip(r: &Route) -> Route {
        serde_json::from_slice(&serde_json::to_vec(r).unwrap()).unwrap()
    }

    // ------------------------------------------------------------ splitting into standard sizes

    #[test]
    fn standard_splits_take_the_fewest_parts() {
        let d = DENOMINATIONS_ZAT;
        let z = |x: f64| (x * 1e8).round() as u64;
        let split = |budget: f64, max: usize| -> Vec<u64> { split_standard(z(budget), &d, max) };
        assert_eq!(split(1.0, 8), [z(1.0)]);
        assert_eq!(split(0.85, 8), [z(0.5), z(0.25), z(0.1)]);
        // Not greedy: 0.25 would leave 0.05, which nothing makes.
        assert_eq!(split(0.3, 8), [z(0.1), z(0.1), z(0.1)]);
        assert_eq!(split(0.37, 8), [z(0.25), z(0.1)], "rounded down to 0.35");
        assert_eq!(split(7.0, 8), [z(5.0), z(1.0), z(1.0)]);
        assert_eq!(split(0.09, 8), Vec::<u64>::new());
        assert_eq!(split(0.2, 1), [z(0.1)], "one part at most");
        assert_eq!(split(0.95, 3), [z(0.5), z(0.25), z(0.1)], "0.95 needs 4");
        // Far past what 8 parts carry: 8 × 100 ZEC.
        assert_eq!(split(5000.0, 8), vec![z(100.0); 8]);
        assert_eq!(split_standard(z(1.0), &[], 8), Vec::<u64>::new());
        assert_eq!(split_standard(z(1.0), &d, 0), Vec::<u64>::new());
    }

    /// Against brute force: every multiset of up to 4 parts, for budgets on a 0.01 ZEC grid.
    #[test]
    fn standard_splits_match_brute_force() {
        let d: Vec<u64> = DENOMINATIONS_ZAT[..6].to_vec(); // up to 5 ZEC
        let mut sums: Vec<(u64, usize)> = vec![(0, 0)];
        let mut frontier = vec![(0u64, 0usize, 0usize)]; // (sum, parts, first denomination index)
        for _ in 0..4 {
            let mut next = vec![];
            for &(s, k, from) in &frontier {
                for (j, x) in d.iter().enumerate().skip(from) {
                    next.push((s + x, k + 1, j));
                    sums.push((s + x, k + 1));
                }
            }
            frontier = next;
        }
        for cents in 0..=1200u64 {
            let budget = cents * 1_000_000;
            let best = sums
                .iter()
                .filter(|(s, _)| *s <= budget)
                .map(|(s, _)| *s)
                .max()
                .unwrap();
            let fewest = sums
                .iter()
                .filter(|(s, _)| *s == best)
                .map(|(_, k)| *k)
                .min()
                .unwrap();
            let got = split_standard(budget, &d, 4);
            assert_eq!(got.iter().sum::<u64>(), best, "budget {budget}");
            assert_eq!(got.len(), fewest, "budget {budget}");
            assert!(got.iter().all(|x| d.contains(x)));
        }
    }

    #[test]
    fn leg_two_sells_the_same_sizes_when_the_wallet_pays_the_fees() {
        let policy = Policy::default();
        let d = DENOMINATIONS_ZAT;
        let z = |x: f64| (x * 1e8).round() as u64;
        // A fresh wallet: the fees come out of the route's own ZEC, so 1 ZEC can't be sold
        // whole; the most that fits after them is 0.95, and the rest stays as shielded ZEC.
        let fresh = plan_sells(ZEC, ZEC - 10_000, &d, 8, &policy);
        assert_eq!(fresh, [z(0.5), z(0.25), z(0.1), z(0.1)]);
        // 0.0006 ZEC spare covers the sweep, the lock and the reserve: the same 1 ZEC.
        let spare = 60_000;
        assert_eq!(plan_sells(ZEC, ZEC - 10_000 + spare, &d, 8, &policy), [ZEC]);
        assert_eq!(
            plan_sells(ZEC, ZEC - 10_000 + spare - 1, &d, 8, &policy),
            fresh
        );
        // Never more than the route bought, whatever the wallet holds.
        assert_eq!(plan_sells(ZEC, 50 * ZEC, &d, 8, &policy), [ZEC]);
        assert_eq!(
            plan_sells(z(0.1), z(0.1) - 10_000, &d, 8, &policy),
            Vec::<u64>::new()
        );
    }

    #[test]
    fn denominations_and_amounts_parse() {
        assert_eq!(
            check_denominations(&DENOMINATIONS_ZAT),
            Ok(DENOMINATIONS_ZAT.to_vec())
        );
        assert_eq!(
            check_denominations(&[ZEC, 10_000_000, ZEC]),
            Ok(vec![10_000_000, ZEC])
        );
        assert!(check_denominations(&[]).is_err());
        assert!(
            check_denominations(&[123_456]).is_err(),
            "not a multiple of 0.001 ZEC"
        );
        assert!(
            check_denominations(&[100_000, 100_000 * 200_000]).is_err(),
            "too far apart"
        );
        assert_eq!(parse_zec("0.25"), Some(25_000_000));
        assert_eq!(parse_zec("100"), Some(10_000_000_000));
        assert_eq!(parse_zec(".1"), Some(10_000_000));
        assert_eq!(parse_zec("0.00000001"), Some(1));
        for bad in ["", ".", "1.000000001", "-1", "1e3", "0x10", "1.2.3"] {
            assert_eq!(parse_zec(bad), None, "{bad:?}");
        }
    }

    // ------------------------------------------------------------ creating a route in parts

    #[test]
    fn a_standard_route_is_planned_in_parts() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let r = std_route(z(0.85), 0);
        assert!(r.standard());
        assert_eq!(sizes(&r, 1), [z(0.5), z(0.25), z(0.1)]);
        assert_eq!(r.zec_zat, z(0.85));
        // A fresh wallet: what fits after fees, the rest kept as shielded ZEC.
        assert_eq!(sizes(&r, 2), [z(0.5), z(0.1), z(0.1), z(0.1)]);
        assert_eq!(r.left_zat, z(0.05));
        assert!(r.parts.iter().all(|p| p.standard));
        // Labels: <route>/<leg>/<n>, unique; parts numbered in the order they run.
        let labels: Vec<&str> = r.parts.iter().map(|p| p.label.as_str()).collect();
        assert_eq!(
            labels[..3],
            [
                "r0123456789abcdef/1/1",
                "r0123456789abcdef/1/2",
                "r0123456789abcdef/1/3"
            ]
        );
        assert_eq!(labels[3], "r0123456789abcdef/2/1");
        // Only the first part of leg 1 is under way.
        assert_eq!(r.parts[0].status, PartStatus::Starting);
        assert!(r.parts[1..].iter().all(|p| p.status == PartStatus::Planned));
        assert_eq!(r.phase, Phase::Leg1Starting);
        // The price limits are rates: no part pays more, or takes less, than the user's rate.
        assert!(r.in_max() <= r.max_in);
        for p in r.plan(2) {
            assert!(
                u128::from(r.limit(p)) * u128::from(r.min_out_basis_zat)
                    >= u128::from(r.min_out) * u128::from(p.zec_zat)
            );
        }
        let created = &r.timeline[0].label;
        assert!(
            created.contains("buying 0.85 ZEC in 3 parts")
                && created.contains("selling 0.8 ZEC in 4 parts"),
            "{created}"
        );
        assert!(
            created.contains("stays in your wallet \"user-z\""),
            "{created}"
        );

        // A wallet with 0.001 ZEC spare pays the fees: leg 2 sells exactly what leg 1 buys.
        let r = std_route(z(0.85), 100_000);
        assert_eq!(sizes(&r, 2), sizes(&r, 1));
        assert_eq!(r.left_zat, 0);

        // A request between standard amounts is rounded down, and says so.
        let r = std_route(z(0.37), 0);
        assert_eq!((r.asked_zat, r.zec_zat), (z(0.37), z(0.35)));
        assert!(
            r.timeline[0].label.contains("You asked for 0.37 ZEC"),
            "{}",
            r.timeline[0].label
        );
        assert!(r.in_max() <= 412_500 * 35 / 37);

        // Too little: below the smallest size, or nothing left to sell after fees.
        let policy = Policy::default();
        assert!(Route::new(std_params(z(0.05), 0), &policy)
            .unwrap_err()
            .contains("smallest standard amount"));
        assert!(Route::new(std_params(z(0.1), 0), &policy)
            .unwrap_err()
            .contains("no standard amount"));
        assert_eq!(
            sizes(&Route::new(std_params(z(0.1), 60_000), &policy).unwrap(), 2),
            [z(0.1)]
        );
    }

    #[test]
    fn the_order_of_the_parts_is_random() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let orders: std::collections::BTreeSet<Vec<u64>> = (0..32)
            .map(|rand| {
                let r = Route::new(
                    NewRoute {
                        rand,
                        ..std_params(z(0.85), 0)
                    },
                    &Policy::default(),
                )
                .unwrap();
                r.parts
                    .iter()
                    .filter(|p| p.leg == 1)
                    .map(|p| p.zec_zat)
                    .collect()
            })
            .collect();
        assert!(orders.len() > 3, "{orders:?}");
    }

    #[test]
    fn a_payout_route_sells_in_one_part() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut p = std_params(z(0.85), 0);
        p.payout_to = Some("0x90F79bf6EB2c4f870365E785982E1f101E93b906".into());
        let r = Route::new(p, &Policy::default()).unwrap();
        assert_eq!(sizes(&r, 1), [z(0.5), z(0.25), z(0.1)]);
        // A deposit address takes one deposit: everything but the fees, in one swap.
        assert_eq!(sizes(&r, 2), [z(0.85) - 3 * 10_000 - 50_000]);
        assert!(!r.plan(2).next().unwrap().standard);
    }

    // ------------------------------------------------------------ one swap each way (off)

    /// A route ending on NEAR Intents: `payout_to` goes to leg 2's start only (leg 1 sweeps into
    /// the user's own leg-2 wallet as always), survives a save, and the end says where coin C
    /// went. A leg-2 swap that doesn't pay it (a daemon that ignored the field) is flagged.
    #[test]
    fn leg_two_pays_the_payout_address() {
        const PAY: &str = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
        let mut run = Run::new();
        let mut r = new_route(&run.policy);
        r.payout_to = Some(PAY.into());
        let (_, cmd) = run.lookup(&r, 1, 1);
        let Some(Command::Start {
            leg: 1, request, ..
        }) = cmd
        else {
            panic!("{cmd:?}")
        };
        assert_eq!(
            (request.payout_to, request.sweep_to.as_deref()),
            (None, Some("utest1l2"))
        );

        let mut r = run.to(Phase::Leg2Starting);
        r.payout_to = Some(PAY.into());
        let r = roundtrip(&r);
        assert_eq!(r.payout_to.as_deref(), Some(PAY));
        let (r, cmd) = run.lookup(&r, 2, 1);
        let Some(Command::Start {
            leg: 2, request, ..
        }) = cmd
        else {
            panic!("{cmd:?}")
        };
        assert_eq!(request.payout_to.as_deref(), Some(PAY));
        assert_eq!(
            request.min_counter,
            Some(39_200_000),
            "the floor still holds"
        );
        let body = serde_json::to_value(&request).unwrap();
        assert_eq!(body["payout_to"], PAY);
        let r = run.started(&r, 2, 1);
        // ferryd shows the address in its own form (here lowercase): the same address.
        let mut done = swap(&r, 2, 1, "Claimed", Some("swapped"));
        done.payout_to = Some(PAY.to_lowercase());
        let (end, _) = run.step(
            &r,
            Obs::Swap {
                leg: 2,
                part: 1,
                swap: done,
            },
        );
        assert_eq!(end.phase, Phase::Done);
        assert_eq!(
            end.reason.as_deref(),
            Some(format!("Done: 39.200001 USDC went to {PAY}, your payout address.").as_str())
        );
        assert!(!end.timeline.iter().any(|e| e.kind == "warning"));

        // The daemon paid its own wallet instead: said plainly.
        let mut ignored = swap(&r, 2, 1, "ZecLocked", None);
        ignored.payout_to = None;
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                leg: 2,
                part: 1,
                swap: ignored,
            },
        );
        let warning = r.timeline.iter().find(|e| e.kind == "warning").unwrap();
        assert!(
            warning.label.contains(&format!(
                "its USDC doesn't go to {PAY}, your payout address"
            )),
            "{}",
            warning.label
        );
    }

    #[test]
    fn happy_path() {
        let mut run = Run::new();
        let r = new_route(&run.policy);
        assert_eq!((r.phase, r.zec2_zat()), (Phase::Leg1Starting, X - 60_000));
        assert!(!r.standard());
        assert_eq!(r.parts.len(), 2);
        assert_eq!(r.parts[0].label, "r0123456789abcdef/1/1");

        // Leg 1 starts once, with the label, sweep_to and the price ceiling.
        let (r, cmd) = run.lookup(&r, 1, 1);
        let Some(Command::Start {
            leg: 1,
            part: 1,
            request,
        }) = cmd
        else {
            panic!("{cmd:?}")
        };
        assert_eq!(
            request,
            StartSwap {
                maker: "http://127.0.0.1:7111".into(),
                zec_zat: X,
                route: "r0123456789abcdef/1/1".into(),
                sweep_to: Some("utest1l2".into()),
                max_counter: Some(412_500),
                min_counter: None,
                payout_to: None,
            }
        );
        assert_eq!(
            r.parts[0].starting.inflight_since,
            Some(T0),
            "persisted before the call"
        );
        let (r, cmd) = run.step(
            &r,
            Obs::Started {
                leg: 1,
                part: 1,
                result: Ok("swap1".into()),
            },
        );
        assert_eq!(
            (r.phase, cmd, r.parts[0].swap_id.as_deref()),
            (Phase::Leg1, None, Some("swap1"))
        );

        // Running, then redeemed: settling.
        let r = run.sw(&r, 1, 1, "ZecSeen", None);
        assert_eq!(r.phase, Phase::Leg1);
        let r = run.sw(&r, 1, 1, "BtcRedeemed", None);
        assert_eq!((r.phase, r.held_zat), (Phase::Settling, X - 10_000));

        // Spendable after 10 confirmations: the pause is drawn inside the window.
        let need = r.zec2_zat() + 50_000;
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                leg: 1,
                part: 1,
                swap: swept(&r, 1, Some(100)),
            },
        );
        let (r, _) = run.step(
            &r,
            Obs::Zec {
                tip: 109,
                spendable_zat: need,
            },
        );
        let gap = draw(7, salt(2, 1), [300, 1800]);
        assert_eq!((r.phase, waiting_at(&r)), (Phase::Pausing, Some(T0 + gap)));
        assert_eq!(r.parts[0].sweep_confs, 10);
        assert!(r.problem.is_none());

        // Still pausing until not_before.
        run.now = T0 + gap - 1;
        assert_eq!(run.step(&r, Obs::Tick).0.phase, Phase::Pausing);
        run.now = T0 + gap;
        let (r, _) = run.step(&r, Obs::Tick);
        assert_eq!(r.phase, Phase::Leg2Starting);

        // Leg 2 starts once, with the price floor.
        let (r, cmd) = run.lookup(&r, 2, 1);
        let Some(Command::Start {
            leg: 2,
            part: 1,
            request,
        }) = cmd
        else {
            panic!("{cmd:?}")
        };
        assert_eq!(
            request,
            StartSwap {
                maker: "http://127.0.0.1:7912".into(),
                zec_zat: X - 60_000,
                route: "r0123456789abcdef/2/1".into(),
                sweep_to: None,
                max_counter: None,
                min_counter: Some(39_200_000),
                payout_to: None,
            }
        );
        let r = run.started(&r, 2, 1);
        assert_eq!(r.phase, Phase::Leg2);
        let r = run.sw(&r, 2, 1, "ZecLocked", None);
        assert_eq!(r.phase, Phase::Leg2);
        let r = run.sw(&r, 2, 1, "Claimed", Some("swapped"));
        assert_eq!((r.phase, r.outcome), (Phase::Done, Some(Outcome::Swapped)));
        assert_eq!(
            r.reason.as_deref(),
            Some("Done: you received 39.200001 USDC.")
        );
        assert!(
            !r.timeline.iter().any(|e| e.kind == "warning"),
            "{:?}",
            r.timeline
        );

        // Final: nothing moves it.
        assert_eq!(run.step(&r, Obs::Tick).0, r);
        assert!(run.user(&r, Obs::Stop).is_err());
        assert!(run.user(&r, Obs::Continue(ContinueReq::default())).is_err());
    }

    #[test]
    fn restart_while_starting_adopts_the_labelled_swap() {
        for leg in [1u8, 2] {
            let mut run = Run::new();
            let target = if leg == 1 {
                Phase::Leg1Starting
            } else {
                Phase::Leg2Starting
            };
            let r = run.to(target);
            // Crash right after persisting the in-flight start.
            let (r, cmd) = run.lookup(&r, leg, 1);
            assert!(cmd.is_some());
            let r = roundtrip(&r);
            // The swap exists: adopted, no second start.
            let found = swap(&r, leg, 1, "Negotiated", None);
            let (adopted, cmd) = run.step(
                &r,
                Obs::Lookup {
                    leg,
                    part: 1,
                    swap: Some(found),
                },
            );
            assert_eq!(cmd, None);
            assert_eq!(
                adopted.phase,
                if leg == 1 { Phase::Leg1 } else { Phase::Leg2 }
            );
            assert_eq!(
                pi(&adopted, leg, 1).swap_id.as_deref(),
                Some(format!("swap{leg}-1").as_str())
            );
            // An adopted swap that already finished is followed straight on.
            let finished = swap(&r, leg, 1, "Refunded", Some("refunded"));
            let (after, _) = run.step(
                &r,
                Obs::Lookup {
                    leg,
                    part: 1,
                    swap: Some(finished),
                },
            );
            assert_eq!(
                after.phase,
                if leg == 1 {
                    Phase::Failed
                } else {
                    Phase::Holding
                }
            );
        }
    }

    #[test]
    fn restart_while_starting_without_a_swap_waits_then_starts_once() {
        for leg in [1u8, 2] {
            let mut run = Run::new();
            let r = run.to(if leg == 1 {
                Phase::Leg1Starting
            } else {
                Phase::Leg2Starting
            });
            let t = run.now;
            let (r, cmd) = run.lookup(&r, leg, 1);
            assert!(cmd.is_some());
            let r = roundtrip(&r);
            // No swap yet: ferryd may still be negotiating. Wait out the grace period.
            run.now = t + 119;
            let (r, cmd) = run.lookup(&r, leg, 1);
            assert_eq!(cmd, None);
            assert!(!pi(&r, leg, 1).start_due(run.now, &run.policy));
            run.now = t + 120;
            assert!(pi(&r, leg, 1).start_due(run.now, &run.policy));
            let (r, cmd) = run.lookup(&r, leg, 1);
            let Some(Command::Start { request, .. }) = cmd else {
                panic!()
            };
            assert_eq!(
                request.route,
                pi(&r, leg, 1).label,
                "the same label: still one swap at most"
            );
            assert_eq!(pi(&r, leg, 1).starting.attempts, 2);
        }
    }

    #[test]
    fn a_lost_answer_keeps_the_start_in_flight() {
        let mut run = Run::new();
        let r = new_route(&run.policy);
        let (r, _) = run.lookup(&r, 1, 1);
        // The answer is lost after a long wait: the grace counts from then, so a daemon still
        // busy with the request gets the whole grace period to finish it.
        run.now = T0 + 100;
        let (r, cmd) = run.step(
            &r,
            Obs::Started {
                leg: 1,
                part: 1,
                result: Err(StartError::Unknown("timeout".into())),
            },
        );
        assert_eq!((r.phase, cmd), (Phase::Leg1Starting, None));
        assert_eq!(r.parts[0].starting.inflight_since, Some(T0 + 100));
        assert!(r
            .problem
            .as_deref()
            .unwrap()
            .contains("checking whether it started"));
        assert!(!r.parts[0].start_due(T0 + 200, &run.policy));
        assert!(r.parts[0].start_due(T0 + 220, &run.policy));
    }

    #[test]
    fn restart_in_every_other_phase_resumes_where_it_was() {
        for p in [Phase::Leg1, Phase::Settling, Phase::Pausing, Phase::Leg2] {
            let mut run = Run::new();
            let r = run.to(p);
            let back = roundtrip(&r);
            assert_eq!(back, r);
            assert!(back.phase.is_active());
            // A repeated observation is harmless.
            let obs = match p {
                Phase::Leg1 => Obs::Swap {
                    leg: 1,
                    part: 1,
                    swap: swap(&r, 1, 1, "BtcLocked", None),
                },
                Phase::Leg2 => Obs::Swap {
                    leg: 2,
                    part: 1,
                    swap: swap(&r, 2, 1, "ZecLocked", None),
                },
                Phase::Settling => Obs::Zec {
                    tip: 1,
                    spendable_zat: 0,
                },
                _ => Obs::Tick,
            };
            let (once, _) = run.step(&back, obs.clone());
            let (twice, cmd) = run.step(&once, obs);
            assert_eq!((twice.phase, cmd), (once.phase, None));
        }
    }

    #[test]
    fn leg1_refunded_punished_or_called_off_fails_the_route() {
        let cases = [
            (
                "Refunded",
                Some("refunded"),
                Outcome::Refunded,
                "back in your wallet",
            ),
            ("Punished", Some("punished"), Outcome::Punished, "was lost"),
            ("Aborted", None, Outcome::NotStarted, "Nothing moved"),
        ];
        for (state, outcome, want, text) in cases {
            let mut run = Run::new();
            let r = run.to(Phase::Leg1);
            let (r, cmd) = run.step(
                &r,
                Obs::Swap {
                    leg: 1,
                    part: 1,
                    swap: swap(&r, 1, 1, state, outcome),
                },
            );
            assert_eq!((r.phase, r.outcome, cmd), (Phase::Failed, Some(want), None));
            assert!(
                r.reason.as_deref().unwrap().contains(text),
                "{:?}",
                r.reason
            );
            assert!(
                r.parts.iter().all(|p| p.leg == 1 || p.swap_id.is_none()),
                "no leg 2"
            );
            assert!(!r.phase.is_active());
        }
    }

    #[test]
    fn leg1_start_refused_fails_but_busy_is_retried() {
        let mut run = Run::new();
        let r = new_route(&run.policy);
        let (r, _) = run.lookup(&r, 1, 1);
        let refused = |status: u16| Obs::Started {
            leg: 1,
            part: 1,
            result: Err(StartError::Refused {
                status,
                message: "The maker refused: price".into(),
            }),
        };
        let (failed, _) = run.step(&r, refused(400));
        assert_eq!(
            (failed.phase, failed.outcome),
            (Phase::Failed, Some(Outcome::NotStarted))
        );
        assert_eq!(
            failed.reason.as_deref(),
            Some("Swap 1 with Kestrel didn't start: The maker refused: price. Nothing moved.")
        );

        // 409: L1 is busy. Retried (after a fresh lookup) until the busy window ends.
        let (busy, _) = run.step(&r, refused(409));
        assert_eq!(
            (busy.phase, busy.parts[0].starting.inflight_since),
            (Phase::Leg1Starting, None)
        );
        run.now = T0 + 30;
        assert_eq!(run.lookup(&busy, 1, 1).1, None, "waits retry_secs");
        run.now = T0 + 60;
        let (busy, cmd) = run.lookup(&busy, 1, 1);
        assert!(cmd.is_some());
        run.now = T0 + 300;
        let (gone, _) = run.step(&busy, refused(409));
        assert_eq!(gone.phase, Phase::Failed);
    }

    #[test]
    fn spendability_gate() {
        let mut run = Run::new();
        let r = run.to(Phase::Settling);
        let need = r.zec2_zat() + 50_000;
        // Leg 1 redeemed but the sweep is not out or not mined yet.
        let (r, _) = run.step(
            &r,
            Obs::Zec {
                tip: 50,
                spendable_zat: need,
            },
        );
        assert_eq!(r.phase, Phase::Settling);
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                leg: 1,
                part: 1,
                swap: swept(&r, 1, None),
            },
        );
        let (r, _) = run.step(
            &r,
            Obs::Zec {
                tip: 99,
                spendable_zat: need,
            },
        );
        assert_eq!(
            (
                r.phase,
                r.parts[0].sweep_confs,
                r.parts[0].sweep_txid.as_deref()
            ),
            (Phase::Settling, 0, Some("sweep1"))
        );
        // Mined at 100; 9 confirmations: not yet, even with the balance there.
        let (r, _) = run.step(
            &r,
            Obs::Zec {
                tip: 108,
                spendable_zat: need,
            },
        );
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                leg: 1,
                part: 1,
                swap: swept(&r, 1, Some(100)),
            },
        );
        assert_eq!((r.phase, r.parts[0].sweep_confs), (Phase::Settling, 9));
        // A tip read from a lagging node doesn't count down.
        let (r, _) = run.step(
            &r,
            Obs::Zec {
                tip: 99,
                spendable_zat: need,
            },
        );
        assert_eq!(
            (r.phase, r.parts[0].sweep_confs, r.parts[0].spendable),
            (Phase::Settling, 0, false)
        );
        // 10 confirmations but L2 can't spend enough yet.
        let (r, _) = run.step(
            &r,
            Obs::Zec {
                tip: 109,
                spendable_zat: need - 1,
            },
        );
        assert_eq!((r.phase, r.zec.short_since), (Phase::Settling, Some(T0)));
        assert!(waiting_at(&r).is_none());
        let (ok, _) = run.step(
            &r,
            Obs::Zec {
                tip: 109,
                spendable_zat: need,
            },
        );
        assert_eq!((ok.phase, ok.zec.short_since), (Phase::Pausing, None));
        // Still short after the grace: hold, with the numbers.
        run.now = T0 + 1800;
        let (held, _) = run.step(
            &r,
            Obs::Zec {
                tip: 200,
                spendable_zat: need - 1,
            },
        );
        assert_eq!(
            (held.phase, held.outcome),
            (Phase::Holding, Some(Outcome::HoldingZec))
        );
        assert!(
            held.reason.as_deref().unwrap().contains("can spend only"),
            "{:?}",
            held.reason
        );
    }

    #[test]
    fn pause_is_drawn_in_its_window_once() {
        let mut run = Run::new();
        for rand in [0u64, 1, 1500, 1501, u64::MAX] {
            run.rand = rand;
            let r = run.to(Phase::Pausing);
            let t = waiting_at(&r).unwrap();
            assert!((T0 + 300..=T0 + 1800).contains(&t), "{rand}: {t}");
            run.now = T0;
        }
        run.rand = 99;
        let p = run.to(Phase::Pausing);
        let drawn = waiting_at(&p);
        // Restart and the same observation again, with other randomness: not redrawn.
        run.rand = 12345;
        let p2 = roundtrip(&p);
        let (p3, _) = run.step(
            &p2,
            Obs::Zec {
                tip: 120,
                spendable_zat: X,
            },
        );
        assert_eq!((waiting_at(&p3), p3.phase), (drawn, Phase::Pausing));
        // Off: no pause.
        let mut r = new_route(&run.policy);
        r.delay_secs = [0, 0];
        let r = run.drive_to(r, Phase::Leg2Starting);
        assert_eq!(r.parts[1].not_before, Some(run.now));
    }

    #[test]
    fn leg2_refusals_rotate_makers_then_hold_when_the_window_ends() {
        let mut run = Run::new();
        let r = run.to(Phase::Leg2Starting);
        let t = run.now;
        let refused = |status, msg: &str| Obs::Started {
            leg: 2,
            part: 1,
            result: Err(StartError::Refused {
                status,
                message: msg.into(),
            }),
        };
        let mut r = r;
        let mut makers = vec![];
        for (i, status) in [409u16, 400, 502, 400].into_iter().enumerate() {
            run.now = t + 60 * i as u64;
            let (next, cmd) = run.lookup(&r, 2, 1);
            let Some(Command::Start { request, .. }) = cmd else {
                panic!("attempt {i}")
            };
            makers.push(request.maker);
            let (next, _) = run.step(
                &next,
                refused(status, "Z does not have enough shielded ZEC"),
            );
            assert_eq!(next.phase, Phase::Leg2Starting);
            assert!(next.problem.is_some());
            // Not before retry_secs.
            assert_eq!(run.lookup(&next, 2, 1).1, None);
            r = next;
        }
        assert_eq!(
            makers,
            [
                "http://127.0.0.1:7912",
                "http://127.0.0.1:7913",
                "http://127.0.0.1:7912",
                "http://127.0.0.1:7913"
            ]
        );
        // The same refusal is logged once.
        assert_eq!(
            r.timeline
                .iter()
                .filter(|e| e.kind == "leg2_refused")
                .count(),
            1
        );
        run.now = t + 7200;
        let (held, cmd) = run.step(&r, Obs::Tick);
        assert_eq!((held.phase, cmd), (Phase::Holding, None));
        let why = held.reason.unwrap();
        assert!(
            why.contains("within 120 minutes")
                && why.contains("You hold about 0.9999 shielded ZEC"),
            "{why}"
        );
        assert!(why.contains("\"user-z\""), "{why}");
    }

    #[test]
    fn leg2_window_needs_one_try_and_no_start_in_flight() {
        let mut run = Run::new();
        let r = run.to(Phase::Leg2Starting);
        // The router was down for the whole window: still try once.
        run.now += 3 * 3600;
        let (r2, _) = run.step(&r, Obs::Tick);
        assert_eq!(r2.phase, Phase::Leg2Starting);
        let (r2, cmd) = run.lookup(&r2, 2, 1);
        assert!(cmd.is_some());
        // With a start in flight, an unreachable daemon can't end the window.
        let (r3, _) = run.step(
            &r2,
            Obs::Unreachable {
                leg: 2,
                error: "refused".into(),
            },
        );
        assert_eq!(r3.phase, Phase::Leg2Starting);
        assert!(r3.problem.as_deref().unwrap().contains("usdc-base"));
        let (r4, _) = run.step(
            &r2,
            Obs::Started {
                leg: 2,
                part: 1,
                result: Err(StartError::Refused {
                    status: 502,
                    message: "maker unreachable".into(),
                }),
            },
        );
        let (r5, _) = run.step(
            &r4,
            Obs::Unreachable {
                leg: 2,
                error: "refused".into(),
            },
        );
        assert_eq!(r5.phase, Phase::Holding);
    }

    #[test]
    fn price_floor_scales_with_the_leg2_amount() {
        let policy = Policy::default();
        let r = new_route(&policy);
        assert_eq!(r.out_min(), 39_200_000);
        // Jitter: 1.5% kept back, same rate floor, rounded up.
        let r = Route::new(
            NewRoute {
                keep_zat: 1_500_000,
                ..params()
            },
            &policy,
        )
        .unwrap();
        assert_eq!(r.zec2_zat(), r.min_out_basis_zat - 1_500_000);
        let exact = 39_200_000u128 * u128::from(r.zec2_zat());
        let want = exact.div_ceil(u128::from(r.min_out_basis_zat)) as u64;
        assert_eq!(r.out_min(), want);
        let mut run = Run::new();
        let rr = run.drive_to(r.clone(), Phase::Leg2Starting);
        let (_, cmd) = run.lookup(&rr, 2, 1);
        let Some(Command::Start { request, .. }) = cmd else {
            panic!()
        };
        assert_eq!(
            (request.min_counter, request.zec_zat),
            (Some(want), r.zec2_zat())
        );
    }

    #[test]
    fn price_limit_refusal_holds_the_zec() {
        let mut run = Run::new();
        run.policy.leg2_window_secs = 120;
        let r = run.to(Phase::Leg2Starting);
        let (r, _) = run.lookup(&r, 2, 1);
        let msg = "The maker pays 38000000 for 0.9994 ZEC, below your minimum of 39200000";
        let (r, _) = run.step(
            &r,
            Obs::Started {
                leg: 2,
                part: 1,
                result: Err(StartError::Refused {
                    status: 400,
                    message: msg.into(),
                }),
            },
        );
        run.now += 120;
        let (r, _) = run.step(&r, Obs::Tick);
        assert_eq!(
            (r.phase, r.outcome),
            (Phase::Holding, Some(Outcome::HoldingZec))
        );
        assert!(r.reason.as_deref().unwrap().contains("below your minimum"));
    }

    #[test]
    fn a_daemon_ignoring_the_limits_is_reported() {
        let mut run = Run::new();
        let r = run.to(Phase::Leg2);
        let mut s = swap(&r, 2, 1, "ZecLocked", None);
        s.amounts.btc_sat = r.out_min() - 1;
        s.route = None;
        let (r2, _) = run.step(
            &r,
            Obs::Swap {
                leg: 2,
                part: 1,
                swap: s.clone(),
            },
        );
        let w: Vec<_> = r2.timeline.iter().filter(|e| e.kind == "warning").collect();
        assert_eq!(w.len(), 1);
        assert!(w[0].label.contains("your minimum") && w[0].label.contains("route label"));
        // Not repeated every tick.
        let (r3, _) = run.step(
            &r2,
            Obs::Swap {
                leg: 2,
                part: 1,
                swap: s,
            },
        );
        assert_eq!(r3.timeline.len(), r2.timeline.len());

        // Leg 1 sweeping to its own wallet: hold in L1's wallet once swapped, no leg 2.
        let r = run.to(Phase::Leg1);
        let mut s = swap(&r, 1, 1, "BtcRedeemed", None);
        s.sweep_to = None;
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                leg: 1,
                part: 1,
                swap: s,
            },
        );
        assert!(r.zec_elsewhere);
        assert_eq!(r.phase, Phase::Holding);
        assert!(
            r.reason.as_deref().unwrap().contains("\"user-b\""),
            "{:?}",
            r.reason
        );
        assert!(run.user(&r, Obs::Continue(ContinueReq::default())).is_err());
    }

    #[test]
    fn leg2_outcomes() {
        let mut run = Run::new();
        let r = run.to(Phase::Leg2);
        let done = run.sw(&r, 2, 1, "Punished", Some("punished"));
        assert_eq!(
            (done.phase, done.outcome),
            (Phase::Done, Some(Outcome::Swapped))
        );
        assert!(done.reason.as_deref().unwrap().contains("penalty"));

        let held = run.sw(&r, 2, 1, "ZecReclaimed", Some("refunded"));
        assert_eq!(
            (held.phase, held.outcome),
            (Phase::Holding, Some(Outcome::HoldingZec))
        );
        assert_eq!(held.held_zat, X - 30_000, "sweep + lock + reclaim fees");
        assert!(held
            .reason
            .as_deref()
            .unwrap()
            .contains("You hold about 0.9997 shielded ZEC in your wallet \"user-z\"."));

        // Refunded before Z locked anything: nothing spent.
        let held = run.sw(&r, 2, 1, "Refunded", Some("refunded"));
        assert_eq!((held.phase, held.held_zat), (Phase::Holding, X - 10_000));
        let held = run.sw(&r, 2, 1, "Aborted", None);
        assert_eq!(held.phase, Phase::Holding);
        // ZecLockRefused waits for the refund to finish.
        let wait = run.sw(&r, 2, 1, "ZecLockRefused", None);
        assert_eq!(wait.phase, Phase::Leg2);
    }

    #[test]
    fn stop() {
        let mut run = Run::new();
        // Before anything was sent: nothing moved.
        let r = run.to(Phase::Leg1Starting);
        let s = run.user(&r, Obs::Stop).unwrap();
        assert_eq!(
            (s.phase, s.outcome),
            (Phase::Failed, Some(Outcome::NotStarted))
        );
        assert_eq!(
            s.reason.as_deref(),
            Some("You stopped the route before anything moved.")
        );

        // A start in flight: wait to learn whether it happened.
        let (r, _) = run.lookup(&r, 1, 1);
        let s = run.user(&r, Obs::Stop).unwrap();
        assert!(s.stop_requested && s.phase == Phase::Leg1Starting);
        run.now += 120;
        let (gone, cmd) = run.lookup(&s, 1, 1);
        assert_eq!((gone.phase, cmd), (Phase::Failed, None));
        let (running, _) = run.step(
            &s,
            Obs::Lookup {
                leg: 1,
                part: 1,
                swap: Some(swap(&s, 1, 1, "BtcLocked", None)),
            },
        );
        assert_eq!(running.phase, Phase::Leg1);
        // ... it did: leg 1 runs to the end, then the route holds.
        let held = run.sw(&running, 1, 1, "BtcRedeemed", None);
        assert_eq!(
            (held.phase, held.outcome),
            (Phase::Holding, Some(Outcome::HoldingZec))
        );
        assert!(held
            .reason
            .as_deref()
            .unwrap()
            .starts_with("You stopped the route before swap 2."));

        for p in [Phase::Settling, Phase::Pausing] {
            let mut run = Run::new();
            let r = run.to(p);
            let s = run.user(&r, Obs::Stop).unwrap();
            assert_eq!(s.phase, Phase::Holding, "{p:?}");
            assert!(s.reason.as_deref().unwrap().contains("You stopped"));
            assert_eq!(run.user(&s, Obs::Stop).unwrap().phase, Phase::Holding);
        }
        let mut run = Run::new();
        let r = run.to(Phase::Leg2Starting);
        assert_eq!(run.user(&r, Obs::Stop).unwrap().phase, Phase::Holding);
        let (r, _) = run.lookup(&r, 2, 1);
        let s = run.user(&r, Obs::Stop).unwrap();
        assert_eq!(s.phase, Phase::Leg2Starting);
        run.now += 120;
        assert_eq!(run.lookup(&s, 2, 1).0.phase, Phase::Holding);
        let r = run.to(Phase::Leg2);
        assert!(run.user(&r, Obs::Stop).is_err(), "nothing left to stop");
    }

    #[test]
    fn continue_from_holding_and_skip_the_pause() {
        let mut run = Run::new();
        // Skipping the pause, with a warning.
        let r = run.to(Phase::Pausing);
        let s = run.user(&r, Obs::Continue(ContinueReq::default())).unwrap();
        assert_eq!(s.phase, Phase::Leg2Starting);
        assert!(s.timeline.iter().any(|e| e.kind == "pause_skipped"));
        // Not while settling or running.
        for p in [Phase::Settling, Phase::Leg1, Phase::Leg2] {
            let r = run.to(p);
            assert!(
                run.user(&r, Obs::Continue(ContinueReq::default())).is_err(),
                "{p:?}"
            );
        }

        // Leg 2 refunded with fees spent: continue tries a new swap under a new label.
        let r = run.to(Phase::Leg2);
        let held = run.sw(&r, 2, 1, "ZecReclaimed", Some("refunded"));
        let req = ContinueReq {
            maker2: Some(vec![maker("http://127.0.0.1:7914", "Ibis")]),
            ..ContinueReq::default()
        };
        let c = run.user(&held, Obs::Continue(req)).unwrap();
        assert_eq!(
            (c.phase, c.outcome),
            (Phase::Leg2Starting, None),
            "no new pause"
        );
        let next = c.plan(2).next().unwrap();
        assert_eq!((next.n, next.label.as_str()), (2, "r0123456789abcdef/2/2"));
        assert_eq!(
            next.zec_zat,
            X - 80_000,
            "what is left after the lock and reclaim fees"
        );
        assert!(c.limit(next) < 39_200_000, "the same rate for less ZEC");
        let (_, cmd) = run.lookup(&c, 2, 2);
        let Some(Command::Start { request, .. }) = cmd else {
            panic!()
        };
        assert_eq!(request.route, "r0123456789abcdef/2/2");
        assert_eq!(request.maker, "http://127.0.0.1:7914");
        assert_eq!(request.zec_zat, X - 80_000);
        // The earlier swap stays on record.
        assert_eq!(pi(&c, 2, 1).swap_id.as_deref(), Some("swap2-1"));

        // When the wallet can't show the amount yet (the reclaim isn't spendable), it waits.
        let mut short = held.clone();
        short.zec.spendable_zat = Some(1);
        let c = run
            .user(&short, Obs::Continue(ContinueReq::default()))
            .unwrap();
        assert_eq!(c.phase, Phase::Settling);

        // New amount and price floor.
        let req = ContinueReq {
            zec_zat: Some(50_000_000),
            min_out: Some(1_000),
            ..ContinueReq::default()
        };
        let c = run.user(&held, Obs::Continue(req)).unwrap();
        assert_eq!((c.zec2_zat(), c.out_min()), (50_000_000, 1_000));
        let bad = ContinueReq {
            min_out: Some(0),
            ..ContinueReq::default()
        };
        assert!(run.user(&held, Obs::Continue(bad)).is_err());
        let too_much = ContinueReq {
            zec_zat: Some(2 * X),
            ..ContinueReq::default()
        };
        assert!(run.user(&held, Obs::Continue(too_much)).is_err());
    }

    #[test]
    fn unreachable_daemons_only_note_a_problem() {
        let mut run = Run::new();
        for p in [
            Phase::Leg1Starting,
            Phase::Leg1,
            Phase::Settling,
            Phase::Leg2,
        ] {
            let r = run.to(p);
            let leg = if matches!(p, Phase::Leg2) { 2 } else { 1 };
            let (r2, cmd) = run.step(
                &r,
                Obs::Unreachable {
                    leg,
                    error: "connection refused".into(),
                },
            );
            assert_eq!((r2.phase, cmd), (p, None));
            assert!(r2.problem.is_some());
            run.now = T0;
        }
    }

    #[test]
    fn small_amounts_and_jitter_are_checked() {
        let policy = Policy::default();
        let mut p = NewRoute {
            zec_zat: 60_000,
            ..params()
        };
        assert!(Route::new(p.clone(), &policy)
            .unwrap_err()
            .contains("too little"));
        p.zec_zat = 160_000;
        p.keep_zat = 100_000;
        assert!(Route::new(p.clone(), &policy).is_err());
        p.keep_zat = 2_000;
        let r = Route::new(p, &policy).unwrap();
        assert_eq!((r.zec2_zat(), r.min_out_basis_zat), (98_000, 100_000));
    }

    #[test]
    fn partners() {
        let a = maker("http://127.0.0.1:7111", "Kestrel");
        assert!(a.same_partner(&maker("http://127.0.0.1:7111/", "Other")));
        assert!(
            !a.same_partner(&maker("http://127.0.0.1:7912", "Heron")),
            "local demo: ports differ"
        );
        assert!(
            a.same_partner(&maker("http://127.0.0.1:9999", "kestrel ")),
            "same name"
        );
        let m = |u: &str| Maker {
            url: u.into(),
            name: None,
        };
        assert!(m("https://kestrel.example:8443").same_partner(&m("https://KESTREL.example")));
        assert!(!m("https://kestrel.example").same_partner(&m("https://heron.example")));
        assert_eq!(
            m("https://kestrel.example").display(),
            "kestrel.example:443"
        );
    }

    #[test]
    fn amounts_in_words() {
        assert_eq!(zec_str(99_940_000), "0.9994 ZEC");
        assert_eq!(zec_str(100_000_000), "1 ZEC");
        let usdc = Unit {
            ticker: "USDC".into(),
            decimals: 6,
        };
        assert_eq!(units_str(3_910_000_000, &usdc), "3910 USDC");
        assert_eq!(units_str(1, &usdc), "0.000001 USDC");
        assert_eq!(duration_str(12 * 60), "12 minutes");
        assert_eq!(duration_str(3 * 3600 + 600), "3 h 10 min");
        assert_eq!(
            parts_str(&[50_000_000, 25_000_000, 10_000_000]),
            "3 parts (0.5, 0.25 and 0.1 ZEC)"
        );
        assert_eq!(parts_str(&[ZEC]), "1 part");
    }

    // ------------------------------------------------------------ routes in parts, driven

    /// The two daemons and the Zcash chain, as far as the router can see them: each start makes a
    /// swap (or is refused with 409 while the daemon runs one), each tick moves every swap one
    /// step on, the sweep lands in the leg-2 wallet and becomes spendable at 10 confirmations.
    struct Sim {
        run: Run,
        r: Route,
        tip: u64,
        /// L2's spendable ZEC that isn't the route's (the spare).
        spare: u64,
        swaps: Vec<(u8, u32, LegSwap, u64)>, // leg, part, swap, sweep height (leg 1)
        starts: Vec<StartSwap>,
        /// Leg-2 parts (by n) whose maker calls the swap off after Z locked.
        refund: Vec<u32>,
        /// Leg-1 parts (by n) whose swap is refunded.
        refund1: Vec<u32>,
        /// (time, leg) of every swap creation and end, for ordering checks.
        events: Vec<(u64, u8, &'static str, u32)>,
        restarts: bool,
        /// Every leg-2 start is refused with this (no swap is made).
        refuse2: Option<StartError>,
        refusals: u32,
        /// The driver doesn't look parts up (to stop between scheduling and starting).
        pause_starts: bool,
    }

    impl Sim {
        fn new(r: Route, spare: u64) -> Sim {
            Sim {
                run: Run::new(),
                r,
                tip: 100,
                spare,
                swaps: vec![],
                starts: vec![],
                refund: vec![],
                refund1: vec![],
                events: vec![],
                restarts: true,
                refuse2: None,
                refusals: 0,
                pause_starts: false,
            }
        }

        fn busy(&self, leg: u8) -> bool {
            self.swaps
                .iter()
                .any(|(l, _, s, _)| *l == leg && s.outcome.is_none() && !s.aborted())
        }

        /// L2's spendable balance: the spare, plus every buried sweep, less every lock.
        fn spendable(&self) -> u64 {
            let f = self.run.policy.zec_fee_zat;
            let mut v = self.spare as i128;
            for (leg, _, s, h) in &self.swaps {
                let z = i128::from(s.amounts.zec_zat);
                if *leg == 1 && s.outcome.as_deref() == Some("swapped") && self.tip >= h + 9 {
                    v += z - i128::from(f);
                }
                if *leg == 2 && s.state != "Negotiated" {
                    v -= z + i128::from(f);
                    if s.state == "ZecReclaimed" {
                        v += z - i128::from(f);
                    }
                }
            }
            v.max(0) as u64
        }

        fn apply(&mut self, obs: Obs) {
            let (r, cmd) = self.run.step(&self.r, obs);
            self.check(&r);
            self.r = if self.restarts { roundtrip(&r) } else { r };
            if let Some(Command::Start { leg, part, request }) = cmd {
                assert_eq!(request.route, pi(&self.r, leg, part).label);
                if let (2, Some(e)) = (leg, self.refuse2.clone()) {
                    self.refusals += 1;
                    let (r, _) = self.run.step(
                        &self.r,
                        Obs::Started {
                            leg,
                            part,
                            result: Err(e),
                        },
                    );
                    self.check(&r);
                    self.r = r;
                    return;
                }
                assert!(
                    !self.starts.iter().any(|s| s.route == request.route),
                    "{} started twice",
                    request.route
                );
                self.starts.push(request.clone());
                assert!(!self.busy(leg), "leg {leg}'s daemon was busy");
                let id = format!("swap{leg}-{part}");
                let mut s = swap(&self.r, leg, part, "Negotiated", None);
                s.id = id.clone();
                self.swaps.push((leg, part, s, 0));
                self.events.push((self.run.now, leg, "start", part));
                let (r, _) = self.run.step(
                    &self.r,
                    Obs::Started {
                        leg,
                        part,
                        result: Ok(id),
                    },
                );
                self.check(&r);
                self.r = r;
            }
        }

        /// Invariants after every step.
        fn check(&self, r: &Route) {
            // Leg 2 never sells ZEC leg 1 hasn't delivered (and made spendable).
            let ready: u64 = r
                .parts
                .iter()
                .filter(|p| p.leg == 1 && p.spendable)
                .map(|p| p.zec_zat)
                .sum();
            let selling: u64 = r
                .parts
                .iter()
                .filter(|p| {
                    p.leg == 2
                        && matches!(
                            p.status,
                            PartStatus::Starting | PartStatus::Running | PartStatus::Swapped
                        )
                })
                .map(|p| p.zec_zat)
                .sum();
            assert!(selling <= ready, "selling {selling} with {ready} ready");
            // At most one part of each leg holds its daemon.
            for leg in [1, 2] {
                assert!(
                    r.parts
                        .iter()
                        .filter(|p| p.leg == leg && p.holds_lane())
                        .count()
                        <= 1
                );
            }
        }

        /// One tick: the swaps move, then the router observes as the driver would.
        fn tick(&mut self) {
            self.run.now += 30;
            self.run.rand = mix(self.run.now);
            self.tip += 1;
            let tip = self.tip;
            let (refund, refund1) = (self.refund.clone(), self.refund1.clone());
            for (leg, n, s, h) in self.swaps.iter_mut() {
                let next = match (*leg, s.state.as_str()) {
                    (1, "Negotiated") => ("BtcLocked", None),
                    (1, "BtcLocked") if refund1.contains(n) => ("Refunded", Some("refunded")),
                    (1, "BtcLocked") => ("BtcRedeemed", None),
                    (1, "BtcRedeemed") => {
                        *h = tip;
                        s.timeline.push(SwapEntry {
                            at: String::new(),
                            kind: "zec_sweep_broadcast".into(),
                            txid: Some(format!("sweep{n}")),
                            height: Some(tip),
                        });
                        ("ZecSwept", Some("swapped"))
                    }
                    (2, "Negotiated") => ("ZecLocked", None),
                    (2, "ZecLocked") if refund.contains(n) => ("ZecReclaimed", Some("refunded")),
                    (2, "ZecLocked") => ("Claimed", Some("swapped")),
                    _ => continue,
                };
                if s.outcome.is_none() && next.1.is_some() {
                    self.events.push((self.run.now, *leg, "end", *n));
                }
                s.state = next.0.into();
                s.outcome = next.1.map(Into::into);
            }
            let r = self.r.clone();
            let mut obs = vec![];
            for p in r.parts.iter().filter(|p| p.followed()) {
                let s = self
                    .swaps
                    .iter()
                    .find(|(l, n, _, _)| *l == p.leg && *n == p.n)
                    .unwrap()
                    .2
                    .clone();
                obs.push(Obs::Swap {
                    leg: p.leg,
                    part: p.n,
                    swap: s,
                });
            }
            obs.push(Obs::Zec {
                tip,
                spendable_zat: self.spendable(),
            });
            for o in obs {
                self.apply(o);
            }
            if self.pause_starts {
                return;
            }
            let starting: Vec<(u8, u32)> = self
                .r
                .parts
                .iter()
                .filter(|p| p.status == PartStatus::Starting)
                .map(|p| (p.leg, p.n))
                .collect();
            for (leg, n) in starting {
                let label = pi(&self.r, leg, n).label.clone();
                let found = self
                    .swaps
                    .iter()
                    .find(|(l, _, s, _)| *l == leg && s.route.as_deref() == Some(label.as_str()))
                    .map(|x| x.2.clone());
                self.apply(Obs::Lookup {
                    leg,
                    part: n,
                    swap: found,
                });
            }
        }

        fn until(&mut self, what: impl Fn(&Route) -> bool) {
            for _ in 0..2000 {
                if what(&self.r) {
                    return;
                }
                self.tick();
            }
            panic!("never got there: {:?} {:#?}", self.r.phase, self.r.timeline);
        }
    }

    fn std_sim(zec: u64, spare: u64, delay: [u64; 2]) -> Sim {
        let r = Route::new(
            NewRoute {
                delay_secs: delay,
                ..std_params(zec, spare)
            },
            &Policy::default(),
        )
        .unwrap();
        let mut sim = Sim::new(r, spare);
        // The first part starts at once, as the API's create does.
        sim.apply(Obs::Lookup {
            leg: 1,
            part: 1,
            swap: None,
        });
        sim
    }

    #[test]
    fn a_route_in_parts_runs_to_done() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [60, 600]);
        sim.until(|r| r.phase.is_final());
        let r = &sim.r;
        assert_eq!(
            (r.phase, r.outcome),
            (Phase::Done, Some(Outcome::Swapped)),
            "{:#?}",
            r.timeline
        );
        // Every swap is a standard size, each label once, and each leg sold what it planned.
        assert!(sim
            .starts
            .iter()
            .all(|s| DENOMINATIONS_ZAT.contains(&s.zec_zat)));
        let leg = |s: &StartSwap| if s.sweep_to.is_some() { 1 } else { 2 };
        let mut buys: Vec<u64> = sim
            .starts
            .iter()
            .filter(|s| leg(s) == 1)
            .map(|s| s.zec_zat)
            .collect();
        let mut sells: Vec<u64> = sim
            .starts
            .iter()
            .filter(|s| leg(s) == 2)
            .map(|s| s.zec_zat)
            .collect();
        buys.sort_unstable();
        sells.sort_unstable();
        assert_eq!(buys, [z(0.1), z(0.25), z(0.5)]);
        assert_eq!(
            sells, buys,
            "with spare for the fees, leg 2 sells the same sizes"
        );
        // Each start carries its part's own price limit.
        for s in &sim.starts {
            if leg(s) == 1 {
                assert_eq!(
                    s.max_counter,
                    Some((412_500u128 * u128::from(s.zec_zat) / u128::from(z(0.85))) as u64)
                );
            } else {
                assert!(
                    s.min_counter.unwrap() as u128 * u128::from(r.min_out_basis_zat)
                        >= 39_200_000u128 * u128::from(s.zec_zat)
                );
            }
        }
        // The legs interleave: a sell starts before the last buy ends.
        let last_buy_end = sim
            .events
            .iter()
            .filter(|e| e.1 == 1 && e.2 == "end")
            .map(|e| e.0)
            .max()
            .unwrap();
        let first_sell = sim
            .events
            .iter()
            .filter(|e| e.1 == 2 && e.2 == "start")
            .map(|e| e.0)
            .min()
            .unwrap();
        assert!(first_sell < last_buy_end, "{:?}", sim.events);
        // Every part but the first waited its own random gap, and started only after it.
        let pauses = r.timeline.iter().filter(|e| e.kind == "pause").count();
        assert_eq!(pauses, r.parts.len() - 1);
        for p in r.parts.iter().filter(|p| !(p.leg == 1 && p.n == 1)) {
            assert!(p.started_at.unwrap() >= p.not_before.unwrap(), "{p:?}");
        }
        let gaps: std::collections::BTreeSet<u64> =
            r.parts.iter().filter_map(|p| p.not_before).collect();
        assert!(gaps.len() >= 4, "independent gaps: {gaps:?}");
        assert!(
            r.reason
                .as_deref()
                .unwrap()
                .starts_with("Done: you received"),
            "{:?}",
            r.reason
        );
        assert!(
            r.reason
                .as_deref()
                .unwrap()
                .contains("for 0.85 ZEC in 3 parts"),
            "{:?}",
            r.reason
        );
        // Each part's events carry its leg and number.
        assert!(r
            .timeline
            .iter()
            .any(|e| e.kind == "leg1_started" && e.part == Some(3)));
    }

    #[test]
    fn a_fresh_wallet_keeps_what_the_fees_leave() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(ZEC, 0, [0, 0]);
        assert_eq!(sizes(&sim.r, 2), [z(0.5), z(0.25), z(0.1), z(0.1)]);
        sim.until(|r| r.phase.is_final());
        let r = &sim.r;
        assert_eq!(r.phase, Phase::Done, "{:#?}", r.timeline);
        let why = r.reason.as_deref().unwrap();
        assert!(why.contains("for 0.95 ZEC in 4 parts"), "{why}");
        assert!(
            why.contains("About 0.0495 ZEC stays in your wallet \"user-z\""),
            "{why}"
        );
    }

    #[test]
    fn a_failed_buy_stops_buying_and_sells_what_was_bought() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [0, 0]);
        // The second part of leg 1 is refunded.
        sim.refund1 = vec![2];
        sim.until(|r| r.phase.is_final());
        let r = &sim.r;
        assert_eq!(
            (r.phase, r.outcome),
            (Phase::Done, Some(Outcome::Swapped)),
            "{:#?}",
            r.timeline
        );
        assert_eq!(pi(r, 1, 2).status, PartStatus::Refunded);
        assert_eq!(
            pi(r, 1, 3).status,
            PartStatus::NotStarted,
            "not started after the failure"
        );
        assert!(!sim.starts.iter().any(|s| s.route == pi(r, 1, 3).label));
        let bought = pi(r, 1, 1).zec_zat;
        let sold: u64 = r
            .parts
            .iter()
            .filter(|p| p.leg == 2 && p.status == PartStatus::Swapped)
            .map(|p| p.zec_zat)
            .sum();
        assert_eq!(sold, bought, "leg 2 sold what leg 1 bought, no more");
        assert!(r.timeline.iter().any(|e| e.kind == "replanned"));
        let why = r.reason.as_deref().unwrap();
        assert!(
            why.contains("part 2 of 3 was called off and refunded: its BTC is back"),
            "{why}"
        );
    }

    #[test]
    fn a_failed_first_buy_fails_the_route() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [0, 0]);
        sim.refund1 = vec![1];
        sim.until(|r| r.phase.is_final());
        let r = &sim.r;
        assert_eq!(
            (r.phase, r.outcome),
            (Phase::Failed, Some(Outcome::Refunded))
        );
        assert!(
            r.parts.iter().all(|p| p.leg == 1 || p.swap_id.is_none()),
            "nothing sold"
        );
        assert_eq!(sim.starts.len(), 1);
        assert!(r
            .reason
            .as_deref()
            .unwrap()
            .contains("part 1 of 3 was called off and refunded"));
    }

    #[test]
    fn a_refunded_sell_holds_its_zec_and_continue_sells_it() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [0, 0]);
        let n = sim
            .r
            .parts
            .iter()
            .find(|p| p.leg == 2 && p.zec_zat == z(0.25))
            .unwrap()
            .n;
        sim.refund = vec![n];
        sim.until(|r| !r.phase.is_active());
        let r = sim.r.clone();
        assert_eq!(
            (r.phase, r.outcome),
            (Phase::Holding, Some(Outcome::HoldingZec)),
            "{:#?}",
            r.timeline
        );
        // The others went through.
        let sold: Vec<u64> = r
            .parts
            .iter()
            .filter(|p| p.leg == 2 && p.status == PartStatus::Swapped)
            .map(|p| p.zec_zat)
            .collect();
        assert_eq!(sold.len(), 2);
        assert_eq!(pi(&r, 2, n).status, PartStatus::Refunded);
        let why = r.reason.as_deref().unwrap();
        assert!(
            why.contains("was called off and refunded. You received"),
            "{why}"
        );
        // Three sweeps, three locks and the reclaim: 7 fees.
        assert!(
            why.contains("for 0.6 ZEC so far, and hold about 0.2493 shielded ZEC"),
            "{why}"
        );

        // Continue: what's left is planned again, under new labels, and sold.
        sim.refund.clear();
        sim.r = sim
            .run
            .user(&r, Obs::Continue(ContinueReq::default()))
            .unwrap();
        let fresh: Vec<&Part> = sim
            .r
            .parts
            .iter()
            .filter(|p| p.leg == 2 && p.n > 3)
            .collect();
        assert!(!fresh.is_empty());
        assert!(fresh
            .iter()
            .all(|p| p.standard && !sim.starts.iter().any(|s| s.route == p.label)));
        sim.until(|r| r.phase.is_final());
        assert_eq!(sim.r.phase, Phase::Done, "{:#?}", sim.r.timeline);
    }

    #[test]
    fn no_partner_holds_both_legs_and_continue_resumes_them() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [300, 600]);
        sim.run.policy.leg2_window_secs = 120;
        sim.refuse2 = Some(StartError::Refused {
            status: 400,
            message: "below your minimum".into(),
        });
        sim.until(|r| r.hold.is_some());
        let leg1_starts = |sim: &Sim| sim.starts.iter().filter(|s| s.sweep_to.is_some()).count();
        let at_hold = leg1_starts(&sim);
        assert!(sim.refusals >= 2, "retried within the window");
        // Nothing new starts on either leg while held; what runs finishes.
        sim.until(|r| !r.phase.is_active());
        assert_eq!(sim.r.phase, Phase::Holding);
        assert_eq!(leg1_starts(&sim), at_hold, "no new buy while holding");
        assert!(
            sim.r
                .reason
                .as_deref()
                .unwrap()
                .contains("No partner took your ZEC"),
            "{:?}",
            sim.r.reason
        );
        assert!(sim
            .r
            .parts
            .iter()
            .all(|p| p.status != PartStatus::Waiting && p.status != PartStatus::Starting));
        // Continue: both legs pick up again.
        sim.refuse2 = None;
        sim.r = sim
            .run
            .user(&sim.r, Obs::Continue(ContinueReq::default()))
            .unwrap();
        sim.until(|r| r.phase.is_final());
        assert_eq!(sim.r.phase, Phase::Done, "{:#?}", sim.r.timeline);
        let bought: u64 = sim
            .r
            .parts
            .iter()
            .filter(|p| p.leg == 1 && p.status == PartStatus::Swapped)
            .map(|p| p.zec_zat)
            .sum();
        assert_eq!(bought, z(0.85), "leg 1 resumed after continue");
    }

    #[test]
    fn stop_mid_route_keeps_what_was_bought() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [0, 0]);
        // Until a leg-1 part has bought and a leg-2 part runs.
        sim.until(|r| {
            r.parts
                .iter()
                .any(|p| p.leg == 2 && p.status == PartStatus::Running)
        });
        sim.r = sim.run.user(&sim.r, Obs::Stop).unwrap();
        assert!(sim.r.stop_requested);
        assert!(sim
            .r
            .parts
            .iter()
            .all(|p| p.status != PartStatus::Planned && p.status != PartStatus::Waiting));
        let n_starts = sim.starts.len();
        sim.until(|r| !r.phase.is_active());
        assert_eq!(sim.starts.len(), n_starts, "nothing new started");
        assert_eq!(sim.r.phase, Phase::Holding, "{:#?}", sim.r.timeline);
        assert!(
            sim.r
                .reason
                .as_deref()
                .unwrap()
                .starts_with("You stopped the route."),
            "{:?}",
            sim.r.reason
        );
        // Continue sells what was bought and not sold.
        sim.r = sim
            .run
            .user(&sim.r, Obs::Continue(ContinueReq::default()))
            .unwrap();
        sim.until(|r| !r.phase.is_active());
        assert_eq!(sim.r.phase, Phase::Done, "{:#?}", sim.r.timeline);
    }

    #[test]
    fn a_route_in_parts_survives_lost_answers() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [0, 0]);
        // Part 2 of leg 1: the start reaches the daemon but the answer is lost (a crash).
        sim.pause_starts = true;
        sim.until(|r| pi(r, 1, 2).status == PartStatus::Starting);
        sim.pause_starts = false;
        let (r, cmd) = sim.run.lookup(&sim.r, 1, 2);
        let Some(Command::Start { request, .. }) = cmd else {
            panic!()
        };
        let mut s = swap(&r, 1, 2, "Negotiated", None);
        s.id = "swap1-2".into();
        sim.swaps.push((1, 2, s, 0));
        sim.starts.push(request);
        let r = roundtrip(&r);
        assert!(pi(&r, 1, 2).starting.inflight_since.is_some());
        sim.r = r;
        // The next lookup finds the swap by its label and follows it: no second start.
        sim.until(|r| r.phase.is_final());
        assert_eq!(sim.r.phase, Phase::Done);
        assert_eq!(
            sim.starts
                .iter()
                .filter(|s| s.route.ends_with("/1/2"))
                .count(),
            1
        );
    }

    #[test]
    fn leg1_parts_take_turns_among_listed_partners() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut p = std_params(z(0.85), 100_000);
        p.maker1 = vec![
            maker("http://127.0.0.1:7111", "Kestrel"),
            maker("http://127.0.0.1:7112", "Plover"),
        ];
        p.delay_secs = [0, 0];
        let r = Route::new(p, &Policy::default()).unwrap();
        let mut sim = Sim::new(r, 100_000);
        sim.apply(Obs::Lookup {
            leg: 1,
            part: 1,
            swap: None,
        });
        sim.until(|r| r.phase.is_final());
        let makers: Vec<&str> = sim
            .starts
            .iter()
            .filter(|s| s.sweep_to.is_some())
            .map(|s| s.maker.as_str())
            .collect();
        assert_eq!(
            makers,
            [
                "http://127.0.0.1:7111",
                "http://127.0.0.1:7112",
                "http://127.0.0.1:7111"
            ]
        );
        // Leg 2's parts start with different partners too.
        let sellers: std::collections::BTreeSet<&str> = sim
            .starts
            .iter()
            .filter(|s| s.sweep_to.is_none())
            .map(|s| s.maker.as_str())
            .collect();
        assert_eq!(sellers.len(), 2);

        // A refusal moves on to the next listed partner before giving up.
        let mut p = std_params(z(0.85), 100_000);
        p.maker1 = vec![
            maker("http://127.0.0.1:7111", "Kestrel"),
            maker("http://127.0.0.1:7112", "Plover"),
        ];
        let r = Route::new(p, &Policy::default()).unwrap();
        let run = Run::new();
        let (r, _) = run.lookup(&r, 1, 1);
        let no = |r: &Route| {
            run.step(
                r,
                Obs::Started {
                    leg: 1,
                    part: 1,
                    result: Err(StartError::Refused {
                        status: 400,
                        message: "amount out of range".into(),
                    }),
                },
            )
            .0
        };
        let r = no(&r);
        assert_eq!(r.phase, Phase::Leg1Starting);
        let (r, cmd) = run.lookup(&r, 1, 1);
        let Some(Command::Start { request, .. }) = cmd else {
            panic!()
        };
        assert_eq!(request.maker, "http://127.0.0.1:7112");
        let r = no(&r);
        assert_eq!(
            (r.phase, r.outcome),
            (Phase::Failed, Some(Outcome::NotStarted))
        );
        assert!(
            r.reason.as_deref().unwrap().contains("Nothing moved"),
            "{:?}",
            r.reason
        );
    }

    #[test]
    fn standard_continue_rounds_its_amount_down() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [0, 0]);
        let n = sim
            .r
            .parts
            .iter()
            .find(|p| p.leg == 2 && p.zec_zat == z(0.5))
            .unwrap()
            .n;
        sim.refund = vec![n];
        sim.until(|r| !r.phase.is_active());
        let r = sim.r.clone();
        assert_eq!(r.phase, Phase::Holding);
        let c = sim
            .run
            .user(
                &r,
                Obs::Continue(ContinueReq {
                    zec_zat: Some(z(0.37)),
                    ..ContinueReq::default()
                }),
            )
            .unwrap();
        let mut planned: Vec<u64> = c
            .parts
            .iter()
            .filter(|p| p.leg == 2 && !p.failed() && p.swap_id.is_none())
            .map(|p| p.zec_zat)
            .collect();
        planned.sort_unstable();
        assert_eq!(planned, [z(0.1), z(0.25)]);
        assert!(sim
            .run
            .user(
                &r,
                Obs::Continue(ContinueReq {
                    zec_zat: Some(z(0.6)),
                    ..ContinueReq::default()
                })
            )
            .is_err());
        assert!(sim
            .run
            .user(
                &r,
                Obs::Continue(ContinueReq {
                    zec_zat: Some(z(0.05)),
                    ..ContinueReq::default()
                })
            )
            .is_err());
    }

    #[test]
    fn a_short_wallet_holds_once_leg_one_is_through() {
        let z = |x: f64| (x * 1e8).round() as u64;
        let mut sim = std_sim(z(0.85), 100_000, [0, 0]);
        // The spare the plan counted on is spent elsewhere: the last part can't be locked.
        sim.spare = 0;
        sim.until(|r| !r.phase.is_active());
        let r = &sim.r;
        assert_eq!(
            (r.phase, r.outcome),
            (Phase::Holding, Some(Outcome::HoldingZec)),
            "{:#?}",
            r.timeline
        );
        let why = r.reason.as_deref().unwrap();
        assert!(
            why.contains("Your wallet can spend only") && why.contains("You received"),
            "{why}"
        );
        assert_eq!(
            r.parts
                .iter()
                .filter(|p| p.leg == 2 && p.status == PartStatus::Swapped)
                .count(),
            2
        );
    }
}
