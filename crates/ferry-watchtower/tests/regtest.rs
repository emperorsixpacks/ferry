//! The tower against a real bitcoind (regtest, no -txindex), with the owner offline after
//! uploading its package and broadcasting the lock.
//!
//! Needs `crates/ferry-watchtower/scripts/regtest.sh start` (container ferry-wt-regtest, RPC
//! 127.0.0.1:18943, ferry/ferry; override with FERRY_WT_BTC_RPC). Towers listen on 7701-7709.
//! Run: `cargo test -p ferry-watchtower --test regtest -- --ignored --test-threads=1`
//!
//! `FERRY_CHAIN=ltc` runs the same tests against litecoind (`infra/ltc/regtest.sh start`, RPC
//! 127.0.0.1:19443 unless FERRY_WT_BTC_RPC says otherwise), with the legacy watch-only wallet.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ferry_btc::bitcoin::{Address, Amount, Network, OutPoint, Txid};
use ferry_btc::rpc::BitcoinRpc;
use ferry_btc::{Chain, Coin, Spend};
use ferry_watchtower::package::testkit::Swap;
use ferry_watchtower::{Client, ClientError, Outcome, PackageView, Status, Tower, TowerConfig};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const T1: u16 = 6;
const T2: u16 = 10;
const K: u32 = 2;
const DELTA: u16 = 3;
const POLL: Duration = Duration::from_millis(100);

fn coin() -> Coin {
    std::env::var("FERRY_CHAIN")
        .ok()
        .map(|c| c.parse().expect("FERRY_CHAIN is btc or ltc"))
        .unwrap_or_default()
}

fn url() -> String {
    std::env::var("FERRY_WT_BTC_RPC").unwrap_or_else(|_| match coin() {
        Coin::Btc => "http://127.0.0.1:18943".into(),
        Coin::Ltc => "http://127.0.0.1:19443".into(),
    })
}

fn rpc() -> BitcoinRpc {
    BitcoinRpc::new(url(), "ferry", "ferry").with_coin(coin())
}

fn offline_swap() -> Swap {
    Swap::offline_on(coin(), T1, T2)
}

struct Node {
    miner: BitcoinRpc,
    /// Reads through the tower's watch wallet (the node has no -txindex).
    watch: BitcoinRpc,
    to: Address,
}

impl Node {
    async fn new(watch_wallet: &str) -> Node {
        let miner = rpc().with_wallet("ferry-wt-miner");
        miner
            .ensure_wallet()
            .await
            .expect("bitcoind up? (crates/ferry-watchtower/scripts/regtest.sh start)");
        let to = miner.new_address(Network::Regtest).await.unwrap();
        if miner.balance().await.unwrap() < Amount::from_btc(3.0).unwrap() {
            miner.generate_to_address(101, &to).await.unwrap();
        }
        let watch = rpc()
            .with_wallet(watch_wallet)
            .with_watch_wallet(watch_wallet);
        Node { miner, watch, to }
    }

    async fn mine(&self, n: u64) {
        self.miner.generate_to_address(n, &self.to).await.unwrap();
    }

    async fn height(&self, txid: &Txid) -> u64 {
        self.watch
            .block_height(txid)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("{txid} not mined"))
    }

    /// Fund the swap's lock (signed, not broadcast) and point the templates at it.
    async fn fund(&self, swap: &mut Swap) -> ferry_btc::bitcoin::Transaction {
        let amount = Amount::from_btc(0.5).unwrap();
        let lock = self
            .miner
            .fund_lock(&swap.lock_address(), amount)
            .await
            .unwrap();
        swap.set_lock(
            OutPoint {
                txid: lock.tx.compute_txid(),
                vout: lock.vout,
            },
            amount,
        );
        lock.tx
    }
}

struct Running {
    stop: oneshot::Sender<()>,
    handle: JoinHandle<std::io::Result<()>>,
    client: Client,
}

async fn start_tower(port: u16, data_dir: &Path, wallet: &str, token: Option<&str>) -> Running {
    let rpc = rpc().with_wallet(wallet).with_watch_wallet(wallet);
    let cfg = TowerConfig {
        chain: Chain::new(coin(), Network::Regtest).unwrap(),
        data_dir: data_dir.to_path_buf(),
        token: token.map(String::from),
        poll: POLL,
        rescan_secs: 3600,
    };
    let tower: Arc<Tower> = Tower::open(cfg, rpc).await.unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    let (stop, rx) = oneshot::channel();
    let handle = tokio::spawn(ferry_watchtower::serve(tower, listener, async {
        let _ = rx.await;
    }));
    Running {
        stop,
        handle,
        client: Client::new(format!("http://127.0.0.1:{port}"), token.map(String::from)),
    }
}

impl Running {
    async fn shutdown(self) {
        let _ = self.stop.send(());
        self.handle.await.unwrap().unwrap();
    }
}

/// Let the tower poll a few times.
async fn settle() {
    tokio::time::sleep(POLL * 5).await;
}

/// Mine one block at a time (letting the tower act) until `done` holds for every view.
async fn mine_until(
    node: &Node,
    client: &Client,
    ids: &[&str],
    max: u32,
    done: impl Fn(&[PackageView]) -> bool,
) -> Vec<PackageView> {
    for _ in 0..=max {
        settle().await;
        let mut views = vec![];
        for id in ids {
            views.push(client.status(id).await.unwrap());
        }
        if done(&views) {
            return views;
        }
        node.mine(1).await;
    }
    let mut views = vec![];
    for id in ids {
        views.push(client.status(id).await.unwrap());
    }
    panic!("condition not reached: {views:#?}");
}

fn sent(view: &PackageView, spend: Spend) -> Vec<&ferry_watchtower::store::BroadcastLog> {
    view.broadcasts
        .iter()
        .filter(|b| b.spend == spend && b.error.is_none())
        .collect()
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (crates/ferry-watchtower/scripts/regtest.sh start)"]
async fn b_offline_tower_cancels_and_refunds() {
    let wallet = "ferry-wt-watch-refund";
    let node = Node::new(wallet).await;
    let mut swap = offline_swap();
    let lock_tx = node.fund(&mut swap).await;
    let dir = tempfile::tempdir().unwrap();
    let tower = start_tower(7701, dir.path(), wallet, Some("s3cret")).await;

    // Uploads are authenticated and validated.
    let anon = Client::new("http://127.0.0.1:7701", None);
    let err = anon.upload(&swap.b_package(K, DELTA)).await.unwrap_err();
    assert!(
        matches!(err, ClientError::Refused { status: 401, .. }),
        "{err}"
    );
    let mut bad = swap.b_package(K, DELTA);
    bad.payout_addresses = vec![swap.z_payout.to_string()];
    let err = tower.client.upload(&bad).await.unwrap_err();
    assert!(
        matches!(&err, ClientError::Refused { status: 400, message } if message.contains("payout")),
        "{err}"
    );

    // B uploads at CancelSigned, before the lock is broadcast. Z arms its own package too.
    let b = tower
        .client
        .upload(&swap.b_package(K, DELTA))
        .await
        .unwrap();
    assert!(b.created && b.status == Status::Armed);
    let again = tower
        .client
        .upload(&swap.b_package(K, DELTA))
        .await
        .unwrap();
    assert_eq!((again.id.as_str(), again.created), (b.id.as_str(), false));
    let z = tower
        .client
        .upload(&swap.z_package(K, DELTA))
        .await
        .unwrap();
    settle().await;
    let view = tower.client.status(&b.id).await.unwrap();
    assert_eq!(view.status, Status::Armed);
    assert!(view.note.contains("waiting for the lock"), "{}", view.note);

    // B's last act: broadcast the lock. From here on nobody but the tower touches the swap.
    node.miner.broadcast(&lock_tx).await.unwrap();
    let views = mine_until(&node, &tower.client, &[&b.id, &z.id], 40, |v| {
        v.iter().all(|v| v.status == Status::Done)
    })
    .await;
    let (bv, zv) = (&views[0], &views[1]);
    assert_eq!(bv.outcome, Some(Outcome::Refunded), "{bv:#?}");
    assert_eq!(
        zv.outcome,
        Some(Outcome::Refunded),
        "Z's package stops at B's refund"
    );
    assert!(
        sent(zv, Spend::Punish).is_empty(),
        "no punish after a refund"
    );

    // The timing rules held on chain.
    let lock_h = node.height(&swap.txs.lock_outpoint.txid).await;
    let cancel_h = node.height(&swap.txs.txid(Spend::Cancel)).await;
    let refund_h = node.height(&swap.txs.txid(Spend::Refund)).await;
    assert!(cancel_h - lock_h >= u64::from(T1));
    assert!(
        refund_h - cancel_h >= u64::from(K),
        "refund only after k cancel confirmations ({cancel_h} → {refund_h})"
    );
    assert!(refund_h - cancel_h <= u64::from(T2 - DELTA));
    let refund_log = sent(bv, Spend::Refund);
    assert_eq!(refund_log.len(), 1, "{bv:#?}");
    let at = refund_log[0].cancel_confs.unwrap();
    assert!(
        at >= K && at < u32::from(T2 - DELTA),
        "sent at {at} cancel confs"
    );
    assert_eq!(
        sent(bv, Spend::Cancel).len() + sent(zv, Spend::Cancel).len(),
        1
    );

    // The refund paid B's address.
    let out: serde_json::Value = node
        .miner
        .call(
            "gettxout",
            serde_json::json!([swap.txs.txid(Spend::Refund).to_string(), 0]),
        )
        .await
        .unwrap();
    assert_eq!(
        out["scriptPubKey"]["hex"],
        swap.b_payout.script_pubkey().to_hex_string()
    );
    tower.shutdown().await;
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (crates/ferry-watchtower/scripts/regtest.sh start)"]
async fn z_offline_tower_cancels_and_punishes_across_a_restart() {
    let wallet = "ferry-wt-watch-punish";
    let node = Node::new(wallet).await;
    let mut swap = offline_swap();
    let lock_tx = node.fund(&mut swap).await;
    let dir = tempfile::tempdir().unwrap();
    let tower = start_tower(7702, dir.path(), wallet, None).await;
    let z = tower
        .client
        .upload(&swap.z_package(K, DELTA))
        .await
        .unwrap();
    // B locks, then B and Z both vanish: only Z's tower is left.
    node.miner.broadcast(&lock_tx).await.unwrap();
    mine_until(&node, &tower.client, &[&z.id], 20, |v| {
        v[0].status >= Status::CancelBroadcast
    })
    .await;
    node.mine(2).await;

    // The tower restarts from its data dir and carries on.
    tower.shutdown().await;
    let tower = start_tower(7703, dir.path(), wallet, None).await;
    let view = tower.client.status(&z.id).await.unwrap();
    assert_eq!(view.status, Status::CancelBroadcast);

    let views = mine_until(&node, &tower.client, &[&z.id], 20, |v| {
        v[0].status == Status::Done
    })
    .await;
    let zv = &views[0];
    assert_eq!(zv.outcome, Some(Outcome::Punished), "{zv:#?}");
    let cancel_h = node.height(&swap.txs.txid(Spend::Cancel)).await;
    let punish_h = node.height(&swap.txs.txid(Spend::Punish)).await;
    assert!(punish_h - cancel_h >= u64::from(T2));
    let punish_log = sent(zv, Spend::Punish);
    assert_eq!(punish_log.len(), 1);
    assert!(punish_log[0].cancel_confs.unwrap() >= u32::from(T2));
    let out: serde_json::Value = node
        .miner
        .call(
            "gettxout",
            serde_json::json!([swap.txs.txid(Spend::Punish).to_string(), 0]),
        )
        .await
        .unwrap();
    assert_eq!(
        out["scriptPubKey"]["hex"],
        swap.z_payout.script_pubkey().to_hex_string()
    );
    tower.shutdown().await;
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (crates/ferry-watchtower/scripts/regtest.sh start)"]
async fn redeem_stops_both_towers() {
    let wallet = "ferry-wt-watch-redeem";
    let node = Node::new(wallet).await;
    let mut swap = offline_swap();
    let lock_tx = node.fund(&mut swap).await;
    let dir = tempfile::tempdir().unwrap();
    let tower = start_tower(7704, dir.path(), wallet, None).await;
    let b = tower
        .client
        .upload(&swap.b_package(K, DELTA))
        .await
        .unwrap();
    let z = tower
        .client
        .upload(&swap.z_package(K, DELTA))
        .await
        .unwrap();
    node.miner.broadcast(&lock_tx).await.unwrap();
    node.mine(2).await;
    // Z redeems well before T1 − Δ.
    node.miner.broadcast(&swap.redeem()).await.unwrap();
    settle().await;
    let view = tower.client.status(&b.id).await.unwrap();
    assert_eq!(
        (view.status, view.outcome),
        (Status::Armed, None),
        "mempool spend: hold"
    );
    let views = mine_until(&node, &tower.client, &[&b.id, &z.id], 3, |v| {
        v.iter().all(|v| v.status == Status::Done)
    })
    .await;
    for v in &views {
        assert_eq!(v.outcome, Some(Outcome::Redeemed));
    }
    // Well past T1 and T2: still nothing broadcast.
    node.mine(u64::from(T1 + T2) + 2).await;
    settle().await;
    for id in [&b.id, &z.id] {
        let v = tower.client.status(id).await.unwrap();
        assert!(v.broadcasts.is_empty(), "{v:#?}");
    }
    tower.shutdown().await;
}
