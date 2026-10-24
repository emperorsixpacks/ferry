//! Ferry's real Zcash leg: Ironwood notes on a Zebra + Zaino chain, through a zcash-devtool
//! wallet driven as a subprocess.
//!
//! One wallet directory per party holds the party's own (seed) account plus one view-only
//! account per joint key, imported from the joint UFVK. A background task keeps the wallet
//! synced; [`ZecLeg::watch`] reads the joint account's notes straight from the wallet database.
//! Every transaction is built as a PCZT and checked to be Ironwood-only before it is signed:
//! the lock with `pczt create --ironwood-only` from our own account (signed by devtool with our
//! seed), sweeps with `pczt create-max --ironwood-only` from the view-only joint account (signed
//! by `ferry-zec-signer`, `rsk = ask + α`). Confirmations and the public view of a transaction
//! come from the node's JSON-RPC.
//!
//! # What this relies on
//!
//! - **zcash-devtool** (`vendor/zcash-devtool`, librustzcash rev `eb38d7a3`), built with
//!   `--features regtest_support` and patched with `infra/patches/zcash-devtool-ferry.patch`.
//!   We use its CLI (`wallet init|import-ufvk|sync|balance|list-addresses`, `pczt
//!   create|create-max|prove|sign|combine|send`) with `RUST_LOG=error`, reading only: the
//!   `Default Address:` and `Ironwood Spendable:` lines, and a transaction id printed alone on
//!   the last 64-hex line of `pczt send`. Its wallet database is read directly (read-only) for
//!   accounts, Ironwood notes and their spends: `accounts`, `ironwood_received_notes`,
//!   `ironwood_received_note_spends`, `transactions`. Both are unstable interfaces, which is why
//!   the devtool revision is pinned.
//! - **The patch** ([`DevtoolZecLeg::new`] refuses a devtool binary without it):
//!   - `pczt create-max --discard-ovk` (`OvkPolicy::Discard`). devtool builds outputs with the
//!     sending account's OVK; for the joint account that OVK belongs to both parties, so the
//!     counterparty could decrypt the sweep's outCiphertext and learn where the ZEC went, how
//!     much and the memo (audit H4, shown by `spikes/zec/h4_ovk.sh`).
//!   - `pczt create|create-max --ironwood-only`: select notes from the Ironwood pool alone. A
//!     lock is never funded from another pool, and a sweep ignores foreign Sapling/Orchard notes
//!     that anyone can send to the joint receivers, instead of failing on them (audit H1).
//!   - `pczt sign` signs Ironwood spends of the seed's accounts (upstream signs Orchard only).
//! - **`ferry-zec-signer`** (`tools/ferry-zec-signer`, outside the workspace with devtool's
//!   `Cargo.lock`, so its PCZT types match devtool's and the workspace's pasta_curves 0.5 patch
//!   stays out of that graph). `ufvk <net> <fvk hex>` turns the 96-byte joint FVK into a UFVK
//!   and UA; `sign <in> <out>` reads `ask` from stdin (never argv) and signs every spend still
//!   awaiting a signature, checked against each action's `rk`.
//! - **Wallet policy.** Notes received from another wallet need 10 confirmations before devtool
//!   will spend them. A sweep waits (retryable error) until the joint account's largest note has
//!   them, then spends only spendable notes (`--only-spendable`), so unconfirmed dust sent to the
//!   joint address can neither block it nor be all it sweeps.
//!   Every devtool call that touches the wallet runs under one lock; the database reads do not.
//! - **Time limits.** Every subprocess is killed past its limit (reads 60 s, sync 5 min, PCZT
//!   steps and broadcast 10 min), so a stuck light wallet server cannot hold that lock forever.
//!   A timeout is an ordinary error: sync retries, and a send that timed out is "maybe sent".

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use ferry_core::{ZecLeg, ZecNote, ZecStatus};
use rusqlite::OpenFlags;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum ZecError {
    #[error("{cmd} failed: {detail}")]
    Tool { cmd: String, detail: String },
    #[error("wallet database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("zcash node RPC: {0}")]
    Rpc(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// The subprocess ran past its time limit and was killed. Treated like any other failure
    /// (retryable; a timed-out send counts as "maybe sent", never as refused).
    #[error("{cmd} timed out after {secs}s and was killed")]
    Timeout { cmd: String, secs: u64 },
    /// Refused before anything was broadcast, and retrying cannot help.
    #[error("refused: {0}")]
    Refused(String),
    #[error("{0}")]
    Other(String),
}

/// Where this party's wallet lives and how to reach the chain.
#[derive(Clone, Debug)]
pub struct DevtoolConfig {
    /// zcash-devtool binary (built with `--features regtest_support` for regtest).
    pub devtool: PathBuf,
    /// tools/ferry-zec-signer binary.
    pub signer: PathBuf,
    /// The party's wallet directory; initialized with a fresh seed if it has none yet.
    pub wallet_dir: PathBuf,
    /// age identity encrypting the wallet's mnemonic (generated by devtool if missing).
    pub identity: PathBuf,
    /// Zaino / lightwalletd gRPC endpoint, `host:port` (plaintext for localhost).
    pub server: String,
    /// "regtest", "test" or "main".
    pub network: String,
    /// Activation heights file, needed to initialize a regtest wallet.
    pub activation_heights: Option<PathBuf>,
    /// The node's JSON-RPC endpoint (Zebra), for the chain tip, confirmations and the public
    /// view of transactions. Without one (e.g. a public testnet lightwalletd only), the tip and
    /// confirmations come from the wallet's own scan and `describe_tx` returns nothing.
    pub node_rpc: Option<String>,
    pub node_rpc_auth: Option<(String, String)>,
    /// How often the background task syncs the wallet.
    pub sync_interval: Duration,
}

#[derive(Default)]
struct Cache {
    /// joint FVK -> (UFVK, UA)
    joint: HashMap<[u8; 96], (String, String)>,
    /// joint FVK -> account UUID in our wallet
    imported: HashMap<[u8; 96], String>,
    /// Spendable Ironwood balance of our own account after the last sync.
    balance: Option<u64>,
}

struct Inner {
    cfg: DevtoolConfig,
    http: reqwest::Client,
    /// Serializes every devtool invocation that touches the wallet database.
    wallet: tokio::sync::Mutex<()>,
    cache: Mutex<Cache>,
    own_account: String,
    own_address: String,
}

/// [`ZecLeg`] over a zcash-devtool wallet.
#[derive(Clone)]
pub struct DevtoolZecLeg(Arc<Inner>);

impl DevtoolZecLeg {
    /// Opens (or initializes) the wallet and starts the background sync task.
    pub async fn new(cfg: DevtoolConfig) -> Result<Self, ZecError> {
        for (cmd, flags) in [
            ("create-max", &["--discard-ovk", "--ironwood-only"][..]),
            ("create", &["--ironwood-only"][..]),
        ] {
            let help = run_devtool(
                &cfg,
                &["pczt".into(), cmd.into(), "--help".into()],
                READ_TIMEOUT,
            )
            .await?;
            if let Some(flag) = flags.iter().find(|f| !help.contains(*f)) {
                return Err(ZecError::Other(format!(
                    "{} lacks `pczt {cmd} {flag}`; apply infra/patches/zcash-devtool-ferry.patch \
                     (without it sweeps can leak their recipient to the counterparty or be blocked \
                     by foreign notes, and locks could draw on other pools)",
                    cfg.devtool.display()
                )));
            }
        }
        if !cfg.wallet_dir.join("keys.toml").exists() {
            let mut args = vec![
                "init".to_string(),
                "--name".into(),
                "ferry".into(),
                "-i".into(),
                path_str(&cfg.identity),
                "-n".into(),
                cfg.network.clone(),
                "-s".into(),
                cfg.server.clone(),
            ];
            if let Some(h) = &cfg.activation_heights {
                args.extend(["--activation-heights".into(), path_str(h)]);
            }
            run_devtool_wallet(&cfg, &args, SYNC_TIMEOUT).await?;
            tracing::info!(wallet = %cfg.wallet_dir.display(), "initialized a new Zcash wallet");
        }
        let own_account = query(&cfg.wallet_dir, |c| {
            c.query_row(
                "SELECT uuid FROM accounts WHERE has_spend_key = 1 ORDER BY id LIMIT 1",
                [],
                |r| r.get::<_, Vec<u8>>(0),
            )
        })
        .await
        .map(|u| uuid_str(&u))
        .map_err(|e| ZecError::Other(format!("no spending account in the wallet: {e}")))?;
        let addrs = run_devtool_wallet(
            &cfg,
            &["list-addresses".into(), own_account.clone()],
            READ_TIMEOUT,
        )
        .await?;
        let own_address = addrs
            .lines()
            .find_map(|l| l.trim().strip_prefix("Default Address:"))
            .map(|a| a.trim().to_string())
            .ok_or_else(|| ZecError::Other("list-addresses printed no default address".into()))?;

        let inner = Arc::new(Inner {
            http: reqwest::Client::new(),
            wallet: tokio::sync::Mutex::new(()),
            cache: Mutex::new(Cache::default()),
            own_account,
            own_address,
            cfg,
        });
        tracing::info!(account = %inner.own_account, address = %inner.own_address, "Zcash wallet ready");
        let leg = DevtoolZecLeg(inner);
        if let Err(e) = leg.0.sync().await {
            tracing::warn!("initial zcash wallet sync: {e}");
        }
        tokio::spawn(sync_loop(Arc::downgrade(&leg.0)));
        Ok(leg)
    }

    /// Our own wallet's default unified address (where sweeps land).
    pub fn own_address(&self) -> &str {
        &self.0.own_address
    }
}

async fn sync_loop(inner: Weak<Inner>) {
    loop {
        let Some(i) = inner.upgrade() else { return };
        let interval = i.cfg.sync_interval;
        if let Err(e) = i.sync().await {
            tracing::warn!("zcash wallet sync: {e}");
        }
        drop(i);
        tokio::time::sleep(interval).await;
    }
}

impl Inner {
    async fn sync(&self) -> Result<(), ZecError> {
        let _w = self.wallet.lock().await;
        self.sync_locked().await
    }

    /// Sync and refresh the cached balance; the caller holds the wallet lock.
    async fn sync_locked(&self) -> Result<(), ZecError> {
        run_devtool_wallet(
            &self.cfg,
            &["sync".into(), "-s".into(), self.cfg.server.clone()],
            SYNC_TIMEOUT,
        )
        .await?;
        let out = run_devtool_wallet(
            &self.cfg,
            &["balance".into(), self.own_account.clone()],
            READ_TIMEOUT,
        )
        .await?;
        let balance = out
            .lines()
            .find_map(|l| l.trim().strip_prefix("Ironwood Spendable:"))
            // "   4.99990000 REG" (the unit is REG, TAZ or ZEC by network)
            .and_then(|v| v.split_whitespace().next().and_then(parse_zec))
            .ok_or_else(|| {
                ZecError::Other(format!("cannot read the Ironwood balance from:\n{out}"))
            })?;
        self.cache.lock().unwrap().balance = Some(balance);
        Ok(())
    }

    fn joint_keys(&self, fvk: &[u8; 96]) -> Result<(String, String), ZecError> {
        if let Some(k) = self.cache.lock().unwrap().joint.get(fvk) {
            return Ok(k.clone());
        }
        let out = run_blocking_limited(
            std::process::Command::new(&self.cfg.signer).args([
                "ufvk",
                &self.cfg.network,
                &hex::encode(fvk),
            ]),
            "ferry-zec-signer ufvk",
            READ_TIMEOUT,
        )?;
        if !out.status.success() {
            return Err(ZecError::Tool {
                cmd: "ferry-zec-signer ufvk".into(),
                detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let field = |k: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix(k))
                .map(str::to_string)
                .ok_or_else(|| ZecError::Other(format!("ferry-zec-signer printed no {k}")))
        };
        let keys = (field("UFVK=")?, field("UA=")?);
        self.cache.lock().unwrap().joint.insert(*fvk, keys.clone());
        Ok(keys)
    }

    fn account_name(fvk: &[u8; 96]) -> String {
        format!("ferry-joint-{}", hex::encode(&fvk[..12]))
    }

    async fn find_account(&self, name: String) -> Result<Option<String>, ZecError> {
        let row = query(&self.cfg.wallet_dir, move |c| {
            c.query_row("SELECT uuid FROM accounts WHERE name = ?1", [&name], |r| {
                r.get::<_, Vec<u8>>(0)
            })
        })
        .await;
        match row {
            Ok(u) => Ok(Some(uuid_str(&u))),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// The view-only account of the joint key in our wallet, imported on first use.
    async fn joint_account(&self, fvk: &[u8; 96]) -> Result<String, ZecError> {
        if let Some(u) = self.cache.lock().unwrap().imported.get(fvk) {
            return Ok(u.clone());
        }
        let name = Self::account_name(fvk);
        let _w = self.wallet.lock().await;
        let uuid = match self.find_account(name.clone()).await? {
            Some(u) => u,
            None => {
                let (ufvk, _) = self.joint_keys(fvk)?;
                // The joint key is fresh, so nothing older can pay it; the margin only covers
                // a counterparty that funded before we first looked.
                let birthday = self.node_height().await?.saturating_sub(100).max(1);
                run_devtool_wallet(
                    &self.cfg,
                    &[
                        "import-ufvk".into(),
                        "--name".into(),
                        name.clone(),
                        ufvk,
                        birthday.to_string(),
                        "-s".into(),
                        self.cfg.server.clone(),
                    ],
                    SYNC_TIMEOUT,
                )
                .await?;
                tracing::info!(account = %name, birthday, "imported the joint viewing key");
                self.find_account(name)
                    .await?
                    .ok_or_else(|| ZecError::Other("imported joint account not found".into()))?
            }
        };
        self.cache
            .lock()
            .unwrap()
            .imported
            .insert(*fvk, uuid.clone());
        Ok(uuid)
    }

    /// Total value of the account's Ironwood notes with no recorded spend, confirmed or not.
    async fn unspent_ironwood(&self, account: String) -> Result<u64, ZecError> {
        Ok(query(&self.cfg.wallet_dir, move |c| {
            c.query_row(
                &format!("SELECT COALESCE(SUM(n.value), 0) {UNSPENT_IRONWOOD}"),
                [account.replace('-', "")],
                |r| r.get::<_, u64>(0),
            )
        })
        .await?)
    }

    /// The account's largest unspent Ironwood note: (value, mined height).
    async fn largest_unspent_ironwood(
        &self,
        account: String,
    ) -> Result<Option<(u64, Option<u64>)>, ZecError> {
        let row = query(&self.cfg.wallet_dir, move |c| {
            c.query_row(
                &format!(
                    "SELECT n.value, t.mined_height {UNSPENT_IRONWOOD} ORDER BY n.value DESC LIMIT 1"
                ),
                [account.replace('-', "")],
                |r| Ok((r.get::<_, u64>(0)?, r.get::<_, Option<u64>>(1)?)),
            )
        })
        .await;
        match row {
            Ok(r) => Ok(Some(r)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Pools touched by a transaction our wallet stored (it stores what it builds).
    async fn stored_tx_pools(&self, txid: &str) -> Result<Pools, ZecError> {
        let mut key = hex::decode(txid).map_err(|e| ZecError::Other(format!("txid: {e}")))?;
        key.reverse();
        let raw = query(&self.cfg.wallet_dir, move |c| {
            c.query_row(
                "SELECT raw FROM transactions WHERE txid = ?1 AND raw IS NOT NULL",
                [key],
                |r| r.get::<_, Vec<u8>>(0),
            )
        })
        .await?;
        let path = self.cfg.wallet_dir.join("pczt").join(format!("{txid}.tx"));
        tokio::fs::create_dir_all(path.parent().expect("has a parent")).await?;
        tokio::fs::write(&path, raw).await?;
        let p = pools(&self.cfg.signer, &path).await;
        let _ = tokio::fs::remove_file(&path).await;
        p
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, ZecError> {
        let url = self
            .cfg
            .node_rpc
            .as_ref()
            .ok_or_else(|| ZecError::Rpc("no node RPC configured".into()))?;
        let mut req = self.http.post(url).json(&json!({
            "jsonrpc": "2.0", "id": "ferry", "method": method, "params": params
        }));
        if let Some((u, p)) = &self.cfg.node_rpc_auth {
            req = req.basic_auth(u, Some(p));
        }
        let resp: Value = req
            .send()
            .await
            .map_err(|e| ZecError::Rpc(e.to_string()))?
            .json()
            .await
            .map_err(|e| ZecError::Rpc(e.to_string()))?;
        match resp.get("error") {
            Some(e) if !e.is_null() => Err(ZecError::Rpc(e.to_string())),
            _ => Ok(resp["result"].clone()),
        }
    }

    async fn node_height(&self) -> Result<u64, ZecError> {
        if self.cfg.node_rpc.is_none() {
            // The tip the wallet last learned from the light wallet server.
            return query(&self.cfg.wallet_dir, |c| {
                c.query_row(
                    "SELECT MAX(h) FROM (SELECT MAX(height) AS h FROM blocks
                     UNION ALL SELECT MAX(block_range_end) - 1 FROM scan_queue)",
                    [],
                    |r| r.get::<_, Option<u64>>(0),
                )
            })
            .await
            .map(|h| h.unwrap_or(0))
            .map_err(Into::into);
        }
        self.rpc("getblockcount", json!([]))
            .await?
            .as_u64()
            .ok_or_else(|| ZecError::Rpc("getblockcount: not a number".into()))
    }

    /// Confirmations of a transaction the wallet knows (lock and sweeps both touch our joint
    /// account), for when there is no node RPC.
    async fn wallet_confirmations(&self, txid: &str) -> Result<Option<u32>, ZecError> {
        let mut raw = hex::decode(txid).map_err(|e| ZecError::Other(format!("txid: {e}")))?;
        raw.reverse();
        let mined = query(&self.cfg.wallet_dir, move |c| {
            c.query_row(
                "SELECT mined_height FROM transactions WHERE txid = ?1",
                [raw],
                |r| r.get::<_, Option<u64>>(0),
            )
        })
        .await;
        let mined = match mined {
            Ok(m) => m,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let tip = self.node_height().await?;
        Ok(Some(mined.map_or(0, |h| {
            tip.saturating_sub(h).saturating_add(1) as u32
        })))
    }

    /// `getrawtransaction txid 1`, or `None` if the node does not know the transaction.
    async fn raw_tx(&self, txid: &str) -> Result<Option<Value>, ZecError> {
        match self.rpc("getrawtransaction", json!([txid, 1])).await {
            Ok(v) => Ok(Some(v)),
            // -5: no such mempool or main chain transaction
            Err(ZecError::Rpc(e)) if e.contains("-5") => Ok(None),
            Err(e) => Err(e),
        }
    }
}

impl ZecLeg for DevtoolZecLeg {
    type Error = ZecError;

    async fn status(&self) -> Result<ZecStatus, ZecError> {
        let height = self.0.node_height().await?;
        let balance = self.0.cache.lock().unwrap().balance;
        let shielded_balance = match balance {
            Some(b) => b,
            None => {
                self.0.sync().await?;
                self.0.cache.lock().unwrap().balance.unwrap_or(0)
            }
        };
        Ok(ZecStatus {
            network: self.0.cfg.network.clone(),
            height,
            shielded_balance,
        })
    }

    fn receive_address(&self) -> Option<String> {
        Some(self.own_address().to_string())
    }

    fn joint_address(&self, fvk: &[u8; 96]) -> Result<String, ZecError> {
        Ok(self.0.joint_keys(fvk)?.1)
    }

    async fn send(&self, fvk: &[u8; 96], amount: u64) -> Result<String, ZecError> {
        // Import first, so the lock note is tracked from the block it lands in.
        self.0.joint_account(fvk).await?;
        let (_, ua) = self.0.joint_keys(fvk)?;
        let _w = self.0.wallet.lock().await;
        self.0.sync_locked().await?;
        let cfg = &self.0.cfg;

        // Shielded only, decided before anything is broadcast. Our Ironwood notes alone must be
        // able to cover the payment; if they only lack confirmations, wait.
        let need = amount + SEND_FEE_RESERVE;
        let unspent = self.0.unspent_ironwood(self.0.own_account.clone()).await?;
        if unspent < need {
            return Err(ZecError::Refused(format!(
                "our Ironwood notes total {unspent} zat, short of {amount} zat plus fees, and Ferry \
                 never funds the lock from transparent or other shielded pools"
            )));
        }
        let spendable = self.0.cache.lock().unwrap().balance.unwrap_or(0);
        if spendable < need {
            return Err(ZecError::Other(format!(
                "only {spendable} of {unspent} zat in Ironwood notes is spendable yet; waiting for confirmations"
            )));
        }

        let (created, proven, signed, done) = pczt_paths(cfg, "lock", fvk).await?;
        run_pczt(
            cfg,
            &[
                "create",
                &self.0.own_account,
                "--ironwood-only",
                "--address",
                &ua,
                "--value",
                &amount.to_string(),
                "--output",
                &path_str(&created),
            ],
        )
        .await?;
        // The exact transaction that will be signed and broadcast.
        let p = pools(&cfg.signer, &created).await?;
        if !p.ironwood_only() {
            return Err(ZecError::Refused(format!(
                "the lock transaction would not be Ironwood-only ({p})"
            )));
        }
        run_pczt(
            cfg,
            &["prove", &path_str(&created), "--output", &path_str(&proven)],
        )
        .await?;
        run_pczt(
            cfg,
            &[
                "sign",
                "-i",
                &path_str(&cfg.identity),
                &path_str(&created),
                "--output",
                &path_str(&signed),
            ],
        )
        .await?;
        let txid = combine_and_send(cfg, &proven, &signed, &done).await?;

        // What our wallet stored for it, as a second look (logged only: it is broadcast).
        match self.0.stored_tx_pools(&txid).await {
            Ok(p) if p.ironwood_only() => tracing::info!(%txid, "ZEC lock is Ironwood-only: {p}"),
            Ok(p) => tracing::error!(%txid, "SHIELDED-ONLY VIOLATION in the ZEC lock: {p}"),
            Err(e) => tracing::error!(%txid, "could not re-check the ZEC lock's pools: {e}"),
        }
        Ok(txid)
    }

    fn send_refused(&self, err: &ZecError) -> bool {
        matches!(err, ZecError::Refused(_))
    }

    async fn watch(&self, fvk: &[u8; 96]) -> Result<Vec<ZecNote>, ZecError> {
        let account = self.0.joint_account(fvk).await?;
        let rows = query(&self.0.cfg.wallet_dir, move |c| {
            let mut stmt = c.prepare(
                "SELECT t.txid, t.mined_height, n.value,
                    (SELECT t2.txid FROM ironwood_received_note_spends s
                       JOIN transactions t2 ON t2.id_tx = s.transaction_id
                      WHERE s.ironwood_received_note_id = n.id
                      ORDER BY t2.mined_height IS NULL, t2.mined_height LIMIT 1)
                 FROM ironwood_received_notes n
                 JOIN accounts a ON a.id = n.account_id
                 JOIN transactions t ON t.id_tx = n.transaction_id
                 WHERE lower(hex(a.uuid)) = ?1 AND n.value > 0 AND n.is_change = 0
                 ORDER BY t.mined_height IS NULL, t.mined_height, n.id",
            )?;
            let rows = stmt
                .query_map([account.replace('-', "")], |r| {
                    Ok((
                        r.get::<_, Vec<u8>>(0)?,
                        r.get::<_, Option<u64>>(1)?,
                        r.get::<_, u64>(2)?,
                        r.get::<_, Option<Vec<u8>>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
        if rows.is_empty() {
            return Ok(vec![]);
        }
        let tip = self.0.node_height().await?;
        Ok(rows
            .into_iter()
            .map(|(txid, mined, value, spent)| ZecNote {
                txid: display_txid(&txid),
                value,
                confirmations: mined.map_or(0, |h| tip.saturating_sub(h).saturating_add(1) as u32),
                spent_by: spent.as_deref().map(display_txid),
            })
            .collect())
    }

    async fn sweep(&self, fvk: &[u8; 96], ask: &[u8; 32]) -> Result<String, ZecError> {
        let account = self.0.joint_account(fvk).await?;
        let cfg = &self.0.cfg;
        let _w = self.0.wallet.lock().await;
        self.0.sync_locked().await?;

        // The lock note is the joint account's largest; sweep only once it is spendable, so a
        // sweep never goes out with whatever dust happens to be spendable and leaves it behind.
        let largest = self.0.largest_unspent_ironwood(account.clone()).await?;
        let tip = self.0.node_height().await?;
        match largest {
            None => {
                return Err(ZecError::Other(
                    "no unspent Ironwood notes at the joint address".into(),
                ))
            }
            Some((value, mined)) => {
                let confs = mined.map_or(0, |h| tip.saturating_sub(h) + 1);
                if confs < SPENDABLE_CONFIRMATIONS {
                    return Err(ZecError::Other(format!(
                        "the joint note ({value} zat) has {confs} of {SPENDABLE_CONFIRMATIONS} confirmations; not yet spendable"
                    )));
                }
            }
        }

        let (created, proven, signed, done) = pczt_paths(cfg, "sweep", fvk).await?;
        run_pczt(
            cfg,
            &[
                "create-max",
                &account,
                // Both parties hold the joint FVK, so the joint account's OVK would let the
                // counterparty decrypt outCiphertext and learn our address, amount and memo.
                "--discard-ovk",
                // Anyone can send notes to the joint receivers: foreign Sapling/Orchard notes
                // are ignored, and unconfirmed ones are left for later rather than waited on.
                "--ironwood-only",
                "--only-spendable",
                "--address",
                &self.0.own_address,
                "--output",
                &path_str(&created),
            ],
        )
        .await?;
        let p = pools(&cfg.signer, &created).await?;
        if !p.ironwood_only() {
            return Err(ZecError::Other(format!(
                "refusing to sign a sweep that is not Ironwood-only: {p}"
            )));
        }
        run_pczt(
            cfg,
            &["prove", &path_str(&created), "--output", &path_str(&proven)],
        )
        .await?;
        sign_pczt(&cfg.signer, ask, &created, &signed).await?;
        combine_and_send(cfg, &proven, &signed, &done).await
    }

    async fn confirmations(&self, txid: &str) -> Result<Option<u32>, ZecError> {
        if self.0.cfg.node_rpc.is_none() {
            return self.0.wallet_confirmations(txid).await;
        }
        Ok(self.0.raw_tx(txid).await?.map(|tx| {
            tx.get("confirmations")
                .and_then(Value::as_i64)
                .map_or(0, |c| c.max(0) as u32)
        }))
    }

    async fn describe_tx(&self, txid: &str) -> Result<Option<String>, ZecError> {
        if self.0.cfg.node_rpc.is_none() {
            return Ok(None);
        }
        let Some(tx) = self.0.raw_tx(txid).await? else {
            return Ok(None);
        };
        let count = |k: &str| tx.get(k).and_then(Value::as_array).map_or(0, Vec::len);
        let (vin, vout) = (count("vin"), count("vout"));
        let pool = |k: &str| {
            tx.get(k)
                .map(|b| {
                    let actions = b
                        .get("actions")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    let vb = b
                        .get("valueBalanceZat")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    (actions, vb)
                })
                .unwrap_or((0, 0))
        };
        let (iw_actions, iw_vb) = pool("ironwood");
        let (or_actions, _) = pool("orchard");
        let version = tx.get("version").and_then(Value::as_u64).unwrap_or(0);
        let mut line = format!(
            "v{version} transaction {}…: {} Ironwood action(s), valueBalance {iw_vb} zat; \
             amounts, addresses and memos encrypted; {vin} transparent input(s), {vout} transparent output(s)",
            &txid[..txid.len().min(12)],
            iw_actions
        );
        if or_actions > 0 {
            line.push_str(&format!(", {or_actions} Orchard action(s)"));
        }
        Ok(Some(line))
    }
}

// ---------------------------------------------------------------------------- helpers

/// Confirmations devtool's default policy wants before it spends a note received from another
/// wallet (the joint note, for both parties).
const SPENDABLE_CONFIRMATIONS: u64 = 10;

/// `FROM … WHERE` for an account's (bound as `?1`, UUID hex) Ironwood notes with no spend.
const UNSPENT_IRONWOOD: &str = "FROM ironwood_received_notes n
     JOIN accounts a ON a.id = n.account_id
     JOIN transactions t ON t.id_tx = n.transaction_id
     WHERE lower(hex(a.uuid)) = ?1 AND n.value > 0
       AND NOT EXISTS (SELECT 1 FROM ironwood_received_note_spends s
                       WHERE s.ironwood_received_note_id = n.id)";

/// Where one transaction's PCZT stages go: `<wallet>/pczt/<joint key>.<what>.{created,…}.pczt`.
async fn pczt_paths(
    cfg: &DevtoolConfig,
    what: &str,
    fvk: &[u8; 96],
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), ZecError> {
    let dir = cfg.wallet_dir.join("pczt");
    tokio::fs::create_dir_all(&dir).await?;
    let key = hex::encode(&fvk[..12]);
    let file = |stage: &str| dir.join(format!("{key}.{what}.{stage}.pczt"));
    Ok((
        file("created"),
        file("proven"),
        file("signed"),
        file("final"),
    ))
}

/// `zcash-devtool pczt -w <wallet_dir> <args…>`
async fn run_pczt(cfg: &DevtoolConfig, args: &[&str]) -> Result<String, ZecError> {
    let mut full = vec!["pczt".to_string(), "-w".into(), path_str(&cfg.wallet_dir)];
    full.extend(args.iter().map(|a| a.to_string()));
    run_devtool(cfg, &full, BUILD_TIMEOUT).await
}

/// Combines the proven and signed PCZTs and broadcasts the result (devtool stores it in the
/// wallet). Errors from here on may come after the transaction reached the network.
async fn combine_and_send(
    cfg: &DevtoolConfig,
    proven: &Path,
    signed: &Path,
    done: &Path,
) -> Result<String, ZecError> {
    run_pczt(
        cfg,
        &[
            "combine",
            "-i",
            &path_str(proven),
            "-i",
            &path_str(signed),
            "-o",
            &path_str(done),
        ],
    )
    .await?;
    let out = run_pczt(cfg, &["send", &path_str(done), "-s", &cfg.server]).await?;
    last_txid(&out).ok_or_else(|| ZecError::Other(format!("pczt send printed no txid:\n{out}")))
}

/// Fee headroom required on top of a send (ZIP 317: 5000 zat per action, 2 actions minimum;
/// ten actions' worth covers a lock spending several notes).
const SEND_FEE_RESERVE: u64 = 50_000;

const POOL_KEYS: [&str; 6] = [
    "transparent_inputs",
    "transparent_outputs",
    "sapling_spends",
    "sapling_outputs",
    "orchard_actions",
    "ironwood_actions",
];

/// What a transaction touches, from `ferry-zec-signer pools`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pools {
    pub transparent_inputs: usize,
    pub transparent_outputs: usize,
    pub sapling_spends: usize,
    pub sapling_outputs: usize,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
}

impl Pools {
    /// Nothing transparent, Sapling or Orchard, and at least one Ironwood action.
    pub fn ironwood_only(&self) -> bool {
        self.ironwood_actions > 0
            && self.transparent_inputs + self.transparent_outputs == 0
            && self.sapling_spends + self.sapling_outputs + self.orchard_actions == 0
    }

    /// Parses `key=count` pairs; every one of the six keys must appear exactly once (a missing
    /// count must not read as zero).
    fn parse(line: &str) -> Option<Pools> {
        let mut seen: [Option<usize>; 6] = [None; 6];
        for kv in line.split_whitespace() {
            let (k, v) = kv.split_once('=')?;
            let i = POOL_KEYS.iter().position(|key| *key == k)?;
            if seen[i].replace(v.parse().ok()?).is_some() {
                return None;
            }
        }
        let [ti, to, ss, so, oa, ia] = seen;
        Some(Pools {
            transparent_inputs: ti?,
            transparent_outputs: to?,
            sapling_spends: ss?,
            sapling_outputs: so?,
            orchard_actions: oa?,
            ironwood_actions: ia?,
        })
    }
}

impl std::fmt::Display for Pools {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "transparent {}in/{}out, sapling {}/{}, orchard {}, ironwood {} actions",
            self.transparent_inputs,
            self.transparent_outputs,
            self.sapling_spends,
            self.sapling_outputs,
            self.orchard_actions,
            self.ironwood_actions
        )
    }
}

async fn pools(signer: &Path, file: &Path) -> Result<Pools, ZecError> {
    let mut cmd = Command::new(signer);
    cmd.args(["pools", &path_str(file)]);
    let out = run_limited(cmd, "ferry-zec-signer pools", None, READ_TIMEOUT).await?;
    let text = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        return Err(ZecError::Tool {
            cmd: "ferry-zec-signer pools".into(),
            detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Pools::parse(text.trim())
        .ok_or_else(|| ZecError::Other(format!("ferry-zec-signer pools printed {text:?}")))
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn tool_err(cmd: &str, e: impl std::fmt::Display) -> ZecError {
    ZecError::Tool {
        cmd: cmd.into(),
        detail: e.to_string(),
    }
}

/// `zcash-devtool wallet -w <wallet_dir> <args…>`
async fn run_devtool_wallet(
    cfg: &DevtoolConfig,
    args: &[String],
    limit: Duration,
) -> Result<String, ZecError> {
    let mut full = vec!["wallet".to_string(), "-w".into(), path_str(&cfg.wallet_dir)];
    full.extend_from_slice(args);
    run_devtool(cfg, &full, limit).await
}

/// Time limits for subprocesses. A light wallet server that stops answering must not hold the
/// wallet lock forever (a testnet `sync` once hung for 11 hours).
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const SYNC_TIMEOUT: Duration = Duration::from_secs(300);
/// PCZT building, proving and broadcasting.
const BUILD_TIMEOUT: Duration = Duration::from_secs(600);

/// Runs `cmd` to completion (feeding it `stdin`, if any) and kills it after `limit`.
async fn run_limited(
    mut cmd: Command,
    label: &str,
    stdin: Option<Vec<u8>>,
    limit: Duration,
) -> Result<std::process::Output, ZecError> {
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    // Dropping the future on timeout drops the child, which kills it.
    .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| tool_err(label, e))?;
    let run = async move {
        if let Some(bytes) = stdin {
            let mut pipe = child.stdin.take().expect("piped stdin");
            pipe.write_all(&bytes).await?;
            drop(pipe);
        }
        child.wait_with_output().await
    };
    match tokio::time::timeout(limit, run).await {
        Ok(out) => out.map_err(|e| tool_err(label, e)),
        Err(_) => Err(ZecError::Timeout {
            cmd: label.into(),
            secs: limit.as_secs(),
        }),
    }
}

/// [`run_limited`] for the one synchronous call site ([`ZecLeg::joint_address`]).
fn run_blocking_limited(
    cmd: &mut std::process::Command,
    label: &str,
    limit: Duration,
) -> Result<std::process::Output, ZecError> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| tool_err(label, e))?;
    let deadline = std::time::Instant::now() + limit;
    loop {
        if child.try_wait().map_err(|e| tool_err(label, e))?.is_some() {
            return child.wait_with_output().map_err(|e| tool_err(label, e));
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ZecError::Timeout {
                cmd: label.into(),
                secs: limit.as_secs(),
            });
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Runs devtool and returns its stdout; a failure carries the tail of its output.
async fn run_devtool(
    cfg: &DevtoolConfig,
    args: &[String],
    limit: Duration,
) -> Result<String, ZecError> {
    let cmd = format!(
        "zcash-devtool {}",
        args.iter().take(4).cloned().collect::<Vec<_>>().join(" ")
    );
    let mut command = Command::new(&cfg.devtool);
    command
        .args(args)
        .env("RUST_LOG", "error")
        .env("NO_COLOR", "1");
    let out = run_limited(command, &cmd, None, limit).await?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let all = format!("{stdout}{stderr}");
        let tail: Vec<&str> = all.lines().rev().take(6).collect();
        return Err(ZecError::Tool {
            cmd,
            detail: tail.into_iter().rev().collect::<Vec<_>>().join(" | "),
        });
    }
    Ok(stdout)
}

/// Signs with the helper, handing it `ask` on stdin rather than on the command line.
async fn sign_pczt(
    signer: &Path,
    ask: &[u8; 32],
    input: &Path,
    output: &Path,
) -> Result<(), ZecError> {
    let mut cmd = Command::new(signer);
    cmd.args(["sign", &path_str(input), &path_str(output)]);
    let out = run_limited(
        cmd,
        "ferry-zec-signer sign",
        Some(hex::encode(ask).into_bytes()),
        READ_TIMEOUT,
    )
    .await?;
    if !out.status.success() {
        return Err(ZecError::Tool {
            cmd: "ferry-zec-signer sign".into(),
            detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(())
}

/// Runs a read-only query against the wallet database off the async runtime.
async fn query<T: Send + 'static>(
    wallet_dir: &Path,
    f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static,
) -> rusqlite::Result<T> {
    let path = wallet_dir.join("data.sqlite");
    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::from_secs(10))?;
        f(&conn)
    })
    .await
    .expect("wallet query task panicked")
}

fn uuid_str(b: &[u8]) -> String {
    let h = hex::encode(b);
    if h.len() != 32 {
        return h;
    }
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// Transaction ids are stored in internal byte order and displayed reversed.
fn display_txid(raw: &[u8]) -> String {
    let mut b = raw.to_vec();
    b.reverse();
    hex::encode(b)
}

fn last_txid(out: &str) -> Option<String> {
    out.lines()
        .map(str::trim)
        .rev()
        .find(|l| l.len() == 64 && l.bytes().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_string)
}

/// "4.99990000" -> 499_990_000 zatoshi.
fn parse_zec(s: &str) -> Option<u64> {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if frac.len() > 8 {
        return None;
    }
    let whole: u64 = whole.parse().ok()?;
    let frac: u64 = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<8}").parse().ok()?
    };
    whole.checked_mul(100_000_000)?.checked_add(frac)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shielded_only_checks() {
        let p = Pools::parse("transparent_inputs=0 transparent_outputs=0 sapling_spends=0 sapling_outputs=0 orchard_actions=0 ironwood_actions=2").unwrap();
        assert!(p.ironwood_only());
        assert!(!Pools {
            transparent_outputs: 1,
            ..p
        }
        .ironwood_only());
        assert!(!Pools {
            orchard_actions: 2,
            ..p
        }
        .ironwood_only());
        assert!(!Pools {
            ironwood_actions: 0,
            ..p
        }
        .ironwood_only());
    }

    #[test]
    fn pools_parse_requires_every_key() {
        let all = "transparent_inputs=0 transparent_outputs=0 sapling_spends=0 sapling_outputs=0 orchard_actions=0 ironwood_actions=2";
        assert!(Pools::parse(all).is_some());
        // A missing count is an error, not a zero.
        for key in POOL_KEYS {
            let without: Vec<&str> = all.split(' ').filter(|kv| !kv.starts_with(key)).collect();
            assert_eq!(Pools::parse(&without.join(" ")), None, "without {key}");
        }
        assert_eq!(Pools::parse(""), None);
        assert_eq!(
            Pools::parse(&format!("{all} ironwood_actions=3")),
            None,
            "duplicate"
        );
        assert_eq!(Pools::parse(&format!("{all} extra=1")), None, "unknown key");
        assert_eq!(Pools::parse(&all.replace("=2", "=x")), None, "not a number");
    }

    #[tokio::test]
    async fn hung_subprocesses_are_killed() {
        let dir = std::env::temp_dir().join(format!("ferry-zec-timeout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("pid");
        let mut cmd = Command::new("sh");
        cmd.args([
            "-c",
            &format!("echo $$ > {}; exec sleep 30", pidfile.display()),
        ]);
        let started = std::time::Instant::now();
        let err = run_limited(cmd, "sleep", None, Duration::from_millis(500))
            .await
            .unwrap_err();
        assert!(matches!(err, ZecError::Timeout { .. }), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
        // The child is gone (or at most an unreaped zombie), not still sleeping.
        let pid = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .to_string();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let stat = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid])
            .output()
            .unwrap();
        let stat = String::from_utf8_lossy(&stat.stdout);
        assert!(
            stat.trim().is_empty() || stat.trim().starts_with('Z'),
            "still running: {stat}"
        );

        let mut sync = std::process::Command::new("sleep");
        sync.arg("30");
        let err = run_blocking_limited(&mut sync, "sleep", Duration::from_millis(300)).unwrap_err();
        assert!(matches!(err, ZecError::Timeout { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parsing() {
        assert_eq!(parse_zec("4.99990000"), Some(499_990_000));
        assert_eq!(parse_zec("0.5"), Some(50_000_000));
        assert_eq!(parse_zec("650"), Some(65_000_000_000));
        assert_eq!(parse_zec("1.000000001"), None);
        assert_eq!(
            uuid_str(&hex::decode("87db9ac8ffb74bdfa3a7dd78973655ee").unwrap()),
            "87db9ac8-ffb7-4bdf-a3a7-dd78973655ee"
        );
        assert_eq!(display_txid(&[1, 2, 3]), "030201");
        let out = "Sending transaction...\n2e90568486787c4e6cd86db81f33d3adbf78cb16a7b915aa37436e52666e5d73\n";
        assert_eq!(
            last_txid(out).as_deref(),
            Some("2e90568486787c4e6cd86db81f33d3adbf78cb16a7b915aa37436e52666e5d73")
        );
    }
}
