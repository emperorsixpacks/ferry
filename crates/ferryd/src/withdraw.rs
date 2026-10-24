//! "Send to my wallet": `POST /api/withdraw` and `GET /api/withdrawals` (docs/API.md,
//! "Withdraw"). The node's owner takes coins out of the wallets this ferryd holds: shielded ZEC
//! on every daemon, the counter coin (BTC/LTC, or the EVM token and the chain's gas coin).
//!
//! The rules, the same on both daemon types:
//! - **Only free funds.** What a live swap still needs is held: Z's ZEC lock (amount plus fee
//!   reserve) until it is sent, B's BTC/token lock until it is out, and on EVM the gas of the
//!   swap actions still to come. A withdrawal that would eat into that is refused and the error
//!   says how much is free. Withdrawals and swap starts exclude each other (crate::route::Starts),
//!   so the funds checked are the funds spent.
//! - **Shielded ZEC only.** A transparent (or Sapling, or Sprout) destination is refused before
//!   the wallet is asked; the wallet builds Ironwood in, Ironwood out, and refuses anything else.
//! - **Recorded before broadcast, never sent twice.** Every withdrawal is built and signed first,
//!   so its txid is fixed; the record (with the signed transaction for BTC/EVM) is saved durably
//!   before anything is broadcast. After a crash the same transaction is followed, and sent again
//!   as is if needed, which can never pay twice; it is marked failed only once it provably can
//!   never confirm (its inputs or nonce were used by another transaction, it expired unmined, or
//!   the Zcash wallet never stored it, which means it was never broadcast).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;

use ferry_btc::bitcoin::{consensus::encode::serialize_hex, Amount, Transaction, Txid};
use ferry_btc::rpc::{BitcoinRpc, RpcError};
use ferry_btc::Chain;
use ferry_core::{SendFailure, ZecLeg, ZecTxState};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::daemon::{ApiError, SseEvent};
use crate::record::{private_dir, write_private};

/// In `GET /api/status` `features`: this ferryd has `POST /api/withdraw`.
pub const WITHDRAW_FEATURE: &str = "withdraw";

/// The refusal of a transparent ZEC destination.
pub const SHIELDED_ONLY: &str = "Ferry only sends shielded ZEC; use a shielded address";

/// Fee rate (sat/vB) used when the node has no estimate (regtest, a fresh node): never below the
/// node's own minimum.
const BTC_FALLBACK_FEE_RATE: u64 = 2;
const LTC_FALLBACK_FEE_RATE: u64 = 10;
/// A withdrawal never pays more than this per vbyte, whatever the estimator says.
pub const MAX_FEE_RATE: u64 = 500;
/// Blocks the fee estimate aims for.
const FEE_TARGET_BLOCKS: u16 = 6;
/// Confirmations after which a withdrawal is no longer followed.
const FOLLOW_CONFS: u32 = 6;
/// A pending transaction is handed to the node again this often.
const REBROADCAST_MS: u64 = 60_000;
/// Follow-ups run at most this often.
const FOLLOW_EVERY_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Asset {
    /// Shielded ZEC.
    Zec,
    /// The counter coin of a Bitcoin or Litecoin daemon.
    Btc,
    /// The ERC-20 of an EVM daemon.
    Token,
    /// The gas coin of an EVM daemon's chain.
    Eth,
}

impl Asset {
    pub fn as_str(self) -> &'static str {
        match self {
            Asset::Zec => "zec",
            Asset::Btc => "btc",
            Asset::Token => "token",
            Asset::Eth => "eth",
        }
    }

    /// `name` among the assets this daemon has (`aliases`: other names it takes, such as "ltc"
    /// for "btc" on a Litecoin daemon).
    pub fn parse(name: &str, have: &[Asset], aliases: &[(&str, Asset)]) -> Result<Asset, ApiError> {
        let name = name.trim().to_ascii_lowercase();
        let found = have
            .iter()
            .copied()
            .find(|a| a.as_str() == name)
            .or_else(|| aliases.iter().find(|(n, _)| *n == name).map(|(_, a)| *a));
        found.ok_or_else(|| {
            let list: Vec<String> = have.iter().map(|a| format!("\"{}\"", a.as_str())).collect();
            ApiError(
                400,
                format!("asset must be one of {} on this daemon", list.join(", ")),
            )
        })
    }
}

/// `POST /api/withdraw`.
#[derive(Debug, Deserialize)]
pub struct WithdrawRequest {
    pub asset: String,
    /// Base units (zatoshi, satoshi or litoshi, token base units, wei), as a JSON integer or a
    /// string of digits.
    pub amount: Value,
    pub to: String,
}

/// A whole, positive number of base units, given as a JSON integer or a string of digits.
pub fn parse_amount(v: &Value) -> Result<u128, String> {
    let bad = || {
        "amount must be a whole number of base units (zatoshi, satoshi, token units or wei), \
         as a number or a string of digits"
            .to_string()
    };
    let n = match v {
        Value::Number(n) => u128::from(n.as_u64().ok_or_else(bad)?),
        Value::String(s) => {
            if s.is_empty() || s.len() > 39 || !s.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad());
            }
            s.parse().map_err(|_| bad())?
        }
        _ => return Err(bad()),
    };
    if n == 0 {
        return Err("amount must be more than 0".into());
    }
    Ok(n)
}

/// `amount` base units of a `decimals`-place coin, e.g. "0.5 ZEC", "12.25 USDC".
pub fn show(amount: u128, decimals: u8, symbol: &str) -> String {
    let Some(scale) = 10u128.checked_pow(u32::from(decimals)) else {
        return format!("{amount} base units of {symbol}");
    };
    let (whole, frac) = (amount / scale, amount % scale);
    if frac == 0 {
        return format!("{whole} {symbol}");
    }
    let frac = format!("{frac:0width$}", width = usize::from(decimals));
    format!("{whole}.{} {symbol}", frac.trim_end_matches('0'))
}

// ---------------------------------------------------------------------- free balance

/// Funds a live swap still needs, in the asset's base units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hold {
    pub units: u128,
    /// What holds it, e.g. "swap 1a2b3c4d's ZEC lock".
    pub why: String,
}

pub fn held(holds: &[Hold]) -> u128 {
    holds.iter().map(|h| h.units).fold(0, u128::saturating_add)
}

/// What a withdrawal may take: the balance less what live swaps hold.
pub fn free(have: u128, holds: &[Hold]) -> u128 {
    have.saturating_sub(held(holds))
}

/// `need` (what the withdrawal takes, described by `what`) must fit in what is free. The
/// refusal says how much is free, and why less than the balance.
pub fn check_free(
    have: u128,
    holds: &[Hold],
    need: u128,
    what: &str,
    fmt: impl Fn(u128) -> String,
) -> Result<(), ApiError> {
    let free = free(have, holds);
    if need <= free {
        return Ok(());
    }
    let msg = if holds.is_empty() {
        format!(
            "Not enough in the wallet: {} is free to withdraw, and this needs {what}",
            fmt(free)
        )
    } else {
        let whys: Vec<&str> = holds.iter().map(|h| h.why.as_str()).collect();
        format!(
            "Only {} is free to withdraw: {} is in the wallet and {} is held for a swap in \
             progress ({}). This needs {what}",
            fmt(free),
            fmt(have),
            fmt(held(holds)),
            whys.join(", ")
        )
    };
    Err(ApiError(400, msg))
}

/// The hold a Z swap of ours puts on our shielded ZEC: its lock (and the wallet's fee reserve)
/// until the lock is sent. Once sent, the ZEC has left the spendable balance.
pub fn zec_lock_hold(
    id: &str,
    is_z: bool,
    finished: bool,
    lock_sent: bool,
    zec_amount: u64,
    fee_reserve: u64,
) -> Option<Hold> {
    (is_z && !finished && !lock_sent).then(|| Hold {
        units: u128::from(zec_amount) + u128::from(fee_reserve),
        why: format!("swap {}'s ZEC lock", short_id(id)),
    })
}

pub fn short_id(id: &str) -> &str {
    &id[..id.len().min(8)]
}

// ---------------------------------------------------------------------- ZEC destinations

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZecAddressKind {
    /// t1…/t3… (mainnet), tm…/t2… (testnet, regtest), tex… (ZIP 320).
    Transparent,
    Sapling,
    Sprout,
    /// Unified, or not a Zcash address at all: the wallet decides.
    Other,
}

pub fn zec_address_kind(a: &str) -> ZecAddressKind {
    let lower = a.to_ascii_lowercase();
    let base58_t = ["t1", "t3", "tm", "t2"].iter().any(|p| a.starts_with(p))
        && a.len() == 35
        && a.bytes().all(|b| b.is_ascii_alphanumeric());
    if base58_t || lower.starts_with("tex1") || lower.starts_with("textest1") {
        ZecAddressKind::Transparent
    } else if ["zs1", "ztestsapling1", "zregtestsapling1"]
        .iter()
        .any(|p| lower.starts_with(p))
    {
        ZecAddressKind::Sapling
    } else if (a.starts_with("zc") || a.starts_with("zt")) && a.len() == 95 {
        ZecAddressKind::Sprout
    } else {
        ZecAddressKind::Other
    }
}

/// Whether Ferry may send shielded ZEC to `to` (a withdrawal, or a swap's `sweep_to`): never a
/// transparent, Sapling or Sprout address; otherwise what the Zcash backend says (a unified
/// address of our network with an Orchard receiver, which Ironwood notes go to).
pub async fn check_zec_destination<L: ZecLeg>(leg: &L, to: &str) -> Result<(), String> {
    match zec_address_kind(to) {
        ZecAddressKind::Transparent => return Err(SHIELDED_ONLY.into()),
        ZecAddressKind::Sapling => {
            return Err(
                "Ferry sends ZEC as Ironwood notes, which a Sapling address can't receive; \
                 use a unified address with an Orchard receiver"
                    .into(),
            )
        }
        ZecAddressKind::Sprout => return Err("Sprout addresses are not supported".into()),
        ZecAddressKind::Other => {}
    }
    if to.is_empty() || to.len() > 512 || !to.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("not a Zcash address".into());
    }
    leg.check_address(to).await
}

/// `zec` in `GET /api/addresses`: our own shielded address and network. The address is null
/// when the backend has none, and never a transparent one.
pub async fn zec_address_view<L: ZecLeg>(leg: &L) -> Value {
    let address = leg
        .receive_address()
        .filter(|a| zec_address_kind(a) != ZecAddressKind::Transparent);
    let network = leg.status().await.ok().map(|s| s.network);
    serde_json::json!({ "address": address, "network": network })
}

// ---------------------------------------------------------------------- records

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Recorded, signed, and not yet known to be out (a crash, or a node that did not answer).
    Sending,
    /// Broadcast; not yet confirmed.
    Pending,
    Confirmed,
    /// It never paid and never will (`error` says why).
    Failed,
}

/// One withdrawal, as kept on disk (`<data-dir>/withdrawals/<id>.json`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Withdrawal {
    pub id: String,
    pub asset: Asset,
    /// What moves: "zec", "btc" or "ltc", the token's symbol in lowercase, or "eth".
    pub coin: String,
    /// Base units, as a decimal string.
    pub amount: String,
    /// The destination, as the chain writes it.
    pub to: String,
    /// What the transaction pays in fees, in base units of `fee_coin` (EVM: the most its gas can
    /// cost until it is mined, then what it cost).
    pub fee: String,
    pub fee_coin: String,
    pub txid: String,
    pub status: Status,
    pub confirmations: u32,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub created_ms: u64,
    /// The signed transaction (BTC/LTC, EVM), hex: sent again as is until it confirms or can't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// EVM: its nonce.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<u64>,
    /// Unix ms of the last broadcast.
    #[serde(default)]
    pub sent_ms: u64,
}

/// What the API shows of a withdrawal.
#[derive(Clone, Debug, Serialize)]
pub struct WithdrawalView {
    pub id: String,
    pub asset: Asset,
    pub coin: String,
    pub amount: String,
    pub to: String,
    pub fee: String,
    pub fee_coin: String,
    pub txid: String,
    pub status: Status,
    pub confirmations: u32,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_rfc3339() -> String {
    humantime::format_rfc3339_seconds(std::time::SystemTime::now()).to_string()
}

impl Withdrawal {
    /// A new record of a built and signed transaction, about to be broadcast.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        asset: Asset,
        coin: &str,
        amount: u128,
        to: &str,
        fee: u128,
        fee_coin: &str,
        txid: String,
        raw: Option<String>,
    ) -> Withdrawal {
        let mut b = [0u8; 16];
        OsRng.fill_bytes(&mut b);
        let now = now_rfc3339();
        Withdrawal {
            id: hex::encode(b),
            asset,
            coin: coin.into(),
            amount: amount.to_string(),
            to: to.into(),
            fee: fee.to_string(),
            fee_coin: fee_coin.into(),
            txid,
            status: Status::Sending,
            confirmations: 0,
            error: None,
            created_at: now.clone(),
            updated_at: now,
            created_ms: now_ms(),
            raw,
            nonce: None,
            sent_ms: 0,
        }
    }

    pub fn view(&self) -> WithdrawalView {
        WithdrawalView {
            id: self.id.clone(),
            asset: self.asset,
            coin: self.coin.clone(),
            amount: self.amount.clone(),
            to: self.to.clone(),
            fee: self.fee.clone(),
            fee_coin: self.fee_coin.clone(),
            txid: self.txid.clone(),
            status: self.status,
            confirmations: self.confirmations,
            error: self.error.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    /// Set the status (and the reason, for a failure); true if anything changed.
    pub fn set(&mut self, status: Status, confirmations: u32, error: Option<String>) -> bool {
        if (self.status, self.confirmations, &self.error) == (status, confirmations, &error) {
            return false;
        }
        self.status = status;
        self.confirmations = confirmations;
        self.error = error;
        self.updated_at = now_rfc3339();
        true
    }

    /// Still to be followed: not failed, and not yet buried.
    pub fn open(&self) -> bool {
        match self.status {
            Status::Sending | Status::Pending => true,
            Status::Confirmed => self.confirmations < FOLLOW_CONFS,
            Status::Failed => false,
        }
    }
}

/// One JSON file per withdrawal under `<data-dir>/withdrawals`, written atomically (0600).
pub struct WithdrawStore {
    dir: PathBuf,
}

impl WithdrawStore {
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        private_dir(data_dir)?;
        let dir = data_dir.join("withdrawals");
        private_dir(&dir)?;
        Ok(WithdrawStore { dir })
    }

    /// Durable once it returns Ok: written, fsynced, renamed into place, directory fsynced.
    pub fn save(&self, w: &Withdrawal) -> std::io::Result<()> {
        let tmp = self.dir.join(format!(".{}.json.tmp", w.id));
        write_private(&tmp, &serde_json::to_vec_pretty(w)?)?;
        std::fs::rename(tmp, self.dir.join(format!("{}.json", w.id)))?;
        std::fs::File::open(&self.dir)?.sync_all()
    }

    pub fn load_all(&self) -> std::io::Result<Vec<Withdrawal>> {
        let mut out = vec![];
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if path.extension().is_some_and(|e| e == "json") && !name.starts_with('.') {
                let w: Withdrawal = serde_json::from_slice(&std::fs::read(&path)?)
                    .map_err(|e| std::io::Error::other(format!("{}: {e}", path.display())))?;
                out.push(w);
            }
        }
        Ok(out)
    }
}

/// Demo fault (`--demo-faults`): the process exits at this point of the next withdrawal, to show
/// that a restart neither loses nor repeats it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Crash {
    /// The record is saved; nothing is broadcast yet.
    AfterSave,
    /// Broadcast; the result is not saved yet.
    AfterBroadcast,
}

/// A daemon's withdrawals: on disk, in memory, and announced as `event: withdrawal`.
pub struct Withdrawals {
    store: WithdrawStore,
    list: Mutex<BTreeMap<String, Withdrawal>>,
    events: broadcast::Sender<SseEvent>,
    crash: Mutex<Option<Crash>>,
    last_follow: Mutex<u64>,
    /// Held by a withdrawal request from start to end, and by each round of follow-ups: a
    /// round never sees a record whose request is still running (a `sending` ZEC withdrawal the
    /// wallet has not stored *yet* must not be concluded never sent).
    gate: tokio::sync::Mutex<()>,
}

impl Withdrawals {
    /// For a withdrawal request: waits for a round of follow-ups to end.
    pub async fn gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    /// For a round of follow-ups, if it is due and no request is running: the guard to hold
    /// for the round.
    pub fn round(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        let guard = self.gate.try_lock().ok()?;
        self.due().then_some(guard)
    }

    pub fn open(data_dir: &Path, events: broadcast::Sender<SseEvent>) -> std::io::Result<Self> {
        let store = WithdrawStore::open(data_dir)?;
        let list = store
            .load_all()?
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
        Ok(Withdrawals {
            store,
            list: Mutex::new(list),
            events,
            crash: Mutex::new(None),
            last_follow: Mutex::new(0),
            gate: tokio::sync::Mutex::new(()),
        })
    }

    /// Newest first.
    pub fn views(&self) -> Vec<WithdrawalView> {
        let list = self.list.lock().expect("not poisoned");
        let mut all: Vec<&Withdrawal> = list.values().collect();
        all.sort_by_key(|w| std::cmp::Reverse((w.created_ms, w.id.clone())));
        all.into_iter().map(Withdrawal::view).collect()
    }

    /// Persist `w` durably, then keep and announce it. False (logged) if it is not on disk.
    pub fn save(&self, w: &Withdrawal) -> bool {
        if let Err(e) = self.store.save(w) {
            tracing::error!(id = %w.id, "persisting withdrawal: {e}");
            return false;
        }
        self.list
            .lock()
            .expect("not poisoned")
            .insert(w.id.clone(), w.clone());
        let _ = self.events.send(SseEvent {
            event: "withdrawal",
            data: serde_json::to_string(&w.view()).expect("serializes"),
        });
        true
    }

    /// Whether a round of follow-ups is due (and if so, the round starts now).
    fn due(&self) -> bool {
        let mut last = self.last_follow.lock().expect("not poisoned");
        let now = now_ms();
        if now < *last + FOLLOW_EVERY_MS {
            return false;
        }
        *last = now;
        true
    }

    /// The withdrawals of `assets` still to follow.
    pub fn unsettled(&self, assets: &[Asset]) -> Vec<Withdrawal> {
        self.list
            .lock()
            .expect("not poisoned")
            .values()
            .filter(|w| w.open() && assets.contains(&w.asset))
            .cloned()
            .collect()
    }

    pub fn arm(&self, crash: Crash) {
        *self.crash.lock().expect("not poisoned") = Some(crash);
    }

    /// Demo fault: exit here if armed for this point.
    pub fn crash_point(&self, at: Crash) {
        let armed = self
            .crash
            .lock()
            .expect("not poisoned")
            .take_if(|c| *c == at);
        if armed.is_some() {
            tracing::warn!("demo fault: exiting at {at:?} of a withdrawal");
            std::process::exit(86);
        }
    }
}

/// `{"crash": "after_save" | "after_broadcast"}` (`POST /api/withdraw/fault`, demo only).
#[derive(Debug, Deserialize)]
pub struct FaultRequest {
    pub crash: Crash,
}

// ---------------------------------------------------------------------- ZEC

/// Withdraw `amount` zatoshi of shielded ZEC to `to` (already checked by
/// [`check_zec_destination`]), keeping what `holds` hold. Returns the saved record: `pending`
/// once broadcast, `sending` if the wallet could not say whether it went out.
pub async fn send_zec<L: ZecLeg>(
    ws: &Withdrawals,
    leg: &L,
    to: &str,
    amount: u64,
    holds: Vec<Hold>,
) -> Result<Withdrawal, ApiError> {
    let zec = |u: u128| show(u, 8, "ZEC");
    let have = leg
        .status()
        .await
        .map_err(|e| ApiError(503, format!("the Zcash wallet is unavailable: {e}")))?
        .shielded_balance;
    let fee_bound = leg.withdraw_fee_bound();
    check_free(
        u128::from(have),
        &holds,
        u128::from(amount) + u128::from(fee_bound),
        &format!(
            "{} plus up to {} in fees",
            zec(u128::from(amount)),
            zec(u128::from(fee_bound))
        ),
        zec,
    )?;
    let hold = held(&holds);
    let mut saved: Option<Withdrawal> = None;
    let mut refused: Option<ApiError> = None;
    let result = leg
        .withdraw(to, amount, |b| {
            // Notes are spent whole and change takes confirmations: what stays spendable must
            // still cover the holds, or a swap's lock would wait on our change.
            let left = u128::from(b.spendable.saturating_sub(b.spent));
            if left < hold {
                let msg = format!(
                    "That withdrawal would spend notes worth {}, leaving {} spendable until its \
                     change confirms, but a swap in progress needs {} for its ZEC lock. Withdraw \
                     less, or after the swap has locked its ZEC",
                    zec(u128::from(b.spent)),
                    zec(left),
                    zec(hold)
                );
                refused = Some(ApiError(409, msg.clone()));
                return Err(msg);
            }
            let w = Withdrawal::new(
                Asset::Zec,
                "zec",
                u128::from(amount),
                to,
                u128::from(b.fee),
                "zec",
                b.txid.clone(),
                None,
            );
            if !ws.save(&w) {
                refused = Some(ApiError(
                    500,
                    "could not save the withdrawal; nothing was sent".into(),
                ));
                return Err("could not save the withdrawal".into());
            }
            ws.crash_point(Crash::AfterSave);
            saved = Some(w);
            Ok(())
        })
        .await;
    match (result, saved) {
        (Ok(sent), Some(mut w)) => {
            ws.crash_point(Crash::AfterBroadcast);
            w.txid = sent.txid;
            w.set(Status::Pending, 0, None);
            w.sent_ms = now_ms();
            ws.save(&w);
            Ok(w)
        }
        (Ok(_), None) => Err(ApiError(500, "the wallet sent nothing it reported".into())),
        // Nothing was broadcast: before_broadcast never agreed.
        (Err(e), None) => Err(refused.unwrap_or_else(|| match leg.send_failure(&e) {
            SendFailure::Refused => ApiError(400, format!("The Zcash wallet refused: {e}")),
            _ => ApiError(409, format!("The Zcash wallet could not send it now: {e}")),
        })),
        (Err(e), Some(mut w)) => match leg.send_failure(&e) {
            SendFailure::MaybeSent => {
                // Recorded with its txid: the follow-up finds out (and never sends another).
                tracing::warn!(id = %w.id, txid = %w.txid, "zec withdrawal may have gone out: {e}");
                Ok(w)
            }
            _ => {
                w.set(
                    Status::Failed,
                    0,
                    Some(format!("the wallet did not send it: {e}")),
                );
                ws.save(&w);
                Err(ApiError(
                    409,
                    format!("The Zcash wallet could not send it: {e}"),
                ))
            }
        },
    }
}

/// What the wallet now says of each ZEC withdrawal still open.
pub async fn follow_zec<L: ZecLeg>(ws: &Withdrawals, leg: &L) {
    for mut w in ws.unsettled(&[Asset::Zec]) {
        let state = match leg.tx_state(&w.txid).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(id = %w.id, "zec withdrawal state: {e}");
                continue;
            }
        };
        let changed = match (w.status, state) {
            (_, ZecTxState::Mined { confirmations }) => {
                w.set(Status::Confirmed, confirmations, None)
            }
            (_, ZecTxState::Expired) => w.set(
                Status::Failed,
                0,
                Some("it expired without being mined, so it can never confirm; nothing was paid".into()),
            ),
            // devtool stores a transaction before broadcasting it: never stored, never sent.
            (Status::Sending, ZecTxState::Unknown) => w.set(
                Status::Failed,
                0,
                Some("interrupted before the wallet stored it, so it was never broadcast; nothing was sent".into()),
            ),
            (Status::Sending | Status::Confirmed, ZecTxState::Pending) => {
                w.set(Status::Pending, 0, None)
            }
            _ => false,
        };
        if changed {
            ws.save(&w);
        }
    }
}

// ---------------------------------------------------------------------- Bitcoin / Litecoin

/// Withdraw `amount` sat (litoshi) to `to`: an address of the daemon's chain only its owner can
/// spend, above its type's dust floor, at the node's fee estimate (capped at
/// [`MAX_FEE_RATE`]). `blocked`: a reason no withdrawal of this coin may go out now. The caller
/// holds the daemon's state, so no swap action spends from the wallet meanwhile.
pub async fn send_btc(
    ws: &Withdrawals,
    rpc: &BitcoinRpc,
    chain: Chain,
    to: &str,
    amount: u64,
    holds: Vec<Hold>,
    blocked: Option<String>,
) -> Result<Withdrawal, ApiError> {
    let ticker = chain.ticker();
    let coin = ticker.to_ascii_lowercase();
    let fmt = |u: u128| show(u, 8, ticker);
    let bad = |m: String| ApiError(400, format!("to: {m}"));
    let addr = chain.parse_address(to).map_err(|e| bad(e.to_string()))?;
    ferry_core::check_payout_type(&addr).map_err(|e| bad(e.to_string()))?;
    let dust = chain.coin.dust(&addr.script_pubkey()).to_sat();
    if amount < dust {
        return Err(ApiError(
            400,
            format!(
                "{} is below the dust floor for that address type; send at least {}",
                fmt(u128::from(amount)),
                fmt(u128::from(dust))
            ),
        ));
    }
    if let Some(why) = blocked {
        return Err(ApiError(409, why));
    }
    let unavailable = |e: RpcError| ApiError(503, format!("the {ticker} node is unavailable: {e}"));
    let fallback = if chain.coin.is_btc() {
        BTC_FALLBACK_FEE_RATE
    } else {
        LTC_FALLBACK_FEE_RATE
    };
    let estimate = rpc
        .estimate_fee_rate(FEE_TARGET_BLOCKS)
        .await
        .map_err(unavailable)?;
    let floor = rpc.min_fee_rate().await.map_err(unavailable)?;
    let rate = estimate.unwrap_or(fallback).max(floor);
    if rate > MAX_FEE_RATE {
        return Err(ApiError(
            409,
            format!(
                "The {ticker} node asks {rate} sat/vB in fees right now, above Ferry's cap of \
                 {MAX_FEE_RATE} sat/vB for a withdrawal; try again when fees are lower"
            ),
        ));
    }
    let have = u128::from(rpc.balance().await.map_err(unavailable)?.to_sat());
    check_free(
        have,
        &holds,
        u128::from(amount),
        &format!("{} plus the fee", fmt(u128::from(amount))),
        fmt,
    )?;
    let funded = rpc
        .fund_payment(&addr, Amount::from_sat(amount), rate)
        .await
        .map_err(|e| match e {
            // RPC_WALLET_INSUFFICIENT_FUNDS
            RpcError::Rpc { code: -4 | -6, .. } => ApiError(
                400,
                format!(
                    "Not enough {ticker} in the wallet for {} plus the fee ({rate} sat/vB)",
                    fmt(u128::from(amount))
                ),
            ),
            e => ApiError(503, format!("the {ticker} wallet could not build it: {e}")),
        })?;
    let fee = funded.fee.to_sat();
    if fee > amount {
        return Err(ApiError(
            400,
            format!(
                "The fee ({}) would be more than the amount; send more",
                fmt(u128::from(fee))
            ),
        ));
    }
    check_free(
        have,
        &holds,
        u128::from(amount) + u128::from(fee),
        &format!(
            "{} plus a {} fee",
            fmt(u128::from(amount)),
            fmt(u128::from(fee))
        ),
        fmt,
    )?;
    let mut w = Withdrawal::new(
        Asset::Btc,
        &coin,
        u128::from(amount),
        &chain.encode_address(&addr),
        u128::from(fee),
        &coin,
        funded.tx.compute_txid().to_string(),
        Some(serialize_hex(&funded.tx)),
    );
    if !ws.save(&w) {
        return Err(ApiError(
            500,
            "could not save the withdrawal; nothing was sent".into(),
        ));
    }
    ws.crash_point(Crash::AfterSave);
    w.sent_ms = now_ms();
    match rpc.broadcast(&funded.tx).await {
        Ok(_) => {
            ws.crash_point(Crash::AfterBroadcast);
            w.set(Status::Pending, 0, None);
            ws.save(&w);
            Ok(w)
        }
        // Our own node refused it, so it went nowhere (nobody else has it).
        Err(RpcError::Rpc { message, .. }) => {
            w.set(
                Status::Failed,
                0,
                Some(format!("the node refused it ({message}); nothing was sent")),
            );
            ws.save(&w);
            Err(ApiError(
                409,
                format!("The {ticker} node refused the withdrawal ({message}); nothing was sent"),
            ))
        }
        // No answer: it may be out. The follow-up sends the same transaction again.
        Err(e) => {
            tracing::warn!(id = %w.id, "withdrawal broadcast: {e}");
            ws.save(&w);
            Ok(w)
        }
    }
}

/// What the wallet now says of each BTC/LTC withdrawal still open; the same transaction is
/// handed to the node again while it is unconfirmed.
pub async fn follow_btc(ws: &Withdrawals, rpc: &BitcoinRpc) {
    for mut w in ws.unsettled(&[Asset::Btc]) {
        let Ok(txid) = Txid::from_str(&w.txid) else {
            continue;
        };
        let changed = match rpc.wallet_tx_confirmations(&txid).await {
            Ok(Some(c)) if c > 0 => w.set(Status::Confirmed, c as u32, None),
            Ok(Some(c)) if c < 0 => w.set(
                Status::Failed,
                0,
                Some(
                    "a conflicting transaction confirmed, so this one never will; nothing was paid"
                        .into(),
                ),
            ),
            Ok(found) => {
                // Unconfirmed, or unknown to the wallet (never accepted, or dropped): the same
                // transaction again, now and then.
                let due = found.is_none() || now_ms() >= w.sent_ms + REBROADCAST_MS;
                let mut changed = false;
                if due {
                    if let Some(tx) = w.raw.as_deref().and_then(decode_tx) {
                        w.sent_ms = now_ms();
                        match rpc.broadcast(&tx).await {
                            Ok(_) => changed |= w.set(Status::Pending, 0, None),
                            // Missing or spent inputs: another transaction took its coins.
                            Err(RpcError::Rpc {
                                code: -25, message, ..
                            }) if found.is_none() => {
                                changed |= w.set(
                                    Status::Failed,
                                    0,
                                    Some(format!(
                                        "its coins were spent by another transaction ({message}), so it can never confirm; nothing was paid"
                                    )),
                                );
                            }
                            Err(e) => tracing::info!(id = %w.id, "withdrawal rebroadcast: {e}"),
                        }
                    }
                }
                if found.is_some() {
                    changed |= w.set(Status::Pending, 0, None);
                }
                changed || due
            }
            Err(e) => {
                tracing::warn!(id = %w.id, "withdrawal state: {e}");
                false
            }
        };
        if changed {
            ws.save(&w);
        }
    }
}

fn decode_tx(hex_tx: &str) -> Option<Transaction> {
    ferry_btc::bitcoin::consensus::encode::deserialize_hex(hex_tx).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn amounts() {
        assert_eq!(parse_amount(&json!(150_000)), Ok(150_000));
        assert_eq!(parse_amount(&json!("150000")), Ok(150_000));
        // WETH in wei passes 2^64.
        assert_eq!(
            parse_amount(&json!("100000000000000000000")),
            Ok(100_000_000_000_000_000_000)
        );
        for bad in [
            json!(0),
            json!("0"),
            json!(-5),
            json!(1.5),
            json!("1.5"),
            json!("+5"),
            json!(" 5"),
            json!(""),
            json!("0x10"),
            json!(null),
            json!([1]),
            json!("9".repeat(40)),
        ] {
            assert!(parse_amount(&bad).is_err(), "{bad}");
        }
        assert_eq!(
            parse_amount(&json!(0)).unwrap_err(),
            "amount must be more than 0"
        );
        assert_eq!(show(150_000_000, 8, "ZEC"), "1.5 ZEC");
        assert_eq!(show(12_250_000, 6, "USDC"), "12.25 USDC");
        assert_eq!(show(546, 8, "BTC"), "0.00000546 BTC");
        assert_eq!(show(2, 0, "X"), "2 X");
    }

    #[test]
    fn assets() {
        let have = [Asset::Zec, Asset::Btc];
        assert_eq!(Asset::parse("ZEC", &have, &[]).unwrap(), Asset::Zec);
        assert_eq!(
            Asset::parse("ltc", &have, &[("ltc", Asset::Btc)]).unwrap(),
            Asset::Btc
        );
        let e = Asset::parse("token", &have, &[]).unwrap_err();
        assert_eq!(e.0, 400);
        assert_eq!(e.1, "asset must be one of \"zec\", \"btc\" on this daemon");
    }

    /// The free balance is the balance less what live swaps hold; a refusal says how much is
    /// free and what holds the rest.
    #[test]
    fn free_balance_rules() {
        let fmt = |u: u128| show(u, 8, "ZEC");
        let holds = vec![Hold {
            units: 100_050_000,
            why: "swap 1a2b3c4d's ZEC lock".into(),
        }];
        assert_eq!(free(500_000_000, &holds), 399_950_000);
        assert!(check_free(500_000_000, &holds, 399_950_000, "x", fmt).is_ok());
        let e = check_free(500_000_000, &holds, 399_950_001, "4 ZEC plus fees", fmt).unwrap_err();
        assert_eq!(e.0, 400);
        assert_eq!(
            e.1,
            "Only 3.9995 ZEC is free to withdraw: 5 ZEC is in the wallet and 1.0005 ZEC is held \
             for a swap in progress (swap 1a2b3c4d's ZEC lock). This needs 4 ZEC plus fees"
        );
        // Held more than the balance: nothing is free (no underflow).
        assert_eq!(free(1, &holds), 0);
        let e = check_free(10, &[], 11, "11 units", |u| u.to_string()).unwrap_err();
        assert_eq!(
            e.1,
            "Not enough in the wallet: 10 is free to withdraw, and this needs 11 units"
        );
        // Only a Z swap whose lock has not gone out holds ZEC.
        assert!(zec_lock_hold("ab", true, false, false, 100, 5).is_some_and(|h| h.units == 105));
        assert!(zec_lock_hold("ab", true, false, true, 100, 5).is_none());
        assert!(zec_lock_hold("ab", true, true, false, 100, 5).is_none());
        assert!(zec_lock_hold("ab", false, false, false, 100, 5).is_none());
    }

    #[test]
    fn zec_destinations() {
        use ZecAddressKind::*;
        for (a, kind) in [
            ("t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU", Transparent),
            ("t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd", Transparent),
            ("tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd", Transparent),
            ("t2UNzUUx8mWBCRYPRezvA363EYXyEpHokyi", Transparent),
            ("tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte", Transparent),
            (
                "textest1qyqszqgpqyqszqgpqyqszqgpqyqszqgp2xycrl",
                Transparent,
            ),
            (
                "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly",
                Sapling,
            ),
            ("uregtest1mockwallet7a6f65", Other),
            ("u1qqqq", Other),
            ("", Other),
        ] {
            assert_eq!(zec_address_kind(a), kind, "{a}");
        }
        assert_eq!(
            SHIELDED_ONLY,
            "Ferry only sends shielded ZEC; use a shielded address"
        );
    }

    /// A record survives the store; the API view leaves out the signed transaction; withdrawals
    /// list newest first; only unfinished ones are followed.
    #[test]
    fn records_and_views() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, _rx) = broadcast::channel(16);
        let ws = Withdrawals::open(tmp.path(), tx.clone()).unwrap();
        let mut a = Withdrawal::new(
            Asset::Btc,
            "btc",
            50_000,
            "bcrt1qxyz",
            141,
            "btc",
            "aa".repeat(32),
            Some("0200".into()),
        );
        a.created_ms = 1;
        let mut b = Withdrawal::new(
            Asset::Zec,
            "zec",
            7,
            "u1abc",
            10_000,
            "zec",
            "bb".repeat(32),
            None,
        );
        b.created_ms = 2;
        b.set(Status::Failed, 0, Some("no".into()));
        assert!(ws.save(&a) && ws.save(&b));
        let again = Withdrawals::open(tmp.path(), tx).unwrap();
        let views = again.views();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].asset, Asset::Zec, "newest first");
        let v = serde_json::to_value(&views[1]).unwrap();
        assert_eq!(v["status"], "sending");
        assert_eq!(v["amount"], "50000");
        assert_eq!(v["fee"], "141");
        assert!(v.get("raw").is_none() && v.get("nonce").is_none());
        let open = again.unsettled(&[Asset::Btc, Asset::Zec]);
        assert_eq!(open.len(), 1, "a failed withdrawal is not followed");
        assert_eq!(open[0].raw.as_deref(), Some("0200"));
        assert!(again.unsettled(&[Asset::Zec]).is_empty());
        assert!(again.due());
        assert!(!again.due(), "one round of follow-ups every two seconds");
        let mut c = a.clone();
        assert!(c.set(Status::Confirmed, 2, None));
        assert!(!c.set(Status::Confirmed, 2, None), "no change");
        assert!(c.open());
        c.set(Status::Confirmed, FOLLOW_CONFS, None);
        assert!(!c.open(), "buried");
    }
}
