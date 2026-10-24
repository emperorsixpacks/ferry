//! FerryLock + ferry-evm against a local anvil: a happy claim through a relayer, a refund and a
//! punish, with Ferry shares (Pallas scalars with a cross-group DLEQ); and the same lock with
//! WETH (18 decimals) at an amount above 2^64 base units.
//!
//! Each test spawns its own `anvil` from PATH or ~/.foundry/bin on a port the OS picks (so tests
//! in parallel and other local nodes never collide) and kills it (by its own child handle) at
//! the end. Without an anvil binary the tests print a note and pass. Install: `foundryup`.

use std::path::PathBuf;

use alloy::node_bindings::{Anvil, AnvilInstance};
use alloy::primitives::{Address, B256, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;
use ferry_dleq::k256::elliptic_curve::PrimeField;
use ferry_dleq::{PallasPoint, PallasScalar};
use ferry_evm::bindings::{FerryLock, MockUSDC, MockWETH};
use ferry_evm::{
    point_address_sec1, scalar_address, sign_ready, swap_id, Error, EvmClient, Revealed,
    SwapEventKind, SwapState, SwapWatcher, Terms, TokenInfo,
};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

const AMOUNT: u64 = 250_000_000; // 250 USDC
const MAX_TIP: u64 = 1_000_000;

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

/// A Ferry share: Pallas scalar < 2^254, its points on both curves (DLEQ-proven), and the
/// same integer as a big-endian secp256k1 scalar.
struct Share {
    pallas_pub: PallasPoint,
    secp_be: Zeroizing<[u8; 32]>,
    addr: Address,
}

impl Share {
    fn new(ctx: &[u8]) -> Share {
        let x = ferry_dleq::random_mutual_scalar(&mut OsRng);
        let proven = ferry_dleq::prove(&mut OsRng, ctx, x.clone()).unwrap();
        let secp_be = Zeroizing::new(ferry_dleq::to_secp_scalar(&x).unwrap().to_repr().into());
        // What the counterparty commits to on chain: the address of the published point.
        let addr = point_address_sec1(&ferry_dleq::secp_bytes(&proven.secp_pub)).unwrap();
        assert_eq!(scalar_address(&secp_be), Some(addr));
        Share {
            pallas_pub: proven.pallas_pub,
            secp_be,
            addr,
        }
    }

    /// What the receiver does with a revealed scalar: map it back to the Pallas share and
    /// check it against the proven Pallas point.
    fn matches_revealed(&self, k: &[u8; 32]) -> bool {
        let s: Option<ferry_dleq::SecpScalar> =
            ferry_dleq::SecpScalar::from_repr((*k).into()).into();
        let p: Option<PallasScalar> = s.and_then(|s| ferry_dleq::from_secp_scalar(&s));
        p.is_some_and(|p| ferry_dleq::spend_auth_g() * p == self.pallas_pub)
    }
}

struct Net {
    _anvil: AnvilInstance,
    url: String,
    keys: Vec<PrivateKeySigner>,
    lock: Address,
    usdc: Address,
}

impl Net {
    fn client(&self, i: usize) -> EvmClient {
        EvmClient::connect_http(&self.url, self.lock, self.keys[i].clone()).unwrap()
    }

    async fn warp(&self, client: &EvmClient, ts: u64) {
        let p = client.provider();
        p.raw_request::<_, serde_json::Value>("evm_setNextBlockTimestamp".into(), (ts,))
            .await
            .unwrap();
        p.raw_request::<_, serde_json::Value>("evm_mine".into(), ())
            .await
            .unwrap();
    }

    async fn balance(&self, client: &EvmClient, who: Address) -> u64 {
        client
            .token_balance(self.usdc, who)
            .await
            .unwrap()
            .to::<u64>()
    }
}

// Accounts: 0 deployer, 1 B, 2 Z (payout), 3 relayer.
const B: usize = 1;
const Z: usize = 2;
const RELAYER: usize = 3;

async fn start() -> Option<Net> {
    let Some(bin) = anvil_binary() else {
        eprintln!("SKIP: no anvil binary (install with foundryup)");
        return None;
    };
    // No port: anvil binds port 0 and alloy reads back the one the OS chose.
    let anvil = Anvil::at(bin).spawn();
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
    Some(Net {
        _anvil: anvil,
        url,
        keys,
        lock: *lock.address(),
        usdc: *usdc.address(),
    })
}

fn random_salt() -> B256 {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    B256::from(b)
}

async fn terms(net: &Net, c: &EvmClient, z: &Share, b: &Share) -> Terms {
    let now = c.latest_timestamp().await.unwrap();
    Terms {
        token: net.usdc,
        amount: U256::from(AMOUNT),
        zAddr: z.addr,
        bAddr: b.addr,
        claimer: net.keys[Z].address(),
        refunder: net.keys[B].address(),
        t1: now + 3_600,
        t2: now + 7_200,
        maxTip: U256::from(MAX_TIP),
    }
}

#[tokio::test]
async fn ferry_lock_on_anvil() {
    let Some(net) = start().await else { return };
    let (b, z, relayer) = (net.client(B), net.client(Z), net.client(RELAYER));

    // Z checks the code at the agreed address is this build's FerryLock.
    z.check_deployment().await.unwrap();
    let not_lock = EvmClient::connect_http(&net.url, net.usdc, net.keys[Z].clone()).unwrap();
    assert!(matches!(
        not_lock.check_deployment().await,
        Err(Error::UnknownContract)
    ));

    // The contract's ecrecover check agrees with ferry-evm's (and k256's) point addresses.
    let lock = FerryLock::new(net.lock, b.provider().clone());
    for _ in 0..16 {
        let s = Share::new(b"addr");
        let onchain = lock
            .scalarAddress(U256::from_be_bytes(*s.secp_be))
            .call()
            .await
            .unwrap();
        assert_eq!(onchain, s.addr);
    }

    happy_claim_with_relayer(&net, &b, &z, &relayer).await;
    refund(&net, &b, &z).await;
    punish(&net, &b, &relayer).await;
}

/// WETH: 18 decimals, wrapped from ETH, locked and claimed at 50 WETH (5e19 base units, above
/// u64::MAX). The client keeps every amount in U256; `token_info` reads what each token says
/// about itself, which ferryd checks against its flags at startup.
#[tokio::test]
async fn weth_above_u64_on_anvil() {
    let Some(net) = start().await else { return };
    let (b, z, relayer) = (net.client(B), net.client(Z), net.client(RELAYER));
    let weth = MockWETH::deploy(b.provider().clone()).await.unwrap();
    let weth_addr = *weth.address();

    assert_eq!(
        b.token_info(weth_addr).await.unwrap(),
        TokenInfo {
            symbol: "WETH".into(),
            decimals: 18
        }
    );
    assert_eq!(
        b.token_info(net.usdc).await.unwrap(),
        TokenInfo {
            symbol: "USDC".into(),
            decimals: 6
        }
    );
    // No code there, or a contract that is not an ERC-20: an error, never a guess.
    assert!(b.token_info(net.keys[Z].address()).await.is_err());
    assert!(b.token_info(net.lock).await.is_err());

    // B wraps 60 ETH, then locks 50 WETH with a 0.01 WETH tip cap.
    let wei = |eth: u64| U256::from(eth) * U256::from(10u64).pow(U256::from(18));
    let amount = wei(50);
    let max_tip = wei(1) / U256::from(100);
    assert!(amount > U256::from(u64::MAX));
    weth.deposit()
        .value(wei(60))
        .send()
        .await
        .unwrap()
        .get_receipt()
        .await
        .unwrap();
    assert_eq!(
        b.token_balance(weth_addr, b.address()).await.unwrap(),
        wei(60)
    );

    let (zs, bs) = (Share::new(b"weth/Z"), Share::new(b"weth/B"));
    let now = b.latest_timestamp().await.unwrap();
    let t = Terms {
        token: weth_addr,
        amount,
        zAddr: zs.addr,
        bAddr: bs.addr,
        claimer: net.keys[Z].address(),
        refunder: net.keys[B].address(),
        t1: now + 3_600,
        t2: now + 7_200,
        maxTip: max_tip,
    };
    let (id, lock_tx) = b.lock(random_salt(), &t).await.unwrap();
    z.check_lock(id, &t).await.unwrap();
    let mut short = t.clone();
    short.amount = amount - U256::from(1);
    assert!(matches!(
        z.check_lock(id, &short).await,
        Err(Error::TermsMismatch("amount"))
    ));

    let ready = sign_ready(&net.keys[B], b.chain_id().await.unwrap(), net.lock, id);
    relayer
        .claim(id, &zs.secp_be, max_tip, &ready)
        .await
        .unwrap();
    assert_eq!(
        b.token_balance(weth_addr, net.keys[Z].address())
            .await
            .unwrap(),
        amount - max_tip
    );
    assert_eq!(
        b.token_balance(weth_addr, relayer.address()).await.unwrap(),
        max_tip
    );
    assert_eq!(
        b.token_balance(weth_addr, b.address()).await.unwrap(),
        wei(10)
    );

    // B reads z from the Claimed event exactly as with USDC.
    let events = SwapWatcher::new(id, lock_tx.block_number, 1)
        .poll(&b)
        .await
        .unwrap();
    assert_eq!(events[0].kind, SwapEventKind::Locked(t.clone()));
    let revealed = events[1].revealed_share(&t).unwrap().unwrap();
    assert!(zs.matches_revealed(&revealed));
}

async fn happy_claim_with_relayer(net: &Net, b: &EvmClient, z: &EvmClient, relayer: &EvmClient) {
    let (zs, bs) = (Share::new(b"happy/Z"), Share::new(b"happy/B"));
    let t = terms(net, b, &zs, &bs).await;
    let salt = random_salt();
    let (id, lock_tx) = b.lock(salt, &t).await.unwrap();
    assert_eq!(id, swap_id(b.address(), salt));

    // Z checks the lock before sending any ZEC, and notices any changed term.
    z.check_lock(id, &t).await.unwrap();
    let mut wrong = t.clone();
    wrong.bAddr = Share::new(b"other").addr;
    assert!(matches!(
        z.check_lock(id, &wrong).await,
        Err(Error::TermsMismatch("bAddr"))
    ));

    // Without B's ready signature (here: one by the wrong key, or for another swap) the client
    // refuses before anything is broadcast.
    let nonce = relayer
        .provider()
        .get_transaction_count(relayer.address())
        .await
        .unwrap();
    let chain = b.chain_id().await.unwrap();
    let forged = sign_ready(&net.keys[Z], chain, net.lock, id);
    assert!(matches!(
        relayer.claim(id, &zs.secp_be, U256::ZERO, &forged).await,
        Err(Error::WouldRevert(_))
    ));
    let other_swap = sign_ready(&net.keys[B], chain, net.lock, B256::repeat_byte(1));
    assert!(matches!(
        relayer
            .claim(id, &zs.secp_be, U256::ZERO, &other_swap)
            .await,
        Err(Error::WouldRevert(_))
    ));

    // (Z's ZEC lock reaches N confirmations here.) B signs Ready(id) off-chain and hands it to
    // Z: no transaction, no gas, nothing on chain.
    let ready = sign_ready(&net.keys[B], chain, net.lock, id);
    let digest = ferry_evm::ready_digest(chain, net.lock, id);
    let onchain = FerryLock::new(net.lock, b.provider().clone())
        .readyDigest(id)
        .call()
        .await
        .unwrap();
    assert_eq!(onchain, digest, "EIP-712 digest matches the contract");

    // Wrong share and too high a tip are both refused without broadcasting.
    assert!(matches!(
        relayer.claim(id, &bs.secp_be, U256::ZERO, &ready).await,
        Err(Error::ScalarMismatch)
    ));
    let err = relayer
        .claim(id, &zs.secp_be, U256::from(MAX_TIP + 1), &ready)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, Error::WouldRevert(r) if r.contains("TipTooHigh")),
        "{err}"
    );
    assert_eq!(
        relayer
            .provider()
            .get_transaction_count(relayer.address())
            .await
            .unwrap(),
        nonce,
        "nothing was broadcast"
    );

    // A relayer claims for Z (Z needs no ETH) and keeps the tip.
    let z_before = net.balance(b, net.keys[Z].address()).await;
    let claim_tx = relayer
        .claim(id, &zs.secp_be, U256::from(MAX_TIP), &ready)
        .await
        .unwrap();
    assert_eq!(
        net.balance(b, net.keys[Z].address()).await - z_before,
        AMOUNT - MAX_TIP
    );
    assert_eq!(net.balance(b, relayer.address()).await, MAX_TIP);
    assert_eq!(b.swap(id).await.unwrap().state, SwapState::Claimed);

    // B watches the swap and reads z from the Claimed event...
    let mut watcher = SwapWatcher::new(id, lock_tx.block_number, 1);
    let events = watcher.poll(b).await.unwrap();
    let kinds: Vec<_> = events.iter().map(|e| &e.kind).collect();
    assert!(matches!(
        kinds.as_slice(),
        [SwapEventKind::Locked(_), SwapEventKind::Claimed { .. }]
    ));
    assert_eq!(events[0].kind, SwapEventKind::Locked(t.clone()));
    let claimed = &events[1];
    assert_eq!(claimed.tx_hash, claim_tx.tx_hash);
    let revealed = claimed.revealed_share(&t).unwrap().unwrap();
    assert_eq!(revealed, *zs.secp_be);
    // ...and z maps back to Z's proven Pallas share: B can now complete ask = σ(z + b).
    assert!(zs.matches_revealed(&revealed));
    assert!(!bs.matches_revealed(&revealed));
    assert!(watcher.poll(b).await.unwrap().is_empty());

    // The same z is in the claim's calldata.
    assert_eq!(
        b.revealed_in_tx(claim_tx.tx_hash).await.unwrap(),
        Some(Revealed::Claim { id, z: *zs.secp_be })
    );

    // Nothing else can happen to a claimed swap.
    assert!(matches!(
        b.refund(id, &bs.secp_be).await,
        Err(Error::WrongState(..))
    ));
    assert!(matches!(
        relayer.punish(id).await,
        Err(Error::WouldRevert(_))
    ));
}

async fn refund(net: &Net, b: &EvmClient, z: &EvmClient) {
    let (zs, bs) = (Share::new(b"refund/Z"), Share::new(b"refund/B"));
    let t = terms(net, b, &zs, &bs).await;
    let b_before = net.balance(b, b.address()).await;
    let (id, lock_tx) = b.lock(random_salt(), &t).await.unwrap();

    // Before t1 the client will not send the refund (it would publish b while Z can claim).
    let nonce = b
        .provider()
        .get_transaction_count(b.address())
        .await
        .unwrap();
    assert!(matches!(
        b.refund(id, &bs.secp_be).await,
        Err(Error::WouldRevert(_))
    ));
    assert_eq!(
        b.provider()
            .get_transaction_count(b.address())
            .await
            .unwrap(),
        nonce
    );

    let ready = sign_ready(&net.keys[B], b.chain_id().await.unwrap(), net.lock, id);
    net.warp(b, t.t1).await;
    // After t1 nobody can claim, even with the right share and B's signature.
    assert!(matches!(
        z.claim(id, &zs.secp_be, U256::ZERO, &ready).await,
        Err(Error::WouldRevert(r)) if r.contains("TooLate")
    ));
    let refund_tx = b.refund(id, &bs.secp_be).await.unwrap();
    assert_eq!(net.balance(b, b.address()).await, b_before);

    // Z reads b from the Refunded event (or the calldata) and can reclaim its ZEC.
    let events = SwapWatcher::new(id, lock_tx.block_number, 1)
        .poll(z)
        .await
        .unwrap();
    let refunded = events
        .iter()
        .find(|e| matches!(e.kind, SwapEventKind::Refunded { .. }))
        .unwrap();
    let revealed = refunded.revealed_share(&t).unwrap().unwrap();
    assert!(bs.matches_revealed(&revealed));
    assert_eq!(
        z.revealed_in_tx(refund_tx.tx_hash).await.unwrap(),
        Some(Revealed::Refund { id, b: *bs.secp_be })
    );
    assert!(matches!(z.punish(id).await, Err(Error::WouldRevert(_))));
}

async fn punish(net: &Net, b: &EvmClient, relayer: &EvmClient) {
    let (zs, bs) = (Share::new(b"punish/Z"), Share::new(b"punish/B"));
    let t = terms(net, b, &zs, &bs).await;
    let (id, lock_tx) = b.lock(random_salt(), &t).await.unwrap();

    assert!(
        matches!(relayer.punish(id).await, Err(Error::WouldRevert(r)) if r.contains("TooEarly"))
    );
    // B stays silent past t2: its refund is now refused and anyone can punish for Z.
    net.warp(b, t.t2).await;
    assert!(matches!(
        b.refund(id, &bs.secp_be).await,
        Err(Error::WouldRevert(r)) if r.contains("TooLate")
    ));
    let z_before = net.balance(b, net.keys[Z].address()).await;
    relayer.punish(id).await.unwrap();
    assert_eq!(
        net.balance(b, net.keys[Z].address()).await - z_before,
        AMOUNT
    );
    assert_eq!(b.swap(id).await.unwrap().state, SwapState::Punished);

    let events = b
        .events(id, lock_tx.block_number, b.block_number().await.unwrap())
        .await
        .unwrap();
    assert!(matches!(
        events.last().map(|e| &e.kind),
        Some(SwapEventKind::Punished)
    ));
}
