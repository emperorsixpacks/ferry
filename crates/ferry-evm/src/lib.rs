//! EVM leg of Ferry: shielded ZEC <-> an ERC-20 (USDC, WETH) locked in the `FerryLock` contract
//! (`contracts/src/FerryLock.sol`).
//!
//! Always available (no I/O; ferry-core uses these):
//! - [`address`]: the Ethereum address of a secp256k1 point or share, exactly as the contract's
//!   `scalarAddress` computes it (the lock commits to `address(Z_s)` and `address(B_s)`).
//! - [`ready`]: the EIP-712 `Ready(id)` digest B signs to let Z claim, its signer under the
//!   contract's rules, and swap ids.
//!
//! With the `client` feature (default):
//! - [`EvmClient`]: lock / claim / refund / punish. Every claim and refund is simulated first
//!   and never broadcast if it would revert: a reverted transaction still publishes its scalar
//!   in calldata.
//! - [`SwapWatcher`], [`SwapEvent`]: the contract's events for one swap, and the revealed share
//!   from a claim (`z`) or refund (`b`), checked against the committed address.
//! - [`revealed_in_calldata`]: the same share read from a transaction's input.

pub mod address;
pub mod ready;

#[cfg(feature = "client")]
mod client;
#[cfg(feature = "client")]
mod events;

pub use address::{point_address, point_address_sec1, scalar_address, verify_share};
pub use ready::{ready_digest, ready_signer, swap_id};

#[cfg(feature = "client")]
pub use alloy::signers::local::PrivateKeySigner;
#[cfg(feature = "client")]
pub use client::{EvmClient, OnChainSwap, SwapState, TokenInfo, TxInfo, TxStatus};
#[cfg(feature = "client")]
pub use events::{revealed_in_calldata, Revealed, SwapEvent, SwapEventKind, SwapWatcher};
#[cfg(feature = "client")]
pub use ready::{sign_ready, sign_ready_digest};

pub use alloy::primitives::{Address, B256, U256};

/// Contract bindings, generated from the artifacts `contracts/export-artifacts.sh` writes.
#[cfg(feature = "client")]
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

    alloy::sol!(
        #[sol(rpc)]
        MockWETH,
        "artifacts/MockWETH.json"
    );

    alloy::sol! {
        #[sol(rpc)]
        interface IERC20 {
            function allowance(address owner, address spender) external view returns (uint256);
            function approve(address spender, uint256 amount) external returns (bool);
            function balanceOf(address who) external view returns (uint256);
            function symbol() external view returns (string);
            function decimals() external view returns (uint8);
        }
    }
}

/// The terms a lock is made under (`FerryLock.Terms`).
#[cfg(feature = "client")]
pub type Terms = bindings::FerryLock::Terms;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("RPC: {0}")]
    Rpc(String),
    #[cfg(feature = "client")]
    #[error("contract: {0}")]
    Contract(#[from] alloy::contract::Error),
    /// The simulation reverted, so nothing was broadcast.
    #[error("would revert, not sent: {0}")]
    WouldRevert(String),
    #[error("transaction {0} reverted")]
    Reverted(B256),
    #[error("on-chain lock differs from the agreed terms: {0}")]
    TermsMismatch(&'static str),
    #[cfg(feature = "client")]
    #[error("swap is {0:?}, expected {1}")]
    WrongState(SwapState, &'static str),
    #[error("scalar does not match the committed address")]
    ScalarMismatch,
    #[error("invalid secp256k1 point")]
    BadPoint,
    #[error("bad RPC URL: {0}")]
    Url(String),
    #[error("the code at the FerryLock address is not the FerryLock this build expects")]
    UnknownContract,
}

#[cfg(feature = "client")]
impl From<alloy::transports::TransportError> for Error {
    fn from(e: alloy::transports::TransportError) -> Self {
        Error::Rpc(e.to_string())
    }
}

#[cfg(feature = "client")]
impl From<alloy::providers::PendingTransactionError> for Error {
    fn from(e: alloy::providers::PendingTransactionError) -> Self {
        Error::Rpc(e.to_string())
    }
}
