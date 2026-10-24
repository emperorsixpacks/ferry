//! Persistent per-swap record of an EVM swap: the state machine plus everything needed to
//! resume and to render the UI view. One JSON file per swap under `<data-dir>/evm-swaps`.

use std::path::{Path, PathBuf};

use ferry_core::evm::{EvmAction, EvmEnvelope, EvmSwap, LockTerms};
use ferry_core::{Role, Secret32};
use serde::{Deserialize, Serialize};

use crate::record::{private_dir, state_label, write_private, TimelineEntry};

/// An [`EvmAction`] not executed yet, in a form that survives a restart.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvmPending {
    Send {
        envelope: Box<EvmEnvelope>,
    },
    Lock {
        salt: String,
        terms: LockTerms,
    },
    SignReady {
        digest: String,
    },
    Claim {
        id: String,
        z: Secret32,
        ready_sig: String,
        not_after: u64,
    },
    Refund {
        id: String,
        b: Secret32,
        not_before: u64,
        not_after: u64,
    },
    Punish {
        id: String,
    },
    SendZec {
        fvk: String,
        amount: u64,
    },
    SweepZec {
        fvk: String,
        ask: Secret32,
    },
}

impl EvmPending {
    pub fn is_zec(&self) -> bool {
        matches!(
            self,
            EvmPending::SendZec { .. } | EvmPending::SweepZec { .. }
        )
    }
}

impl From<EvmAction> for EvmPending {
    fn from(a: EvmAction) -> EvmPending {
        match a {
            EvmAction::SendMessage(envelope) => EvmPending::Send {
                envelope: Box::new(envelope),
            },
            EvmAction::Lock { salt, terms } => EvmPending::Lock {
                salt: hex::encode(salt),
                terms,
            },
            EvmAction::SignReady { digest } => EvmPending::SignReady {
                digest: hex::encode(digest),
            },
            EvmAction::Claim {
                id,
                z,
                ready_sig,
                not_after,
            } => EvmPending::Claim {
                id: hex::encode(id),
                z,
                ready_sig: hex::encode(ready_sig),
                not_after,
            },
            EvmAction::Refund {
                id,
                b,
                not_before,
                not_after,
            } => EvmPending::Refund {
                id: hex::encode(id),
                b,
                not_before,
                not_after,
            },
            EvmAction::Punish { id } => EvmPending::Punish {
                id: hex::encode(id),
            },
            EvmAction::SendZec { joint_fvk, amount } => EvmPending::SendZec {
                fvk: hex::encode(joint_fvk),
                amount,
            },
            EvmAction::SweepZec { joint_fvk, ask } => EvmPending::SweepZec {
                fvk: hex::encode(joint_fvk),
                ask,
            },
        }
    }
}

pub fn bytes<const N: usize>(s: &str) -> [u8; N] {
    hex::decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .expect("hex recorded by us")
}

/// An EVM transaction of the swap, ours or seen.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EvmTx {
    pub hash: String,
    pub block: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmRecord {
    pub id: String,
    pub swap: EvmSwap,
    pub counterparty: String,
    pub taker: bool,
    pub outbox: Vec<EvmEnvelope>,
    pub sent: usize,
    pub peer_seen: usize,
    pub received: Vec<String>,
    #[serde(default)]
    pub rejected: u32,
    pub pending: Vec<EvmPending>,
    pub timeline: Vec<TimelineEntry>,
    /// Demo fault: act on nothing, only observe.
    pub stalled: bool,
    /// Z's stall ends once the claim window has closed (t1).
    pub resume_at_t1: bool,
    /// First block to scan for the swap's events (the head when the swap was created).
    pub from_block: u64,
    /// Latest block time seen.
    #[serde(default)]
    pub now: u64,
    /// The swap's EVM transactions, keyed lock / claim / refund / punish.
    #[serde(default)]
    pub evm_txs: Vec<(String, EvmTx)>,
    pub zec_lock_txid: Option<String>,
    pub zec_sweep_txid: Option<String>,
    #[serde(default)]
    pub zec_spent_by: Option<String>,
    #[serde(default)]
    pub sweep_not_before: Option<u64>,
    #[serde(default)]
    pub zec_send_intent: bool,
    #[serde(default)]
    pub created_ms: u64,
    pub mine_revealed: bool,
    pub peer_learned: bool,
    pub zec_joint: String,
    pub observer_evm: Vec<(String, String)>,
    pub observer_zec: Vec<(String, String)>,
}

impl EvmRecord {
    pub fn new(
        id: String,
        swap: EvmSwap,
        counterparty: String,
        taker: bool,
        zec_joint: String,
        from_block: u64,
    ) -> Self {
        EvmRecord {
            id,
            swap,
            counterparty,
            taker,
            outbox: vec![],
            sent: 0,
            peer_seen: 0,
            received: vec![],
            rejected: 0,
            pending: vec![],
            timeline: vec![],
            stalled: false,
            resume_at_t1: false,
            from_block,
            now: 0,
            evm_txs: vec![],
            zec_lock_txid: None,
            zec_sweep_txid: None,
            zec_spent_by: None,
            sweep_not_before: None,
            zec_send_intent: false,
            created_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            mine_revealed: false,
            peer_learned: false,
            zec_joint,
            observer_evm: vec![],
            observer_zec: vec![],
        }
    }

    pub fn role(&self) -> Role {
        self.swap.role()
    }

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

    pub fn evm_tx(&self, key: &str) -> Option<&EvmTx> {
        self.evm_txs.iter().find(|(k, _)| k == key).map(|(_, t)| t)
    }

    /// Record a transaction of the swap; returns true the first time.
    pub fn set_evm_tx(&mut self, key: &str, hash: String, block: Option<u64>) -> bool {
        if let Some((_, t)) = self.evm_txs.iter_mut().find(|(k, _)| k == key) {
            if t.hash == hash && block.is_some() {
                t.block = block;
            }
            return false;
        }
        self.evm_txs.push((key.into(), EvmTx { hash, block }));
        true
    }

    pub fn outcome(&self) -> Option<&'static str> {
        match (self.role(), self.state().as_str()) {
            (Role::B, "ZecSwept") | (Role::Z, "Claimed") => Some("swapped"),
            (Role::B, "Refunded") | (Role::Z, "ZecReclaimed" | "Refunded") => Some("refunded"),
            (_, "Punished") => Some("punished"),
            _ => None,
        }
    }

    /// Nothing left to do or to fill in.
    pub fn settled(&self) -> bool {
        let sweep_expected =
            matches!(self.outcome(), Some("swapped" | "refunded")) && self.zec_lock_txid.is_some();
        let late_note_possible = self.role() == Role::Z
            && self.state() == "Refunded"
            && (self.zec_send_intent
                || self.has("zec_lock_refused")
                || self.has("zec_send_uncertain"));
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

/// One JSON file per EVM swap under `<data-dir>/evm-swaps`, written atomically.
#[derive(Clone)]
pub struct EvmStore {
    dir: PathBuf,
}

impl EvmStore {
    /// Records hold secret key shares: the directory is 0700 and every file 0600.
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        private_dir(data_dir)?;
        let dir = data_dir.join("evm-swaps");
        private_dir(&dir)?;
        Ok(EvmStore { dir })
    }

    pub fn save(&self, rec: &EvmRecord) -> std::io::Result<()> {
        let tmp = self.dir.join(format!(".{}.json.tmp", rec.id));
        write_private(&tmp, &serde_json::to_vec_pretty(rec)?)?;
        std::fs::rename(tmp, self.dir.join(format!("{}.json", rec.id)))?;
        std::fs::File::open(&self.dir)?.sync_all()
    }

    pub fn load_all(&self) -> std::io::Result<Vec<EvmRecord>> {
        let mut out = vec![];
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json")
                && !path.file_name().unwrap().to_string_lossy().starts_with('.')
            {
                let rec: EvmRecord = serde_json::from_slice(&std::fs::read(&path)?)
                    .map_err(|e| std::io::Error::other(format!("{}: {e}", path.display())))?;
                out.push(rec);
            }
        }
        Ok(out)
    }
}
