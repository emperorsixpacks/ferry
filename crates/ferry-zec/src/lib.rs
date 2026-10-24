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
//! - **Retries never strand the lock note.** devtool stores a transaction before broadcasting
//!   it. A spend only counts while its transaction is mined or not yet expired, a retried sweep
//!   rebroadcasts the one already built instead of building another, the background task hands
//!   our unmined transactions to the node again every 30 s, and a sweep is signed only if it
//!   spends a note worth the swap amount (dust alone is never "the sweep"). A lock that fails
//!   before `pczt send` is [`ZecError::NotSent`] (safe to retry); from `pczt send` on it may
//!   have gone out.
//! - **Time limits.** Every subprocess is killed past its limit (reads 60 s, sync 5 min, PCZT
//!   steps and broadcast 10 min), so a stuck light wallet server cannot hold that lock forever.
//!   A timeout is an ordinary error: sync retries, and a send that timed out is "maybe sent".

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use ferry_core::{SendFailure, ZecLeg, ZecNote, ZecStatus};
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
    /// Failed before anything was broadcast (sync, note selection, build, prove, sign);
    /// sending again is safe.
    #[error("not sent: {0}")]
    NotSent(String),
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
    let mut last_rebroadcast = std::time::Instant::now();
    loop {
        let Some(i) = inner.upgrade() else { return };
        let interval = i.cfg.sync_interval;
        if let Err(e) = i.sync().await {
            tracing::warn!("zcash wallet sync: {e}");
        }
        if last_rebroadcast.elapsed() >= REBROADCAST_EVERY {
            last_rebroadcast = std::time::Instant::now();
            i.rebroadcast_unmined().await;
        }
        drop(i);
        tokio::time::sleep(interval).await;
    }
}

/// How often our own unmined, unexpired transactions are handed to the node again.
const REBROADCAST_EVERY: Duration = Duration::from_secs(30);

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
                &format!(
                    "SELECT COALESCE(SUM(n.value), 0) {}",
                    unspent_ironwood_sql()
                ),
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
                    "SELECT n.value, nt.mined_height {} ORDER BY n.value DESC LIMIT 1",
                    unspent_ironwood_sql()
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

    /// Builds, checks, proves and signs the lock, up to the combined PCZT ready to broadcast.
    /// Nothing here touches the network except the wallet sync. The caller holds the lock.
    async fn build_lock(&self, fvk: &[u8; 96], ua: &str, amount: u64) -> Result<PathBuf, ZecError> {
        self.sync_locked().await?;
        let cfg = &self.cfg;

        // Shielded only, decided before anything is broadcast. Our Ironwood notes alone must be
        // able to cover the payment; if they only lack confirmations, wait.
        let need = amount + SEND_FEE_RESERVE;
        let unspent = self.unspent_ironwood(self.own_account.clone()).await?;
        if unspent < need {
            return Err(ZecError::Refused(format!(
                "our Ironwood notes total {unspent} zat, short of {amount} zat plus fees, and Ferry \
                 never funds the lock from transparent or other shielded pools"
            )));
        }
        let spendable = self.cache.lock().unwrap().balance.unwrap_or(0);
        if spendable < need {
            return Err(ZecError::NotSent(format!(
                "only {spendable} of {unspent} zat in Ironwood notes is spendable yet; waiting for confirmations"
            )));
        }

        let (created, proven, signed, done) = pczt_paths(cfg, "lock", fvk).await?;
        run_pczt(
            cfg,
            &[
                "create",
                &self.own_account,
                "--ironwood-only",
                "--address",
                ua,
                "--value",
                &amount.to_string(),
                "--output",
                &path_str(&created),
            ],
        )
        .await?;
        // The exact transaction that will be signed and broadcast.
        lock_guard(&pools(&cfg.signer, &created).await?)?;
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
        combine(cfg, &proven, &signed, &done).await?;
        Ok(done)
    }

    /// A transaction we built that spends one of the account's notes worth at least
    /// `min_value` and is mined or may still be: (txid, mined, raw bytes).
    async fn our_live_spend(
        &self,
        account: String,
        min_value: u64,
    ) -> Result<Option<(String, bool, Vec<u8>)>, ZecError> {
        let row = query(&self.cfg.wallet_dir, move |c| {
            c.query_row(
                &format!(
                    "SELECT t.txid, t.mined_height IS NOT NULL, t.raw FROM transactions t
                     WHERE t.created IS NOT NULL AND t.raw IS NOT NULL AND {LIVE_TX}
                       AND t.id_tx IN (SELECT s.transaction_id FROM ironwood_received_note_spends s
                                       JOIN ironwood_received_notes n ON n.id = s.ironwood_received_note_id
                                       JOIN accounts a ON a.id = n.account_id
                                       WHERE lower(hex(a.uuid)) = ?1 AND n.value >= ?2)
                     ORDER BY t.mined_height IS NULL, t.id_tx DESC LIMIT 1"
                ),
                rusqlite::params![account.replace('-', ""), min_value],
                |r| {
                    Ok((
                        r.get::<_, Vec<u8>>(0)?,
                        r.get::<_, bool>(1)?,
                        r.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
        })
        .await;
        match row {
            Ok((txid, mined, raw)) => Ok(Some((display_txid(&txid), mined, raw))),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// The account's received (non-change) Ironwood notes from mined or unexpired
    /// transactions: (txid, mined height, value, spending txid). Only a mined or unexpired spend
    /// counts, a mined one first, so an expired attempt never shadows the spend that confirmed.
    async fn joint_notes(&self, account: String) -> Result<Vec<NoteRow>, ZecError> {
        Ok(query(&self.cfg.wallet_dir, move |c| {
            let mut stmt = c.prepare(&format!(
                "SELECT nt.txid, nt.mined_height, n.value,
                    (SELECT t.txid FROM ironwood_received_note_spends s
                       JOIN transactions t ON t.id_tx = s.transaction_id
                      WHERE s.ironwood_received_note_id = n.id AND {LIVE_TX}
                      ORDER BY t.mined_height IS NULL, t.mined_height LIMIT 1)
                 FROM ironwood_received_notes n
                 JOIN accounts a ON a.id = n.account_id
                 JOIN transactions nt ON nt.id_tx = n.transaction_id
                 WHERE lower(hex(a.uuid)) = ?1 AND n.value > 0 AND n.is_change = 0
                   AND EXISTS (SELECT 1 FROM transactions t WHERE t.id_tx = nt.id_tx AND {LIVE_TX})
                 ORDER BY nt.mined_height IS NULL, nt.mined_height, n.id"
            ))?;
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
        .await?)
    }

    /// No note worth `amount` in the joint account from a mined or unexpired transaction, and
    /// no unmined, unexpired transaction of ours spending our own notes (a lock still in flight:
    /// devtool stores a transaction before broadcasting it, so one that may be out is here).
    /// Expiry is judged against the wallet's scanned tip, which is also where it learns what was
    /// mined, so an unscanned mined lock still counts as in flight. One query, one snapshot.
    async fn lock_lapsed_in(&self, joint: String, amount: u64) -> Result<bool, ZecError> {
        let own = self.own_account.replace('-', "");
        Ok(query(&self.cfg.wallet_dir, move |c| {
            c.query_row(
                &format!(
                    "SELECT NOT EXISTS (SELECT 1 FROM ironwood_received_notes n
                                          JOIN accounts a ON a.id = n.account_id
                                          JOIN transactions t ON t.id_tx = n.transaction_id
                                         WHERE lower(hex(a.uuid)) = ?1 AND n.value >= ?2 AND {LIVE_TX})
                        AND NOT EXISTS (SELECT 1 FROM transactions t
                                         WHERE t.created IS NOT NULL AND t.mined_height IS NULL AND {LIVE_TX}
                                           AND t.id_tx IN (SELECT s.transaction_id FROM ironwood_received_note_spends s
                                                           JOIN ironwood_received_notes n ON n.id = s.ironwood_received_note_id
                                                           JOIN accounts a ON a.id = n.account_id
                                                           WHERE lower(hex(a.uuid)) = ?3))"
                ),
                rusqlite::params![joint.replace('-', ""), amount, own],
                |r| r.get::<_, bool>(0),
            )
        })
        .await?)
    }

    /// Hands every transaction we built that is neither mined nor expired back to the node
    /// (devtool stores before it broadcasts, so a failed broadcast would otherwise leave a lock
    /// or sweep stuck until it expires). Needs the node RPC; best effort.
    async fn rebroadcast_unmined(&self) {
        if self.cfg.node_rpc.is_none() {
            return;
        }
        let rows = query(&self.cfg.wallet_dir, |c| {
            let mut stmt = c.prepare(&format!(
                "SELECT t.txid, t.raw FROM transactions t
                 WHERE t.created IS NOT NULL AND t.raw IS NOT NULL AND t.mined_height IS NULL
                   AND {LIVE_TX}"
            ))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Vec<u8>>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await;
        match rows {
            Ok(rows) => {
                for (txid, raw) in rows {
                    let txid = display_txid(&txid);
                    let dummy = PathBuf::new();
                    if let Err(e) = self.rebroadcast(&txid, &raw, &dummy).await {
                        tracing::warn!(%txid, "rebroadcast: {e}");
                    }
                }
            }
            Err(e) => tracing::warn!("listing unmined transactions: {e}"),
        }
    }

    /// Puts a transaction we built back on the network. Already known to the node is fine.
    async fn rebroadcast(&self, txid: &str, raw: &[u8], final_pczt: &Path) -> Result<(), ZecError> {
        if self.cfg.node_rpc.is_some() {
            return match self
                .rpc("sendrawtransaction", json!([hex::encode(raw)]))
                .await
            {
                Ok(_) => Ok(()),
                Err(ZecError::Rpc(e)) if node_has_tx(&e) => Ok(()),
                Err(e) => Err(ZecError::Other(format!("rebroadcasting {txid}: {e}"))),
            };
        }
        // No node RPC: devtool can only send a PCZT, so resend the one this came from.
        if !final_pczt.exists() {
            return Err(ZecError::Other(format!(
                "cannot rebroadcast {txid} without a node RPC or its PCZT"
            )));
        }
        run_pczt(
            &self.cfg,
            &["send", &path_str(final_pczt), "-s", &self.cfg.server],
        )
        .await
        .map(|_| ())
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
        // A hung node must not hold up the caller (and so the daemon's Bitcoin deadlines).
        req = req.timeout(NODE_RPC_TIMEOUT);
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
        // Everything up to `pczt send` happens before any broadcast: its failures are NotSent
        // (or Refused), so the daemon may simply try again.
        self.0.joint_account(fvk).await.map_err(not_sent)?;
        let (_, ua) = self.0.joint_keys(fvk).map_err(not_sent)?;
        // Held for the whole build and broadcast.
        let _w = self.0.wallet.lock().await;
        let done = self
            .0
            .build_lock(fvk, &ua, amount)
            .await
            .map_err(not_sent)?;
        let cfg = &self.0.cfg;
        let out = run_pczt(cfg, &["send", &path_str(&done), "-s", &cfg.server]).await?;
        let txid = last_txid(&out)
            .ok_or_else(|| ZecError::Other(format!("pczt send printed no txid:\n{out}")))?;

        // What our wallet stored for it, as a second look (logged only: it is broadcast).
        match self.0.stored_tx_pools(&txid).await {
            Ok(p) if p.ironwood_only() => tracing::info!(%txid, "ZEC lock is Ironwood-only: {p}"),
            Ok(p) => tracing::error!(%txid, "SHIELDED-ONLY VIOLATION in the ZEC lock: {p}"),
            Err(e) => tracing::error!(%txid, "could not re-check the ZEC lock's pools: {e}"),
        }
        Ok(txid)
    }

    fn send_fee_reserve(&self) -> u64 {
        SEND_FEE_RESERVE
    }

    async fn lock_lapsed(&self, fvk: &[u8; 96], amount: u64) -> Result<bool, ZecError> {
        let account = self.0.joint_account(fvk).await?;
        self.0.lock_lapsed_in(account, amount).await
    }

    fn send_failure(&self, err: &ZecError) -> SendFailure {
        match err {
            ZecError::Refused(_) => SendFailure::Refused,
            ZecError::NotSent(_) => SendFailure::NotSent,
            // Including a timed-out or failed `pczt send`: it may have reached the network.
            _ => SendFailure::MaybeSent,
        }
    }

    async fn watch(&self, fvk: &[u8; 96]) -> Result<Vec<ZecNote>, ZecError> {
        let account = self.0.joint_account(fvk).await?;
        let rows = self.0.joint_notes(account).await?;
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

    async fn sweep(
        &self,
        fvk: &[u8; 96],
        ask: &[u8; 32],
        lock_value: u64,
    ) -> Result<String, ZecError> {
        let account = self.0.joint_account(fvk).await?;
        let cfg = &self.0.cfg;
        let _w = self.0.wallet.lock().await;
        self.0.sync_locked().await?;
        let (created, proven, signed, done) = pczt_paths(cfg, "sweep", fvk).await?;

        // A sweep of the lock note we already built (devtool stores it before broadcasting, so a
        // failed or timed-out broadcast leaves it here): mined means done; otherwise put it back
        // on the network until it confirms or expires. Building a second one would conflict.
        if let Some((txid, mined, raw)) = self.0.our_live_spend(account.clone(), lock_value).await?
        {
            if !mined {
                self.0.rebroadcast(&txid, &raw, &done).await?;
            }
            return Ok(txid);
        }

        // The lock note must be unspent and spendable (devtool wants 10 confirmations for a note
        // from another wallet), so a sweep never goes out with just dust that happens to be
        // spendable and leaves the lock note behind.
        let tip = self.0.node_height().await?;
        match self.0.largest_unspent_ironwood(account.clone()).await? {
            Some((value, mined)) if value >= lock_value => {
                let confs = mined.map_or(0, |h| tip.saturating_sub(h) + 1);
                if confs < SPENDABLE_CONFIRMATIONS {
                    return Err(ZecError::Other(format!(
                        "the joint note ({value} zat) has {confs} of {SPENDABLE_CONFIRMATIONS} confirmations; not yet spendable"
                    )));
                }
            }
            _ => {
                return Err(ZecError::Other(format!(
                    "no unspent note of at least {lock_value} zat at the joint address"
                )))
            }
        }

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
        let spent = spend_values(&cfg.signer, &created).await?;
        if !spent.iter().any(|v| *v >= lock_value) {
            return Err(ZecError::Other(format!(
                "refusing to sign a sweep that leaves the lock note ({lock_value} zat) behind: it spends {spent:?}"
            )));
        }
        run_pczt(
            cfg,
            &["prove", &path_str(&created), "--output", &path_str(&proven)],
        )
        .await?;
        sign_pczt(&cfg.signer, ask, &created, &signed).await?;
        combine(cfg, &proven, &signed, &done).await?;
        let out = run_pczt(cfg, &["send", &path_str(&done), "-s", &cfg.server]).await?;
        last_txid(&out).ok_or_else(|| ZecError::Other(format!("pczt send printed no txid:\n{out}")))
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

/// SQL condition: transaction `t` is mined, or could still be (its expiry height is above the
/// wallet's scanned tip). devtool stores a transaction before broadcasting it, so a spend by a
/// transaction that never made it only counts until it expires.
const LIVE_TX: &str =
    "(t.mined_height IS NOT NULL OR t.expiry_height IS NULL OR t.expiry_height = 0
       OR t.expiry_height > (SELECT COALESCE(MAX(height), 0) FROM blocks))";

/// `FROM … WHERE` for an account's (bound as `?1`, UUID hex) Ironwood notes that no live
/// transaction spends.
fn unspent_ironwood_sql() -> String {
    format!(
        "FROM ironwood_received_notes n
         JOIN accounts a ON a.id = n.account_id
         JOIN transactions nt ON nt.id_tx = n.transaction_id
         WHERE lower(hex(a.uuid)) = ?1 AND n.value > 0
           AND NOT EXISTS (SELECT 1 FROM ironwood_received_note_spends s
                           JOIN transactions t ON t.id_tx = s.transaction_id
                           WHERE s.ironwood_received_note_id = n.id AND {LIVE_TX})"
    )
}

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

/// Combines the proven and signed PCZTs into one ready to broadcast.
async fn combine(
    cfg: &DevtoolConfig,
    proven: &Path,
    signed: &Path,
    done: &Path,
) -> Result<(), ZecError> {
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
    .await
    .map(|_| ())
}

/// Errors before the broadcast: anything but a refusal becomes [`ZecError::NotSent`].
fn not_sent(e: ZecError) -> ZecError {
    match e {
        ZecError::Refused(_) | ZecError::NotSent(_) => e,
        other => ZecError::NotSent(other.to_string()),
    }
}

/// The lock must be Ironwood-only; anything else is refused, not retried.
fn lock_guard(p: &Pools) -> Result<(), ZecError> {
    if p.ironwood_only() {
        Ok(())
    } else {
        Err(ZecError::Refused(format!(
            "the lock transaction would not be Ironwood-only ({p})"
        )))
    }
}

/// Values of the notes a PCZT's Ironwood actions spend (dummies are 0).
async fn spend_values(signer: &Path, file: &Path) -> Result<Vec<u64>, ZecError> {
    let mut cmd = Command::new(signer);
    cmd.args(["spends", &path_str(file)]);
    let out = run_limited(cmd, "ferry-zec-signer spends", None, READ_TIMEOUT).await?;
    let text = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        return Err(ZecError::Tool {
            cmd: "ferry-zec-signer spends".into(),
            detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    parse_spends(text.trim())
        .ok_or_else(|| ZecError::Other(format!("ferry-zec-signer spends printed {text:?}")))
}

/// `ironwood=500000000,0 orchard=` -> the Ironwood values.
fn parse_spends(line: &str) -> Option<Vec<u64>> {
    let iw = line
        .split_whitespace()
        .find_map(|kv| kv.strip_prefix("ironwood="))?;
    if iw.is_empty() {
        return Some(vec![]);
    }
    iw.split(',').map(|v| v.parse().ok()).collect()
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

/// A received note as stored: (txid, mined height, value, spending txid), txids in raw order.
type NoteRow = (Vec<u8>, Option<u64>, u64, Option<Vec<u8>>);

/// Time limit for one call to the node's JSON-RPC.
const NODE_RPC_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether a `sendrawtransaction` error says the node already has this very transaction, in its
/// mempool or a block. A rejection (a conflicting spend, an expired or invalid transaction) is
/// not: "already" alone also appears in Zebra's "another transaction in the mempool has already
/// spent some of its inputs", and "known" in "unknown".
fn node_has_tx(err: &str) -> bool {
    // zcashd: RPC_VERIFY_ALREADY_IN_CHAIN.
    if serde_json::from_str::<Value>(err).is_ok_and(|v| v["code"].as_i64() == Some(-27)) {
        return true;
    }
    [
        // Zebra (code -26, the mempool's own message)
        "transaction already exists in mempool",
        "transaction dropped because it is already queued for download",
        "transaction is already in state",
        "transaction was committed to the best chain",
        // zcashd / bitcoind
        "txn-already-in-mempool",
        "txn-already-known",
    ]
    .iter()
    .any(|k| err.contains(k))
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
    // Drain both pipes on their own threads: a child that fills a pipe buffer would otherwise
    // block forever and look like a timeout.
    let drain = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| tool_err(label, e))? {
            break status;
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
    };
    Ok(std::process::Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
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
    fn non_ironwood_locks_are_refused_not_retried() {
        let ironwood = Pools {
            ironwood_actions: 2,
            ..Pools::default()
        };
        assert!(lock_guard(&ironwood).is_ok());
        for bad in [
            Pools {
                orchard_actions: 2,
                ..ironwood
            },
            Pools {
                sapling_outputs: 1,
                ..ironwood
            },
            Pools {
                sapling_spends: 1,
                ..ironwood
            },
            Pools {
                transparent_inputs: 1,
                ..ironwood
            },
            Pools {
                transparent_outputs: 1,
                ..ironwood
            },
            Pools::default(),
        ] {
            let err = lock_guard(&bad).unwrap_err();
            assert!(matches!(err, ZecError::Refused(_)), "{bad}: {err}");
            // not_sent keeps a refusal a refusal.
            assert!(matches!(not_sent(err), ZecError::Refused(_)));
        }
    }

    #[test]
    fn failures_before_broadcast_are_not_sent() {
        for e in [
            ZecError::Timeout {
                cmd: "zcash-devtool wallet sync".into(),
                secs: 300,
            },
            ZecError::Tool {
                cmd: "zcash-devtool pczt prove".into(),
                detail: "boom".into(),
            },
            ZecError::Other("only 1 of 2 zat spendable".into()),
        ] {
            assert!(matches!(not_sent(e), ZecError::NotSent(_)));
        }
    }

    /// A wallet database with just the columns ferry-zec reads.
    fn fake_wallet(dir: &Path) -> Inner {
        let c = rusqlite::Connection::open(dir.join("data.sqlite")).unwrap();
        c.execute_batch(
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, uuid BLOB, name TEXT, has_spend_key INTEGER);
             CREATE TABLE transactions (id_tx INTEGER PRIMARY KEY, txid BLOB, created TEXT,
                 mined_height INTEGER, expiry_height INTEGER, raw BLOB);
             CREATE TABLE ironwood_received_notes (id INTEGER PRIMARY KEY, transaction_id INTEGER,
                 account_id INTEGER, value INTEGER, is_change INTEGER);
             CREATE TABLE ironwood_received_note_spends (ironwood_received_note_id INTEGER,
                 transaction_id INTEGER);
             CREATE TABLE blocks (height INTEGER PRIMARY KEY);
             INSERT INTO accounts VALUES (1, x'00000000000000000000000000000001', 'joint', 0);
             -- the lock note (1 ZEC, mined at 100) and a dust note (20000 zat, mined at 105)
             INSERT INTO transactions VALUES (1, x'01', NULL, 100, NULL, NULL);
             INSERT INTO transactions VALUES (2, x'02', NULL, 105, NULL, NULL);
             INSERT INTO ironwood_received_notes VALUES (1, 1, 1, 100000000, 0);
             INSERT INTO ironwood_received_notes VALUES (2, 2, 1, 20000, 0);
             -- our sweep of the lock note: stored, never mined, expires after height 150
             INSERT INTO transactions VALUES (3, x'03', '2026-10-17', NULL, 150, x'beef');
             INSERT INTO ironwood_received_note_spends VALUES (1, 3);
             INSERT INTO blocks VALUES (120);",
        )
        .unwrap();
        Inner {
            cfg: DevtoolConfig {
                devtool: "zcash-devtool".into(),
                signer: "ferry-zec-signer".into(),
                wallet_dir: dir.to_path_buf(),
                identity: dir.join("id.age"),
                server: "localhost:1".into(),
                network: "regtest".into(),
                activation_heights: None,
                node_rpc: None,
                node_rpc_auth: None,
                sync_interval: Duration::from_secs(1),
            },
            http: reqwest::Client::new(),
            wallet: tokio::sync::Mutex::new(()),
            cache: Mutex::new(Cache::default()),
            own_account: "00000000-0000-0000-0000-000000000002".into(),
            own_address: String::new(),
        }
    }

    /// Audit N1: a stored sweep that never made it must neither make the lock note look spent
    /// forever nor let a retry sweep only the dust.
    #[tokio::test]
    async fn stored_unbroadcast_sweep_counts_until_it_expires() {
        let dir = std::env::temp_dir().join(format!("ferry-zec-n1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = fake_wallet(&dir);
        let joint = "00000000-0000-0000-0000-000000000001".to_string();

        // Before expiry: the retry finds our sweep (to rebroadcast, not rebuild), and the
        // largest unspent note is the dust, which is below the lock value, so no new sweep.
        let (txid, mined, raw) = w
            .our_live_spend(joint.clone(), 100_000_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (txid.as_str(), mined, raw.as_slice()),
            ("03", false, &[0xbe, 0xef][..])
        );
        assert_eq!(
            w.largest_unspent_ironwood(joint.clone()).await.unwrap(),
            Some((20_000, Some(105)))
        );
        // A spend of only the dust is not a sweep of the lock note.
        assert!(w
            .our_live_spend(joint.clone(), 100_000_001)
            .await
            .unwrap()
            .is_none());

        // After expiry: the stored sweep no longer counts, and the lock note is unspent again.
        rusqlite::Connection::open(dir.join("data.sqlite"))
            .unwrap()
            .execute("INSERT INTO blocks VALUES (150)", [])
            .unwrap();
        assert!(w
            .our_live_spend(joint.clone(), 100_000_000)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            w.largest_unspent_ironwood(joint.clone()).await.unwrap(),
            Some((100_000_000, Some(100)))
        );
        assert_eq!(
            w.unspent_ironwood(joint.clone()).await.unwrap(),
            100_020_000
        );

        // Once mined, it counts for good.
        rusqlite::Connection::open(dir.join("data.sqlite"))
            .unwrap()
            .execute(
                "UPDATE transactions SET mined_height = 149 WHERE id_tx = 3",
                [],
            )
            .unwrap();
        let (_, mined, _) = w
            .our_live_spend(joint.clone(), 100_000_000)
            .await
            .unwrap()
            .unwrap();
        assert!(mined);
        assert_eq!(
            w.largest_unspent_ironwood(joint).await.unwrap(),
            Some((20_000, Some(105)))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn exec(dir: &Path, sql: &str) {
        rusqlite::Connection::open(dir.join("data.sqlite"))
            .unwrap()
            .execute_batch(sql)
            .unwrap();
    }

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ferry-zec-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An expired spend neither marks the lock note spent nor shadows the spend that is mined
    /// later, and a note whose own transaction expired unmined does not exist.
    #[tokio::test]
    async fn watch_reports_only_live_spends_and_notes() {
        let dir = test_dir("watch");
        let w = fake_wallet(&dir);
        let joint = "00000000-0000-0000-0000-000000000001".to_string();
        let spent = |rows: &[NoteRow]| {
            rows.iter()
                .map(|r| (r.0.clone(), r.3.clone()))
                .collect::<Vec<_>>()
        };
        // A note from a stored lock that never got mined and expires after height 140.
        exec(
            &dir,
            "INSERT INTO transactions VALUES (5, x'05', '2026-10-17', NULL, 140, x'aa');
             INSERT INTO ironwood_received_notes VALUES (3, 5, 1, 100000000, 0);",
        );
        let rows = w.joint_notes(joint.clone()).await.unwrap();
        assert_eq!(
            spent(&rows),
            vec![(vec![1], Some(vec![3])), (vec![2], None), (vec![5], None)]
        );

        // Both stored transactions expire: the lock note is unspent, the phantom note gone.
        exec(&dir, "INSERT INTO blocks VALUES (150);");
        let rows = w.joint_notes(joint.clone()).await.unwrap();
        assert_eq!(spent(&rows), vec![(vec![1], None), (vec![2], None)]);

        // A second sweep confirms: it is the spend, not the expired first attempt.
        exec(
            &dir,
            "INSERT INTO transactions VALUES (4, x'04', '2026-10-17', 151, 190, x'bb');
             INSERT INTO ironwood_received_note_spends VALUES (1, 4);
             INSERT INTO blocks VALUES (151);",
        );
        let rows = w.joint_notes(joint).await.unwrap();
        assert_eq!(
            spent(&rows),
            vec![(vec![1], Some(vec![4])), (vec![2], None)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A lock lapses only once nothing can land: no live note worth the amount at the joint
    /// address and no unmined, unexpired transaction of ours still in flight.
    #[tokio::test]
    async fn lock_lapses_only_when_nothing_can_land() {
        let dir = test_dir("lapse");
        let w = fake_wallet(&dir);
        let joint = "00000000-0000-0000-0000-000000000001".to_string();
        let amount = 200_000_000;
        // The existing 1 ZEC note is too small to be this lock.
        assert!(w.lock_lapsed_in(joint.clone(), amount).await.unwrap());
        assert!(!w.lock_lapsed_in(joint.clone(), 100_000_000).await.unwrap());

        // Our own account's note, spent by our lock: stored, unmined, expires after 160.
        exec(
            &dir,
            "INSERT INTO accounts VALUES (2, x'00000000000000000000000000000002', 'ferry', 1);
             INSERT INTO transactions VALUES (10, x'0a', NULL, 90, NULL, NULL);
             INSERT INTO ironwood_received_notes VALUES (10, 10, 2, 500000000, 0);
             INSERT INTO transactions VALUES (11, x'0b', '2026-10-17', NULL, 160, x'cc');
             INSERT INTO ironwood_received_note_spends VALUES (10, 11);",
        );
        assert!(
            !w.lock_lapsed_in(joint.clone(), amount).await.unwrap(),
            "a lock in flight may still land"
        );
        exec(&dir, "INSERT INTO blocks VALUES (160);");
        assert!(w.lock_lapsed_in(joint.clone(), amount).await.unwrap());

        // A note worth the amount, even unmined, means it did not lapse.
        exec(
            &dir,
            "INSERT INTO transactions VALUES (12, x'0c', NULL, NULL, 200, NULL);
             INSERT INTO ironwood_received_notes VALUES (12, 12, 1, 200000000, 0);",
        );
        assert!(!w.lock_lapsed_in(joint, amount).await.unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebroadcast_accepts_only_a_transaction_the_node_already_has() {
        let zebra = |msg: &str| json!({"code": -26, "message": msg}).to_string();
        for known in [
            zebra("transaction already exists in mempool"),
            zebra("transaction dropped because it is already queued for download"),
            zebra("transaction is already in state"),
            zebra("the transaction will be rejected from the mempool until the next chain tip block: transaction was committed to the best chain"),
            json!({"code": -27, "message": "transaction already in block chain"}).to_string(),
            json!({"code": -26, "message": "txn-already-in-mempool"}).to_string(),
        ] {
            assert!(node_has_tx(&known), "{known}");
        }
        for rejected in [
            zebra("transaction rejected because another transaction in the mempool has already spent some of its inputs"),
            zebra("the transaction will be rejected from the mempool until a chain reset: transaction inputs were spent, or nullifiers were revealed, in the best chain"),
            zebra("best chain tip has reached transaction expiry height"),
            zebra("unknown transaction"),
            json!({"code": -25, "message": "duplicate nullifier"}).to_string(),
            "error sending request: operation timed out".to_string(),
        ] {
            assert!(!node_has_tx(&rejected), "{rejected}");
        }
    }

    #[test]
    fn spends_parsing() {
        assert_eq!(
            parse_spends("ironwood=500000000,0 orchard="),
            Some(vec![500_000_000, 0])
        );
        assert_eq!(parse_spends("ironwood= orchard="), Some(vec![]));
        assert_eq!(parse_spends("orchard=1"), None);
        assert_eq!(parse_spends("ironwood=x orchard="), None);
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

        // A chatty child (more than a pipe buffer of output) must finish, not time out.
        let mut chatty = std::process::Command::new("sh");
        chatty.args(["-c", "head -c 300000 /dev/zero; echo done >&2"]);
        let out = run_blocking_limited(&mut chatty, "chatty", Duration::from_secs(20)).unwrap();
        assert_eq!(out.stdout.len(), 300_000);
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "done");

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
