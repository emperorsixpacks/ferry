//! Real `ferryd --counter evm` processes against an anvil whose blocks come slowly (interval
//! mining, no automine), so a lock (approve + lock, each waiting for its receipt) takes several
//! seconds, as it can on a public chain.
//!
//! - A B maker must answer a proposal at once and lock afterwards: a taker that gives up waiting
//!   must never leave a lock on chain that the running maker doesn't track. The maker keeps the
//!   swap, refuses a second proposal while it runs, and refunds at t1 when the taker never locks.
//! - Buying ZEC on EVM: a B taker's POST /api/swaps returns at once, its lock goes out from the
//!   tick loop, and the swap with a Z maker completes.
//!
//! Each test spawns its own anvil (from PATH or ~/.foundry/bin) and daemons on ports the OS picks,
//! and kills them by their own child handles. Without anvil the tests print a note and pass.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use ferry_core::evm::{EvmParams, EvmProposal, ANVIL_CHAIN_ID};
use ferry_core::Role;
use ferry_evm::bindings::{FerryLock, MockUSDC};
use ferry_evm::{Address, EvmClient, PrivateKeySigner, B256, U256};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};

const TOKEN: &str = "evm-it-token";
const RATE: u64 = 40_000_000; // 40 USDC per ZEC
const T1_SECS: u64 = 120;
// anvil's well-known test accounts (its default mnemonic): 0 deploys, 1 is B, 2 is Z
const KEY_DEPLOYER: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY_B: &str = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const KEY_Z: &str = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

fn anvil_binary() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join("anvil"))
            .find(|p| p.is_file())
    });
    on_path.or_else(|| {
        let p = PathBuf::from(std::env::var_os("HOME")?).join(".foundry/bin/anvil");
        p.is_file().then_some(p)
    })
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn signer(hex_key: &str) -> PrivateKeySigner {
    let b: [u8; 32] = hex::decode(hex_key).unwrap().try_into().unwrap();
    PrivateKeySigner::from_bytes(&B256::from(b)).unwrap()
}

/// A child process killed (by its own handle) when dropped.
struct Proc(Child);

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Chain {
    _anvil: Proc,
    url: String,
    deployer: EvmClient,
    lock: Address,
    usdc: Address,
    dir: tempfile::TempDir,
}

impl Chain {
    /// anvil with automine for the setup: FerryLock and MockUSDC deployed, 1000 USDC minted to B.
    async fn start() -> Option<Chain> {
        let Some(bin) = anvil_binary() else {
            eprintln!("SKIP: no anvil binary (install with foundryup)");
            return None;
        };
        let port = free_port();
        let anvil = Proc(
            Command::new(bin)
                .args([
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                    "--silent",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn anvil"),
        );
        let url = format!("http://127.0.0.1:{port}");
        let deployer = EvmClient::connect_http(&url, Address::ZERO, signer(KEY_DEPLOYER)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while deployer.chain_id().await.is_err() {
            assert!(Instant::now() < deadline, "anvil did not come up");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let p = deployer.provider();
        let usdc = *MockUSDC::deploy(p).await.unwrap().address();
        let lock = *FerryLock::deploy(p).await.unwrap().address();
        MockUSDC::new(usdc, p)
            .mint(signer(KEY_B).address(), U256::from(1_000_000_000u64))
            .send()
            .await
            .unwrap()
            .get_receipt()
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        for (name, key) in [("b.key", KEY_B), ("z.key", KEY_Z)] {
            std::fs::write(dir.path().join(name), key).unwrap();
        }
        Some(Chain {
            _anvil: anvil,
            url,
            deployer,
            lock,
            usdc,
            dir,
        })
    }

    /// One of anvil's own JSON-RPC methods.
    async fn rpc(&self, method: &str, params: Value) {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let r: Value = reqwest::Client::new()
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(r.get("error").is_none(), "{method}: {r}");
    }

    /// From now on a block every `secs` seconds and none in between: every transaction waits
    /// for the next one.
    async fn slow_blocks(&self, secs: u64) {
        self.rpc("evm_setAutomine", json!([false])).await;
        self.rpc("evm_setIntervalMining", json!([secs])).await;
    }

    /// The next block at time `ts`, mined now (then blocks come as before).
    async fn warp(&self, ts: u64) {
        self.rpc("evm_setNextBlockTimestamp", json!([ts])).await;
        self.rpc("evm_mine", json!([])).await;
    }

    async fn usdc_of(&self, key: &str) -> U256 {
        self.usdc_at(signer(key).address()).await
    }

    async fn usdc_at(&self, who: Address) -> U256 {
        self.deployer.token_balance(self.usdc, who).await.unwrap()
    }

    /// A ferryd for this chain; `extra` adds the role's own flags.
    fn ferryd(&self, role: &str, name: &str, key: &str, extra: &[&str]) -> Daemon {
        let (api, peer) = (free_port(), free_port());
        let log = std::fs::File::create(self.dir.path().join(format!("{name}.log"))).unwrap();
        let mut args: Vec<String> = [
            "--counter",
            "evm",
            "--role",
            role,
            "--name",
            name,
            "--api-listen",
            &format!("127.0.0.1:{api}"),
            "--listen",
            &format!("127.0.0.1:{peer}"),
            "--api-token",
            TOKEN,
            "--data-dir",
            self.dir.path().join(name).to_str().unwrap(),
            "--dev-policy",
            "--evm-rpc",
            &self.url,
            "--evm-contract",
            &format!("{:#x}", self.lock),
            "--evm-token",
            &format!("{:#x}", self.usdc),
            "--evm-token-symbol",
            "USDC",
            "--evm-token-decimals",
            "6",
            "--evm-key-file",
            self.dir.path().join(key).to_str().unwrap(),
            "--evm-t1-secs",
            &T1_SECS.to_string(),
            "--evm-refund-secs",
            "120",
            "--evm-delta-secs",
            "15",
            "--evm-lock-confs",
            "1",
            "--zec-confs",
            "1",
            "--zec",
            "mock",
            "--zec-mock-file",
            self.dir.path().join("zec-chain.json").to_str().unwrap(),
            "--zec-mock-block-secs",
            "0.5",
            "--sweep-delay-secs",
            "0:1",
            "--poll-ms",
            "250",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        args.extend(extra.iter().map(|s| s.to_string()));
        let child = Command::new(env!("CARGO_BIN_EXE_ferryd"))
            .args(&args)
            .env("RUST_LOG", "ferryd=debug")
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .expect("spawn ferryd");
        Daemon {
            _proc: Proc(child),
            api: format!("http://127.0.0.1:{api}"),
            peer: format!("http://127.0.0.1:{peer}"),
            log: self.dir.path().join(format!("{name}.log")),
        }
    }
}

struct Daemon {
    _proc: Proc,
    api: String,
    peer: String,
    log: PathBuf,
}

/// Reads may wait while the daemon's tick holds its state through a slow transaction.
fn api_client() -> reqwest::Client {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::AUTHORIZATION,
        format!("Bearer {TOKEN}").parse().unwrap(),
    );
    reqwest::Client::builder()
        .default_headers(h)
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap()
}

fn tail(path: &Path) -> String {
    let s = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = s.lines().collect();
    lines[lines.len().saturating_sub(30)..].join("\n")
}

impl Daemon {
    async fn ready(&self, http: &reqwest::Client) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(r) = http.get(format!("{}/api/status", self.api)).send().await {
                if r.status().is_success() {
                    return;
                }
            }
            assert!(
                Instant::now() < deadline,
                "ferryd did not come up\n{}",
                tail(&self.log)
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn swap(&self, http: &reqwest::Client, id: &str) -> Value {
        http.get(format!("{}/api/swaps/{id}", self.api))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    /// Poll until `done` holds for the swap's view.
    async fn until(
        &self,
        http: &reqwest::Client,
        id: &str,
        secs: u64,
        what: &str,
        done: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let v = self.swap(http, id).await;
            if done(&v) {
                return v;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {} {}\n{}",
                v["state"],
                v["timeline"]
                    .as_array()
                    .map(|t| t
                        .iter()
                        .map(|e| e["kind"].as_str().unwrap_or(""))
                        .collect::<Vec<_>>()
                        .join(","))
                    .unwrap_or_default(),
                tail(&self.log)
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

/// A Z taker's Propose for `zec_zat` at the maker's offer, built as ferryd's create_swap does.
async fn propose(chain: &Chain, offer: &Value, sid: [u8; 32], zec_zat: u64) -> Value {
    let now = chain.deployer.latest_timestamp().await.unwrap();
    let t = &offer["terms"];
    let t1 = now + t["t1_secs"].as_u64().unwrap();
    let params = EvmParams {
        chain_id: ANVIL_CHAIN_ID,
        contract: chain.lock.0 .0,
        token: chain.usdc.0 .0,
        token_amount: (u128::from(zec_zat) * u128::from(RATE) / 100_000_000) as u64,
        token_symbol: "USDC".into(),
        token_decimals: 6,
        zec_amount: zec_zat,
        t1,
        t2: t1 + t["refund_secs"].as_u64().unwrap(),
        claim_margin: t["claim_margin"].as_u64().unwrap(),
        refund_margin: t["refund_margin"].as_u64().unwrap(),
        lock_confirmations: t["lock_confirmations"].as_u64().unwrap() as u32,
        zec_confirmations: t["zec_confirmations"].as_u64().unwrap() as u32,
        max_tip: 0,
    };
    let z = signer(KEY_Z).address().0 .0;
    let (_, env) = EvmProposal::new(&mut OsRng, sid, Role::Z, params, z).unwrap();
    json!({"envelope": env, "taker_url": "http://127.0.0.1:1"})
}

/// A B maker whose lock takes several blocks answers the proposal at once (a taker waiting
/// 2 s gets its Accept), keeps the swap in memory, refuses a second proposal while it runs,
/// locks from the tick loop, and refunds at t1 when the taker never locks ZEC.
#[tokio::test]
async fn slow_lock_maker_answers_at_once_and_still_refunds() {
    let Some(chain) = Chain::start().await else {
        return;
    };
    let http = api_client();
    let maker = chain.ferryd("b", "bram", "b.key", &["--maker-offer", &format!("{RATE}")]);
    maker.ready(&http).await;
    let before = chain.usdc_of(KEY_B).await;
    let offer: Value = http
        .get(format!("{}/peer/offer", maker.peer))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(offer["role"], "B");
    chain.slow_blocks(4).await;

    // The taker gives up after 2 s; approve + lock need at least two 4 s blocks.
    let mut sid = [0u8; 32];
    OsRng.fill_bytes(&mut sid);
    let id = hex::encode(sid);
    let impatient = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let started = Instant::now();
    let r = impatient
        .post(format!("{}/peer/swaps", maker.peer))
        .json(&propose(&chain, &offer, sid, 100_000_000).await)
        .send()
        .await
        .unwrap_or_else(|e| {
            panic!(
                "the maker kept the taker waiting: {e}\n{}",
                tail(&maker.log)
            )
        });
    assert_eq!(
        r.status().as_u16(),
        201,
        "{}",
        r.text().await.unwrap_or_default()
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    let accept: Value = r.json().await.unwrap();
    assert_eq!(accept["message"]["type"], "accept");

    // The maker tracks the swap in memory, and takes no second one while it runs.
    let v = maker.swap(&http, &id).await;
    assert_eq!(
        (v["role"].as_str(), v["taker"].as_bool()),
        (Some("B"), Some(false)),
        "{v}"
    );
    let mut sid2 = [0u8; 32];
    OsRng.fill_bytes(&mut sid2);
    let r = http
        .post(format!("{}/peer/swaps", maker.peer))
        .json(&propose(&chain, &offer, sid2, 100_000_000).await)
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.status().as_u16(),
        409,
        "{}",
        r.text().await.unwrap_or_default()
    );

    // The lock lands from the tick loop.
    let v = maker
        .until(&http, &id, 60, "B's lock", |v| v["state"] == "Locked")
        .await;
    let t1 = v["deadlines"]["t1_unix"].as_u64().unwrap();
    assert!(chain.usdc_of(KEY_B).await < before, "the tokens are locked");

    // No ZEC ever comes: at t1 B refunds, and has its tokens back.
    chain.warp(t1 + 1).await;
    maker
        .until(&http, &id, 60, "B's refund", |v| v["outcome"] == "refunded")
        .await;
    assert_eq!(chain.usdc_of(KEY_B).await, before);
}

/// Buying ZEC on EVM: the B taker's start returns at once (its lock goes out from the tick
/// loop), and the swap with a Z maker completes on a chain with 2 s blocks.
#[tokio::test]
async fn buy_zec_b_taker_with_a_z_maker() {
    let Some(chain) = Chain::start().await else {
        return;
    };
    let http = api_client();
    let maker = chain.ferryd(
        "z",
        "zoe",
        "z.key",
        &[
            "--maker-offer",
            &format!("{RATE}"),
            "--zec-mock-balance",
            "500000000",
        ],
    );
    let taker = chain.ferryd("b", "bram", "b.key", &[]);
    maker.ready(&http).await;
    taker.ready(&http).await;
    let offer: Value = http
        .get(format!("{}/peer/offer", maker.peer))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        (offer["role"].as_str(), offer["making"].as_bool()),
        (Some("Z"), Some(true))
    );
    let z_before = chain.usdc_of(KEY_Z).await;
    chain.slow_blocks(2).await;

    let started = Instant::now();
    let r = http
        .post(format!("{}/api/swaps", taker.api))
        .json(&json!({"maker": maker.peer, "zec_zat": 100_000_000}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.status().as_u16(),
        201,
        "{}",
        r.text().await.unwrap_or_default()
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the start waited for the chain: {:?}",
        started.elapsed()
    );
    let id = r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let b = taker
        .until(&http, &id, 120, "the swap", |v| v["outcome"] == "swapped")
        .await;
    assert_eq!(
        (b["role"].as_str(), b["taker"].as_bool()),
        (Some("B"), Some(true))
    );
    let z = maker
        .until(&http, &id, 30, "Z's side", |v| v["outcome"] == "swapped")
        .await;
    assert_eq!(z["taker"].as_bool(), Some(false));
    assert_eq!(
        chain.usdc_of(KEY_Z).await - z_before,
        U256::from(RATE),
        "Z received 40 USDC for 1 ZEC"
    );
}

// ---------------------------------------------------------------- route legs (crate::route)

/// The mock chain's address of `owner`'s wallet (crates/ferryd/src/mock_zec.rs).
fn mock_wallet(owner: &str) -> String {
    format!("uregtest1mockwallet{}", hex::encode(owner))
}

/// A wallet's shielded balance on the test's mock Zcash chain.
fn mock_balance(chain: &Chain, owner: &str) -> u64 {
    let raw = std::fs::read_to_string(chain.dir.path().join("zec-chain.json")).unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    v["balances"][owner].as_u64().unwrap_or(0)
}

/// Forwards every request to `target`, holding `POST /peer/swaps` back for `delay`: a maker
/// that takes its time, so a start stays in progress.
async fn slow_maker(target: String, delay: Duration) -> String {
    use axum::extract::{Request, State};
    use axum::response::{IntoResponse, Response};
    async fn forward(State((target, delay)): State<(String, Duration)>, req: Request) -> Response {
        let (parts, body) = req.into_parts();
        let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
        if parts.method == reqwest::Method::POST && parts.uri.path() == "/peer/swaps" {
            tokio::time::sleep(delay).await;
        }
        let path = parts.uri.path_and_query().map_or("/", |p| p.as_str());
        let mut rb =
            reqwest::Client::new().request(parts.method.clone(), format!("{target}{path}"));
        for h in [
            reqwest::header::AUTHORIZATION,
            reqwest::header::CONTENT_TYPE,
        ] {
            if let Some(v) = parts.headers.get(&h) {
                rb = rb.header(h, v.clone());
            }
        }
        let r = rb.body(bytes).send().await.unwrap();
        let status = r.status();
        (status, r.bytes().await.unwrap()).into_response()
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new()
        .fallback(forward)
        .with_state((target, delay));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

async fn post_swap(http: &reqwest::Client, d: &Daemon, body: Value) -> (u16, Value) {
    let r = http
        .post(format!("{}/api/swaps", d.api))
        .json(&body)
        .send()
        .await
        .unwrap();
    (r.status().as_u16(), r.json().await.unwrap_or_default())
}

async fn api_get(http: &reqwest::Client, d: &Daemon, path: &str) -> Value {
    http.get(format!("{}{path}", d.api))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// `base` with the fields of `extra` added.
fn with(base: &Value, extra: Value) -> Value {
    let mut b = base.clone();
    b.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    b
}

/// Leg 1 of a route on EVM (buying ZEC, the user is a B taker): ferryd advertises routes and its
/// own shielded address; refuses a bad label, a sweep destination of another network, a limit
/// of the wrong role and a maker asking more than `max_counter`; refuses a second start with a
/// label that is in use, while its first start is still being handled and after; and its sweep
/// pays the address it was given, not its own wallet.
#[tokio::test]
async fn route_leg_one_buys_zec_into_another_wallet() {
    let Some(chain) = Chain::start().await else {
        return;
    };
    let http = api_client();
    let maker = chain.ferryd(
        "z",
        "maker-z",
        "z.key",
        &[
            "--maker-offer",
            &format!("{RATE}"),
            "--zec-mock-balance",
            "500000000",
        ],
    );
    let user = chain.ferryd("b", "user-b", "b.key", &[]);
    maker.ready(&http).await;
    user.ready(&http).await;

    let status = api_get(&http, &user, "/api/status").await;
    assert_eq!(status["features"], json!(["route", "payout"]), "{status}");
    let addresses = api_get(&http, &user, "/api/addresses").await;
    assert_eq!(addresses["zec"]["address"], mock_wallet("user-b"));

    let to = mock_wallet("user-z");
    let one_zec = 100_000_000u64;
    let base = json!({"maker": maker.peer, "zec_zat": one_zec});
    for (extra, why) in [
        (json!({"route": "R1/1"}), "route may hold only"),
        (
            json!({"sweep_to": "utest1mockwallet757365722d7a"}),
            "sweep_to: not a wallet address",
        ),
        (json!({"min_counter": 1}), "min_counter is for role Z only"),
        (
            json!({"route": "r1/1", "max_counter": RATE - 1}),
            "above your limit",
        ),
    ] {
        let (code, body) = post_swap(&http, &user, with(&base, extra.clone())).await;
        assert_eq!(code, 400, "{extra}: {body}");
        assert!(
            body["error"].as_str().unwrap_or("").contains(why),
            "{extra}: {body}"
        );
    }
    assert_eq!(api_get(&http, &user, "/api/swaps").await, json!([]));

    // A start that takes a while: the same label again gets 409 with the label code, any other
    // start a plain 409, and the first one still creates its swap.
    let slow = slow_maker(maker.peer.clone(), Duration::from_secs(3)).await;
    let leg = json!({"maker": slow, "zec_zat": one_zec, "route": "r1/1",
                     "sweep_to": to, "max_counter": RATE});
    let first = {
        let (http, api, leg) = (http.clone(), user.api.clone(), leg.clone());
        tokio::spawn(async move {
            let r = http
                .post(format!("{api}/api/swaps"))
                .json(&leg)
                .send()
                .await
                .unwrap();
            (r.status().as_u16(), r.json::<Value>().await.unwrap())
        })
    };
    tokio::time::sleep(Duration::from_millis(800)).await;
    let (code, body) = post_swap(&http, &user, leg.clone()).await;
    assert_eq!(
        (code, body["code"].as_str()),
        (409, Some("route_label_in_use")),
        "{body}"
    );
    let (code, body) = post_swap(&http, &user, with(&base, json!({"route": "r2/1"}))).await;
    assert_eq!((code, body["code"].as_str()), (409, None), "{body}");
    let (code, body) = first.await.unwrap();
    assert_eq!(code, 201, "{body}\n{}", tail(&user.log));
    let id = body["id"].as_str().unwrap().to_string();
    let (code, body) = post_swap(&http, &user, leg).await;
    assert_eq!(
        (code, body["code"].as_str()),
        (409, Some("route_label_in_use")),
        "{body}"
    );
    assert!(body["error"].as_str().unwrap().contains(&id), "{body}");
    assert_eq!(
        api_get(&http, &user, "/api/swaps")
            .await
            .as_array()
            .unwrap()
            .len(),
        1,
        "one label, one swap"
    );

    let v = user.swap(&http, &id).await;
    assert_eq!(
        (v["route"].as_str(), v["sweep_to"].as_str()),
        (Some("r1/1"), Some(to.as_str()))
    );
    let v = user
        .until(&http, &id, 120, "the swap", |v| v["outcome"] == "swapped")
        .await;
    let swept = v["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "zec_sweep_broadcast")
        .unwrap();
    assert!(
        swept["label"]
            .as_str()
            .unwrap()
            .contains("the shielded address given for this swap"),
        "{swept}"
    );
    assert_eq!(
        mock_balance(&chain, "user-z"),
        one_zec,
        "the sweep paid user-z"
    );
    assert_eq!(
        mock_balance(&chain, "user-b"),
        0,
        "not the sweeper's wallet"
    );
    // The maker never saw the destination or the label.
    let m = maker.swap(&http, &id).await;
    assert!(m["sweep_to"].is_null() && m["route"].is_null(), "{m}");
}

/// Leg 2 of a route on EVM (selling ZEC, the user is a Z taker): a maker paying less than
/// `min_counter` is refused, `sweep_to` is refused for role Z, and a swap whose record can't be
/// saved is refused with no swap left behind, in memory or on disk.
#[tokio::test]
async fn route_leg_two_price_floor_and_an_unsaved_swap() {
    let Some(chain) = Chain::start().await else {
        return;
    };
    let http = api_client();
    let maker = chain.ferryd(
        "b",
        "maker-b",
        "b.key",
        &["--maker-offer", &format!("{RATE}")],
    );
    let user = chain.ferryd("z", "user-z", "z.key", &["--zec-mock-balance", "500000000"]);
    maker.ready(&http).await;
    user.ready(&http).await;
    let base = json!({"maker": maker.peer, "zec_zat": 100_000_000u64, "route": "r9/2"});
    let (code, body) = post_swap(&http, &user, with(&base, json!({"min_counter": RATE + 1}))).await;
    assert_eq!(code, 400, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("below your minimum"),
        "{body}"
    );
    let (code, body) = post_swap(
        &http,
        &user,
        with(&base, json!({"sweep_to": mock_wallet("x")})),
    )
    .await;
    assert_eq!(code, 400, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("role B only"),
        "{body}"
    );
    assert_eq!(api_get(&http, &user, "/api/swaps").await, json!([]));

    // The record can't be written: refused, and nothing is left to resume.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let swaps = chain.dir.path().join("user-z").join("evm-swaps");
        std::fs::set_permissions(&swaps, std::fs::Permissions::from_mode(0o500)).unwrap();
        let (code, body) = post_swap(&http, &user, with(&base, json!({"min_counter": RATE}))).await;
        std::fs::set_permissions(&swaps, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(code, 500, "{body}");
        assert!(
            body["error"].as_str().unwrap().contains("could not save"),
            "{body}"
        );
        assert_eq!(
            api_get(&http, &user, "/api/swaps").await,
            json!([]),
            "no swap in memory"
        );
        assert_eq!(
            std::fs::read_dir(&swaps).unwrap().count(),
            0,
            "none on disk"
        );
    }
}

// ---------------------------------------------------------------- payout_to (role Z)

/// anvil's account 3: an address neither daemon holds a key for (say, a 1Click deposit
/// address).
const PAYOUT: &str = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

/// A Z taker's `payout_to` is the claimer in the FerryLock terms: the claim pays it, not Z's
/// account (which still sends the claim). A bad address, FerryLock or the token itself, and
/// `payout_to` on a B daemon are refused before any maker is contacted.
#[tokio::test]
async fn payout_to_claim_lands_at_a_third_address() {
    let Some(chain) = Chain::start().await else {
        return;
    };
    let http = api_client();
    let maker = chain.ferryd(
        "b",
        "maker-b",
        "b.key",
        &["--maker-offer", &format!("{RATE}")],
    );
    let user = chain.ferryd("z", "user-z", "z.key", &["--zec-mock-balance", "500000000"]);
    maker.ready(&http).await;
    user.ready(&http).await;
    let status = api_get(&http, &user, "/api/status").await;
    assert!(
        status["features"]
            .as_array()
            .unwrap()
            .contains(&json!("payout")),
        "{status}"
    );

    // Checked before the maker is asked: these name a maker nobody listens on.
    let nowhere = json!({"maker": "http://127.0.0.1:1", "zec_zat": 100_000_000u64});
    let lock = format!("{:#x}", chain.lock);
    let usdc = format!("{:#x}", chain.usdc);
    let typo = PAYOUT.replacen('F', "f", 1);
    for (to, why) in [
        ("0x1234", "40 hex digits"),
        (typo.as_str(), "checksum"),
        ("0x0000000000000000000000000000000000000000", "zero address"),
        (lock.as_str(), "FerryLock contract"),
        (usdc.as_str(), "USDC contract"),
        (
            "bcrt1qn7uqc8hytxc7mhtsdszr9f5yc6hgmqqlc0wsks",
            "starts with 0x",
        ),
    ] {
        let (code, body) = post_swap(&http, &user, with(&nowhere, json!({"payout_to": to}))).await;
        assert_eq!(code, 400, "{to}: {body}");
        let e = body["error"].as_str().unwrap_or("");
        assert!(
            e.starts_with("payout_to: ") && e.contains(why),
            "{to}: {body}"
        );
    }
    let (code, body) = post_swap(&http, &maker, with(&nowhere, json!({"payout_to": PAYOUT}))).await;
    assert_eq!(code, 400, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("role Z only"),
        "{body}"
    );
    assert_eq!(api_get(&http, &user, "/api/swaps").await, json!([]));

    let payout: Address = PAYOUT.parse().unwrap();
    let (payout_before, z_before) = (chain.usdc_at(payout).await, chain.usdc_of(KEY_Z).await);
    let (code, body) = post_swap(
        &http,
        &user,
        json!({"maker": maker.peer, "zec_zat": 100_000_000u64, "payout_to": PAYOUT.to_lowercase(),
               "min_counter": RATE}),
    )
    .await;
    assert_eq!(code, 201, "{body}\n{}", tail(&user.log));
    let id = body["id"].as_str().unwrap().to_string();
    let v = user.swap(&http, &id).await;
    assert_eq!(v["payout_to"], PAYOUT, "shown checksummed: {v}");
    assert!(
        v["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "payout_to"),
        "{v}"
    );
    let z = user
        .until(&http, &id, 120, "the swap", |v| v["outcome"] == "swapped")
        .await;
    // The terms bind it: both sides' view of the lock names the payout address as claimer.
    assert_eq!(z["counter"]["claimer"], PAYOUT, "{z}");
    let b = maker
        .until(&http, &id, 30, "B's side", |v| v["outcome"] == "swapped")
        .await;
    assert_eq!(b["counter"]["claimer"], PAYOUT, "{b}");
    assert!(b["payout_to"].is_null(), "the maker's own view: {b}");
    assert_eq!(
        chain.usdc_at(payout).await - payout_before,
        U256::from(RATE),
        "the claim paid 40 USDC to the payout address"
    );
    assert_eq!(
        chain.usdc_of(KEY_Z).await,
        z_before,
        "Z's own account got nothing"
    );
    let done = z["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "swap_complete")
        .unwrap();
    assert!(
        done["label"]
            .as_str()
            .unwrap()
            .contains("the payout address given for this swap"),
        "{done}"
    );
}
