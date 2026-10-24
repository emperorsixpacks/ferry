//! `--counter evm` flags, the EVM maker offer and its terms.

use std::path::PathBuf;

use clap::{Args, ValueEnum};
use ferry_core::evm::{EvmEnvelope, EvmParams};
use ferry_core::Role;
use serde::{Deserialize, Serialize};

/// What the ZEC is swapped against.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Counter {
    /// A UTXO coin over Taproot (bitcoind; the default).
    #[default]
    Btc,
    /// An ERC-20 (USDC) in the FerryLock contract on an EVM chain (docs/EVM.md).
    Evm,
}

/// EVM counter-chain settings (used with `--counter evm`).
#[derive(Clone, Debug, Args)]
pub struct EvmArgs {
    /// EVM JSON-RPC endpoint (anvil, Base Sepolia...).
    #[arg(long, default_value = "http://127.0.0.1:18545")]
    pub evm_rpc: String,
    /// FerryLock deployment address. Both parties must use the same one, and ferryd refuses to
    /// start unless the code there is the FerryLock it was built with.
    #[arg(long)]
    pub evm_contract: Option<String>,
    /// The ERC-20 being swapped (USDC).
    #[arg(long)]
    pub evm_token: Option<String>,
    /// File holding our EVM private key (hex). Z: the account the tokens are paid to (and that
    /// sends the claim, so it needs a little ETH). B: the account that holds the tokens, locks,
    /// refunds and signs Ready(id).
    #[arg(long)]
    pub evm_key_file: Option<PathBuf>,
    #[arg(long, default_value = "USDC")]
    pub evm_token_symbol: String,
    #[arg(long, default_value_t = 6)]
    pub evm_token_decimals: u8,
    /// Seconds from the proposal to t1 (the end of the claim window).
    #[arg(long, default_value_t = 1_800)]
    pub evm_t1_secs: u64,
    /// Seconds from t1 to t2 (the refund window; punish from t2).
    #[arg(long, default_value_t = 1_800)]
    pub evm_refund_secs: u64,
    /// Δ for both the claim and the refund deadline (seconds).
    #[arg(long, default_value_t = 300)]
    pub evm_delta_secs: u64,
    /// Confirmations of the EVM lock Z waits for before locking ZEC.
    #[arg(long, default_value_t = 2)]
    pub evm_lock_confs: u32,
    /// Largest relayer tip a claim may take (token base units).
    #[arg(long, default_value_t = 0)]
    pub evm_max_tip: u64,
    /// Block range per eth_getLogs request (public RPCs cap it).
    #[arg(long, default_value_t = 2_000)]
    pub evm_log_chunk: u64,
    /// Accept an EVM chain id Ferry has no safety policy for, as a test network (2 min margins,
    /// 2 lock confirmations). Without it such a chain is refused. Never for real funds, and not
    /// accepted for a listed chain (docs/EVM.md, "Timing rules").
    #[arg(long, conflicts_with = "dev_policy")]
    pub evm_testnet_policy: bool,
}

/// Timing terms of an EVM offer; the maker's apply to every swap it accepts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTerms {
    /// Seconds from the proposal to t1.
    pub t1_secs: u64,
    /// t2 − t1.
    pub refund_secs: u64,
    pub claim_margin: u64,
    pub refund_margin: u64,
    pub lock_confirmations: u32,
    pub zec_confirmations: u32,
    pub max_tip: u64,
}

impl EvmTerms {
    pub fn of(p: &EvmParams) -> EvmTerms {
        EvmTerms {
            t1_secs: 0,
            refund_secs: p.t2 - p.t1,
            claim_margin: p.claim_margin,
            refund_margin: p.refund_margin,
            lock_confirmations: p.lock_confirmations,
            zec_confirmations: p.zec_confirmations,
            max_tip: p.max_tip,
        }
    }

    /// Everything but the absolute deadlines agrees.
    pub fn same_shape(&self, p: &EvmParams) -> bool {
        EvmTerms {
            t1_secs: 0,
            ..self.clone()
        } == EvmTerms::of(p)
    }
}

/// `GET /peer/offer` of an EVM maker. Field names follow the Bitcoin offer where they mean the
/// same thing, so a maker directory can list both: `rate_sat_per_zec` is in the token's base
/// units per ZEC here.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmOffer {
    pub counter: Counter,
    pub role: Role,
    pub chain_id: u64,
    /// e.g. "anvil", "base-sepolia"
    pub network: String,
    #[serde(with = "hex_addr")]
    pub contract: [u8; 20],
    #[serde(with = "hex_addr")]
    pub token: [u8; 20],
    pub token_symbol: String,
    pub token_decimals: u8,
    pub making: bool,
    pub rate_sat_per_zec: u64,
    pub min_zat: u64,
    pub max_zat: u64,
    pub terms: EvmTerms,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_updated_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub liquidity: Option<crate::config::Liquidity>,
    #[serde(default)]
    pub paused: bool,
}

impl EvmOffer {
    pub fn token_for(&self, zec_zat: u64) -> u64 {
        crate::config::btc_for(zec_zat, self.rate_sat_per_zec)
    }

    pub fn pair(&self) -> String {
        format!("ZEC/{}", self.token_symbol)
    }
}

/// Which policy the operator asked for beyond the listed chains.
pub fn policy_opt_in(cli: &crate::config::Cli) -> ferry_core::evm::PolicyOptIn {
    use ferry_core::evm::PolicyOptIn;
    if cli.dev_policy {
        PolicyOptIn::Dev
    } else if cli.evm.evm_testnet_policy {
        PolicyOptIn::UnlistedTestnet
    } else {
        PolicyOptIn::Listed
    }
}

pub fn network_name(chain_id: u64) -> String {
    use ferry_core::evm::*;
    match chain_id {
        ANVIL_CHAIN_ID => "anvil",
        ETHEREUM_CHAIN_ID => "ethereum",
        OPTIMISM_CHAIN_ID => "optimism",
        BASE_CHAIN_ID => "base",
        ARBITRUM_CHAIN_ID => "arbitrum",
        SEPOLIA_CHAIN_ID => "sepolia",
        OP_SEPOLIA_CHAIN_ID => "op-sepolia",
        BASE_SEPOLIA_CHAIN_ID => "base-sepolia",
        ARBITRUM_SEPOLIA_CHAIN_ID => "arbitrum-sepolia",
        n => return format!("evm-{n}"),
    }
    .into()
}

/// `POST /peer/swaps` on an EVM maker.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmProposeRequest {
    pub envelope: EvmEnvelope,
    pub taker_url: String,
}

/// `0x`-prefixed hex for 20-byte addresses.
pub mod hex_addr {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8; 20], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(v)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 20], D::Error> {
        let s = String::deserialize(d)?;
        super::parse_address(&s).map_err(D::Error::custom)
    }
}

pub fn parse_address(s: &str) -> Result<[u8; 20], String> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(h)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| format!("{s}: not a 20-byte hex address"))
}

pub fn addr_str(a: &[u8; 20]) -> String {
    ferry_evm::Address::from(*a).to_checksum(None)
}

/// `amount` base units of a `decimals`-place token, e.g. "249.5 USDC".
pub fn token_str(amount: u64, decimals: u8, symbol: &str) -> String {
    let scale = 10u64.pow(u32::from(decimals));
    let whole = amount / scale;
    let frac = amount % scale;
    if frac == 0 {
        return format!("{whole} {symbol}");
    }
    let frac = format!("{frac:0width$}", width = usize::from(decimals));
    format!("{whole}.{} {symbol}", frac.trim_end_matches('0'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_flags() {
        use clap::Parser;
        use ferry_core::evm::PolicyOptIn;
        let cli = |extra: &[&str]| {
            let base = [
                "ferryd",
                "--role",
                "z",
                "--name",
                "n",
                "--data-dir",
                "/x",
                "--counter",
                "evm",
            ];
            crate::config::Cli::try_parse_from(base.iter().chain(extra))
        };
        assert_eq!(policy_opt_in(&cli(&[]).unwrap()), PolicyOptIn::Listed);
        assert_eq!(
            policy_opt_in(&cli(&["--dev-policy"]).unwrap()),
            PolicyOptIn::Dev
        );
        assert_eq!(
            policy_opt_in(&cli(&["--evm-testnet-policy"]).unwrap()),
            PolicyOptIn::UnlistedTestnet
        );
        assert!(cli(&["--dev-policy", "--evm-testnet-policy"]).is_err());
    }

    #[test]
    fn formatting_and_parsing() {
        assert_eq!(token_str(250_000_000, 6, "USDC"), "250 USDC");
        assert_eq!(token_str(249_500_000, 6, "USDC"), "249.5 USDC");
        assert_eq!(token_str(1, 6, "USDC"), "0.000001 USDC");
        assert_eq!(network_name(1), "ethereum");
        assert_eq!(network_name(10), "optimism");
        assert_eq!(network_name(8453), "base");
        assert_eq!(network_name(42161), "arbitrum");
        assert_eq!(network_name(11_155_111), "sepolia");
        assert_eq!(network_name(11_155_420), "op-sepolia");
        assert_eq!(network_name(84532), "base-sepolia");
        assert_eq!(network_name(421_614), "arbitrum-sepolia");
        assert_eq!(network_name(31337), "anvil");
        assert_eq!(network_name(7), "evm-7");
        let a = parse_address("0x5FbDB2315678afecb367f032d93F642f64180aa3").unwrap();
        assert_eq!(addr_str(&a), "0x5FbDB2315678afecb367f032d93F642f64180aa3");
        assert!(parse_address("0x1234").is_err());
    }
}
