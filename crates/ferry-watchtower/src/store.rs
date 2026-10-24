//! One JSON file per package under `<data-dir>/packages`, written atomically (mode 0600).

use std::path::{Path, PathBuf};

use ferry_btc::bitcoin::{Network, OutPoint, Txid};
use ferry_btc::{Coin, Role, Spend};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::engine::{Outcome, Status};
use crate::package::{Armed, Package};

/// Most log lines kept per package.
const MAX_EVENTS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogLine {
    /// Unix seconds.
    pub at: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BroadcastLog {
    pub spend: Spend,
    pub txid: Txid,
    pub at: u64,
    /// Lock and cancel confirmations when it was sent (shows the rule that allowed it).
    pub lock_confs: Option<u32>,
    pub cancel_confs: Option<u32>,
    /// None if the node accepted it.
    pub error: Option<String>,
    /// Identical consecutive attempts are folded into one entry.
    pub attempts: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub created_at: u64,
    pub package: Package,
    pub status: Status,
    pub outcome: Option<Outcome>,
    /// What the tower is waiting for, or what it just did.
    pub note: String,
    pub lock_confs: Option<u32>,
    pub cancel_confs: Option<u32>,
    pub broadcasts: Vec<BroadcastLog>,
    pub events: Vec<LogLine>,
}

impl Record {
    pub fn new(id: String, package: Package) -> Record {
        let now = now();
        Record {
            id,
            created_at: now,
            package,
            status: Status::Armed,
            outcome: None,
            note: "armed".into(),
            lock_confs: None,
            cancel_confs: None,
            broadcasts: vec![],
            events: vec![LogLine {
                at: now,
                text: "package validated and armed".into(),
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

    pub fn log_broadcast(&mut self, entry: BroadcastLog) {
        if let Some(last) = self.broadcasts.last_mut() {
            if last.spend == entry.spend && last.error == entry.error {
                last.attempts += 1;
                last.at = entry.at;
                return;
            }
        }
        self.broadcasts.push(entry);
        if self.broadcasts.len() > MAX_EVENTS {
            self.broadcasts.remove(0);
        }
    }

    pub fn view(&self, armed: &Armed) -> PackageView {
        let role = self.package.role;
        PackageView {
            id: self.id.clone(),
            role,
            coin: self.package.coin,
            network: self.package.network,
            label: self.package.label.clone(),
            status: self.status,
            outcome: self.outcome,
            // The advice is worded for Bitcoin; a Litecoin package gets its own ticker.
            advice: self
                .outcome
                .map(|o| o.advice(role).replace("BTC", self.package.coin.ticker())),
            note: self.note.clone(),
            lock_outpoint: armed.lock_outpoint,
            cancel_txid: armed.cancel_txid(),
            refund_txid: (role == Role::B).then(|| armed.final_txid()),
            punish_txid: (role == Role::Z).then(|| armed.final_txid()),
            lock_confs: self.lock_confs,
            cancel_confs: self.cancel_confs,
            t1: self.package.t1,
            t2: self.package.t2,
            created_at: self.created_at,
            broadcasts: self.broadcasts.clone(),
            events: self.events.clone(),
        }
    }
}

/// `GET /packages/:id`. Never includes the transactions themselves: B's completed
/// tx_refund must not leak before it is due (docs/WATCHTOWER.md).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageView {
    pub id: String,
    pub role: Role,
    /// `btc` or `ltc`.
    #[serde(default)]
    pub coin: Coin,
    pub network: Network,
    pub label: Option<String>,
    pub status: Status,
    pub outcome: Option<Outcome>,
    pub advice: Option<String>,
    pub note: String,
    pub lock_outpoint: OutPoint,
    pub cancel_txid: Txid,
    pub refund_txid: Option<Txid>,
    pub punish_txid: Option<Txid>,
    pub lock_confs: Option<u32>,
    pub cancel_confs: Option<u32>,
    pub t1: u16,
    pub t2: u16,
    pub created_at: u64,
    pub broadcasts: Vec<BroadcastLog>,
    pub events: Vec<LogLine>,
}

/// A record kept as `<data-dir>/packages/<id>.json`.
pub trait Stored: Serialize + DeserializeOwned {
    fn id(&self) -> &str;
}

impl Stored for Record {
    fn id(&self) -> &str {
        &self.id
    }
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn open(data_dir: &Path) -> std::io::Result<Store> {
        let dir = data_dir.join("packages");
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(data_dir, std::fs::Permissions::from_mode(0o700))?;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Store { dir })
    }

    pub fn save<R: Stored>(&self, rec: &R) -> std::io::Result<()> {
        let tmp = self.dir.join(format!(".{}.json.tmp", rec.id()));
        write_private(&tmp, &serde_json::to_vec_pretty(rec)?)?;
        std::fs::rename(tmp, self.dir.join(format!("{}.json", rec.id())))?;
        std::fs::File::open(&self.dir)?.sync_all()
    }

    pub fn load_all<R: Stored>(&self) -> std::io::Result<Vec<R>> {
        let mut out = vec![];
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if path.extension().is_some_and(|e| e == "json") && !name.starts_with('.') {
                let rec: R = serde_json::from_slice(&std::fs::read(&path)?)
                    .map_err(|e| std::io::Error::other(format!("{}: {e}", path.display())))?;
                out.push(rec);
            }
        }
        Ok(out)
    }
}

/// Create `path` with mode 0600 (replacing it) and write `bytes`.
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

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::testkit::Swap;

    #[test]
    fn records_persist_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let s = Swap::offline(6, 10);
        let mut rec = Record::new("abc".into(), s.b_package(2, 3));
        rec.log("one");
        rec.log("one");
        rec.log("two");
        assert_eq!(rec.events.len(), 3, "consecutive duplicates fold");
        store.save(&rec).unwrap();
        rec.status = Status::CancelBroadcast;
        store.save(&rec).unwrap();
        let back: Vec<Record> = store.load_all().unwrap();
        assert_eq!(back, vec![rec.clone()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("packages/abc.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let armed = rec
            .package
            .validate(ferry_btc::Chain::bitcoin(Network::Regtest))
            .unwrap();
        let view = serde_json::to_value(rec.view(&armed)).unwrap();
        assert_eq!(view["status"], "cancel_broadcast");
        assert_eq!(view["coin"], "btc");
        assert!(view["refund_txid"].is_string() && view["punish_txid"].is_null());
        let text = view.to_string();
        assert!(
            !text.contains(&rec.package.refund_tx.clone().unwrap()[..40]),
            "the view never shows transaction bytes"
        );
    }

    #[test]
    fn broadcast_attempts_fold() {
        let s = Swap::offline(6, 10);
        let mut rec = Record::new("x".into(), s.z_package(2, 3));
        let entry = |error: Option<&str>| BroadcastLog {
            spend: Spend::Cancel,
            txid: s.txs.txid(Spend::Cancel),
            at: 1,
            lock_confs: Some(6),
            cancel_confs: None,
            error: error.map(String::from),
            attempts: 1,
        };
        rec.log_broadcast(entry(Some("non-final")));
        rec.log_broadcast(entry(Some("non-final")));
        rec.log_broadcast(entry(None));
        assert_eq!(rec.broadcasts.len(), 2);
        assert_eq!(rec.broadcasts[0].attempts, 2);
    }
}
