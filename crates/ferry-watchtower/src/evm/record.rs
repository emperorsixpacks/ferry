//! What the tower keeps per EVM package (`<data-dir>/packages/<id>.json`, mode 0600) and what
//! `GET /packages/:id` shows of it.

use ferry_btc::Role;
use ferry_evm::{Address, B256};
use serde::{Deserialize, Serialize};

use super::engine::{advice, EvmCall};
use super::package::EvmPackage;
use crate::engine::{Outcome, Status};
use crate::store::{now, LogLine, Stored};
use crate::Counter;

/// Most log lines kept per package.
const MAX_EVENTS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmSendLog {
    pub call: EvmCall,
    /// None if nothing was sent (the simulation failed, or the node refused it).
    pub tx_hash: Option<B256>,
    pub at: u64,
    /// The latest block's time when it was sent (shows the rule that allowed it).
    pub block_time: u64,
    pub error: Option<String>,
    /// Identical consecutive attempts are folded into one entry.
    pub attempts: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmRecord {
    pub id: String,
    pub created_at: u64,
    pub package: EvmPackage,
    pub status: Status,
    pub outcome: Option<Outcome>,
    /// What the tower is waiting for, or what it just did.
    pub note: String,
    /// The latest block's time at the last poll.
    pub chain_time: Option<u64>,
    /// Our last call while it may still land.
    pub pending_tx: Option<B256>,
    pub sends: Vec<EvmSendLog>,
    pub events: Vec<LogLine>,
}

impl Stored for EvmRecord {
    fn id(&self) -> &str {
        &self.id
    }
}

impl EvmRecord {
    pub fn new(id: String, package: EvmPackage) -> EvmRecord {
        let now = now();
        EvmRecord {
            id,
            created_at: now,
            package,
            status: Status::Armed,
            outcome: None,
            note: "armed".into(),
            chain_time: None,
            pending_tx: None,
            sends: vec![],
            events: vec![LogLine {
                at: now,
                text: "package validated against the chain and armed".into(),
            }],
        }
    }

    pub fn log(&mut self, text: impl Into<String>) {
        let text = text.into();
        if self.events.last().is_some_and(|l| l.text == text) {
            return;
        }
        self.events.push(LogLine { at: now(), text });
        if self.events.len() > MAX_EVENTS {
            self.events.remove(0);
        }
    }

    pub fn log_send(&mut self, entry: EvmSendLog) {
        if let Some(last) = self.sends.last_mut() {
            if last.call == entry.call && last.error.is_some() && last.error == entry.error {
                last.attempts += 1;
                last.at = entry.at;
                last.block_time = entry.block_time;
                return;
            }
        }
        self.sends.push(entry);
        if self.sends.len() > MAX_EVENTS {
            self.sends.remove(0);
        }
    }

    pub fn view(&self) -> EvmPackageView {
        let p = &self.package;
        EvmPackageView {
            id: self.id.clone(),
            counter: Counter::Evm,
            role: p.role,
            chain_id: p.chain_id,
            contract: p.contract,
            swap_id: p.swap_id,
            label: p.label.clone(),
            status: self.status,
            outcome: self.outcome,
            advice: self.outcome.map(|o| advice(o, p.role).to_string()),
            note: self.note.clone(),
            t1: p.terms.t1,
            t2: p.terms.t2,
            refund_margin: p.refund_margin,
            chain_time: self.chain_time,
            pending_tx: self.pending_tx,
            sends: self.sends.clone(),
            created_at: self.created_at,
            events: self.events.clone(),
        }
    }
}

/// `GET /packages/:id` for an EVM package. Never includes B's share.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmPackageView {
    pub id: String,
    pub counter: Counter,
    pub role: Role,
    pub chain_id: u64,
    pub contract: Address,
    pub swap_id: B256,
    pub label: Option<String>,
    pub status: Status,
    pub outcome: Option<Outcome>,
    pub advice: Option<String>,
    pub note: String,
    pub t1: u64,
    pub t2: u64,
    pub refund_margin: u64,
    pub chain_time: Option<u64>,
    pub pending_tx: Option<B256>,
    pub sends: Vec<EvmSendLog>,
    pub created_at: u64,
    pub events: Vec<LogLine>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evm::package::testkit::EvmSwap;
    use crate::store::Store;

    #[test]
    fn records_persist_and_the_view_hides_b() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let s = EvmSwap::new(31337, Address::repeat_byte(0x11), 1_000, 2_000);
        let mut rec = EvmRecord::new("e1".into(), s.b_package());
        let failed = |error: &str| EvmSendLog {
            call: EvmCall::Refund,
            tx_hash: None,
            at: 1,
            block_time: 1_000,
            error: Some(error.into()),
            attempts: 1,
        };
        rec.log_send(failed("would revert"));
        rec.log_send(failed("would revert"));
        rec.log_send(EvmSendLog {
            tx_hash: Some(B256::repeat_byte(1)),
            error: None,
            ..failed("")
        });
        assert_eq!(rec.sends.len(), 2);
        assert_eq!(rec.sends[0].attempts, 2);
        store.save(&rec).unwrap();
        let back: Vec<EvmRecord> = store.load_all().unwrap();
        assert_eq!(back, vec![rec.clone()]);
        let view = serde_json::to_value(rec.view()).unwrap();
        assert_eq!(view["counter"], "evm");
        assert_eq!(view["role"], "B");
        assert!(
            !view.to_string().contains(&hex::encode(s.b())),
            "the view never shows b"
        );
        let file = std::fs::read_to_string(dir.path().join("packages/e1.json")).unwrap();
        assert!(file.contains(&hex::encode(s.b())), "the record keeps b");
    }
}
