//! What an owner hands the tower, and the checks it passes before the tower arms it.
//!
//! A package holds only fully signed transactions that pay the owner (or the swap's own
//! cancel output). The tower holds no keys, so the worst it can do on its own is fail to act.
//! B's completed tx_refund is still sensitive: see docs/WATCHTOWER.md ("What a tower can do").

use std::collections::BTreeSet;

use ferry_btc::bitcoin::consensus::encode::{deserialize_hex, serialize_hex};
use ferry_btc::bitcoin::{
    Address, Amount, Network, OutPoint, ScriptBuf, Transaction, Txid, XOnlyPublicKey,
};
use ferry_btc::{adaptor, Chain, Coin, Role, Spend, SwapScripts, SwapTxs};
use serde::{Deserialize, Serialize};

use crate::engine::Rules;

pub const PACKAGE_VERSION: u32 = 1;

/// `POST /packages` body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Package {
    pub version: u32,
    /// The owner's role: B delegates cancel + refund, Z delegates cancel + punish.
    pub role: Role,
    /// The counter-chain: `btc` (the default, omitted) or `ltc`. Litecoin runs the same
    /// transactions and scripts; only the node and the address encoding differ.
    #[serde(default, skip_serializing_if = "Coin::is_btc")]
    pub coin: Coin,
    /// The network tier (`regtest`, `testnet`, `bitcoin` = mainnet), for either coin.
    pub network: Network,
    /// The swap's lock output (`txid:vout`).
    pub lock_outpoint: OutPoint,
    pub lock_amount_sat: u64,
    /// B's and Z's BTC keys (x-only hex), which define the lock and cancel scripts.
    pub kb: XOnlyPublicKey,
    pub kz: XOnlyPublicKey,
    /// The lock's internal key is the MuSig2 aggregate of kb and kz.
    pub keypath: bool,
    pub t1: u16,
    pub t2: u16,
    /// k: tx_cancel confirmations before tx_refund.
    pub cancel_confirmations: u32,
    /// Δ: no tx_refund once tx_cancel has `t2 − refund_margin` confirmations.
    pub refund_margin: u16,
    /// Fully signed tx_cancel (consensus hex).
    pub cancel_tx: String,
    /// B: fully signed tx_refund (Z's decrypted adaptor signature plus B's own).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refund_tx: Option<String>,
    /// Z: fully signed tx_punish.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub punish_tx: Option<String>,
    /// Addresses the owner accepts as payout of tx_refund / tx_punish, in the coin's own
    /// encoding (`bcrt1…` for Bitcoin, `rltc1…` for Litecoin).
    pub payout_addresses: Vec<String>,
    /// Free text for the owner (e.g. its swap id). Shown back by `GET /packages/:id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("invalid package: {0}")]
pub struct PackageError(pub String);

fn bad<T>(msg: impl Into<String>) -> Result<T, PackageError> {
    Err(PackageError(msg.into()))
}

/// A package that passed validation, with everything the tower needs to watch and act.
#[derive(Clone, Debug)]
pub struct Armed {
    pub rules: Rules,
    pub lock_outpoint: OutPoint,
    pub lock_script: ScriptBuf,
    pub lock_amount: Amount,
    pub lock_address: Address,
    pub cancel: Transaction,
    pub cancel_outpoint: OutPoint,
    pub cancel_address: Address,
    /// tx_refund (B) or tx_punish (Z).
    pub final_tx: Transaction,
}

impl Armed {
    pub fn tx(&self, spend: Spend) -> Option<&Transaction> {
        match spend {
            Spend::Cancel => Some(&self.cancel),
            s if s == self.rules.final_spend() => Some(&self.final_tx),
            _ => None,
        }
    }

    pub fn cancel_txid(&self) -> Txid {
        self.cancel.compute_txid()
    }

    pub fn final_txid(&self) -> Txid {
        self.final_tx.compute_txid()
    }
}

impl Package {
    /// Build a package from the swap's templates and the owner's signed transactions.
    /// `final_tx` is tx_refund for B and tx_punish for Z.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        role: Role,
        chain: Chain,
        txs: &SwapTxs,
        cancel_confirmations: u32,
        refund_margin: u16,
        cancel_tx: &Transaction,
        final_tx: &Transaction,
        payout_addresses: &[Address],
    ) -> Package {
        let s = &txs.scripts;
        let (refund_tx, punish_tx) = match role {
            Role::B => (Some(serialize_hex(final_tx)), None),
            Role::Z => (None, Some(serialize_hex(final_tx))),
        };
        Package {
            version: PACKAGE_VERSION,
            role,
            coin: chain.coin,
            network: chain.network,
            lock_outpoint: txs.lock_outpoint,
            lock_amount_sat: txs.lock_txout.value.to_sat(),
            kb: s.kb,
            kz: s.kz,
            keypath: s.keypath,
            t1: s.t1,
            t2: s.t2,
            cancel_confirmations,
            refund_margin,
            cancel_tx: serialize_hex(cancel_tx),
            refund_tx,
            punish_tx,
            payout_addresses: payout_addresses
                .iter()
                .map(|a| chain.encode_address(a))
                .collect(),
            label: None,
        }
    }

    pub fn chain(&self) -> Chain {
        Chain {
            coin: self.coin,
            network: self.network,
        }
    }

    pub fn rules(&self) -> Rules {
        Rules {
            role: self.role,
            t1: self.t1,
            t2: self.t2,
            cancel_confirmations: self.cancel_confirmations,
            refund_margin: self.refund_margin,
        }
    }

    /// Check everything the tower can check offline:
    /// - the timing terms leave a refund window (as `SwapParams::validate` requires);
    /// - every transaction parses, is 1-in-1-out and spends the expected outpoint: tx_cancel
    ///   the lock, tx_refund / tx_punish the output of this tx_cancel;
    /// - each one is exactly the swap's template (rebuilt from kb, kz, T1, T2, the lock and
    ///   the fee), so the timelocks and the cancel script are the agreed ones;
    /// - every signature verifies, with the right leaf and control block;
    /// - tx_refund / tx_punish pays one of `payout_addresses`.
    pub fn validate(&self, chain: Chain) -> Result<Armed, PackageError> {
        if self.version != PACKAGE_VERSION {
            return bad(format!("unsupported version {}", self.version));
        }
        if self.chain() != chain {
            return bad(format!(
                "package is for {} {}, this tower watches {} {}",
                self.coin.name(),
                self.network,
                chain.coin.name(),
                chain.network
            ));
        }
        let network = chain.network;
        let rules = self.rules();
        if self.t1 == 0 || self.t2 == 0 {
            return bad("t1 and t2 must be positive");
        }
        if self.cancel_confirmations == 0 || self.refund_margin == 0 {
            return bad("cancel_confirmations and refund_margin must be at least 1");
        }
        if u32::from(self.t2) <= u32::from(self.refund_margin) + self.cancel_confirmations {
            return bad("t2 leaves no refund window");
        }
        let final_hex = match (self.role, &self.refund_tx, &self.punish_tx) {
            (Role::B, Some(r), None) => r,
            (Role::Z, None, Some(p)) => p,
            (Role::B, ..) => return bad("a B package carries refund_tx and no punish_tx"),
            (Role::Z, ..) => return bad("a Z package carries punish_tx and no refund_tx"),
        };
        let payouts = self.payout_scripts(chain)?;
        let cancel = parse_tx("cancel_tx", &self.cancel_tx)?;
        let final_tx = parse_tx(
            if self.role == Role::B {
                "refund_tx"
            } else {
                "punish_tx"
            },
            final_hex,
        )?;
        for (name, tx) in [("cancel_tx", &cancel), ("final tx", &final_tx)] {
            if tx.input.len() != 1 || tx.output.len() != 1 {
                return bad(format!("{name} must have one input and one output"));
            }
        }
        if cancel.input[0].previous_output != self.lock_outpoint {
            return bad("cancel_tx does not spend lock_outpoint");
        }
        let cancel_outpoint = OutPoint {
            txid: cancel.compute_txid(),
            vout: 0,
        };
        if final_tx.input[0].previous_output != cancel_outpoint {
            return bad("the refund/punish tx does not spend the output of cancel_tx");
        }
        let payout = final_tx.output[0].script_pubkey.clone();
        if !payouts.contains(&payout) {
            return bad("the refund/punish tx does not pay any of payout_addresses");
        }

        let lock_amount = Amount::from_sat(self.lock_amount_sat);
        let fee = lock_amount
            .checked_sub(cancel.output[0].value)
            .filter(|f| *f > Amount::ZERO)
            .ok_or_else(|| PackageError("cancel_tx pays more than the lock holds".into()))?;
        let scripts = SwapScripts::new(self.kb, self.kz, self.t1, self.t2, self.keypath);
        // Same templates on either coin; only the dust floor of its outputs differs.
        let txs = SwapTxs::new(
            self.coin,
            scripts,
            self.lock_outpoint,
            lock_amount,
            fee,
            payout.clone(),
            payout.clone(),
            payout,
        )
        .map_err(|e| PackageError(e.to_string()))?;
        let spend = rules.final_spend();
        if txs.txid(Spend::Cancel) != cancel.compute_txid() {
            return bad("cancel_tx is not the swap's tx_cancel (script, timelock or amount)");
        }
        if txs.txid(spend) != final_tx.compute_txid() {
            return bad("the refund/punish tx is not the swap's template (timelock or fee)");
        }
        check_signed(&txs, Spend::Cancel, &cancel)?;
        check_signed(&txs, spend, &final_tx)?;

        Ok(Armed {
            rules,
            lock_outpoint: self.lock_outpoint,
            lock_script: txs.lock_txout.script_pubkey.clone(),
            lock_amount,
            lock_address: txs.scripts.lock.address(network),
            cancel,
            cancel_outpoint,
            cancel_address: txs.scripts.cancel_out.address(network),
            final_tx,
        })
    }

    fn payout_scripts(&self, chain: Chain) -> Result<BTreeSet<ScriptBuf>, PackageError> {
        if self.payout_addresses.is_empty() {
            return bad("payout_addresses is empty");
        }
        self.payout_addresses
            .iter()
            .map(|a| {
                chain
                    .parse_address(a)
                    .map(|a| a.script_pubkey())
                    .map_err(|e| PackageError(format!("payout address {a}: {e}")))
            })
            .collect()
    }
}

fn parse_tx(name: &str, hex: &str) -> Result<Transaction, PackageError> {
    deserialize_hex(hex.trim()).map_err(|e| PackageError(format!("{name}: {e}")))
}

/// Every signature `tx` carries verifies, and the witness is exactly what the template
/// produces with them (right leaf, right control block, nothing extra).
fn check_signed(txs: &SwapTxs, spend: Spend, tx: &Transaction) -> Result<(), PackageError> {
    let name = crate::engine::spend_name(spend);
    let hash = txs.sighash(spend);
    let sig = |role: Role| {
        SwapTxs::witness_sig(tx, spend, role).map_err(|e| PackageError(format!("{name}: {e}")))
    };
    let s = &txs.scripts;
    let rebuilt = match spend {
        Spend::Punish => {
            let sig_z = sig(Role::Z)?;
            if !adaptor::verify(&s.kz, &hash, &sig_z) {
                return bad(format!("{name}: Z's signature does not verify"));
            }
            txs.complete_punish(&sig_z)
        }
        _ => {
            let (sig_b, sig_z) = (sig(Role::B)?, sig(Role::Z)?);
            if !adaptor::verify(&s.kb, &hash, &sig_b) {
                return bad(format!("{name}: B's signature does not verify"));
            }
            if !adaptor::verify(&s.kz, &hash, &sig_z) {
                return bad(format!("{name}: Z's signature does not verify"));
            }
            txs.complete(spend, &sig_b, &sig_z)
                .map_err(|e| PackageError(e.to_string()))?
        }
    };
    if rebuilt != *tx {
        return bad(format!(
            "{name}: unexpected witness (leaf or control block)"
        ));
    }
    Ok(())
}

/// Helpers that build real signed packages without a node (tests, and the daemon's own
/// tests later).
pub mod testkit {
    use super::*;
    use ferry_btc::adaptor::EncryptionKey;
    use ferry_btc::bitcoin::hashes::Hash;
    use ferry_btc::bitcoin::key::Secp256k1;
    use ferry_btc::BtcKey;

    /// Both parties' keys and the swap templates for one lock outpoint.
    pub struct Swap {
        pub kb: BtcKey,
        pub kz: BtcKey,
        /// B's Zcash key share on secp256k1 (`b`); Z's refund adaptor is encrypted under it.
        pub b_share: [u8; 32],
        pub txs: SwapTxs,
        pub b_payout: Address,
        pub z_payout: Address,
        pub coin: Coin,
        pub network: Network,
    }

    pub fn p2tr(network: Network, key: &BtcKey) -> Address {
        Address::p2tr(&Secp256k1::new(), key.xonly(), None, network)
    }

    impl Swap {
        /// Fresh keys and payout addresses; the lock outpoint is a dummy until
        /// [`Swap::set_lock`] (fund [`Swap::lock_address`] first).
        pub fn offline(t1: u16, t2: u16) -> Swap {
            Self::offline_on(Coin::Btc, t1, t2)
        }

        /// [`Swap::offline`] on `coin` (regtest).
        pub fn offline_on(coin: Coin, t1: u16, t2: u16) -> Swap {
            let network = Network::Regtest;
            let (kb, kz) = (BtcKey::random(), BtcKey::random());
            let b_share = *BtcKey::random().secret_bytes();
            let (b_payout, z_payout) = (
                p2tr(network, &BtcKey::random()),
                p2tr(network, &BtcKey::random()),
            );
            let lock = OutPoint {
                txid: Txid::from_byte_array([7; 32]),
                vout: 1,
            };
            let txs = Self::templates(
                coin,
                &kb,
                &kz,
                t1,
                t2,
                lock,
                Amount::from_sat(1_000_000),
                &b_payout,
                &z_payout,
            );
            Swap {
                kb,
                kz,
                b_share,
                txs,
                b_payout,
                z_payout,
                coin,
                network,
            }
        }

        pub fn chain(&self) -> Chain {
            Chain {
                coin: self.coin,
                network: self.network,
            }
        }

        #[allow(clippy::too_many_arguments)]
        fn templates(
            coin: Coin,
            kb: &BtcKey,
            kz: &BtcKey,
            t1: u16,
            t2: u16,
            lock: OutPoint,
            amount: Amount,
            b_payout: &Address,
            z_payout: &Address,
        ) -> SwapTxs {
            SwapTxs::new(
                coin,
                SwapScripts::new(kb.xonly(), kz.xonly(), t1, t2, true),
                lock,
                amount,
                Amount::from_sat(2_000),
                z_payout.script_pubkey(),
                b_payout.script_pubkey(),
                z_payout.script_pubkey(),
            )
            .expect("amount covers fees")
        }

        pub fn lock_address(&self) -> Address {
            self.txs.scripts.lock.address(self.network)
        }

        /// Rebuild the templates for the real lock output.
        pub fn set_lock(&mut self, lock: OutPoint, amount: Amount) {
            let s = &self.txs.scripts;
            self.txs = Self::templates(
                self.coin,
                &self.kb,
                &self.kz,
                s.t1,
                s.t2,
                lock,
                amount,
                &self.b_payout,
                &self.z_payout,
            );
        }

        pub fn cancel(&self) -> Transaction {
            let h = self.txs.sighash(Spend::Cancel);
            self.txs
                .complete(Spend::Cancel, &self.kb.sign(&h), &self.kz.sign(&h))
                .expect("two-party leaf")
        }

        /// B's completed refund: Z's adaptor signature under B_s, decrypted with b.
        pub fn refund(&self) -> Transaction {
            let h = self.txs.sighash(Spend::Refund);
            let b_s = EncryptionKey::from_secret(&self.b_share).expect("valid share");
            let enc = self.kz.encrypted_sign(&b_s, &h);
            let sig_z = adaptor::decrypt(&self.b_share, &enc).expect("decrypts");
            self.txs
                .complete(Spend::Refund, &self.kb.sign(&h), &sig_z)
                .expect("two-party leaf")
        }

        /// tx_redeem through the script path (both signatures; tests only).
        pub fn redeem(&self) -> Transaction {
            let h = self.txs.sighash(Spend::Redeem);
            self.txs
                .complete(Spend::Redeem, &self.kb.sign(&h), &self.kz.sign(&h))
                .expect("two-party leaf")
        }

        pub fn punish(&self) -> Transaction {
            let h = self.txs.sighash(Spend::Punish);
            self.txs.complete_punish(&self.kz.sign(&h))
        }

        pub fn b_package(&self, k: u32, delta: u16) -> Package {
            Package::new(
                Role::B,
                self.chain(),
                &self.txs,
                k,
                delta,
                &self.cancel(),
                &self.refund(),
                std::slice::from_ref(&self.b_payout),
            )
        }

        pub fn z_package(&self, k: u32, delta: u16) -> Package {
            Package::new(
                Role::Z,
                self.chain(),
                &self.txs,
                k,
                delta,
                &self.cancel(),
                &self.punish(),
                std::slice::from_ref(&self.z_payout),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::{p2tr, Swap};
    use super::*;
    use ferry_btc::bitcoin::Sequence;
    use ferry_btc::BtcKey;

    const REGTEST: Chain = Chain {
        coin: Coin::Btc,
        network: Network::Regtest,
    };

    fn reject(p: &Package, needle: &str) {
        reject_on(REGTEST, p, needle);
    }

    #[test]
    fn good_packages_validate_and_round_trip() {
        let s = Swap::offline(6, 10);
        for p in [s.b_package(2, 3), s.z_package(2, 3)] {
            let json = serde_json::to_string(&p).unwrap();
            let back: Package = serde_json::from_str(&json).unwrap();
            assert_eq!(back, p);
            let armed = back.validate(REGTEST).unwrap();
            assert_eq!(armed.cancel_txid(), s.txs.txid(Spend::Cancel));
            assert_eq!(
                armed.lock_address,
                s.txs.scripts.lock.address(Network::Regtest)
            );
            assert_eq!(armed.cancel_outpoint.txid, s.txs.txid(Spend::Cancel));
        }
        let b = s.b_package(2, 3).validate(REGTEST).unwrap();
        assert_eq!(b.final_txid(), s.txs.txid(Spend::Refund));
        let z = s.z_package(2, 3).validate(REGTEST).unwrap();
        assert_eq!(z.final_txid(), s.txs.txid(Spend::Punish));
        let json = serde_json::to_value(s.b_package(2, 3)).unwrap();
        assert_eq!(json["network"], "regtest");
        assert_eq!(json["role"], "B");
        assert!(json["lock_outpoint"].as_str().unwrap().ends_with(":1"));
    }

    #[test]
    fn wrong_network_version_and_role_shape() {
        let s = Swap::offline(6, 10);
        let p = s.b_package(2, 3);
        assert!(p
            .validate(Chain::bitcoin(Network::Signet))
            .unwrap_err()
            .0
            .contains("for Bitcoin regtest"));
        reject(
            &Package {
                version: 2,
                ..p.clone()
            },
            "version",
        );
        reject(
            &Package {
                role: Role::Z,
                ..p.clone()
            },
            "Z package",
        );
        reject(
            &Package {
                punish_tx: Some(serialize_hex(&s.punish())),
                ..p.clone()
            },
            "B package",
        );
    }

    #[test]
    fn litecoin_packages() {
        let ltc = Chain::new(Coin::Ltc, Network::Regtest).unwrap();
        let s = Swap::offline_on(Coin::Ltc, 6, 10);
        for p in [s.b_package(2, 3), s.z_package(2, 3)] {
            let json = serde_json::to_value(&p).unwrap();
            assert_eq!(json["coin"], "ltc");
            assert!(json["payout_addresses"][0]
                .as_str()
                .unwrap()
                .starts_with("rltc1p"));
            let back: Package = serde_json::from_value(json).unwrap();
            let armed = back.validate(ltc).unwrap();
            assert_eq!(armed.lock_address, s.lock_address());
            // A Bitcoin tower refuses it, and a Litecoin tower refuses a Bitcoin package.
            assert!(p
                .validate(REGTEST)
                .unwrap_err()
                .0
                .contains("package is for Litecoin regtest, this tower watches Bitcoin regtest"));
        }
        let btc = Swap::offline(6, 10).z_package(2, 3);
        assert!(btc
            .validate(ltc)
            .unwrap_err()
            .0
            .contains("for Bitcoin regtest"));
        // The coin is omitted for Bitcoin, so packages from before it existed still parse.
        assert!(serde_json::to_value(&btc).unwrap().get("coin").is_none());
        // A payout written as a Bitcoin address (same script) is refused on Litecoin.
        reject_on(
            ltc,
            &Package {
                payout_addresses: vec![s.z_payout.to_string()],
                ..s.z_package(2, 3)
            },
            "payout address",
        );
    }

    fn reject_on(chain: Chain, p: &Package, needle: &str) {
        let err = p.validate(chain).unwrap_err().0;
        assert!(err.contains(needle), "{err:?} does not mention {needle:?}");
    }

    #[test]
    fn timing_terms_need_a_refund_window() {
        let s = Swap::offline(6, 10);
        reject(&s.b_package(7, 3), "no refund window");
        reject(&s.b_package(0, 3), "at least 1");
        reject(&s.b_package(2, 0), "at least 1");
    }

    #[test]
    fn payout_must_be_listed() {
        let s = Swap::offline(6, 10);
        let other = p2tr(Network::Regtest, &BtcKey::random()).to_string();
        reject(
            &Package {
                payout_addresses: vec![other.clone()],
                ..s.b_package(2, 3)
            },
            "does not pay any of payout_addresses",
        );
        reject(
            &Package {
                payout_addresses: vec![],
                ..s.z_package(2, 3)
            },
            "empty",
        );
        // A mainnet address on a regtest tower.
        let main = p2tr(Network::Bitcoin, &BtcKey::random()).to_string();
        reject(
            &Package {
                payout_addresses: vec![main],
                ..s.z_package(2, 3)
            },
            "payout address",
        );
        // Listing extra addresses is fine.
        Package {
            payout_addresses: vec![other, s.z_payout.to_string()],
            ..s.z_package(2, 3)
        }
        .validate(REGTEST)
        .unwrap();
    }

    #[test]
    fn refund_paying_someone_else_is_refused_even_if_listed_differently() {
        // B's package carrying Z's punish slot output: listed only B's address.
        let s = Swap::offline(6, 10);
        let p = Package {
            refund_tx: Some(serialize_hex(&s.punish())),
            ..s.b_package(2, 3)
        };
        reject(&p, "does not pay any of payout_addresses");
    }

    #[test]
    fn outpoints_are_checked() {
        let s = Swap::offline(6, 10);
        let mut p = s.b_package(2, 3);
        p.lock_outpoint.vout = 0;
        reject(&p, "does not spend lock_outpoint");

        let mut refund = s.refund();
        refund.input[0].previous_output.vout = 1;
        reject(
            &Package {
                refund_tx: Some(serialize_hex(&refund)),
                ..s.b_package(2, 3)
            },
            "does not spend the output of cancel_tx",
        );
    }

    #[test]
    fn templates_are_rebuilt() {
        let s = Swap::offline(6, 10);
        // Claimed T1 differs from the one the cancel was signed with.
        reject(
            &Package {
                t1: 5,
                ..s.b_package(2, 3)
            },
            "not the swap's tx_cancel",
        );
        // Claimed keys differ: the cancel output script would differ.
        reject(
            &Package {
                kb: BtcKey::random().xonly(),
                ..s.z_package(2, 3)
            },
            "not the swap's tx_cancel",
        );
        // A punish whose CSV was edited (so the signature no longer matters).
        let mut punish = s.punish();
        punish.input[0].sequence = Sequence::from_height(3);
        reject(
            &Package {
                punish_tx: Some(serialize_hex(&punish)),
                ..s.z_package(2, 3)
            },
            "not the swap's template",
        );
        // A different lock amount means a different fee, so the refund template differs.
        reject(
            &Package {
                lock_amount_sat: 1_000_500,
                ..s.b_package(2, 3)
            },
            "not the swap's template",
        );
    }

    #[test]
    fn signatures_are_verified() {
        let s = Swap::offline(6, 10);
        // Z's refund signature still encrypted (B forgot to decrypt it): invalid.
        let h = s.txs.sighash(Spend::Refund);
        let wrong = s
            .txs
            .complete(Spend::Refund, &s.kb.sign(&h), &BtcKey::random().sign(&h))
            .unwrap();
        reject(
            &Package {
                refund_tx: Some(serialize_hex(&wrong)),
                ..s.b_package(2, 3)
            },
            "Z's signature does not verify",
        );
        let h = s.txs.sighash(Spend::Cancel);
        let wrong = s
            .txs
            .complete(Spend::Cancel, &BtcKey::random().sign(&h), &s.kz.sign(&h))
            .unwrap();
        reject(
            &Package {
                cancel_tx: serialize_hex(&wrong),
                ..s.z_package(2, 3)
            },
            "B's signature does not verify",
        );
        // An unsigned template.
        reject(
            &Package {
                punish_tx: Some(serialize_hex(&s.txs.punish)),
                ..s.z_package(2, 3)
            },
            "tx_punish",
        );
        // Garbage.
        reject(
            &Package {
                cancel_tx: "zz".into(),
                ..s.z_package(2, 3)
            },
            "cancel_tx",
        );
    }

    #[test]
    fn witness_must_match_the_template() {
        let s = Swap::offline(6, 10);
        let mut cancel = s.cancel();
        let mut items: Vec<Vec<u8>> = cancel.input[0].witness.iter().map(|w| w.to_vec()).collect();
        items.insert(2, vec![1]);
        cancel.input[0].witness = items.into();
        reject(
            &Package {
                cancel_tx: serialize_hex(&cancel),
                ..s.b_package(2, 3)
            },
            "unexpected witness",
        );
    }
}
