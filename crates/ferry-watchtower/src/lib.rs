//! Ferry watchtower.
//!
//! A swap party hands the tower fully signed, deadline-critical Bitcoin transactions that pay
//! only itself (B: tx_cancel + completed tx_refund; Z: tx_cancel + tx_punish). The tower
//! watches bitcoind and broadcasts each one when the timing rules of docs/PROTOCOL.md allow
//! it, so the party no longer has to stay online until its deadline. It holds no keys.
//! See docs/WATCHTOWER.md.

pub mod client;
pub mod engine;
pub mod http;
pub mod package;
pub mod store;
pub mod tower;

pub use client::{Client, ClientError};
pub use engine::{Outcome, Rules, Status};
pub use package::{Armed, Package, PackageError, PACKAGE_VERSION};
pub use store::PackageView;
pub use tower::{Registered, Tower, TowerConfig};

/// Serve the API on `listener` until `shutdown` resolves, polling in the background.
pub async fn serve(
    tower: std::sync::Arc<Tower>,
    listener: tokio::net::TcpListener,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let poller = tokio::spawn(tower.clone().run());
    let res = axum::serve(listener, http::router(tower))
        .with_graceful_shutdown(shutdown)
        .await;
    poller.abort();
    res
}
