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

    /// Whether `err`, returned by [`ZecLeg::send`], means the send was refused before anything
    /// was broadcast and retrying cannot help (for example, too few Ironwood notes to fund it
    /// shielded-only). Any other send error may have reached the network.
    fn send_refused(&self, _err: &Self::Error) -> bool {
        false
    }

    /// Notes received by the joint address, found by scanning with the joint viewing key.
    fn watch(
        &self,
        fvk: &[u8; 96],
    ) -> impl Future<Output = Result<Vec<ZecNote>, Self::Error>> + Send;

    /// Spend every note of the joint address to our own wallet, authorizing with `ask`
    /// (RedPallas, `rsk = ask + α`). Returns the txid.
    fn sweep(
        &self,
        fvk: &[u8; 96],
        ask: &[u8; 32],
    ) -> impl Future<Output = Result<String, Self::Error>> + Send;

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
