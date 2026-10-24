//! What the daemon's Zcash wallet integration must provide. Implemented in `ferry-zec`.

use std::future::Future;

/// A note received by the joint address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZecNote {
    /// zatoshi
    pub value: u64,
    pub confirmations: u32,
}

/// Zcash (Ironwood) operations, keyed by the joint full viewing key from
/// [`crate::joint::joint_fvk_bytes`] (`ak || nk || rivk`, Orchard encoding).
pub trait ZecLeg {
    type Error: std::error::Error + Send + Sync + 'static;

    /// Encoded single-use unified address of the joint viewing key.
    fn joint_address(&self, fvk: &[u8; 96]) -> Result<String, Self::Error>;

    /// Send `amount` zatoshi to the joint address, funded from shielded notes only.
    /// Returns the txid.
    fn send(
        &self,
        fvk: &[u8; 96],
        amount: u64,
    ) -> impl Future<Output = Result<String, Self::Error>> + Send;

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

    /// Confirmations of a transaction sent by [`ZecLeg::send`] or [`ZecLeg::sweep`]
    /// (`Some(0)` while in the mempool, `None` if unknown).
    fn confirmations(
        &self,
        txid: &str,
    ) -> impl Future<Output = Result<Option<u32>, Self::Error>> + Send;
}
