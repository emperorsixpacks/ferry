//! Live maker rate: the median of public price feeds, times (1 + spread), refreshed in the
//! background.
//!
//! `--maker-price-feed kraken,coingecko --maker-spread-bps 50` makes the offer's rate follow the
//! market instead of the fixed `--maker-offer` rate. Every refresh asks each source for the
//! base/quote price (no API keys), takes the median of the ones that answered with a fresh,
//! positive price, and applies the spread. When no source has answered for `stale_after`, the
//! offer pauses (`making: false`) rather than quote a stale price.
//!
//! A taker fetches the offer, then proposes at that rate. A refresh may land in between, so the
//! maker also accepts the previous rate for `grace` after it was replaced.

use std::fmt;
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{checked_btc_for, zat_for, Offer};

/// How often the rate is refreshed.
pub const REFRESH: Duration = Duration::from_secs(60);
/// Past this age without any source answering, the offer pauses.
pub const STALE_AFTER: Duration = Duration::from_secs(300);
/// A replaced rate is still accepted for this long (a taker's quote in flight).
pub const GRACE: Duration = Duration::from_secs(120);
/// Per-request timeout of every feed call.
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asset {
    Zec,
    Btc,
    Ltc,
    Usd,
    Usdc,
    /// Ether, priced for WETH (which is 1:1 with it): wei, 18 decimals.
    Eth,
}

impl Asset {
    /// Decimal places of the asset's smallest unit (sat, litoshi, cent-of-a-cent, wei...).
    pub fn decimals(self) -> u32 {
        match self {
            Asset::Zec | Asset::Btc | Asset::Ltc => 8,
            Asset::Usd | Asset::Usdc => 6,
            Asset::Eth => 18,
        }
    }

    fn kraken(self) -> &'static str {
        match self {
            Asset::Zec => "ZEC",
            Asset::Btc => "XBT",
            Asset::Ltc => "LTC",
            Asset::Usd => "USD",
            Asset::Usdc => "USDC",
            Asset::Eth => "ETH",
        }
    }

    /// CoinGecko coin id (None for fiat).
    fn coingecko_id(self) -> Option<&'static str> {
        match self {
            Asset::Zec => Some("zcash"),
            Asset::Btc => Some("bitcoin"),
            Asset::Ltc => Some("litecoin"),
            Asset::Usdc => Some("usd-coin"),
            Asset::Eth => Some("ethereum"),
            Asset::Usd => None,
        }
    }

    /// CoinGecko `vs_currencies` code, when the asset is one.
    fn coingecko_vs(self) -> Option<&'static str> {
        match self {
            Asset::Btc => Some("btc"),
            Asset::Ltc => Some("ltc"),
            Asset::Usd => Some("usd"),
            Asset::Eth => Some("eth"),
            Asset::Zec | Asset::Usdc => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Asset::Zec => "ZEC",
            Asset::Btc => "BTC",
            Asset::Ltc => "LTC",
            Asset::Usd => "USD",
            Asset::Usdc => "USDC",
            Asset::Eth => "ETH",
        }
    }
}

impl FromStr for Asset {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        Ok(match s.trim().to_ascii_uppercase().as_str() {
            "ZEC" => Asset::Zec,
            "BTC" | "XBT" => Asset::Btc,
            "LTC" => Asset::Ltc,
            "USD" => Asset::Usd,
            "USDC" => Asset::Usdc,
            "ETH" | "WETH" => Asset::Eth,
            other => {
                return Err(format!(
                    "unknown asset {other} (ZEC, BTC, LTC, USD, USDC, ETH/WETH)"
                ))
            }
        })
    }
}

/// `BASE/QUOTE`: the price is how many QUOTE one BASE buys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pair {
    pub base: Asset,
    pub quote: Asset,
}

impl Pair {
    #[cfg(test)]
    pub const ZEC_BTC: Pair = Pair {
        base: Asset::Zec,
        quote: Asset::Btc,
    };

    /// `price` QUOTE per BASE → QUOTE's smallest units per one whole BASE, after the spread.
    pub fn rate_units(self, price: f64, spread_bps: i32) -> Option<u64> {
        let r = price
            * (1.0 + f64::from(spread_bps) / 10_000.0)
            * 10f64.powi(self.quote.decimals() as i32);
        (r.is_finite() && r >= 1.0 && r < u64::MAX as f64).then(|| r.round() as u64)
    }
}

impl fmt::Display for Pair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.base.as_str(), self.quote.as_str())
    }
}

impl FromStr for Pair {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let (b, q) = s
            .split_once('/')
            .ok_or("expected BASE/QUOTE, e.g. ZEC/BTC")?;
        let pair = Pair {
            base: b.parse()?,
            quote: q.parse()?,
        };
        if pair.base == pair.quote {
            return Err("base and quote must differ".into());
        }
        Ok(pair)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    /// Kraken's public ticker (`/0/public/Ticker`), last trade price.
    Kraken,
    /// CoinGecko's simple price (`/api/v3/simple/price`).
    CoinGecko,
}

impl SourceKind {
    pub fn name(self) -> &'static str {
        match self {
            SourceKind::Kraken => "kraken",
            SourceKind::CoinGecko => "coingecko",
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            SourceKind::Kraken => "https://api.kraken.com",
            SourceKind::CoinGecko => "https://api.coingecko.com",
        }
    }
}

/// `--maker-price-feed`: `kraken`, `coingecko`, a comma list of them, `all`, or `off` (a fixed
/// rate; lets a deployment template always pass the flag).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedArg(pub Vec<SourceKind>);

impl FromStr for FeedArg {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let mut out = vec![];
        if matches!(s.trim().to_ascii_lowercase().as_str(), "off" | "none") {
            return Ok(FeedArg(out));
        }
        for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let kinds: &[SourceKind] = match part.to_ascii_lowercase().as_str() {
                "all" => &[SourceKind::Kraken, SourceKind::CoinGecko],
                "kraken" => &[SourceKind::Kraken],
                "coingecko" => &[SourceKind::CoinGecko],
                other => {
                    return Err(format!(
                        "unknown price feed {other} (kraken, coingecko, all)"
                    ))
                }
            };
            for k in kinds {
                if !out.contains(k) {
                    out.push(*k);
                }
            }
        }
        if out.is_empty() {
            return Err("name at least one price feed".into());
        }
        Ok(FeedArg(out))
    }
}

/// One price source and where to reach it (tests point it at a local mock).
#[derive(Clone, Debug)]
pub struct Source {
    pub kind: SourceKind,
    pub base_url: String,
}

impl Source {
    pub fn public(kind: SourceKind) -> Source {
        Source {
            kind,
            base_url: kind.default_base_url().into(),
        }
    }

    /// QUOTE per BASE, fresh as of `now_unix`.
    pub async fn fetch(
        &self,
        http: &reqwest::Client,
        pair: Pair,
        now_unix: u64,
    ) -> Result<f64, String> {
        match self.kind {
            SourceKind::Kraken => self.kraken(http, pair).await,
            SourceKind::CoinGecko => self.coingecko(http, pair, now_unix).await,
        }
    }

    async fn get(&self, http: &reqwest::Client, path_and_query: &str) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path_and_query);
        let res = http
            .get(&url)
            .timeout(HTTP_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("{}: {e}", self.kind.name()))?;
        let res = res
            .error_for_status()
            .map_err(|e| format!("{}: {e}", self.kind.name()))?;
        res.json::<Value>()
            .await
            .map_err(|e| format!("{}: bad JSON: {e}", self.kind.name()))
    }

    async fn kraken(&self, http: &reqwest::Client, pair: Pair) -> Result<f64, String> {
        let direct = self.kraken_pair(http, pair.base, pair.quote).await;
        let unlisted = direct
            .as_ref()
            .is_err_and(|e| e.contains("Unknown asset pair"));
        if !unlisted || pair.quote == Asset::Usd || pair.base == Asset::Usd {
            return direct;
        }
        // Not every pair is listed (ZEC/LTC is not): cross through USD. Only for an unlisted
        // pair; a timeout must not cost two more calls.
        let b = self.kraken_pair(http, pair.base, Asset::Usd).await?;
        let q = self.kraken_pair(http, pair.quote, Asset::Usd).await?;
        positive(b / q, "kraken")
    }

    async fn kraken_pair(
        &self,
        http: &reqwest::Client,
        base: Asset,
        quote: Asset,
    ) -> Result<f64, String> {
        let v = self
            .get(
                http,
                &format!("/0/public/Ticker?pair={}{}", base.kraken(), quote.kraken()),
            )
            .await?;
        parse_kraken(&v)
    }

    async fn coingecko(
        &self,
        http: &reqwest::Client,
        pair: Pair,
        now_unix: u64,
    ) -> Result<f64, String> {
        let base = pair
            .base
            .coingecko_id()
            .ok_or("coingecko: base must be a coin")?;
        if let Some(vs) = pair.quote.coingecko_vs() {
            let v = self
                .get(
                    http,
                    &format!("/api/v3/simple/price?ids={base}&vs_currencies={vs}&include_last_updated_at=true"),
                )
                .await?;
            return parse_coingecko(&v, base, vs, now_unix);
        }
        // A coin quote with no vs code (USDC): the ratio of both USD prices.
        let quote = pair
            .quote
            .coingecko_id()
            .ok_or("coingecko: unsupported quote")?;
        let v = self
            .get(
                http,
                &format!("/api/v3/simple/price?ids={base},{quote}&vs_currencies=usd&include_last_updated_at=true"),
            )
            .await?;
        let b = parse_coingecko(&v, base, "usd", now_unix)?;
        let q = parse_coingecko(&v, quote, "usd", now_unix)?;
        positive(b / q, "coingecko")
    }
}

fn positive(p: f64, who: &str) -> Result<f64, String> {
    if p.is_finite() && p > 0.0 {
        Ok(p)
    } else {
        Err(format!("{who}: price {p} is not a positive number"))
    }
}

/// `{"error": [], "result": {"XZECXXBT": {"c": ["0.000898", "1.2"], ...}}}` → last trade price.
pub fn parse_kraken(v: &Value) -> Result<f64, String> {
    if let Some(errs) = v.get("error").and_then(Value::as_array) {
        if !errs.is_empty() {
            return Err(format!("kraken: {}", Value::Array(errs.clone())));
        }
    }
    let ticker = v
        .get("result")
        .and_then(Value::as_object)
        .and_then(|r| r.values().next())
        .ok_or("kraken: no ticker in the result")?;
    let last = ticker
        .get("c")
        .and_then(|c| c.get(0))
        .and_then(Value::as_str)
        .ok_or("kraken: no last trade price")?;
    positive(
        last.parse::<f64>()
            .map_err(|e| format!("kraken: {last}: {e}"))?,
        "kraken",
    )
}

/// `{"zcash": {"btc": 0.000898, "last_updated_at": 1760870000}}` → price, refused when the
/// source's own timestamp is older than [`STALE_AFTER`].
pub fn parse_coingecko(v: &Value, id: &str, vs: &str, now_unix: u64) -> Result<f64, String> {
    let coin = v
        .get(id)
        .ok_or_else(|| format!("coingecko: no {id} in the answer"))?;
    let price = coin
        .get(vs)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("coingecko: no {id} price in {vs}"))?;
    if let Some(at) = coin.get("last_updated_at").and_then(Value::as_u64) {
        if now_unix.saturating_sub(at) > STALE_AFTER.as_secs() {
            return Err(format!("coingecko: {id} price is {}s old", now_unix - at));
        }
    }
    positive(price, "coingecko")
}

/// The median of `xs` (the mean of the middle two for an even count).
pub fn median(xs: &mut [f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    xs.sort_by(|a, b| a.total_cmp(b));
    let n = xs.len();
    Some(if n % 2 == 1 {
        xs[n / 2]
    } else {
        (xs[n / 2 - 1] + xs[n / 2]) / 2.0
    })
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Clone, Debug)]
pub struct FeedConfig {
    pub pair: Pair,
    pub sources: Vec<Source>,
    pub spread_bps: i32,
    pub refresh: Duration,
    pub stale_after: Duration,
    pub grace: Duration,
}

#[derive(Debug, Default)]
struct RateState {
    rate: Option<u64>,
    /// The rate before the last change, and when it was replaced.
    previous: Option<(u64, Instant)>,
    /// Unix seconds of the last successful refresh.
    updated_at: Option<u64>,
    last_ok: Option<Instant>,
    /// Sources that answered in the last successful refresh.
    answered: Vec<&'static str>,
    /// Why the last refresh failed, if it did.
    last_error: Option<String>,
}

/// What the offer quotes right now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    pub rate: u64,
    /// e.g. `median(kraken,coingecko) +50bps`
    pub source: String,
    /// Unix seconds of the price the rate comes from.
    pub updated_at: u64,
    /// Every source has been failing for longer than `stale_after`.
    pub paused: bool,
}

/// The shared live rate: one refresher task writes it, the offer reads it.
#[derive(Debug)]
pub struct LiveRate {
    pub cfg: FeedConfig,
    state: RwLock<RateState>,
}

impl LiveRate {
    pub fn new(cfg: FeedConfig) -> LiveRate {
        LiveRate {
            cfg,
            state: RwLock::new(RateState::default()),
        }
    }

    /// Record one refresh round's answers.
    pub fn apply(
        &self,
        results: &[(SourceKind, Result<f64, String>)],
        now: Instant,
        now_unix: u64,
    ) {
        let mut prices: Vec<f64> = results
            .iter()
            .filter_map(|(_, r)| r.as_ref().ok().copied())
            .filter(|p| p.is_finite() && *p > 0.0)
            .collect();
        let errors: Vec<&str> = results
            .iter()
            .filter_map(|(_, r)| r.as_ref().err().map(String::as_str))
            .collect();
        let mut st = self.state.write().expect("not poisoned");
        let rate =
            median(&mut prices).and_then(|p| self.cfg.pair.rate_units(p, self.cfg.spread_bps));
        match rate {
            Some(rate) => {
                if let Some(old) = st.rate.filter(|old| *old != rate) {
                    st.previous = Some((old, now));
                }
                st.rate = Some(rate);
                st.updated_at = Some(now_unix);
                st.last_ok = Some(now);
                st.answered = results
                    .iter()
                    .filter(|(_, r)| r.is_ok())
                    .map(|(k, _)| k.name())
                    .collect();
                st.last_error = (!errors.is_empty()).then(|| errors.join("; "));
            }
            None => {
                st.last_error = Some(if errors.is_empty() {
                    "no usable price".into()
                } else {
                    errors.join("; ")
                });
            }
        }
    }

    /// The current quote; None until the first successful refresh.
    pub fn quote_at(&self, now: Instant) -> Option<Quote> {
        let st = self.state.read().expect("not poisoned");
        let rate = st.rate?;
        let paused = st
            .last_ok
            .is_none_or(|t| now.duration_since(t) > self.cfg.stale_after);
        let spread = match self.cfg.spread_bps {
            0 => String::new(),
            s => format!(" {s:+}bps"),
        };
        Some(Quote {
            rate,
            source: format!("median({}){spread}", st.answered.join(",")),
            updated_at: st.updated_at.unwrap_or(0),
            paused,
        })
    }

    pub fn quote(&self) -> Option<Quote> {
        self.quote_at(Instant::now())
    }

    pub fn last_error(&self) -> Option<String> {
        self.state.read().expect("not poisoned").last_error.clone()
    }

    /// Whether `btc_amount` for `zec_amount` matches the current rate, or the previous one while
    /// it is within the grace period. False while paused.
    pub fn amount_matches_at(&self, zec_amount: u64, btc_amount: u64, now: Instant) -> bool {
        let Some(q) = self.quote_at(now) else {
            return false;
        };
        if q.paused {
            return false;
        }
        // A quote that does not fit in u64 matches nothing (rather than a saturated amount).
        if checked_btc_for(zec_amount, q.rate) == Some(btc_amount) {
            return true;
        }
        let st = self.state.read().expect("not poisoned");
        st.previous.is_some_and(|(old, replaced)| {
            now.duration_since(replaced) <= self.cfg.grace
                && checked_btc_for(zec_amount, old) == Some(btc_amount)
        })
    }

    pub fn amount_matches(&self, zec_amount: u64, btc_amount: u64) -> bool {
        self.amount_matches_at(zec_amount, btc_amount, Instant::now())
    }

    /// Ask every source once (concurrently) and record the answers.
    pub async fn refresh(&self, http: &reqwest::Client) {
        let now_unix = unix_now();
        let calls = self.cfg.sources.iter().map(|s| async move {
            // a hung source can't hold up the round, whatever the client's own timeouts are
            let r = tokio::time::timeout(HTTP_TIMEOUT * 3, s.fetch(http, self.cfg.pair, now_unix))
                .await
                .unwrap_or_else(|_| Err(format!("{}: timed out", s.kind.name())));
            (s.kind, r)
        });
        let results = futures_util::future::join_all(calls).await;
        for (kind, r) in &results {
            if let Err(e) = r {
                tracing::warn!(source = kind.name(), "price feed: {e}");
            }
        }
        self.apply(&results, Instant::now(), unix_now());
        match self.quote() {
            Some(q) if !q.paused => {
                tracing::debug!(rate = q.rate, source = %q.source, "maker rate")
            }
            _ => tracing::warn!(
                pair = %self.cfg.pair,
                "maker offer paused: no fresh price ({})",
                self.last_error().unwrap_or_default()
            ),
        }
    }

    /// Refresh forever, every `cfg.refresh`.
    pub async fn run(self: Arc<Self>) {
        let http = match feed_client() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("price feed: building the HTTP client: {e}");
                return;
            }
        };
        let mut tick = tokio::time::interval(self.cfg.refresh);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            self.refresh(&http).await;
        }
    }
}

/// HTTP client for the feeds: connect and total timeouts on every call.
pub fn feed_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("ferryd/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// The maker's balances, as far as filling an offer goes.
#[derive(Clone, Copy, Debug)]
pub struct Funds {
    pub zec_shielded_zat: u64,
    pub btc_sat: u64,
}

/// `base` as it stands right now: the live rate (or the fixed one), where it comes from, whether
/// it is paused, and how much ZEC the maker can fill from its balance (`funds`).
pub fn live_offer(
    base: &Offer,
    rate: Option<&LiveRate>,
    funds: Option<Funds>,
    now: Instant,
) -> Offer {
    let mut offer = base.clone();
    match rate {
        None => {
            offer.rate_source = Some("fixed".into());
        }
        Some(live) => match live.quote_at(now) {
            Some(q) => {
                offer.rate_sat_per_zec = q.rate;
                offer.rate_source = Some(q.source);
                offer.rate_updated_at = Some(q.updated_at);
                if q.paused {
                    offer.paused = true;
                    offer.making = false;
                }
            }
            None => {
                // no price yet: never quote the fixed fallback as if it were live
                offer.rate_source = Some("waiting for the first price".into());
                offer.paused = true;
                offer.making = false;
            }
        },
    }
    if let Some(f) = funds.filter(|_| base.making) {
        let fillable = match base.role {
            ferry_core::Role::Z => f.zec_shielded_zat,
            ferry_core::Role::B => {
                let spendable = f.btc_sat.saturating_sub(base.terms.btc_fee);
                zat_for(spendable, offer.rate_sat_per_zec)
            }
        };
        // capped at the offer's max, so it says nothing about a balance above it
        offer.liquidity = Some(crate::config::Liquidity {
            zec_zat: fillable.min(base.max_zat),
        });
    }
    offer
}

// The daemon's view of its own offer. Kept here so daemon.rs only calls these.
impl<L: ferry_core::ZecLeg + 'static> crate::daemon::Daemon<L> {
    /// Our offer right now, with liquidity from `balances` when given.
    pub fn offer_with(&self, balances: Option<&crate::view::Balances>) -> Offer {
        let funds = balances.map(|b| Funds {
            zec_shielded_zat: b.zec_shielded_zat,
            btc_sat: b.btc_sat,
        });
        live_offer(&self.offer, self.price.as_deref(), funds, Instant::now())
    }

    /// `GET /peer/offer`: liquidity from the last status refresh's balances.
    pub async fn offer_now(&self) -> Offer {
        let balances = self
            .state
            .lock()
            .await
            .status
            .as_ref()
            .map(|s| s.balances.clone());
        self.offer_with(balances.as_ref())
    }

    /// A proposal's BTC amount matches our rate: the fixed one, or the live one (or the one it
    /// replaced, within the grace period; never while paused).
    pub fn rate_matches(&self, zec_amount: u64, btc_amount: u64) -> bool {
        match &self.price {
            Some(live) => live.amount_matches(zec_amount, btc_amount),
            None => checked_btc_for(zec_amount, self.offer.rate_sat_per_zec) == Some(btc_amount),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Terms;
    use axum::extract::Query;
    use axum::routing::get;
    use axum::{Json, Router};
    use ferry_btc::bitcoin::Network;
    use serde_json::json;
    use std::collections::HashMap;

    fn cfg(sources: Vec<Source>, spread_bps: i32) -> FeedConfig {
        FeedConfig {
            pair: Pair::ZEC_BTC,
            sources,
            spread_bps,
            refresh: REFRESH,
            stale_after: STALE_AFTER,
            grace: GRACE,
        }
    }

    fn offer(role: ferry_core::Role) -> Offer {
        Offer {
            role,
            coin: ferry_btc::Coin::Btc,
            network: Network::Regtest,
            making: true,
            rate_sat_per_zec: 410_000,
            min_zat: 10_000_000,
            max_zat: 1_000_000_000,
            terms: Terms {
                t1: 12,
                t2: 24,
                btc_fee: 2_000,
                btc_lock_confirmations: 2,
                zec_confirmations: 3,
                cancel_confirmations: 1,
                redeem_margin: 3,
                refund_margin: 3,
                keypath: true,
            },
            rate_source: None,
            rate_updated_at: None,
            liquidity: None,
            paused: false,
            quote_key: None,
        }
    }

    #[test]
    fn parses_args() {
        assert_eq!("ZEC/BTC".parse::<Pair>().unwrap(), Pair::ZEC_BTC);
        assert_eq!("zec/ltc".parse::<Pair>().unwrap().quote, Asset::Ltc);
        assert!("ZEC/ZEC".parse::<Pair>().is_err());
        assert!("ZECBTC".parse::<Pair>().is_err());
        assert_eq!(
            "coingecko, kraken".parse::<FeedArg>().unwrap().0,
            vec![SourceKind::CoinGecko, SourceKind::Kraken]
        );
        assert_eq!("all".parse::<FeedArg>().unwrap().0.len(), 2);
        assert!("off".parse::<FeedArg>().unwrap().0.is_empty());
        assert!("binance".parse::<FeedArg>().is_err());
        assert!("".parse::<FeedArg>().is_err());
    }

    #[test]
    fn rate_units_and_spread() {
        // 0.0041 BTC per ZEC = 410000 sat; +50 bps = 412050
        assert_eq!(Pair::ZEC_BTC.rate_units(0.0041, 0), Some(410_000));
        assert_eq!(Pair::ZEC_BTC.rate_units(0.0041, 50), Some(412_050));
        assert_eq!(Pair::ZEC_BTC.rate_units(0.0041, -100), Some(405_900));
        let usdc = "ZEC/USDC".parse::<Pair>().unwrap();
        assert_eq!(usdc.rate_units(52.5, 0), Some(52_500_000));
        assert_eq!(Pair::ZEC_BTC.rate_units(f64::NAN, 0), None);
        assert_eq!(Pair::ZEC_BTC.rate_units(0.0, 0), None);
        // WETH is priced as ETH, in wei: 0.012 ETH per ZEC.
        let weth = "ZEC/WETH".parse::<Pair>().unwrap();
        assert_eq!(weth, "zec/eth".parse::<Pair>().unwrap());
        assert_eq!(weth.quote.decimals(), 18);
        assert_eq!(weth.rate_units(0.012, 0), Some(12_000_000_000_000_000));
        // A rate that does not fit in u64 wei (over ~18.4 ETH per ZEC) is no price at all.
        assert_eq!(weth.rate_units(20.0, 0), None);
    }

    /// At WETH's scale a quote overflows u64 for a large swap: it then matches no amount,
    /// not even u64::MAX, instead of wrapping or saturating into a match.
    #[test]
    fn amount_matching_at_18_decimals() {
        let mut c = cfg(vec![], 0);
        c.pair = "ZEC/ETH".parse().unwrap();
        let live = LiveRate::new(c);
        let t0 = Instant::now();
        live.apply(&[(SourceKind::Kraken, Ok(0.012))], t0, 1);
        let rate = 12_000_000_000_000_000;
        assert_eq!(live.quote_at(t0).unwrap().rate, rate);
        assert!(live.amount_matches_at(100_000_000, rate, t0));
        assert!(!live.amount_matches_at(100_000_000, rate + 1, t0));
        let too_big = 200_000_000_000; // 2000 ZEC = 24 WETH > u64::MAX wei
        assert!(!live.amount_matches_at(too_big, u64::MAX, t0));
    }

    #[test]
    fn parses_feed_answers() {
        let k = json!({"error": [], "result": {"XZECXXBT": {"a": ["1"], "c": ["0.00412", "3.1"]}}});
        assert_eq!(parse_kraken(&k).unwrap(), 0.00412);
        assert!(parse_kraken(&json!({"error": ["EQuery:Unknown asset pair"]})).is_err());
        assert!(parse_kraken(&json!({"error": [], "result": {}})).is_err());
        let now = 1_760_000_000;
        let g = json!({"zcash": {"btc": 0.0041, "last_updated_at": now - 30}});
        assert_eq!(parse_coingecko(&g, "zcash", "btc", now).unwrap(), 0.0041);
        let old = json!({"zcash": {"btc": 0.0041, "last_updated_at": now - 600}});
        assert!(parse_coingecko(&old, "zcash", "btc", now)
            .unwrap_err()
            .contains("old"));
        assert!(parse_coingecko(&json!({"zcash": {"btc": -1.0}}), "zcash", "btc", now).is_err());
    }

    #[test]
    fn median_of_answers() {
        assert_eq!(median(&mut []), None);
        assert_eq!(median(&mut [3.0]), Some(3.0));
        assert_eq!(median(&mut [5.0, 1.0, 3.0]), Some(3.0));
        assert_eq!(median(&mut [4.0, 1.0, 3.0, 2.0]), Some(2.5));
    }

    #[test]
    fn median_ignores_failed_sources_and_pauses_when_all_stale() {
        let live = LiveRate::new(cfg(vec![], 0));
        let t0 = Instant::now();
        assert_eq!(live.quote_at(t0), None);
        live.apply(
            &[
                (SourceKind::Kraken, Ok(0.0040)),
                (SourceKind::CoinGecko, Err("coingecko: timed out".into())),
            ],
            t0,
            1_000,
        );
        let q = live.quote_at(t0).unwrap();
        assert_eq!((q.rate, q.updated_at, q.paused), (400_000, 1_000, false));
        assert_eq!(q.source, "median(kraken)");
        assert!(live.last_error().unwrap().contains("timed out"));

        // every source fails: the old rate stands until it is STALE_AFTER old, then pauses
        let t1 = t0 + Duration::from_secs(60);
        live.apply(
            &[
                (SourceKind::Kraken, Err("x".into())),
                (SourceKind::CoinGecko, Err("y".into())),
            ],
            t1,
            1_060,
        );
        assert!(!live.quote_at(t1).unwrap().paused);
        assert_eq!(live.quote_at(t1).unwrap().updated_at, 1_000);
        let late = t0 + STALE_AFTER + Duration::from_secs(1);
        assert!(live.quote_at(late).unwrap().paused);
        assert!(!live.amount_matches_at(100_000_000, 400_000, late));

        // a source answers again: unpaused
        live.apply(&[(SourceKind::CoinGecko, Ok(0.0042))], late, 1_400);
        let q = live.quote_at(late).unwrap();
        assert_eq!((q.rate, q.paused), (420_000, false));
    }

    #[test]
    fn previous_rate_accepted_during_grace() {
        let live = LiveRate::new(cfg(vec![], 0));
        let t0 = Instant::now();
        live.apply(&[(SourceKind::Kraken, Ok(0.0041))], t0, 1);
        live.apply(&[(SourceKind::Kraken, Ok(0.0042))], t0, 2);
        assert!(live.amount_matches_at(100_000_000, 420_000, t0));
        assert!(live.amount_matches_at(100_000_000, 410_000, t0));
        assert!(!live.amount_matches_at(100_000_000, 400_000, t0));
        let later = t0 + GRACE + Duration::from_secs(1);
        assert!(!live.amount_matches_at(100_000_000, 410_000, later));
        assert!(live.amount_matches_at(100_000_000, 420_000, later));
    }

    #[test]
    fn live_offer_fields() {
        let base = offer(ferry_core::Role::B);
        let funds = Funds {
            zec_shielded_zat: 0,
            btc_sat: 2_002_000,
        };
        // fixed rate: liquidity from B's BTC, less one presigned fee, at the fixed rate
        let o = live_offer(&base, None, Some(funds), Instant::now());
        assert_eq!(o.rate_source.as_deref(), Some("fixed"));
        assert_eq!(
            o.liquidity.unwrap().zec_zat,
            2_000_000 * 100_000_000 / 410_000
        );
        assert!(o.making && !o.paused);

        // live rate, before any price: paused
        let live = LiveRate::new(cfg(vec![], 25));
        let t0 = Instant::now();
        let o = live_offer(&base, Some(&live), Some(funds), t0);
        assert!(o.paused && !o.making);

        live.apply(&[(SourceKind::Kraken, Ok(0.004))], t0, 77);
        let o = live_offer(&base, Some(&live), Some(funds), t0);
        assert_eq!(o.rate_sat_per_zec, 401_000);
        assert_eq!(o.rate_updated_at, Some(77));
        assert_eq!(o.rate_source.as_deref(), Some("median(kraken) +25bps"));
        assert!(o.making);

        // Z maker: its shielded ZEC, capped at the offer's max
        let z = offer(ferry_core::Role::Z);
        let rich = Funds {
            zec_shielded_zat: 50_000_000_000,
            btc_sat: 0,
        };
        assert_eq!(
            live_offer(&z, None, Some(rich), t0)
                .liquidity
                .unwrap()
                .zec_zat,
            z.max_zat
        );

        // the JSON a taker gets
        let v = serde_json::to_value(live_offer(&base, Some(&live), Some(funds), t0)).unwrap();
        assert_eq!(v["rate_updated_at"], 77);
        assert!(v["liquidity"]["zec_zat"].is_u64());
        assert_eq!(v["rate_source"], "median(kraken) +25bps");
    }

    /// A local stand-in for both public APIs. Ports stay in this agent's 7801-7899 range.
    async fn mock_feeds(
        kraken_price: &'static str,
        gecko_price: f64,
        slow: bool,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route(
                "/0/public/Ticker",
                get(move |Query(q): Query<HashMap<String, String>>| async move {
                    if slow {
                        tokio::time::sleep(HTTP_TIMEOUT + Duration::from_secs(2)).await;
                    }
                    match q.get("pair").map(String::as_str) {
                        Some("ZECXBT") => Json(json!({"error": [], "result": {"XZECXXBT": {"c": [kraken_price, "1"]}}})),
                        Some("ZECUSD") => Json(json!({"error": [], "result": {"XZECZUSD": {"c": ["50.0", "1"]}}})),
                        Some("LTCUSD") => Json(json!({"error": [], "result": {"XLTCZUSD": {"c": ["100.0", "1"]}}})),
                        _ => Json(json!({"error": ["EQuery:Unknown asset pair"]})),
                    }
                }),
            )
            .route(
                "/api/v3/simple/price",
                get(move |Query(q): Query<HashMap<String, String>>| async move {
                    let at = unix_now();
                    let vs = q.get("vs_currencies").cloned().unwrap_or_default();
                    Json(json!({"zcash": {vs: gecko_price, "last_updated_at": at}}))
                }),
            );
        for port in 7860..7900u16 {
            if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                let h = tokio::spawn(async move {
                    let _ = axum::serve(l, app).await;
                });
                return (format!("http://127.0.0.1:{port}"), h);
            }
        }
        panic!("no free port in 7860-7899");
    }

    fn sources(url: &str) -> Vec<Source> {
        [SourceKind::Kraken, SourceKind::CoinGecko]
            .into_iter()
            .map(|kind| Source {
                kind,
                base_url: url.into(),
            })
            .collect()
    }

    #[tokio::test]
    async fn refresh_takes_the_median_of_a_mocked_feed() {
        let (url, server) = mock_feeds("0.0040", 0.0042, false).await;
        let live = LiveRate::new(cfg(sources(&url), 100));
        live.refresh(&feed_client().unwrap()).await;
        let q = live.quote().unwrap();
        // median of 0.0040 and 0.0042 = 0.0041, +100 bps = 414100 sat
        assert_eq!(q.rate, 414_100);
        assert_eq!(q.source, "median(kraken,coingecko) +100bps");
        assert!(!q.paused);
        assert!(unix_now() - q.updated_at < 5);

        // ZEC/LTC is not listed on (this mock of) Kraken: crossed through USD, 50 / 100
        let ltc = LiveRate::new(FeedConfig {
            pair: "ZEC/LTC".parse().unwrap(),
            sources: sources(&url)[..1].to_vec(),
            ..cfg(vec![], 0)
        });
        ltc.refresh(&feed_client().unwrap()).await;
        assert_eq!(ltc.quote().unwrap().rate, 50_000_000);
        server.abort();
    }

    #[tokio::test]
    async fn a_slow_or_dead_source_times_out() {
        let (url, server) = mock_feeds("0.0040", 0.0042, true).await;
        let mut srcs = sources(&url);
        // and one that refuses connections
        srcs.push(Source {
            kind: SourceKind::CoinGecko,
            base_url: "http://127.0.0.1:1".into(),
        });
        let live = LiveRate::new(cfg(srcs, 0));
        let started = Instant::now();
        live.refresh(&feed_client().unwrap()).await;
        assert!(started.elapsed() < HTTP_TIMEOUT + Duration::from_secs(3));
        // only the (fast) CoinGecko route answered
        let q = live.quote().unwrap();
        assert_eq!(q.rate, 420_000);
        assert_eq!(q.source, "median(coingecko)");
        assert!(live.last_error().unwrap().contains("kraken"));
        server.abort();
    }
}
