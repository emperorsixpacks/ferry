//! What the daemon's Zcash wallet integration must provide. Implemented in `ferry-zec`.
//!
//! Wallet location, lightwalletd/Zaino endpoint and similar configuration belong to the
//! implementing type's constructor, not to this trait.

use std::future::Future;

/// A note received by the joint address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZecNote {
    /// Transaction that created the note.
    pub txid: String,
    /// zatoshi
    pub value: u64,
    pub confirmations: u32,
    /// Transaction that spent the note, if the viewing key has seen its nullifier.
    pub spent_by: Option<String>,
}

/// Our own wallet and chain, for status displays.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZecStatus {
    /// e.g. "regtest", "test", "main"
    pub network: String,
    pub height: u64,
    /// Spendable Ironwood balance of our own wallet (zatoshi).
    pub shielded_balance: u64,
}

/// How a failed [`ZecLeg::send`] left things.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendFailure {
    /// The transaction may have reached the network: never send again; wait for the note.
    MaybeSent,
    /// Failed before anything was broadcast (sync, note selection, building, proving,
    /// signing); sending again is safe.
    NotSent,
    /// Refused before anything was broadcast, and retrying cannot help (for example, too few
    /// Ironwood notes to fund it shielded-only).
    Refused,
}

/// Zcash (Ironwood) operations, keyed by the joint full viewing key from
/// [`crate::joint::joint_fvk_bytes`] (`ak || nk || rivk`, Orchard encoding).
pub trait ZecLeg: Send + Sync {
    type Error: std::error::Error + Send + Sync + 'static;

    fn status(&self) -> impl Future<Output = Result<ZecStatus, Self::Error>> + Send;

    /// Encoded single-use unified address of the joint viewing key.
    fn joint_address(&self, fvk: &[u8; 96]) -> Result<String, Self::Error>;

    /// Send `amount` zatoshi to the joint address, funded from shielded notes only.
    /// Returns the txid.
    fn send(
        &self,
        fvk: &[u8; 96],
        amount: u64,
    ) -> impl Future<Output = Result<String, Self::Error>> + Send;

    /// What an error returned by [`ZecLeg::send`] says about the network. Only report
    /// [`SendFailure::NotSent`] or [`SendFailure::Refused`] when nothing can have been
    /// broadcast; the default assumes the worst.
    fn send_failure(&self, _err: &Self::Error) -> SendFailure {
        SendFailure::MaybeSent
    }

    /// Zatoshi the wallet needs on top of the amount to fund a lock (fees): [`ZecLeg::send`]
    /// refuses with less, so a party checks it before anything is locked.
    fn send_fee_reserve(&self) -> u64 {
        0
    }

    /// Whether a lock of ours to the joint address provably never landed and never will: no
    /// note worth at least `amount` there (from a mined or unexpired transaction), and no
    /// transaction we built that could still create one. Only answer true when that is
    /// certain; the default never concludes it.
    fn lock_lapsed(
        &self,
        _fvk: &[u8; 96],
        _amount: u64,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async { Ok(false) }
    }

    /// Notes received by the joint address, found by scanning with the joint viewing key.
    /// Notes of a transaction that expired unmined are not listed, and `spent_by` only names a
    /// spend that is mined or not yet expired (a mined one first).
    fn watch(
        &self,
        fvk: &[u8; 96],
    ) -> impl Future<Output = Result<Vec<ZecNote>, Self::Error>> + Send;

    /// Spend the joint address's notes to our own wallet, or to `to` when given (an address
    /// [`ZecLeg::check_address`] accepted), authorizing with `ask` (RedPallas, `rsk = ask + α`).
    /// The sweep must include the lock note, a note worth at least `lock_value`; one that would
    /// leave it behind is refused. Retrying after an error returns the sweep already built if it
    /// may still confirm, rather than building another. Returns the txid.
    fn sweep(
        &self,
        fvk: &[u8; 96],
        ask: &[u8; 32],
        lock_value: u64,
        to: Option<&str>,
    ) -> impl Future<Output = Result<String, Self::Error>> + Send;

    /// Whether a sweep may pay `address`: a shielded address of our network that a sweep can
    /// pay (a unified address with an Orchard receiver, which Ironwood shares). `Err` says why
    /// not, or that the check itself failed. The default refuses every address: a backend that
    /// cannot check one never sweeps to one.
    fn check_address(&self, _address: &str) -> impl Future<Output = Result<(), String>> + Send {
        async { Err("this Zcash backend cannot check addresses".to_string()) }
    }

    /// Confirmations of a transaction (`Some(0)` while in the mempool, `None` if unknown).
    fn confirmations(
        &self,
        txid: &str,
    ) -> impl Future<Output = Result<Option<u32>, Self::Error>> + Send;

    /// Our own wallet's receiving address, where the ZEC to swap must be sent (shown to the
    /// operator for funding). None if the backend has no such address.
    fn receive_address(&self) -> Option<String> {
        None
    }

    /// One line on what a public chain observer sees of `txid` (for the demo UI).
    fn describe_tx(
        &self,
        _txid: &str,
    ) -> impl Future<Output = Result<Option<String>, Self::Error>> + Send {
        async { Ok(None) }
    }
}
