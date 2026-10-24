//! `--counter evm`: the party's swaps run against FerryLock on an EVM chain instead of
//! bitcoind (docs/EVM.md). Same API and peer paths, EVM bodies; the Bitcoin daemon is untouched.

pub mod config;
mod daemon;
mod http;
mod quote;
pub(crate) mod record;
mod view;

pub use config::{Counter, EvmArgs};

use anyhow::bail;
use ferry_core::ZecLeg;

use crate::config::Cli;

pub async fn run<L: ZecLeg + 'static>(cli: Cli, leg: L) -> anyhow::Result<()> {
    let (peer_addr, api_addr) = (cli.listen, cli.api_listen);
    if !api_addr.ip().is_loopback() && !cli.api_allow_remote {
        bail!(
            "--api-listen must be a loopback address (the control API moves funds); \
             use --api-allow-remote only on a private network"
        );
    }
    let token_file = cli.data_dir.join("api-token");
    let daemon = daemon::EvmDaemon::new(cli, leg).await?;
    // Only now is the chain known: a maker on a main network keeps its spread.
    daemon
        .cli
        .check_maker_spread(ferry_core::evm::EvmPolicy::is_mainnet(daemon.chain_id))
        .map_err(anyhow::Error::msg)?;
    tracing::info!(
        role = daemon.role.as_str(),
        name = %daemon.cli.name,
        making = daemon.offer.making,
        chain_id = daemon.chain_id,
        contract = %config::addr_str(&daemon.offer.contract),
        token = %daemon.offer.token_symbol,
        account = %daemon.client.address(),
        "ferryd (EVM): API on http://{api_addr} (token in {}), peer protocol on http://{peer_addr}",
        token_file.display()
    );
    tokio::spawn(daemon.clone().run());
    if let Some(price) = daemon.price.clone() {
        tokio::spawn(price.run());
    }
    let api = tokio::net::TcpListener::bind(api_addr).await?;
    let peer = tokio::net::TcpListener::bind(peer_addr).await?;
    let shutdown = || async {
        let _ = tokio::signal::ctrl_c().await;
    };
    tokio::try_join!(
        axum::serve(api, http::api_router(daemon.clone())).with_graceful_shutdown(shutdown()),
        // the peer's address, for the firm-quote rate limit (crate::quote)
        axum::serve(
            peer,
            http::peer_router(daemon).into_make_service_with_connect_info::<std::net::SocketAddr>()
        )
        .with_graceful_shutdown(shutdown()),
    )?;
    Ok(())
}
