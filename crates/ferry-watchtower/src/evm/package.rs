//! What the owner of a FerryLock swap (`ferryd --counter evm`) hands the tower, and the offline
//! checks it passes. [`crate::evm::EvmTower::register`] then checks it against the chain.
//!
//! FerryLock has no presigned transactions. Anyone may call `punish` once t2 has passed, so Z's
//! package holds no secret: the swap id and its terms. `refund` needs B's share `b`, so B's
//! package carries `b` itself, and B hands it only to a tower it runs (docs/WATCHTOWER.md). In
//! both cases the contract pays the swap's own `refunder` or `claimer`, never the caller.

use ferry_btc::Role;
use ferry_evm::{Address, B256, U256};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::engine::EvmRules;
use crate::package::PackageError;
use crate::Counter;

pub const EVM_PACKAGE_VERSION: u32 = 1;

fn bad<T>(msg: impl Into<String>) -> Result<T, PackageError> {
    Err(PackageError(msg.into()))
}

/// `FerryLock.Terms`, as the owner agreed them. Amounts are decimal strings of base units.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTerms {
    pub token: Address,
    #[serde(with = "decimal")]
    pub amount: U256,
    /// address(Z_s), the commitment to Z's share.
    pub z_addr: Address,
    /// address(B_s), the commitment to B's share.
    pub b_addr: Address,
    /// Z's account: claim and punish pay it.
    pub claimer: Address,
    /// B's account: refund pays it.
    pub refunder: Address,
    /// Block timestamps: claim before t1, refund in [t1, t2), punish from t2.
    pub t1: u64,
    pub t2: u64,
    #[serde(with = "decimal")]
    pub max_tip: U256,
}

impl EvmTerms {
    pub fn to_chain(&self) -> ferry_evm::Terms {
        ferry_evm::Terms {
            token: self.token,
            amount: self.amount,
            zAddr: self.z_addr,
            bAddr: self.b_addr,
            claimer: self.claimer,
            refunder: self.refunder,
            t1: self.t1,
            t2: self.t2,
            maxTip: self.max_tip,
        }
    }

    /// The first field that differs from the terms on chain.
    pub fn mismatch(&self, chain: &ferry_evm::Terms) -> Option<&'static str> {
        let t = self.to_chain();
        [
            (t.token == chain.token, "token"),
            (t.amount == chain.amount, "amount"),
            (t.zAddr == chain.zAddr, "z_addr"),
            (t.bAddr == chain.bAddr, "b_addr"),
            (t.claimer == chain.claimer, "claimer"),
            (t.refunder == chain.refunder, "refunder"),
            (t.t1 == chain.t1, "t1"),
            (t.t2 == chain.t2, "t2"),
            (t.maxTip == chain.maxTip, "max_tip"),
        ]
        .into_iter()
        .find(|(same, _)| !same)
        .map(|(_, field)| field)
    }
}

/// B's share `b` (big-endian secp256k1 scalar, hex). Never logged and never served back;
/// wiped from memory when dropped.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Share(#[serde(with = "hex32")] [u8; 32]);

impl Share {
    pub fn new(bytes: [u8; 32]) -> Share {
        Share(bytes)
    }

    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for Share {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Share(<redacted>)")
    }
}

impl Drop for Share {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// `POST /packages` body for a FerryLock swap. `counter` is always `evm`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmPackage {
    pub version: u32,
    pub counter: Counter,
    /// The owner's role: B delegates the refund, Z the punish.
    pub role: Role,
    pub chain_id: u64,
    /// The FerryLock deployment.
    pub contract: Address,
    pub swap_id: B256,
    pub terms: EvmTerms,
    /// Δ (seconds): no refund once the latest block's time is at or past `t2 − refund_margin`.
    pub refund_margin: u64,
    /// B only: B's share, which `refund(id, b)` publishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<Share>,
    /// Accounts the owner accepts as the payout: B's must include `terms.refunder`, Z's
    /// `terms.claimer`.
    pub payout_addresses: Vec<Address>,
    /// Free text for the owner (e.g. its swap id). Shown back by `GET /packages/:id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A package that passed the offline checks.
#[derive(Clone, Debug)]
pub struct EvmArmed {
    pub rules: EvmRules,
    pub contract: Address,
    pub swap_id: B256,
    pub terms: EvmTerms,
    /// B's share (B packages only).
    pub b: Option<Share>,
}

impl EvmPackage {
    pub fn rules(&self) -> EvmRules {
        EvmRules {
            role: self.role,
            t1: self.terms.t1,
            t2: self.terms.t2,
            refund_margin: self.refund_margin,
        }
    }

    /// Everything the tower can check without the chain:
    /// - the package is for this chain, and its terms are ones FerryLock accepts;
    /// - the terms leave a refund window (`t1 + Δ < t2`, `Δ ≥ 1`);
    /// - a B package carries `b`, and `b·G` is the lock's `b_addr`; a Z package carries no `b`;
    /// - the payout is the owner's: B's `payout_addresses` include `refunder`, Z's `claimer`.
    pub fn validate(&self, chain_id: u64) -> Result<EvmArmed, PackageError> {
        if self.version != EVM_PACKAGE_VERSION {
            return bad(format!("unsupported version {}", self.version));
        }
        if self.counter != Counter::Evm {
            return bad("not an EVM package (counter must be evm)");
        }
        if self.chain_id != chain_id {
            return bad(format!(
                "package is for EVM chain {}, this tower watches chain {chain_id}",
                self.chain_id
            ));
        }
        if self.contract == Address::ZERO || self.swap_id == B256::ZERO {
            return bad("contract and swap_id must be set");
        }
        let t = &self.terms;
        if t.amount.is_zero() || t.max_tip > t.amount {
            return bad("the terms need 0 < amount and max_tip <= amount");
        }
        let addrs = [t.token, t.z_addr, t.b_addr, t.claimer, t.refunder];
        if addrs.contains(&Address::ZERO) || t.z_addr == t.b_addr {
            return bad("the terms have a zero address, or z_addr == b_addr");
        }
        if t.t1 == 0 || t.t2 <= t.t1 {
            return bad("the terms need 0 < t1 < t2");
        }
        if self.refund_margin == 0 {
            return bad("refund_margin must be at least 1 second");
        }
        if t.t1.saturating_add(self.refund_margin) >= t.t2 {
            return bad("t2 leaves no refund window");
        }
        match (self.role, &self.b) {
            (Role::B, Some(b)) => {
                if ferry_evm::verify_share(b.expose(), t.b_addr).is_err() {
                    return bad("b does not match the lock's b_addr");
                }
            }
            (Role::B, None) => return bad("a B package carries b"),
            (Role::Z, Some(_)) => return bad("a Z package carries no b"),
            (Role::Z, None) => {}
        }
        if self.payout_addresses.is_empty() {
            return bad("payout_addresses is empty");
        }
        let (payee, name) = match self.role {
            Role::B => (t.refunder, "refund pays the refunder"),
            Role::Z => (t.claimer, "punish pays the claimer"),
        };
        if !self.payout_addresses.contains(&payee) {
            return bad(format!(
                "the {name} {payee}, which is not one of payout_addresses"
            ));
        }
        Ok(EvmArmed {
            rules: self.rules(),
            contract: self.contract,
            swap_id: self.swap_id,
            terms: self.terms.clone(),
            b: self.b.clone(),
        })
    }
}

/// U256 as a decimal string; reads a number, a decimal or a `0x` hex string.
mod decimal {
    use ferry_evm::U256;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &U256, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<U256, D::Error> {
        U256::deserialize(d)
    }
}

mod hex32 {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        hex::decode(s.trim_start_matches("0x"))
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or_else(|| D::Error::custom("expected 32 bytes of hex"))
    }
}

/// Packages for tests, with real shares (no chain).
pub mod testkit {
    use super::*;
    use ferry_evm::PrivateKeySigner;

    /// One swap's keys and terms: both shares are ordinary secp256k1 keys here.
    pub struct EvmSwap {
        pub z_share: PrivateKeySigner,
        pub b_share: PrivateKeySigner,
        pub claimer: Address,
        pub refunder: Address,
        pub terms: EvmTerms,
        pub chain_id: u64,
        pub contract: Address,
        pub swap_id: B256,
    }

    impl EvmSwap {
        pub fn new(chain_id: u64, contract: Address, t1: u64, t2: u64) -> EvmSwap {
            let (z_share, b_share) = (PrivateKeySigner::random(), PrivateKeySigner::random());
            let (claimer, refunder) = (
                PrivateKeySigner::random().address(),
                PrivateKeySigner::random().address(),
            );
            let terms = EvmTerms {
                token: Address::repeat_byte(0x22),
                amount: U256::from(250_000_000u64),
                z_addr: z_share.address(),
                b_addr: b_share.address(),
                claimer,
                refunder,
                t1,
                t2,
                max_tip: U256::ZERO,
            };
            EvmSwap {
                z_share,
                b_share,
                claimer,
                refunder,
                terms,
                chain_id,
                contract,
                swap_id: B256::repeat_byte(0x5a),
            }
        }

        pub fn b(&self) -> [u8; 32] {
            self.b_share.to_bytes().0
        }

        fn package(&self, role: Role, b: Option<Share>, payout: Address) -> EvmPackage {
            EvmPackage {
                version: EVM_PACKAGE_VERSION,
                counter: Counter::Evm,
                role,
                chain_id: self.chain_id,
                contract: self.contract,
                swap_id: self.swap_id,
                terms: self.terms.clone(),
                refund_margin: 30,
                b,
                payout_addresses: vec![payout],
                label: None,
            }
        }

        pub fn b_package(&self) -> EvmPackage {
            self.package(Role::B, Some(Share::new(self.b())), self.refunder)
        }

        pub fn z_package(&self) -> EvmPackage {
            self.package(Role::Z, None, self.claimer)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::EvmSwap;
    use super::*;

    const CHAIN: u64 = 31337;

    fn swap() -> EvmSwap {
        EvmSwap::new(CHAIN, Address::repeat_byte(0x11), 1_000, 2_000)
    }

    fn reject(p: &EvmPackage, needle: &str) {
        let err = p.validate(CHAIN).unwrap_err().0;
        assert!(err.contains(needle), "{err:?} does not mention {needle:?}");
    }

    #[test]
    fn good_packages_validate_and_round_trip() {
        let s = swap();
        for p in [s.b_package(), s.z_package()] {
            let json = serde_json::to_value(&p).unwrap();
            assert_eq!(json["counter"], "evm");
            assert_eq!(json["terms"]["amount"], "250000000");
            let back: EvmPackage = serde_json::from_value(json).unwrap();
            assert_eq!(back, p);
            let armed = back.validate(CHAIN).unwrap();
            assert_eq!((armed.rules.t1, armed.rules.t2), (1_000, 2_000));
        }
        let json = serde_json::to_value(s.b_package()).unwrap();
        assert_eq!(json["b"], hex::encode(s.b()));
        assert!(serde_json::to_value(s.z_package())
            .unwrap()
            .get("b")
            .is_none());
        // Amounts are read as numbers, decimals or hex.
        let mut j = serde_json::to_value(s.z_package()).unwrap();
        j["terms"]["amount"] = serde_json::json!(250_000_000u64);
        let p: EvmPackage = serde_json::from_value(j).unwrap();
        assert_eq!(p.terms.amount, U256::from(250_000_000u64));
    }

    #[test]
    fn the_share_never_shows_in_debug_output() {
        let s = swap();
        let text = format!("{:?}", s.b_package());
        assert!(!text.contains(&hex::encode(s.b())), "{text}");
        assert!(text.contains("redacted"));
    }

    #[test]
    fn wrong_chain_version_or_counter() {
        let s = swap();
        let err = s.z_package().validate(8453).unwrap_err().0;
        assert!(
            err.contains("package is for EVM chain 31337, this tower watches chain 8453"),
            "{err}"
        );
        reject(
            &EvmPackage {
                version: 2,
                ..s.z_package()
            },
            "version",
        );
        reject(
            &EvmPackage {
                counter: Counter::Btc,
                ..s.z_package()
            },
            "counter",
        );
    }

    #[test]
    fn b_must_carry_its_own_share_and_z_none() {
        let s = swap();
        reject(
            &EvmPackage {
                b: None,
                ..s.b_package()
            },
            "carries b",
        );
        // A share that is not the committed b (Z's, say) would make refund revert.
        reject(
            &EvmPackage {
                b: Some(Share::new(s.z_share.to_bytes().0)),
                ..s.b_package()
            },
            "b_addr",
        );
        reject(
            &EvmPackage {
                b: Some(Share::new(s.b())),
                ..s.z_package()
            },
            "carries no b",
        );
        reject(
            &EvmPackage {
                role: Role::Z,
                ..s.b_package()
            },
            "carries no b",
        );
    }

    #[test]
    fn payout_must_be_the_owners() {
        let s = swap();
        // B's package listing Z's account: the refund would not pay any of them.
        reject(
            &EvmPackage {
                payout_addresses: vec![s.claimer],
                ..s.b_package()
            },
            "refund pays the refunder",
        );
        reject(
            &EvmPackage {
                payout_addresses: vec![s.refunder],
                ..s.z_package()
            },
            "punish pays the claimer",
        );
        reject(
            &EvmPackage {
                payout_addresses: vec![],
                ..s.z_package()
            },
            "empty",
        );
        // Extra addresses are fine.
        EvmPackage {
            payout_addresses: vec![s.refunder, s.claimer],
            ..s.z_package()
        }
        .validate(CHAIN)
        .unwrap();
    }

    #[test]
    fn deadlines_must_leave_a_refund_window() {
        let s = swap();
        let with = |t1: u64, t2: u64, margin: u64| EvmPackage {
            terms: EvmTerms {
                t1,
                t2,
                ..s.terms.clone()
            },
            refund_margin: margin,
            ..s.b_package()
        };
        reject(&with(2_000, 1_000, 30), "t1 < t2");
        reject(&with(1_000, 1_000, 30), "t1 < t2");
        reject(&with(0, 1_000, 30), "t1 < t2");
        reject(&with(1_000, 1_030, 30), "no refund window");
        reject(&with(1_000, 2_000, 0), "at least 1");
        with(1_000, 1_031, 30).validate(CHAIN).unwrap();
    }

    #[test]
    fn terms_sanity() {
        let s = swap();
        let with = |terms: EvmTerms| EvmPackage {
            terms,
            ..s.z_package()
        };
        reject(
            &with(EvmTerms {
                amount: U256::ZERO,
                ..s.terms.clone()
            }),
            "amount",
        );
        reject(
            &with(EvmTerms {
                max_tip: s.terms.amount + U256::from(1),
                ..s.terms.clone()
            }),
            "max_tip",
        );
        reject(
            &with(EvmTerms {
                token: Address::ZERO,
                ..s.terms.clone()
            }),
            "zero address",
        );
        reject(
            &EvmPackage {
                swap_id: B256::ZERO,
                ..s.z_package()
            },
            "swap_id",
        );
    }

    #[test]
    fn mismatch_names_the_field() {
        let s = swap();
        let mut chain = s.terms.to_chain();
        assert_eq!(s.terms.mismatch(&chain), None);
        chain.t2 += 1;
        assert_eq!(s.terms.mismatch(&chain), Some("t2"));
        chain = s.terms.to_chain();
        chain.refunder = s.claimer;
        assert_eq!(s.terms.mismatch(&chain), Some("refunder"));
    }
}
