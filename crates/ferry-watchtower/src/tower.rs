//! The service: registered packages, chain polling through bitcoind or litecoind, broadcasting.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ferry_btc::bitcoin::{Amount, OutPoint, Txid};
use ferry_btc::rpc::{BitcoinRpc, RpcError};
use ferry_btc::{Chain, Spend};
use rand::RngCore;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::engine::{decide, spend_name, Decision, Observation, OutputState, Status};
use crate::package::{Armed, Package, PackageError};
use crate::store::{now, BroadcastLog, PackageView, Record, Store};

#[derive(Clone, Debug)]
pub struct TowerConfig {
    /// The coin and network this tower follows (bitcoind or litecoind). Packages for any other
    /// chain are refused.
    pub chain: Chain,
    pub data_dir: PathBuf,
    /// Bearer token required on `/packages*` (None: open, for a tower on a private network).
    pub token: Option<String>,
    pub poll: Duration,
    /// How far back the watch wallet rescans when a package arrives (seconds before the
    /// upload). The lock is normally broadcast around the upload, so a few hours suffice.
    pub rescan_secs: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum RegisterError {
    #[error(transparent)]
    Invalid(#[from] PackageError),
    #[error("{0}")]
    Conflict(String),
    #[error("node: {0}")]
    Node(#[from] RpcError),
    /// The node is unreachable, or does not show the swap yet: try again later.
    #[error("{0}")]
    Unavailable(String),
    #[error("storage: {0}")]
    Io(#[from] std::io::Error),
}

impl RegisterError {
    pub fn http_status(&self) -> u16 {
        match self {
            RegisterError::Invalid(_) => 400,
            RegisterError::Conflict(_) => 409,
            RegisterError::Node(_) | RegisterError::Unavailable(_) => 503,
            RegisterError::Io(_) => 500,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct Registered {
    pub id: String,
    /// False when the same transactions were already registered.
    pub created: bool,
    pub status: Status,
}

struct Entry {
    record: Record,
    armed: Armed,
}

pub struct Tower {
    pub cfg: TowerConfig,
    rpc: BitcoinRpc,
    store: Store,
    entries: Mutex<BTreeMap<String, Entry>>,
}

/// What one poll saw, beyond the engine's [`Observation`].
struct Seen {
    obs: Observation,
    lock_confs: Option<u32>,
}

impl Tower {
    /// Load the stored packages and make sure the watch wallet follows the active ones.
    /// `rpc` must be built `with_wallet(w).with_watch_wallet(w)` for one watch-only wallet `w`,
    /// and `with_coin(cfg.chain.coin)`. On Litecoin the watch wallet is a legacy watch-only one
    /// (Litecoin Core 0.21 has no descriptor wallets); `BitcoinRpc` picks that from the coin.
    pub async fn open(cfg: TowerConfig, rpc: BitcoinRpc) -> anyhow::Result<Arc<Tower>> {
        anyhow::ensure!(
            rpc.coin() == cfg.chain.coin,
            "the node client is for {}, the tower for {}",
            rpc.coin(),
            cfg.chain.coin
        );
        let store = Store::open(&cfg.data_dir)?;
        rpc.ensure_watch_wallet().await?;
        let mut entries = BTreeMap::new();
        for record in store.load_all::<Record>()? {
            match record.package.validate(cfg.chain) {
                Ok(armed) => {
                    if record.status != Status::Done {
                        let back = now().saturating_sub(record.created_at) + cfg.rescan_secs;
                        rpc.watch_address(&armed.lock_address, back).await?;
                        rpc.watch_address(&armed.cancel_address, back).await?;
                    }
                    entries.insert(record.id.clone(), Entry { record, armed });
                }
                Err(e) => tracing::error!(id = %record.id, "stored package no longer valid: {e}"),
            }
        }
        tracing::info!(packages = entries.len(), "watchtower loaded");
        Ok(Arc::new(Tower {
            cfg,
            rpc,
            store,
            entries: Mutex::new(entries),
        }))
    }

    /// Validate, watch and persist a package. Uploading the same transactions again returns
    /// the existing id; different transactions for the same role and lock are refused.
    pub async fn register(&self, package: Package) -> Result<Registered, RegisterError> {
        let armed = package.validate(self.cfg.chain)?;
        let mut entries = self.entries.lock().await;
        if let Some(e) = entries.values().find(|e| {
            e.record.package.role == package.role
                && e.record.package.lock_outpoint == package.lock_outpoint
        }) {
            // Same transactions (signatures may differ: BIP340 nonces are random, so a
            // re-signed upload is a different but equally valid copy). Keep the first.
            if e.armed.cancel_txid() == armed.cancel_txid()
                && e.armed.final_txid() == armed.final_txid()
            {
                return Ok(Registered {
                    id: e.record.id.clone(),
                    created: false,
                    status: e.record.status,
                });
            }
            return Err(RegisterError::Conflict(format!(
                "a different {} package for this lock is already registered ({})",
                package.role.as_str(),
                e.record.id
            )));
        }
        self.rpc
            .watch_address(&armed.lock_address, self.cfg.rescan_secs)
            .await?;
        self.rpc
            .watch_address(&armed.cancel_address, self.cfg.rescan_secs)
            .await?;
        let mut id = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut id);
        let record = Record::new(hex::encode(id), package);
        self.store.save(&record)?;
        tracing::info!(
            id = %record.id,
            role = record.package.role.as_str(),
            lock = %record.package.lock_outpoint,
            "package armed"
        );
        let reply = Registered {
            id: record.id.clone(),
            created: true,
            status: record.status,
        };
        entries.insert(record.id.clone(), Entry { record, armed });
        Ok(reply)
    }

    pub async fn view(&self, id: &str) -> Option<PackageView> {
        let entries = self.entries.lock().await;
        entries.get(id).map(|e| e.record.view(&e.armed))
    }

    /// Poll forever.
    pub async fn run(self: Arc<Self>) {
        loop {
            self.poll_once().await;
            tokio::time::sleep(self.cfg.poll).await;
        }
    }

    /// One pass over every active package.
    pub async fn poll_once(&self) {
        let active: Vec<(String, Armed)> = {
            let entries = self.entries.lock().await;
            entries
                .values()
                .filter(|e| e.record.status != Status::Done)
                .map(|e| (e.record.id.clone(), e.armed.clone()))
                .collect()
        };
        for (id, armed) in active {
            let seen = match self.observe(&armed).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(%id, "node: {e}");
                    self.note_error(&id, format!("node: {e}")).await;
                    continue;
                }
            };
            let decision = decide(&armed.rules, &seen.obs);
            let sent = match decision.broadcast {
                Some(spend) => {
                    let tx = armed
                        .tx(spend)
                        .expect("the engine only sends delegated txs");
                    let res = self.rpc.broadcast(tx).await;
                    match &res {
                        Ok(txid) => tracing::info!(%id, %txid, "broadcast {}", spend_name(spend)),
                        Err(e) => tracing::warn!(%id, "broadcast {}: {e}", spend_name(spend)),
                    }
                    Some((spend, tx.compute_txid(), res.err().map(|e| e.to_string())))
                }
                None => None,
            };
            self.apply(&id, &seen, decision, sent).await;
        }
    }

    async fn note_error(&self, id: &str, text: String) {
        let mut entries = self.entries.lock().await;
        if let Some(e) = entries.get_mut(id) {
            if e.record.note != text {
                e.record.note = text.clone();
                e.record.log(text);
                if let Err(err) = self.store.save(&e.record) {
                    tracing::error!(%id, "saving: {err}");
                }
            }
        }
    }

    async fn apply(
        &self,
        id: &str,
        seen: &Seen,
        d: Decision,
        sent: Option<(Spend, Txid, Option<String>)>,
    ) {
        let mut entries = self.entries.lock().await;
        let Some(e) = entries.get_mut(id) else { return };
        let rec = &mut e.record;
        let before = rec.clone();
        if seen.lock_confs.is_some() {
            rec.lock_confs = seen.lock_confs;
        }
        if seen.obs.cancel_confs.is_some() {
            rec.cancel_confs = seen.obs.cancel_confs;
        }
        let mut status = d.status;
        let mut note = d.note.clone();
        if let Some((spend, txid, error)) = sent {
            if let Some(err) = &error {
                // Not out after all: report the stage before it.
                status = match spend {
                    Spend::Cancel => Status::Armed,
                    _ => Status::CancelBroadcast,
                };
                note = format!("{note}; the node refused it: {err}");
            }
            rec.log_broadcast(BroadcastLog {
                spend,
                txid,
                at: now(),
                lock_confs: seen.lock_confs,
                cancel_confs: seen.obs.cancel_confs,
                error,
                attempts: 1,
            });
        }
        if let Some(outcome) = d.outcome {
            rec.outcome = Some(outcome);
            status = Status::Done;
        }
        if status > rec.status {
            rec.status = status;
        }
        rec.note = note.clone();
        rec.log(note);
        if *rec != before {
            if let Err(err) = self.store.save(rec) {
                tracing::error!(%id, "saving: {err}");
            }
        }
    }

    async fn observe(&self, a: &Armed) -> Result<Seen, RpcError> {
        let info: Value = self.rpc.call("getblockchaininfo", json!([])).await?;
        let node_synced = info["initialblockdownload"].as_bool() == Some(false);
        let lock_m = self.txout(&a.lock_outpoint, true).await?;
        let lock_c = self.txout(&a.lock_outpoint, false).await?;
        let cancel_m = self.txout(&a.cancel_outpoint, true).await?;
        let cancel_c = self.txout(&a.cancel_outpoint, false).await?;
        // Wallet answers are trusted only once the wallet has processed this tip (it follows
        // the chain asynchronously). Queried after the UTXO view, before the wallet lookups.
        let tip = self.rpc.block_count().await?;
        let wallet: Value = self.rpc.wallet_call("getwalletinfo", json!([])).await?;
        // `lastprocessedblock` needs Bitcoin Core 26+; older nodes are taken as synced.
        let wallet_synced = wallet["lastprocessedblock"]["height"]
            .as_u64()
            .is_none_or(|h| h >= tip)
            && !wallet["scanning"].is_object();
        let lock_confs = self.rpc.confirmations(&a.lock_outpoint.txid).await?;
        let cancel_confs = self.rpc.confirmations(&a.cancel_txid()).await?;
        let final_confs = self.rpc.confirmations(&a.final_txid()).await?;

        let lock_mismatch = lock_m
            .as_ref()
            .or(lock_c.as_ref())
            .is_some_and(|o| o.script != a.lock_script.to_hex_string() || o.value != a.lock_amount);
        let lock = output_state(&lock_m, &lock_c, lock_confs);
        let cancel_out = output_state(&cancel_m, &cancel_c, cancel_confs);
        // The UTXO view may be a block ahead of the wallet's count, or behind it.
        let cancel_confs = match (cancel_confs, &cancel_m) {
            (Some(w), Some(u)) => Some(w.max(u.confs)),
            (w, _) => w,
        };
        Ok(Seen {
            obs: Observation {
                lock,
                lock_mismatch,
                cancel_confs,
                cancel_out,
                final_confs,
                node_synced,
                wallet_synced,
            },
            lock_confs: match &lock_m {
                Some(u) => Some(u.confs.max(lock_confs.unwrap_or(0))),
                None => lock_confs,
            },
        })
    }

    async fn txout(&self, op: &OutPoint, mempool: bool) -> Result<Option<TxOutInfo>, RpcError> {
        let v: Option<Value> = self
            .rpc
            .call("gettxout", json!([op.txid.to_string(), op.vout, mempool]))
            .await?;
        Ok(v.filter(|v| !v.is_null()).map(|v| TxOutInfo {
            confs: v["confirmations"].as_u64().unwrap_or(0) as u32,
            script: v["scriptPubKey"]["hex"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            value: v["value"]
                .as_f64()
                .and_then(|b| Amount::from_btc(b).ok())
                .unwrap_or(Amount::ZERO),
        }))
    }
}

struct TxOutInfo {
    confs: u32,
    script: String,
    value: Amount,
}

/// From `gettxout` with and without the mempool, and the confirmations of the transaction
/// that creates the output.
fn output_state(
    with_mempool: &Option<TxOutInfo>,
    chain_only: &Option<TxOutInfo>,
    parent_confs: Option<u32>,
) -> OutputState {
    match (with_mempool, chain_only, parent_confs) {
        (Some(o), ..) => OutputState::Unspent { confs: o.confs },
        (None, Some(_), _) => OutputState::SpentInMempool,
        (None, None, None) => OutputState::Unknown,
        (None, None, Some(0)) => OutputState::SpentInMempool,
        (None, None, Some(_)) => OutputState::SpentInBlock,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(confs: u32) -> Option<TxOutInfo> {
        Some(TxOutInfo {
            confs,
            script: String::new(),
            value: Amount::ZERO,
        })
    }

    #[test]
    fn output_states_from_the_utxo_views() {
        use OutputState::*;
        assert_eq!(output_state(&None, &None, None), Unknown);
        assert_eq!(output_state(&info(0), &None, Some(0)), Unspent { confs: 0 });
        assert_eq!(
            output_state(&info(3), &info(3), Some(3)),
            Unspent { confs: 3 }
        );
        assert_eq!(output_state(&None, &info(3), Some(3)), SpentInMempool);
        assert_eq!(output_state(&None, &None, Some(0)), SpentInMempool);
        assert_eq!(output_state(&None, &None, Some(4)), SpentInBlock);
    }
}
