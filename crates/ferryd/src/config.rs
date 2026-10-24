//! Command line, offer terms and the peer wire types.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, ValueEnum};
use ferry_btc::bitcoin::Network;
use ferry_btc::{Chain, Coin};
use ferry_core::{Envelope, Role, SwapParams};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum RoleArg {
    Z,
    B,
}

impl From<RoleArg> for Role {
    fn from(r: RoleArg) -> Role {
        match r {
            RoleArg::Z => Role::Z,
            RoleArg::B => Role::B,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum ZecBackend {
    /// File-backed stand-in chain shared by both daemons (see --zec-mock-file).
    Mock,
    /// zcash-devtool wallet (ferry-zec).
    Devtool,
}

/// Runs one party of a Ferry swap.
#[derive(Clone, Debug, Parser)]
#[command(name = "ferryd", version)]
pub struct Cli {
    /// z: holds shielded ZEC and wants BTC. b: holds BTC and wants ZEC.
    #[arg(long, value_enum)]
    pub role: RoleArg,
    #[arg(long)]
    pub name: String,
    /// Peer protocol listener (/peer/*). A maker exposes this one to takers.
    #[arg(long, default_value = "127.0.0.1:7111")]
    pub listen: SocketAddr,
    /// Control API listener (/api/*, for the UI). Must be a loopback address unless
    /// --api-allow-remote is given.
    #[arg(long, default_value = "127.0.0.1:7101")]
    pub api_listen: SocketAddr,
    /// Allow a non-loopback --api-listen, for a private container network where the UI server
    /// runs in another container. The bearer token is still required on every request.
    #[arg(long)]
    pub api_allow_remote: bool,
    /// Bearer token required on /api/*. Default: a random token, written to <data-dir>/api-token.
    #[arg(long, conflicts_with = "api_token_file")]
    pub api_token: Option<String>,
    /// Read the API token from this file, or create it there (random, mode 0600) if it is missing
    /// or empty. Keeps the token out of command lines; a UI server can read the same file.
    #[arg(long)]
    pub api_token_file: Option<PathBuf>,
    /// Browser origin allowed to call /api/* (repeatable). Requests carrying any other
    /// `Origin` header are refused.
    #[arg(long)]
    pub ui_origin: Vec<String>,
    /// Enable POST /api/swaps/:id/fault (demo fault injection).
    #[arg(long)]
    pub demo_faults: bool,
    /// Random delay before sweeping the joint note, MIN:MAX seconds, so the ZEC sweep does not
    /// line up in time with the BTC transaction that revealed the key.
    #[arg(long, default_value = "5:20")]
    pub sweep_delay_secs: DelayArg,
    /// Redeem BTC through the MuSig2 key path, so tx_lock and tx_redeem look like an ordinary
    /// single-key Taproot payment (`--btc-keypath false`: 2-of-2 script-path redeem).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    pub btc_keypath: bool,
    /// Relaxed local policy for development (regtest only, where it is required): margins and
    /// confirmation minimums drop to 1.
    #[arg(long)]
    pub dev_policy: bool,
    /// A swap that has locked nothing after this long is aborted, freeing the maker's slot.
    #[arg(long, default_value_t = 1800)]
    pub negotiation_timeout_secs: u64,
    /// URL the counterparty uses to reach our peer listener (default http://<listen>).
    #[arg(long)]
    pub public_url: Option<String>,
    /// One JSON file per swap is kept under <data-dir>/swaps.
    #[arg(long)]
    pub data_dir: PathBuf,

    #[arg(long, default_value = "http://127.0.0.1:18543")]
    pub btc_rpc: String,
    #[arg(long, default_value = "ferry")]
    pub btc_rpc_user: String,
    #[arg(long, default_value = "ferry")]
    pub btc_rpc_pass: String,
    /// Read the bitcoind RPC password from this file instead of --btc-rpc-pass.
    #[arg(long)]
    pub btc_rpc_pass_file: Option<PathBuf>,
    /// bitcoind wallet holding our BTC (created if missing; default: --name).
    #[arg(long)]
    pub btc_wallet: Option<String>,
    /// Watch-only bitcoind wallet tracking the swap outputs (created if missing; default:
    /// <btc-wallet>-watch). Lets ferryd follow its transactions on a pruned node without -txindex.
    #[arg(long)]
    pub btc_watch_wallet: Option<String>,
    #[arg(long, default_value = "regtest")]
    pub network: Network,
    /// The coin swapped against ZEC: btc (bitcoind) or ltc (litecoind, Core >= 0.21.2). The
    /// --btc-* options then point at that coin's node and wallet.
    #[arg(long, default_value = "btc")]
    pub chain: Coin,

    #[arg(long, value_enum, default_value = "mock")]
    pub zec: ZecBackend,
    /// Shared state file of the mock Zcash chain (both daemons must use the same file).
    #[arg(long)]
    pub zec_mock_file: Option<PathBuf>,
    #[arg(long, default_value_t = 5.0)]
    pub zec_mock_block_secs: f64,
    /// Our mock shielded balance the first time the mock chain sees us (zatoshi).
    #[arg(long, default_value_t = 0)]
    pub zec_mock_balance: u64,

    /// zcash-devtool binary (built with `--features regtest_support` for regtest).
    #[arg(long, default_value = "zcash-devtool")]
    pub zec_devtool: PathBuf,
    /// ferry-zec-signer binary (tools/ferry-zec-signer).
    #[arg(long, default_value = "ferry-zec-signer")]
    pub zec_signer: PathBuf,
    /// Our zcash-devtool wallet directory (initialized if empty). Default: <data-dir>/zec-wallet.
    #[arg(long)]
    pub zec_wallet_dir: Option<PathBuf>,
    /// age identity for the wallet's mnemonic. Default: <data-dir>/zec-identity.age.
    #[arg(long)]
    pub zec_identity: Option<PathBuf>,
    /// Zaino/lightwalletd gRPC endpoint (host:port; plaintext for localhost).
    #[arg(long, default_value = "localhost:8137")]
    pub zec_server: String,
    /// Zcash network: regtest, test or main.
    #[arg(long, default_value = "regtest")]
    pub zec_network: String,
    /// Activation heights file, needed to initialize a regtest wallet.
    #[arg(long)]
    pub zec_activation_heights: Option<PathBuf>,
    /// The Zcash node's JSON-RPC endpoint (Zebra, e.g. http://127.0.0.1:18232). Without it the
    /// chain tip and confirmations come from the wallet's own scan, and the UI gets no
    /// public-view description of ZEC transactions.
    #[arg(long)]
    pub zec_node_rpc: Option<String>,
    /// USER:PASS for the node's JSON-RPC, if it needs any.
    #[arg(long)]
    pub zec_node_rpc_auth: Option<String>,
    #[arg(long, default_value_t = 2.0)]
    pub zec_sync_secs: f64,

    /// Accept proposals as maker: RATE_SAT_PER_ZEC[:MIN_ZAT:MAX_ZAT]. Either role can make: a B
    /// maker pays RATE per ZEC it buys (takers sell ZEC), a Z maker asks RATE per ZEC it sells
    /// (takers buy ZEC) and quotes its spendable shielded ZEC, less the lock fee, as liquidity.
    #[arg(long)]
    pub maker_offer: Option<OfferArg>,
    /// Follow the market instead of the fixed --maker-offer rate: `kraken`, `coingecko`, a comma
    /// list, `all`, or `off`. The rate is the median of the sources that answer, times
    /// (1 + --maker-spread-bps), refreshed every minute; the offer pauses when every source has
    /// been failing for 5 minutes. MIN/MAX still come from --maker-offer.
    #[arg(long, requires = "maker_offer")]
    pub maker_price_feed: Option<crate::pricefeed::FeedArg>,
    /// Spread over the feed price, in basis points (50 = +0.5%). May be negative: a B maker buying
    /// ZEC quotes below the market, a Z maker selling ZEC above it.
    #[arg(long, default_value_t = 0, allow_negative_numbers = true,
          value_parser = clap::value_parser!(i32).range(-5_000..=5_000))]
    pub maker_spread_bps: i32,
    /// The pair the price feed quotes (BASE/QUOTE: ZEC/BTC, ZEC/LTC, ZEC/USD, ZEC/USDC, ZEC/ETH
    /// for WETH). A BTC or LTC quote follows --chain, so `--chain ltc` quotes ZEC/LTC. With
    /// --counter evm the quote's decimals must be the token's (ferryd refuses to start otherwise).
    #[arg(long, default_value = "ZEC/BTC")]
    pub maker_price_pair: crate::pricefeed::Pair,
    /// Testing and mirrors: SOURCE=BASE_URL to reach a feed somewhere else (repeatable).
    #[arg(long, hide = true)]
    pub maker_price_feed_url: Vec<String>,
    /// Testing: seconds between feed refreshes (default 60).
    #[arg(long, hide = true, default_value_t = crate::pricefeed::REFRESH.as_secs())]
    pub maker_price_refresh_secs: u64,
    /// Testing: pause the offer after this many seconds without a fresh price (default 300).
    #[arg(long, hide = true, default_value_t = crate::pricefeed::STALE_AFTER.as_secs())]
    pub maker_price_stale_secs: u64,

    #[arg(long, default_value_t = 12)]
    pub t1: u16,
    #[arg(long, default_value_t = 24)]
    pub t2: u16,
    /// Δ for both the redeem and the refund deadline (blocks).
    #[arg(long, default_value_t = 3)]
    pub delta: u16,
    #[arg(long, default_value_t = 2)]
    pub btc_lock_confs: u32,
    #[arg(long, default_value_t = 3)]
    pub zec_confs: u32,
    #[arg(long, default_value_t = 1)]
    pub cancel_confs: u32,
    /// Fixed fee per presigned BTC transaction (sats).
    #[arg(long, default_value_t = 2_000)]
    pub fee_sat: u64,
    /// Chain polling and peer exchange interval.
    #[arg(long, default_value_t = 1_000)]
    pub poll_ms: u64,

    /// Watchtower (ferry-watchtower) to hand our signed deadline transactions to once tx_cancel
    /// is co-signed, so the swap finishes even if this daemon goes offline (docs/WATCHTOWER.md).
    #[arg(long)]
    pub watchtower: Option<String>,
    /// Bearer token file for --watchtower.
    #[arg(long, requires = "watchtower")]
    pub watchtower_token_file: Option<std::path::PathBuf>,
    /// B only: confirm the watchtower is your own (or one you trust not to work with your
    /// counterparty). B's completed refund reveals B's key share to Z, so without this flag B
    /// refuses to arm a tower. Z can use any tower.
    #[arg(long, requires = "watchtower")]
    pub watchtower_own: bool,

    /// What the ZEC is swapped against: `btc` (bitcoind, the default) or `evm` (an ERC-20 such
    /// as USDC in FerryLock; see the --evm-* flags and docs/EVM.md).
    #[arg(long, value_enum, default_value = "btc")]
    pub counter: crate::evm::Counter,
    #[command(flatten)]
    pub evm: crate::evm::EvmArgs,
}

#[derive(Clone, Copy, Debug)]
pub struct DelayArg {
    pub min_secs: u64,
    pub max_secs: u64,
}

impl std::str::FromStr for DelayArg {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let (min, max) = s.split_once(':').unwrap_or((s, s));
        let min = min.parse::<u64>().map_err(|e| format!("{min}: {e}"))?;
        let max = max.parse::<u64>().map_err(|e| format!("{max}: {e}"))?;
        if min > max {
            return Err("expected MIN:MAX with MIN <= MAX".into());
        }
        Ok(DelayArg {
            min_secs: min,
            max_secs: max,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct OfferArg {
    pub rate_sat_per_zec: u64,
    pub min_zat: u64,
    pub max_zat: u64,
}

impl std::str::FromStr for OfferArg {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let parts: Vec<u64> = s
            .split(':')
            .map(|p| p.parse::<u64>().map_err(|e| format!("{p}: {e}")))
            .collect::<Result<_, _>>()?;
        match parts[..] {
            [rate] => Ok(OfferArg {
                rate_sat_per_zec: rate,
                min_zat: 10_000_000,
                max_zat: 1_000_000_000,
            }),
            [rate, min, max] if min <= max => Ok(OfferArg {
                rate_sat_per_zec: rate,
                min_zat: min,
                max_zat: max,
            }),
            _ => Err("expected RATE or RATE:MIN_ZAT:MAX_ZAT".into()),
        }
    }
}

impl Cli {
    /// --maker-price-pair with a BTC or LTC quote set to --chain's coin (the rate is in its
    /// smallest unit per ZEC).
    pub fn price_pair(&self) -> crate::pricefeed::Pair {
        use crate::pricefeed::Asset;
        let mut pair = self.maker_price_pair;
        if matches!(pair.quote, Asset::Btc | Asset::Ltc) {
            pair.quote = match self.chain {
                Coin::Btc => Asset::Btc,
                Coin::Ltc => Asset::Ltc,
            };
        }
        pair
    }

    /// Counter-chain coin and network.
    pub fn chain(&self) -> anyhow::Result<Chain> {
        Ok(Chain::new(self.chain, self.network)?)
    }

    pub fn public_url(&self) -> String {
        self.public_url
            .clone()
            .unwrap_or_else(|| format!("http://{}", self.listen))
    }

    pub fn terms(&self) -> Terms {
        Terms {
            t1: self.t1,
            t2: self.t2,
            btc_fee: self.fee_sat,
            btc_lock_confirmations: self.btc_lock_confs,
            zec_confirmations: self.zec_confs,
            cancel_confirmations: self.cancel_confs,
            redeem_margin: self.delta,
            refund_margin: self.delta,
            keypath: self.btc_keypath,
        }
    }

    pub fn offer(&self) -> Offer {
        let o = self.maker_offer.unwrap_or(OfferArg {
            rate_sat_per_zec: 410_000,
            min_zat: 10_000_000,
            max_zat: 1_000_000_000,
        });
        Offer {
            role: self.role.into(),
            coin: self.chain,
            network: self.network,
            making: self.maker_offer.is_some(),
            rate_sat_per_zec: o.rate_sat_per_zec,
            min_zat: o.min_zat,
            max_zat: o.max_zat,
            terms: self.terms(),
            rate_source: None,
            rate_updated_at: None,
            liquidity: None,
            paused: false,
        }
    }

    /// The live rate behind the offer, when --maker-price-feed is given.
    pub fn live_rate(&self) -> Option<crate::pricefeed::LiveRate> {
        use crate::pricefeed::{FeedConfig, LiveRate, Source, GRACE};
        use std::time::Duration;
        let feed = self.maker_price_feed.as_ref().filter(|f| !f.0.is_empty())?;
        let sources = feed
            .0
            .iter()
            .map(|k| {
                let prefix = format!("{}=", k.name());
                let url = self
                    .maker_price_feed_url
                    .iter()
                    .find_map(|o| o.strip_prefix(&prefix).map(str::to_string));
                url.map_or_else(
                    || Source::public(*k),
                    |base_url| Source { kind: *k, base_url },
                )
            })
            .collect();
        Some(LiveRate::new(FeedConfig {
            pair: self.price_pair(),
            sources,
            spread_bps: self.maker_spread_bps,
            refresh: Duration::from_secs(self.maker_price_refresh_secs.max(1)),
            stale_after: Duration::from_secs(self.maker_price_stale_secs.max(1)),
            grace: GRACE,
        }))
    }
}

/// Timing and fee terms; the maker's apply to every swap it accepts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Terms {
    pub t1: u16,
    pub t2: u16,
    pub btc_fee: u64,
    pub btc_lock_confirmations: u32,
    pub zec_confirmations: u32,
    pub cancel_confirmations: u32,
    pub redeem_margin: u16,
    pub refund_margin: u16,
    #[serde(default)]
    pub keypath: bool,
}

impl Terms {
    pub fn params(&self, chain: Chain, zec_zat: u64, btc_sat: u64) -> SwapParams {
        SwapParams {
            coin: chain.coin,
            network: chain.network,
            btc_amount: btc_sat,
            zec_amount: zec_zat,
            t1: self.t1,
            t2: self.t2,
            btc_fee: self.btc_fee,
            btc_lock_confirmations: self.btc_lock_confirmations,
            zec_confirmations: self.zec_confirmations,
            cancel_confirmations: self.cancel_confirmations,
            redeem_margin: self.redeem_margin,
            refund_margin: self.refund_margin,
            keypath: self.keypath,
        }
    }

    pub fn of(p: &SwapParams) -> Terms {
        Terms {
            t1: p.t1,
            t2: p.t2,
            btc_fee: p.btc_fee,
            btc_lock_confirmations: p.btc_lock_confirmations,
            zec_confirmations: p.zec_confirmations,
            cancel_confirmations: p.cancel_confirmations,
            redeem_margin: p.redeem_margin,
            refund_margin: p.refund_margin,
            keypath: p.keypath,
        }
    }
}

/// `GET /peer/offer`
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Offer {
    /// The maker's role; a taker must hold the other one.
    pub role: Role,
    /// The coin swapped against ZEC (absent from older makers: btc).
    #[serde(default)]
    pub coin: Coin,
    pub network: Network,
    /// Whether this daemon accepts proposals at all.
    pub making: bool,
    pub rate_sat_per_zec: u64,
    pub min_zat: u64,
    pub max_zat: u64,
    pub terms: Terms,
    /// `fixed`, or the feeds behind a live rate (`median(kraken,coingecko) +50bps`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_source: Option<String>,
    /// Unix seconds of the price a live rate comes from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_updated_at: Option<u64>,
    /// How much the maker can fill right now, from its balance (capped at `max_zat`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub liquidity: Option<Liquidity>,
    /// The live rate went stale: `making` is false until a feed answers again.
    #[serde(default)]
    pub paused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Liquidity {
    /// The largest ZEC amount the maker's balance covers right now.
    pub zec_zat: u64,
}

impl Offer {
    /// "ZEC/BTC", "ZEC/LTC".
    pub fn pair(&self) -> String {
        format!("ZEC/{}", self.coin.ticker())
    }

    pub fn btc_for(&self, zec_zat: u64) -> u64 {
        btc_for(zec_zat, self.rate_sat_per_zec)
    }
}

/// `zec_zat · rate / 10^8`, rounded to the nearest base unit (sat, or an EVM token's smallest
/// unit), or None when the result does not fit in u64. A WETH rate is about 1.2e16 wei per ZEC,
/// so this caps one swap at about 18.4 WETH. Never overflows: the product of two u64 values plus
/// the rounding term stays below 2^128.
pub fn checked_btc_for(zec_zat: u64, rate_sat_per_zec: u64) -> Option<u64> {
    let units = (u128::from(zec_zat) * u128::from(rate_sat_per_zec) + 50_000_000) / 100_000_000;
    u64::try_from(units).ok()
}

/// [`checked_btc_for`], saturating at u64::MAX (an amount no one can fund) instead of wrapping.
/// Bitcoin amounts never come near it; EVM quotes use [`checked_btc_for`], so an oversized swap
/// is refused with a clear error instead.
pub fn btc_for(zec_zat: u64, rate_sat_per_zec: u64) -> u64 {
    checked_btc_for(zec_zat, rate_sat_per_zec).unwrap_or(u64::MAX)
}

/// The zatoshi that `units` base units buy at `rate_sat_per_zec`, rounded down, saturating at
/// u64::MAX (0 at a zero rate).
pub fn zat_for(units: u64, rate_sat_per_zec: u64) -> u64 {
    if rate_sat_per_zec == 0 {
        return 0;
    }
    u64::try_from(u128::from(units) * 100_000_000 / u128::from(rate_sat_per_zec))
        .unwrap_or(u64::MAX)
}

/// `POST /peer/swaps`
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProposeRequest {
    pub envelope: Envelope,
    pub taker_url: String,
}

/// Reply to `POST /peer/swaps/:id/messages`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Delivery {
    pub accepted: bool,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn litecoin_cli() {
        let cli = |extra: &[&str]| {
            let base = [
                "ferryd",
                "--role",
                "b",
                "--name",
                "n",
                "--data-dir",
                "/nonexistent",
            ];
            Cli::try_parse_from(base.iter().chain(extra)).unwrap()
        };
        let btc = cli(&[]);
        assert_eq!(btc.offer().pair(), "ZEC/BTC");
        assert_eq!(btc.price_pair().to_string(), "ZEC/BTC");
        let ltc = cli(&["--chain", "ltc"]);
        assert_eq!(ltc.offer().pair(), "ZEC/LTC");
        assert_eq!(ltc.chain().unwrap().hrp(), "rltc");
        // a BTC/LTC price quote follows --chain; a USD quote is left alone
        assert_eq!(ltc.price_pair().to_string(), "ZEC/LTC");
        let usd = cli(&["--chain", "ltc", "--maker-price-pair", "ZEC/USD"]);
        assert_eq!(usd.price_pair().to_string(), "ZEC/USD");
        assert!(cli(&["--chain", "ltc", "--network", "signet"])
            .chain()
            .is_err());
        // A Litecoin swap can arm a tower that follows litecoind (ferry-watchtower --chain ltc).
        assert!(cli(&["--chain", "ltc", "--watchtower", "http://t"])
            .chain()
            .is_ok());
        assert!(Cli::try_parse_from([
            "ferryd",
            "--role",
            "b",
            "--name",
            "n",
            "--data-dir",
            "/x",
            "--chain",
            "doge"
        ])
        .is_err());
    }

    #[test]
    fn offer_parsing_and_rate() {
        let o: OfferArg = "410000".parse().unwrap();
        assert_eq!((o.min_zat, o.max_zat), (10_000_000, 1_000_000_000));
        let o: OfferArg = "500:1:2".parse().unwrap();
        assert_eq!((o.rate_sat_per_zec, o.min_zat, o.max_zat), (500, 1, 2));
        assert!("1:2".parse::<OfferArg>().is_err());
        assert_eq!(btc_for(100_000_000, 410_000), 410_000);
        assert_eq!(btc_for(12_345_678, 410_000), 50_617);
        let d: DelayArg = "3:9".parse().unwrap();
        assert_eq!((d.min_secs, d.max_secs), (3, 9));
        assert!("9:3".parse::<DelayArg>().is_err());
    }

    /// 18-decimal tokens: `zec_zat × rate` is far beyond u64 (1 ZEC at 0.012 WETH is
    /// 1e8 × 1.2e16), and the result must be exact, or refused, never wrapped.
    #[test]
    fn rate_at_18_decimals() {
        const WETH_RATE: u64 = 12_000_000_000_000_000; // 0.012 WETH per ZEC, in wei
        assert_eq!(checked_btc_for(100_000_000, WETH_RATE), Some(WETH_RATE));
        assert_eq!(
            checked_btc_for(12_345_678, WETH_RATE),
            Some(1_481_481_360_000_000)
        );
        // The per-swap cap: u64::MAX wei is about 18.44 WETH, about 1537 ZEC at this rate.
        let cap_zat = 153_722_867_280;
        assert!(checked_btc_for(cap_zat, WETH_RATE).is_some());
        assert_eq!(checked_btc_for(cap_zat + 1, WETH_RATE), None);
        assert_eq!(btc_for(cap_zat + 1, WETH_RATE), u64::MAX);
        // The extremes neither panic nor wrap.
        assert_eq!(checked_btc_for(u64::MAX, u64::MAX), None);
        assert_eq!(checked_btc_for(u64::MAX, 100_000_000), Some(u64::MAX));
        assert_eq!(checked_btc_for(0, u64::MAX), Some(0));
        // ...and back: what a balance can fill.
        assert_eq!(zat_for(WETH_RATE, WETH_RATE), 100_000_000);
        assert_eq!(zat_for(u64::MAX, WETH_RATE), cap_zat);
        assert_eq!(zat_for(u64::MAX, 1), u64::MAX);
        assert_eq!(zat_for(5, 0), 0);
    }
}
