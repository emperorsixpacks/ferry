//! Two real `ferryd` processes (Z taker, B maker) swap over HTTP against a regtest bitcoind,
//! with the file-backed mock Zcash chain. The test plays block producer.
//!
//! Needs `spikes/btc/scripts/regtest.sh start` (override the RPC with FERRY_BTC_RPC).
//! Run: `cargo test -p ferryd --test two_daemons -- --ignored --test-threads=1 --nocapture`

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use ferry_btc::bitcoin::{Amount, Network};
use ferry_btc::rpc::BitcoinRpc;
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};

const T1: u16 = 16;
const T2: u16 = 10;
const TOKEN: &str = "it-api-token";

fn rpc_url() -> String {
    std::env::var("FERRY_BTC_RPC").unwrap_or_else(|_| "http://127.0.0.1:18543".into())
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct Party {
    child: Option<Child>,
    url: String,
    args: Vec<String>,
    log: PathBuf,
    wallet: String,
}

impl Party {
    fn spawn(&mut self) {
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
            .unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_ferryd"))
            .args(&self.args)
            .env("RUST_LOG", "ferryd=debug")
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .expect("spawn ferryd");
        self.child = Some(child);
    }

    fn kill(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// The peer listener's URL (what a taker is given as `maker`).
    fn peer_url(&self) -> String {
        let i = self.args.iter().position(|a| a == "--listen").unwrap();
        format!("http://{}", self.args[i + 1])
    }

    fn logs(&self) -> String {
        let s = std::fs::read_to_string(&self.log).unwrap_or_default();
        let lines: Vec<&str> = s.lines().collect();
        lines[lines.len().saturating_sub(40)..].join("\n")
    }
}

impl Drop for Party {
    fn drop(&mut self) {
        self.kill();
    }
}

struct World {
    http: reqwest::Client,
    rpc: BitcoinRpc,
    miner: ferry_btc::bitcoin::Address,
    z: Party,
    b: Party,
    _dir: tempfile::TempDir,
}

#[allow(clippy::too_many_arguments)]
fn party_args(
    role: &str,
    name: &str,
    port: u16,
    dir: &Path,
    zec_file: &Path,
    wallet: &str,
    zec_confs: u32,
    extra: &[&str],
) -> Vec<String> {
    let mut args: Vec<String> = [
        "--role",
        role,
        "--name",
        name,
        "--api-listen",
        &format!("127.0.0.1:{port}"),
        "--listen",
        &format!("127.0.0.1:{}", free_port()),
        "--api-token",
        TOKEN,
        "--demo-faults",
        "--sweep-delay-secs",
        "0:1",
        "--data-dir",
        dir.join(name).to_str().unwrap(),
        "--btc-rpc",
        &rpc_url(),
        "--btc-wallet",
        wallet,
        "--zec",
        "mock",
        "--zec-mock-file",
        zec_file.to_str().unwrap(),
        "--zec-mock-block-secs",
        "0.5",
        "--t1",
        &T1.to_string(),
        "--t2",
        &T2.to_string(),
        "--delta",
        "3",
        "--btc-lock-confs",
        "1",
        "--zec-confs",
        &zec_confs.to_string(),
        "--cancel-confs",
        "1",
        "--poll-ms",
        "250",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(extra.iter().map(|s| s.to_string()));
    args
}

impl World {
    async fn start(zec_confs: u32) -> World {
        let dir = tempfile::tempdir().unwrap();
        let zec_file = dir.path().join("zec-chain.json");
        let tag = format!("{:08x}", OsRng.next_u32());

        let rpc = BitcoinRpc::new(rpc_url(), "ferry", "ferry").with_wallet("ferryd-it");
        rpc.ensure_wallet()
            .await
            .expect("bitcoind up? (spikes/btc/scripts/regtest.sh start)");
        let miner = rpc.new_address(Network::Regtest).await.unwrap();
        if rpc.balance().await.unwrap() < Amount::from_btc(5.0).unwrap() {
            rpc.generate_to_address(101, &miner).await.unwrap();
        }

        let (zp, bp) = (free_port(), free_port());
        let mut z = Party {
            child: None,
            url: format!("http://127.0.0.1:{zp}"),
            wallet: format!("it-zoe-{tag}"),
            args: vec![],
            log: dir.path().join("zoe.log"),
        };
        z.args = party_args(
            "z",
            "zoe",
            zp,
            dir.path(),
            &zec_file,
            &z.wallet,
            zec_confs,
            &["--zec-mock-balance", "500000000"],
        );
        let mut b = Party {
            child: None,
            url: format!("http://127.0.0.1:{bp}"),
            wallet: format!("it-bram-{tag}"),
            args: vec![],
            log: dir.path().join("bram.log"),
        };
        b.args = party_args(
            "b",
            "bram",
            bp,
            dir.path(),
            &zec_file,
            &b.wallet,
            zec_confs,
            &["--maker-offer", "410000"],
        );
        z.spawn();
        b.spawn();

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {TOKEN}").parse().unwrap(),
        );
        let w = World {
            http: reqwest::Client::builder()
                .default_headers(headers)
                .build()
                .unwrap(),
            rpc,
            miner,
            z,
            b,
            _dir: dir,
        };
        w.wait_ready(&w.z.url).await;
        w.wait_ready(&w.b.url).await;

        // Fund B's wallet (created by its daemon).
        let b_rpc = BitcoinRpc::new(rpc_url(), "ferry", "ferry").with_wallet(w.b.wallet.clone());
        let b_addr = b_rpc.new_address(Network::Regtest).await.unwrap();
        let _: Value = w
            .rpc
            .wallet_call("sendtoaddress", json!([b_addr.to_string(), 1.0]))
            .await
            .unwrap();
        w.mine().await;
        w
    }

    async fn wait_ready(&self, url: &str) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(r) = self.http.get(format!("{url}/api/status")).send().await {
                if r.status().is_success() {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!(
            "{url} did not come up\nZ:\n{}\nB:\n{}",
            self.z.logs(),
            self.b.logs()
        );
    }

    async fn mine(&self) {
        self.rpc.generate_to_address(1, &self.miner).await.unwrap();
    }

    async fn get(&self, url: &str, path: &str) -> Value {
        self.http
            .get(format!("{url}{path}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn post(&self, url: &str, path: &str, body: Value) -> (u16, Value) {
        let r = self
            .http
            .post(format!("{url}{path}"))
            .json(&body)
            .send()
            .await
            .unwrap();
        (r.status().as_u16(), r.json().await.unwrap_or_default())
    }

    async fn swap(&self, url: &str, id: &str) -> Value {
        self.get(url, &format!("/api/swaps/{id}")).await
    }

    async fn start_swap(&self, zec_zat: u64) -> String {
        let (code, body) = self
            .post(
                &self.z.url,
                "/api/swaps",
                json!({"maker": self.b.peer_url(), "zec_zat": zec_zat}),
            )
            .await;
        assert_eq!(
            code,
            201,
            "{body}\nZ:\n{}\nB:\n{}",
            self.z.logs(),
            self.b.logs()
        );
        body["id"].as_str().unwrap().to_string()
    }

    /// Poll every 100ms, mining a block every `block_ms`, until `done` or `max` blocks.
    async fn run_until(
        &self,
        id: &str,
        block_ms: u64,
        max: u32,
        done: impl Fn(&Value, &Value) -> bool,
    ) -> (Value, Value) {
        let mut blocks = 0;
        let mut last_block = Instant::now();
        loop {
            let (z, b) = (
                self.swap(&self.z.url, id).await,
                self.swap(&self.b.url, id).await,
            );
            if done(&z, &b) {
                return (z, b);
            }
            if last_block.elapsed() >= Duration::from_millis(block_ms) {
                assert!(
                    blocks < max,
                    "not done after {max} blocks: Z {} / B {}\nZ timeline: {}\nB timeline: {}\nZ log:\n{}\nB log:\n{}",
                    z["state"], b["state"], kinds(&z), kinds(&b), self.z.logs(), self.b.logs()
                );
                self.mine().await;
                blocks += 1;
                last_block = Instant::now();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

fn kinds(v: &Value) -> String {
    v["timeline"]
        .as_array()
        .map(|t| {
            t.iter()
                .map(|e| e["kind"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default()
}

fn entry<'a>(v: &'a Value, kind: &str) -> &'a Value {
    v["timeline"]
        .as_array()
        .and_then(|t| t.iter().find(|e| e["kind"] == kind))
        .unwrap_or_else(|| panic!("no {kind} in {}", kinds(v)))
}

fn state(v: &Value) -> &str {
    v["state"].as_str().unwrap_or("")
}

/// The control API needs the token, refuses foreign origins and is not on the peer listener.
async fn check_api_guard(w: &World) {
    let bare = reqwest::Client::new();
    let status = |r: reqwest::Response| r.status().as_u16();
    let url = format!("{}/api/status", w.z.url);
    assert_eq!(status(bare.get(&url).send().await.unwrap()), 401);
    assert_eq!(
        status(bare.get(&url).bearer_auth("wrong").send().await.unwrap()),
        401
    );
    let from_site = bare
        .get(&url)
        .bearer_auth(TOKEN)
        .header("origin", "https://evil.example");
    assert_eq!(status(from_site.send().await.unwrap()), 403);
    assert_eq!(
        status(bare.get(&url).bearer_auth(TOKEN).send().await.unwrap()),
        200
    );
    let on_peer = format!("{}/api/status", w.b.peer_url());
    assert_eq!(
        status(bare.get(&on_peer).bearer_auth(TOKEN).send().await.unwrap()),
        404
    );
    let offer = format!("{}/peer/offer", w.b.peer_url());
    assert_eq!(status(bare.get(&offer).send().await.unwrap()), 200);

    let token_file = w._dir.path().join("zoe").join("api-token");
    assert_eq!(std::fs::read_to_string(&token_file).unwrap(), TOKEN);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&token_file), 0o600);
        assert_eq!(mode(&w._dir.path().join("zoe").join("swaps")), 0o700);
    }
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn happy_swap_over_http_with_restart() {
    let mut w = World::start(2).await;
    check_api_guard(&w).await;
    let id = w.start_swap(100_000_000).await;

    // Restart Z mid-swap, once its ZEC is locked: it must resume from its swap file.
    w.run_until(&id, 700, 20, |z, _| {
        state(z) == "ZecLocked" || state(z) == "RedeemSigReceived"
    })
    .await;
    w.z.kill();
    w.z.spawn();
    w.wait_ready(&w.z.url.clone()).await;

    let (z, b) = w
        .run_until(&id, 700, 30, |z, b| {
            z["outcome"] == "swapped" && b["outcome"] == "swapped"
        })
        .await;
    assert_eq!(
        (z["id"].as_str(), b["id"].as_str()),
        (Some(id.as_str()), Some(id.as_str()))
    );
    assert_eq!((state(&z), state(&b)), ("BtcRedeemed", "ZecSwept"));
    assert!(
        z["secrets"]["mine_revealed"].as_bool().unwrap()
            && b["secrets"]["peer_learned"].as_bool().unwrap()
    );
    assert_eq!(z["keys"]["joint_ak"], b["keys"]["joint_ak"]);
    assert_eq!(z["addresses"], b["addresses"]);
    assert!(entry(&b, "btc_lock_broadcast")["height"].is_u64());
    assert!(entry(&z, "zec_lock_broadcast")["txid"].is_string());
    assert!(entry(&b, "secret_extracted")["txid"].is_string());
    assert!(entry(&b, "zec_sweep_broadcast")["txid"].is_string());
    entry(&b, "sweep_delayed");

    // Let the redeem's timeline height fill in, then compare what each side says observers see.
    let (z, b) = w
        .run_until(&id, 700, 5, |z, _| {
            entry(z, "btc_redeem_broadcast")["height"].is_u64()
        })
        .await;
    assert_eq!(
        z["observer"], b["observer"],
        "both parties describe the same public transactions"
    );
    assert_eq!(
        z["observer"]["btc"].as_array().unwrap().len(),
        2,
        "{}",
        z["observer"]
    );
    assert!(z["observer"]["btc"][1]
        .as_str()
        .unwrap()
        .starts_with("tx_redeem: key-path spend"));
    let redeem_txid = entry(&z, "btc_redeem_broadcast")["txid"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let redeem = w.rpc.raw_transaction(&redeem_txid).await.unwrap().unwrap();
    assert_eq!(
        redeem.input[0].witness.len(),
        1,
        "MuSig2 key-path redeem: a single signature"
    );
    assert!(z["observer"]["btc"][0]
        .as_str()
        .unwrap()
        .starts_with("tx_lock: "));

    let zs = w.get(&w.z.url, "/api/status").await;
    assert_eq!(zs["balances"]["btc_sat"], 410_000 - 2_000);
    assert_eq!(zs["balances"]["zec_shielded_zat"], 400_000_000);
    let bs = w.get(&w.b.url, "/api/status").await;
    assert_eq!(bs["balances"]["zec_shielded_zat"], 100_000_000);

    // A second swap is refused only while one is running; the SSE stream replays state.
    let mut sse = w
        .http
        .get(format!("{}/api/events", w.b.url))
        .send()
        .await
        .unwrap();
    let mut seen = String::new();
    while !seen.contains("event: swap") {
        let chunk = tokio::time::timeout(Duration::from_secs(5), sse.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        seen.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(seen.contains(&id));
    println!("Z: {}\nB: {}", kinds(&z), kinds(&b));
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn refund_swap_when_z_stalls() {
    // Z stalls with its ZEC locked; B cancels at T1 and refunds; Z wakes on the cancel,
    // extracts b from the refund witness and reclaims its ZEC.
    let w = World::start(4).await;
    let id = w.start_swap(50_000_000).await;
    w.run_until(&id, 700, 20, |z, _| state(z) == "ZecLocked")
        .await;
    let (code, body) = w
        .post(
            &w.z.url,
            &format!("/api/swaps/{id}/fault"),
            json!({"fault": "stall"}),
        )
        .await;
    assert_eq!(code, 200, "{body}");
    let (code, _) = w
        .post(
            &w.z.url,
            &format!("/api/swaps/{id}/fault"),
            json!({"fault": "stall"}),
        )
        .await;
    assert_eq!(code, 409);

    let (z, b) = w
        .run_until(&id, 300, 60, |z, b| {
            z["outcome"] == "refunded" && b["outcome"] == "refunded"
        })
        .await;
    assert_eq!((state(&z), state(&b)), ("ZecReclaimed", "Refunded"));
    for k in [
        "fault_injected",
        "fault_cleared",
        "secret_extracted",
        "zec_reclaim_broadcast",
    ] {
        entry(&z, k);
    }
    for k in ["cancel_broadcast", "refund_broadcast"] {
        entry(&b, k);
    }
    assert!(
        z["secrets"]["peer_learned"].as_bool().unwrap()
            && b["secrets"]["mine_revealed"].as_bool().unwrap()
    );
    assert!(z["deadlines"]["cancel_height"].is_u64());
    assert!(
        entry(&b, "btc_lock_broadcast")["height"].as_u64().unwrap() + u64::from(T1)
            <= z["deadlines"]["cancel_height"].as_u64().unwrap()
    );
    let zs = w.get(&w.z.url, "/api/status").await;
    assert_eq!(zs["balances"]["zec_shielded_zat"], 500_000_000);
    println!("Z: {}\nB: {}", kinds(&z), kinds(&b));
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn punish_swap_when_b_stalls() {
    // Slow ZEC confirmations keep B in BtcLocked/ZecSeen long enough to stall it there.
    let w = World::start(6).await;
    let id = w.start_swap(50_000_000).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    while state(&w.swap(&w.b.url, &id).await) != "CancelSigned" {
        assert!(
            Instant::now() < deadline,
            "B never reached CancelSigned\n{}",
            w.b.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Too early: tx_lock is not confirmed yet.
    let (code, _) = w
        .post(
            &w.b.url,
            &format!("/api/swaps/{id}/fault"),
            json!({"fault": "stall"}),
        )
        .await;
    assert_eq!(code, 409);
    w.mine().await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !matches!(state(&w.swap(&w.b.url, &id).await), "BtcLocked" | "ZecSeen") {
        assert!(
            Instant::now() < deadline,
            "B never reached BtcLocked/ZecSeen\n{}",
            w.b.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (code, body) = w
        .post(
            &w.b.url,
            &format!("/api/swaps/{id}/fault"),
            json!({"fault": "stall"}),
        )
        .await;
    assert_eq!(code, 200, "{body}");

    let (z, b) = w
        .run_until(&id, 300, 60, |z, b| {
            z["outcome"] == "punished" && b["outcome"] == "punished"
        })
        .await;
    entry(&z, "cancel_broadcast");
    entry(&z, "punish_broadcast");
    entry(&b, "punish_seen");
    assert!(!kinds(&b).contains("refund_broadcast"));
    println!("Z: {}\nB: {}", kinds(&z), kinds(&b));
}
