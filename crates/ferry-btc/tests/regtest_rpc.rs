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
