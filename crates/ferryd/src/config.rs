//! Command line, offer terms and the peer wire types.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, ValueEnum};
use ferry_btc::bitcoin::Network;
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
    /// Control API listener (/api/*, for the UI). Must be a loopback address.
    #[arg(long, default_value = "127.0.0.1:7101")]
    pub api_listen: SocketAddr,
    /// Bearer token required on /api/*. Default: a random token, written to <data-dir>/api-token.
    #[arg(long)]
    pub api_token: Option<String>,
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
    /// bitcoind wallet holding our BTC (created if missing; default: --name).
    #[arg(long)]
    pub btc_wallet: Option<String>,
    #[arg(long, default_value = "regtest")]
    pub network: Network,

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

    /// Accept proposals as maker: RATE_SAT_PER_ZEC[:MIN_ZAT:MAX_ZAT].
    #[arg(long)]
    pub maker_offer: Option<OfferArg>,

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
            network: self.network,
            making: self.maker_offer.is_some(),
            rate_sat_per_zec: o.rate_sat_per_zec,
            min_zat: o.min_zat,
            max_zat: o.max_zat,
            terms: self.terms(),
        }
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
}

impl Terms {
    pub fn params(&self, network: Network, zec_zat: u64, btc_sat: u64) -> SwapParams {
        SwapParams {
            network,
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
        }
    }
}

/// `GET /peer/offer`
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Offer {
    /// The maker's role; a taker must hold the other one.
    pub role: Role,
    pub network: Network,
    /// Whether this daemon accepts proposals at all.
    pub making: bool,
    pub rate_sat_per_zec: u64,
    pub min_zat: u64,
    pub max_zat: u64,
    pub terms: Terms,
}

impl Offer {
    pub fn btc_for(&self, zec_zat: u64) -> u64 {
        btc_for(zec_zat, self.rate_sat_per_zec)
    }
}

/// `zec_zat · rate / 10^8`, rounded to the nearest sat.
pub fn btc_for(zec_zat: u64, rate_sat_per_zec: u64) -> u64 {
    ((u128::from(zec_zat) * u128::from(rate_sat_per_zec) + 50_000_000) / 100_000_000) as u64
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
}
