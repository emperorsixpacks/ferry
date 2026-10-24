//! Arming a watchtower (`--watchtower`), so the swap still ends safely if this daemon goes
//! offline. docs/WATCHTOWER.md.
//!
//! - Bitcoin / Litecoin: once tx_cancel is co-signed, upload our fully signed deadline
//!   transactions (B: tx_cancel + completed tx_refund, Z: tx_cancel + tx_punish).
//! - EVM (`--counter evm`): once the FerryLock lock is on chain, upload the swap id and terms
//!   (Z: the tower may punish from t2) and, for B, B's share `b` (the tower may refund in
//!   [t1, t2 − Δ)).

use ferry_btc::bitcoin::Address;
use ferry_btc::Chain;
use ferry_core::evm::{EvmBState, EvmSwap, EvmZState};
use ferry_core::Role;
use ferry_watchtower::evm::{EvmTerms, Share, EVM_PACKAGE_VERSION};
use ferry_watchtower::{Client, ClientError, Counter, EvmPackage, Package};
use serde::{Deserialize, Serialize};

use crate::config::Cli;
use crate::evm::record::EvmRecord;
use crate::record::SwapRecord;

/// Wait between failed uploads.
const RETRY_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TowerStatus {
    /// Not uploaded yet (nothing to hand over yet, or the tower was unreachable).
    Pending,
    /// The tower accepted the package.
    Armed,
    /// We will not arm this tower (see the note).
    Refused,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TowerState {
    pub url: String,
    pub status: TowerStatus,
    /// The tower's id for our package.
    pub package_id: Option<String>,
    pub note: String,
    #[serde(default)]
    pub next_try_ms: u64,
}

impl TowerState {
    fn new(url: &str, note: &str) -> TowerState {
        TowerState {
            url: url.into(),
            status: TowerStatus::Pending,
            package_id: None,
            note: note.into(),
            next_try_ms: 0,
        }
    }

    fn due(&self) -> bool {
        self.status == TowerStatus::Pending && now_ms() >= self.next_try_ms
    }

    fn retry(&mut self, note: String) {
        self.note = note;
        self.next_try_ms = now_ms() + RETRY_MS;
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Why B refuses a tower it was not told is its own.
pub const B_NOT_OWN: &str = "Not armed: B's refund reveals B's key share to whoever also holds \
    Z's encrypted signature, so a tower that passed it to Z early could let Z take both sides. \
    Use a tower you run yourself and pass --watchtower-own";

/// The same for an EVM swap, where the tower holds `b` itself.
pub const B_NOT_OWN_EVM: &str = "Not armed: to call refund, the tower needs B's key share b \
    itself, so a tower that passed b to Z early could let Z take both sides. Use a tower you \
    run yourself and pass --watchtower-own";

/// A timeline entry for the record: (kind, label).
type Logged = Option<(&'static str, String)>;

/// Called every tick; does nothing without `--watchtower`, once armed, or once refused.
pub async fn arm(cli: &Cli, rec: &mut SwapRecord) {
    let Some(url) = &cli.watchtower else { return };
    if rec.swap.is_final() {
        return;
    }
    let mut st = rec
        .watchtower
        .take()
        .unwrap_or_else(|| TowerState::new(url, "Waiting for tx_cancel to be co-signed"));
    if st.due() {
        if let Some((kind, label)) = try_arm(cli, rec, &mut st).await {
            rec.log("local", kind, label, None);
        }
    }
    rec.watchtower = Some(st);
}

async fn try_arm(cli: &Cli, rec: &SwapRecord, st: &mut TowerState) -> Logged {
    let role = rec.role();
    if role == Role::B && !cli.watchtower_own {
        return Some(refuse_not_own(st, &rec.id, B_NOT_OWN));
    }
    let (txs, cancel, last) = match rec.swap.watchtower_txs() {
        Ok(Some(t)) => t,
        Ok(None) => return None,
        Err(e) => {
            st.retry(format!("Could not build the watchtower package: {e}"));
            return None;
        }
    };
    let params = &rec.swap.session().params;
    let Ok(payout) = Address::from_script(&last.output[0].script_pubkey, params.network) else {
        st.status = TowerStatus::Refused;
        st.note = "Our payout script has no address form".into();
        return None;
    };
    let chain = Chain {
        coin: params.coin,
        network: params.network,
    };
    let mut package = Package::new(
        role,
        chain,
        &txs,
        params.cancel_confirmations,
        params.refund_margin,
        &cancel,
        &last,
        &[payout],
    );
    package.label = Some(rec.id.clone());
    let action = match role {
        Role::B => "broadcast the call-off and refund",
        Role::Z => "broadcast the call-off and penalty",
    };
    upload(cli, st, &rec.id, &package, action).await
}

/// `--counter evm`: called every tick, like [`arm`].
pub async fn arm_evm(cli: &Cli, rec: &mut EvmRecord) {
    let Some(url) = &cli.watchtower else { return };
    if rec.swap.is_final() {
        return;
    }
    let mut st = rec
        .watchtower
        .take()
        .unwrap_or_else(|| TowerState::new(url, "Waiting for the FerryLock lock to be mined"));
    if st.due() {
        if let Some((kind, label)) = try_arm_evm(cli, rec, &mut st).await {
            rec.log("local", kind, label, None);
        }
    }
    rec.watchtower = Some(st);
}

/// The lock is on chain with the agreed terms and nothing has settled it yet: the tower can
/// check the package against the chain, and still has something to guard.
fn evm_due(swap: &EvmSwap) -> bool {
    match swap {
        EvmSwap::B(b) => matches!(
            b.state,
            EvmBState::Locked
                | EvmBState::ZecSeen { .. }
                | EvmBState::ReadySigning
                | EvmBState::ReadySent
                | EvmBState::Refunding
        ),
        EvmSwap::Z(z) => matches!(
            z.state,
            EvmZState::LockSeen
                | EvmZState::ZecLocked
                | EvmZState::ZecLockRefused
                | EvmZState::ReadyReceived
                | EvmZState::Claiming
                | EvmZState::Expired
                | EvmZState::Punishing
        ),
    }
}

async fn try_arm_evm(cli: &Cli, rec: &EvmRecord, st: &mut TowerState) -> Logged {
    let role = rec.role();
    if role == Role::B && !cli.watchtower_own {
        return Some(refuse_not_own(st, &rec.id, B_NOT_OWN_EVM));
    }
    if !evm_due(&rec.swap) {
        return None;
    }
    let package = match evm_package(rec) {
        Ok(p) => p,
        Err(e) => {
            st.retry(format!("Could not build the watchtower package: {e}"));
            return None;
        }
    };
    let action = match role {
        Role::B => "call refund after t1",
        Role::Z => "call punish after t2",
    };
    upload(cli, st, &rec.id, &package, action).await
}

/// Our package for an EVM swap: the swap id and its terms, plus `b` for B.
pub fn evm_package(rec: &EvmRecord) -> Result<EvmPackage, ferry_core::Error> {
    use ferry_evm::{Address, B256, U256};
    let s = rec.swap.session();
    let p = &s.params;
    let t = s.lock_terms()?;
    let role = rec.role();
    Ok(EvmPackage {
        version: EVM_PACKAGE_VERSION,
        counter: Counter::Evm,
        role,
        chain_id: p.chain_id,
        contract: Address::from(p.contract),
        swap_id: B256::from(s.swap_id()),
        terms: EvmTerms {
            token: Address::from(t.token),
            amount: U256::from(t.amount),
            z_addr: Address::from(t.z_addr),
            b_addr: Address::from(t.b_addr),
            claimer: Address::from(t.claimer),
            refunder: Address::from(t.refunder),
            t1: t.t1,
            t2: t.t2,
            max_tip: U256::from(t.max_tip),
        },
        refund_margin: p.refund_margin,
        b: (role == Role::B).then(|| Share::new(*s.me.share_secp_bytes())),
        // Refund pays B's account and punish Z's: ours either way.
        payout_addresses: vec![Address::from(s.me.setup.evm_address)],
        label: Some(rec.id.clone()),
    })
}

fn refuse_not_own(st: &mut TowerState, id: &str, why: &str) -> (&'static str, String) {
    st.status = TowerStatus::Refused;
    st.note = why.into();
    tracing::warn!(%id, "watchtower {}: {why}", st.url);
    ("watchtower_refused", why.into())
}

/// Upload `package`; on success the tower will `action` on time.
async fn upload(
    cli: &Cli,
    st: &mut TowerState,
    id: &str,
    package: &impl Serialize,
    action: &str,
) -> Logged {
    let token = match &cli.watchtower_token_file {
        Some(p) => match std::fs::read_to_string(p) {
            Ok(t) => Some(t.trim().to_string()),
            Err(e) => {
                st.retry(format!("Reading {}: {e}", p.display()));
                return None;
            }
        },
        None => None,
    };
    match Client::new(st.url.clone(), token).upload(package).await {
        Ok(r) => {
            st.status = TowerStatus::Armed;
            st.package_id = Some(r.id.clone());
            st.note = format!("The tower will {action} on time if this Ferry is offline");
            tracing::info!(%id, package = %r.id, "watchtower armed at {}", st.url);
            Some((
                "watchtower_armed",
                format!("Watchtower armed: it will {action} on time if this Ferry goes offline"),
            ))
        }
        // The tower judged the package itself: retrying the same one cannot help.
        Err(ClientError::Refused { status, message }) if status == 400 || status == 409 => {
            st.status = TowerStatus::Refused;
            st.note = format!("The tower refused our package: {message}");
            tracing::error!(%id, "watchtower refused the package ({status}): {message}");
            Some(("watchtower_refused", st.note.clone()))
        }
        Err(e) => {
            st.retry(format!("Watchtower not armed yet: {e}"));
            tracing::warn!(%id, "watchtower: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use ferry_btc::bitcoin::{
        absolute::LockTime, hashes::Hash, transaction::Version, Network, OutPoint, Sequence,
        Transaction, TxIn, TxOut, Txid, Witness,
    };
    use ferry_core::{accept, Action, Event, Proposal, Swap, SwapParams};

    /// Nothing listens here: a test that reached the network would fail to arm.
    const NOWHERE: &str = "http://127.0.0.1:7799";

    fn cli(extra: &[&str]) -> Cli {
        let mut args = vec![
            "ferryd",
            "--role",
            "b",
            "--name",
            "t",
            "--data-dir",
            "/nonexistent",
        ];
        args.extend_from_slice(extra);
        Cli::parse_from(args)
    }

    fn addr() -> Address {
        let secp = ferry_btc::bitcoin::key::Secp256k1::new();
        Address::p2tr(
            &secp,
            ferry_btc::BtcKey::random().xonly(),
            None,
            Network::Regtest,
        )
    }

    fn sends(actions: &[Action]) -> Vec<Event> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::SendMessage(env) => Some(Event::Peer(env.clone())),
                _ => None,
            })
            .collect()
    }

    /// Both parties driven to `CancelSigned` (no node: the lock is a stand-in funding tx).
    fn cancel_signed() -> (Swap, Swap) {
        cancel_signed_on(ferry_btc::Coin::Btc)
    }

    fn cancel_signed_on(coin: ferry_btc::Coin) -> (Swap, Swap) {
        let params = SwapParams {
            coin,
            network: Network::Regtest,
            btc_amount: 1_000_000,
            zec_amount: 1_000_000,
            t1: 12,
            t2: 24,
            btc_fee: 2_000,
            btc_lock_confirmations: 1,
            zec_confirmations: 1,
            cancel_confirmations: 1,
            redeem_margin: 3,
            refund_margin: 3,
            keypath: true,
        };
        let mut rng = rand_core::OsRng;
        let (proposal, propose) =
            Proposal::new(&mut rng, [3; 32], Role::Z, params, addr()).unwrap();
        let (mut b, b_actions) = accept(&mut rng, &propose, addr()).unwrap();
        let Action::SendMessage(acc) = &b_actions[0] else {
            panic!("expected Accept")
        };
        let (mut z, _) = proposal.on_accept(&mut rng, acc).unwrap();
        let Some(Action::FundBtcLock { address, amount }) = b_actions.get(1).cloned() else {
            panic!("expected FundBtcLock")
        };
        let lock = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_raw_hash(Hash::all_zeros()),
                    vout: 3,
                },
                sequence: Sequence::MAX,
                witness: Witness::from_slice(&[[1u8; 64]]),
                ..Default::default()
            }],
            output: vec![TxOut {
                value: amount,
                script_pubkey: address.script_pubkey(),
            }],
        };
        let mut to_z = sends(&b.handle(Event::LockFunded { tx: lock, vout: 0 }).unwrap());
        while !to_z.is_empty() {
            let mut to_b = vec![];
            for ev in to_z.drain(..) {
                to_b.extend(sends(&z.handle(ev).unwrap()));
            }
            for ev in to_b {
                to_z.extend(sends(&b.handle(ev).unwrap()));
            }
        }
        assert_eq!(b.state_name(), "CancelSigned");
        assert_eq!(z.state_name(), "CancelSigned");
        (b, z)
    }

    #[test]
    fn both_packages_pass_the_towers_validation() {
        for coin in [ferry_btc::Coin::Btc, ferry_btc::Coin::Ltc] {
            let (b, z) = cancel_signed_on(coin);
            for swap in [&b, &z] {
                let (txs, cancel, last) = swap.watchtower_txs().unwrap().expect("cancel co-signed");
                let p = &swap.session().params;
                let chain = Chain::new(p.coin, p.network).unwrap();
                let payout =
                    Address::from_script(&last.output[0].script_pubkey, p.network).unwrap();
                let package = Package::new(
                    swap.role(),
                    chain,
                    &txs,
                    p.cancel_confirmations,
                    p.refund_margin,
                    &cancel,
                    &last,
                    &[payout],
                );
                assert_eq!(package.coin, coin);
                package
                    .validate(chain)
                    .unwrap_or_else(|e| panic!("{coin} {:?}: {e}", swap.role()));
                // A tower on the other coin refuses it.
                let other = Chain::new(
                    match coin {
                        ferry_btc::Coin::Btc => ferry_btc::Coin::Ltc,
                        ferry_btc::Coin::Ltc => ferry_btc::Coin::Btc,
                    },
                    p.network,
                )
                .unwrap();
                assert!(package.validate(other).is_err());
            }
        }
    }

    #[tokio::test]
    async fn b_refuses_a_tower_not_marked_its_own() {
        let mut rec = crate::record::tests::sample_record();
        assert_eq!(rec.role(), Role::B);
        arm(&cli(&["--watchtower", NOWHERE]), &mut rec).await;
        let st = rec.watchtower.clone().unwrap();
        assert_eq!(st.status, TowerStatus::Refused);
        assert!(st.note.contains("--watchtower-own"), "{}", st.note);
        assert!(rec.has("watchtower_refused"));
        // Refused once, logged once.
        arm(&cli(&["--watchtower", NOWHERE]), &mut rec).await;
        let refusals = rec
            .timeline
            .iter()
            .filter(|e| e.kind == "watchtower_refused")
            .count();
        assert_eq!(refusals, 1);
    }

    #[tokio::test]
    async fn waits_for_the_cancel_signature_and_is_off_by_default() {
        let mut rec = crate::record::tests::sample_record();
        arm(&cli(&[]), &mut rec).await;
        assert!(rec.watchtower.is_none());
        // Own tower, but nothing to hand over before tx_cancel is co-signed: no upload yet.
        arm(
            &cli(&["--watchtower", NOWHERE, "--watchtower-own"]),
            &mut rec,
        )
        .await;
        let st = rec.watchtower.clone().unwrap();
        assert_eq!((st.status, st.next_try_ms), (TowerStatus::Pending, 0));
        assert!(rec.timeline.is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_tower_is_retried() {
        let (b, _) = cancel_signed();
        let mut rec = crate::record::tests::sample_record();
        rec.swap = b;
        arm(
            &cli(&["--watchtower", NOWHERE, "--watchtower-own"]),
            &mut rec,
        )
        .await;
        let st = rec.watchtower.clone().unwrap();
        assert_eq!(st.status, TowerStatus::Pending);
        assert!(
            st.next_try_ms > 0 && st.note.contains("not armed yet"),
            "{st:?}"
        );
    }

    // ------------------------------------------------------------------ EVM

    /// An EVM swap in both roles, before (`locked = false`) or after the lock is seen on chain.
    fn evm_records(locked: bool) -> (EvmRecord, EvmRecord) {
        use ferry_core::evm::{
            evm_accept, EvmAction, EvmChainEvent, EvmEvent, EvmObservation, EvmParams, EvmProposal,
            ObservedLock, ANVIL_CHAIN_ID,
        };
        let params = EvmParams {
            chain_id: ANVIL_CHAIN_ID,
            contract: [0x11; 20],
            token: [0x22; 20],
            token_amount: 250_000_000,
            token_symbol: "USDC".into(),
            token_decimals: 6,
            zec_amount: 100_000_000,
            t1: 10_000,
            t2: 20_000,
            claim_margin: 60,
            refund_margin: 60,
            lock_confirmations: 1,
            zec_confirmations: 1,
            max_tip: 0,
        };
        let mut rng = rand_core::OsRng;
        let (proposal, propose) =
            EvmProposal::new(&mut rng, [4; 32], Role::Z, params, [0xaa; 20]).unwrap();
        let (mut b, b_actions) = evm_accept(&mut rng, &propose, [0xbb; 20]).unwrap();
        let EvmAction::SendMessage(accept) = &b_actions[0] else {
            panic!("expected Accept")
        };
        let (mut z, _) = proposal.on_accept(&mut rng, accept).unwrap();
        if locked {
            let terms = b.session().lock_terms().unwrap();
            for swap in [&mut b, &mut z] {
                swap.handle(EvmEvent::Chain(EvmChainEvent::Observed(EvmObservation {
                    now: 1_000,
                    lock: Some(ObservedLock {
                        terms: terms.clone(),
                        confs: 1,
                    }),
                    ..Default::default()
                })))
                .unwrap();
            }
        }
        let rec = |swap: EvmSwap| {
            EvmRecord::new("e".into(), swap, NOWHERE.into(), false, String::new(), 0)
        };
        (rec(b), rec(z))
    }

    #[test]
    fn evm_packages_pass_the_towers_offline_validation() {
        let (b, z) = evm_records(true);
        assert_eq!(b.state(), "Locked");
        for rec in [&b, &z] {
            let package = evm_package(rec).unwrap();
            let armed = package
                .validate(ferry_core::evm::ANVIL_CHAIN_ID)
                .unwrap_or_else(|e| panic!("{:?}: {e}", rec.role()));
            assert_eq!(armed.swap_id.0, rec.swap.session().swap_id());
            let mine = ferry_evm::Address::from(rec.swap.session().me.setup.evm_address);
            assert_eq!(package.payout_addresses, vec![mine]);
            let json = serde_json::to_value(&package).unwrap();
            assert_eq!(json["counter"], "evm");
            // Only B's package holds a secret: its share b.
            assert_eq!(json.get("b").is_some(), rec.role() == Role::B);
        }
        let (bt, zt) = (
            evm_package(&b).unwrap().terms,
            evm_package(&z).unwrap().terms,
        );
        assert_eq!(bt, zt, "both sides describe the same lock");
        assert_eq!(bt.refunder, ferry_evm::Address::repeat_byte(0xbb));
        assert_eq!(bt.claimer, ferry_evm::Address::repeat_byte(0xaa));
    }

    #[tokio::test]
    async fn b_refuses_an_evm_tower_not_marked_its_own() {
        let (mut b, mut z) = evm_records(true);
        let not_own = cli(&["--counter", "evm", "--watchtower", NOWHERE]);
        arm_evm(&not_own, &mut b).await;
        let st = b.watchtower.clone().unwrap();
        assert_eq!(st.status, TowerStatus::Refused);
        assert!(
            st.note.contains("--watchtower-own") && st.note.contains("b"),
            "{}",
            st.note
        );
        arm_evm(&not_own, &mut b).await;
        let refusals = b
            .timeline
            .iter()
            .filter(|e| e.kind == "watchtower_refused")
            .count();
        assert_eq!(refusals, 1, "refused once, logged once");
        // Z's package holds no secret: Z arms any tower (here an unreachable one, so it retries).
        arm_evm(&not_own, &mut z).await;
        let st = z.watchtower.clone().unwrap();
        assert_eq!(st.status, TowerStatus::Pending);
        assert!(
            st.next_try_ms > 0 && st.note.contains("not armed yet"),
            "{st:?}"
        );
    }

    #[tokio::test]
    async fn evm_waits_for_the_lock_and_is_off_by_default() {
        let (mut b, mut z) = evm_records(false);
        arm_evm(&cli(&["--counter", "evm"]), &mut b).await;
        assert!(b.watchtower.is_none());
        let own = cli(&[
            "--counter",
            "evm",
            "--watchtower",
            NOWHERE,
            "--watchtower-own",
        ]);
        for rec in [&mut b, &mut z] {
            arm_evm(&own, rec).await;
            let st = rec.watchtower.clone().unwrap();
            assert_eq!(
                (st.status, st.next_try_ms),
                (TowerStatus::Pending, 0),
                "{st:?}"
            );
            assert!(st.note.contains("FerryLock lock"), "{}", st.note);
            assert!(rec.timeline.is_empty());
        }
    }
}
