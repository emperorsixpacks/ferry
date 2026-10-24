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
        self.deployer
            .token_balance(self.usdc, signer(key).address())
            .await
            .unwrap()
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
