//! The EVM tower against FerryLock on a local anvil (127.0.0.1:18545), with the owners offline
//! after uploading: registration checks against the chain, B's refund inside [t1, t2 − Δ),
//! nothing after t2 − Δ, Z's punish from t2, and nothing for a swap already claimed. The tower
//! pays the gas from its own account. Its HTTP API listens on 127.0.0.1:7707.
//!
//! Spawns `anvil` from PATH or ~/.foundry/bin and kills it (by its own child handle) at the end.
//! Without an anvil binary the test prints a note and passes. Install: `foundryup`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use alloy::node_bindings::{Anvil, AnvilInstance};
use alloy::providers::{Provider, ProviderBuilder};
use ferry_evm::bindings::{FerryLock, MockUSDC};
use ferry_evm::{sign_ready, Address, EvmClient, PrivateKeySigner, SwapState, B256, U256};
use ferry_watchtower::evm::{EvmCall, EvmTerms, Share, EVM_PACKAGE_VERSION};
use ferry_watchtower::package::testkit::Swap as BtcSwap;
use ferry_watchtower::tower::RegisterError;
use ferry_watchtower::{
    Client, ClientError, Counter, EvmPackage, EvmTower, EvmTowerConfig, Outcome, Status,
};
use rand::RngCore;

const PORT: u16 = 18545;
const API_PORT: u16 = 7707;
const AMOUNT: u64 = 250_000_000;
const DELTA: u64 = 60;
// Accounts: 0 deployer, 1 B, 2 Z, 3 the tower's gas account.
const B: usize = 1;
const Z: usize = 2;
const TOWER: usize = 3;

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

struct Net {
    _anvil: AnvilInstance,
    url: String,
    keys: Vec<PrivateKeySigner>,
    lock: Address,
    usdc: Address,
    chain_id: u64,
}

/// One locked swap: its id, terms and both shares.
struct Locked {
    id: B256,
    terms: EvmTerms,
    b: [u8; 32],
    z: [u8; 32],
}

impl Net {
    fn client(&self, i: usize) -> EvmClient {
        EvmClient::connect_http(&self.url, self.lock, self.keys[i].clone()).unwrap()
    }

    async fn now(&self) -> u64 {
        self.client(0).latest_timestamp().await.unwrap()
    }

    /// The next block has timestamp `ts`, and is mined now.
    async fn warp(&self, ts: u64) {
        let c = self.client(0);
        let p = c.provider();
        p.raw_request::<_, serde_json::Value>("evm_setNextBlockTimestamp".into(), (ts,))
            .await
            .unwrap();
        p.raw_request::<_, serde_json::Value>("evm_mine".into(), ())
            .await
            .unwrap();
    }

    async fn balance(&self, who: Address) -> u64 {
        self.client(0)
            .token_balance(self.usdc, who)
            .await
            .unwrap()
            .to::<u64>()
    }

    async fn tower_nonce(&self) -> u64 {
        self.client(0)
            .provider()
            .get_transaction_count(self.keys[TOWER].address())
            .await
            .unwrap()
    }

    /// B locks a fresh swap with t1 = now + 100 and t2 = t1 + 300.
    async fn lock_swap(&self) -> Locked {
        let (zs, bs) = (PrivateKeySigner::random(), PrivateKeySigner::random());
        let t1 = self.now().await + 100;
        let terms = EvmTerms {
            token: self.usdc,
            amount: U256::from(AMOUNT),
            z_addr: zs.address(),
            b_addr: bs.address(),
            claimer: self.keys[Z].address(),
            refunder: self.keys[B].address(),
            t1,
            t2: t1 + 300,
            max_tip: U256::ZERO,
        };
        let mut salt = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut salt);
        let (id, _) = self
            .client(B)
            .lock(B256::from(salt), &terms.to_chain())
            .await
            .unwrap();
        Locked {
            id,
            terms,
            b: bs.to_bytes().0,
            z: zs.to_bytes().0,
        }
    }

    fn package(&self, s: &Locked, role: ferry_btc::Role) -> EvmPackage {
        let (b, payout) = match role {
            ferry_btc::Role::B => (Some(Share::new(s.b)), self.keys[B].address()),
            ferry_btc::Role::Z => (None, self.keys[Z].address()),
        };
        EvmPackage {
            version: EVM_PACKAGE_VERSION,
            counter: Counter::Evm,
            role,
            chain_id: self.chain_id,
            contract: self.lock,
            swap_id: s.id,
            terms: s.terms.clone(),
            refund_margin: DELTA,
            b,
            payout_addresses: vec![payout],
            label: None,
        }
    }
}

async fn start() -> Option<Net> {
    let Some(bin) = anvil_binary() else {
        eprintln!("SKIP: no anvil binary (install with foundryup)");
        return None;
    };
    let anvil = Anvil::at(bin).port(PORT).spawn();
    let keys: Vec<PrivateKeySigner> = anvil.keys().iter().map(|k| k.clone().into()).collect();
    let url = anvil.endpoint();
    let deployer = ProviderBuilder::new()
        .wallet(keys[0].clone())
        .connect_http(url.parse().unwrap());
    let usdc = MockUSDC::deploy(&deployer).await.unwrap();
    let lock = FerryLock::deploy(&deployer).await.unwrap();
    usdc.mint(keys[B].address(), U256::from(10 * AMOUNT))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    let chain_id = deployer.get_chain_id().await.unwrap();
    Some(Net {
        _anvil: anvil,
        url,
        keys,
        lock: *lock.address(),
        usdc: *usdc.address(),
        chain_id,
    })
}

async fn open_tower(net: &Net, dir: &std::path::Path) -> Arc<EvmTower> {
    let cfg = EvmTowerConfig {
        data_dir: dir.to_path_buf(),
        token: Some("s3cret".into()),
        poll: Duration::from_millis(100),
        max_lag_secs: 120,
        contracts: vec![],
    };
    let client = EvmClient::connect_http(&net.url, Address::ZERO, net.keys[TOWER].clone()).unwrap();
    EvmTower::open(cfg, client).await.unwrap()
}

/// Poll, and poll again so the tower sees its own call mined (anvil mines on arrival).
async fn polls(tower: &EvmTower) {
    for _ in 0..3 {
        tower.poll_once().await;
    }
}

fn refused(r: Result<ferry_watchtower::Registered, RegisterError>, status: u16, needle: &str) {
    let err = r.unwrap_err();
    assert_eq!(err.http_status(), status, "{err}");
    assert!(
        err.to_string().contains(needle),
        "{err} does not mention {needle:?}"
    );
}

#[tokio::test]
async fn evm_tower_on_anvil() {
    let Some(net) = start().await else { return };
    let dir = tempfile::tempdir().unwrap();
    let tower = open_tower(&net, dir.path()).await;
    use ferry_btc::Role;

    // ------------------------------------------------ registration is checked against the chain
    let a = net.lock_swap().await;
    let mut not_locked = net.package(&a, Role::Z);
    not_locked.swap_id = B256::repeat_byte(9);
    refused(tower.register(not_locked).await, 503, "not on chain yet");
    let mut wrong_t2 = net.package(&a, Role::B);
    wrong_t2.terms.t2 += 10;
    refused(tower.register(wrong_t2).await, 400, "t2 differs");
    let mut wrong_payee = net.package(&a, Role::Z);
    wrong_payee.terms.claimer = net.keys[TOWER].address();
    wrong_payee.payout_addresses = vec![net.keys[TOWER].address()];
    refused(tower.register(wrong_payee).await, 400, "claimer differs");
    let mut not_ferrylock = net.package(&a, Role::Z);
    not_ferrylock.contract = net.usdc;
    refused(tower.register(not_ferrylock).await, 400, "not FerryLock");
    let mut other_chain = net.package(&a, Role::Z);
    other_chain.chain_id = 8453;
    refused(tower.register(other_chain).await, 400, "chain 8453");

    // ------------------------------------------------ swap A: B offline, the tower refunds
    let b_pkg = tower.register(net.package(&a, Role::B)).await.unwrap();
    let z_pkg = tower.register(net.package(&a, Role::Z)).await.unwrap();
    assert!(b_pkg.created && z_pkg.created);
    let again = tower.register(net.package(&a, Role::B)).await.unwrap();
    assert_eq!(
        (again.id.as_str(), again.created),
        (b_pkg.id.as_str(), false)
    );

    polls(&tower).await;
    let v = tower.view(&b_pkg.id).await.unwrap();
    assert_eq!((v.status, v.sends.len()), (Status::Armed, 0), "{v:#?}");
    assert!(v.note.contains("claim window open"), "{}", v.note);
    assert_eq!(net.tower_nonce().await, 0, "nothing sent before t1");

    let refunder_before = net.balance(net.keys[B].address()).await;
    net.warp(a.terms.t1).await;
    polls(&tower).await;
    let bv = tower.view(&b_pkg.id).await.unwrap();
    let zv = tower.view(&z_pkg.id).await.unwrap();
    assert_eq!(bv.outcome, Some(Outcome::Refunded), "{bv:#?}");
    assert_eq!(zv.outcome, Some(Outcome::Refunded), "{zv:#?}");
    assert!(zv.sends.is_empty(), "no punish after a refund");
    let ok: Vec<_> = bv.sends.iter().filter(|s| s.error.is_none()).collect();
    assert_eq!(ok.len(), 1, "{bv:#?}");
    assert_eq!(ok[0].call, EvmCall::Refund);
    assert!(ok[0].block_time >= a.terms.t1 && ok[0].block_time + DELTA < a.terms.t2);
    assert_eq!(
        net.balance(net.keys[B].address()).await - refunder_before,
        AMOUNT,
        "the refund paid B's refunder"
    );
    assert_eq!(net.tower_nonce().await, 1);
    let c = net.client(0);
    assert_eq!(c.swap(a.id).await.unwrap().state, SwapState::Refunded);

    // ------------------------------------------------ swap C: B and Z offline, refund window missed
    let s = net.lock_swap().await;
    let b_late = tower.register(net.package(&s, Role::B)).await.unwrap();
    let z_late = tower.register(net.package(&s, Role::Z)).await.unwrap();
    // The tower only comes back after t2 − Δ: B's refund is held back.
    net.warp(s.terms.t2 - DELTA).await;
    polls(&tower).await;
    let bv = tower.view(&b_late.id).await.unwrap();
    assert!(bv.sends.is_empty(), "{bv:#?}");
    assert!(bv.note.contains("window closed"), "{}", bv.note);
    assert!(tower.view(&z_late.id).await.unwrap().sends.is_empty());
    let claimer_before = net.balance(net.keys[Z].address()).await;
    net.warp(s.terms.t2).await;
    polls(&tower).await;
    let zv = tower.view(&z_late.id).await.unwrap();
    assert_eq!(zv.outcome, Some(Outcome::Punished), "{zv:#?}");
    assert!(zv.sends[0].block_time >= s.terms.t2);
    assert_eq!(
        net.balance(net.keys[Z].address()).await - claimer_before,
        AMOUNT
    );
    let bv = tower.view(&b_late.id).await.unwrap();
    assert_eq!(bv.outcome, Some(Outcome::Punished));
    assert!(bv.sends.is_empty(), "B's refund was never sent");

    // ------------------------------------------------ swap D: claimed, so the tower never acts
    let d = net.lock_swap().await;
    let b_d = tower.register(net.package(&d, Role::B)).await.unwrap();
    let z_d = tower.register(net.package(&d, Role::Z)).await.unwrap();
    let ready = sign_ready(&net.keys[B], net.chain_id, net.lock, d.id);
    net.client(Z)
        .claim(d.id, &d.z, U256::ZERO, &ready)
        .await
        .unwrap();
    let nonce = net.tower_nonce().await;
    net.warp(d.terms.t2 + 10).await;
    polls(&tower).await;
    for id in [&b_d.id, &z_d.id] {
        let v = tower.view(id).await.unwrap();
        assert_eq!(v.outcome, Some(Outcome::Redeemed), "{v:#?}");
        assert!(v.sends.is_empty());
    }
    assert_eq!(
        net.tower_nonce().await,
        nonce,
        "nothing sent for a claimed swap"
    );

    // ------------------------------------------------ the HTTP API, and a restart
    drop(tower);
    let tower = open_tower(&net, dir.path()).await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", API_PORT))
        .await
        .unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, ferry_watchtower::http::router(tower))
            .await
            .unwrap()
    });
    let client = Client::new(
        format!("http://127.0.0.1:{API_PORT}"),
        Some("s3cret".into()),
    );
    let v = client.evm_status(&b_pkg.id).await.unwrap();
    assert_eq!(
        (v.status, v.outcome),
        (Status::Done, Some(Outcome::Refunded))
    );
    let raw = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{API_PORT}/packages/{}", b_pkg.id))
        .bearer_auth("s3cret")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!raw.contains(&hex::encode(a.b)), "the view never shows b");
    // A Bitcoin package on an EVM tower is refused with a reason.
    let btc = BtcSwap::offline(6, 10).z_package(2, 3);
    let err = client.upload(&btc).await.unwrap_err();
    assert!(
        matches!(&err, ClientError::Refused { status: 400, message } if message.contains("this tower watches EVM chain")),
        "{err}"
    );
    // Uploads need the token.
    let anon = Client::new(format!("http://127.0.0.1:{API_PORT}"), None);
    let err = anon.upload(&net.package(&a, Role::Z)).await.unwrap_err();
    assert!(
        matches!(err, ClientError::Refused { status: 401, .. }),
        "{err}"
    );
    let health: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{API_PORT}/health"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["counter"], "evm");
    assert_eq!(health["chain_id"], net.chain_id);
    server.abort();
}
