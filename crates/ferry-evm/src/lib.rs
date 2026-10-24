//! EVM leg of Ferry: shielded ZEC <-> an ERC-20 (USDC) locked in the `FerryLock` contract
//! (`contracts/src/FerryLock.sol`).
//!
//! - [`address`]: the Ethereum address of a secp256k1 point or share, exactly as the contract's
//!   `scalarAddress` computes it (the lock commits to `address(Z_s)` and `address(B_s)`).
//! - [`EvmClient`]: lock / ready / claim / refund / punish. Every claim and refund is simulated
//!   first and never broadcast if it would revert: a reverted transaction still publishes its
//!   scalar in calldata.
//! - [`SwapWatcher`] and [`SwapEvent`]: the contract's events for one swap, and the revealed
//!   share from a claim (`z`) or refund (`b`), checked against the committed address.
//! - [`revealed_in_calldata`]: the same share read from a transaction's input, for a claim or
//!   refund seen before (or without) its event.

pub mod address;
mod client;
mod events;

pub use address::{point_address, point_address_sec1, scalar_address, verify_share};
pub use client::{EvmClient, OnChainSwap, SwapState, TxInfo};
pub use events::{revealed_in_calldata, Revealed, SwapEvent, SwapEventKind, SwapWatcher};

pub use alloy::primitives::{Address, B256, U256};

/// Contract bindings, generated from the artifacts `contracts/export-artifacts.sh` writes.
#[allow(clippy::too_many_arguments)] // the generated `Locked` event constructor
pub mod bindings {
    alloy::sol!(
        #[sol(rpc)]
        #[derive(Debug, PartialEq, Eq)]
        FerryLock,
        "artifacts/FerryLock.json"
    );

    alloy::sol!(
        #[sol(rpc)]
        MockUSDC,
        "artifacts/MockUSDC.json"
    );

    alloy::sol! {
        #[sol(rpc)]
        interface IERC20 {
            function allowance(address owner, address spender) external view returns (uint256);
            function approve(address spender, uint256 amount) external returns (bool);
            function balanceOf(address who) external view returns (uint256);
        }
    }
}

/// The terms a lock is made under (`FerryLock.Terms`).
pub type Terms = bindings::FerryLock::Terms;

/// The id the contract gives a lock by `locker` with `salt`: `keccak256(abi.encode(locker,
/// salt))`.
pub fn swap_id(locker: Address, salt: B256) -> B256 {
    use alloy::sol_types::SolValue;
    alloy::primitives::keccak256((locker, salt).abi_encode())
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("RPC: {0}")]
    Rpc(String),
    #[error("contract: {0}")]
    Contract(#[from] alloy::contract::Error),
    /// The simulation reverted, so nothing was broadcast.
    #[error("would revert, not sent: {0}")]
    WouldRevert(String),
    #[error("transaction {0} reverted")]
    Reverted(B256),
    #[error("on-chain lock differs from the agreed terms: {0}")]
    TermsMismatch(&'static str),
    #[error("swap is {0:?}, expected {1}")]
    WrongState(SwapState, &'static str),
    #[error("scalar does not match the committed address")]
    ScalarMismatch,
    #[error("invalid secp256k1 point")]
    BadPoint,
    #[error("bad RPC URL: {0}")]
    Url(String),
}

impl From<alloy::transports::TransportError> for Error {
    fn from(e: alloy::transports::TransportError) -> Self {
        Error::Rpc(e.to_string())
    }
}

impl From<alloy::providers::PendingTransactionError> for Error {
    fn from(e: alloy::providers::PendingTransactionError) -> Self {
        Error::Rpc(e.to_string())
    }
}
