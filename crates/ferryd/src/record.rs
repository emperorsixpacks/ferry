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
    /// Our sweep of the joint address.
    pub zec_sweep_txid: Option<String>,
    pub mine_revealed: bool,
    pub peer_learned: bool,
    pub zec_joint: String,
    /// What a chain observer sees, keyed by transaction kind.
    pub observer_btc: Vec<(String, String)>,
    pub observer_zec: Vec<(String, String)>,
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
            mine_revealed: false,
            peer_learned: false,
            zec_joint,
            observer_btc: vec![],
            observer_zec: vec![],
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
        self.swap.is_final()
            && self.pending.is_empty()
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
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        let dir = data_dir.join("swaps");
        std::fs::create_dir_all(&dir)?;
        Ok(Store { dir })
    }

    pub fn save(&self, rec: &SwapRecord) -> std::io::Result<()> {
        let tmp = self.dir.join(format!(".{}.json.tmp", rec.id));
        std::fs::write(&tmp, serde_json::to_vec_pretty(rec)?)?;
        std::fs::rename(tmp, self.dir.join(format!("{}.json", rec.id)))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_labels() {
        assert_eq!(state_label("ZecSeen { confs: 2 }"), "ZecSeen");
        assert_eq!(state_label("BtcLocked"), "BtcLocked");
    }
}
