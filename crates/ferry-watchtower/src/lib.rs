//! Ferry watchtower.
//!
//! A swap party hands the tower fully signed, deadline-critical Bitcoin (or Litecoin)
//! transactions that pay only itself (B: tx_cancel + completed tx_refund; Z: tx_cancel +
//! tx_punish). The tower watches the node and broadcasts each one when the timing rules of
//! docs/PROTOCOL.md allow it, so the party no longer has to stay online until its deadline. It
//! holds no keys.
//!
//! A tower started with `--counter evm` guards FerryLock swaps instead ([`evm`]): it calls
//! `punish` for Z (keyless) or `refund` for B (with B's share `b`) on time, paying the gas from
//! its own account. See docs/WATCHTOWER.md.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub mod client;
pub mod engine;
pub mod evm;
pub mod http;
pub mod package;
pub mod store;
pub mod tower;

pub use client::{Client, ClientError};
pub use engine::{Outcome, Rules, Status};
pub use evm::{EvmPackage, EvmPackageView, EvmTower, EvmTowerConfig};
pub use package::{Armed, Package, PackageError, PACKAGE_VERSION};
pub use store::PackageView;
pub use tower::{Registered, Tower, TowerConfig};

/// What the swaps a tower guards lock against the ZEC.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Counter {
    /// A Taproot output on bitcoind or litecoind, spent by presigned transactions.
    #[default]
    Btc,
    /// An ERC-20 in FerryLock on an EVM chain.
    Evm,
}

impl std::str::FromStr for Counter {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "btc" => Ok(Counter::Btc),
            "evm" => Ok(Counter::Evm),
            _ => Err(format!("unknown counter {s:?} (expected btc or evm)")),
        }
    }
}

/// A running tower of either kind.
#[derive(Clone)]
pub enum Service {
    /// Bitcoin or Litecoin (presigned transactions through the node).
    Utxo(Arc<Tower>),
    /// FerryLock on an EVM chain.
    Evm(Arc<EvmTower>),
}

impl From<Arc<Tower>> for Service {
    fn from(t: Arc<Tower>) -> Service {
        Service::Utxo(t)
    }
}

impl From<Arc<EvmTower>> for Service {
    fn from(t: Arc<EvmTower>) -> Service {
        Service::Evm(t)
    }
}

/// Serve the API on `listener` until `shutdown` resolves, polling in the background.
pub async fn serve(
    tower: impl Into<Service>,
    listener: tokio::net::TcpListener,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let service = tower.into();
    let poller = match &service {
        Service::Utxo(t) => tokio::spawn(t.clone().run()),
        Service::Evm(t) => tokio::spawn(t.clone().run()),
    };
    let res = axum::serve(listener, http::router(service))
        .with_graceful_shutdown(shutdown)
        .await;
    poller.abort();
    res
}
