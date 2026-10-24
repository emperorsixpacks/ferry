//! The ferryd control-API contract the router relies on (spec section 6), in one place.
//!
//! The router only ever talks to the user's own daemons through [`Ferryd`]: read the status,
//! read the shielded receive address, list or read swaps, and start a swap. [`HttpFerryd`] is the
//! real client; tests use a fake. Everything ferryd must provide for routes (step 1 of the spec)
//! is named here:
//!
//! - `POST /api/swaps` takes, besides `{maker, zec_zat}`:
//!   - `route`: an opaque label (`[a-z0-9/-]`, at most 80 chars), stored in the swap record
//!     before the first save and shown as `SwapView.route`;
//!   - `sweep_to`: role B only, the shielded address leg 1's sweep pays;
//!   - `max_counter` (role B) / `min_counter` (role Z): refuse to start if the maker's rate means
//!     paying more / receiving fewer counter units for `zec_zat`.
//!
//!   An error status means no swap was created; `201 {id}` means it was.
//! - `GET /api/swaps` and `GET /api/swaps/:id` return `route` and `sweep_to`.
//! - `GET /api/status` lists [`ROUTE_FEATURE`] in `features`. Today's ferryd silently ignores
//!   unknown body fields (`crates/ferryd/src/http.rs:144-148` has no `deny_unknown_fields`), so
//!   without this marker a route posted to an older daemon would start a leg that sweeps to the
//!   wrong wallet, has no price limit and carries no label to find it again after a restart.
//!   The router refuses to start a leg on a daemon that does not advertise it.
//! - `GET /api/addresses` returns the wallet's own shielded address as `zec.address`.

use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// What `/api/status` must list in `features` before the router starts a leg there.
pub const ROUTE_FEATURE: &str = "route";

/// Swap party: `Z` holds shielded ZEC and wants the counter coin, `B` the reverse.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
pub enum Role {
    Z,
    #[default]
    B,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Z => "Z",
            Role::B => "B",
        }
    }
}

/// The pairs a UI can name, as in `web/server/pairs.mjs` (`btc`, `ltc`, `usdc-base`, ...).
const TOKENS: [&str; 2] = ["usdc", "weth"];
const EVM_CHAINS: [&str; 4] = ["base", "ethereum", "arbitrum", "optimism"];

/// `btc`, `ltc`, or `<token>-<chain>` for an ERC-20 on an EVM chain.
pub fn is_pair(id: &str) -> bool {
    matches!(id, "btc" | "ltc") || evm_pair(id).is_some()
}

/// `usdc-base` → `("usdc", "base")`.
fn evm_pair(id: &str) -> Option<(&str, &str)> {
    let (token, chain) = id.split_once('-')?;
    (TOKENS.contains(&token) && EVM_CHAINS.contains(&chain)).then_some((token, chain))
}

/// The asset a pair swaps against ZEC, whatever chain carries it: USDC on Base and USDC on
/// Arbitrum are the same asset, so a route between them is refused.
pub fn asset(pair: &str) -> &str {
    evm_pair(pair).map_or(pair, |(token, _)| token)
}

/// What the router needs from `GET /api/status` (both daemon types).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DaemonStatus {
    pub role: Role,
    pub name: String,
    /// `chains.btc.coin`: `btc`, `ltc`, or the token symbol in lowercase (`usdc`).
    pub coin: String,
    /// `chains.btc.network`: `regtest`, `signet`, `anvil`, `base-sepolia`, ...
    pub network: String,
    /// An EVM daemon (`counter.kind == "evm"`).
    pub evm: bool,
    pub ticker: String,
    pub decimals: u8,
    pub zec_network: String,
    pub zec_height: u64,
    /// `balances.zec_shielded_zat`: devtool's "Ironwood Spendable" balance, the figure ferryd's
    /// own `check_funds` uses before a Z swap.
    pub spendable_zat: u64,
    pub features: Vec<String>,
}

impl DaemonStatus {
    pub fn from_json(v: &serde_json::Value) -> Result<DaemonStatus, String> {
        #[derive(Deserialize)]
        struct Raw {
            role: Role,
            #[serde(default)]
            name: String,
            balances: Balances,
            chains: Chains,
            #[serde(default)]
            counter: Option<Counter>,
            #[serde(default)]
            features: Vec<String>,
        }
        #[derive(Deserialize)]
        struct Balances {
            zec_shielded_zat: u64,
        }
        #[derive(Deserialize)]
        struct Chains {
            btc: CounterChain,
            zec: ZecChain,
        }
        #[derive(Deserialize)]
        struct CounterChain {
            coin: String,
            network: String,
            #[serde(default)]
            ticker: String,
            #[serde(default)]
            decimals: Option<u8>,
        }
        #[derive(Deserialize)]
        struct ZecChain {
            network: String,
            height: u64,
        }
        #[derive(Deserialize)]
        struct Counter {
            kind: String,
        }
        let raw = Raw::deserialize(v).map_err(|e| format!("unexpected /api/status: {e}"))?;
        let coin = raw.chains.btc.coin.to_ascii_lowercase();
        Ok(DaemonStatus {
            role: raw.role,
            name: raw.name,
            ticker: if raw.chains.btc.ticker.is_empty() {
                coin.to_ascii_uppercase()
            } else {
                raw.chains.btc.ticker
            },
            coin,
            network: raw.chains.btc.network,
            evm: raw.counter.is_some_and(|c| c.kind == "evm"),
            // Bitcoin and Litecoin daemons leave decimals out: both count in 10^-8.
            decimals: raw.chains.btc.decimals.unwrap_or(8),
            zec_network: raw.chains.zec.network,
            zec_height: raw.chains.zec.height,
            spendable_zat: raw.balances.zec_shielded_zat,
            features: raw.features,
        })
    }
}

/// Whether `status` is the daemon configured for (`pair`, `role`) and speaks the route contract.
pub fn verify(status: &DaemonStatus, pair: &str, role: Role) -> Result<(), String> {
    if status.role != role {
        return Err(format!(
            "the {pair} daemon has role {}, the route needs role {}",
            status.role.as_str(),
            role.as_str()
        ));
    }
    match evm_pair(pair) {
        None => {
            if status.evm || status.coin != pair {
                return Err(format!(
                    "the daemon configured for {pair} swaps {}",
                    status.coin
                ));
            }
        }
        Some((token, chain)) => {
            if !status.evm || status.coin != token {
                return Err(format!(
                    "the daemon configured for {pair} swaps {}{}",
                    status.coin,
                    if status.evm {
                        ""
                    } else {
                        " (not an EVM daemon)"
                    }
                ));
            }
            // The network name comes from the chain id (crates/ferryd/src/evm/config.rs:240):
            // the chain itself, its testnet ("base-sepolia"), or a local/unlisted test chain.
            let n = status.network.as_str();
            let same_chain = n == chain
                || n.strip_prefix(chain)
                    .is_some_and(|rest| rest.starts_with('-'))
                || (chain == "ethereum" && n == "sepolia")
                || n == "anvil"
                || n.starts_with("evm-");
            if !same_chain {
                return Err(format!(
                    "the daemon configured for {pair} runs on {}",
                    status.network
                ));
            }
        }
    }
    if !status.features.iter().any(|f| f == ROUTE_FEATURE) {
        return Err(format!(
            "the {pair} daemon does not support routes (its /api/status lacks features: [\"{ROUTE_FEATURE}\"]); \
             it would ignore sweep_to, the route label and the price limit"
        ));
    }
    Ok(())
}

/// One timeline entry of a swap, as far as the router reads it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SwapEntry {
    #[serde(default)]
    pub at: String,
    pub kind: String,
    #[serde(default)]
    pub txid: Option<String>,
    #[serde(default)]
    pub height: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SwapAmounts {
    pub zec_zat: u64,
    /// Counter-chain base units (sats, litoshis, or the token's smallest unit).
    pub btc_sat: u64,
}

/// What the router reads of a ferryd `SwapView` (both daemon types).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LegSwap {
    pub id: String,
    pub role: Role,
    #[serde(default)]
    pub counterparty: String,
    pub state: String,
    #[serde(default)]
    pub outcome: Option<String>,
    pub amounts: SwapAmounts,
    #[serde(default)]
    pub timeline: Vec<SwapEntry>,
    #[serde(default)]
    pub watchtower: Option<serde_json::Value>,
    /// Step 1: the label given at creation.
    #[serde(default)]
    pub route: Option<String>,
    /// Step 1: where B's sweep pays (role B; None = the daemon's own wallet).
    #[serde(default)]
    pub sweep_to: Option<String>,
}

impl LegSwap {
    /// Final with no outcome: called off before anything was locked (negotiation timeout, or an
    /// EVM lock that never landed). Every other final state has an outcome
    /// (`crates/ferryd/src/record.rs:201-208`, `evm/record.rs:253-260`).
    pub fn aborted(&self) -> bool {
        self.state == "Aborted"
    }

    /// B: the maker took the counter coin, so the key is ours and the ZEC is (being) swept:
    /// `BtcRedeemed` on Bitcoin/Litecoin, `Claimed` on EVM. Nothing can undo it.
    pub fn redeemed(&self) -> bool {
        self.role == Role::B && matches!(self.state.as_str(), "BtcRedeemed" | "Claimed")
    }

    /// The latest broadcast of B's sweep: (txid, mined height). A sweep that expired unmined is
    /// followed by a new `zec_sweep_broadcast` entry.
    pub fn sweep(&self) -> Option<(String, Option<u64>)> {
        self.timeline
            .iter()
            .rev()
            .find(|e| e.kind == "zec_sweep_broadcast")
            .and_then(|e| e.txid.clone().map(|t| (t, e.height)))
    }

    /// Z swept its ZEC lock back to its own wallet (two Ironwood fees spent).
    pub fn reclaimed(&self) -> bool {
        self.role == Role::Z && self.state == "ZecReclaimed"
    }
}

/// `POST /api/swaps` body (spec section 6).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartSwap {
    pub maker: String,
    pub zec_zat: u64,
    pub route: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sweep_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max_counter: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub min_counter: Option<u64>,
}

/// A read from a daemon failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegError {
    /// No answer (connection refused, timeout).
    Unreachable(String),
    /// An error status, with ferryd's `{"error": ...}` text.
    Status(u16, String),
    /// An answer the router cannot read.
    Invalid(String),
}

impl std::fmt::Display for LegError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LegError::Unreachable(e) => write!(f, "unreachable: {e}"),
            LegError::Status(code, e) => write!(f, "{code}: {e}"),
            LegError::Invalid(e) => write!(f, "unexpected answer: {e}"),
        }
    }
}

/// Starting a swap failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StartError {
    /// ferryd answered with an error status: no swap was created. 409: a swap is already in
    /// progress there; 400: refused (maker's terms, amount, funds, price limit); 502: the maker
    /// could not be reached or refused; 503: a wallet or node is down.
    Refused { status: u16, message: String },
    /// No usable answer: the swap may or may not exist. Only a lookup by label can tell.
    Unknown(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Refused { status, message } => write!(f, "{message} ({status})"),
            StartError::Unknown(e) => write!(f, "no answer ({e})"),
        }
    }
}

/// One ferryd control API.
pub trait Ferryd: Send + Sync + 'static {
    fn status(&self) -> impl Future<Output = Result<DaemonStatus, LegError>> + Send;
    /// `GET /api/addresses` → `zec.address` (None: this wallet cannot say).
    fn zec_address(&self) -> impl Future<Output = Result<Option<String>, LegError>> + Send;
    fn swaps(&self) -> impl Future<Output = Result<Vec<LegSwap>, LegError>> + Send;
    fn swap(&self, id: &str) -> impl Future<Output = Result<LegSwap, LegError>> + Send;
    /// `POST /api/swaps` → the new swap's id.
    fn start(&self, req: &StartSwap) -> impl Future<Output = Result<String, StartError>> + Send;
}

/// The swap carrying `label`, if the daemon has one. Several (which the router never causes)
/// prefer one still running, then the latest listed.
pub fn find_labelled(swaps: Vec<LegSwap>, label: &str) -> Option<LegSwap> {
    let mut found: Vec<LegSwap> = swaps
        .into_iter()
        .filter(|s| s.route.as_deref() == Some(label))
        .collect();
    let running = found
        .iter()
        .position(|s| s.outcome.is_none() && !s.aborted());
    match running {
        Some(i) => Some(found.swap_remove(i)),
        None => found.pop(),
    }
}

/// The real client: bearer token, short timeouts for reads, a long one for starting a swap
/// (ferryd contacts the maker and funds the lock before it answers).
#[derive(Clone)]
pub struct HttpFerryd {
    base: String,
    token: String,
    http: reqwest::Client,
    start_timeout: Duration,
}

impl HttpFerryd {
    pub fn new(base: &str, token: String) -> anyhow::Result<HttpFerryd> {
        Ok(HttpFerryd {
            base: base.trim_end_matches('/').to_string(),
            token,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()?,
            start_timeout: Duration::from_secs(120),
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    async fn get(&self, path: &str) -> Result<serde_json::Value, LegError> {
        let resp = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| LegError::Unreachable(e.without_url().to_string()))?;
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| LegError::Unreachable(e.without_url().to_string()))?;
        let body = serde_json::from_slice::<serde_json::Value>(&bytes);
        if !status.is_success() {
            let body = body.unwrap_or_default();
            return Err(LegError::Status(status.as_u16(), error_text(&body)));
        }
        body.map_err(|e| LegError::Invalid(e.to_string()))
    }
}

/// ferryd's `{"error": "..."}` text.
fn error_text(body: &serde_json::Value) -> String {
    body["error"].as_str().unwrap_or("error").to_string()
}

impl Ferryd for HttpFerryd {
    async fn status(&self) -> Result<DaemonStatus, LegError> {
        DaemonStatus::from_json(&self.get("/api/status").await?).map_err(LegError::Invalid)
    }

    async fn zec_address(&self) -> Result<Option<String>, LegError> {
        let v = self.get("/api/addresses").await?;
        Ok(v["zec"]["address"]
            .as_str()
            .filter(|a| !a.is_empty())
            .map(str::to_string))
    }

    async fn swaps(&self) -> Result<Vec<LegSwap>, LegError> {
        serde_json::from_value(self.get("/api/swaps").await?)
            .map_err(|e| LegError::Invalid(e.to_string()))
    }

    async fn swap(&self, id: &str) -> Result<LegSwap, LegError> {
        if !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(LegError::Invalid(format!("bad swap id {id:?}")));
        }
        serde_json::from_value(self.get(&format!("/api/swaps/{id}")).await?)
            .map_err(|e| LegError::Invalid(e.to_string()))
    }

    async fn start(&self, req: &StartSwap) -> Result<String, StartError> {
        let resp = self
            .http
            .post(format!("{}/api/swaps", self.base))
            .bearer_auth(&self.token)
            .timeout(self.start_timeout)
            .json(req)
            .send()
            .await
            .map_err(|e| StartError::Unknown(e.without_url().to_string()))?;
        let status = resp.status();
        // Read as text first: an unreadable 201 still means a swap exists.
        let text = resp
            .text()
            .await
            .map_err(|e| StartError::Unknown(e.without_url().to_string()))?;
        let body: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        if status.is_success() {
            return body["id"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| StartError::Unknown(format!("{status} without an id")));
        }
        Err(StartError::Refused {
            status: status.as_u16(),
            message: error_text(&body),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn btc_status() -> serde_json::Value {
        json!({
            "role": "B", "name": "user-b",
            "balances": {"zec_shielded_zat": 0, "btc_sat": 100},
            "chains": {"btc": {"coin": "btc", "ticker": "BTC", "network": "regtest", "height": 7},
                       "zec": {"network": "regtest", "height": 42, "pool": "ironwood"}},
            "offer": {"pair": "ZEC/BTC"},
            "features": ["route"]
        })
    }

    fn evm_status() -> serde_json::Value {
        json!({
            "role": "Z", "name": "user-z",
            "balances": {"zec_shielded_zat": 123, "btc_sat": 0, "token_units": "0", "eth_wei": "0"},
            "chains": {"btc": {"coin": "usdc", "ticker": "USDC", "decimals": 6, "network": "anvil",
                               "height": 9, "time": 1},
                       "zec": {"network": "regtest", "height": 43, "pool": "ironwood"}},
            "offer": {"pair": "ZEC/USDC"},
            "counter": {"kind": "evm", "chain_id": 31337},
            "features": ["route"]
        })
    }

    #[test]
    fn pairs_and_assets() {
        assert!(
            is_pair("btc") && is_pair("ltc") && is_pair("usdc-base") && is_pair("weth-arbitrum")
        );
        assert!(
            !is_pair("zec") && !is_pair("usdc") && !is_pair("usdc-solana") && !is_pair("dai-base")
        );
        assert_eq!(asset("usdc-base"), "usdc");
        assert_eq!(asset("usdc-arbitrum"), asset("usdc-base"));
        assert_eq!(asset("btc"), "btc");
    }

    #[test]
    fn reads_both_status_shapes() {
        let b = DaemonStatus::from_json(&btc_status()).unwrap();
        assert_eq!(
            (b.role, b.coin.as_str(), b.evm, b.decimals),
            (Role::B, "btc", false, 8)
        );
        assert_eq!((b.zec_height, b.spendable_zat), (42, 0));
        let z = DaemonStatus::from_json(&evm_status()).unwrap();
        assert_eq!(
            (z.role, z.coin.as_str(), z.evm, z.decimals),
            (Role::Z, "usdc", true, 6)
        );
        assert_eq!((z.ticker.as_str(), z.spendable_zat), ("USDC", 123));
        assert!(DaemonStatus::from_json(&json!({"role": "B"})).is_err());
    }

    #[test]
    fn verify_checks_role_pair_and_contract() {
        let b = DaemonStatus::from_json(&btc_status()).unwrap();
        assert_eq!(verify(&b, "btc", Role::B), Ok(()));
        assert!(verify(&b, "btc", Role::Z).unwrap_err().contains("role B"));
        assert!(verify(&b, "ltc", Role::B).is_err());
        assert!(verify(&b, "usdc-base", Role::B).is_err());
        let z = DaemonStatus::from_json(&evm_status()).unwrap();
        assert_eq!(
            verify(&z, "usdc-base", Role::Z),
            Ok(()),
            "anvil stands in for any chain"
        );
        assert!(verify(&z, "weth-base", Role::Z).is_err());
        assert!(verify(&z, "btc", Role::Z).is_err());
        let on = |network: &str| DaemonStatus {
            network: network.into(),
            ..z.clone()
        };
        assert_eq!(verify(&on("base-sepolia"), "usdc-base", Role::Z), Ok(()));
        assert_eq!(verify(&on("base"), "usdc-base", Role::Z), Ok(()));
        assert!(verify(&on("arbitrum-sepolia"), "usdc-base", Role::Z).is_err());
        assert!(verify(&on("baseline"), "usdc-base", Role::Z).is_err());
        // A daemon from before step 1 would ignore sweep_to, the label and the price limit.
        let old = DaemonStatus {
            features: vec![],
            ..b
        };
        assert!(verify(&old, "btc", Role::B)
            .unwrap_err()
            .contains("does not support routes"));
    }

    #[test]
    fn reads_a_swap_view_and_its_sweep() {
        let v = json!({
            "id": "ab01", "coin": "btc", "role": "B", "counterparty": "http://m", "state": "ZecSwept",
            "outcome": "swapped", "amounts": {"zec_zat": 5, "btc_sat": 6},
            "timeline": [
                {"at": "t", "chain": "zec", "kind": "zec_sweep_broadcast", "label": "x", "txid": "old", "height": null},
                {"at": "t", "chain": "zec", "kind": "zec_sweep_expired", "label": "x", "txid": null, "height": null},
                {"at": "t", "chain": "zec", "kind": "zec_sweep_broadcast", "label": "x", "txid": "new", "height": 40}
            ],
            "watchtower": null, "route": "r1/1", "sweep_to": "utest1x", "keys": {}, "observer": {}
        });
        let s: LegSwap = serde_json::from_value(v).unwrap();
        assert_eq!(s.sweep(), Some(("new".into(), Some(40))));
        assert_eq!(s.route.as_deref(), Some("r1/1"));
        assert!(!s.redeemed() && !s.aborted());
    }

    #[test]
    fn finds_the_labelled_swap() {
        let s = |id: &str, label: Option<&str>, outcome: Option<&str>| LegSwap {
            id: id.into(),
            route: label.map(Into::into),
            outcome: outcome.map(Into::into),
            state: "x".into(),
            ..LegSwap::default()
        };
        assert_eq!(
            find_labelled(vec![s("a", None, None), s("b", Some("r/2"), None)], "r/1"),
            None
        );
        let list = vec![
            s("a", Some("r/1"), Some("refunded")),
            s("b", Some("r/1"), None),
            s("c", Some("r/2"), None),
        ];
        assert_eq!(find_labelled(list, "r/1").unwrap().id, "b");
    }

    #[test]
    fn start_body_leaves_out_unset_limits() {
        let body = serde_json::to_value(StartSwap {
            maker: "http://m".into(),
            zec_zat: 9,
            route: "r1/2".into(),
            min_counter: Some(4),
            ..StartSwap::default()
        })
        .unwrap();
        assert_eq!(
            body,
            json!({"maker": "http://m", "zec_zat": 9, "route": "r1/2", "min_counter": 4})
        );
    }
}
