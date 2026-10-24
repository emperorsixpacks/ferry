//! `ferryd`: runs one party (Z or B) of a Ferry ZEC<->BTC swap.

mod config;
mod daemon;
mod http;
mod mock_zec;
mod pricefeed;
mod rebroadcast;
mod record;
mod tower;
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
    let mut cli = Cli::parse();
    resolve_secret_files(&mut cli)?;
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

/// Secrets given as files (kept out of `ps` and `docker inspect`).
fn resolve_secret_files(cli: &mut Cli) -> anyhow::Result<()> {
    if let Some(path) = &cli.btc_rpc_pass_file {
        let pass = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        cli.btc_rpc_pass = pass.trim().to_string();
    }
    if let Some(path) = &cli.api_token_file {
        let existing = std::fs::read_to_string(path).ok().map(|t| t.trim().to_string());
        let token = match existing.filter(|t| !t.is_empty()) {
            Some(t) => t,
            None => {
                use rand_core::RngCore;
                let mut b = [0u8; 32];
                rand_core::OsRng.fill_bytes(&mut b);
                let t = hex::encode(b);
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                record::write_private(path, t.as_bytes())
                    .with_context(|| format!("writing {}", path.display()))?;
                t
            }
        };
        cli.api_token = Some(token);
    }
    Ok(())
}

async fn run<L: ZecLeg + 'static>(cli: Cli, leg: L) -> anyhow::Result<()> {
    let (peer_addr, api_addr) = (cli.listen, cli.api_listen);
    if !api_addr.ip().is_loopback() && !cli.api_allow_remote {
        bail!(
            "--api-listen must be a loopback address (the control API moves funds); \
             use --api-allow-remote only on a private network"
        );
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
    if let Some(price) = daemon.price.clone() {
        tracing::info!(
            pair = %price.cfg.pair,
            spread_bps = price.cfg.spread_bps,
            sources = ?price.cfg.sources.iter().map(|s| s.kind.name()).collect::<Vec<_>>(),
            "maker rate follows the price feed (paused until the first price)"
        );
        tokio::spawn(price.run());
    }
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
