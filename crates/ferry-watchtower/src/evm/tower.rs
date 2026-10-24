//! The EVM service: registered FerryLock packages, polling an EVM node, calling refund or punish
//! from the tower's own account (it pays the gas; the contract pays the swap's own parties).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ferry_evm::{Address, EvmClient, SwapState, TxStatus, B256};
use rand::RngCore;
use tokio::sync::Mutex;

use super::engine::{decide, EvmCall, EvmDecision, EvmObservation};
use super::package::{EvmArmed, EvmPackage};
use super::record::{EvmPackageView, EvmRecord, EvmSendLog};
use crate::engine::Status;
use crate::package::PackageError;
use crate::store::{now, Store};
use crate::tower::{RegisterError, Registered};

/// Any node call taking longer than this is abandoned until the next poll.
const NODE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct EvmTowerConfig {
    pub data_dir: PathBuf,
    /// Bearer token required on `/packages*` (None: open, for a tower on a private network).
    pub token: Option<String>,
    pub poll: Duration,
    /// Hold a refund while the node's latest block is older than this by the local clock. A
    /// lagging node could show a time before t2 − Δ when the chain is already past it.
    pub max_lag_secs: u64,
    /// Accept packages only for these FerryLock deployments (empty: any address whose code is
    /// this build's FerryLock).
    pub contracts: Vec<Address>,
}

struct Entry {
    record: EvmRecord,
    armed: EvmArmed,
}

pub struct EvmTower {
    pub cfg: EvmTowerConfig,
    pub chain_id: u64,
    /// Signs with the tower's own gas key; [`EvmClient::at`] points it at each package's contract.
    client: EvmClient,
    store: Store,
    entries: Mutex<BTreeMap<String, Entry>>,
}

/// What one poll saw.
struct Seen {
    obs: EvmObservation,
    /// Our pending call and what the node says about it.
    ours: Option<(B256, TxStatus)>,
}

async fn node<T>(
    f: impl std::future::Future<Output = Result<T, ferry_evm::Error>>,
) -> Result<T, ferry_evm::Error> {
    tokio::time::timeout(NODE_TIMEOUT, f)
        .await
        .unwrap_or_else(|_| Err(ferry_evm::Error::Rpc("no answer in time".into())))
}

impl EvmTower {
    /// Load the stored packages. `client` signs with the tower's gas key; its contract address
    /// is not used.
    pub async fn open(cfg: EvmTowerConfig, client: EvmClient) -> anyhow::Result<Arc<EvmTower>> {
        let chain_id = node(client.chain_id()).await?;
        let store = Store::open(&cfg.data_dir)?;
        let mut entries = BTreeMap::new();
        for record in store.load_all::<EvmRecord>()? {
            match record.package.validate(chain_id) {
                Ok(armed) => {
                    entries.insert(record.id.clone(), Entry { record, armed });
                }
                Err(e) => tracing::error!(id = %record.id, "stored package no longer valid: {e}"),
            }
        }
        match node(client.eth_balance()).await {
            Ok(wei) if wei.is_zero() => tracing::warn!(
                account = %client.address(),
                "the tower's gas account has no ETH: fund it, or refund/punish calls will fail"
            ),
            Ok(wei) => tracing::info!(account = %client.address(), %wei, "gas account"),
            Err(e) => tracing::warn!("reading the gas account balance: {e}"),
        }
        tracing::info!(packages = entries.len(), chain_id, "EVM watchtower loaded");
        Ok(Arc::new(EvmTower {
            cfg,
            chain_id,
            client,
            store,
            entries: Mutex::new(entries),
        }))
    }

    /// The account that pays for refund and punish calls.
    pub fn account(&self) -> Address {
        self.client.address()
    }

    /// Validate the package offline and against the chain, then persist it. Uploading the
    /// same package again returns the existing id; a different one for the same swap and role
    /// is refused.
    pub async fn register(&self, package: EvmPackage) -> Result<Registered, RegisterError> {
        let armed = package.validate(self.chain_id)?;
        if !self.cfg.contracts.is_empty() && !self.cfg.contracts.contains(&armed.contract) {
            return Err(PackageError(format!(
                "this tower only watches FerryLock at {}",
                self.cfg
                    .contracts
                    .iter()
                    .map(|a| a.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
            .into());
        }
        let c = self.client.at(armed.contract);
        match node(c.check_deployment()).await {
            Ok(()) => {}
            Err(ferry_evm::Error::UnknownContract) => {
                return Err(PackageError(format!(
                    "the code at {} is not FerryLock",
                    armed.contract
                ))
                .into())
            }
            Err(e) => return Err(RegisterError::Unavailable(format!("EVM node: {e}"))),
        }
        let on_chain = node(c.swap(armed.swap_id))
            .await
            .map_err(|e| RegisterError::Unavailable(format!("EVM node: {e}")))?;
        if on_chain.state == SwapState::None {
            return Err(RegisterError::Unavailable(
                "the lock is not on chain yet; upload again once it is mined".into(),
            ));
        }
        if let Some(field) = armed.terms.mismatch(&on_chain.terms) {
            return Err(PackageError(format!(
                "the swap on chain does not have these terms ({field} differs)"
            ))
            .into());
        }

        let mut entries = self.entries.lock().await;
        if let Some(e) = entries.values().find(|e| {
            e.record.package.role == package.role
                && e.record.package.contract == package.contract
                && e.record.package.swap_id == package.swap_id
        }) {
            if e.record.package == package {
                return Ok(Registered {
                    id: e.record.id.clone(),
                    created: false,
                    status: e.record.status,
                });
            }
            return Err(RegisterError::Conflict(format!(
                "a different {} package for this swap is already registered ({})",
                package.role.as_str(),
                e.record.id
            )));
        }
        let mut id = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut id);
        let record = EvmRecord::new(hex::encode(id), package);
        self.store.save(&record)?;
        tracing::info!(
            id = %record.id,
            role = record.package.role.as_str(),
            swap = %record.package.swap_id,
            "EVM package armed"
        );
        let reply = Registered {
            id: record.id.clone(),
            created: true,
            status: record.status,
        };
        entries.insert(record.id.clone(), Entry { record, armed });
        Ok(reply)
    }

    pub async fn view(&self, id: &str) -> Option<EvmPackageView> {
        let entries = self.entries.lock().await;
        entries.get(id).map(|e| e.record.view())
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
        let active: Vec<(String, EvmArmed, Option<B256>)> = {
            let entries = self.entries.lock().await;
            entries
                .values()
                .filter(|e| e.record.status != Status::Done)
                .map(|e| (e.record.id.clone(), e.armed.clone(), e.record.pending_tx))
                .collect()
        };
        for (id, armed, pending) in active {
            let seen = match self.observe(&armed, pending).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(%id, "EVM node: {e}");
                    self.note_error(&id, format!("EVM node: {e}")).await;
                    continue;
                }
            };
            let d = decide(&armed.rules, &seen.obs);
            let sent = match d.call {
                Some(call) => Some(self.send(&id, &armed, call).await),
                None => None,
            };
            self.apply(&id, &seen, d, sent).await;
        }
    }

    async fn observe(&self, a: &EvmArmed, pending: Option<B256>) -> Result<Seen, ferry_evm::Error> {
        let c = self.client.at(a.contract);
        let (_, now) = node(c.latest_block()).await?;
        let s = node(c.swap(a.swap_id)).await?;
        // Read after the state: a call mined in between shows as mined-while-locked, which
        // counts as in flight until the next poll reads the new state.
        let ours = match pending {
            Some(h) => Some((h, node(c.tx_status(h)).await?)),
            None => None,
        };
        let in_flight = matches!(
            ours,
            Some((_, TxStatus::Pending | TxStatus::Mined { ok: true, .. }))
        );
        Ok(Seen {
            obs: EvmObservation {
                now,
                state: s.state,
                terms_match: s.state == SwapState::None || a.terms.mismatch(&s.terms).is_none(),
                node_fresh: now.saturating_add(self.cfg.max_lag_secs) >= crate::store::now(),
                in_flight,
            },
            ours,
        })
    }

    /// Re-check the window against the latest block right before sending (time passes between
    /// the observation and here), then simulate and broadcast.
    async fn send(
        &self,
        id: &str,
        a: &EvmArmed,
        call: EvmCall,
    ) -> (EvmCall, u64, Result<B256, String>) {
        let c = self.client.at(a.contract);
        let now = match node(c.latest_timestamp()).await {
            Ok(t) => t,
            Err(e) => return (call, 0, Err(e.to_string())),
        };
        let res = match call {
            EvmCall::Refund if !a.rules.can_refund(now) => {
                Err("the refund window closed before sending; not sent".into())
            }
            EvmCall::Punish if !a.rules.can_punish(now) => Err("before t2; not sent".into()),
            EvmCall::Refund => match &a.b {
                Some(b) => node(c.submit_refund(a.swap_id, b.expose()))
                    .await
                    .map_err(|e| e.to_string()),
                None => Err("no b in this package".into()),
            },
            EvmCall::Punish => node(c.submit_punish(a.swap_id))
                .await
                .map_err(|e| e.to_string()),
        };
        match &res {
            Ok(hash) => tracing::info!(%id, %hash, "sent {}", call.name()),
            Err(e) => tracing::warn!(%id, "{} not sent: {e}", call.name()),
        }
        (call, now, res)
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
        d: EvmDecision,
        sent: Option<(EvmCall, u64, Result<B256, String>)>,
    ) {
        let mut entries = self.entries.lock().await;
        let Some(e) = entries.get_mut(id) else { return };
        let rec = &mut e.record;
        let before = rec.clone();
        rec.chain_time = Some(seen.obs.now);
        match seen.ours {
            Some((h, TxStatus::Unknown)) => {
                rec.pending_tx = None;
                rec.log(format!(
                    "our call {h} is no longer known to the node (dropped); it may be sent again"
                ));
            }
            Some((h, TxStatus::Mined { ok: false, block })) => {
                rec.pending_tx = None;
                rec.log(format!("our call {h} reverted in block {block}"));
            }
            _ => {}
        }
        let mut status = d.status;
        let mut note = d.note;
        if let Some((call, block_time, res)) = sent {
            let (tx_hash, error) = match res {
                Ok(h) => (Some(h), None),
                Err(err) => (None, Some(err)),
            };
            if let Some(err) = &error {
                // Not out after all.
                status = Status::Armed;
                note = format!("{note}; not sent: {err}");
            } else {
                rec.pending_tx = tx_hash;
            }
            rec.log_send(EvmSendLog {
                call,
                tx_hash,
                at: now(),
                block_time,
                error,
                attempts: 1,
            });
        }
        if let Some(outcome) = d.outcome {
            rec.outcome = Some(outcome);
            rec.pending_tx = None;
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
}
