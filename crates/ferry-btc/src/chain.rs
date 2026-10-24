//! The counter-chain of a swap: Bitcoin or Litecoin, plus its network.
//!
//! Litecoin (Core ≥ 0.21.2) runs the same transaction format, Taproot, BIP340/341 sighash and
//! script rules as Bitcoin (checked against litecoind 0.21.5.6 regtest, see docs/LITECOIN.md),
//! so rust-bitcoin's `Transaction`, `ScriptBuf` and `Address` are reused as-is. An `Address` is
//! only a typed scriptPubKey here; what differs per chain is how it is written as text
//! (bech32 hrp, base58 version bytes) and a few relay/timing defaults, which live on [`Chain`].
//!
//! Internally a Litecoin address carries the rust-bitcoin [`Network`] of the same tier
//! (mainnet = `Network::Bitcoin`, `Testnet`, `Regtest`), so `require_network` and
//! `is_valid_for_network` keep working; convert to and from text only with
//! [`Chain::encode_address`] / [`Chain::parse_address`].

use std::fmt;
use std::str::FromStr;

use bitcoin::address::{Address, NetworkUnchecked};
use bitcoin::bech32::{self, Fe32, Hrp};
use bitcoin::hashes::Hash;
use bitcoin::script::{Script, ScriptBuf};
use bitcoin::{Amount, FeeRate, Network, PubkeyHash, ScriptHash, WitnessProgram, WitnessVersion};
use serde::{Deserialize, Serialize};

/// The coin on the non-Zcash side of the swap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Coin {
    #[default]
    #[serde(alias = "bitcoin")]
    Btc,
    #[serde(alias = "litecoin")]
    Ltc,
}

impl Coin {
    /// Ticker: `BTC`, `LTC`.
    pub fn ticker(self) -> &'static str {
        match self {
            Coin::Btc => "BTC",
            Coin::Ltc => "LTC",
        }
    }

    /// `Bitcoin`, `Litecoin`.
    pub fn name(self) -> &'static str {
        match self {
            Coin::Btc => "Bitcoin",
            Coin::Ltc => "Litecoin",
        }
    }

    /// Smallest unit (1e-8 of a coin): `sat`, `lit` (litoshi).
    pub fn base_unit(self) -> &'static str {
        match self {
            Coin::Btc => "sat",
            Coin::Ltc => "lit",
        }
    }

    /// `address_type` for the node's `getnewaddress`. Litecoin Core 0.21's wallet has no
    /// `bech32m` type (it cannot make Taproot addresses, though it validates and pays them).
    pub fn wallet_address_type(self) -> &'static str {
        match self {
            Coin::Btc => "bech32m",
            Coin::Ltc => "bech32",
        }
    }

    /// Target block interval in seconds.
    pub fn block_time_secs(self) -> u64 {
        match self {
            Coin::Btc => 600,
            Coin::Ltc => 150,
        }
    }

    pub fn is_btc(&self) -> bool {
        *self == Coin::Btc
    }

    /// Whether the node has `submitpackage` (package relay and package CPFP): Bitcoin Core ≥ 28,
    /// which Ferry pins, has it; Litecoin Core 0.21 has only a one-transaction `testmempoolaccept`
    /// and no package submission, so a fee bump there only ever sends a child after its parent is
    /// already in the mempool.
    pub fn supports_packages(self) -> bool {
        match self {
            Coin::Btc => true,
            Coin::Ltc => false,
        }
    }

    /// The node's default `-dustrelayfee`: 3 sat/vB on Bitcoin Core, 30 lit/vB on Litecoin Core
    /// (measured with `testmempoolaccept` on litecoind 0.21.5.6).
    pub fn dust_relay_fee(self) -> FeeRate {
        match self {
            Coin::Btc => FeeRate::from_sat_per_vb_u32(3),
            Coin::Ltc => FeeRate::from_sat_per_vb_u32(30),
        }
    }

    /// Smallest value the node relays in an output paying to `spk`
    /// (BTC: P2TR 330, P2WPKH 294, P2PKH 546; LTC ten times that).
    pub fn dust(self, spk: &Script) -> Amount {
        spk.minimal_non_dust_custom(self.dust_relay_fee())
    }

    /// Dust floor of every standard output type: that of P2PKH, the largest (BTC 546, LTC 5460).
    pub fn dust_limit(self) -> Amount {
        self.dust(&ScriptBuf::new_p2pkh(&PubkeyHash::all_zeros()))
    }
}

impl fmt::Display for Coin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Coin::Btc => "btc",
            Coin::Ltc => "ltc",
        })
    }
}

impl FromStr for Coin {
    type Err = ChainError;
    fn from_str(s: &str) -> Result<Self, ChainError> {
        match s.to_ascii_lowercase().as_str() {
            "btc" | "bitcoin" => Ok(Coin::Btc),
            "ltc" | "litecoin" => Ok(Coin::Ltc),
            _ => Err(ChainError::UnknownCoin(s.into())),
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ChainError {
    #[error("unknown chain {0:?} (expected btc or ltc)")]
    UnknownCoin(String),
    #[error("{0} has no {1} network")]
    NoSuchNetwork(&'static str, Network),
    #[error("not a {chain} {network} address: {reason}")]
    BadAddress {
        chain: &'static str,
        network: Network,
        reason: String,
    },
}

/// A coin on one of its networks. Litecoin has mainnet (`Network::Bitcoin`), testnet
/// (`Network::Testnet`, Litecoin's testnet4) and regtest; no signet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Chain {
    pub coin: Coin,
    pub network: Network,
}

impl Chain {
    pub fn new(coin: Coin, network: Network) -> Result<Chain, ChainError> {
        match (coin, network) {
            (Coin::Ltc, Network::Signet | Network::Testnet4) => {
                Err(ChainError::NoSuchNetwork(coin.name(), network))
            }
            _ => Ok(Chain { coin, network }),
        }
    }

    pub fn bitcoin(network: Network) -> Chain {
        Chain {
            coin: Coin::Btc,
            network,
        }
    }

    pub fn ticker(&self) -> &'static str {
        self.coin.ticker()
    }

    /// Bech32 human-readable part of segwit addresses.
    pub fn hrp(&self) -> &'static str {
        match (self.coin, self.network) {
            (Coin::Btc, Network::Bitcoin) => "bc",
            (Coin::Btc, Network::Regtest) => "bcrt",
            (Coin::Btc, _) => "tb",
            (Coin::Ltc, Network::Bitcoin) => "ltc",
            (Coin::Ltc, Network::Regtest) => "rltc",
            (Coin::Ltc, _) => "tltc",
        }
    }

    /// (P2PKH, P2SH) base58 version bytes; Litecoin mainnet also accepts the legacy `3...`
    /// P2SH version (0x05) when parsing.
    fn base58_versions(&self) -> (u8, u8) {
        match (self.coin, self.network) {
            (Coin::Btc, Network::Bitcoin) => (0x00, 0x05),
            (Coin::Btc, _) => (0x6f, 0xc4),
            (Coin::Ltc, Network::Bitcoin) => (0x30, 0x32),
            (Coin::Ltc, _) => (0x6f, 0x3a),
        }
    }

    pub fn wallet_address_type(&self) -> &'static str {
        self.coin.wallet_address_type()
    }

    /// Smallest output value the node relays for any standard output we may pay to.
    pub fn dust_limit(&self) -> Amount {
        self.coin.dust_limit()
    }

    /// Default confirmations to wait for on a lock or cancel transaction: about 20 minutes of
    /// blocks on mainnet, 1-2 on the test networks.
    pub fn default_confirmations(&self) -> u32 {
        match (self.coin, self.network) {
            (_, Network::Regtest) => 1,
            (Coin::Btc, Network::Bitcoin) => 2,
            (Coin::Ltc, Network::Bitcoin) => 8,
            (Coin::Btc, _) => 1,
            (Coin::Ltc, _) => 2,
        }
    }

    pub fn block_time_secs(&self) -> u64 {
        self.coin.block_time_secs()
    }

    /// Text form of `addr` on this chain.
    pub fn encode_address(&self, addr: &Address) -> String {
        if self.coin == Coin::Btc {
            return addr.to_string();
        }
        self.encode_script(&addr.script_pubkey())
            .expect("an Address is always a standard, encodable scriptPubKey")
    }

    /// Text form of a scriptPubKey, if it has one (P2PKH, P2SH or a witness program).
    pub fn encode_script(&self, spk: &ScriptBuf) -> Option<String> {
        if let Some(version) = spk.witness_version() {
            let program = &spk.as_bytes()[2..];
            let hrp = Hrp::parse(self.hrp()).expect("static hrp is valid");
            let fe = Fe32::try_from(version.to_num()).ok()?;
            return bech32::segwit::encode(hrp, fe, program).ok();
        }
        let (p2pkh, p2sh) = self.base58_versions();
        let b = spk.as_bytes();
        let (version, hash) = if spk.is_p2pkh() {
            (p2pkh, &b[3..23])
        } else if spk.is_p2sh() {
            (p2sh, &b[2..22])
        } else {
            return None;
        };
        let mut data = vec![version];
        data.extend_from_slice(hash);
        Some(bitcoin::base58::encode_check(&data))
    }

    /// Parse a text address of this chain into an `Address` of `self.network`.
    pub fn parse_address(&self, s: &str) -> Result<Address, ChainError> {
        let bad = |reason: String| ChainError::BadAddress {
            chain: self.coin.name(),
            network: self.network,
            reason,
        };
        let s = s.trim();
        if self.coin == Coin::Btc {
            return s
                .parse::<Address<NetworkUnchecked>>()
                .map_err(|e| bad(e.to_string()))?
                .require_network(self.network)
                .map_err(|e| bad(e.to_string()));
        }
        let spk = self.parse_script(s).map_err(bad)?;
        Address::from_script(&spk, self.network).map_err(|e| bad(e.to_string()))
    }

    fn parse_script(&self, s: &str) -> Result<ScriptBuf, String> {
        let lower = s.to_ascii_lowercase();
        if lower.starts_with(&format!("{}1", self.hrp())) {
            let (hrp, version, program) = bech32::segwit::decode(s).map_err(|e| e.to_string())?;
            if hrp.as_str() != self.hrp() {
                return Err(format!("hrp {hrp} (expected {})", self.hrp()));
            }
            let version = WitnessVersion::try_from(version.to_u8()).map_err(|e| e.to_string())?;
            let wp = WitnessProgram::new(version, &program).map_err(|e| e.to_string())?;
            return Ok(ScriptBuf::new_witness_program(&wp));
        }
        if lower.contains("mweb1") {
            return Err("MWEB addresses cannot receive a swap payout".into());
        }
        let data = bitcoin::base58::decode_check(s).map_err(|_| {
            format!(
                "expected a {}1... segwit address or a base58 address",
                self.hrp()
            )
        })?;
        if data.len() != 21 {
            return Err("base58 payload is not 21 bytes".into());
        }
        let (p2pkh, p2sh) = self.base58_versions();
        let legacy_p2sh =
            self.coin == Coin::Ltc && self.network == Network::Bitcoin && data[0] == 0x05;
        let hash: [u8; 20] = data[1..].try_into().expect("21 - 1 bytes");
        if data[0] == p2pkh {
            Ok(ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array(hash)))
        } else if data[0] == p2sh || legacy_p2sh {
            Ok(ScriptBuf::new_p2sh(&ScriptHash::from_byte_array(hash)))
        } else {
            Err(format!("base58 version byte {:#04x}", data[0]))
        }
    }
}

impl fmt::Display for Chain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.coin, self.network)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::key::Secp256k1;

    fn ltc(network: Network) -> Chain {
        Chain::new(Coin::Ltc, network).unwrap()
    }

    #[test]
    fn dust_matches_the_nodes() {
        let secp = Secp256k1::new();
        let k = crate::BtcKey::random().xonly();
        let p2tr = ScriptBuf::new_p2tr(&secp, k, None);
        let p2wpkh = ScriptBuf::new_p2wpkh(&bitcoin::WPubkeyHash::all_zeros());
        let p2pkh = ScriptBuf::new_p2pkh(&PubkeyHash::all_zeros());
        let sat = |c: Coin, s: &ScriptBuf| c.dust(s).to_sat();
        // Bitcoin Core defaults
        assert_eq!(
            [
                sat(Coin::Btc, &p2tr),
                sat(Coin::Btc, &p2wpkh),
                sat(Coin::Btc, &p2pkh)
            ],
            [330, 294, 546]
        );
        // litecoind 0.21.5.6 testmempoolaccept: smallest accepted value per type
        assert_eq!(
            [
                sat(Coin::Ltc, &p2tr),
                sat(Coin::Ltc, &p2wpkh),
                sat(Coin::Ltc, &p2pkh)
            ],
            [3300, 2940, 5460]
        );
        assert_eq!(Coin::Ltc.dust_limit(), Amount::from_sat(5460));
    }

    #[test]
    fn coin_names() {
        assert_eq!("LTC".parse::<Coin>().unwrap(), Coin::Ltc);
        assert_eq!("bitcoin".parse::<Coin>().unwrap(), Coin::Btc);
        assert!("doge".parse::<Coin>().is_err());
        assert_eq!(serde_json::to_string(&Coin::Ltc).unwrap(), "\"ltc\"");
        assert_eq!(Coin::Ltc.base_unit(), "lit");
        assert!(Chain::new(Coin::Ltc, Network::Signet).is_err());
        assert_eq!(ltc(Network::Regtest).to_string(), "ltc/regtest");
    }

    /// Vectors produced by litecoind 0.21.5.6 regtest (`getnewaddress`, `validateaddress`).
    #[test]
    fn litecoind_regtest_vectors() {
        let c = ltc(Network::Regtest);
        for (s, kind) in [
            ("rltc1qw27r6n6natnqq85lxda2fc5jjvday3lnt5utj3", "p2wpkh"),
            ("mgiYMiKfxcUfKCq12DtcE3M3kZLuC1mvaJ", "p2pkh"),
            ("QLjoMKbm1eGg9vPKJgwGZ6itZt3HkQShma", "p2sh"),
        ] {
            let a = c.parse_address(s).unwrap();
            let spk = a.script_pubkey();
            let ok = match kind {
                "p2wpkh" => spk.is_p2wpkh(),
                "p2pkh" => spk.is_p2pkh(),
                _ => spk.is_p2sh(),
            };
            assert!(ok, "{s} is {kind}");
            assert!(a.as_unchecked().is_valid_for_network(Network::Regtest));
            assert_eq!(c.encode_address(&a), s);
        }
        assert!(c.parse_address("tmweb1qq06desw6mgsgzxennvk0ne59ctwqrvgdauyqch44lpqm4qer6au8zq4zd0errp27fgmx0qh7p0955kzjqxfvlq9vccav7mdn4jq9faspacvutwyr").is_err());
    }

    #[test]
    fn taproot_round_trip_every_network() {
        let secp = Secp256k1::new();
        let key = crate::BtcKey::random().xonly();
        for (network, hrp) in [
            (Network::Bitcoin, "ltc1p"),
            (Network::Testnet, "tltc1p"),
            (Network::Regtest, "rltc1p"),
        ] {
            let c = ltc(network);
            let a = Address::p2tr(&secp, key, None, network);
            let s = c.encode_address(&a);
            assert!(s.starts_with(hrp), "{s}");
            assert_eq!(c.parse_address(&s).unwrap(), a);
            // The Bitcoin encoding of the same output is rejected, and vice versa.
            assert!(c.parse_address(&a.to_string()).is_err());
            assert!(Chain::bitcoin(network).parse_address(&s).is_err());
        }
    }

    #[test]
    fn litecoin_mainnet_base58() {
        let c = ltc(Network::Bitcoin);
        let h = [7u8; 20];
        let p2pkh = Address::from_script(
            &ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array(h)),
            Network::Bitcoin,
        )
        .unwrap();
        let s = c.encode_address(&p2pkh);
        assert!(s.starts_with('L'), "{s}");
        assert_eq!(c.parse_address(&s).unwrap(), p2pkh);
        let p2sh = Address::from_script(
            &ScriptBuf::new_p2sh(&ScriptHash::from_byte_array(h)),
            Network::Bitcoin,
        )
        .unwrap();
        let s = c.encode_address(&p2sh);
        assert!(s.starts_with('M'), "{s}");
        assert_eq!(c.parse_address(&s).unwrap(), p2sh);
        // legacy 3... P2SH still parses on Litecoin mainnet
        assert_eq!(c.parse_address(&p2sh.to_string()).unwrap(), p2sh);
    }

    #[test]
    fn bitcoin_passthrough() {
        let c = Chain::bitcoin(Network::Regtest);
        let secp = Secp256k1::new();
        let a = Address::p2tr(
            &secp,
            crate::BtcKey::random().xonly(),
            None,
            Network::Regtest,
        );
        assert_eq!(c.encode_address(&a), a.to_string());
        assert_eq!(c.parse_address(&a.to_string()).unwrap(), a);
        assert!(Chain::bitcoin(Network::Bitcoin)
            .parse_address(&a.to_string())
            .is_err());
        assert_eq!(c.wallet_address_type(), "bech32m");
        assert_eq!(c.dust_limit(), Amount::from_sat(546));
    }
}
