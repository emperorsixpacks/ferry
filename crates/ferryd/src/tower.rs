//! Arming a watchtower (`--watchtower`): once tx_cancel is co-signed, upload our fully signed
//! deadline transactions (B: tx_cancel + completed tx_refund, Z: tx_cancel + tx_punish), so the
//! swap still ends safely if this daemon goes offline. docs/WATCHTOWER.md.

use ferry_btc::bitcoin::Address;
use ferry_core::Role;
use ferry_watchtower::{Client, ClientError, Package};
use serde::{Deserialize, Serialize};

use crate::config::Cli;
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

/// Called every tick; does nothing without `--watchtower`, once armed, or once refused.
pub async fn arm(cli: &Cli, rec: &mut SwapRecord) {
    let Some(url) = &cli.watchtower else { return };
    if rec.swap.is_final() {
        return;
    }
    let mut st = rec.watchtower.take().unwrap_or_else(|| TowerState {
        url: url.clone(),
        status: TowerStatus::Pending,
        package_id: None,
        note: "Waiting for tx_cancel to be co-signed".into(),
        next_try_ms: 0,
    });
    if st.status == TowerStatus::Pending && now_ms() >= st.next_try_ms {
        try_arm(cli, rec, &mut st).await;
    }
    rec.watchtower = Some(st);
}

async fn try_arm(cli: &Cli, rec: &mut SwapRecord, st: &mut TowerState) {
    let role = rec.role();
    if role == Role::B && !cli.watchtower_own {
        st.status = TowerStatus::Refused;
        st.note = B_NOT_OWN.into();
        tracing::warn!(id = %rec.id, "watchtower {}: {B_NOT_OWN}", st.url);
        rec.log("local", "watchtower_refused", B_NOT_OWN, None);
        return;
    }
    let (txs, cancel, last) = match rec.swap.watchtower_txs() {
        Ok(Some(t)) => t,
        Ok(None) => return,
        Err(e) => {
            st.note = format!("Could not build the watchtower package: {e}");
            st.next_try_ms = now_ms() + RETRY_MS;
            return;
        }
    };
    let params = &rec.swap.session().params;
    let Ok(payout) = Address::from_script(&last.output[0].script_pubkey, params.network) else {
        st.status = TowerStatus::Refused;
        st.note = "Our payout script has no address form".into();
        return;
    };
    let mut package = Package::new(
        role,
        params.network,
        &txs,
        params.cancel_confirmations,
        params.refund_margin,
        &cancel,
        &last,
        &[payout],
    );
    package.label = Some(rec.id.clone());
    let token = match &cli.watchtower_token_file {
        Some(p) => match std::fs::read_to_string(p) {
            Ok(t) => Some(t.trim().to_string()),
            Err(e) => {
                st.note = format!("Reading {}: {e}", p.display());
                st.next_try_ms = now_ms() + RETRY_MS;
                return;
            }
        },
        None => None,
    };
    match Client::new(st.url.clone(), token).upload(&package).await {
        Ok(r) => {
            st.status = TowerStatus::Armed;
            st.package_id = Some(r.id.clone());
            let what = match role {
                Role::B => "call-off and refund",
                Role::Z => "call-off and penalty",
            };
            st.note =
                format!("The tower will broadcast the {what} on time if this Ferry is offline");
            tracing::info!(id = %rec.id, package = %r.id, "watchtower armed at {}", st.url);
            rec.log(
                "local",
                "watchtower_armed",
                format!(
                    "Watchtower armed: it broadcasts the {what} on time if this Ferry goes offline"
                ),
                None,
            );
        }
        // The tower judged the package itself: retrying the same one cannot help.
        Err(ClientError::Refused { status, message }) if status == 400 || status == 409 => {
            st.status = TowerStatus::Refused;
            st.note = format!("The tower refused our package: {message}");
            tracing::error!(id = %rec.id, "watchtower refused the package ({status}): {message}");
            rec.log("local", "watchtower_refused", st.note.clone(), None);
        }
        Err(e) => {
            st.note = format!("Watchtower not armed yet: {e}");
            st.next_try_ms = now_ms() + RETRY_MS;
            tracing::warn!(id = %rec.id, "watchtower: {e}");
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
        let params = SwapParams {
            coin: ferry_btc::Coin::Btc,
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
        let (b, z) = cancel_signed();
        for swap in [&b, &z] {
            let (txs, cancel, last) = swap.watchtower_txs().unwrap().expect("cancel co-signed");
            let p = &swap.session().params;
            let payout = Address::from_script(&last.output[0].script_pubkey, p.network).unwrap();
            let package = Package::new(
                swap.role(),
                p.network,
                &txs,
                p.cancel_confirmations,
                p.refund_margin,
                &cancel,
                &last,
                &[payout],
            );
            package
                .validate(p.network)
                .unwrap_or_else(|e| panic!("{:?}: {e}", swap.role()));
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
}
