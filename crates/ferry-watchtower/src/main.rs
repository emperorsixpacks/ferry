//! `ferry-watchtower`: broadcasts a Ferry party's presigned cancel/refund/punish on time, or
//! (`--counter evm`) calls FerryLock's refund/punish for it.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context};
use clap::Parser;
use ferry_btc::bitcoin::Network;
use ferry_btc::rpc::BitcoinRpc;
use ferry_btc::{Chain, Coin};
use ferry_evm::{Address, EvmClient, PrivateKeySigner, B256};
use ferry_watchtower::{Counter, EvmTower, EvmTowerConfig, Service, Tower, TowerConfig};

/// Watches Ferry swaps for offline owners. Holds no keys of theirs.
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
    /// What the guarded swaps lock against the ZEC: btc (a Taproot output on bitcoind or
    /// litecoind, see --chain) or evm (an ERC-20 in FerryLock, see the --evm-* options).
    #[arg(long, default_value = "btc")]
    counter: Counter,
    /// The coin whose node the tower follows: btc (bitcoind) or ltc (litecoind, Core >= 0.21.2).
    /// The --btc-* options then point at that node.
    #[arg(long, default_value = "btc")]
    chain: Coin,
    #[arg(long, default_value = "regtest")]
    network: Network,
    #[arg(long, default_value = "http://127.0.0.1:18543")]
    btc_rpc: String,
    #[arg(long, default_value = "ferry")]
    btc_rpc_user: String,
    #[arg(long, default_value = "ferry")]
    btc_rpc_pass: String,
    /// Read the node's RPC password from this file instead of --btc-rpc-pass.
    #[arg(long)]
    btc_rpc_pass_file: Option<PathBuf>,
    /// Watch-only node wallet (no keys) that tracks the swaps' outputs; created if missing (a
    /// descriptor wallet on bitcoind, a legacy one on litecoind).
    #[arg(long, default_value = "ferry-watchtower")]
    btc_watch_wallet: String,
    /// EVM JSON-RPC endpoint (--counter evm).
    #[arg(long, default_value = "http://127.0.0.1:18545")]
    evm_rpc: String,
    /// The tower's own EVM key (hex), which pays the gas of refund and punish calls; the
    /// contract pays the swap's parties, never this account. Created (random, mode 0600) if
    /// missing; refused if other users can read it. Fund its address (in the log and
    /// /health) with a little ETH.
    #[arg(long)]
    evm_key_file: Option<PathBuf>,
    /// Accept packages only for this FerryLock deployment (repeatable). Default: any address
    /// whose code is this build's FerryLock.
    #[arg(long)]
    evm_contract: Vec<Address>,
    /// Hold a refund while the node's latest block is more than this many seconds behind the
    /// local clock.
    #[arg(long, default_value_t = 120)]
    evm_max_lag_secs: u64,
    #[arg(long, default_value_t = 2_000)]
    poll_ms: u64,
    /// On upload, rescan this many seconds of blocks for the lock (Bitcoin and Litecoin).
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

/// The tower's gas key: read it (only from a file no one else can read), or create one.
fn read_evm_key(path: &Path) -> anyhow::Result<PrivateKeySigner> {
    let existing = std::fs::read_to_string(path)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let Some(text) = existing else {
        let signer = PrivateKeySigner::random();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        ferry_watchtower::store::write_private(path, hex::encode(signer.to_bytes()).as_bytes())
            .with_context(|| format!("writing {}", path.display()))?;
        tracing::info!(account = %signer.address(), "created the tower's gas key in {}", path.display());
        return Ok(signer);
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)?.permissions().mode();
        if mode & 0o077 != 0 {
            bail!(
                "{} is readable by other users (mode {:o}); chmod 600 it",
                path.display(),
                mode & 0o777
            );
        }
    }
    let bytes: [u8; 32] = hex::decode(text.trim_start_matches("0x"))
        .ok()
        .and_then(|v| v.try_into().ok())
        .with_context(|| format!("{} must hold a 32-byte hex key", path.display()))?;
    PrivateKeySigner::from_bytes(&B256::from(bytes))
        .with_context(|| format!("{} does not hold a valid key", path.display()))
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
    let poll = Duration::from_millis(cli.poll_ms.max(100));
    let service: Service = match cli.counter {
        Counter::Btc => {
            let pass = match &cli.btc_rpc_pass_file {
                Some(p) => std::fs::read_to_string(p)
                    .with_context(|| format!("reading {}", p.display()))?
                    .trim()
                    .to_string(),
                None => cli.btc_rpc_pass.clone(),
            };
            let chain = Chain::new(cli.chain, cli.network)?;
            let rpc = BitcoinRpc::new(&cli.btc_rpc, &cli.btc_rpc_user, pass)
                .with_coin(chain.coin)
                .with_wallet(&cli.btc_watch_wallet)
                .with_watch_wallet(&cli.btc_watch_wallet);
            let cfg = TowerConfig {
                chain,
                data_dir: cli.data_dir.clone(),
                token,
                poll,
                rescan_secs: cli.rescan_secs,
            };
            let tower = Tower::open(cfg, rpc).await.with_context(|| {
                format!(
                    "starting the watchtower (is the {} node up, with wallet support?)",
                    chain.coin.name()
                )
            })?;
            tracing::info!(chain = %chain, auth = cli.token_file.is_some(), "ferry-watchtower on http://{}", cli.listen);
            tower.into()
        }
        Counter::Evm => {
            let key_file = cli
                .evm_key_file
                .as_deref()
                .context("--counter evm needs --evm-key-file (the tower's gas account)")?;
            let signer = read_evm_key(key_file)?;
            // The contract address is per package (EvmClient::at); this one is never called.
            let client = EvmClient::connect_http(&cli.evm_rpc, Address::ZERO, signer)?;
            let cfg = EvmTowerConfig {
                data_dir: cli.data_dir.clone(),
                token,
                poll,
                max_lag_secs: cli.evm_max_lag_secs,
                contracts: cli.evm_contract.clone(),
            };
            let tower = EvmTower::open(cfg, client)
                .await
                .with_context(|| format!("starting the EVM watchtower (is {} up?)", cli.evm_rpc))?;
            tracing::info!(
                chain_id = tower.chain_id,
                account = %tower.account(),
                auth = cli.token_file.is_some(),
                "ferry-watchtower (EVM) on http://{}",
                cli.listen
            );
            tower.into()
        }
    };
    let listener = tokio::net::TcpListener::bind(cli.listen).await?;
    ferry_watchtower::serve(service, listener, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
