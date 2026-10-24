//! The driver: for every active route, observe its daemons, [`step`] the route, persist it, and
//! only then run the command it returned. One driver pass (or user request) at a time.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tokio::sync::broadcast;

use crate::legs::{self, find_labelled, verify, DaemonStatus, Ferryd, Role};
use crate::route::{
    step, Command, ContinueReq, Ctx, Leg, Maker, NewRoute, Obs, Phase, Policy, Refused, Route, Unit,
};
use crate::store::Store;
use crate::view::{route_view, RouteView};

/// An API error: HTTP status and a plain message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HubError(pub u16, pub String);

impl HubError {
    fn bad(m: impl Into<String>) -> HubError {
        HubError(400, m.into())
    }
}

/// Limits on what a route request may ask for.
#[derive(Clone, Debug)]
pub struct Settings {
    /// The privacy pause when a request names none (Standard: 5–30 min).
    pub default_delay_secs: [u64; 2],
    pub max_delay_secs: u64,
    /// Most ZEC jitter a route may keep back (basis points of X).
    pub max_keep_bps: u32,
    /// Allow the same maker (name or host) for both legs.
    pub allow_same_partner: bool,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            default_delay_secs: [300, 1800],
            max_delay_secs: 24 * 3600,
            max_keep_bps: 200,
            allow_same_partner: false,
        }
    }
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    })
}

pub fn os_random() -> Clock {
    Arc::new(|| {
        use rand::RngCore;
        rand::rngs::OsRng.next_u64()
    })
}

/// A maker as a request names it: a URL, or `{url, name}`.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum MakerArg {
    Url(String),
    Named { url: String, name: Option<String> },
}

impl MakerArg {
    fn resolve(self) -> Result<Maker, HubError> {
        let (url, name) = match self {
            MakerArg::Url(url) => (url, None),
            MakerArg::Named { url, name } => (url, name.filter(|n| !n.trim().is_empty())),
        };
        let url = url.trim().trim_end_matches('/').to_string();
        let ok = reqwest::Url::parse(&url)
            .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some());
        if !ok {
            return Err(HubError::bad(format!(
                "{url:?} is not an http(s) maker URL"
            )));
        }
        Ok(Maker { url, name })
    }
}

/// `POST /api/routes`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRoute {
    pub from: String,
    pub to: String,
    pub zec_zat: u64,
    pub maker1: MakerArg,
    pub maker2: Vec<MakerArg>,
    pub max_in: u64,
    /// The least coin C for the ZEC leg 2 sells before jitter (`zec_zat` − fees − reserve).
    pub min_out: u64,
    #[serde(default)]
    pub delay_secs: Option<[u64; 2]>,
    #[serde(default)]
    pub keep_bps: Option<u32>,
    /// Where leg 2 pays coin C instead of the leg-2 wallet (a NEAR Intents 1Click deposit
    /// address, say). Leg 2's ferryd checks it for its chain before it contacts a maker.
    #[serde(default)]
    pub payout_to: Option<String>,
}

/// `POST /api/routes/:id/continue`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContinueArg {
    #[serde(default)]
    pub maker2: Option<Vec<MakerArg>>,
    #[serde(default)]
    pub min_out: Option<u64>,
    #[serde(default)]
    pub zec_zat: Option<u64>,
}

pub struct Hub<F: Ferryd> {
    pub policy: Policy,
    pub settings: Settings,
    legs: BTreeMap<(String, Role), F>,
    store: Store,
    routes: Mutex<BTreeMap<String, Route>>,
    /// One driver pass or user request at a time: a route is never stepped twice at once.
    drive: tokio::sync::Mutex<()>,
    events: broadcast::Sender<RouteView>,
    clock: Clock,
    random: Clock,
}

impl<F: Ferryd> Hub<F> {
    pub fn open(
        data_dir: &Path,
        policy: Policy,
        settings: Settings,
        legs: BTreeMap<(String, Role), F>,
        clock: Clock,
        random: Clock,
    ) -> std::io::Result<Hub<F>> {
        let store = Store::open(data_dir)?;
        let routes = store
            .load_all()?
            .into_iter()
            .map(|r| (r.id.clone(), r))
            .collect();
        Ok(Hub {
            policy,
            settings,
            legs,
            store,
            routes: Mutex::new(routes),
            drive: tokio::sync::Mutex::new(()),
            events: broadcast::channel(256).0,
            clock,
            random,
        })
    }

    pub fn now(&self) -> u64 {
        (self.clock)()
    }

    pub fn legs(&self) -> impl Iterator<Item = &(String, Role)> {
        self.legs.keys()
    }

    pub fn routes(&self) -> Vec<Route> {
        self.routes.lock().unwrap().values().cloned().collect()
    }

    pub fn route(&self, id: &str) -> Option<Route> {
        self.routes.lock().unwrap().get(id).cloned()
    }

    pub fn view(&self, r: &Route) -> RouteView {
        route_view(r, &self.policy, self.now())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RouteView> {
        self.events.subscribe()
    }

    fn leg(&self, pair: &str, role: Role) -> Option<&F> {
        self.legs.get(&(pair.to_string(), role))
    }

    /// Leg `n`'s daemon; missing if the router was restarted without that `--leg`.
    fn leg_of(&self, r: &Route, n: u8) -> Result<&F, String> {
        let l = &r.legs[usize::from(n - 1)];
        self.leg(&l.pair, l.role).ok_or_else(|| {
            format!(
                "no {}:{} daemon is configured (--leg)",
                l.pair,
                l.role.as_str().to_lowercase()
            )
        })
    }

    /// Persist, then publish. Nothing acts on a route state that is not on disk.
    fn commit(&self, r: &Route) -> Result<(), HubError> {
        self.store.save(r).map_err(|e| {
            tracing::error!(route = %r.id, "persisting route: {e}");
            HubError(500, format!("could not save the route: {e}"))
        })?;
        self.routes.lock().unwrap().insert(r.id.clone(), r.clone());
        let _ = self.events.send(self.view(r));
        Ok(())
    }

    fn ctx(&self) -> Ctx<'_> {
        Ctx {
            now: self.now(),
            rand: (self.random)(),
            policy: &self.policy,
        }
    }

    /// Step `current` with `obs`, persist, and run the command it returns (then step its answer).
    async fn apply(&self, current: &Route, obs: Obs) -> Result<Route, HubError> {
        let (next, cmd) =
            step(current, &obs, &self.ctx()).map_err(|Refused(m)| HubError(409, m))?;
        if next != *current {
            self.commit(&next)?;
        }
        let Some(Command::Start { n, request }) = cmd else {
            return Ok(next);
        };
        let Ok(leg) = self.leg_of(&next, n) else {
            // observe() found the daemon, so this does not happen. Nothing was sent; the start
            // stays in flight and the next lookup decides.
            return Ok(next);
        };
        tracing::info!(route = %next.id, leg = n, label = %request.route, "starting leg {n}");
        let result = leg.start(&request).await;
        if let Err(e) = &result {
            tracing::warn!(route = %next.id, leg = n, "start: {e}");
        }
        let (after, _) = step(&next, &Obs::Started { n, result }, &self.ctx())
            .map_err(|Refused(m)| HubError(409, m))?;
        // If this save fails, the route on disk (and in memory) still says the start is in
        // flight: the next pass looks the swap up by its label instead of starting another.
        self.commit(&after)?;
        Ok(after)
    }

    /// What the daemons say about `r` now.
    async fn observe(&self, r: &Route) -> Obs {
        let unreachable = |n: u8, e: String| Obs::Unreachable { n, error: e };
        match r.phase {
            Phase::Leg1Starting | Phase::Leg2Starting => {
                let n = r.starting_leg();
                let leg = match self.leg_of(r, n) {
                    Ok(l) => l,
                    Err(e) => return unreachable(n, e),
                };
                if r.start_due(self.now(), &self.policy) {
                    // About to start: make sure this is still the daemon the route needs.
                    let l = &r.legs[usize::from(n - 1)];
                    match leg.status().await {
                        Err(e) => return unreachable(n, e.to_string()),
                        Ok(s) => {
                            if let Err(e) = verify(&s, &l.pair, l.role) {
                                return unreachable(n, e);
                            }
                            // A daemon replaced by an older one since the route was created
                            // would pay its own wallet: hold off instead.
                            if n == 2 && r.payout_to.is_some() {
                                if let Err(e) = legs::verify_payout(&s, &l.pair) {
                                    return unreachable(n, e);
                                }
                            }
                        }
                    }
                }
                match leg.swaps().await {
                    Ok(list) => Obs::Lookup {
                        n,
                        swap: find_labelled(list, &r.label(n)),
                    },
                    Err(e) => unreachable(n, e.to_string()),
                }
            }
            Phase::Leg1 | Phase::Leg2 => {
                let n = if r.phase == Phase::Leg1 { 1 } else { 2 };
                let id = r.legs[usize::from(n - 1)]
                    .swap_id
                    .clone()
                    .unwrap_or_default();
                let leg = match self.leg_of(r, n) {
                    Ok(l) => l,
                    Err(e) => return unreachable(n, e),
                };
                match leg.swap(&id).await {
                    Ok(swap) => Obs::Swap { n, swap },
                    Err(e) => unreachable(n, e.to_string()),
                }
            }
            Phase::Settling => {
                let id = r.legs[0].swap_id.clone().unwrap_or_default();
                let (l1, l2) = match (self.leg_of(r, 1), self.leg_of(r, 2)) {
                    (Ok(l1), Ok(l2)) => (l1, l2),
                    (Err(e), _) => return unreachable(1, e),
                    (_, Err(e)) => return unreachable(2, e),
                };
                let leg1 = match l1.swap(&id).await {
                    Ok(s) => s,
                    Err(e) => return unreachable(1, e.to_string()),
                };
                let s1 = match l1.status().await {
                    Ok(s) => s,
                    Err(e) => return unreachable(1, e.to_string()),
                };
                let s2 = match l2.status().await {
                    Ok(s) => s,
                    Err(e) => return unreachable(2, e.to_string()),
                };
                // The more cautious tip of the two: L2's spendability is what matters.
                Obs::Settle {
                    leg1,
                    zec_tip: s1.zec_height.min(s2.zec_height),
                    spendable_zat: s2.spendable_zat,
                }
            }
            Phase::Pausing | Phase::Done | Phase::Holding | Phase::Failed => Obs::Tick,
        }
    }

    async fn drive_locked(&self, id: &str) -> Result<Route, HubError> {
        let r = self
            .route(id)
            .ok_or_else(|| HubError(404, "no such route".into()))?;
        if !r.phase.is_active() {
            return Ok(r);
        }
        let obs = self.observe(&r).await;
        self.apply(&r, obs).await
    }

    /// One pass over every active route.
    pub async fn tick(&self) {
        let _g = self.drive.lock().await;
        let ids: Vec<String> = self
            .routes
            .lock()
            .unwrap()
            .values()
            .filter(|r| r.phase.is_active())
            .map(|r| r.id.clone())
            .collect();
        for id in ids {
            if let Err(HubError(_, e)) = self.drive_locked(&id).await {
                tracing::warn!(route = %id, "{e}");
            }
        }
    }

    pub async fn run(self: Arc<Self>, every: std::time::Duration) {
        loop {
            self.tick().await;
            tokio::time::sleep(every).await;
        }
    }

    async fn status_of(&self, pair: &str, role: Role) -> Result<DaemonStatus, HubError> {
        let leg = self.leg(pair, role).ok_or_else(|| {
            HubError::bad(format!(
                "no {pair} daemon with role {} is configured (--leg {pair}:{}=URL)",
                role.as_str(),
                role.as_str().to_lowercase()
            ))
        })?;
        let s = leg
            .status()
            .await
            .map_err(|e| HubError(502, format!("your {pair} daemon can't be reached: {e}")))?;
        verify(&s, pair, role).map_err(HubError::bad)?;
        Ok(s)
    }

    fn check_partners(&self, m1: &Maker, m2: &[Maker]) -> Result<(), HubError> {
        if m2.is_empty() || m2.len() > 8 {
            return Err(HubError::bad("maker2 must list 1 to 8 partners"));
        }
        if !self.settings.allow_same_partner {
            if let Some(m) = m2.iter().find(|m| m.same_partner(m1)) {
                return Err(HubError::bad(format!(
                    "{} can't take both swaps: the same partner on both legs could link them",
                    m.display()
                )));
            }
        }
        Ok(())
    }

    /// `POST /api/routes`: validate, persist, and start leg 1 right away.
    pub async fn create(&self, req: CreateRoute) -> Result<Route, HubError> {
        let (from, to) = (req.from.trim().to_lowercase(), req.to.trim().to_lowercase());
        for p in [&from, &to] {
            if !legs::is_pair(p) {
                return Err(HubError::bad(format!("unknown pair {p:?}")));
            }
        }
        if legs::asset(&from) == legs::asset(&to) {
            return Err(HubError::bad(format!(
                "{from} → {to} swaps an asset for itself: the amounts in and out would match and link the two legs"
            )));
        }
        let maker1 = req.maker1.resolve()?;
        let maker2 = req
            .maker2
            .into_iter()
            .map(MakerArg::resolve)
            .collect::<Result<Vec<_>, _>>()?;
        self.check_partners(&maker1, &maker2)?;
        if req.zec_zat == 0 || req.max_in == 0 || req.min_out == 0 {
            return Err(HubError::bad(
                "zec_zat, max_in and min_out must be positive",
            ));
        }
        let delay = req.delay_secs.unwrap_or(self.settings.default_delay_secs);
        if delay[0] > delay[1] || delay[1] > self.settings.max_delay_secs {
            return Err(HubError::bad(format!(
                "delay_secs must be [min, max] with min ≤ max ≤ {}",
                self.settings.max_delay_secs
            )));
        }
        let keep_bps = req.keep_bps.unwrap_or(0);
        if keep_bps > self.settings.max_keep_bps {
            return Err(HubError::bad(format!(
                "keep_bps is at most {}",
                self.settings.max_keep_bps
            )));
        }
        let payout_to = req.payout_to.map(|p| p.trim().to_string());
        if let Some(p) = &payout_to {
            legs::check_payout(p).map_err(HubError::bad)?;
        }

        let _g = self.drive.lock().await;
        let busy = self.routes.lock().unwrap().values().any(|r| {
            r.phase.is_active()
                && ((r.from == from && r.legs[0].role == Role::B)
                    || (r.to == to && r.legs[1].role == Role::Z))
        });
        if busy {
            return Err(HubError(
                409,
                "Another route is already using one of these daemons".into(),
            ));
        }
        let s1 = self.status_of(&from, Role::B).await?;
        let s2 = self.status_of(&to, Role::Z).await?;
        if payout_to.is_some() {
            legs::verify_payout(&s2, &to).map_err(HubError::bad)?;
        }
        if s1.zec_network != s2.zec_network {
            return Err(HubError::bad(format!(
                "your {from} daemon is on Zcash {} and your {to} daemon on Zcash {}",
                s1.zec_network, s2.zec_network
            )));
        }
        let sweep_to = self
            .leg(&to, Role::Z)
            .expect("checked above")
            .zec_address()
            .await
            .map_err(|e| HubError(502, format!("your {to} daemon can't be reached: {e}")))?
            .ok_or_else(|| {
                HubError::bad(format!(
                    "your {to} daemon has no shielded address to receive swap 1's ZEC"
                ))
            })?;

        let now = self.now();
        let keep_zat = if keep_bps == 0 {
            0
        } else {
            let bps = (self.random)() % (u64::from(keep_bps) + 1);
            u64::try_from(u128::from(req.zec_zat) * u128::from(bps) / 10_000).unwrap_or(0)
        };
        let leg = |pair: &str, role, s: &DaemonStatus| Leg {
            pair: pair.to_string(),
            role,
            unit: Unit {
                ticker: s.ticker.clone(),
                decimals: s.decimals,
            },
            wallet: s.name.clone(),
            ..Leg::default()
        };
        let id = {
            let taken = self.routes.lock().unwrap();
            (0u64..)
                .map(|i| {
                    format!(
                        "r{:016x}",
                        (self.random)() ^ i.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                    )
                })
                .find(|id| !taken.contains_key(id))
                .expect("a free id")
        };
        let route = Route::new(
            NewRoute {
                id: id.clone(),
                now,
                from: leg(&from, Role::B, &s1),
                to: leg(&to, Role::Z, &s2),
                zec_zat: req.zec_zat,
                keep_zat,
                max_in: req.max_in,
                min_out: req.min_out,
                delay_secs: delay,
                sweep_to,
                payout_to,
                maker1,
                maker2,
            },
            &self.policy,
        )
        .map_err(HubError::bad)?;
        self.commit(&route)?;
        tracing::info!(route = %id, %from, %to, "route created");
        // Start leg 1 now, so a refusal shows up in the answer.
        self.drive_locked(&id).await
    }

    /// `continue` or `stop`.
    pub async fn user(&self, id: &str, obs: Obs) -> Result<Route, HubError> {
        let _g = self.drive.lock().await;
        let r = self
            .route(id)
            .ok_or_else(|| HubError(404, "no such route".into()))?;
        if let Obs::Continue(c) = &obs {
            if let Some(list) = &c.maker2 {
                self.check_partners(&r.maker1, list)?;
            }
        }
        let r = self.apply(&r, obs).await?;
        if r.phase.is_active() {
            return self.drive_locked(id).await;
        }
        Ok(r)
    }

    pub async fn resume(&self, id: &str, arg: ContinueArg) -> Result<Route, HubError> {
        let maker2 = arg
            .maker2
            .map(|l| {
                l.into_iter()
                    .map(MakerArg::resolve)
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        let req = ContinueReq {
            maker2,
            min_out: arg.min_out,
            zec_zat: arg.zec_zat,
        };
        self.user(id, Obs::Continue(req)).await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fake::FakeFerryd;
    use crate::legs::{StartError, SwapEntry};
    use crate::route::tests::T0;
    use std::sync::atomic::{AtomicU64, Ordering};

    pub(crate) struct Rig {
        pub dir: tempfile::TempDir,
        pub l1: FakeFerryd,
        pub l2: FakeFerryd,
        pub now: Arc<AtomicU64>,
        pub rand: Arc<AtomicU64>,
    }

    impl Rig {
        pub(crate) fn new() -> Rig {
            Rig {
                dir: tempfile::tempdir().unwrap(),
                l1: FakeFerryd::new(Role::B, "btc", "user-b"),
                l2: FakeFerryd::new(Role::Z, "usdc-base", "user-z"),
                now: Arc::new(AtomicU64::new(T0)),
                rand: Arc::new(AtomicU64::new(42)),
            }
        }

        /// A hub over the rig's data dir, as after a (re)start.
        pub(crate) fn hub(&self) -> Hub<FakeFerryd> {
            self.hub_with(BTreeMap::from([
                (("btc".to_string(), Role::B), self.l1.clone()),
                (("usdc-base".to_string(), Role::Z), self.l2.clone()),
            ]))
        }

        pub(crate) fn hub_with(
            &self,
            legs: BTreeMap<(String, Role), FakeFerryd>,
        ) -> Hub<FakeFerryd> {
            let (now, rand) = (self.now.clone(), self.rand.clone());
            Hub::open(
                self.dir.path(),
                Policy::default(),
                Settings::default(),
                legs,
                Arc::new(move || now.load(Ordering::SeqCst)),
                Arc::new(move || rand.load(Ordering::SeqCst)),
            )
            .unwrap()
        }

        pub(crate) fn advance(&self, secs: u64) {
            self.now.fetch_add(secs, Ordering::SeqCst);
        }
    }

    pub(crate) fn request() -> CreateRoute {
        serde_json::from_value(serde_json::json!({
            "from": "btc", "to": "usdc-base", "zec_zat": 100_000_000,
            "maker1": {"url": "http://127.0.0.1:7111", "name": "Kestrel"},
            "maker2": ["http://127.0.0.1:7912", {"url": "http://127.0.0.1:7913", "name": "Egret"}],
            "max_in": 412_500, "min_out": 39_200_000, "delay_secs": [300, 1800]
        }))
        .unwrap()
    }

    fn sweep(height: u64) -> SwapEntry {
        SwapEntry {
            kind: "zec_sweep_broadcast".into(),
            txid: Some("sweeptx".into()),
            height: Some(height),
            ..SwapEntry::default()
        }
    }

    #[tokio::test]
    async fn a_whole_route_through_the_driver() {
        let rig = Rig::new();
        let hub = rig.hub();
        let r = hub.create(request()).await.unwrap();
        // Leg 1 started at once, exactly as the contract says.
        assert_eq!(r.phase, Phase::Leg1);
        let starts = rig.l1.starts();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].route, format!("{}/1", r.id));
        assert_eq!(starts[0].sweep_to.as_deref(), Some("utest1user-z"));
        assert_eq!(
            (starts[0].max_counter, starts[0].zec_zat),
            (Some(412_500), 100_000_000)
        );
        let id1 = r.legs[0].swap_id.clone().unwrap();

        hub.tick().await;
        assert_eq!(hub.route(&r.id).unwrap().phase, Phase::Leg1);
        rig.l1.set_state(&id1, "ZecSwept", Some("swapped"));
        rig.l1.push_timeline(&id1, sweep(100));
        rig.l1.set_zec(105, 0);
        rig.l2.set_zec(105, 0);
        hub.tick().await; // leg 1 → settling
        hub.tick().await; // 6 confirmations
        let r = hub.route(&r.id).unwrap();
        assert_eq!((r.phase, r.zec.sweep_confs), (Phase::Settling, 6));

        rig.l1.set_zec(109, 0);
        rig.l2.set_zec(109, 99_990_000);
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Pausing);
        let not_before = r.not_before.unwrap();
        assert_eq!(not_before, T0 + 300 + 42);
        hub.tick().await;
        assert!(rig.l2.starts().is_empty(), "no leg 2 during the pause");

        rig.advance(342);
        hub.tick().await; // pause over → leg2_starting
        hub.tick().await; // lookup → start
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Leg2);
        let starts = rig.l2.starts();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].route, format!("{}/2", r.id));
        assert_eq!(
            (starts[0].min_counter, starts[0].zec_zat),
            (Some(39_200_000), 99_940_000)
        );
        assert_eq!(starts[0].maker, "http://127.0.0.1:7912");
        let id2 = r.legs[1].swap_id.clone().unwrap();

        rig.l2.set_state(&id2, "Claimed", Some("swapped"));
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Done);
        assert_eq!((rig.l1.starts().len(), rig.l2.starts().len()), (1, 1));
        // Persisted.
        assert_eq!(rig.hub().route(&r.id).unwrap(), r);
    }

    /// `payout_to` (a route that ends on NEAR Intents): refused unless it looks like an address
    /// and leg 2's daemon takes it; sent with leg 2's start only, and not to a daemon that has
    /// stopped taking it since the route was created.
    #[tokio::test]
    async fn payout_to_reaches_leg_two_only_on_a_daemon_that_takes_it() {
        const PAY: &str = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
        let rig = Rig::new();
        let hub = rig.hub();
        let with = |to: &str| CreateRoute {
            payout_to: Some(to.into()),
            ..request()
        };
        let err = hub.create(with(PAY)).await.unwrap_err();
        assert_eq!(err.0, 400);
        assert!(err.1.contains("does not take payout_to"), "{}", err.1);
        let err = hub.create(with("0x12/34")).await.unwrap_err();
        assert!(err.1.contains("must be an address"), "{}", err.1);
        assert!(hub.routes().is_empty() && rig.l1.starts().is_empty());

        let features = || vec!["route".to_string(), "payout".to_string()];
        rig.l2.set_features(features());
        let r = hub.create(with(PAY)).await.unwrap();
        assert_eq!(r.payout_to.as_deref(), Some(PAY));
        assert_eq!(hub.view(&r).payout_to.as_deref(), Some(PAY));
        assert_eq!(rig.l1.starts()[0].payout_to, None, "leg 1 never gets it");
        let id1 = r.legs[0].swap_id.clone().unwrap();
        rig.l1.set_state(&id1, "ZecSwept", Some("swapped"));
        rig.l1.push_timeline(&id1, sweep(100));
        rig.l1.set_zec(109, 0);
        rig.l2.set_zec(109, 99_990_000);
        hub.tick().await; // settling
        hub.tick().await; // pausing
        rig.advance(342);
        rig.l2.set_features(vec!["route".into()]);
        hub.tick().await; // leg2_starting
        hub.tick().await; // the daemon no longer takes payout_to: no start
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Leg2Starting);
        assert!(rig.l2.starts().is_empty());
        assert!(
            r.problem.as_deref().unwrap_or("").contains("payout_to"),
            "{:?}",
            r.problem
        );
        rig.l2.set_features(features());
        rig.advance(60);
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Leg2);
        let starts = rig.l2.starts();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].payout_to.as_deref(), Some(PAY));
        let id2 = r.legs[1].swap_id.clone().unwrap();
        rig.l2.set_state(&id2, "Claimed", Some("swapped"));
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Done);
        assert!(r.reason.unwrap().contains("your payout address"));
        assert!(!r.timeline.iter().any(|e| e.kind == "warning"));
    }

    #[tokio::test]
    async fn a_lost_answer_is_adopted_after_a_restart_not_started_again() {
        let rig = Rig::new();
        // ferryd creates the swap but the router never hears back, then the router restarts.
        rig.l1.lose_next_answer();
        let r = rig.hub().create(request()).await.unwrap();
        assert_eq!(r.phase, Phase::Leg1Starting);
        assert!(r.starting.inflight_since.is_some());
        let hub = rig.hub();
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Leg1);
        assert_eq!(rig.l1.starts().len(), 1);
        assert_eq!(rig.l1.swap_count(), 1);
    }

    #[tokio::test]
    async fn a_start_that_never_arrived_is_sent_once_after_the_grace() {
        let rig = Rig::new();
        // The call fails without reaching ferryd (as after a crash just before posting).
        rig.l1.drop_next_start();
        let r = rig.hub().create(request()).await.unwrap();
        assert_eq!(r.phase, Phase::Leg1Starting);
        let hub = rig.hub();
        rig.advance(60);
        hub.tick().await;
        assert_eq!(
            rig.l1.starts().len(),
            0,
            "ferryd might still be busy with it: wait"
        );
        rig.advance(60);
        hub.tick().await;
        assert_eq!(hub.route(&r.id).unwrap().phase, Phase::Leg1);
        assert_eq!(rig.l1.starts().len(), 1);
        assert_eq!(rig.l1.swap_count(), 1, "one swap, under the one label");
        hub.tick().await;
        assert_eq!(rig.l1.starts().len(), 1);
    }

    #[tokio::test]
    async fn the_pause_survives_a_restart() {
        let rig = Rig::new();
        let hub = rig.hub();
        let r = hub.create(request()).await.unwrap();
        let id1 = r.legs[0].swap_id.clone().unwrap();
        rig.l1.set_state(&id1, "ZecSwept", Some("swapped"));
        rig.l1.push_timeline(&id1, sweep(100));
        rig.l1.set_zec(120, 0);
        rig.l2.set_zec(120, 99_990_000);
        hub.tick().await;
        hub.tick().await;
        let drawn = hub.route(&r.id).unwrap().not_before.unwrap();
        drop(hub);
        rig.rand.store(1000, std::sync::atomic::Ordering::SeqCst);
        let hub = rig.hub();
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!((r.phase, r.not_before), (Phase::Pausing, Some(drawn)));
        rig.advance(drawn - T0);
        hub.tick().await;
        hub.tick().await;
        assert_eq!(hub.route(&r.id).unwrap().phase, Phase::Leg2);
        assert_eq!(rig.l2.starts().len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nothing_starts_while_the_route_cannot_be_saved() {
        use std::os::unix::fs::PermissionsExt;
        let rig = Rig::new();
        let hub = rig.hub();
        let r = hub.create(request()).await.unwrap();
        let id1 = r.legs[0].swap_id.clone().unwrap();
        rig.l1.set_state(&id1, "ZecSwept", Some("swapped"));
        rig.l1.push_timeline(&id1, sweep(100));
        rig.l1.set_zec(120, 0);
        rig.l2.set_zec(120, 99_990_000);
        rig.rand.store(0, std::sync::atomic::Ordering::SeqCst);
        hub.tick().await;
        hub.tick().await;
        hub.tick().await; // pause drawn and leg2_starting reached? Not yet: 300 s pause.
        assert_eq!(hub.route(&r.id).unwrap().phase, Phase::Pausing);
        rig.advance(300);
        let routes = rig.dir.path().join("routes");
        std::fs::set_permissions(&routes, std::fs::Permissions::from_mode(0o500)).unwrap();
        for _ in 0..3 {
            hub.tick().await;
        }
        assert_eq!(
            hub.route(&r.id).unwrap().phase,
            Phase::Pausing,
            "unsaved: not taken"
        );
        assert!(rig.l2.starts().is_empty());
        std::fs::set_permissions(&routes, std::fs::Permissions::from_mode(0o700)).unwrap();
        hub.tick().await;
        hub.tick().await;
        assert_eq!(hub.route(&r.id).unwrap().phase, Phase::Leg2);
        assert_eq!(rig.l2.starts().len(), 1);
    }

    #[tokio::test]
    async fn leg2_refusals_end_in_holding_and_continue_works() {
        let rig = Rig::new();
        let hub = rig.hub();
        let r = hub
            .create(CreateRoute {
                delay_secs: Some([0, 0]),
                ..request()
            })
            .await
            .unwrap();
        let id1 = r.legs[0].swap_id.clone().unwrap();
        rig.l1.set_state(&id1, "ZecSwept", Some("swapped"));
        rig.l1.push_timeline(&id1, sweep(100));
        rig.l1.set_zec(120, 0);
        rig.l2.set_zec(120, 99_990_000);
        rig.l2.refuse_starts(StartError::Refused {
            status: 400,
            message: "The maker pays less than your minimum".into(),
        });
        for _ in 0..4 {
            hub.tick().await;
        }
        assert_eq!(hub.route(&r.id).unwrap().phase, Phase::Leg2Starting);
        for _ in 0..3 {
            rig.advance(60);
            hub.tick().await;
        }
        rig.advance(7200);
        hub.tick().await;
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Holding);
        assert!(hub
            .view(&r)
            .note
            .contains("You hold about 0.9999 shielded ZEC in your wallet \"user-z\""));
        assert_eq!(
            rig.l2.starts().len(),
            4,
            "every 60 s, then the window ended"
        );
        assert_eq!(rig.l2.swap_count(), 0);

        // The maker is back: continue, and leg 2 runs.
        rig.l2.accept_starts();
        let r = hub.resume(&r.id, ContinueArg::default()).await.unwrap();
        assert_eq!(
            r.phase,
            Phase::Pausing,
            "the pause already ran: straight through"
        );
        hub.tick().await;
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Leg2);
        assert_eq!(rig.l2.swap_count(), 1);
        // Stop is refused now.
        assert_eq!(hub.user(&r.id, Obs::Stop).await.unwrap_err().0, 409);
    }

    #[tokio::test]
    async fn create_refuses_bad_routes() {
        let rig = Rig::new();
        let hub = rig.hub();
        let code = |r: Result<Route, HubError>| r.unwrap_err();
        let same_asset = CreateRoute {
            to: "btc".into(),
            ..request()
        };
        assert_eq!(code(hub.create(same_asset).await).0, 400);
        let unknown = CreateRoute {
            to: "doge".into(),
            ..request()
        };
        assert_eq!(code(hub.create(unknown).await).0, 400);
        let unconfigured = CreateRoute {
            to: "usdc-arbitrum".into(),
            ..request()
        };
        assert!(code(hub.create(unconfigured).await)
            .1
            .contains("no usdc-arbitrum daemon"));
        let same_maker = CreateRoute {
            maker2: vec![MakerArg::Url("http://127.0.0.1:7111/".into())],
            ..request()
        };
        assert!(code(hub.create(same_maker).await).1.contains("both swaps"));
        let bad_url = CreateRoute {
            maker1: MakerArg::Url("file:///etc".into()),
            ..request()
        };
        assert_eq!(code(hub.create(bad_url).await).0, 400);
        let long = CreateRoute {
            delay_secs: Some([10, 1_000_000]),
            ..request()
        };
        assert_eq!(code(hub.create(long).await).0, 400);
        let jitter = CreateRoute {
            keep_bps: Some(500),
            ..request()
        };
        assert_eq!(code(hub.create(jitter).await).0, 400);
        let tiny = CreateRoute {
            zec_zat: 50_000,
            ..request()
        };
        assert!(code(hub.create(tiny).await).1.contains("too little"));

        rig.l2.set_address(None);
        assert!(code(hub.create(request()).await)
            .1
            .contains("no shielded address"));
        rig.l2.set_address(Some("utest1user-z".into()));
        rig.l2.set_features(vec![]);
        assert!(code(hub.create(request()).await)
            .1
            .contains("does not support routes"));
        rig.l2.set_features(vec!["route".into()]);
        rig.l2.set_down(true);
        assert_eq!(code(hub.create(request()).await).0, 502);
        rig.l2.set_down(false);
        assert!(hub.routes().is_empty(), "nothing was persisted");

        // One route per daemon at a time.
        let r = hub.create(request()).await.unwrap();
        assert_eq!(code(hub.create(request()).await).0, 409);
        let r2 = hub.user(&r.id, Obs::Stop).await.unwrap();
        assert_eq!(
            r2.phase,
            Phase::Leg1,
            "leg 1 runs on; stop only cancels leg 2"
        );
        assert!(r2.stop_requested);
    }

    #[tokio::test]
    async fn a_refused_leg1_fails_the_route_without_moving_anything() {
        let rig = Rig::new();
        rig.l1.refuse_starts(StartError::Refused {
            status: 400,
            message: "The maker refused: amount out of range".into(),
        });
        let hub = rig.hub();
        let r = hub.create(request()).await.unwrap();
        assert_eq!(r.phase, Phase::Failed);
        let note = hub.view(&r).note;
        assert!(
            note.contains("amount out of range") && note.contains("Nothing moved"),
            "{note}"
        );
        let again = hub.create(request()).await.unwrap();
        assert_eq!(again.phase, Phase::Failed, "a failed route holds no daemon");
        assert_eq!(rig.l2.starts().len(), 0);
    }

    #[tokio::test]
    async fn the_existing_labelled_swap_is_checked_before_any_start() {
        let rig = Rig::new();
        let hub = rig.hub();
        let r = hub
            .create(CreateRoute {
                delay_secs: Some([0, 0]),
                ..request()
            })
            .await
            .unwrap();
        let id1 = r.legs[0].swap_id.clone().unwrap();
        rig.l1.set_state(&id1, "ZecSwept", Some("swapped"));
        rig.l1.push_timeline(&id1, sweep(100));
        rig.l1.set_zec(120, 0);
        rig.l2.set_zec(120, 99_990_000);
        hub.tick().await; // settling
        hub.tick().await; // pausing
        hub.tick().await; // leg2_starting

        // Someone (a previous router process) already started leg 2 under this label.
        rig.l2.insert_swap(&format!("{}/2", r.id), 99_940_000);
        hub.tick().await;
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Leg2);
        assert!(rig.l2.starts().is_empty());
    }

    #[tokio::test]
    async fn a_leg_dropped_from_the_config_is_a_problem_not_a_crash() {
        let rig = Rig::new();
        let r = rig.hub().create(request()).await.unwrap();
        let id1 = r.legs[0].swap_id.clone().unwrap();
        rig.l1.set_state(&id1, "ZecSwept", Some("swapped"));
        // Restarted with only the leg-1 daemon configured.
        let hub = rig.hub_with(BTreeMap::from([(
            ("btc".to_string(), Role::B),
            rig.l1.clone(),
        )]));
        hub.tick().await; // leg 1 → settling
        hub.tick().await; // settling needs the leg-2 daemon
        let r = hub.route(&r.id).unwrap();
        assert_eq!(r.phase, Phase::Settling);
        assert!(
            r.problem
                .as_deref()
                .unwrap()
                .contains("no usdc-base:z daemon is configured"),
            "{:?}",
            r.problem
        );
    }
}
