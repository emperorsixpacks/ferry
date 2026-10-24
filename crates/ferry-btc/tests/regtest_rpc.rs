//! The RPC client against a real node: wallet addresses, lock funding and the watch-only
//! wallet. Bitcoin by default (`spikes/btc/scripts/regtest.sh start`, 127.0.0.1:18543);
//! `FERRY_CHAIN=ltc` runs it against litecoind (`infra/ltc/regtest.sh start`, 127.0.0.1:19443).
//! Override the URL with FERRY_BTC_RPC.
//!
//! Run: `cargo test -p ferry-btc --test regtest_rpc -- --ignored`

use ferry_btc::bitcoin::{key::Secp256k1, Address, Amount, Network};
use ferry_btc::rpc::BitcoinRpc;
use ferry_btc::{BtcKey, Chain, Coin};
use serde_json::{json, Value};

fn coin() -> Coin {
    std::env::var("FERRY_CHAIN")
        .unwrap_or_else(|_| "btc".into())
        .parse()
        .unwrap()
}

fn url(coin: Coin) -> String {
    std::env::var("FERRY_BTC_RPC").unwrap_or_else(|_| {
        match coin {
            Coin::Btc => "http://127.0.0.1:18543",
            Coin::Ltc => "http://127.0.0.1:19443",
        }
        .into()
    })
}

#[tokio::test]
#[ignore = "needs a regtest node (spikes/btc/scripts/regtest.sh or infra/ltc/regtest.sh)"]
async fn wallet_lock_and_watch_wallet() {
    let coin = coin();
    let chain = Chain::new(coin, Network::Regtest).unwrap();
    let suffix = BtcKey::random().xonly().to_string();
    let watch_name = format!("ferry-btc-it-watch-{}", &suffix[..8]);
    let rpc = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet("ferry-btc-it")
        .with_watch_wallet(watch_name.clone())
        .with_coin(coin);
    rpc.ensure_wallet().await.expect("node up?");
    rpc.ensure_watch_wallet().await.unwrap();

    let miner = rpc.new_address(Network::Regtest).await.unwrap();
    if rpc.balance().await.unwrap() < Amount::from_btc(1.0).unwrap() {
        rpc.generate_to_address(101, &miner).await.unwrap();
    }
    let labeled = rpc
        .labeled_address("ferry-it", Network::Regtest)
        .await
        .unwrap();
    assert_eq!(
        rpc.labeled_address("ferry-it", Network::Regtest)
            .await
            .unwrap(),
        labeled
    );
    // What the node calls the address is what Chain encodes.
    let info: Value = rpc
        .wallet_call("getaddressinfo", json!([chain.encode_address(&labeled)]))
        .await
        .unwrap();
    assert_eq!(info["ismine"], json!(true), "{info}");

    // A Taproot output the wallet does not own, watched before it is funded.
    let lock = Address::p2tr(
        &Secp256k1::new(),
        BtcKey::random().xonly(),
        None,
        Network::Regtest,
    );
    rpc.watch_address(&lock, 3600).await.unwrap();
    let funded = rpc
        .fund_lock(&lock, Amount::from_sat(1_000_000))
        .await
        .unwrap();
    let txid = rpc.broadcast(&funded.tx).await.unwrap();
    assert_eq!(rpc.confirmations(&txid).await.unwrap(), Some(0));
    rpc.generate_to_address(1, &miner).await.unwrap();
    assert_eq!(rpc.confirmations(&txid).await.unwrap(), Some(1));
    assert_eq!(
        rpc.block_height(&txid).await.unwrap(),
        Some(rpc.block_count().await.unwrap())
    );

    // The watch-only wallet itself knows the transaction (not just -txindex).
    let watch = BitcoinRpc::new(url(coin), "ferry", "ferry").with_wallet(watch_name);
    let tx: Value = watch
        .wallet_call("gettransaction", json!([txid.to_string(), true]))
        .await
        .unwrap();
    assert_eq!(tx["confirmations"], json!(1), "{tx}");
    println!(
        "{coin}: lock {} paid in {txid}",
        chain.encode_address(&lock)
    );
}

/// Two locks funded before either is broadcast never pick the same coin: the wallet locks what
/// each one picked, the spendable balance leaves those coins out, a lock lost across a node
/// restart can be locked again, and an unlocked coin is spendable again.
#[tokio::test]
#[ignore = "needs a regtest node (spikes/btc/scripts/regtest.sh or infra/ltc/regtest.sh)"]
async fn unbroadcast_locks_never_share_coins() {
    use std::collections::HashSet;
    let coin = coin();
    let suffix = BtcKey::random().xonly().to_string();
    let rpc = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet(format!("ferry-btc-it-locks-{}", &suffix[..8]))
        .with_coin(coin);
    rpc.ensure_wallet().await.expect("node up?");
    let miner = rpc.new_address(Network::Regtest).await.unwrap();
    let elsewhere = || {
        Address::p2tr(
            &Secp256k1::new(),
            BtcKey::random().xonly(),
            None,
            Network::Regtest,
        )
    };
    // Three coinbase coins of its own, matured by blocks paying someone else.
    rpc.generate_to_address(3, &miner).await.unwrap();
    rpc.generate_to_address(100, &elsewhere()).await.unwrap();
    let before = rpc.spendable_balance().await.unwrap();
    assert!(before > Amount::ZERO);
    assert!(rpc.locked_coins().await.unwrap().is_empty());

    let amount = Amount::from_sat(1_000_000);
    let a = rpc.fund_lock(&elsewhere(), amount).await.unwrap();
    let b = rpc.fund_lock(&elsewhere(), amount).await.unwrap();
    let ins = |t: &ferry_btc::bitcoin::Transaction| -> HashSet<_> {
        t.input.iter().map(|i| i.previous_output).collect()
    };
    assert!(
        ins(&a.tx).is_disjoint(&ins(&b.tx)),
        "two locks share a coin"
    );
    let locked: HashSet<_> = rpc.locked_coins().await.unwrap().into_iter().collect();
    assert!(locked.is_superset(&ins(&a.tx)) && locked.is_superset(&ins(&b.tx)));
    // getbalance still counts the locked coins; the spendable balance does not.
    assert_eq!(rpc.balance().await.unwrap(), before);
    assert!(rpc.spendable_balance().await.unwrap() < before);

    // Lost locks (a node restart) come back, and locking or unlocking twice is harmless.
    let a_in: Vec<_> = ins(&a.tx).into_iter().collect();
    rpc.unlock_coins(&a_in).await.unwrap();
    rpc.unlock_coins(&a_in).await.unwrap();
    assert!(rpc.lock_coins(&a_in).await.unwrap().is_empty());
    assert!(rpc.lock_coins(&a_in).await.unwrap().is_empty());
    // A third lock now has one coin left, which neither of the others uses.
    let c = rpc.fund_lock(&elsewhere(), amount).await.unwrap();
    assert!(ins(&c.tx).is_disjoint(&ins(&a.tx)) && ins(&c.tx).is_disjoint(&ins(&b.tx)));
    assert_eq!(rpc.spendable_balance().await.unwrap(), Amount::ZERO);
    assert!(
        rpc.fund_lock(&elsewhere(), amount).await.is_err(),
        "a fourth lock finds no free coin"
    );

    // B's lock goes out (its coins are spent, its change is ours); A and C are abandoned and
    // unlocked, so their coins are spendable again.
    rpc.broadcast(&b.tx).await.unwrap();
    rpc.unlock_coins(&a_in).await.unwrap();
    rpc.unlock_coins(&ins(&c.tx).into_iter().collect::<Vec<_>>())
        .await
        .unwrap();
    assert!(rpc.locked_coins().await.unwrap().is_empty());
    let after = rpc.spendable_balance().await.unwrap();
    assert!(
        after < before && after + amount * 2 > before,
        "{after} vs {before}"
    );
    println!("{coin}: three unbroadcast locks used disjoint coins; spendable {before} -> {after}");
}
