//! `ferry-route`: runs routes (coin A → shielded ZEC → coin C) over the user's own two ferryd
//! daemons. See crates/ferry-route/README.md.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use clap::Parser;
use ferry_route::api::{self, Api};
use ferry_route::hub::{os_random, system_clock, Hub, Settings};
use ferry_route::legs::{self, Ferryd, HttpFerryd, Role};
use ferry_route::route::{check_denominations, parse_zec, zec_str, Policy, MAX_PARTS_LIMIT};
use ferry_route::store::write_private;

/// Chains two Ferry swaps through shielded ZEC: leg 1 buys ZEC with coin A (your B daemon on
/// pair A) and pays it straight into the shielded wallet of your Z daemon on pair C; once the
/// ZEC can be spent, leg 2 sells it for coin C. By default both legs are split into parts of
/// standard sizes, each its own swap after its own random gap.
#[derive(Debug, Parser)]
#[command(name = "ferry-route", version)]
struct Cli {
    /// One JSON file per route is kept under <data-dir>/routes (mode 0600).
    #[arg(long)]
    data_dir: PathBuf,
    /// HTTP API listener. Must be a loopback address unless --api-allow-remote is given.
    #[arg(long, default_value = "127.0.0.1:7140")]
    api_listen: SocketAddr,
    /// Allow a non-loopback --api-listen, for a private container network. The bearer token is
    /// still required on every request.
    #[arg(long)]
    api_allow_remote: bool,
    /// Bearer token file for /api/*: read it, or create it (random, mode 0600) if it is missing
    /// or empty. Default: <data-dir>/api-token.
    #[arg(long)]
    api_token_file: Option<PathBuf>,
    /// Browser origin allowed to call /api/* (repeatable). Requests carrying any other `Origin`
    /// header are refused.
    #[arg(long)]
    ui_origin: Vec<String>,
    /// A daemon's control API: PAIR:ROLE=URL, e.g. btc:b=http://127.0.0.1:7102 (leg 1 runs on a
    /// B daemon) or usdc-base:z=http://127.0.0.1:7901 (leg 2 runs on a Z daemon). Repeatable.
    #[arg(long = "leg", value_name = "PAIR:ROLE=URL")]
    legs: Vec<String>,
    /// That daemon's API token file (its <data-dir>/api-token): PAIR:ROLE=FILE. Repeatable.
    #[arg(long = "leg-token-file", value_name = "PAIR:ROLE=FILE")]
    leg_tokens: Vec<String>,
    /// The random gap before each part (the privacy pause) for routes that name none, MIN:MAX
    /// seconds (Standard: 5–30 min; Off is 0:0, Long is 3600:21600).
    #[arg(long, default_value = "300:1800")]
    delay_secs: String,
    /// Split routes into parts of standard sizes (`on`), so the amounts on both outer chains are
    /// ones every swap of that size shares. `off` (for testing) runs each leg as one swap; a
    /// request may still ask either way (`standard_amounts`).
    #[arg(long, value_parser = ["on", "off"], default_value = "on")]
    standard_amounts: String,
    /// The standard sizes, in ZEC, comma-separated (default: the firm-quote buckets).
    #[arg(long, default_value = "0.1,0.25,0.5,1,2.5,5,10,25,50,100")]
    denominations: String,
    /// Most parts per leg; a larger amount is rounded down to what this many parts can carry.
    #[arg(long, default_value_t = 8)]
    max_parts: usize,
    /// Longest privacy pause a route may ask for.
    #[arg(long, default_value_t = 24 * 3600)]
    max_delay_secs: u64,
    /// Most ZEC a route may keep back as jitter, in basis points of the amount.
    #[arg(long, default_value_t = 200)]
    max_keep_bps: u32,
    /// Allow the same maker (by name or URL host) on both legs. Off by default: one partner on
    /// both sides can link them trivially.
    #[arg(long)]
    allow_same_partner: bool,
    /// Confirmations of leg 1's sweep before leg 2 may start (devtool spends a note received
    /// from outside the wallet only at 10).
    #[arg(long, default_value_t = 10)]
    zec_confs: u32,
    /// Fee allowance for one Ironwood transaction (zat).
    #[arg(long, default_value_t = 10_000)]
    zec_fee_zat: u64,
    /// What L2 keeps spare for its lock's fee (zat; ferryd's SEND_FEE_RESERVE).
    #[arg(long, default_value_t = 50_000)]
    zec_lock_reserve_zat: u64,
    /// Leg 1: keep retrying a busy (409) daemon this long before failing.
    #[arg(long, default_value_t = 300)]
    leg1_busy_secs: u64,
    /// Leg 2: keep trying to start it this long, then hold the ZEC.
    #[arg(long, default_value_t = 7200)]
    leg2_window_secs: u64,
    #[arg(long, default_value_t = 60)]
    retry_secs: u64,
    /// After a start whose answer was lost, wait this long for the swap to appear before
    /// starting again under the same label.
    #[arg(long, default_value_t = 120)]
    start_grace_secs: u64,
    /// The sweep is buried but the wallet still can't spend leg 2's amount: hold after this long.
    #[arg(long, default_value_t = 1800)]
    spendable_grace_secs: u64,
    #[arg(long, default_value_t = 5)]
    tick_secs: u64,
}

fn parse_key(spec: &str, flag: &str) -> anyhow::Result<((String, Role), String)> {
    let (key, value) = spec
        .split_once('=')
        .with_context(|| format!("{flag} {spec:?}: expected PAIR:ROLE=VALUE"))?;
    let (pair, role) = key
        .split_once(':')
        .with_context(|| format!("{flag} {spec:?}: expected PAIR:ROLE=VALUE"))?;
    let pair = pair.trim().to_lowercase();
    if !legs::is_pair(&pair) {
        bail!("{flag}: unknown pair {pair:?} (btc, ltc, usdc-base, weth-arbitrum, ...)");
    }
    let role = match role.trim().to_lowercase().as_str() {
        "b" => Role::B,
        "z" => Role::Z,
        r => bail!("{flag}: role must be b or z, not {r:?}"),
    };
    Ok(((pair, role), value.trim().to_string()))
}

fn read_or_create_token(path: &PathBuf) -> anyhow::Result<String> {
    let existing = std::fs::read_to_string(path)
        .ok()
        .map(|t| t.trim().to_string());
    if let Some(t) = existing.filter(|t| !t.is_empty()) {
        return Ok(t);
    }
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let t = hex::encode(b);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_private(path, t.as_bytes()).with_context(|| format!("writing {}", path.display()))?;
    Ok(t)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ferry_route=info".into()),
        )
        .init();
    let cli = Cli::parse();
    if !cli.api_listen.ip().is_loopback() && !cli.api_allow_remote {
        bail!(
            "--api-listen must be a loopback address (the API starts swaps); \
             use --api-allow-remote only on a private network"
        );
    }
    let delay = cli
        .delay_secs
        .split_once(':')
        .and_then(|(a, b)| Some([a.trim().parse().ok()?, b.trim().parse().ok()?]))
        .filter(|[a, b]: &[u64; 2]| a <= b && *b <= cli.max_delay_secs)
        .context("--delay-secs must be MIN:MAX seconds, MIN ≤ MAX ≤ --max-delay-secs")?;

    let mut tokens = BTreeMap::new();
    for spec in &cli.leg_tokens {
        let (key, file) = parse_key(spec, "--leg-token-file")?;
        let token = std::fs::read_to_string(&file)
            .with_context(|| format!("reading the token file for {}:{}", key.0, key.1.as_str()))?
            .trim()
            .to_string();
        if token.is_empty() {
            bail!("the token file for {}:{} is empty", key.0, key.1.as_str());
        }
        tokens.insert(key, token);
    }
    let mut daemons = BTreeMap::new();
    for spec in &cli.legs {
        let (key, url) = parse_key(spec, "--leg")?;
        let token = tokens.remove(&key).with_context(|| {
            format!(
                "--leg {}:{} needs a --leg-token-file",
                key.0,
                key.1.as_str().to_lowercase()
            )
        })?;
        if daemons.contains_key(&key) {
            bail!(
                "--leg {}:{} given twice",
                key.0,
                key.1.as_str().to_lowercase()
            );
        }
        daemons.insert(key, HttpFerryd::new(&url, token)?);
    }
    if let Some(((pair, role), _)) = tokens.into_iter().next() {
        bail!(
            "--leg-token-file {pair}:{} has no --leg",
            role.as_str().to_lowercase()
        );
    }
    if !daemons.keys().any(|(_, r)| *r == Role::B) || !daemons.keys().any(|(_, r)| *r == Role::Z) {
        bail!("a route needs at least one B daemon (leg 1) and one Z daemon (leg 2): --leg PAIR:b=URL --leg PAIR:z=URL");
    }
    // Each daemon must be the one configured, and speak the route contract. One that is down
    // now is checked again before every start.
    for ((pair, role), d) in &daemons {
        match d.status().await {
            Ok(s) => {
                legs::verify(&s, pair, *role).map_err(|e| anyhow::anyhow!("{} ({e})", d.base()))?;
                tracing::info!(%pair, role = role.as_str(), name = %s.name, "leg daemon ok");
            }
            Err(e) => {
                tracing::warn!(%pair, role = role.as_str(), "leg daemon not reachable now: {e}")
            }
        }
    }

    let token_file = cli
        .api_token_file
        .clone()
        .unwrap_or_else(|| cli.data_dir.join("api-token"));
    ferry_route::store::private_dir(&cli.data_dir)?;
    let token = read_or_create_token(&token_file)?;
    let policy = Policy {
        needed_confs: cli.zec_confs,
        zec_fee_zat: cli.zec_fee_zat,
        lock_reserve_zat: cli.zec_lock_reserve_zat,
        leg1_busy_secs: cli.leg1_busy_secs,
        leg2_window_secs: cli.leg2_window_secs,
        retry_secs: cli.retry_secs,
        start_grace_secs: cli.start_grace_secs,
        spendable_grace_secs: cli.spendable_grace_secs,
    };
    let denominations = cli
        .denominations
        .split(',')
        .map(|d| {
            parse_zec(d).with_context(|| format!("--denominations: {d:?} is not an amount of ZEC"))
        })
        .collect::<anyhow::Result<Vec<u64>>>()?;
    let denominations =
        check_denominations(&denominations).map_err(|e| anyhow::anyhow!("--denominations: {e}"))?;
    if !(1..=MAX_PARTS_LIMIT).contains(&cli.max_parts) {
        bail!("--max-parts must be 1 to {MAX_PARTS_LIMIT}");
    }
    let settings = Settings {
        default_delay_secs: delay,
        max_delay_secs: cli.max_delay_secs,
        max_keep_bps: cli.max_keep_bps.min(10_000),
        allow_same_partner: cli.allow_same_partner,
        standard_amounts: cli.standard_amounts == "on",
        denominations,
        max_parts: cli.max_parts,
    };
    if settings.standard_amounts {
        let sizes: Vec<String> = settings.denominations.iter().map(|d| zec_str(*d)).collect();
        tracing::info!(
            max_parts = settings.max_parts,
            "standard amounts: {}",
            sizes.join(", ")
        );
    } else {
        tracing::warn!("standard amounts are off: each leg runs as one swap, and its amounts can link the legs");
    }
    let hub = Arc::new(Hub::open(
        &cli.data_dir,
        policy,
        settings,
        daemons,
        system_clock(),
        os_random(),
    )?);
    for r in hub.routes().iter().filter(|r| r.phase.is_active()) {
        tracing::info!(route = %r.id, phase = ?r.phase, "resuming route");
    }
    tokio::spawn(hub.clone().run(Duration::from_secs(cli.tick_secs.max(1))));

    let app = api::router(Arc::new(Api {
        hub,
        token,
        ui_origins: cli.ui_origin.clone(),
    }));
    let listener = tokio::net::TcpListener::bind(cli.api_listen).await?;
    tracing::info!(
        "ferry-route: API on http://{} (token in {})",
        cli.api_listen,
        token_file.display()
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
