//! EVM swap parameters and the timing rules of docs/EVM.md.
//!
//! All EVM timing is in block timestamps (unix seconds), which is what FerryLock compares:
//! claim in `[lock, t1)`, refund in `[t1, t2)`, punish from `t2`. `now` is always the latest
//! block's timestamp, never the local clock.

use serde::{Deserialize, Serialize};

use crate::Error;

/// Anvil's chain id (local development).
pub const ANVIL_CHAIN_ID: u64 = 31337;
pub const ETHEREUM_CHAIN_ID: u64 = 1;
pub const OPTIMISM_CHAIN_ID: u64 = 10;
pub const BASE_CHAIN_ID: u64 = 8453;
pub const ARBITRUM_CHAIN_ID: u64 = 42161;
pub const SEPOLIA_CHAIN_ID: u64 = 11_155_111;
pub const OP_SEPOLIA_CHAIN_ID: u64 = 11_155_420;
pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;
pub const ARBITRUM_SEPOLIA_CHAIN_ID: u64 = 421_614;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmParams {
    pub chain_id: u64,
    /// The FerryLock deployment both parties use.
    #[serde(with = "crate::hex_serde")]
    pub contract: [u8; 20],
    /// The ERC-20 B locks (USDC, WETH).
    #[serde(with = "crate::hex_serde")]
    pub token: [u8; 20],
    /// Token base units B locks (USDC: 10^-6, WETH: 10^-18). Z receives this minus any relayer
    /// tip. A u64, so one swap carries at most about 18.44 WETH (FerryLock itself takes any
    /// uint256); kept so the wire format stays the same for USDC peers.
    pub token_amount: u64,
    /// Agreed (and part of the transcript) so both sides name, scale and show the same token;
    /// each daemon checks them against the token's own `symbol()` and `decimals()` at startup.
    pub token_symbol: String,
    pub token_decimals: u8,
    /// ZEC Z locks (zatoshi).
    pub zec_amount: u64,
    /// Claims are valid before t1 (unix seconds, block time).
    pub t1: u64,
    /// Refunds are valid in [t1, t2); punish from t2.
    pub t2: u64,
    /// Δ for claims: Z never sends a claim once `now >= t1 - claim_margin`.
    pub claim_margin: u64,
    /// Δ for refunds: B never sends a refund once `now >= t2 - refund_margin`.
    pub refund_margin: u64,
    /// Confirmations of the EVM lock Z waits for before locking ZEC.
    pub lock_confirmations: u32,
    /// Zcash confirmations (N) B waits for on the lock note before signing Ready(id).
    pub zec_confirmations: u32,
    /// Largest tip (token base units) a claim may pay its sender (a relayer).
    pub max_tip: u64,
}

impl EvmParams {
    /// Hard sanity checks, independent of any policy.
    pub fn validate(&self) -> Result<(), Error> {
        if self.token_amount == 0 {
            return Err(Error::InvalidParams("token_amount is zero"));
        }
        if self.zec_amount == 0 {
            return Err(Error::InvalidParams("zec_amount is zero"));
        }
        if self.max_tip > self.token_amount {
            return Err(Error::InvalidParams("max_tip exceeds token_amount"));
        }
        if self.token_symbol.is_empty()
            || self.token_symbol.len() > 11
            || !self.token_symbol.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return Err(Error::InvalidParams("token_symbol"));
        }
        if self.token_decimals > 18 {
            return Err(Error::InvalidParams("token_decimals"));
        }
        if self.claim_margin == 0 || self.refund_margin == 0 {
            return Err(Error::InvalidParams(
                "the Δ margins must be at least one second",
            ));
        }
        if self.lock_confirmations == 0 || self.zec_confirmations == 0 {
            return Err(Error::InvalidParams(
                "confirmation targets must be at least 1",
            ));
        }
        if self.t1 <= self.claim_margin {
            return Err(Error::InvalidParams("t1 leaves no claim window"));
        }
        if self.t2 <= self.t1.saturating_add(self.refund_margin) {
            return Err(Error::InvalidParams("t2 leaves no refund window"));
        }
        if self.contract == [0; 20] || self.token == [0; 20] {
            return Err(Error::InvalidParams("zero contract or token address"));
        }
        Ok(())
    }

    /// [`EvmParams::validate`], the local [`EvmPolicy`] minimums, and enough time left at `now`.
    pub fn check_policy(&self, policy: &EvmPolicy, now: u64) -> Result<(), Error> {
        self.validate()?;
        let checks = [
            (
                "claim margin (s)",
                self.claim_margin,
                policy.min_margin_secs,
            ),
            (
                "refund margin (s)",
                self.refund_margin,
                policy.min_margin_secs,
            ),
            (
                "EVM lock confirmations",
                u64::from(self.lock_confirmations),
                u64::from(policy.min_lock_confirmations),
            ),
            (
                "ZEC confirmations",
                u64::from(self.zec_confirmations),
                u64::from(policy.min_zec_confirmations),
            ),
            (
                "claim window (s)",
                self.t1
                    .saturating_sub(self.claim_margin)
                    .saturating_sub(now),
                policy.min_claim_window_secs,
            ),
            (
                "refund window (s)",
                self.t2 - self.t1 - self.refund_margin,
                policy.min_margin_secs,
            ),
        ];
        for (name, got, min) in checks {
            if got < min {
                return Err(Error::Policy(format!(
                    "{name} is {got}, we require at least {min}"
                )));
            }
        }
        Ok(())
    }

    /// Z may send a claim only while `now < t1 − Δ`.
    pub fn can_claim(&self, now: u64) -> bool {
        now.saturating_add(self.claim_margin) < self.t1
    }

    /// Z locks ZEC once the EVM lock is buried enough and there is still time to claim.
    pub fn can_lock_zec(&self, lock_confs: u32, now: u64) -> bool {
        lock_confs >= self.lock_confirmations && self.can_claim(now)
    }

    /// No claim can land any more (FerryLock refuses claims from t1).
    pub fn claim_closed(&self, now: u64) -> bool {
        now >= self.t1
    }

    /// B may send a refund only in `[t1, t2 − Δ)`.
    pub fn can_refund(&self, now: u64) -> bool {
        now >= self.t1 && now.saturating_add(self.refund_margin) < self.t2
    }

    pub fn can_punish(&self, now: u64) -> bool {
        now >= self.t2
    }
}

/// Local minimums a party enforces on any EVM terms it signs up to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvmPolicy {
    /// Both Δ margins, and the smallest refund window (seconds).
    pub min_margin_secs: u64,
    pub min_lock_confirmations: u32,
    pub min_zec_confirmations: u32,
    /// Time from the proposal to `t1 − Δ`: enough to lock, lock ZEC, confirm it and claim.
    pub min_claim_window_secs: u64,
}

/// What a party accepts beyond the chains Ferry has a policy for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PolicyOptIn {
    /// Only the listed chains.
    #[default]
    Listed,
    /// The relaxed development policy. Anvil only, and required there.
    Dev,
    /// A chain id Ferry has no policy for, declared a test network by the operator: it gets the
    /// test-network minimums. Never accepted for a listed chain, so it can't loosen a mainnet.
    UnlistedTestnet,
}

/// OP Stack and Arbitrum mainnets: a single sequencer can delay inclusion. Base stopped making
/// blocks for 33 min in August 2025 and for about 2 h in 2026, so both margins (Δ) are 2 h: a
/// claim or refund sent just before its cutoff still lands in time through a stall that long.
/// Never below 1 h. (Lock confirmations differ with the block time.)
const SEQUENCER_MARGIN_SECS: u64 = 2 * 3_600;
/// From the proposal to t1 − Δ. A swap needs about 15-20 min of it (10 Zcash confirmations are
/// most of that), so 2 h leaves room for a slow Zcash. It is also how long the second locker holds
/// a free price option, which grows with the square root of the window (about 0.48% of the amount
/// at 2 h against 0.68% at 4 h, at 80% volatility); running out is safe (B refunds at t1).
const SEQUENCER_CLAIM_WINDOW_SECS: u64 = 2 * 3_600;
/// Every mainnet: ten Zcash blocks (about 12.5 minutes) before B lets Z claim.
const MAINNET_ZEC_CONFIRMATIONS: u32 = 10;

const TESTNET: EvmPolicy = EvmPolicy {
    min_margin_secs: 120,
    min_lock_confirmations: 2,
    min_zec_confirmations: 3,
    min_claim_window_secs: 1_200,
};

impl EvmPolicy {
    /// One of the main networks Ferry has a policy for: real value at stake.
    pub fn is_mainnet(chain_id: u64) -> bool {
        matches!(
            chain_id,
            ETHEREUM_CHAIN_ID | BASE_CHAIN_ID | OPTIMISM_CHAIN_ID | ARBITRUM_CHAIN_ID
        )
    }

    /// The minimums for `chain_id` (reasons in docs/EVM.md, "Timing rules"):
    /// - Ethereum: no sequencer, 12 s blocks. 15 min margins, 64 lock confirmations (about two
    ///   epochs, when a block is normally finalized), a claim window of at least 2 h.
    /// - Base and Optimism (OP Stack, 2 s blocks): 2 h margins, 30 lock confirmations, 2 h.
    /// - Arbitrum One (about 0.25 s blocks): Base's margins and claim window, and 240 lock
    ///   confirmations, the same minute as Base's 30.
    /// - Sepolia, Base Sepolia, OP Sepolia, Arbitrum Sepolia: test-network minimums.
    /// - Anvil: only with [`PolicyOptIn::Dev`].
    /// - Any other chain is refused, unless the operator declares it a test network
    ///   ([`PolicyOptIn::UnlistedTestnet`]).
    pub fn for_chain(chain_id: u64, opt_in: PolicyOptIn) -> Result<EvmPolicy, Error> {
        let listed = match chain_id {
            ETHEREUM_CHAIN_ID => Some(EvmPolicy {
                min_margin_secs: 900,
                min_lock_confirmations: 64,
                min_zec_confirmations: MAINNET_ZEC_CONFIRMATIONS,
                min_claim_window_secs: 2 * 3_600,
            }),
            BASE_CHAIN_ID | OPTIMISM_CHAIN_ID => Some(EvmPolicy {
                min_margin_secs: SEQUENCER_MARGIN_SECS,
                min_lock_confirmations: 30,
                min_zec_confirmations: MAINNET_ZEC_CONFIRMATIONS,
                min_claim_window_secs: SEQUENCER_CLAIM_WINDOW_SECS,
            }),
            ARBITRUM_CHAIN_ID => Some(EvmPolicy {
                min_margin_secs: SEQUENCER_MARGIN_SECS,
                min_lock_confirmations: 240,
                min_zec_confirmations: MAINNET_ZEC_CONFIRMATIONS,
                min_claim_window_secs: SEQUENCER_CLAIM_WINDOW_SECS,
            }),
            SEPOLIA_CHAIN_ID
            | BASE_SEPOLIA_CHAIN_ID
            | OP_SEPOLIA_CHAIN_ID
            | ARBITRUM_SEPOLIA_CHAIN_ID => Some(TESTNET),
            _ => None,
        };
        match (chain_id, opt_in, listed) {
            (ANVIL_CHAIN_ID, PolicyOptIn::Dev, _) => Ok(EvmPolicy {
                min_margin_secs: 2,
                min_lock_confirmations: 1,
                min_zec_confirmations: 1,
                min_claim_window_secs: 10,
            }),
            (ANVIL_CHAIN_ID, _, _) => Err(Error::Policy(
                "anvil (chain 31337) needs the explicit dev policy".into(),
            )),
            (_, PolicyOptIn::Dev, _) => Err(Error::Policy(
                "the dev policy is only for anvil (chain 31337)".into(),
            )),
            (_, PolicyOptIn::Listed, Some(p)) => Ok(p),
            (_, PolicyOptIn::UnlistedTestnet, Some(_)) => Err(Error::Policy(format!(
                "chain {chain_id} has its own policy; it can't be treated as an unlisted test \
                 network"
            ))),
            (_, PolicyOptIn::UnlistedTestnet, None) => Ok(TESTNET),
            (_, PolicyOptIn::Listed, None) => Err(Error::Policy(format!(
                "Ferry has no safety policy for EVM chain {chain_id}; if it is a test network, \
                 declare it one explicitly"
            ))),
        }
    }
}

#[cfg(test)]
pub(crate) fn test_params() -> EvmParams {
    EvmParams {
        chain_id: ANVIL_CHAIN_ID,
        contract: [0x11; 20],
        token: [0x22; 20],
        token_amount: 250_000_000,
        token_symbol: "USDC".into(),
        token_decimals: 6,
        zec_amount: 500_000_000,
        t1: 1_000,
        t2: 2_000,
        claim_margin: 100,
        refund_margin: 100,
        lock_confirmations: 1,
        zec_confirmations: 2,
        max_tip: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows() {
        let p = test_params();
        p.validate().unwrap();
        assert!(p.can_claim(899) && !p.can_claim(900));
        assert!(!p.claim_closed(999) && p.claim_closed(1_000));
        assert!(!p.can_refund(999) && p.can_refund(1_000) && p.can_refund(1_899));
        assert!(!p.can_refund(1_900));
        assert!(!p.can_punish(1_999) && p.can_punish(2_000));
        assert!(p.can_lock_zec(1, 0) && !p.can_lock_zec(0, 0) && !p.can_lock_zec(1, 900));
    }

    #[test]
    fn rejects_bad_params() {
        let p = test_params();
        for bad in [
            EvmParams {
                token_amount: 0,
                ..p.clone()
            },
            EvmParams {
                max_tip: p.token_amount + 1,
                ..p.clone()
            },
            EvmParams {
                t2: 1_100,
                ..p.clone()
            },
            EvmParams {
                claim_margin: 0,
                ..p.clone()
            },
            EvmParams {
                token_symbol: "US DC".into(),
                ..p.clone()
            },
            EvmParams {
                contract: [0; 20],
                ..p.clone()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn policies() {
        let p = test_params();
        let dev = EvmPolicy::for_chain(ANVIL_CHAIN_ID, PolicyOptIn::Dev).unwrap();
        p.check_policy(&dev, 0).unwrap();
        // Too little time left before t1 − Δ.
        assert!(p.check_policy(&dev, 895).is_err());
        let sepolia = EvmPolicy::for_chain(BASE_SEPOLIA_CHAIN_ID, PolicyOptIn::Listed).unwrap();
        let err = p.check_policy(&sepolia, 0).unwrap_err().to_string();
        assert!(err.contains("claim margin"), "{err}");
    }

    /// (margin s, lock confirmations, ZEC confirmations, claim window s) per chain.
    fn table(chain_id: u64) -> (u64, u32, u32, u64) {
        let p = EvmPolicy::for_chain(chain_id, PolicyOptIn::Listed)
            .unwrap_or_else(|e| panic!("chain {chain_id}: {e}"));
        (
            p.min_margin_secs,
            p.min_lock_confirmations,
            p.min_zec_confirmations,
            p.min_claim_window_secs,
        )
    }

    #[test]
    fn policy_table() {
        assert_eq!(table(ETHEREUM_CHAIN_ID), (900, 64, 10, 7_200));
        assert_eq!(table(BASE_CHAIN_ID), (7_200, 30, 10, 7_200));
        assert_eq!(table(OPTIMISM_CHAIN_ID), table(BASE_CHAIN_ID));
        assert_eq!(table(ARBITRUM_CHAIN_ID), (7_200, 240, 10, 7_200));
        // A sequencer chain's margin covers Base's 2 h halt of 2026, and never drops below 1 h.
        for seq in [BASE_CHAIN_ID, OPTIMISM_CHAIN_ID, ARBITRUM_CHAIN_ID] {
            assert!(table(seq).0 >= 2 * 3_600, "chain {seq}");
        }
        for testnet in [
            SEPOLIA_CHAIN_ID,
            BASE_SEPOLIA_CHAIN_ID,
            OP_SEPOLIA_CHAIN_ID,
            ARBITRUM_SEPOLIA_CHAIN_ID,
        ] {
            assert_eq!(table(testnet), (120, 2, 3, 1_200), "chain {testnet}");
            assert!(!EvmPolicy::is_mainnet(testnet), "chain {testnet}");
        }
        assert!(!EvmPolicy::is_mainnet(ANVIL_CHAIN_ID) && !EvmPolicy::is_mainnet(59_144));
        // Lock confirmations cover at least Base's minute at each chain's block time.
        let secs = |chain, block_ms: u64| u64::from(table(chain).1) * block_ms / 1_000;
        assert!(secs(ARBITRUM_CHAIN_ID, 250) >= secs(BASE_CHAIN_ID, 2_000));
        assert!(
            secs(ETHEREUM_CHAIN_ID, 12_000) >= 12 * 60,
            "about two epochs"
        );
        // Every mainnet is stricter than every test network.
        for main in [
            ETHEREUM_CHAIN_ID,
            BASE_CHAIN_ID,
            OPTIMISM_CHAIN_ID,
            ARBITRUM_CHAIN_ID,
        ] {
            assert!(EvmPolicy::is_mainnet(main), "chain {main}");
            let (m, l, z, w) = table(main);
            let (tm, tl, tz, tw) = table(SEPOLIA_CHAIN_ID);
            assert!(m > tm && l > tl && z > tz && w > tw, "chain {main}");
        }
    }

    /// `NAME=<digits>` or `NAME:-<digits>` in a shell script, as a number.
    fn script_value(script: &str, name: &str) -> u64 {
        let path = format!("{}/../../{script}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        [format!("{name}="), format!("{name}:-")]
            .iter()
            .find_map(|key| {
                let rest = &text[text.find(key.as_str())? + key.len()..];
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().ok()
            })
            .unwrap_or_else(|| panic!("{script}: no number for {name}"))
    }

    /// The Base mainnet terms `infra/node/ferry --mainnet` and `infra/mainnet-demo.sh` ship, read
    /// from the scripts, so neither can drift below the policy or away from the times in the docs
    /// (docs/EVM.md, "Timing rules").
    #[test]
    fn shipped_base_mainnet_terms() {
        let base = EvmPolicy::for_chain(BASE_CHAIN_ID, PolicyOptIn::Listed).unwrap();
        let shipped = [
            (
                script_value("infra/node/ferry", "EVM_T1_SECS"),
                script_value("infra/node/ferry", "EVM_REFUND_SECS"),
                script_value("infra/node/ferry", "EVM_DELTA_SECS"),
                script_value("infra/node/ferry", "EVM_LOCK_CONFS"),
                script_value("infra/node/ferry", "ZEC_CONFS"),
            ),
            (
                script_value("infra/mainnet-demo.sh", "T1_SECS"),
                script_value("infra/mainnet-demo.sh", "REFUND_SECS"),
                script_value("infra/mainnet-demo.sh", "DELTA_SECS"),
                script_value("infra/mainnet-demo.sh", "LOCK_CONFS"),
                script_value("infra/mainnet-demo.sh", "ZEC_CONFS"),
            ),
        ];
        let (h, m) = (3_600, 60);
        for (t1_secs, refund_secs, delta, lock, zec) in shipped {
            let now = 1_800_000_000;
            let p = EvmParams {
                chain_id: BASE_CHAIN_ID,
                t1: now + t1_secs,
                t2: now + t1_secs + refund_secs,
                claim_margin: delta,
                refund_margin: delta,
                lock_confirmations: lock as u32,
                zec_confirmations: zec as u32,
                ..test_params()
            };
            p.check_policy(&base, now).unwrap();
            // 15 min of slack between the offer and the maker's own check of the proposal
            p.check_policy(&base, now + 15 * m).unwrap();
            assert!(p.check_policy(&base, now + 15 * m + 1).is_err());
            // From the proposal: the last claim at 2 h 15 min, B's refund from 4 h 15 min, its
            // last refund at 28 h 15 min (a 24 h window), Z's punish from 30 h 15 min.
            assert_eq!(delta, 2 * h);
            assert_eq!(p.t1 - delta - now, 2 * h + 15 * m);
            assert_eq!(p.t1 - now, 4 * h + 15 * m);
            assert_eq!(p.t2 - p.t1 - delta, 24 * h);
            assert_eq!(p.t2 - delta - now, 28 * h + 15 * m);
            assert_eq!(p.t2 - now, 30 * h + 15 * m);
            // The windows as the daemons and the watchtower apply them.
            assert!(p.can_claim(p.t1 - delta - 1) && !p.can_claim(p.t1 - delta));
            assert!(!p.can_refund(p.t1 - 1) && p.can_refund(p.t1));
            assert!(p.can_refund(p.t2 - delta - 1) && !p.can_refund(p.t2 - delta));
            assert!(!p.can_punish(p.t2 - 1) && p.can_punish(p.t2));
        }
    }

    #[test]
    fn unknown_chains_are_refused_unless_declared_test_networks() {
        let unknown = 59_144; // not listed
        let err = EvmPolicy::for_chain(unknown, PolicyOptIn::Listed).unwrap_err();
        assert!(err.to_string().contains("no safety policy"), "{err}");
        assert_eq!(
            EvmPolicy::for_chain(unknown, PolicyOptIn::UnlistedTestnet).unwrap(),
            TESTNET
        );
        // The opt-in can't loosen a listed chain, mainnet or not.
        for listed in [ETHEREUM_CHAIN_ID, BASE_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID] {
            assert!(EvmPolicy::for_chain(listed, PolicyOptIn::UnlistedTestnet).is_err());
        }
    }

    #[test]
    fn the_dev_policy_is_for_anvil_only() {
        assert!(EvmPolicy::for_chain(ANVIL_CHAIN_ID, PolicyOptIn::Listed).is_err());
        assert!(EvmPolicy::for_chain(ANVIL_CHAIN_ID, PolicyOptIn::UnlistedTestnet).is_err());
        assert_eq!(
            EvmPolicy::for_chain(ANVIL_CHAIN_ID, PolicyOptIn::Dev)
                .unwrap()
                .min_margin_secs,
            2
        );
        for chain in [ETHEREUM_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, 59_144] {
            assert!(
                EvmPolicy::for_chain(chain, PolicyOptIn::Dev).is_err(),
                "{chain}"
            );
        }
    }
}
