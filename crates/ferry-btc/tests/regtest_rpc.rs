//! The RPC client against a real node: wallet addresses, lock funding and the watch-only
//! wallet. Bitcoin by default (`infra/btc/regtest.sh start`, 127.0.0.1:18543);
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
#[ignore = "needs a regtest node (infra/btc/regtest.sh or infra/ltc/regtest.sh)"]
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
#[ignore = "needs a regtest node (infra/btc/regtest.sh or infra/ltc/regtest.sh)"]
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
#[ignore = "needs a regtest node (infra/btc/regtest.sh or infra/ltc/regtest.sh)"]
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
    // Bitcoin Core 28.1, and litecoind started with -mempoolreplacement=1, say "insufficient
    // fee". Litecoin Core 0.21.5.6 has replacement OFF by default (-mempoolreplacement=0): it
    // answers "txn-mempool-conflict" to any replacement, so there a child can never be replaced.
    let replaces = verdict[0].reject_reason.as_deref() == Some("insufficient fee");
    if !replaces {
        assert_eq!(coin, Coin::Ltc, "{verdict:?}");
        assert_eq!(
            verdict[0].reject_reason.as_deref(),
            Some("txn-mempool-conflict")
        );
        let c2 = build_child(
            &rpc,
            &parent.tx,
            vout,
            &dest2,
            Amount::from_sat(need + 1_000),
            coin,
            &limits,
        )
        .await
        .unwrap();
        let err = rpc.broadcast(&c2.tx).await.unwrap_err().to_string();
        println!("{coin}: this node does not replace: {err}");
        assert!(err.contains("txn-mempool-conflict"), "{err}");
        println!("{coin}: replacement is off on this node; the rest of the replacement checks are skipped");
        return;
    }
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
    if coin == Coin::Btc {
        assert!(
            verdict[0].allowed,
            "exactly the incremental fee: {verdict:?}"
        );
    }
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

/// Raise the node's mempool floor to at least `sat_per_vb` by filling its mempool (start the
/// node with `-maxmempool=5`, the lowest 28.1 takes) with big transactions at that rate: the node
/// evicts the cheapest and the floor rises above the rate it evicted. `keep` are coins to leave
/// alone. Returns how many fillers it took.
async fn raise_mempool_floor(
    rpc: &BitcoinRpc,
    net: Network,
    sat_per_vb: u64,
    keep: &[OutPoint],
) -> usize {
    let secp = Secp256k1::new();
    let mut sent = 0;
    loop {
        let floors = rpc.fee_floors().await.unwrap();
        if floors.mempool_min >= sat_per_vb * 1000 {
            return sent;
        }
        assert!(sent < 120, "the floor never rose: {floors:?}");
        let coins: Vec<Value> = rpc
            .wallet_call("listunspent", json!([1, 9_999_999, [], false]))
            .await
            .unwrap();
        // A confirmed coin no filler or kept transaction uses yet.
        let coin = coins
            .iter()
            .find(|c| {
                let op = OutPoint {
                    txid: c["txid"].as_str().unwrap().parse().unwrap(),
                    vout: c["vout"].as_u64().unwrap() as u32,
                };
                c["spendable"] == json!(true)
                    && !keep.contains(&op)
                    && c["amount"].as_f64() > Some(1.0)
            })
            .expect("no coin left to fill the mempool with: mine more blocks");
        // ~1500 outputs of 1000 sat: about 65 kvB, under the 100 kvB standard limit.
        let outputs: Vec<Value> = (0..1500)
            .map(|_| {
                let a = Address::p2tr(&secp, BtcKey::random().xonly(), None, net);
                json!({ a.to_string(): "0.00001" })
            })
            .collect();
        let raw: String = rpc
            .wallet_call(
                "createrawtransaction",
                json!([[{"txid": coin["txid"], "vout": coin["vout"]}], outputs]),
            )
            .await
            .unwrap();
        let funded: Value = rpc
            .wallet_call(
                "fundrawtransaction",
                json!([raw, {
                    "add_inputs": false,
                    "fee_rate": sat_per_vb,
                    "changePosition": 0,
                }]),
            )
            .await
            .unwrap();
        let signed: Value = rpc
            .wallet_call("signrawtransactionwithwallet", json!([funded["hex"]]))
            .await
            .unwrap();
        assert_eq!(signed["complete"], json!(true), "{signed}");
        // The one that tips the pool over may itself be the cheapest and be evicted at once
        // ("mempool full"): the floor has risen all the same.
        let r: Result<String, _> = rpc.call("sendrawtransaction", json!([signed["hex"]])).await;
        if let Err(e) = r {
            assert!(e.to_string().contains("mempool full"), "{e}");
        }
        sent += 1;
    }
}

/// A parent whose own fee has fallen below the node's mempool floor is refused alone and taken
/// with its child as a package; the child of a held parent is then replaced by the exact
/// incremental fee; both confirm. Needs a node started with `-maxmempool=5` (the smallest 28.1
/// takes), e.g. `FERRY_BTC_RPC=http://127.0.0.1:28445`. Bitcoin only: Litecoin has no packages.
#[tokio::test]
#[ignore = "needs a regtest bitcoind started with -maxmempool=5"]
async fn package_rescues_a_parent_below_the_mempool_floor() {
    use ferry_btc::child::{build_child, fee_for, vsize_bound, ChildLimits};

    let coin = coin();
    assert!(coin.supports_packages(), "Bitcoin only");
    let suffix = BtcKey::random().xonly().to_string();
    let rpc = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet(format!("ferry-btc-it-floor-{}", &suffix[..8]))
        .with_coin(coin);
    rpc.ensure_wallet().await.expect("node up?");
    let net = Network::Regtest;
    let miner = rpc.new_address(net).await.unwrap();
    // Plenty of mature coinbase coins: one per filler.
    rpc.generate_to_address(140, &miner).await.unwrap();

    // The parent, signed but not sent, at 2 sat/vB (it passes the static 1 sat/vB relay floor).
    let own = rpc.new_address(net).await.unwrap();
    let parent = rpc
        .fund_payment(&own, Amount::from_sat(2_000_000), 2)
        .await
        .unwrap();
    let parent_txid = parent.tx.compute_txid();
    let vout = parent
        .tx
        .output
        .iter()
        .position(|o| o.script_pubkey == own.script_pubkey())
        .unwrap() as u32;
    let kept: Vec<OutPoint> = parent.tx.input.iter().map(|i| i.previous_output).collect();

    let fillers = raise_mempool_floor(&rpc, net, 60, &kept).await;
    let floors = rpc.fee_floors().await.unwrap();
    println!("{coin}: {fillers} fillers raised the floor to {floors:?}");
    assert!(floors.mempool_min >= 60_000 && floors.min_relay == 1_000);

    // Alone, the parent is refused for the dynamic floor, not for the static relay fee.
    let alone = rpc
        .test_accept(std::slice::from_ref(&parent.tx), None)
        .await
        .unwrap();
    println!("{coin}: parent alone: {alone:?}");
    assert!(!alone[0].allowed);
    assert_eq!(
        alone[0].reject_reason.as_deref(),
        Some("mempool min fee not met")
    );
    let sent = rpc.broadcast(&parent.tx).await;
    assert!(sent.is_err(), "{sent:?}");

    // A child that lifts the pair to 1.2 x the floor.
    let dest = rpc.new_address(net).await.unwrap().script_pubkey();
    let bound = vsize_bound(&own.script_pubkey(), &dest).unwrap();
    let parent_vsize = parent.tx.vsize() as u64;
    let want = floors.mempool_min * 12 / 10;
    let fee = fee_for(want, parent_vsize + bound) - parent.fee.to_sat();
    let limits = ChildLimits {
        max_fee: Amount::from_sat(1_000_000),
        max_fee_rate: want * 4,
    };
    let child = build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest,
        Amount::from_sat(fee),
        coin,
        &limits,
    )
    .await
    .unwrap();
    // The child alone is not enough: its parent is not there.
    let orphan = rpc
        .test_accept(std::slice::from_ref(&child.tx), None)
        .await
        .unwrap();
    assert_eq!(orphan[0].reject_reason.as_deref(), Some("missing-inputs"));
    let both = rpc
        .test_accept(
            &[parent.tx.clone(), child.tx.clone()],
            Some(limits.max_fee_rate),
        )
        .await
        .unwrap();
    // Bitcoin Core 28.1's testmempoolaccept judges each transaction of a package on its own fee,
    // so it cannot vouch for a child-pays-for-parent package: it refuses this one for the
    // parent's fee. Only submitpackage applies the package feerate. Recorded, not asserted.
    println!("{coin}: testmempoolaccept on the package (recorded, not asserted): {both:?}");
    let pkg = rpc
        .submit_package(
            &[parent.tx.clone(), child.tx.clone()],
            Some(limits.max_fee_rate),
        )
        .await
        .unwrap();
    println!("{coin}: package: {pkg:?}");
    assert!(pkg.success, "{pkg:?}");
    let held = rpc.mempool_entry(&parent_txid).await.unwrap().unwrap();
    assert_eq!(held.spent_by, vec![child.tx.compute_txid()]);
    assert_eq!(held.descendant_fee, parent.fee + child.fee);

    // The parent is held now, so its child is judged alone: it clears the floor by itself, and a
    // replacement adds exactly the incremental fee.
    let dest2 = rpc.new_address(net).await.unwrap().script_pubkey();
    let fee2 = fee + fee_for(floors.incremental, child.vsize);
    let child2 = build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest2,
        Amount::from_sat(fee2),
        coin,
        &limits,
    )
    .await
    .unwrap();
    let verdict = rpc
        .test_accept(std::slice::from_ref(&child2.tx), None)
        .await
        .unwrap();
    assert!(verdict[0].allowed, "{verdict:?}");
    rpc.broadcast_capped(&child2.tx, limits.max_fee_rate)
        .await
        .unwrap();
    assert_eq!(
        rpc.mempool_entry(&child.tx.compute_txid()).await.unwrap(),
        None
    );

    rpc.generate_to_address(1, &miner).await.unwrap();
    assert_eq!(rpc.confirmations(&parent_txid).await.unwrap(), Some(1));
    assert_eq!(
        rpc.confirmations(&child2.tx.compute_txid()).await.unwrap(),
        Some(1)
    );
    println!(
        "{coin}: parent below the mempool floor rescued by a package, child replaced, both mined"
    );
}

/// The race at T1, against a counterparty who plays to win. B holds the presigned, fixed-fee
/// tx_cancel and may broadcast it the moment the lock has T1 confirmations; Z holds the
/// presigned tx_redeem and bumps it with a child of its own output. Checks, on a real node:
/// the cancel is refused before T1; once valid it cannot replace the in-mempool redeem and its
/// child (it would have to pay their fees too, and it is fixed); when the redeem and child are
/// evicted by a rising mempool floor the cancel cannot get in either, and Z puts the redeem
/// back with a new child as a package; the redeem confirms and the cancel is dead; after a
/// reorg the redeem and its child return to the mempool together.
///
/// Needs a node started with `-maxmempool=5 -blockmintxfee=0.0010 -mintxfee=0.0011` (blocks
/// leave out packages under 100 sat/vB, and the wallet pays at least that), e.g.
/// `FERRY_BTC_RPC=http://127.0.0.1:28446`. Bitcoin only.
#[tokio::test]
#[ignore = "needs a regtest bitcoind started with -maxmempool=5 -blockmintxfee=0.0010 -mintxfee=0.0011"]
async fn t1_race_a_bumped_redeem_cannot_be_displaced_by_the_fixed_fee_cancel() {
    use ferry_btc::child::{build_child, fee_for, vsize_bound, ChildLimits};
    use ferry_btc::{Spend, SwapScripts, SwapTxs};

    const T1: u16 = 6;
    let coin = Coin::Btc;
    let suffix = BtcKey::random().xonly().to_string();
    let rpc = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet(format!("ferry-btc-it-race-{}", &suffix[..8]))
        .with_coin(coin);
    rpc.ensure_wallet().await.expect("node up?");
    let net = Network::Regtest;
    let miner = rpc.new_address(net).await.unwrap();
    rpc.generate_to_address(140, &miner).await.unwrap();

    // The swap's lock, funded by B's wallet and confirmed, and the four presigned spends. Both
    // keys are the test's, so it can sign what each party would.
    let (kb, kz) = (BtcKey::random(), BtcKey::random());
    let scripts = SwapScripts::new(kb.xonly(), kz.xonly(), T1, 20, false);
    let lock_addr = scripts.lock.address(net);
    let funded = rpc
        .fund_lock(&lock_addr, Amount::from_sat(1_000_000))
        .await
        .unwrap();
    let lock_txid = rpc.broadcast(&funded.tx).await.unwrap();
    rpc.generate_to_address(1, &miner).await.unwrap();
    assert_eq!(rpc.confirmations(&lock_txid).await.unwrap(), Some(1));
    let redeem_to = rpc.new_address(net).await.unwrap();
    let txs = SwapTxs::new(
        coin,
        scripts,
        OutPoint {
            txid: lock_txid,
            vout: funded.vout,
        },
        Amount::from_sat(1_000_000),
        Amount::from_sat(2_000),
        redeem_to.script_pubkey(), // Z's own wallet address: the output Z bumps from
        rpc.new_address(net).await.unwrap().script_pubkey(),
        rpc.new_address(net).await.unwrap().script_pubkey(),
    )
    .unwrap();
    let signed = |spend: Spend| {
        let h = txs.sighash(spend);
        txs.complete(spend, &kb.sign(&h), &kz.sign(&h)).unwrap()
    };
    let (cancel, redeem) = (signed(Spend::Cancel), signed(Spend::Redeem));
    let redeem_txid = redeem.compute_txid();

    // Before T1 the cancel is not valid.
    let early = rpc.broadcast(&cancel).await.unwrap_err().to_string();
    println!("cancel before T1: {early}");
    assert!(early.contains("non-BIP68-final"), "{early}");

    // Z broadcasts the redeem at its presigned fee (12 sat/vB: the node takes it, a miner
    // asking for 100 does not), then lifts the pair to 90 sat/vB with a child of its own output.
    rpc.broadcast(&redeem).await.unwrap();
    let limits = ChildLimits {
        max_fee: Amount::from_sat(1_000_000),
        max_fee_rate: 1_000_000,
    };
    let dest = rpc.new_address(net).await.unwrap().script_pubkey();
    let vsize_redeem = redeem.vsize() as u64;
    let vsize_child = vsize_bound(&redeem_to.script_pubkey(), &dest).unwrap();
    let fee1 = fee_for(90_000, vsize_redeem + vsize_child) - 2_000;
    let child1 = build_child(
        &rpc,
        &redeem,
        0,
        &dest,
        Amount::from_sat(fee1),
        coin,
        &limits,
    )
    .await
    .unwrap();
    rpc.broadcast_capped(&child1.tx, limits.max_fee_rate)
        .await
        .unwrap();

    // The lock reaches T1 confirmations; the pair is below the miners' 100 sat/vB and stays.
    rpc.generate_to_address(u64::from(T1) - 1, &miner)
        .await
        .unwrap();
    assert_eq!(
        rpc.confirmations(&lock_txid).await.unwrap(),
        Some(u32::from(T1))
    );
    assert_eq!(rpc.confirmations(&redeem_txid).await.unwrap(), Some(0));

    // B plays the cancel. It conflicts with the redeem and would have to pay for the redeem and
    // its child as well; it is fixed at 2000 sat, so it is refused and nothing is displaced.
    let try_cancel = rpc
        .test_accept(std::slice::from_ref(&cancel), None)
        .await
        .unwrap();
    println!("cancel against the bumped redeem: {try_cancel:?}");
    assert!(!try_cancel[0].allowed);
    assert!(rpc.broadcast(&cancel).await.is_err());
    let held = rpc.mempool_entry(&redeem_txid).await.unwrap().unwrap();
    assert_eq!(held.spent_by, vec![child1.tx.compute_txid()]);

    // The mempool floor rises past the pair (150 sat/vB fillers): redeem and child are evicted.
    // The cancel, at 12 sat/vB, cannot get in over that floor either.
    let fillers = raise_mempool_floor(&rpc, net, 150, &[]).await;
    let floors = rpc.fee_floors().await.unwrap();
    println!("{fillers} fillers: floors {floors:?}");
    assert_eq!(
        rpc.mempool_entry(&redeem_txid).await.unwrap(),
        None,
        "evicted"
    );
    let no_cancel = rpc
        .test_accept(std::slice::from_ref(&cancel), None)
        .await
        .unwrap();
    println!("cancel over the raised floor: {no_cancel:?}");
    assert!(!no_cancel[0].allowed);
    assert_eq!(
        no_cancel[0].reject_reason.as_deref(),
        Some("mempool min fee not met")
    );
    let alone = rpc
        .test_accept(std::slice::from_ref(&redeem), None)
        .await
        .unwrap();
    assert_eq!(
        alone[0].reject_reason.as_deref(),
        Some("mempool min fee not met")
    );

    // Z puts the redeem back with a new child, as a package, at 1.2 x the floor. The child it
    // had is gone with its parent, so nothing is replaced.
    let want = floors.mempool_min * 12 / 10;
    let fee2 = fee_for(want, vsize_redeem + vsize_child) - 2_000;
    assert!(fee2 > fee1);
    let child2 = build_child(
        &rpc,
        &redeem,
        0,
        &dest,
        Amount::from_sat(fee2),
        coin,
        &limits,
    )
    .await
    .unwrap();
    let pkg = rpc
        .submit_package(
            &[redeem.clone(), child2.tx.clone()],
            Some(limits.max_fee_rate),
        )
        .await
        .unwrap();
    println!("package: {pkg:?}");
    assert!(pkg.success, "{pkg:?}");
    let held = rpc.mempool_entry(&redeem_txid).await.unwrap().unwrap();
    assert_eq!(held.spent_by, vec![child2.tx.compute_txid()]);
    // B still cannot displace it.
    let again = rpc
        .test_accept(std::slice::from_ref(&cancel), None)
        .await
        .unwrap();
    assert!(!again[0].allowed, "{again:?}");

    // The next block takes the package (above the miners' 100 sat/vB): the redeem is final and
    // the cancel's input is spent.
    rpc.generate_to_address(1, &miner).await.unwrap();
    assert_eq!(rpc.confirmations(&redeem_txid).await.unwrap(), Some(1));
    assert_eq!(
        rpc.confirmations(&child2.tx.compute_txid()).await.unwrap(),
        Some(1)
    );
    assert!(rpc.broadcast(&cancel).await.is_err());

    // A reorg of that block returns the redeem and its child to the mempool together.
    let tip: String = rpc.call("getbestblockhash", json!([])).await.unwrap();
    let _: Value = rpc.call("invalidateblock", json!([tip])).await.unwrap();
    let back = rpc.mempool_entry(&redeem_txid).await.unwrap().unwrap();
    assert_eq!(back.spent_by, vec![child2.tx.compute_txid()]);
    assert_eq!(back.descendant_fee, Amount::from_sat(2_000 + fee2));
    let _: Value = rpc.call("reconsiderblock", json!([tip])).await.unwrap();
    assert_eq!(rpc.confirmations(&redeem_txid).await.unwrap(), Some(1));
    println!("T1 race: the fixed-fee cancel never displaced the bumped redeem");
}

/// A parent whose own fee is below the node's static `minrelaytxfee` cannot be rescued by a
/// package, whatever the child pays: the node refuses the parent for its own fee. Only a parent
/// that fell below the mempool's rising floor can be (see the test above). Needs a node started
/// with `-minrelaytxfee=0.0003` (30 sat/vB), e.g. `FERRY_BTC_RPC=http://127.0.0.1:28444`.
/// Bitcoin only.
#[tokio::test]
#[ignore = "needs a regtest bitcoind started with -minrelaytxfee=0.0003"]
async fn package_cannot_rescue_a_parent_below_the_static_relay_fee() {
    use ferry_btc::child::{build_child, ChildLimits};

    let coin = coin();
    assert!(coin.supports_packages(), "Bitcoin only");
    let suffix = BtcKey::random().xonly().to_string();
    let rpc = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet(format!("ferry-btc-it-relay-{}", &suffix[..8]))
        .with_coin(coin);
    rpc.ensure_wallet().await.expect("node up?");
    let net = Network::Regtest;
    let miner = rpc.new_address(net).await.unwrap();
    rpc.generate_to_address(101, &miner).await.unwrap();
    let floors = rpc.fee_floors().await.unwrap();
    assert_eq!(
        floors.min_relay, 30_000,
        "start the node with -minrelaytxfee=0.0003"
    );

    // A one-input, one-output Taproot payment to ourselves at about 18 sat/vB: what a presigned
    // 2000-sat spend pays. The wallet will not make one that low, so it is built by hand.
    let coins: Vec<Value> = rpc
        .wallet_call("listunspent", json!([1, 9_999_999, [], false]))
        .await
        .unwrap();
    let coin_in = coins
        .iter()
        .find(|c| c["spendable"] == json!(true))
        .unwrap();
    let own = rpc.new_address(net).await.unwrap();
    let value = Amount::from_btc(coin_in["amount"].as_f64().unwrap()).unwrap();
    let raw: String = rpc
        .wallet_call(
            "createrawtransaction",
            json!([
                [{"txid": coin_in["txid"], "vout": coin_in["vout"], "sequence": 0xffff_fffdu32}],
                [{ own.to_string(): (value - Amount::from_sat(2_000)).to_string_in(ferry_btc::bitcoin::Denomination::Bitcoin) }]
            ]),
        )
        .await
        .unwrap();
    let signed: Value = rpc
        .wallet_call("signrawtransactionwithwallet", json!([raw]))
        .await
        .unwrap();
    assert_eq!(signed["complete"], json!(true));
    let parent: ferry_btc::bitcoin::Transaction =
        ferry_btc::bitcoin::consensus::encode::deserialize_hex(signed["hex"].as_str().unwrap())
            .unwrap();

    let alone = rpc
        .test_accept(std::slice::from_ref(&parent), None)
        .await
        .unwrap();
    println!("parent alone: {alone:?}");
    assert_eq!(
        alone[0].reject_reason.as_deref(),
        Some("min relay fee not met")
    );

    // A child that would lift the pair far above any floor.
    let dest = rpc.new_address(net).await.unwrap().script_pubkey();
    let limits = ChildLimits {
        max_fee: Amount::from_sat(1_000_000),
        max_fee_rate: 10_000_000,
    };
    let child = build_child(
        &rpc,
        &parent,
        0,
        &dest,
        Amount::from_sat(20_000),
        coin,
        &limits,
    )
    .await
    .unwrap();
    let pkg = rpc
        .submit_package(
            &[parent.clone(), child.tx.clone()],
            Some(limits.max_fee_rate),
        )
        .await
        .unwrap();
    println!("package: {pkg:?}");
    assert!(!pkg.success);
    assert!(
        pkg.errors
            .iter()
            .any(|(txid, e)| *txid == parent.compute_txid() && e.contains("min relay fee not met")),
        "{pkg:?}"
    );
    assert_eq!(
        rpc.mempool_entry(&parent.compute_txid()).await.unwrap(),
        None
    );
    println!("a package does not lift a parent over the static relay fee: {pkg:?}");
}

/// What Bitcoin Core 28.1 does with a package whose parent has been mined in the meantime, the
/// race between the daemon reading the parent as unconfirmed and sending it with its child. The
/// daemon checks `gettxout` (confirmed chain only) just before `submitpackage` and, if the parent's
/// output is there, sends nothing: the parent is final and there is nothing left to lift. What
/// Core 28.1 answers is printed, not asserted (recorded 2026-10-22: `package_msg` "transaction
/// failed" with the parent's "txn-already-known", and the child accepted into the mempool all the
/// same, on its own merits). What the daemon relies on is asserted: `output_confirmed` tells a
/// mined parent from one that is only in the mempool, and the child can be in the mempool
/// afterwards, sent alone if the package did not take it. Bitcoin only (packages).
#[tokio::test]
#[ignore = "needs a regtest bitcoind"]
async fn package_with_a_parent_that_is_already_confirmed() {
    use ferry_btc::child::{build_child, ChildLimits};

    let coin = coin();
    assert!(coin.supports_packages(), "Bitcoin only");
    let suffix = BtcKey::random().xonly().to_string();
    let rpc = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet(format!("ferry-btc-it-conf-{}", &suffix[..8]))
        .with_coin(coin);
    rpc.ensure_wallet().await.expect("node up?");
    let net = Network::Regtest;
    let miner = rpc.new_address(net).await.unwrap();
    rpc.generate_to_address(101, &miner).await.unwrap();

    let own = rpc.new_address(net).await.unwrap();
    let parent = rpc
        .fund_payment(&own, Amount::from_sat(1_500_000), 2)
        .await
        .unwrap();
    let parent_txid = parent.tx.compute_txid();
    let vout = parent
        .tx
        .output
        .iter()
        .position(|o| o.script_pubkey == own.script_pubkey())
        .unwrap() as u32;
    // Not sent yet: not in a block.
    assert!(!rpc.output_confirmed(&parent_txid, vout).await.unwrap());
    assert!(!rpc.tx_mined(&parent_txid, vout).await.unwrap());
    rpc.broadcast(&parent.tx).await.unwrap();
    // In the mempool only: gettxout without the mempool does not see it.
    assert!(!rpc.output_confirmed(&parent_txid, vout).await.unwrap());
    assert!(!rpc.tx_mined(&parent_txid, vout).await.unwrap());

    let limits = ChildLimits {
        max_fee: Amount::from_sat(1_000_000),
        max_fee_rate: 1_000_000,
    };
    let dest = rpc.new_address(net).await.unwrap().script_pubkey();
    let child = build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest,
        Amount::from_sat(5_000),
        coin,
        &limits,
    )
    .await
    .unwrap();
    let child_txid = child.tx.compute_txid();

    // The parent is mined.
    rpc.generate_to_address(1, &miner).await.unwrap();
    assert_eq!(rpc.confirmations(&parent_txid).await.unwrap(), Some(1));
    assert!(rpc.output_confirmed(&parent_txid, vout).await.unwrap());
    assert!(rpc.tx_mined(&parent_txid, vout).await.unwrap());

    // The package, now.
    let tested = rpc
        .test_accept(&[parent.tx.clone(), child.tx.clone()], None)
        .await;
    println!("testmempoolaccept [confirmed parent, child]: {tested:?}");
    let pkg = rpc
        .submit_package(
            &[parent.tx.clone(), child.tx.clone()],
            Some(limits.max_fee_rate),
        )
        .await;
    println!("submitpackage [confirmed parent, child]: {pkg:?}");
    let held = rpc.mempool_entry(&child_txid).await.unwrap();
    println!(
        "the child is in the mempool after the package: {}",
        held.is_some()
    );

    // Whatever the package did, the child can be in the mempool: alone if it is not there.
    if held.is_none() {
        rpc.broadcast_capped(&child.tx, limits.max_fee_rate)
            .await
            .unwrap();
    }
    assert!(rpc.mempool_entry(&child_txid).await.unwrap().is_some());
    rpc.generate_to_address(1, &miner).await.unwrap();
    assert_eq!(rpc.confirmations(&child_txid).await.unwrap(), Some(1));
    // Once the child is mined too, the output is spent: no longer an unspent confirmed output.
    assert!(!rpc.output_confirmed(&parent_txid, vout).await.unwrap());
    // The parent is still in a block, which is what the bumper asks before it sends a package.
    assert!(rpc.tx_mined(&parent_txid, vout).await.unwrap());

    // A parent mined in the same block as our child, the case the bumper meets when the bump
    // worked: gettxout has nothing (the output is spent), and the parent is in a block.
    let parent = rpc
        .fund_payment(&own, Amount::from_sat(1_500_000), 2)
        .await
        .unwrap();
    let parent_txid = parent.tx.compute_txid();
    let vout = parent
        .tx
        .output
        .iter()
        .position(|o| o.script_pubkey == own.script_pubkey())
        .unwrap() as u32;
    rpc.broadcast(&parent.tx).await.unwrap();
    let child = build_child(
        &rpc,
        &parent.tx,
        vout,
        &dest,
        Amount::from_sat(5_000),
        coin,
        &limits,
    )
    .await
    .unwrap();
    rpc.broadcast_capped(&child.tx, limits.max_fee_rate)
        .await
        .unwrap();
    assert!(!rpc.tx_mined(&parent_txid, vout).await.unwrap());
    rpc.generate_to_address(1, &miner).await.unwrap();
    assert_eq!(
        rpc.confirmations(&child.tx.compute_txid()).await.unwrap(),
        Some(1)
    );
    assert!(!rpc.output_confirmed(&parent_txid, vout).await.unwrap());
    assert!(rpc.tx_mined(&parent_txid, vout).await.unwrap());
}

/// A locked wallet refuses to sign a child with the node's own error (-13). The bumper takes
/// that as a refusal to wait out until the next block, not as a node it could not reach.
#[tokio::test]
#[ignore = "needs a regtest node (infra/btc/regtest.sh or infra/ltc/regtest.sh)"]
async fn a_locked_wallet_refuses_to_sign_a_child() {
    use ferry_btc::child::{build_child, ChildError, ChildLimits};
    use ferry_btc::rpc::RpcError;

    let coin = coin();
    let suffix = BtcKey::random().xonly().to_string();
    let rpc = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet(format!("ferry-btc-it-sign-{}", &suffix[..8]))
        .with_coin(coin);
    rpc.ensure_wallet().await.expect("node up?");
    let net = Network::Regtest;
    let miner = rpc.new_address(net).await.unwrap();
    rpc.generate_to_address(101, &miner).await.unwrap();
    let own = rpc.new_address(net).await.unwrap();
    let parent = rpc
        .fund_payment(&own, Amount::from_sat(1_500_000), 2)
        .await
        .unwrap();
    let vout = parent
        .tx
        .output
        .iter()
        .position(|o| o.script_pubkey == own.script_pubkey())
        .unwrap() as u32;

    // A second wallet made with a passphrase: encrypted, and locked from the start.
    let name = format!("ferry-btc-it-locked-{}", &suffix[..8]);
    let _: Value = rpc
        .call("createwallet", json!([name, false, false, "regtest-only"]))
        .await
        .unwrap();
    let locked = BitcoinRpc::new(url(coin), "ferry", "ferry")
        .with_wallet(name)
        .with_coin(coin);
    let limits = ChildLimits {
        max_fee: Amount::from_sat(1_000_000),
        max_fee_rate: 1_000_000,
    };
    let dest = rpc.new_address(net).await.unwrap().script_pubkey();
    let err = build_child(
        &locked,
        &parent.tx,
        vout,
        &dest,
        Amount::from_sat(5_000),
        coin,
        &limits,
    )
    .await
    .unwrap_err();
    assert!(
        matches!(err, ChildError::Rpc(RpcError::Rpc { code: -13, .. })),
        "{err:?}"
    );
}
