//! Two real `ferryd` processes swap over HTTP against a regtest bitcoind, with the file-backed
//! mock Zcash chain. The test plays block producer. The three stories (happy, refund, punish) run
//! both ways: selling ZEC (Z takes from a B maker) and buying ZEC (B takes from a Z maker).
//!
//! Needs `spikes/btc/scripts/regtest.sh start` (override the RPC with FERRY_BTC_RPC).
//! Run: `cargo test -p ferryd --test two_daemons -- --ignored --test-threads=1 --nocapture`

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use ferry_btc::bitcoin::{Amount, Network};
use ferry_btc::rpc::BitcoinRpc;
use ferry_core::Role;
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
    /// Who makes (`--maker-offer`); the other one takes.
    maker: Role,
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
        "--dev-policy",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(extra.iter().map(|s| s.to_string()));
    args
}

impl World {
    async fn start(zec_confs: u32) -> World {
        Self::start_with(zec_confs, &[]).await
    }

    /// `b_extra`: more flags for the maker (B).
    async fn start_with(zec_confs: u32, b_extra: &[&str]) -> World {
        Self::start_as(zec_confs, Role::B, b_extra).await
    }

    /// `maker` makes at 410000 sat/ZEC, with `maker_extra`; the other party takes.
    async fn start_as(zec_confs: u32, maker: Role, maker_extra: &[&str]) -> World {
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
        let offer = [&["--maker-offer", "410000"], maker_extra].concat();
        let z_extra = [
            &["--zec-mock-balance", "500000000"][..],
            if maker == Role::Z { &offer } else { &[] },
        ]
        .concat();
        z.args = party_args(
            "z",
            "zoe",
            zp,
            dir.path(),
            &zec_file,
            &z.wallet,
            zec_confs,
            &z_extra,
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
            if maker == Role::B { &offer } else { &[] },
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
            maker,
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

    fn party(&self, role: Role) -> &Party {
        match role {
            Role::Z => &self.z,
            Role::B => &self.b,
        }
    }

    fn maker(&self) -> &Party {
        self.party(self.maker)
    }

    fn taker(&self) -> &Party {
        self.party(self.maker.peer())
    }

    fn zec_file(&self) -> PathBuf {
        self._dir.path().join("zec-chain.json")
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

    /// Poll `/api/status` until `ok` holds (10 s at most).
    async fn status_until(&self, url: &str, ok: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let s = self.get(url, "/api/status").await;
            if ok(&s) {
                return s;
            }
            assert!(Instant::now() < deadline, "status never matched: {s}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn swap(&self, url: &str, id: &str) -> Value {
        self.get(url, &format!("/api/swaps/{id}")).await
    }

    /// The taker proposes to the maker: one call on the taker's API, whichever role it holds.
    async fn start_swap(&self, zec_zat: u64) -> String {
        let (code, body) = self
            .post(
                &self.taker().url,
                "/api/swaps",
                json!({"maker": self.maker().peer_url(), "zec_zat": zec_zat}),
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
    // Each status says whether its daemon is a maker (a UI keeps a maker out of the user's own
    // daemons to swap on).
    assert_eq!(
        w.get(&w.maker().url, "/api/status").await["offer"]["maker"],
        true
    );
    assert_eq!(
        w.get(&w.taker().url, "/api/status").await["offer"]["maker"],
        false
    );
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
    let on_peer = format!("{}/api/status", w.maker().peer_url());
    assert_eq!(
        status(bare.get(&on_peer).bearer_auth(TOKEN).send().await.unwrap()),
        404
    );
    let offer = format!("{}/peer/offer", w.maker().peer_url());
    let got: Value = bare.get(&offer).send().await.unwrap().json().await.unwrap();
    assert_eq!(got["making"], true, "{got}");
    assert_eq!(got["role"], if w.maker == Role::Z { "Z" } else { "B" });
    // A Z maker quotes what its shielded ZEC can fill (the mock wallet keeps no fee reserve),
    // once its first status refresh has read the balance.
    if w.maker == Role::Z {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let got: Value = bare.get(&offer).send().await.unwrap().json().await.unwrap();
            if got["liquidity"]["zec_zat"] == 500_000_000 {
                break;
            }
            assert!(Instant::now() < deadline, "Z maker liquidity: {got}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

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
    happy_swap(Role::B).await;
}

/// Buying ZEC: B proposes to a Z maker, locks BTC, receives the ZEC and sweeps it.
#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn buy_zec_happy_swap_with_a_z_maker() {
    happy_swap(Role::Z).await;
}

async fn happy_swap(maker: Role) {
    let mut w = World::start_as(2, maker, &[]).await;
    check_api_guard(&w).await;
    let id = w.start_swap(100_000_000).await;
    let (taker_view, maker_view) = (
        w.swap(&w.taker().url, &id).await,
        w.swap(&w.maker().url, &id).await,
    );
    assert_eq!(
        (taker_view["taker"].as_bool(), maker_view["taker"].as_bool()),
        (Some(true), Some(false))
    );
    // The maker's outbox is only readable with the ECDH-derived peer token.
    let outbox = format!("{}/peer/swaps/{id}/messages?after=0", w.maker().peer_url());
    let bare = reqwest::Client::new();
    assert_eq!(
        bare.get(&outbox).send().await.unwrap().status().as_u16(),
        401
    );
    assert_eq!(
        bare.get(&outbox)
            .bearer_auth("guess")
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        401
    );

    // Restart Z mid-swap (taker or maker), once its ZEC is locked: it must resume from its
    // swap file. A poll can miss the short RedeemSigReceived window when B pushes its adaptor
    // the moment it may (B as taker), so a Z that already redeemed is restarted all the same.
    w.run_until(&id, 700, 20, |z, _| {
        matches!(state(z), "ZecLocked" | "RedeemSigReceived" | "BtcRedeemed")
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
    // Z follows the swap through its watch-only wallet (what a pruned node without -txindex
    // needs): it knows B's lock and the redeem even though neither came from Z's own wallet.
    let z_watch =
        BitcoinRpc::new(rpc_url(), "ferry", "ferry").with_wallet(format!("{}-watch", w.z.wallet));
    let lock_txid = entry(&b, "btc_lock_broadcast")["txid"]
        .as_str()
        .unwrap()
        .to_string();
    for txid in [lock_txid, redeem_txid.to_string()] {
        let v: Value = z_watch
            .wallet_call("gettransaction", json!([txid, true]))
            .await
            .unwrap();
        assert!(v["confirmations"].as_i64().unwrap() >= 1, "{v}");
    }
    assert!(z["observer"]["btc"][0]
        .as_str()
        .unwrap()
        .starts_with("tx_lock: "));

    // Balances are refreshed on the daemons' poll interval.
    let zs = w
        .status_until(&w.z.url, |s| s["balances"]["btc_sat"] == 410_000 - 2_000)
        .await;
    assert_eq!(zs["balances"]["zec_shielded_zat"], 400_000_000);
    let bs = w
        .status_until(&w.b.url, |s| {
            s["balances"]["zec_shielded_zat"] == 100_000_000
        })
        .await;
    let offer = &bs["offer"];
    assert_eq!(
        (offer["fee_sat"].as_u64(), offer["t1_blocks"].as_u64()),
        (Some(2_000), Some(u64::from(T1)))
    );
    assert_eq!(
        (offer["t2_blocks"].as_u64(), offer["zec_confs"].as_u64()),
        (Some(u64::from(T2)), Some(2))
    );

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
    refund_swap(Role::B).await;
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn buy_zec_refund_when_the_z_maker_stalls() {
    refund_swap(Role::Z).await;
}

async fn refund_swap(maker: Role) {
    // Z stalls with its ZEC locked; B cancels at T1 and refunds; Z wakes on the cancel,
    // extracts b from the refund witness and reclaims its ZEC.
    let w = World::start_as(4, maker, &[]).await;
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
    // The node "rejects" B's next two broadcasts (tx_cancel, then tx_refund). With Z stalled
    // until tx_cancel confirms, only B's rebroadcasting can finish the swap.
    let (code, body) = w
        .post(
            &w.b.url,
            &format!("/api/swaps/{id}/fault"),
            json!({"fault": "drop_broadcasts", "count": 2}),
        )
        .await;
    assert_eq!(code, 200, "{body}");

    let (z, b) = w
        .run_until(&id, 300, 60, |z, b| {
            z["outcome"] == "refunded" && b["outcome"] == "refunded"
        })
        .await;
    entry(&b, "fault_drop_broadcasts");
    assert!(entry(&b, "refund_broadcast")["height"].is_u64());
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
    w.status_until(&w.z.url, |s| {
        s["balances"]["zec_shielded_zat"] == 500_000_000
    })
    .await;
    println!("Z: {}\nB: {}", kinds(&z), kinds(&b));
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn punish_swap_when_b_stalls() {
    punish_swap(Role::B).await;
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn buy_zec_punish_when_the_b_taker_stalls() {
    punish_swap(Role::Z).await;
}

async fn punish_swap(maker: Role) {
    // Slow ZEC confirmations keep B in BtcLocked/ZecSeen long enough to stall it there.
    let w = World::start_as(6, maker, &[]).await;
    let id = w.start_swap(50_000_000).await;
    // CancelSigned with tx_lock in the mempool: B broadcasts it from its loop once the state has
    // moved (no handler moves funds), so the block below must not be mined before.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let b = w.swap(&w.b.url, &id).await;
        if state(&b) == "CancelSigned" && kinds(&b).contains("btc_lock_broadcast") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "B never broadcast its lock in CancelSigned\n{}",
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
    // Once Z has locked its ZEC, the Zcash backend breaks for good: the Bitcoin deadlines
    // must still be met (cancel at T1, punish at T2).
    w.run_until(&id, 300, 20, |z, _| state(z) == "ZecLocked")
        .await;
    std::fs::write(w.zec_file(), b"not json").unwrap();

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

/// A maker whose offer is outside the taker's policy (zero fee, zero margins).
#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn taker_refuses_out_of_policy_terms() {
    let w = World::start(2).await;
    let offer = json!({
        "role": "B", "network": "regtest", "making": true,
        "rate_sat_per_zec": 410000, "min_zat": 1, "max_zat": 100000000000u64,
        "terms": {
            "t1": 16, "t2": 10, "btc_fee": 0, "btc_lock_confirmations": 1,
            "zec_confirmations": 2, "cancel_confirmations": 1,
            "redeem_margin": 0, "refund_margin": 0, "keypath": true
        }
    });
    let app = axum::Router::new().route(
        "/peer/offer",
        axum::routing::get(move || async move { axum::Json(offer) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fake = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (code, body) = w
        .post(
            &w.z.url,
            "/api/swaps",
            json!({"maker": fake, "zec_zat": 50_000_000}),
        )
        .await;
    assert_eq!(code, 400, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("not acceptable"),
        "{body}"
    );
}

fn propose(sid: [u8; 32]) -> (ferry_core::Proposal, Value) {
    use ferry_btc::bitcoin::{key::Secp256k1, Address};
    let params = ferry_core::SwapParams {
        coin: ferry_btc::Coin::Btc,
        network: Network::Regtest,
        btc_amount: 205_000,
        zec_amount: 50_000_000,
        t1: T1,
        t2: T2,
        btc_fee: 2_000,
        btc_lock_confirmations: 1,
        zec_confirmations: 2,
        cancel_confirmations: 1,
        redeem_margin: 3,
        refund_margin: 3,
        keypath: true,
    };
    let address = Address::p2tr(
        &Secp256k1::new(),
        ferry_btc::BtcKey::random().xonly(),
        None,
        Network::Regtest,
    );
    let (p, env) =
        ferry_core::Proposal::new(&mut OsRng, sid, ferry_core::Role::Z, params, address).unwrap();
    (
        p,
        json!({"envelope": env, "taker_url": "http://silent.invalid"}),
    )
}

/// A taker that proposes and goes silent must not hold the maker's only slot forever, and
/// neither proposals nor garbage envelopes are unbounded.
#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn silent_taker_times_out_and_peer_input_is_bounded() {
    let w = World::start_with(2, &["--negotiation-timeout-secs", "3"]).await;
    let peer = w.b.peer_url();
    let http = reqwest::Client::new();
    let post = |path: String, body: Value, token: Option<String>| {
        let mut r = http.post(format!("{peer}{path}")).json(&body);
        if let Some(t) = token {
            r = r.bearer_auth(t);
        }
        async move {
            let r = r.send().await.unwrap();
            (
                r.status().as_u16(),
                r.json::<Value>().await.unwrap_or_default(),
            )
        }
    };

    let (p1, req1) = propose([1; 32]);
    let (code, accept) = post("/peer/swaps".into(), req1.clone(), None).await;
    assert_eq!(code, 201, "{accept}");
    let accept: ferry_core::Envelope = serde_json::from_value(accept).unwrap();
    let (swap1, _) = p1.on_accept(&mut OsRng, &accept).unwrap();
    let token = swap1.session().peer_token().unwrap();
    let id1 = hex::encode([1u8; 32]);
    assert_eq!(
        post("/peer/swaps".into(), propose([2; 32]).1, None).await.0,
        409,
        "slot taken"
    );

    // Garbage envelopes: refused, not remembered, and capped.
    let mut env = req1["envelope"].clone();
    let path = format!("/peer/swaps/{id1}/messages");
    assert_eq!(
        post(path.clone(), env.clone(), None).await.0,
        401,
        "peer token required"
    );
    let mut last = 0;
    for i in 0..20u8 {
        env["transcript"] = json!(hex::encode([i; 32]));
        last = post(path.clone(), env.clone(), Some(token.clone())).await.0;
    }
    assert_eq!(last, 429);

    // The silent swap times out (B had funded but not broadcast its lock) and frees the slot.
    let deadline = Instant::now() + Duration::from_secs(15);
    while state(&w.swap(&w.b.url, &id1).await) != "Aborted" {
        assert!(Instant::now() < deadline, "never aborted\n{}", w.b.logs());
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let b = w.swap(&w.b.url, &id1).await;
    assert!(kinds(&b).matches("peer_message_rejected").count() <= 16);
    assert_eq!(
        post("/peer/swaps".into(), propose([3; 32]).1, None).await.0,
        201,
        "slot free again"
    );

    // Proposals are rate limited (6 a minute; four so far).
    let codes: Vec<u16> = futures_util::future::join_all(
        (4..8u8).map(|i| post("/peer/swaps".into(), propose([i; 32]).1, None)),
    )
    .await
    .into_iter()
    .map(|(c, _)| c)
    .collect();
    assert!(codes.contains(&429), "{codes:?}");
}

/// A 1-zat note at the joint address before Z locks must not make Z skip its own ZEC lock.
#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn dust_note_does_not_stop_z_locking() {
    let w = World::start(2).await;
    let id = w.start_swap(100_000_000).await;
    // B's lock is broadcast but not mined, so Z has not sent anything yet.
    let deadline = Instant::now() + Duration::from_secs(20);
    while state(&w.swap(&w.b.url, &id).await) != "CancelSigned" {
        assert!(Instant::now() < deadline, "{}", w.b.logs());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let rec: Value = serde_json::from_slice(
        &std::fs::read(w._dir.path().join(format!("zoe/swaps/{id}.json"))).unwrap(),
    )
    .unwrap();
    let swap: ferry_core::Swap = serde_json::from_value(rec["swap"].clone()).unwrap();
    let fvk = hex::encode(swap.session().joint_fvk().unwrap());
    let dust = "d".repeat(64);
    {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(w.zec_file())
            .unwrap();
        file.lock().unwrap();
        let mut chain: Value =
            serde_json::from_slice(&std::fs::read(w.zec_file()).unwrap()).unwrap();
        chain["txs"].as_array_mut().unwrap().push(json!({
            "txid": dust, "kind": "send", "fvk": fvk, "value": 1, "owner": "bram", "height": 1
        }));
        std::fs::write(w.zec_file(), serde_json::to_vec(&chain).unwrap()).unwrap();
        file.unlock().unwrap();
    }
    let (z, _) = w
        .run_until(&id, 700, 30, |z, b| {
            z["outcome"] == "swapped" && b["outcome"] == "swapped"
        })
        .await;
    assert_ne!(
        entry(&z, "zec_lock_broadcast")["txid"].as_str().unwrap(),
        dust
    );
}

/// The mock chain's address of `owner`'s wallet (crates/ferryd/src/mock_zec.rs).
fn mock_wallet(owner: &str) -> String {
    format!("uregtest1mockwallet{}", hex::encode(owner))
}

/// Leg 1 of a route on Bitcoin (the user is a B taker buying ZEC from a Z maker): ferryd
/// advertises routes and its shielded address, refuses a maker asking more than `max_counter`,
/// a bad `sweep_to` and a reused label, sweeps to the address it was given, and refuses a swap
/// whose record it can't save, leaving nothing to resume.
#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn route_leg_buys_zec_into_another_wallet() {
    let w = World::start_as(1, Role::Z, &[]).await;
    let (user, maker) = (w.taker().url.clone(), w.maker().peer_url());
    let status = w.get(&user, "/api/status").await;
    assert_eq!(status["features"], json!(["route", "payout"]), "{status}");
    let addresses = w.get(&user, "/api/addresses").await;
    assert_eq!(addresses["zec"]["address"], mock_wallet("bram"));

    let to = mock_wallet("user-z");
    let leg = json!({"maker": maker, "zec_zat": 100_000_000u64, "route": "r7/1",
                     "sweep_to": to, "max_counter": 410_000});
    let mut over = leg.clone();
    over["max_counter"] = json!(409_999);
    let (code, body) = w.post(&user, "/api/swaps", over).await;
    assert_eq!(code, 400, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("above your limit"),
        "{body}"
    );
    let mut bad = leg.clone();
    bad["sweep_to"] = json!("utest1mockwallet7573");
    let (code, body) = w.post(&user, "/api/swaps", bad).await;
    assert_eq!(code, 400, "{body}");
    assert_eq!(w.get(&user, "/api/swaps").await, json!([]));

    let (code, body) = w.post(&user, "/api/swaps", leg.clone()).await;
    assert_eq!(code, 201, "{body}\nB:\n{}", w.b.logs());
    let id = body["id"].as_str().unwrap().to_string();
    let (code, body) = w.post(&user, "/api/swaps", leg.clone()).await;
    assert_eq!(
        (code, body["code"].as_str()),
        (409, Some("route_label_in_use")),
        "{body}"
    );
    let v = w.swap(&user, &id).await;
    assert_eq!(
        (v["route"].as_str(), v["sweep_to"].as_str()),
        (Some("r7/1"), Some(to.as_str()))
    );
    w.run_until(&id, 700, 40, |z, b| {
        z["outcome"] == "swapped" && b["outcome"] == "swapped"
    })
    .await;
    let chain: Value = serde_json::from_slice(&std::fs::read(w.zec_file()).unwrap()).unwrap();
    assert_eq!(
        chain["balances"]["user-z"], 100_000_000,
        "the sweep paid user-z"
    );
    assert_eq!(chain["balances"]["bram"], 0, "not the sweeper's own wallet");
    let (code, _) = w.post(&user, "/api/swaps", leg).await;
    assert_eq!(code, 409, "a finished swap keeps its label");

    // B's record can't be written: refused, nothing in memory or on disk.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let swaps = w._dir.path().join("bram").join("swaps");
        let before = std::fs::read_dir(&swaps).unwrap().count();
        std::fs::set_permissions(&swaps, std::fs::Permissions::from_mode(0o500)).unwrap();
        let (code, body) = w
            .post(
                &user,
                "/api/swaps",
                json!({"maker": maker, "zec_zat": 100_000_000u64, "route": "r8/1"}),
            )
            .await;
        std::fs::set_permissions(&swaps, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(code, 500, "{body}");
        assert_eq!(
            w.get(&user, "/api/swaps").await.as_array().unwrap().len(),
            1
        );
        assert_eq!(std::fs::read_dir(&swaps).unwrap().count(), before);
    }
}
