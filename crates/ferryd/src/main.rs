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
            )?;
            run(cli, leg).await
        }
        ZecBackend::Devtool => {
            bail!("--zec devtool needs the ferry-zec crate, which is not part of this build yet")
        }
    }
}

async fn run<L: ZecLeg + 'static>(cli: Cli, leg: L) -> anyhow::Result<()> {
    let listen = cli.listen;
    let daemon = Daemon::new(cli, leg).await?;
    tracing::info!(
        role = daemon.role.as_str(),
        name = %daemon.cli.name,
        making = daemon.offer.making,
        "ferryd listening on http://{listen}"
    );
    tokio::spawn(daemon.clone().run());
    let listener = tokio::net::TcpListener::bind(listen).await?;
    axum::serve(listener, http::router(daemon))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
