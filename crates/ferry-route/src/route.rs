//! A route and its state machine.
//!
//! [`step`] is pure, in the style of ferry-core: the driver feeds it one observation per tick
//! (what a daemon said, the result of a command, a user request) and executes the command it
//! returns, if any, only after the returned route is on disk. A transition can safely repeat.
//!
//! ```text
//! leg1_starting → leg1 → settling → pausing → leg2_starting → leg2 → done
//!       │           │        │           │          │            └→ holding (refunded / called off)
//!       └→ failed   └→ failed (refunded | punished | called off)    └→ holding (no partner or price
//!          (nothing moved)                                              within the window; stop)
//! ```
//!
//! The only commands are starting leg 1 and starting leg 2. Each runs at most once per label:
//! the route persists `inflight_since` before the call, and before every start the driver looks
//! for a swap carrying the label on that daemon and adopts it instead.

use serde::{Deserialize, Serialize};

use crate::legs::{LegSwap, Role, StartError, StartSwap};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Leg1Starting,
    Leg1,
    Settling,
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
    /// Coin C received.
    Swapped,
    /// Leg 2 did not run or was refunded: shielded ZEC in L2's wallet.
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
    /// One Ironwood transaction's fee allowance (the sweep is `create-max`).
    pub zec_fee_zat: u64,
    /// What L2 keeps spare for its lock's fee (ferryd's `SEND_FEE_RESERVE`).
    pub lock_reserve_zat: u64,
    /// Leg 1: how long to keep retrying while L1 answers 409 (busy) before failing.
    pub leg1_busy_secs: u64,
    /// Leg 2: how long to keep trying to start it before holding.
    pub leg2_window_secs: u64,
    pub retry_secs: u64,
    /// After a start whose answer was lost, how long to wait for the swap to show up (ferryd
    /// may still be talking to the maker) before starting again under the same label.
    pub start_grace_secs: u64,
    /// The sweep is buried but L2 still can't spend leg 2's amount: hold after this long.
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
    /// Leg 2's amount before any jitter: what leg 1 buys less the sweep fee and the lock reserve.
    pub fn leg2_basis(&self, zec_zat: u64) -> Option<u64> {
        zec_zat
            .checked_sub(self.zec_fee_zat.saturating_add(self.lock_reserve_zat))
            .filter(|z| *z > 0)
    }
}

/// How amounts of a counter coin are written.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unit {
    pub ticker: String,
    pub decimals: u8,
}

/// One leg: the daemon it runs on and the latest view of its swap.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Leg {
    pub pair: String,
    pub role: Role,
    #[serde(default)]
    pub unit: Unit,
    /// The daemon's name (`/api/status`), for "You hold ... in <wallet>".
    #[serde(default)]
    pub wallet: String,
    pub maker: Option<Maker>,
    pub label: Option<String>,
    pub swap_id: Option<String>,
    pub state: Option<String>,
    pub outcome: Option<String>,
    pub zec_zat: Option<u64>,
    pub counter_units: Option<u64>,
    pub watchtower: Option<serde_json::Value>,
    /// Earlier swaps of this leg that ended (leg 2 after `continue`).
    #[serde(default)]
    pub earlier: Vec<String>,
}

/// Starting a leg: the in-flight marker and the retry schedule.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Starting {
    /// A start was sent (or was about to be) and its answer is unknown.
    pub inflight_since: Option<u64>,
    /// Earliest next start.
    pub next_at: u64,
    /// Leg 1: stop retrying a busy daemon. Leg 2: hold after this.
    pub window_ends: Option<u64>,
    pub attempts: u32,
    /// Leg 2: the next maker to try (index into `maker2`, wrapping).
    pub maker_idx: usize,
    pub last_error: Option<String>,
}

/// Leg 1's ZEC on its way to L2.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZecProgress {
    pub sweep_txid: Option<String>,
    pub sweep_height: Option<u64>,
    pub sweep_confs: u32,
    /// L2's spendable shielded balance when last seen.
    pub spendable_zat: Option<u64>,
    /// Since when the sweep is buried but the balance is still short.
    pub short_since: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub at: String,
    pub kind: String,
    pub label: String,
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
    /// X: the ZEC leg 1 buys.
    pub zec_zat: u64,
    /// The privacy jitter kept in L2's wallet (`keep_bps`), drawn once.
    pub keep_zat: u64,
    /// The ZEC leg 2 sells.
    pub zec2_zat: u64,
    /// About how much of the route's ZEC sits in L2's wallet between and after the legs.
    pub held_zat: u64,
    /// Leg 1: pay at most this many units of coin A for X.
    pub max_in: u64,
    /// Leg 2: receive at least `min_out` units of coin C per `min_out_basis_zat` sold, i.e. a
    /// floor on the rate, so jitter or fees that shrink `zec2_zat` keep the same price.
    pub min_out: u64,
    pub min_out_basis_zat: u64,
    /// The privacy pause window, seconds after the ZEC becomes spendable.
    pub delay_secs: [u64; 2],
    /// When the pause ends: drawn once, persisted, never redrawn.
    pub not_before: Option<u64>,
    /// L2's own shielded address: where leg 1's sweep pays.
    pub sweep_to: String,
    pub maker1: Maker,
    /// Leg 2's partners, tried in order.
    pub maker2: Vec<Maker>,
    pub phase: Phase,
    pub outcome: Option<Outcome>,
    pub legs: [Leg; 2],
    /// Leg 2's swap generation: `continue` after a leg-2 swap ended starts a new label.
    pub leg2_gen: u32,
    pub starting: Starting,
    pub zec: ZecProgress,
    pub stop_requested: bool,
    /// Leg 1's sweep did not pay L2 (the daemon ignored `sweep_to`): the ZEC is in L1's wallet.
    #[serde(default)]
    pub zec_elsewhere: bool,
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
    pub from: Leg,
    pub to: Leg,
    pub zec_zat: u64,
    pub keep_zat: u64,
    pub max_in: u64,
    pub min_out: u64,
    pub delay_secs: [u64; 2],
    pub sweep_to: String,
    pub maker1: Maker,
    pub maker2: Vec<Maker>,
}

impl Route {
    pub fn new(p: NewRoute, policy: &Policy) -> Result<Route, String> {
        let basis = policy.leg2_basis(p.zec_zat).ok_or_else(|| {
            format!(
                "{} is too little to route: {} zat of it pay the sweep fee and leg 2's lock reserve",
                zec_str(p.zec_zat),
                policy.zec_fee_zat + policy.lock_reserve_zat
            )
        })?;
        let zec2 = basis
            .checked_sub(p.keep_zat)
            .filter(|z| *z > 0)
            .ok_or("the ZEC kept back leaves nothing for leg 2")?;
        let mut r = Route {
            id: p.id,
            created_at: p.now,
            updated_at: p.now,
            from: p.from.pair.clone(),
            to: p.to.pair.clone(),
            zec_zat: p.zec_zat,
            keep_zat: p.keep_zat,
            zec2_zat: zec2,
            held_zat: 0,
            max_in: p.max_in,
            min_out: p.min_out,
            min_out_basis_zat: basis,
            delay_secs: p.delay_secs,
            not_before: None,
            sweep_to: p.sweep_to,
            maker1: p.maker1,
            maker2: p.maker2,
            phase: Phase::Leg1Starting,
            outcome: None,
            legs: [p.from, p.to],
            leg2_gen: 1,
            starting: Starting {
                next_at: p.now,
                window_ends: Some(p.now + policy.leg1_busy_secs),
                ..Starting::default()
            },
            zec: ZecProgress::default(),
            stop_requested: false,
            zec_elsewhere: false,
            reason: None,
            problem: None,
            timeline: vec![],
        };
        r.legs[0].label = Some(r.label(1));
        let label = format!(
            "Route created: {} → shielded ZEC → {}, buying {} on the way",
            r.legs[0].unit.ticker,
            r.legs[1].unit.ticker,
            zec_str(r.zec_zat)
        );
        log(&mut r, p.now, "created", label);
        Ok(r)
    }

    /// The idempotency key of a leg's swap, stored by ferryd as `SwapView.route`.
    pub fn label(&self, n: u8) -> String {
        match (n, self.leg2_gen) {
            (1, _) => format!("{}/1", self.id),
            (_, 0 | 1) => format!("{}/2", self.id),
            (_, g) => format!("{}/2-{g}", self.id),
        }
    }

    /// The least coin C leg 2 accepts for `zec2_zat`, rounded up (never below the user's rate).
    pub fn out_min(&self) -> u64 {
        let basis = u128::from(self.min_out_basis_zat.max(1));
        let v = (u128::from(self.min_out) * u128::from(self.zec2_zat)).div_ceil(basis);
        u64::try_from(v).unwrap_or(u64::MAX)
    }

    /// The leg being started, or 0.
    pub fn starting_leg(&self) -> u8 {
        match self.phase {
            Phase::Leg1Starting => 1,
            Phase::Leg2Starting => 2,
            _ => 0,
        }
    }

    /// A start command may come out of the next lookup (the driver re-checks the daemon first).
    pub fn start_due(&self, now: u64, policy: &Policy) -> bool {
        self.starting_leg() != 0
            && match self.starting.inflight_since {
                Some(t) => now >= t.saturating_add(policy.start_grace_secs),
                None => now >= self.starting.next_at,
            }
    }

    fn start_request(&self, n: u8, maker: &Maker) -> StartSwap {
        match n {
            1 => StartSwap {
                maker: maker.url.clone(),
                zec_zat: self.zec_zat,
                route: self.label(1),
                sweep_to: Some(self.sweep_to.clone()),
                max_counter: Some(self.max_in),
                min_counter: None,
            },
            _ => StartSwap {
                maker: maker.url.clone(),
                zec_zat: self.zec2_zat,
                route: self.label(2),
                sweep_to: None,
                max_counter: None,
                min_counter: Some(self.out_min()),
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
}

/// What the driver saw this tick, or what the user asked.
#[derive(Clone, Debug, PartialEq)]
pub enum Obs {
    /// Time passed; nothing was read.
    Tick,
    /// Before starting leg `n`: its daemon's swap carrying the leg's label, if any.
    Lookup { n: u8, swap: Option<LegSwap> },
    /// Leg `n`'s swap as its daemon shows it.
    Swap { n: u8, swap: LegSwap },
    /// Settling: leg 1's swap, the Zcash tip (L1's) and L2's spendable balance.
    Settle {
        leg1: LegSwap,
        zec_tip: u64,
        spendable_zat: u64,
    },
    /// The answer to [`Command::Start`].
    Started {
        n: u8,
        result: Result<String, StartError>,
    },
    /// Leg `n`'s daemon could not be read (or is not the daemon the route needs).
    Unreachable { n: u8, error: String },
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
    /// The least coin C for `zec_zat` (or for the current leg-2 amount).
    #[serde(default)]
    pub min_out: Option<u64>,
    /// A new leg-2 amount (e.g. when fees left the wallet short).
    #[serde(default)]
    pub zec_zat: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Start { n: u8, request: StartSwap },
}

/// A user request the route's state does not allow (HTTP 409).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused(pub String);

pub struct Ctx<'a> {
    /// Unix seconds.
    pub now: u64,
    /// Fresh randomness; used only to draw the privacy pause.
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
        Obs::Unreachable { n, error } => {
            let pair = &r.legs[usize::from(*n == 2)].pair;
            r.problem = Some(format!("Can't use your {pair} daemon: {error}"));
            if r.phase == Phase::Leg2Starting {
                leg2_window(&mut r, ctx);
            }
            None
        }
        _ => match r.phase {
            Phase::Leg1Starting => starting(&mut r, 1, obs, ctx),
            Phase::Leg2Starting => starting(&mut r, 2, obs, ctx),
            Phase::Leg1 => {
                if let Obs::Swap { n: 1, swap } = obs {
                    on_leg1(&mut r, swap, ctx);
                }
                None
            }
            Phase::Settling => {
                if let Obs::Settle {
                    leg1,
                    zec_tip,
                    spendable_zat,
                } = obs
                {
                    settle(&mut r, leg1, *zec_tip, *spendable_zat, ctx);
                }
                None
            }
            Phase::Pausing => {
                if r.not_before.is_none_or(|t| ctx.now >= t) {
                    enter_leg2(&mut r, ctx);
                }
                None
            }
            Phase::Leg2 => {
                if let Obs::Swap { n: 2, swap } = obs {
                    on_leg2(&mut r, swap, ctx);
                }
                None
            }
            Phase::Done | Phase::Failed | Phase::Holding => None,
        },
    };
    if r != *route {
        r.updated_at = ctx.now;
    }
    Ok((r, cmd))
}

fn log(r: &mut Route, now: u64, kind: &str, label: impl Into<String>) {
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(now);
    r.timeline.push(Entry {
        at: humantime::format_rfc3339_seconds(at).to_string(),
        kind: kind.into(),
        label: label.into(),
    });
}

fn starting(r: &mut Route, n: u8, obs: &Obs, ctx: &Ctx) -> Option<Command> {
    let i = usize::from(n - 1);
    match obs {
        Obs::Lookup { n: m, swap } if *m == n => {
            r.problem = None;
            if let Some(s) = swap {
                adopt(r, n, s, ctx);
                return None;
            }
            if let Some(t) = r.starting.inflight_since {
                // ferryd may still be negotiating with the maker: give it time to finish
                // before starting again under the same label.
                if ctx.now < t.saturating_add(ctx.policy.start_grace_secs) {
                    return None;
                }
                r.starting.inflight_since = None;
            }
            if r.stop_requested {
                stopped_before_start(r, n, ctx);
                return None;
            }
            if n == 2 && leg2_window(r, ctx) {
                return None;
            }
            if ctx.now < r.starting.next_at {
                return None;
            }
            if n == 2 && r.maker2.is_empty() {
                hold(r, "There is no partner for swap 2".into(), ctx);
                return None;
            }
            let maker = match n {
                1 => r.maker1.clone(),
                _ => r.maker2[r.starting.maker_idx % r.maker2.len()].clone(),
            };
            let request = r.start_request(n, &maker);
            if r.starting.attempts == 0 {
                let what = match n {
                    1 => format!(
                        "Starting swap 1 of 2 with {}: your {} for {}",
                        maker.display(),
                        r.legs[0].unit.ticker,
                        zec_str(r.zec_zat)
                    ),
                    _ => format!(
                        "Starting swap 2 of 2 with {}: {} for your {}",
                        maker.display(),
                        zec_str(r.zec2_zat),
                        r.legs[1].unit.ticker
                    ),
                };
                log(r, ctx.now, &format!("leg{n}_starting"), what);
            }
            r.starting.inflight_since = Some(ctx.now);
            r.starting.attempts += 1;
            r.legs[i].maker = Some(maker);
            r.legs[i].label = Some(request.route.clone());
            Some(Command::Start { n, request })
        }
        Obs::Started { n: m, result } if *m == n => {
            match result {
                Ok(id) => {
                    r.problem = None;
                    let s = LegSwap {
                        id: id.clone(),
                        role: r.legs[i].role,
                        state: "Negotiated".into(),
                        ..LegSwap::default()
                    };
                    adopt(r, n, &s, ctx);
                }
                // The swap may exist: the next lookup decides (inflight_since stays set).
                // The swap may exist, and ferryd may still be working on it: the grace period
                // counts from now, and the next lookups decide.
                Err(StartError::Unknown(e)) => {
                    r.starting.inflight_since = Some(ctx.now);
                    r.problem = Some(format!(
                        "No answer when starting swap {n} ({e}); checking whether it started"
                    ));
                }
                Err(StartError::Refused { status, message }) => {
                    r.starting.inflight_since = None;
                    refused(r, n, *status, message, ctx);
                }
            }
            None
        }
        Obs::Tick if n == 2 => {
            leg2_window(r, ctx);
            None
        }
        _ => None,
    }
}

/// A definite refusal: nothing was created.
fn refused(r: &mut Route, n: u8, status: u16, message: &str, ctx: &Ctx) {
    let maker = r.legs[usize::from(n - 1)]
        .maker
        .as_ref()
        .map(Maker::display)
        .unwrap_or_default();
    if n == 1 {
        // 409: L1 is busy with another swap; that clears up. Anything else will not.
        let busy_until = r.starting.window_ends.unwrap_or(0);
        if status == 409 && ctx.now < busy_until {
            r.starting.next_at = ctx.now + ctx.policy.retry_secs;
            r.problem = Some(format!(
                "Your {} daemon is busy with another swap; trying again",
                r.from
            ));
            return;
        }
        fail(
            r,
            Outcome::NotStarted,
            format!("Swap 1 with {maker} didn't start: {message}. Nothing moved."),
            ctx,
        );
        return;
    }
    if r.starting.last_error.as_deref() != Some(message) {
        log(
            r,
            ctx.now,
            "leg2_refused",
            format!(
                "Swap 2 with {maker} didn't start: {message}. Your ZEC stays put; trying again."
            ),
        );
    }
    r.starting.last_error = Some(message.to_string());
    r.problem = Some(format!("Swap 2 with {maker} didn't start: {message}"));
    r.starting.next_at = ctx.now + ctx.policy.retry_secs;
    r.starting.maker_idx = r.starting.maker_idx.wrapping_add(1);
}

/// Leg 2's window is over (and at least one start was tried): hold. True if it held.
fn leg2_window(r: &mut Route, ctx: &Ctx) -> bool {
    let over = r.starting.window_ends.is_some_and(|t| ctx.now >= t);
    if !over || r.starting.inflight_since.is_some() || r.starting.attempts == 0 {
        return false;
    }
    let mins = ctx.policy.leg2_window_secs / 60;
    let why = match &r.starting.last_error {
        Some(e) => format!(
            "No partner took your ZEC at your price within {mins} minutes (last answer: {e})"
        ),
        None => format!("No partner took your ZEC at your price within {mins} minutes"),
    };
    hold(r, why, ctx);
    true
}

fn stopped_before_start(r: &mut Route, n: u8, ctx: &Ctx) {
    if n == 1 {
        fail(
            r,
            Outcome::NotStarted,
            "You stopped the route before anything moved.".into(),
            ctx,
        );
    } else {
        hold(r, "You stopped the route before swap 2".into(), ctx);
    }
}

/// Leg `n` has a swap: follow it from now on.
fn adopt(r: &mut Route, n: u8, s: &LegSwap, ctx: &Ctx) {
    let i = usize::from(n - 1);
    r.starting.inflight_since = None;
    r.legs[i].swap_id = Some(s.id.clone());
    if let Some(m) = std::iter::once(r.maker1.clone())
        .chain(r.maker2.clone())
        .find(|m| !s.counterparty.is_empty() && m.url.trim_end_matches('/') == s.counterparty)
    {
        r.legs[i].maker = Some(m);
    }
    r.phase = if n == 1 { Phase::Leg1 } else { Phase::Leg2 };
    let maker = r.legs[i]
        .maker
        .as_ref()
        .map(Maker::display)
        .unwrap_or_default();
    log(
        r,
        ctx.now,
        &format!("leg{n}_started"),
        format!("Swap {n} of 2 started with {maker}"),
    );
    if n == 1 {
        on_leg1(r, s, ctx);
    } else {
        on_leg2(r, s, ctx);
    }
}

fn snapshot(leg: &mut Leg, s: &LegSwap) {
    leg.state = Some(s.state.clone());
    leg.outcome = s.outcome.clone();
    if s.amounts.zec_zat > 0 {
        leg.zec_zat = Some(s.amounts.zec_zat);
        leg.counter_units = Some(s.amounts.btc_sat);
    }
    leg.watchtower = s.watchtower.clone();
}

/// The daemon shows terms the route did not ask for. The swap runs regardless (the router
/// cannot stop it), so say so plainly. A daemon that speaks the route contract never does this.
fn check_terms(r: &mut Route, n: u8, s: &LegSwap, ctx: &Ctx) {
    if s.amounts.zec_zat == 0 {
        return; // not read yet (a swap we only know the id of)
    }
    let label = r.label(n);
    let mut warn = vec![];
    if s.route.as_deref() != Some(label.as_str()) {
        warn.push(format!("it does not carry the route label {label}"));
    }
    let (unit, units) = (r.legs[usize::from(n - 1)].unit.clone(), s.amounts.btc_sat);
    if n == 1 {
        if s.amounts.zec_zat != r.zec_zat {
            warn.push(format!(
                "it buys {} instead of {}",
                zec_str(s.amounts.zec_zat),
                zec_str(r.zec_zat)
            ));
        }
        if units > r.max_in {
            warn.push(format!(
                "it pays {} (your limit is {})",
                units_str(units, &unit),
                units_str(r.max_in, &unit)
            ));
        }
        if s.sweep_to.as_deref() != Some(r.sweep_to.as_str()) && !r.zec_elsewhere {
            r.zec_elsewhere = true;
            warn.push("its ZEC goes to its own wallet, not your leg-2 wallet".into());
        }
    } else {
        if s.amounts.zec_zat != r.zec2_zat {
            warn.push(format!(
                "it sells {} instead of {}",
                zec_str(s.amounts.zec_zat),
                zec_str(r.zec2_zat)
            ));
        }
        if units < r.out_min() {
            warn.push(format!(
                "it receives {} (your minimum is {})",
                units_str(units, &unit),
                units_str(r.out_min(), &unit)
            ));
        }
    }
    let text = format!("Swap {n} doesn't match the route: {}", warn.join("; "));
    if !warn.is_empty() && !r.timeline.iter().any(|e| e.label == text) {
        log(r, ctx.now, "warning", text);
    }
}

fn on_leg1(r: &mut Route, s: &LegSwap, ctx: &Ctx) {
    r.problem = None;
    snapshot(&mut r.legs[0], s);
    check_terms(r, 1, s, ctx);
    match s.outcome.as_deref() {
        Some("swapped") => {}
        Some("refunded") => {
            return fail(
                r,
                Outcome::Refunded,
                format!(
                    "Swap 1 was called off and refunded: your {} is back in your wallet, minus network fees. Swap 2 never started.",
                    r.legs[0].unit.ticker
                ),
                ctx,
            );
        }
        Some("punished") => {
            return fail(
                r,
                Outcome::Punished,
                format!(
                    "Swap 1 failed and your {} was lost: it was not refunded before the deadline, so the partner took it as the penalty. Swap 2 never started.",
                    r.legs[0].unit.ticker
                ),
                ctx,
            );
        }
        _ if s.aborted() => {
            return fail(
                r,
                Outcome::NotStarted,
                "Swap 1 was called off before anything was locked. Nothing moved.".into(),
                ctx,
            );
        }
        _ if s.redeemed() => {}
        _ => return,
    }
    // Leg 1 is through: the ZEC is ours whatever happens next.
    if r.phase == Phase::Leg1 {
        r.phase = Phase::Settling;
        r.held_zat = r.zec_zat.saturating_sub(ctx.policy.zec_fee_zat);
        let to = r.zec_wallet();
        log(
            r,
            ctx.now,
            "leg1_swapped",
            format!(
                "Swap 1 is done: about {} is on its way to {to}",
                zec_str(r.held_zat)
            ),
        );
        if r.stop_requested {
            hold(r, "You stopped the route before swap 2".into(), ctx);
        }
    }
}

fn settle(r: &mut Route, leg1: &LegSwap, tip: u64, spendable: u64, ctx: &Ctx) {
    on_leg1(r, leg1, ctx);
    if r.phase != Phase::Settling {
        return;
    }
    if let Some((txid, height)) = leg1.sweep() {
        r.zec.sweep_confs = height
            .filter(|h| tip >= *h)
            .map_or(0, |h| u32::try_from(tip - h + 1).unwrap_or(u32::MAX));
        r.zec.sweep_txid = Some(txid);
        r.zec.sweep_height = height;
    }
    r.zec.spendable_zat = Some(spendable);
    if leg1.outcome.as_deref() != Some("swapped") {
        return;
    }
    if r.zec_elsewhere {
        return hold(
            r,
            "Swap 1 paid the ZEC to its own wallet instead of your leg-2 wallet, so swap 2 can't use it".into(),
            ctx,
        );
    }
    if r.zec.sweep_confs < ctx.policy.needed_confs {
        return;
    }
    let need = r.zec2_zat + ctx.policy.lock_reserve_zat;
    if spendable < need {
        let since = *r.zec.short_since.get_or_insert(ctx.now);
        if ctx.now >= since.saturating_add(ctx.policy.spendable_grace_secs) {
            let why = format!(
                "Your wallet can spend only {}, and swap 2 needs {} (its amount plus fees)",
                zec_str(spendable),
                zec_str(need)
            );
            hold(r, why, ctx);
        }
        return;
    }
    r.zec.short_since = None;
    // Spendable: draw the privacy pause once.
    let [lo, hi] = r.delay_secs;
    let not_before = *r.not_before.get_or_insert_with(|| {
        let span = hi.saturating_sub(lo).saturating_add(1);
        ctx.now.saturating_add(lo).saturating_add(ctx.rand % span)
    });
    r.phase = Phase::Pausing;
    let wait = not_before.saturating_sub(ctx.now);
    let label = if wait == 0 {
        format!("Your ZEC is in {} and can be spent", r.zec_wallet())
    } else {
        format!(
            "Your ZEC is in {} and can be spent. Privacy pause: swap 2 starts {}",
            r.zec_wallet(),
            in_about(wait)
        )
    };
    log(r, ctx.now, "zec_spendable", label);
}

fn enter_leg2(r: &mut Route, ctx: &Ctx) {
    r.phase = Phase::Leg2Starting;
    r.starting = Starting {
        next_at: ctx.now,
        window_ends: Some(ctx.now + ctx.policy.leg2_window_secs),
        ..Starting::default()
    };
    r.legs[1].label = Some(r.label(2));
}

fn on_leg2(r: &mut Route, s: &LegSwap, ctx: &Ctx) {
    r.problem = None;
    snapshot(&mut r.legs[1], s);
    check_terms(r, 2, s, ctx);
    let got = units_str(s.amounts.btc_sat, &r.legs[1].unit);
    match s.outcome.as_deref() {
        Some("swapped") => done(r, format!("Done: you received {got}."), ctx),
        Some("punished") => done(
            r,
            format!("Done: your partner vanished after locking, so you claimed their {got} as the penalty."),
            ctx,
        ),
        Some("refunded") => {
            if s.reclaimed() {
                // The lock and the reclaim each paid an Ironwood fee.
                let fees = 2 * ctx.policy.zec_fee_zat;
                r.held_zat = r.held_zat.saturating_sub(fees);
                r.zec2_zat = r.zec2_zat.saturating_sub(fees).max(1);
            }
            hold(r, "Swap 2 was called off and refunded".into(), ctx);
        }
        _ if s.aborted() => hold(r, "Swap 2 was called off before anything was locked".into(), ctx),
        _ => {}
    }
}

fn hold(r: &mut Route, why: String, ctx: &Ctx) {
    r.phase = Phase::Holding;
    r.outcome = Some(Outcome::HoldingZec);
    r.starting.inflight_since = None;
    let text = format!(
        "{why}. You hold about {} shielded ZEC in {}.",
        units_str(
            r.held_zat,
            &Unit {
                ticker: String::new(),
                decimals: 8
            }
        ),
        r.zec_wallet()
    );
    log(r, ctx.now, "holding", text.clone());
    r.reason = Some(text);
}

fn fail(r: &mut Route, outcome: Outcome, why: String, ctx: &Ctx) {
    r.phase = Phase::Failed;
    r.outcome = Some(outcome);
    log(r, ctx.now, "failed", why.clone());
    r.reason = Some(why);
}

fn done(r: &mut Route, why: String, ctx: &Ctx) {
    r.phase = Phase::Done;
    r.outcome = Some(Outcome::Swapped);
    log(r, ctx.now, "done", why.clone());
    r.reason = Some(why);
}

fn stop(r: &mut Route, ctx: &Ctx) -> Result<(), Refused> {
    let inflight = r.starting.inflight_since.is_some();
    match r.phase {
        Phase::Leg1Starting if !inflight => stopped_before_start(r, 1, ctx),
        Phase::Leg2Starting if !inflight => stopped_before_start(r, 2, ctx),
        // A start may be in flight, or leg 1 is running: decide once it is known.
        Phase::Leg1Starting | Phase::Leg2Starting | Phase::Leg1 => {
            if !r.stop_requested {
                r.stop_requested = true;
                log(
                    r,
                    ctx.now,
                    "stop_requested",
                    "Stopping: swap 2 won't run. If swap 1 completes, you keep the ZEC.",
                );
            }
        }
        Phase::Settling | Phase::Pausing => {
            hold(r, "You stopped the route before swap 2".into(), ctx)
        }
        Phase::Holding => {}
        Phase::Leg2 => {
            return Err(Refused(
                "Swap 2 is running and can't be stopped; if it fails, its refund returns your ZEC"
                    .into(),
            ))
        }
        Phase::Done | Phase::Failed => return Err(Refused("The route is over".into())),
    }
    Ok(())
}

fn resume(r: &mut Route, req: &ContinueReq, ctx: &Ctx) -> Result<(), Refused> {
    match r.phase {
        Phase::Pausing => {
            apply_overrides(r, req, false)?;
            r.not_before = Some(ctx.now);
            log(
                r,
                ctx.now,
                "pause_skipped",
                "Privacy pause skipped at your request: the short gap between the two swaps makes them easier to link.",
            );
            enter_leg2(r, ctx);
            Ok(())
        }
        Phase::Holding => {
            if r.zec_elsewhere {
                return Err(Refused(format!(
                    "The ZEC is in {}, which swap 2 can't spend from",
                    r.zec_wallet()
                )));
            }
            if let Some(id) = r.legs[1].swap_id.take() {
                // A new swap needs a new label: the old one names a swap that ended.
                r.leg2_gen += 1;
                let leg = &mut r.legs[1];
                leg.earlier.push(id);
                leg.state = None;
                leg.outcome = None;
                leg.zec_zat = None;
                leg.counter_units = None;
                leg.watchtower = None;
            }
            apply_overrides(r, req, true)?;
            r.phase = Phase::Settling;
            r.outcome = None;
            r.reason = None;
            r.stop_requested = false;
            r.zec.short_since = None;
            r.starting = Starting::default();
            r.legs[1].label = Some(r.label(2));
            log(
                r,
                ctx.now,
                "continued",
                format!(
                    "Trying swap 2 again: {} for at least {}",
                    zec_str(r.zec2_zat),
                    units_str(r.out_min(), &r.legs[1].unit)
                ),
            );
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

fn apply_overrides(r: &mut Route, req: &ContinueReq, amount_ok: bool) -> Result<(), Refused> {
    if let Some(z) = req.zec_zat {
        if !amount_ok {
            return Err(Refused("The amount can change only while holding".into()));
        }
        if z == 0 {
            return Err(Refused("zec_zat must be positive".into()));
        }
        r.zec2_zat = z;
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
        r.min_out = m;
        r.min_out_basis_zat = r.zec2_zat;
    }
    Ok(())
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
    use crate::legs::SwapAmounts;

    pub(crate) const T0: u64 = 1_800_000_000;
    pub(crate) const X: u64 = 100_000_000;

    pub(crate) fn maker(url: &str, name: &str) -> Maker {
        Maker {
            url: url.into(),
            name: Some(name.into()),
        }
    }

    pub(crate) fn new_route(policy: &Policy) -> Route {
        Route::new(
            NewRoute {
                id: "r0123456789abcdef".into(),
                now: T0,
                from: Leg {
                    pair: "btc".into(),
                    role: Role::B,
                    unit: Unit {
                        ticker: "BTC".into(),
                        decimals: 8,
                    },
                    wallet: "user-b".into(),
                    ..Leg::default()
                },
                to: Leg {
                    pair: "usdc-base".into(),
                    role: Role::Z,
                    unit: Unit {
                        ticker: "USDC".into(),
                        decimals: 6,
                    },
                    wallet: "user-z".into(),
                    ..Leg::default()
                },
                zec_zat: X,
                keep_zat: 0,
                max_in: 412_500,
                min_out: 39_200_000,
                delay_secs: [300, 1800],
                sweep_to: "utest1l2".into(),
                maker1: maker("http://127.0.0.1:7111", "Kestrel"),
                maker2: vec![
                    maker("http://127.0.0.1:7912", "Heron"),
                    maker("http://127.0.0.1:7913", "Egret"),
                ],
            },
            policy,
        )
        .unwrap()
    }

    /// A swap as leg `n`'s daemon would show it, terms matching the route.
    pub(crate) fn swap(r: &Route, n: u8, state: &str, outcome: Option<&str>) -> LegSwap {
        let (role, zec, units, sweep_to) = match n {
            1 => (Role::B, r.zec_zat, 400_000, Some(r.sweep_to.clone())),
            _ => (Role::Z, r.zec2_zat, r.out_min() + 1, None),
        };
        LegSwap {
            id: format!("swap{n}"),
            role,
            counterparty: r.legs[usize::from(n - 1)]
                .maker
                .as_ref()
                .map(|m| m.url.clone())
                .unwrap_or_default(),
            state: state.into(),
            outcome: outcome.map(Into::into),
            amounts: SwapAmounts {
                zec_zat: zec,
                btc_sat: units,
            },
            timeline: vec![],
            watchtower: None,
            route: Some(r.label(n)),
            sweep_to,
        }
    }

    pub(crate) fn swept(r: &Route, height: Option<u64>) -> LegSwap {
        let mut s = swap(r, 1, "ZecSwept", Some("swapped"));
        s.timeline.push(crate::legs::SwapEntry {
            at: String::new(),
            kind: "zec_sweep_broadcast".into(),
            txid: Some("sweeptx".into()),
            height,
        });
        s
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

        fn step(&self, r: &Route, obs: Obs) -> (Route, Option<Command>) {
            let ctx = Ctx {
                now: self.now,
                rand: self.rand,
                policy: &self.policy,
            };
            step(r, &obs, &ctx).expect("not refused")
        }

        fn user(&self, r: &Route, obs: Obs) -> Result<Route, Refused> {
            let ctx = Ctx {
                now: self.now,
                rand: self.rand,
                policy: &self.policy,
            };
            step(r, &obs, &ctx).map(|(r, _)| r)
        }

        /// Drive `r` to the given phase along the happy path.
        fn to(&mut self, target: Phase) -> Route {
            let mut r = new_route(&self.policy);
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
                assert_eq!(r.phase, p);
                r = match p {
                    Phase::Leg1Starting => {
                        let (r, _) = self.step(&r, Obs::Lookup { n: 1, swap: None });
                        self.step(
                            &r,
                            Obs::Started {
                                n: 1,
                                result: Ok("swap1".into()),
                            },
                        )
                        .0
                    }
                    Phase::Leg1 => {
                        let s = swap(&r, 1, "BtcRedeemed", None);
                        self.step(&r, Obs::Swap { n: 1, swap: s }).0
                    }
                    Phase::Settling => {
                        let s = swept(&r, Some(100));
                        self.step(
                            &r,
                            Obs::Settle {
                                leg1: s,
                                zec_tip: 109,
                                spendable_zat: r.zec2_zat + 50_000,
                            },
                        )
                        .0
                    }
                    Phase::Pausing => {
                        self.now = r.not_before.unwrap();
                        self.step(&r, Obs::Tick).0
                    }
                    Phase::Leg2Starting => {
                        let (r, _) = self.step(&r, Obs::Lookup { n: 2, swap: None });
                        self.step(
                            &r,
                            Obs::Started {
                                n: 2,
                                result: Ok("swap2".into()),
                            },
                        )
                        .0
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

    #[test]
    fn happy_path() {
        let mut run = Run::new();
        let r = new_route(&run.policy);
        assert_eq!((r.phase, r.zec2_zat), (Phase::Leg1Starting, X - 60_000));
        assert_eq!(r.label(1), "r0123456789abcdef/1");

        // Leg 1 starts once, with the label, sweep_to and the price ceiling.
        let (r, cmd) = run.step(&r, Obs::Lookup { n: 1, swap: None });
        let Some(Command::Start { n: 1, request }) = cmd else {
            panic!("{cmd:?}")
        };
        assert_eq!(
            request,
            StartSwap {
                maker: "http://127.0.0.1:7111".into(),
                zec_zat: X,
                route: "r0123456789abcdef/1".into(),
                sweep_to: Some("utest1l2".into()),
                max_counter: Some(412_500),
                min_counter: None,
            }
        );
        assert_eq!(
            r.starting.inflight_since,
            Some(T0),
            "persisted before the call"
        );
        let (r, cmd) = run.step(
            &r,
            Obs::Started {
                n: 1,
                result: Ok("swap1".into()),
            },
        );
        assert_eq!(
            (r.phase, cmd, r.legs[0].swap_id.as_deref()),
            (Phase::Leg1, None, Some("swap1"))
        );

        // Running, then redeemed: settling.
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                n: 1,
                swap: swap(&r, 1, "ZecSeen", None),
            },
        );
        assert_eq!(r.phase, Phase::Leg1);
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                n: 1,
                swap: swap(&r, 1, "BtcRedeemed", None),
            },
        );
        assert_eq!((r.phase, r.held_zat), (Phase::Settling, X - 10_000));

        // Spendable after 10 confirmations: the pause is drawn inside the window.
        let need = r.zec2_zat + 50_000;
        let obs = |tip, spendable| Obs::Settle {
            leg1: swept(&r, Some(100)),
            zec_tip: tip,
            spendable_zat: spendable,
        };
        let (r, _) = run.step(&r, obs(109, need));
        assert_eq!(
            (r.phase, r.not_before),
            (Phase::Pausing, Some(T0 + 300 + 7))
        );
        assert_eq!(r.zec.sweep_confs, 10);
        assert!(r.problem.is_none());

        // Still pausing until not_before.
        run.now = T0 + 306;
        assert_eq!(run.step(&r, Obs::Tick).0.phase, Phase::Pausing);
        run.now = T0 + 307;
        let (r, _) = run.step(&r, Obs::Tick);
        assert_eq!(r.phase, Phase::Leg2Starting);

        // Leg 2 starts once, with the price floor.
        let (r, cmd) = run.step(&r, Obs::Lookup { n: 2, swap: None });
        let Some(Command::Start { n: 2, request }) = cmd else {
            panic!("{cmd:?}")
        };
        assert_eq!(
            request,
            StartSwap {
                maker: "http://127.0.0.1:7912".into(),
                zec_zat: X - 60_000,
                route: "r0123456789abcdef/2".into(),
                sweep_to: None,
                max_counter: None,
                min_counter: Some(39_200_000),
            }
        );
        let (r, _) = run.step(
            &r,
            Obs::Started {
                n: 2,
                result: Ok("swap2".into()),
            },
        );
        assert_eq!(r.phase, Phase::Leg2);
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: swap(&r, 2, "ZecLocked", None),
            },
        );
        assert_eq!(r.phase, Phase::Leg2);
        let (r, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: swap(&r, 2, "Claimed", Some("swapped")),
            },
        );
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
        for n in [1u8, 2] {
            let mut run = Run::new();
            let target = if n == 1 {
                Phase::Leg1Starting
            } else {
                Phase::Leg2Starting
            };
            let r = run.to(target);
            // Crash right after persisting the in-flight start.
            let (r, cmd) = run.step(&r, Obs::Lookup { n, swap: None });
            assert!(cmd.is_some());
            let r = roundtrip(&r);
            // The swap exists: adopted, no second start.
            let found = swap(&r, n, "Negotiated", None);
            let (adopted, cmd) = run.step(
                &r,
                Obs::Lookup {
                    n,
                    swap: Some(found),
                },
            );
            assert_eq!(cmd, None);
            assert_eq!(
                adopted.phase,
                if n == 1 { Phase::Leg1 } else { Phase::Leg2 }
            );
            assert_eq!(
                adopted.legs[usize::from(n - 1)].swap_id.as_deref(),
                Some(format!("swap{n}").as_str())
            );
            // An adopted swap that already finished is followed straight on.
            let finished = swap(&r, n, "Refunded", Some("refunded"));
            let (after, _) = run.step(
                &r,
                Obs::Lookup {
                    n,
                    swap: Some(finished),
                },
            );
            assert_eq!(
                after.phase,
                if n == 1 {
                    Phase::Failed
                } else {
                    Phase::Holding
                }
            );
        }
    }

    #[test]
    fn restart_while_starting_without_a_swap_waits_then_starts_once() {
        for n in [1u8, 2] {
            let mut run = Run::new();
            let r = run.to(if n == 1 {
                Phase::Leg1Starting
            } else {
                Phase::Leg2Starting
            });
            let t = run.now;
            let (r, cmd) = run.step(&r, Obs::Lookup { n, swap: None });
            assert!(cmd.is_some());
            let r = roundtrip(&r);
            // No swap yet: ferryd may still be negotiating. Wait out the grace period.
            run.now = t + 119;
            let (r, cmd) = run.step(&r, Obs::Lookup { n, swap: None });
            assert_eq!(cmd, None);
            assert!(!r.start_due(run.now, &run.policy));
            run.now = t + 120;
            assert!(r.start_due(run.now, &run.policy));
            let (r, cmd) = run.step(&r, Obs::Lookup { n, swap: None });
            let Some(Command::Start { request, .. }) = cmd else {
                panic!()
            };
            assert_eq!(
                request.route,
                r.label(n),
                "the same label: still one swap at most"
            );
            assert_eq!(r.starting.attempts, 2);
        }
    }

    #[test]
    fn a_lost_answer_keeps_the_start_in_flight() {
        let mut run = Run::new();
        let r = new_route(&run.policy);
        let (r, _) = run.step(&r, Obs::Lookup { n: 1, swap: None });
        // The answer is lost after a long wait: the grace counts from then, so a daemon still
        // busy with the request gets the whole grace period to finish it.
        run.now = T0 + 100;
        let (r, cmd) = run.step(
            &r,
            Obs::Started {
                n: 1,
                result: Err(StartError::Unknown("timeout".into())),
            },
        );
        assert_eq!((r.phase, cmd), (Phase::Leg1Starting, None));
        assert_eq!(r.starting.inflight_since, Some(T0 + 100));
        assert!(r
            .problem
            .as_deref()
            .unwrap()
            .contains("checking whether it started"));
        assert!(!r.start_due(T0 + 200, &run.policy));
        assert!(r.start_due(T0 + 220, &run.policy));
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
                    n: 1,
                    swap: swap(&r, 1, "BtcLocked", None),
                },
                Phase::Leg2 => Obs::Swap {
                    n: 2,
                    swap: swap(&r, 2, "ZecLocked", None),
                },
                Phase::Settling => Obs::Settle {
                    leg1: swept(&r, None),
                    zec_tip: 1,
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
                    n: 1,
                    swap: swap(&r, 1, state, outcome),
                },
            );
            assert_eq!((r.phase, r.outcome, cmd), (Phase::Failed, Some(want), None));
            assert!(
                r.reason.as_deref().unwrap().contains(text),
                "{:?}",
                r.reason
            );
            assert!(r.legs[1].swap_id.is_none(), "no leg 2");
        }
    }

    #[test]
    fn leg1_start_refused_fails_but_busy_is_retried() {
        let mut run = Run::new();
        let r = new_route(&run.policy);
        let (r, _) = run.step(&r, Obs::Lookup { n: 1, swap: None });
        let refused = |status: u16| Obs::Started {
            n: 1,
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
        assert!(failed.reason.as_deref().unwrap().contains("Nothing moved"));

        // 409: L1 is busy. Retried (after a fresh lookup) until the busy window ends.
        let (busy, _) = run.step(&r, refused(409));
        assert_eq!(
            (busy.phase, busy.starting.inflight_since),
            (Phase::Leg1Starting, None)
        );
        run.now = T0 + 30;
        assert_eq!(
            run.step(&busy, Obs::Lookup { n: 1, swap: None }).1,
            None,
            "waits retry_secs"
        );
        run.now = T0 + 60;
        let (busy, cmd) = run.step(&busy, Obs::Lookup { n: 1, swap: None });
        assert!(cmd.is_some());
        run.now = T0 + 300;
        let (gone, _) = run.step(&busy, refused(409));
        assert_eq!(gone.phase, Phase::Failed);
    }

    #[test]
    fn spendability_gate() {
        let mut run = Run::new();
        let r = run.to(Phase::Settling);
        let need = r.zec2_zat + 50_000;
        let settle = |r: &Route, height, tip, spendable| Obs::Settle {
            leg1: swept(r, height),
            zec_tip: tip,
            spendable_zat: spendable,
        };
        // Leg 1 redeemed but the sweep is not out or not mined yet.
        let (r, _) = run.step(
            &r,
            Obs::Settle {
                leg1: swap(&r, 1, "BtcRedeemed", None),
                zec_tip: 50,
                spendable_zat: need,
            },
        );
        assert_eq!(r.phase, Phase::Settling);
        let (r, _) = run.step(&r, settle(&r, None, 120, need));
        assert_eq!(
            (r.phase, r.zec.sweep_confs, r.zec.sweep_txid.as_deref()),
            (Phase::Settling, 0, Some("sweeptx"))
        );
        // 9 confirmations: not yet, even with the balance there.
        let (r, _) = run.step(&r, settle(&r, Some(100), 108, need));
        assert_eq!((r.phase, r.zec.sweep_confs), (Phase::Settling, 9));
        // 10 confirmations but L2 can't spend enough yet.
        let (r, _) = run.step(&r, settle(&r, Some(100), 109, need - 1));
        assert_eq!((r.phase, r.zec.short_since), (Phase::Settling, Some(T0)));
        assert!(r.not_before.is_none());
        let (ok, _) = run.step(&r, settle(&r, Some(100), 109, need));
        assert_eq!((ok.phase, ok.zec.short_since), (Phase::Pausing, None));
        // Still short after the grace: hold, with the numbers.
        run.now = T0 + 1800;
        let (held, _) = run.step(&r, settle(&r, Some(100), 200, need - 1));
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
            let t = r.not_before.unwrap();
            assert!((T0 + 300..=T0 + 1800).contains(&t), "{rand}: {t}");
            run.now = T0;
        }
        run.rand = 99;
        let r = run.to(Phase::Settling);
        let need = r.zec2_zat + 50_000;
        let (p, _) = run.step(
            &r,
            Obs::Settle {
                leg1: swept(&r, Some(1)),
                zec_tip: 10,
                spendable_zat: need,
            },
        );
        let drawn = p.not_before;
        // Restart and the same observation again, with other randomness: not redrawn.
        run.rand = 12345;
        let p2 = roundtrip(&p);
        let (p3, _) = run.step(&p2, Obs::Tick);
        assert_eq!((p3.not_before, p3.phase), (drawn, Phase::Pausing));
        // Off: zero pause.
        let mut r = run.to(Phase::Settling);
        r.delay_secs = [0, 0];
        let (p, _) = run.step(
            &r,
            Obs::Settle {
                leg1: swept(&r, Some(1)),
                zec_tip: 10,
                spendable_zat: need,
            },
        );
        assert_eq!(p.not_before, Some(run.now));
        assert_eq!(run.step(&p, Obs::Tick).0.phase, Phase::Leg2Starting);
    }

    #[test]
    fn leg2_refusals_rotate_makers_then_hold_when_the_window_ends() {
        let mut run = Run::new();
        let r = run.to(Phase::Leg2Starting);
        let t = run.now;
        let refused = |status, msg: &str| Obs::Started {
            n: 2,
            result: Err(StartError::Refused {
                status,
                message: msg.into(),
            }),
        };
        let mut r = r;
        let mut makers = vec![];
        for (i, status) in [409u16, 400, 502, 400].into_iter().enumerate() {
            run.now = t + 60 * i as u64;
            let (next, cmd) = run.step(&r, Obs::Lookup { n: 2, swap: None });
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
            assert_eq!(run.step(&next, Obs::Lookup { n: 2, swap: None }).1, None);
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
        let (r2, cmd) = run.step(&r2, Obs::Lookup { n: 2, swap: None });
        assert!(cmd.is_some());
        // With a start in flight, an unreachable daemon can't end the window.
        let (r3, _) = run.step(
            &r2,
            Obs::Unreachable {
                n: 2,
                error: "refused".into(),
            },
        );
        assert_eq!(r3.phase, Phase::Leg2Starting);
        assert!(r3.problem.as_deref().unwrap().contains("usdc-base"));
        let (r4, _) = run.step(
            &r2,
            Obs::Started {
                n: 2,
                result: Err(StartError::Refused {
                    status: 502,
                    message: "maker unreachable".into(),
                }),
            },
        );
        let (r5, _) = run.step(
            &r4,
            Obs::Unreachable {
                n: 2,
                error: "refused".into(),
            },
        );
        assert_eq!(r5.phase, Phase::Holding);
    }

    #[test]
    fn price_floor_scales_with_the_leg2_amount() {
        let policy = Policy::default();
        let mut r = new_route(&policy);
        assert_eq!(r.out_min(), 39_200_000);
        // Jitter: 1.5% kept back, same rate floor, rounded up.
        r.keep_zat = 1_500_000;
        r.zec2_zat = r.min_out_basis_zat - r.keep_zat;
        let exact = 39_200_000u128 * u128::from(r.zec2_zat);
        let want = exact.div_ceil(u128::from(r.min_out_basis_zat)) as u64;
        assert_eq!(r.out_min(), want);
        assert!(u128::from(r.out_min()) * u128::from(r.min_out_basis_zat) >= exact);
        let mut run = Run::new();
        let mut rr = run.to(Phase::Leg2Starting);
        rr.keep_zat = r.keep_zat;
        rr.zec2_zat = r.zec2_zat;
        let (_, cmd) = run.step(&rr, Obs::Lookup { n: 2, swap: None });
        let Some(Command::Start { request, .. }) = cmd else {
            panic!()
        };
        assert_eq!(request.min_counter, Some(want));
        assert_eq!(request.zec_zat, r.zec2_zat);
    }

    #[test]
    fn price_limit_refusal_holds_the_zec() {
        let mut run = Run::new();
        run.policy.leg2_window_secs = 120;
        let r = run.to(Phase::Leg2Starting);
        let (r, _) = run.step(&r, Obs::Lookup { n: 2, swap: None });
        let msg = "The maker pays 38000000 for 0.9994 ZEC, below your minimum of 39200000";
        let (r, _) = run.step(
            &r,
            Obs::Started {
                n: 2,
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
        let mut s = swap(&r, 2, "ZecLocked", None);
        s.amounts.btc_sat = r.out_min() - 1;
        s.route = None;
        let (r2, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: s.clone(),
            },
        );
        let w: Vec<_> = r2.timeline.iter().filter(|e| e.kind == "warning").collect();
        assert_eq!(w.len(), 1);
        assert!(w[0].label.contains("your minimum") && w[0].label.contains("route label"));
        // Not repeated every tick.
        let (r3, _) = run.step(&r2, Obs::Swap { n: 2, swap: s });
        assert_eq!(r3.timeline.len(), r2.timeline.len());

        // Leg 1 sweeping to its own wallet: hold in L1's wallet once swapped, no leg 2.
        let r = run.to(Phase::Leg1);
        let mut s = swap(&r, 1, "BtcRedeemed", None);
        s.sweep_to = None;
        let (r, _) = run.step(&r, Obs::Swap { n: 1, swap: s });
        assert!(r.zec_elsewhere);
        let (r, _) = run.step(
            &r,
            Obs::Settle {
                leg1: {
                    let mut s = swept(&r, Some(1));
                    s.sweep_to = None;
                    s
                },
                zec_tip: 50,
                spendable_zat: X,
            },
        );
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
        let (done, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: swap(&r, 2, "Punished", Some("punished")),
            },
        );
        assert_eq!(
            (done.phase, done.outcome),
            (Phase::Done, Some(Outcome::Swapped))
        );
        assert!(done.reason.as_deref().unwrap().contains("penalty"));

        let (held, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: swap(&r, 2, "ZecReclaimed", Some("refunded")),
            },
        );
        assert_eq!(
            (held.phase, held.outcome),
            (Phase::Holding, Some(Outcome::HoldingZec))
        );
        assert_eq!(held.held_zat, X - 30_000, "sweep + lock + reclaim fees");
        assert_eq!(held.zec2_zat, X - 80_000, "the next try sells what is left");
        assert!(held
            .reason
            .as_deref()
            .unwrap()
            .contains("You hold about 0.9997 shielded ZEC in your wallet \"user-z\"."));

        // Refunded before Z locked anything: nothing spent.
        let (held, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: swap(&r, 2, "Refunded", Some("refunded")),
            },
        );
        assert_eq!((held.phase, held.held_zat), (Phase::Holding, X - 10_000));
        let (held, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: swap(&r, 2, "Aborted", None),
            },
        );
        assert_eq!(held.phase, Phase::Holding);
        // ZecLockRefused waits for the refund to finish.
        let (wait, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: swap(&r, 2, "ZecLockRefused", None),
            },
        );
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

        // A start in flight: wait to learn whether it happened.
        let (r, _) = run.step(&r, Obs::Lookup { n: 1, swap: None });
        let s = run.user(&r, Obs::Stop).unwrap();
        assert!(s.stop_requested && s.phase == Phase::Leg1Starting);
        run.now += 120;
        let (gone, cmd) = run.step(&s, Obs::Lookup { n: 1, swap: None });
        assert_eq!((gone.phase, cmd), (Phase::Failed, None));
        let (running, _) = run.step(
            &s,
            Obs::Lookup {
                n: 1,
                swap: Some(swap(&s, 1, "BtcLocked", None)),
            },
        );
        assert_eq!(running.phase, Phase::Leg1);
        // ... it did: leg 1 runs to the end, then the route holds.
        let (held, _) = run.step(
            &running,
            Obs::Swap {
                n: 1,
                swap: swap(&running, 1, "BtcRedeemed", None),
            },
        );
        assert_eq!(
            (held.phase, held.outcome),
            (Phase::Holding, Some(Outcome::HoldingZec))
        );

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
        let (r, _) = run.step(&r, Obs::Lookup { n: 2, swap: None });
        let s = run.user(&r, Obs::Stop).unwrap();
        assert_eq!(s.phase, Phase::Leg2Starting);
        run.now += 120;
        assert_eq!(
            run.step(&s, Obs::Lookup { n: 2, swap: None }).0.phase,
            Phase::Holding
        );
        let r = run.to(Phase::Leg2);
        assert!(run.user(&r, Obs::Stop).is_err());
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
        let (held, _) = run.step(
            &r,
            Obs::Swap {
                n: 2,
                swap: swap(&r, 2, "ZecReclaimed", Some("refunded")),
            },
        );
        let req = ContinueReq {
            maker2: Some(vec![maker("http://127.0.0.1:7914", "Ibis")]),
            ..ContinueReq::default()
        };
        let c = run.user(&held, Obs::Continue(req)).unwrap();
        assert_eq!((c.phase, c.outcome, c.leg2_gen), (Phase::Settling, None, 2));
        assert_eq!(c.legs[1].earlier, ["swap2"]);
        assert_eq!(c.label(2), "r0123456789abcdef/2-2");
        // The gate waits for the reclaimed note, at the reduced amount and the same rate.
        let need = c.zec2_zat + 50_000;
        let (c2, _) = run.step(
            &c,
            Obs::Settle {
                leg1: swept(&c, Some(100)),
                zec_tip: 300,
                spendable_zat: need - 1,
            },
        );
        assert_eq!(c2.phase, Phase::Settling);
        let (c2, _) = run.step(
            &c2,
            Obs::Settle {
                leg1: swept(&c, Some(100)),
                zec_tip: 300,
                spendable_zat: need,
            },
        );
        assert_eq!(c2.phase, Phase::Pausing);
        assert_eq!(
            c2.not_before, r.not_before,
            "the pause already ran: not redrawn"
        );
        let (c3, _) = run.step(&c2, Obs::Tick);
        let (_, cmd) = run.step(&c3, Obs::Lookup { n: 2, swap: None });
        let Some(Command::Start { request, .. }) = cmd else {
            panic!()
        };
        assert_eq!(request.route, "r0123456789abcdef/2-2");
        assert_eq!(request.maker, "http://127.0.0.1:7914");
        assert_eq!(request.zec_zat, X - 80_000);
        assert!(request.min_counter.unwrap() < 39_200_000);

        // New amount and price floor.
        let req = ContinueReq {
            zec_zat: Some(50_000_000),
            min_out: Some(1_000),
            ..ContinueReq::default()
        };
        let c = run.user(&held, Obs::Continue(req)).unwrap();
        assert_eq!((c.zec2_zat, c.out_min()), (50_000_000, 1_000));
        let bad = ContinueReq {
            min_out: Some(0),
            ..ContinueReq::default()
        };
        assert!(run.user(&held, Obs::Continue(bad)).is_err());
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
            let n = if matches!(p, Phase::Leg2) { 2 } else { 1 };
            let (r2, cmd) = run.step(
                &r,
                Obs::Unreachable {
                    n,
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
            ..route_params()
        };
        assert!(Route::new(p.clone(), &policy)
            .unwrap_err()
            .contains("too little"));
        p.zec_zat = 160_000;
        p.keep_zat = 100_000;
        assert!(Route::new(p.clone(), &policy).is_err());
        p.keep_zat = 2_000;
        let r = Route::new(p, &policy).unwrap();
        assert_eq!((r.zec2_zat, r.min_out_basis_zat), (98_000, 100_000));
    }

    fn route_params() -> NewRoute {
        let r = new_route(&Policy::default());
        NewRoute {
            id: r.id,
            now: T0,
            from: r.legs[0].clone(),
            to: r.legs[1].clone(),
            zec_zat: r.zec_zat,
            keep_zat: 0,
            max_in: r.max_in,
            min_out: r.min_out,
            delay_secs: r.delay_secs,
            sweep_to: r.sweep_to,
            maker1: r.maker1,
            maker2: r.maker2,
        }
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
    }
}
