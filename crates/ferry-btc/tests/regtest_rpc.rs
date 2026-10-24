//! The RPC client against a real node: wallet addresses, lock funding and the watch-only
//! wallet. Bitcoin by default (`spikes/btc/scripts/regtest.sh start`, 127.0.0.1:18543);
//! `FERRY_CHAIN=ltc` runs it against litecoind (`infra/ltc/regtest.sh start`, 127.0.0.1:19443).
//! Override the URL with FERRY_BTC_RPC.
//!
//! Run: `cargo test -p ferry-btc --test regtest_rpc -- --ignored`

use ferry_btc::bitcoin::{key::Secp256k1, Address, Amount, Network, OutPoint};
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

/// The fee-bump primitives against a real node: the floors, a CPFP child of an owned output,
/// the exact incremental fee a replacement needs, the node's own `maxfeerate` guard, a locked
/// coin, and (Bitcoin only) a parent the mempool does not hold, sent with its child as a package.
#[tokio::test]
#[ignore = "needs a regtest node (spikes/btc/scripts/regtest.sh or infra/ltc/regtest.sh)"]
async fn child_bump_primitives() {
    use ferry_btc::child::{build_child, fee_for, vsize_bound, ChildError, ChildLimits};

    let coin = coin();
    let suffix = BtcKey::random().xonly().to_string();
    let rpc = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet(format!("ferry-btc-it-bump-{}", &suffix[..8]))
        .with_coin(coin);
    rpc.ensure_wallet().await.expect("node up?");
    let net = Network::Regtest;
    let miner = rpc.new_address(net).await.unwrap();
    let elsewhere = Address::p2tr(&Secp256k1::new(), BtcKey::random().xonly(), None, net);
    rpc.generate_to_address(3, &miner).await.unwrap();
    rpc.generate_to_address(100, &elsewhere).await.unwrap();

    let floors = rpc.fee_floors().await.unwrap();
    println!("{coin}: floors {floors:?}");
    assert!(floors.min_relay > 0 && floors.incremental > 0);
    assert!(floors.floor() >= floors.min_relay);

    // The parent: a payment to an address of ours at 2 sat/vB, the way a redeem pays Z's own
    // wallet address.
    let own = rpc.new_address(net).await.unwrap();
    let own_spk = own.script_pubkey();
    let parent = rpc
        .fund_payment(&own, Amount::from_sat(2_000_000), 2)
        .await
        .unwrap();
    let vout = parent
        .tx
        .output
        .iter()
        .position(|o| o.script_pubkey == own_spk)
        .unwrap() as u32;
    let parent_txid = parent.tx.compute_txid();
    assert_eq!(rpc.mempool_entry(&parent_txid).await.unwrap(), None);
    rpc.broadcast(&parent.tx).await.unwrap();
    let e = rpc.mempool_entry(&parent_txid).await.unwrap().unwrap();
    assert_eq!(e.base_fee, parent.fee);
    assert!(e.spent_by.is_empty() && e.depends.is_empty());

    let limits = ChildLimits {
        max_fee: Amount::from_sat(100_000),
        max_fee_rate: 100_000, // 100 sat/vB
    };
    let dest1 = rpc.new_address(net).await.unwrap().script_pubkey();
    let bound = vsize_bound(&own_spk, &dest1).unwrap();
    let fee1 = fee_for(10_000, bound); // 10 sat/vB
                                       // A coin the wallet has locked is refused; unlocked it builds.
    let spent = OutPoint {
        txid: parent_txid,
        vout,
    };
    assert!(rpc.lock_coins(&[spent]).await.unwrap().is_empty());
    assert!(matches!(
        build_child(&rpc, &parent.tx, vout, &dest1, Amount::from_sat(fee1), coin, &limits).await,
        Err(ChildError::LockedCoin(o)) if o == spent
    ));
    rpc.unlock_coins(&[spent]).await.unwrap();
    // Unlocked again, the same child builds (not sent: the real one follows).
    build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest1,
        Amount::from_sat(fee1),
        coin,
        &limits,
    )
    .await
    .unwrap();

    let c1 = build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest1,
        Amount::from_sat(fee1),
        coin,
        &limits,
    )
    .await
    .unwrap();
    assert!(c1.vsize <= bound);
    let verdict = rpc
        .test_accept(std::slice::from_ref(&c1.tx), Some(limits.max_fee_rate))
        .await
        .unwrap();
    assert!(verdict[0].allowed, "{verdict:?}");
    assert_eq!(verdict[0].vsize, Some(c1.vsize));
    assert_eq!(verdict[0].fee, Some(c1.fee));
    let c1_txid = rpc
        .broadcast_capped(&c1.tx, limits.max_fee_rate)
        .await
        .unwrap();
    let e = rpc.mempool_entry(&parent_txid).await.unwrap().unwrap();
    assert_eq!(e.spent_by, vec![c1_txid]);
    assert_eq!(e.descendant_fee, parent.fee + c1.fee);
    assert_eq!(e.descendant_vsize, e.vsize + c1.vsize);

    // A replacement of the child (same input) must add `incremental x its own size`: one
    // satoshi less is refused, exactly that is taken.
    let dest2 = rpc.new_address(net).await.unwrap().script_pubkey();
    let need = fee1 + fee_for(floors.incremental, c1.vsize);
    let low = build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest2,
        Amount::from_sat(need - 1),
        coin,
        &limits,
    )
    .await
    .unwrap();
    let verdict = rpc
        .test_accept(std::slice::from_ref(&low.tx), None)
        .await
        .unwrap();
    println!("{coin}: one satoshi short of the replacement rule: {verdict:?}");
    assert!(!verdict[0].allowed, "{verdict:?}");
    assert!(rpc.broadcast(&low.tx).await.is_err());
    let c2 = build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest2,
        Amount::from_sat(need),
        coin,
        &limits,
    )
    .await
    .unwrap();
    let verdict = rpc
        .test_accept(std::slice::from_ref(&c2.tx), None)
        .await
        .unwrap();
    assert!(
        verdict[0].allowed,
        "exactly the incremental fee: {verdict:?}"
    );
    let c2_txid = rpc.broadcast(&c2.tx).await.unwrap();
    assert_eq!(rpc.mempool_entry(&c1_txid).await.unwrap(), None, "replaced");
    let e = rpc.mempool_entry(&parent_txid).await.unwrap().unwrap();
    assert_eq!(e.spent_by, vec![c2_txid]);
    assert_eq!(e.descendant_fee, parent.fee + Amount::from_sat(need));

    // The builder refuses a rate above its cap before anything reaches the node, and the node's
    // own maxfeerate refuses what the builder was allowed to build.
    let strict = ChildLimits {
        max_fee_rate: 100_000,
        max_fee: Amount::from_sat(1_000_000),
    };
    let dest3 = rpc.new_address(net).await.unwrap().script_pubkey();
    assert!(matches!(
        build_child(
            &rpc,
            &parent.tx,
            vout,
            &dest3,
            Amount::from_sat(50_000),
            coin,
            &strict
        )
        .await,
        Err(ChildError::RateAboveCap { .. })
    ));
    let loose = ChildLimits {
        max_fee_rate: 10_000_000,
        max_fee: Amount::from_sat(1_000_000),
    };
    let rich = build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest3,
        Amount::from_sat(50_000),
        coin,
        &loose,
    )
    .await
    .unwrap();
    let verdict = rpc
        .test_accept(std::slice::from_ref(&rich.tx), Some(strict.max_fee_rate))
        .await
        .unwrap();
    assert!(!verdict[0].allowed, "{verdict:?}");
    assert_eq!(
        verdict[0].reject_reason.as_deref(),
        Some("max-fee-exceeded")
    );
    assert!(rpc
        .broadcast_capped(&rich.tx, strict.max_fee_rate)
        .await
        .is_err());
    // The fee cap, in sat.
    let tight = ChildLimits {
        max_fee: Amount::from_sat(1_000),
        max_fee_rate: 10_000_000,
    };
    assert!(matches!(
        build_child(
            &rpc,
            &parent.tx,
            vout,
            &dest3,
            Amount::from_sat(1_001),
            coin,
            &tight
        )
        .await,
        Err(ChildError::FeeAboveCap { .. })
    ));

    // Both confirm in the next block.
    rpc.generate_to_address(1, &miner).await.unwrap();
    assert_eq!(rpc.confirmations(&parent_txid).await.unwrap(), Some(1));
    assert_eq!(rpc.confirmations(&c2_txid).await.unwrap(), Some(1));
    assert_eq!(rpc.mempool_entry(&parent_txid).await.unwrap(), None);

    // A parent the node does not hold: its child alone is missing inputs; with Bitcoin the two
    // go in as one package, and the wallet signs the child from the output handed to it.
    let own2 = rpc.new_address(net).await.unwrap();
    let p2 = rpc
        .fund_payment(&own2, Amount::from_sat(1_500_000), 2)
        .await
        .unwrap();
    let vout2 = p2
        .tx
        .output
        .iter()
        .position(|o| o.script_pubkey == own2.script_pubkey())
        .unwrap() as u32;
    let dest4 = rpc.new_address(net).await.unwrap().script_pubkey();
    let orphan = build_child(
        &rpc,
        &p2.tx,
        vout2,
        &dest4,
        Amount::from_sat(fee1),
        coin,
        &limits,
    )
    .await
    .unwrap();
    let alone = rpc
        .test_accept(std::slice::from_ref(&orphan.tx), None)
        .await
        .unwrap();
    assert!(!alone[0].allowed);
    assert_eq!(alone[0].reject_reason.as_deref(), Some("missing-inputs"));
    if coin.supports_packages() {
        let tested = rpc
            .test_accept(&[p2.tx.clone(), orphan.tx.clone()], None)
            .await
            .unwrap();
        assert!(tested.iter().all(|r| r.allowed), "{tested:?}");
        let sent = rpc
            .submit_package(
                &[p2.tx.clone(), orphan.tx.clone()],
                Some(limits.max_fee_rate),
            )
            .await
            .unwrap();
        assert!(sent.success, "{sent:?}");
        assert!(rpc
            .mempool_entry(&p2.tx.compute_txid())
            .await
            .unwrap()
            .is_some());
        assert!(rpc
            .mempool_entry(&orphan.tx.compute_txid())
            .await
            .unwrap()
            .is_some());
    } else {
        assert!(matches!(
            rpc.submit_package(&[p2.tx.clone(), orphan.tx.clone()], None)
                .await,
            Err(ferry_btc::rpc::PackageError::Unsupported)
        ));
    }
    println!("{coin}: child bump primitives verified (floors {floors:?})");
}
