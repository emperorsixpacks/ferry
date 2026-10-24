//! `ferry-watchtower`: broadcasts a Ferry party's presigned cancel/refund/punish on time.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};
use clap::Parser;
use ferry_btc::bitcoin::Network;
use ferry_btc::rpc::BitcoinRpc;
use ferry_watchtower::{Tower, TowerConfig};

/// Watches Ferry swaps for offline owners. Holds no keys.
#[derive(Debug, Parser)]
#[command(name = "ferry-watchtower", version)]
struct Cli {
    #[arg(long, default_value = "127.0.0.1:7700")]
    listen: SocketAddr,
    /// One JSON file per package is kept under <data-dir>/packages.
    #[arg(long)]
    data_dir: PathBuf,
    /// Bearer token file for /packages*: read it, or create it (random, mode 0600) if missing
    /// or empty. Without it the API is open; that is refused off loopback unless --open.
    #[arg(long)]
    token_file: Option<PathBuf>,
    /// Serve without a token on a non-loopback address (private networks only).
    #[arg(long)]
    open: bool,
    #[arg(long, default_value = "regtest")]
    network: Network,
    #[arg(long, default_value = "http://127.0.0.1:18543")]
    btc_rpc: String,
    #[arg(long, default_value = "ferry")]
    btc_rpc_user: String,
    #[arg(long, default_value = "ferry")]
    btc_rpc_pass: String,
    /// Read the bitcoind RPC password from this file instead of --btc-rpc-pass.
    #[arg(long)]
    btc_rpc_pass_file: Option<PathBuf>,
    /// Watch-only bitcoind wallet (no keys) that tracks the swaps' outputs; created if missing.
    #[arg(long, default_value = "ferry-watchtower")]
    btc_watch_wallet: String,
    #[arg(long, default_value_t = 2_000)]
    poll_ms: u64,
    /// On upload, rescan this many seconds of blocks for the lock.
    #[arg(long, default_value_t = 6 * 3600)]
    rescan_secs: u64,
}

fn read_token(path: &PathBuf) -> anyhow::Result<String> {
    if let Some(t) = std::fs::read_to_string(path)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
    {
        return Ok(t);
    }
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let t = hex::encode(b);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    ferry_watchtower::store::write_private(path, t.as_bytes())
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(t)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ferry_watchtower=info".into()),
        )
        .init();
    let cli = Cli::parse();
    let token = cli.token_file.as_ref().map(read_token).transpose()?;
    if token.is_none() && !cli.listen.ip().is_loopback() && !cli.open {
        bail!("--listen off loopback needs --token-file (or --open on a private network)");
    }
    let pass = match &cli.btc_rpc_pass_file {
        Some(p) => std::fs::read_to_string(p)
            .with_context(|| format!("reading {}", p.display()))?
            .trim()
            .to_string(),
        None => cli.btc_rpc_pass.clone(),
    };
    let rpc = BitcoinRpc::new(&cli.btc_rpc, &cli.btc_rpc_user, pass)
        .with_wallet(&cli.btc_watch_wallet)
        .with_watch_wallet(&cli.btc_watch_wallet);
    let cfg = TowerConfig {
        network: cli.network,
        data_dir: cli.data_dir.clone(),
        token,
        poll: Duration::from_millis(cli.poll_ms.max(100)),
        rescan_secs: cli.rescan_secs,
    };
    let tower = Tower::open(cfg, rpc)
        .await
        .context("starting the watchtower (is bitcoind up, with wallet support?)")?;
    let listener = tokio::net::TcpListener::bind(cli.listen).await?;
    tracing::info!(
        network = %cli.network,
        auth = cli.token_file.is_some(),
        "ferry-watchtower on http://{}",
        cli.listen
    );
    ferry_watchtower::serve(tower, listener, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
