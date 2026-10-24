//! `ferryd`: runs one party (Z or B) of a Ferry ZEC<->BTC swap.

mod config;
mod daemon;
mod http;
mod mock_zec;
mod record;
mod view;

use anyhow::{bail, Context};
use clap::Parser;
use ferry_core::ZecLeg;

use crate::config::{Cli, ZecBackend};
use crate::daemon::Daemon;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ferryd=info".into()),
        )
        .init();
    let cli = Cli::parse();
    match cli.zec {
        ZecBackend::Mock => {
            let path = cli
                .zec_mock_file
                .clone()
                .context("--zec mock needs --zec-mock-file (both daemons must share it)")?;
            let leg = mock_zec::MockZecLeg::new(
                path,
                cli.name.clone(),
                cli.zec_mock_block_secs,
                cli.zec_mock_balance,
            )?
            .with_network(cli.zec_network.clone());
            run(cli, leg).await
        }
        ZecBackend::Devtool => {
            let cfg = ferry_zec::DevtoolConfig {
                devtool: cli.zec_devtool.clone(),
                signer: cli.zec_signer.clone(),
                wallet_dir: cli
                    .zec_wallet_dir
                    .clone()
                    .unwrap_or_else(|| cli.data_dir.join("zec-wallet")),
                identity: cli
                    .zec_identity
                    .clone()
                    .unwrap_or_else(|| cli.data_dir.join("zec-identity.age")),
                server: cli.zec_server.clone(),
                network: cli.zec_network.clone(),
                activation_heights: cli.zec_activation_heights.clone(),
                node_rpc: cli.zec_node_rpc.clone(),
                node_rpc_auth: cli
                    .zec_node_rpc_auth
                    .as_deref()
                    .map(|a| {
                        a.split_once(':')
                            .map(|(u, p)| (u.to_string(), p.to_string()))
                            .context("--zec-node-rpc-auth must be USER:PASS")
                    })
                    .transpose()?,
                sync_interval: std::time::Duration::from_secs_f64(cli.zec_sync_secs.max(0.2)),
            };
            let leg = ferry_zec::DevtoolZecLeg::new(cfg)
                .await
                .context("starting the zcash-devtool wallet")?;
            run(cli, leg).await
        }
    }
}

async fn run<L: ZecLeg + 'static>(cli: Cli, leg: L) -> anyhow::Result<()> {
    let (peer_addr, api_addr) = (cli.listen, cli.api_listen);
    if !api_addr.ip().is_loopback() {
        bail!("--api-listen must be a loopback address (the control API moves funds)");
    }
    let token_file = cli.data_dir.join("api-token");
    let daemon = Daemon::new(cli, leg).await?;
    tracing::info!(
        role = daemon.role.as_str(),
        name = %daemon.cli.name,
        making = daemon.offer.making,
        "ferryd: API on http://{api_addr} (token in {}), peer protocol on http://{peer_addr}",
        token_file.display()
    );
    tokio::spawn(daemon.clone().run());
    let api = tokio::net::TcpListener::bind(api_addr).await?;
    let peer = tokio::net::TcpListener::bind(peer_addr).await?;
    let shutdown = || async {
        let _ = tokio::signal::ctrl_c().await;
    };
    tokio::try_join!(
        axum::serve(api, http::api_router(daemon.clone())).with_graceful_shutdown(shutdown()),
        axum::serve(peer, http::peer_router(daemon)).with_graceful_shutdown(shutdown()),
    )?;
    Ok(())
}
