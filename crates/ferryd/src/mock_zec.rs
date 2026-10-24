//! A stand-in Zcash chain shared by daemons through one JSON file (both parties must see the
//! same notes, and they run as separate processes). Blocks are produced by the clock: the
//! height advances every `block_secs`. A sweep only succeeds when `ask` really is the
//! discrete log of the joint `ak`, so the mock still checks the cryptography that matters.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use ferry_core::{ZecLeg, ZecNote, ZecStatus};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum MockZecError {
    #[error("mock zec file: {0}")]
    Io(#[from] std::io::Error),
    #[error("mock zec file: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Rejected(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Send,
    Sweep,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct MockTx {
    txid: String,
    kind: Kind,
    /// Joint viewing key (hex) the transaction pays to or spends from.
    fvk: String,
    value: u64,
    owner: String,
    height: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct MockChain {
    genesis_ms: u64,
    balances: BTreeMap<String, u64>,
    txs: Vec<MockTx>,
}

impl MockChain {
    fn confs(&self, tx: &MockTx, height: u64) -> u32 {
        if height >= tx.height {
            (height - tx.height + 1) as u32
        } else {
            0
        }
    }
}

pub struct MockZecLeg {
    path: PathBuf,
    owner: String,
    block_ms: u64,
    /// Network label for status and the mock address prefix ("regtest", "test", "main").
    network: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl MockZecLeg {
    /// `owner` names this party's wallet in the shared file; it starts with `initial_balance`
    /// the first time it is seen.
    pub fn new(
        path: PathBuf,
        owner: String,
        block_secs: f64,
        initial_balance: u64,
    ) -> Result<Self, MockZecError> {
        let leg = MockZecLeg {
            path,
            owner,
            block_ms: (block_secs * 1000.0).max(1.0) as u64,
            network: "regtest".into(),
        };
        leg.with_chain(|c, _| {
            c.balances
                .entry(leg.owner.clone())
                .or_insert(initial_balance);
            Ok(())
        })?;
        Ok(leg)
    }

    pub fn with_network(mut self, network: impl Into<String>) -> Self {
        self.network = network.into();
        self
    }

    fn height(&self, c: &MockChain) -> u64 {
        1 + now_ms().saturating_sub(c.genesis_ms) / self.block_ms
    }

    /// Read-modify-write under an exclusive file lock.
    fn with_chain<T>(
        &self,
        f: impl FnOnce(&mut MockChain, u64) -> Result<T, MockZecError>,
    ) -> Result<T, MockZecError> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file: File = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.path)?;
        file.lock()?;
        let mut raw = String::new();
        file.read_to_string(&mut raw)?;
        let mut chain: MockChain = if raw.trim().is_empty() {
            MockChain {
                genesis_ms: now_ms(),
                ..Default::default()
            }
        } else {
            serde_json::from_str(&raw)?
        };
        let height = self.height(&chain);
        let out = f(&mut chain, height)?;
        let bytes = serde_json::to_vec_pretty(&chain)?;
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&bytes)?;
        file.unlock()?;
        Ok(out)
    }

    fn txid() -> String {
        let mut b = [0u8; 32];
        OsRng.fill_bytes(&mut b);
        hex::encode(b)
    }
}

impl ZecLeg for MockZecLeg {
    type Error = MockZecError;

    async fn status(&self) -> Result<ZecStatus, MockZecError> {
        self.with_chain(|c, height| {
            Ok(ZecStatus {
                network: self.network.clone(),
                height,
                shielded_balance: c.balances.get(&self.owner).copied().unwrap_or(0),
            })
        })
    }

    fn joint_address(&self, fvk: &[u8; 96]) -> Result<String, MockZecError> {
        let hrp = if self.network == "main" {
            "u"
        } else {
            &format!("u{}", self.network)
        };
        Ok(format!("{hrp}1mock{}", hex::encode(&fvk[..24])))
    }

    async fn send(&self, fvk: &[u8; 96], amount: u64) -> Result<String, MockZecError> {
        self.with_chain(|c, height| {
            let bal = c.balances.entry(self.owner.clone()).or_default();
            if *bal < amount {
                return Err(MockZecError::Rejected(format!(
                    "insufficient shielded balance ({bal} < {amount})"
                )));
            }
            *bal -= amount;
            let txid = Self::txid();
            c.txs.push(MockTx {
                txid: txid.clone(),
                kind: Kind::Send,
                fvk: hex::encode(fvk),
                value: amount,
                owner: self.owner.clone(),
                height: height + 1,
            });
            Ok(txid)
        })
    }

    /// A mock send is atomic: recorded with its note, or not at all. So no note means no lock.
    async fn lock_lapsed(&self, fvk: &[u8; 96], amount: u64) -> Result<bool, MockZecError> {
        let fvk = hex::encode(fvk);
        self.with_chain(|c, _| {
            Ok(!c
                .txs
                .iter()
                .any(|t| t.kind == Kind::Send && t.fvk == fvk && t.value >= amount))
        })
    }

    async fn watch(&self, fvk: &[u8; 96]) -> Result<Vec<ZecNote>, MockZecError> {
        let fvk = hex::encode(fvk);
        self.with_chain(|c, height| {
            Ok(c.txs
                .iter()
                .filter(|t| t.kind == Kind::Send && t.fvk == fvk)
                .map(|t| ZecNote {
                    txid: t.txid.clone(),
                    value: t.value,
                    confirmations: c.confs(t, height),
                    spent_by: c
                        .txs
                        .iter()
                        .find(|s| s.kind == Kind::Sweep && s.fvk == fvk)
                        .map(|s| s.txid.clone()),
                })
                .collect())
        })
    }

    async fn sweep(
        &self,
        fvk: &[u8; 96],
        ask: &[u8; 32],
        lock_value: u64,
    ) -> Result<String, MockZecError> {
        let scalar = ferry_dleq::pallas_scalar_from_bytes(ask)
            .ok_or_else(|| MockZecError::Rejected("ask is not a canonical Pallas scalar".into()))?;
        let ak = ferry_dleq::pallas_bytes(&(ferry_dleq::spend_auth_g() * scalar));
        if ak[..] != fvk[..32] {
            return Err(MockZecError::Rejected(
                "ask does not authorize the joint ak".into(),
            ));
        }
        let fvk = hex::encode(fvk);
        self.with_chain(|c, height| {
            if c.txs.iter().any(|t| t.kind == Kind::Sweep && t.fvk == fvk) {
                return Err(MockZecError::Rejected("joint note already spent".into()));
            }
            let value: u64 = c
                .txs
                .iter()
                .filter(|t| t.kind == Kind::Send && t.fvk == fvk)
                .map(|t| t.value)
                .sum();
            if value == 0 {
                return Err(MockZecError::Rejected(
                    "no notes at the joint address".into(),
                ));
            }
            if !c
                .txs
                .iter()
                .any(|t| t.kind == Kind::Send && t.fvk == fvk && t.value >= lock_value)
            {
                return Err(MockZecError::Rejected(
                    "the sweep would leave the lock note behind".into(),
                ));
            }
            *c.balances.entry(self.owner.clone()).or_default() += value;
            let txid = Self::txid();
            c.txs.push(MockTx {
                txid: txid.clone(),
                kind: Kind::Sweep,
                fvk,
                value,
                owner: self.owner.clone(),
                height: height + 1,
            });
            Ok(txid)
        })
    }

    async fn confirmations(&self, txid: &str) -> Result<Option<u32>, MockZecError> {
        self.with_chain(|c, height| {
            Ok(c.txs
                .iter()
                .find(|t| t.txid == txid)
                .map(|t| c.confs(t, height)))
        })
    }

    async fn describe_tx(&self, txid: &str) -> Result<Option<String>, MockZecError> {
        self.with_chain(|c, _| {
            Ok(c.txs.iter().find(|t| t.txid == txid).map(|t| match t.kind {
                Kind::Send => format!(
                    "ZEC lock: Ironwood bundle with 2 actions; value, sender, receiver and memo encrypted; \
                     valueBalance 0, so no amount leaves the pool (mock chain, txid {}…)",
                    &t.txid[..8]
                ),
                Kind::Sweep => format!(
                    "ZEC sweep: Ironwood bundle spending one note, revealing only a nullifier, a randomized key rk \
                     and encrypted outputs; nothing in it appears on Bitcoin (mock chain, txid {}…)",
                    &t.txid[..8]
                ),
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferry_dleq::pasta_curves::group::ff::PrimeField;

    #[tokio::test]
    async fn send_watch_sweep_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("zec.json");
        let z = MockZecLeg::new(path.clone(), "zoe".into(), 0.05, 1_000).unwrap();
        let b = MockZecLeg::new(path, "bram".into(), 0.05, 0).unwrap();

        let g = ferry_dleq::spend_auth_g();
        let ask = ferry_dleq::random_mutual_scalar(&mut OsRng);
        let mut fvk = [0u8; 96];
        fvk[..32].copy_from_slice(&ferry_dleq::pallas_bytes(&(g * *ask)));

        assert!(z.send(&fvk, 2_000).await.is_err());
        assert!(
            z.lock_lapsed(&fvk, 600).await.unwrap(),
            "a refused send locks nothing"
        );
        let txid = z.send(&fvk, 600).await.unwrap();
        assert!(!z.lock_lapsed(&fvk, 600).await.unwrap());
        assert!(!b.lock_lapsed(&fvk, 600).await.unwrap());
        let notes = b.watch(&fvk).await.unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(
            (notes[0].txid.as_str(), notes[0].value),
            (txid.as_str(), 600)
        );
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        assert!(b.confirmations(&txid).await.unwrap().unwrap() >= 1);

        let wrong = ferry_dleq::random_mutual_scalar(&mut OsRng);
        assert!(b.sweep(&fvk, &wrong.to_repr(), 600).await.is_err());
        assert!(b.sweep(&fvk, &ask.to_repr(), 601).await.is_err(), "lock note missing");
        let sweep = b.sweep(&fvk, &ask.to_repr(), 600).await.unwrap();
        assert_eq!(z.watch(&fvk).await.unwrap()[0].spent_by, Some(sweep));
        assert!(z.sweep(&fvk, &ask.to_repr(), 600).await.is_err(), "double spend");
        assert_eq!(b.status().await.unwrap().shielded_balance, 600);
        assert_eq!(z.status().await.unwrap().shielded_balance, 400);
    }
}
