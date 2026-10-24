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
    /// An ERC-20 (USDC, WETH) in the FerryLock contract on an EVM chain (docs/EVM.md).
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
    /// The ERC-20 being swapped (USDC, WETH...).
    #[arg(long)]
    pub evm_token: Option<String>,
    /// File holding our EVM private key (hex). Z: the account the tokens are paid to (and that
    /// sends the claim, so it needs a little ETH). B: the account that holds the tokens, locks,
    /// refunds and signs Ready(id).
    #[arg(long)]
    pub evm_key_file: Option<PathBuf>,
    /// The token's symbol (USDC, WETH). ferryd refuses to start unless the token's own
    /// `symbol()` returns exactly this.
    #[arg(long, default_value = "USDC")]
    pub evm_token_symbol: String,
    /// The token's decimals (USDC 6, WETH 18): amounts and rates are in its base units. ferryd
    /// refuses to start unless the token's own `decimals()` returns this.
    #[arg(long, default_value_t = 6, value_parser = clap::value_parser!(u8).range(0..=18))]
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
            refund_secs: p.t2.saturating_sub(p.t1),
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
    /// Token base units for `zec_zat` at this offer's rate, or None above the per-swap cap:
    /// amounts are u64 base units, so one swap carries at most u64::MAX of them (about 18.4
    /// WETH; USDC never gets near it).
    pub fn token_for(&self, zec_zat: u64) -> Option<u64> {
        crate::config::checked_btc_for(zec_zat, self.rate_sat_per_zec)
    }

    pub fn pair(&self) -> String {
        format!("ZEC/{}", self.token_symbol)
    }

    /// The per-swap cap in words, e.g. "18.446744073709551615 WETH".
    pub fn swap_cap(&self) -> String {
        token_str(u64::MAX, self.token_decimals, &self.token_symbol)
    }

    /// Taker side: the maker's offer names our chain, our FerryLock and exactly our token
    /// (address, symbol and decimals), so a USDC taker never matches a WETH maker or the reverse.
    pub fn check_same_token(&self, theirs: &EvmOffer) -> Result<(), String> {
        if theirs.chain_id != self.chain_id || theirs.contract != self.contract {
            return Err("the counterparty uses another chain or FerryLock".into());
        }
        if theirs.token != self.token
            || theirs.token_symbol != self.token_symbol
            || theirs.token_decimals != self.token_decimals
        {
            return Err(format!(
                "the counterparty swaps {:?} ({}, {} decimals); we swap {} ({}, {} decimals)",
                theirs.token_symbol,
                addr_str(&theirs.token),
                theirs.token_decimals,
                self.token_symbol,
                addr_str(&self.token),
                self.token_decimals
            ));
        }
        Ok(())
    }

    /// Maker side: a proposal's terms name our chain, our FerryLock and exactly our token. The
    /// token, its symbol and its decimals are part of `EvmParams`, so of the transcript both
    /// sides hash.
    pub fn check_params_token(&self, p: &EvmParams) -> Result<(), &'static str> {
        if p.chain_id != self.chain_id || p.contract != self.contract || p.token != self.token {
            return Err("another chain, FerryLock or token than this maker's");
        }
        if p.token_symbol != self.token_symbol || p.token_decimals != self.token_decimals {
            return Err("token symbol or decimals differ from the offer");
        }
        Ok(())
    }
}

/// Startup, both roles: the token's own `symbol()` and `decimals()` are what the flags say, so
/// a mislabeled token is never quoted, checked or shown at the wrong scale.
pub fn check_token_metadata(
    onchain: &ferry_evm::TokenInfo,
    symbol: &str,
    decimals: u8,
) -> Result<(), String> {
    if onchain.decimals != decimals {
        return Err(format!(
            "the token's decimals() is {}, but --evm-token-decimals is {decimals}",
            onchain.decimals
        ));
    }
    if onchain.symbol != symbol {
        return Err(format!(
            "the token's symbol() is {:?}, but --evm-token-symbol is {symbol:?}",
            onchain.symbol
        ));
    }
    Ok(())
}

/// Startup, with a price feed: the feed's rate is in the quote asset's smallest unit per ZEC,
/// so the quote must have the token's decimals. ZEC/USDC (6) for WETH (18) would quote 10^12
/// times too little.
pub fn check_feed_pair(pair: crate::pricefeed::Pair, token_decimals: u8) -> Result<(), String> {
    if pair.quote.decimals() != u32::from(token_decimals) {
        return Err(format!(
            "--maker-price-pair {pair} quotes in units of 10^-{} but the token has {token_decimals} decimals (ZEC/USDC or ZEC/USD for USDC, ZEC/ETH for WETH)",
            pair.quote.decimals()
        ));
    }
    Ok(())
}

pub fn network_name(chain_id: u64) -> String {
    use ferry_core::evm::{ANVIL_CHAIN_ID, BASE_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID};
    match chain_id {
        ANVIL_CHAIN_ID => "anvil".into(),
        BASE_SEPOLIA_CHAIN_ID => "base-sepolia".into(),
        BASE_CHAIN_ID => "base".into(),
        n => format!("evm-{n}"),
    }
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

/// `amount` base units of a `decimals`-place token, e.g. "249.5 USDC", "0.012 WETH". Exact for
/// any decimals (u128 arithmetic: 10^18 does not fit twice in u64).
pub fn token_str(amount: u64, decimals: u8, symbol: &str) -> String {
    let Some(scale) = 10u128.checked_pow(u32::from(decimals)) else {
        return format!("{amount} base units of {symbol}");
    };
    let whole = u128::from(amount) / scale;
    let frac = u128::from(amount) % scale;
    if frac == 0 {
        return format!("{whole} {symbol}");
    }
    let frac = format!("{frac:0width$}", width = usize::from(decimals));
    format!("{whole}.{} {symbol}", frac.trim_end_matches('0'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferry_evm::TokenInfo;

    #[test]
    fn formatting_and_parsing() {
        assert_eq!(token_str(250_000_000, 6, "USDC"), "250 USDC");
        assert_eq!(token_str(249_500_000, 6, "USDC"), "249.5 USDC");
        assert_eq!(token_str(1, 6, "USDC"), "0.000001 USDC");
        assert_eq!(token_str(12_000_000_000_000_000, 18, "WETH"), "0.012 WETH");
        assert_eq!(token_str(1, 18, "WETH"), "0.000000000000000001 WETH");
        assert_eq!(
            token_str(u64::MAX, 18, "WETH"),
            "18.446744073709551615 WETH"
        );
        assert_eq!(token_str(7, 0, "X"), "7 X");
        assert_eq!(token_str(7, 255, "X"), "7 base units of X");
        let a = parse_address("0x5FbDB2315678afecb367f032d93F642f64180aa3").unwrap();
        assert_eq!(addr_str(&a), "0x5FbDB2315678afecb367f032d93F642f64180aa3");
        assert!(parse_address("0x1234").is_err());
    }

    const USDC: [u8; 20] = [0x55; 20];
    const WETH: [u8; 20] = [0xee; 20];

    fn offer(token: [u8; 20], symbol: &str, decimals: u8, rate: u64) -> EvmOffer {
        EvmOffer {
            counter: Counter::Evm,
            role: Role::B,
            chain_id: ferry_core::evm::ANVIL_CHAIN_ID,
            network: "anvil".into(),
            contract: [0x11; 20],
            token,
            token_symbol: symbol.into(),
            token_decimals: decimals,
            making: true,
            rate_sat_per_zec: rate,
            min_zat: 1,
            max_zat: u64::MAX,
            terms: EvmTerms {
                t1_secs: 600,
                refund_secs: 600,
                claim_margin: 60,
                refund_margin: 60,
                lock_confirmations: 1,
                zec_confirmations: 1,
                max_tip: 0,
            },
            rate_source: None,
            rate_updated_at: None,
            liquidity: None,
            paused: false,
        }
    }

    fn usdc() -> EvmOffer {
        offer(USDC, "USDC", 6, 40_000_000)
    }

    fn weth() -> EvmOffer {
        offer(WETH, "WETH", 18, 12_000_000_000_000_000)
    }

    fn params_of(o: &EvmOffer, zec_zat: u64) -> EvmParams {
        EvmParams {
            chain_id: o.chain_id,
            contract: o.contract,
            token: o.token,
            token_amount: o.token_for(zec_zat).unwrap(),
            token_symbol: o.token_symbol.clone(),
            token_decimals: o.token_decimals,
            zec_amount: zec_zat,
            t1: 10_000,
            t2: 20_000,
            claim_margin: 60,
            refund_margin: 60,
            lock_confirmations: 1,
            zec_confirmations: 1,
            max_tip: 0,
        }
    }

    /// A USDC taker and a WETH maker (or the reverse) never agree on a swap: the taker refuses
    /// the offer, the maker refuses the proposal, and a proposal that names the other token in
    /// any one field (address, symbol or decimals) is refused too.
    #[test]
    fn usdc_and_weth_never_match() {
        let (usdc, weth) = (usdc(), weth());
        assert!(usdc.check_same_token(&usdc.clone()).is_ok());
        assert!(weth.check_same_token(&weth.clone()).is_ok());
        let err = usdc.check_same_token(&weth).unwrap_err();
        assert!(
            err.contains("\"WETH\"") && err.contains("we swap USDC"),
            "{err}"
        );
        assert!(weth.check_same_token(&usdc).is_err());

        let usdc_proposal = params_of(&usdc, 100_000_000);
        let weth_proposal = params_of(&weth, 100_000_000);
        usdc_proposal.validate().unwrap();
        weth_proposal.validate().unwrap();
        assert!(usdc.check_params_token(&usdc_proposal).is_ok());
        assert!(weth.check_params_token(&weth_proposal).is_ok());
        assert!(weth.check_params_token(&usdc_proposal).is_err());
        assert!(usdc.check_params_token(&weth_proposal).is_err());

        // Mixed labels: WETH's address under USDC's name, or the right name at the wrong scale.
        for (token, symbol, decimals) in [
            (WETH, "USDC", 6),
            (USDC, "WETH", 6),
            (USDC, "USDC", 18),
            (USDC, "usdc", 6),
        ] {
            let mut p = usdc_proposal.clone();
            (p.token, p.token_symbol, p.token_decimals) = (token, symbol.into(), decimals);
            assert!(usdc.check_params_token(&p).is_err(), "{symbol} {decimals}");
            let mut o = usdc.clone();
            (o.token, o.token_symbol, o.token_decimals) = (token, symbol.into(), decimals);
            assert!(usdc.check_same_token(&o).is_err(), "{symbol} {decimals}");
        }
        let mut other_lock = usdc.clone();
        other_lock.contract = [0x12; 20];
        assert!(usdc.check_same_token(&other_lock).is_err());
    }

    #[test]
    fn token_metadata_must_match_the_flags() {
        let weth = TokenInfo {
            symbol: "WETH".into(),
            decimals: 18,
        };
        check_token_metadata(&weth, "WETH", 18).unwrap();
        let err = check_token_metadata(&weth, "WETH", 6).unwrap_err();
        assert!(err.contains("decimals() is 18"), "{err}");
        let err = check_token_metadata(&weth, "USDC", 18).unwrap_err();
        assert!(err.contains("symbol() is \"WETH\""), "{err}");
        assert!(check_token_metadata(&weth, "weth", 18).is_err());
        let usdc = TokenInfo {
            symbol: "USDC".into(),
            decimals: 6,
        };
        check_token_metadata(&usdc, "USDC", 6).unwrap();
        assert!(check_token_metadata(&usdc, "USDC", 18).is_err());
    }

    #[test]
    fn feed_pair_must_have_the_token_decimals() {
        let pair = |s: &str| s.parse::<crate::pricefeed::Pair>().unwrap();
        check_feed_pair(pair("ZEC/USDC"), 6).unwrap();
        check_feed_pair(pair("ZEC/USD"), 6).unwrap();
        check_feed_pair(pair("ZEC/ETH"), 18).unwrap();
        check_feed_pair(pair("ZEC/WETH"), 18).unwrap();
        assert!(check_feed_pair(pair("ZEC/USDC"), 18).is_err());
        assert!(check_feed_pair(pair("ZEC/ETH"), 6).is_err());
        assert!(check_feed_pair(pair("ZEC/BTC"), 6).is_err());
    }

    /// Quotes at 18 decimals are exact up to the per-swap cap and refused above it.
    #[test]
    fn weth_quotes_and_the_swap_cap() {
        let weth = weth();
        assert_eq!(weth.token_for(100_000_000), Some(12_000_000_000_000_000));
        assert_eq!(
            weth.token_for(153_722_867_280),
            Some(18_446_744_073_600_000_000)
        );
        assert_eq!(weth.token_for(153_722_867_281), None);
        assert_eq!(weth.swap_cap(), "18.446744073709551615 WETH");
        // USDC at 40 per ZEC: even u64::MAX / 100 zat (far more ZEC than exists) fits.
        assert_eq!(
            usdc().token_for(u64::MAX / 100),
            Some(73_786_976_294_838_206)
        );
    }
}
