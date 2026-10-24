//! Persistent per-swap record: the state machine plus everything the daemon needs to resume
//! (outbox, delivery cursors, unexecuted actions) and to render the UI view.

use std::path::{Path, PathBuf};

use ferry_btc::bitcoin::Transaction;
use ferry_core::{Action, Envelope, Role, Secret32, Swap};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub at: String,
    /// local | btc | zec | peer
    pub chain: String,
    pub kind: String,
    pub label: String,
    pub txid: Option<String>,
    pub height: Option<u64>,
}

/// A transaction we keep (re)broadcasting.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Rebroadcast {
    pub tx: Transaction,
    /// The timeline already has its `*_broadcast` entry.
    pub announced: bool,
}

/// An [`Action`] the daemon has not executed yet, in a form that survives a restart.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Pending {
    Send { envelope: Box<Envelope> },
    FundLock { address: String, amount_sat: u64 },
    Broadcast { tx: Transaction },
    SendZec { fvk: String, amount: u64 },
    SweepZec { fvk: String, ask: Secret32 },
}

impl From<Action> for Pending {
    fn from(a: Action) -> Pending {
        match a {
            Action::SendMessage(envelope) => Pending::Send {
                envelope: Box::new(envelope),
            },
            Action::FundBtcLock { address, amount } => Pending::FundLock {
                address: address.to_string(),
                amount_sat: amount.to_sat(),
            },
            Action::BroadcastBtc(tx) => Pending::Broadcast { tx },
            Action::SendZec { joint_fvk, amount } => Pending::SendZec {
                fvk: hex::encode(joint_fvk),
                amount,
            },
            Action::SweepZec { joint_fvk, ask } => Pending::SweepZec {
                fvk: hex::encode(joint_fvk),
                ask,
            },
        }
    }
}

pub fn fvk_from_hex(s: &str) -> [u8; 96] {
    hex::decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .expect("fvk recorded by us")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SwapRecord {
    pub id: String,
    pub swap: Swap,
    /// The other daemon's URL.
    pub counterparty: String,
    /// We proposed (and so push our messages to, and poll, the maker).
    pub taker: bool,
    /// Messages we sent, in order. For a maker, index 0 is the `Accept`.
    pub outbox: Vec<Envelope>,
    /// Taker: how many outbox messages the maker has acknowledged.
    pub sent: usize,
    /// Taker: how many of the maker's outbox messages we have processed.
    pub peer_seen: usize,
    /// Maker: digests of envelopes already processed (retries are acknowledged, not reapplied).
    pub received: Vec<String>,
    pub pending: Vec<Pending>,
    pub timeline: Vec<TimelineEntry>,
    /// Demo fault: act on nothing, only observe.
    pub stalled: bool,
    /// Z's stall ends once tx_cancel confirms.
    pub resume_on_cancel: bool,
    pub btc_lock_height: Option<u64>,
    pub cancel_height: Option<u64>,
    /// The ZEC lock transaction (Z: ours, B: the note's).
    pub zec_lock_txid: Option<String>,
    /// Our sweep of the joint address; cleared if it expires unmined, so we sweep again.
    pub zec_sweep_txid: Option<String>,
    /// Whoever's transaction spends the lock note (seen with the viewing key), mined or not
    /// yet expired.
    #[serde(default)]
    pub zec_spent_by: Option<String>,
    /// Unix ms before which we do not sweep (random delay, set when the sweep is queued).
    #[serde(default)]
    pub sweep_not_before: Option<u64>,
    /// We are about to send (or sent) our ZEC lock; set and persisted before calling the
    /// wallet, so a crash in between can never lead to a second send.
    #[serde(default)]
    pub zec_send_intent: bool,
    /// Presigned spends we broadcast, rebroadcast every tick until they or a conflicting spend
    /// are buried (a rejected or evicted refund must not be lost).
    #[serde(default)]
    pub rebroadcast: Vec<Rebroadcast>,
    /// Unix ms when the swap was created (negotiation deadline).
    #[serde(default)]
    pub created_ms: u64,
    /// Peer envelopes refused so far (bounded: past the cap the peer gets 429).
    #[serde(default)]
    pub rejected: u32,
    /// Demo fault: treat the next N broadcasts as rejected by the node.
    #[serde(default)]
    pub drop_broadcasts: u32,
    pub mine_revealed: bool,
    pub peer_learned: bool,
    pub zec_joint: String,
    /// What a chain observer sees, keyed by transaction kind.
    pub observer_btc: Vec<(String, String)>,
    pub observer_zec: Vec<(String, String)>,
    /// Our package at the watchtower (--watchtower), if one is configured.
    #[serde(default)]
    pub watchtower: Option<crate::tower::TowerState>,
}

impl SwapRecord {
    pub fn new(
        id: String,
        swap: Swap,
        counterparty: String,
        taker: bool,
        zec_joint: String,
    ) -> Self {
        SwapRecord {
            id,
            swap,
            counterparty,
            taker,
            outbox: vec![],
            sent: 0,
            peer_seen: 0,
            received: vec![],
            pending: vec![],
            timeline: vec![],
            stalled: false,
            resume_on_cancel: false,
            btc_lock_height: None,
            cancel_height: None,
            zec_lock_txid: None,
            zec_sweep_txid: None,
            zec_spent_by: None,
            sweep_not_before: None,
            zec_send_intent: false,
            rebroadcast: vec![],
            rejected: 0,
            drop_broadcasts: 0,
            created_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            mine_revealed: false,
            peer_learned: false,
            zec_joint,
            observer_btc: vec![],
            observer_zec: vec![],
            watchtower: None,
        }
    }

    pub fn role(&self) -> Role {
        self.swap.role()
    }

    /// State name without variant data (`ZecSeen { confs: 1 }` → `ZecSeen`).
    pub fn state(&self) -> String {
        state_label(&self.swap.state_name())
    }

    pub fn log(&mut self, chain: &str, kind: &str, label: impl Into<String>, txid: Option<String>) {
        self.timeline.push(TimelineEntry {
            at: humantime::format_rfc3339_seconds(std::time::SystemTime::now()).to_string(),
            chain: chain.into(),
            kind: kind.into(),
            label: label.into(),
            txid,
            height: None,
        });
    }

    pub fn has(&self, kind: &str) -> bool {
        self.timeline.iter().any(|e| e.kind == kind)
    }

    pub fn outcome(&self) -> Option<&'static str> {
        match (self.role(), self.state().as_str()) {
            (Role::B, "ZecSwept") | (Role::Z, "BtcRedeemed") => Some("swapped"),
            (Role::B, "Refunded") | (Role::Z, "ZecReclaimed" | "Refunded") => Some("refunded"),
            (_, "Punished") => Some("punished"),
            _ => None,
        }
    }

    /// Nothing left to do or to fill in.
    pub fn settled(&self) -> bool {
        // On the swapped and refunded paths someone sweeps the joint note; keep watching
        // until we have seen it, so both parties show the same observer lines.
        let sweep_expected =
            matches!(self.outcome(), Some("swapped" | "refunded")) && self.zec_lock_txid.is_some();
        // Z refunded without (knowingly) locking ZEC, but a send was attempted: keep watching
        // the joint address, so a note that lands anyway is reclaimed rather than stranded.
        let late_note_possible = self.role() == Role::Z
            && self.state() == "Refunded"
            && (self.zec_send_intent || self.has("zec_lock_refused") || self.has("zec_send_uncertain"));
        !late_note_possible
            && self.swap.is_final()
            && self.pending.is_empty()
            && (!sweep_expected || self.observer_zec.iter().any(|(k, _)| k == "sweep"))
            && self
                .timeline
                .iter()
                .all(|e| e.txid.is_none() || e.height.is_some())
    }

    pub fn set_observer(list: &mut Vec<(String, String)>, key: &str, line: String) {
        if !list.iter().any(|(k, _)| k == key) {
            list.push((key.into(), line));
        }
    }
}

pub fn state_label(debug: &str) -> String {
    debug
        .split([' ', '{', '('])
        .next()
        .unwrap_or(debug)
        .to_string()
}

/// One JSON file per swap under `<data-dir>/swaps`, written atomically.
#[derive(Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// Swap records hold secret key shares: the directory is 0700 and every file 0600.
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        private_dir(data_dir)?;
        let dir = data_dir.join("swaps");
        private_dir(&dir)?;
        Ok(Store { dir })
    }

    /// Durable once it returns Ok: the file is fsynced, renamed into place and the directory
    /// entry fsynced.
    pub fn save(&self, rec: &SwapRecord) -> std::io::Result<()> {
        let tmp = self.dir.join(format!(".{}.json.tmp", rec.id));
        write_private(&tmp, &serde_json::to_vec_pretty(rec)?)?;
        std::fs::rename(tmp, self.dir.join(format!("{}.json", rec.id)))?;
        std::fs::File::open(&self.dir)?.sync_all()
    }

    pub fn load_all(&self) -> std::io::Result<Vec<SwapRecord>> {
        let mut out = vec![];
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json")
                && !path.file_name().unwrap().to_string_lossy().starts_with('.')
            {
                let rec: SwapRecord = serde_json::from_slice(&std::fs::read(&path)?)
                    .map_err(|e| std::io::Error::other(format!("{}: {e}", path.display())))?;
                out.push(rec);
            }
        }
        Ok(out)
    }
}

/// Create `dir` (and parents) and restrict it to the owner.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write a fresh owner-only (0600) file at `path`, replacing a stale one. The file is created
/// with `create_new`, so its mode is never looser than 0600, not even briefly.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn sample_record() -> SwapRecord {
        use ferry_btc::bitcoin::{Address, Network};
        use ferry_core::{accept, Proposal, SwapParams};
        let secp = ferry_btc::bitcoin::key::Secp256k1::new();
        let addr = || {
            Address::p2tr(
                &secp,
                ferry_btc::BtcKey::random().xonly(),
                None,
                Network::Regtest,
            )
        };
        let params = SwapParams {
            coin: ferry_btc::Coin::Btc,
            network: Network::Regtest,
            btc_amount: 1_000_000,
            zec_amount: 1_000_000,
            t1: 12,
            t2: 12,
            btc_fee: 2_000,
            btc_lock_confirmations: 1,
            zec_confirmations: 1,
            cancel_confirmations: 1,
            redeem_margin: 3,
            refund_margin: 3,
            keypath: true,
        };
        let mut rng = rand_core::OsRng;
        let (_, propose) = Proposal::new(&mut rng, [1; 32], Role::Z, params, addr()).unwrap();
        let (swap, _) = accept(&mut rng, &propose, addr()).unwrap();
        SwapRecord::new(
            "01".repeat(32),
            swap,
            "http://peer".into(),
            false,
            "u1".into(),
        )
    }

    #[test]
    fn state_labels() {
        assert_eq!(state_label("ZecSeen { confs: 2 }"), "ZecSeen");
        assert_eq!(state_label("BtcLocked"), "BtcLocked");
    }

    #[cfg(unix)]
    #[test]
    fn save_reports_failure_and_never_leaves_a_partial_record() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let swaps = tmp.path().join("swaps");
        std::fs::set_permissions(&swaps, std::fs::Permissions::from_mode(0o500)).unwrap();
        let rec = sample_record();
        assert!(
            store.save(&rec).is_err(),
            "a read-only directory must surface as an error"
        );
        std::fs::set_permissions(&swaps, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(std::fs::read_dir(&swaps).unwrap().next().is_none());
        store.save(&rec).unwrap();
        assert_eq!(store.load_all().unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn private_files_and_dirs() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("data");
        Store::open(&dir).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("swaps")), 0o700);
        let f = dir.join("secret");
        write_private(&f, b"one").unwrap();
        write_private(&f, b"two").unwrap();
        assert_eq!(mode(&f), 0o600);
        assert_eq!(std::fs::read(&f).unwrap(), b"two");
    }
}
