//! JSON views of an EVM daemon, in the Bitcoin daemon's shape (docs/API.md) so the UI reads
//! both: the counter chain stays under `btc`/`*_sat` names with amounts in the token's base
//! units, `chains.btc.coin`/`ticker`/`decimals` say what it is, and `counter` adds what only
//! an EVM swap has.

use ferry_core::Role;
use serde::Serialize;

use super::config::{addr_str, EvmOffer};
use super::record::EvmRecord;
use crate::record::TimelineEntry;
use crate::view::{Keys, Secrets};

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct EvmStatusView {
    pub role: Role,
    pub name: String,
    pub balances: Balances,
    pub chains: Chains,
    pub offer: OfferView,
    pub counter: CounterInfo,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Balances {
    pub zec_shielded_zat: u64,
    /// Token base units (USDC: 10^-6).
    pub btc_sat: u64,
    /// For gas (wei, decimal string).
    pub eth_wei: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Chains {
    pub btc: CounterChain,
    pub zec: crate::view::ZecChain,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CounterChain {
    /// e.g. "anvil", "base-sepolia"
    pub network: String,
    pub height: u64,
    /// The token, lowercase ("usdc").
    pub coin: String,
    pub ticker: String,
    pub decimals: u8,
    /// Latest block time (unix seconds): what the contract's windows compare against.
    pub time: u64,
}

/// What only an EVM swap has.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CounterInfo {
    pub kind: &'static str,
    pub chain_id: u64,
    pub contract: String,
    pub token: String,
    pub symbol: String,
    pub decimals: u8,
    /// Our account (Z: payout; B: locks and refunds).
    pub account: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct OfferView {
    pub pair: String,
    /// Token base units per ZEC.
    pub rate_sat_per_zec: u64,
    pub min_zat: u64,
    pub max_zat: u64,
    /// No presigned fees on EVM: the claim's sender pays gas.
    pub fee_sat: u64,
    pub t1_secs: u64,
    pub refund_secs: u64,
    pub delta_secs: u64,
    /// Named like the Bitcoin offer's: confirmations of the counter-chain lock.
    pub btc_lock_confs: u32,
    pub zec_confs: u32,
    pub rate_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub liquidity_zat: Option<u64>,
    pub paused: bool,
}

impl OfferView {
    pub fn of(o: &EvmOffer) -> OfferView {
        OfferView {
            pair: o.pair(),
            rate_sat_per_zec: o.rate_sat_per_zec,
            min_zat: o.min_zat,
            max_zat: o.max_zat,
            fee_sat: 0,
            t1_secs: o.terms.t1_secs,
            refund_secs: o.terms.refund_secs,
            delta_secs: o.terms.claim_margin,
            btc_lock_confs: o.terms.lock_confirmations,
            zec_confs: o.terms.zec_confirmations,
            rate_source: o.rate_source.clone(),
            rate_updated_at: o.rate_updated_at,
            liquidity_zat: o.liquidity.map(|l| l.zec_zat),
            paused: o.paused,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct EvmSwapView {
    pub id: String,
    pub role: Role,
    pub counterparty: String,
    pub state: String,
    pub outcome: Option<&'static str>,
    pub amounts: Amounts,
    pub deadlines: Deadlines,
    pub keys: Keys,
    pub addresses: Addresses,
    pub secrets: Secrets,
    pub timeline: Vec<TimelineEntry>,
    pub observer: Observer,
    /// Our package at the watchtower; absent without --watchtower.
    pub watchtower: Option<crate::tower::TowerState>,
    pub counter: SwapCounter,
}

#[derive(Clone, Debug, Serialize)]
pub struct Amounts {
    pub zec_zat: u64,
    /// Token base units B locks.
    pub btc_sat: u64,
}

/// Block-time deadlines. The block-count fields stay for the Bitcoin-shaped UI and are 0.
#[derive(Clone, Debug, Serialize)]
pub struct Deadlines {
    pub t1_blocks: u16,
    pub t2_blocks: u16,
    pub btc_lock_height: Option<u64>,
    pub cancel_height: Option<u64>,
    pub t1_unix: u64,
    pub t2_unix: u64,
    pub claim_margin_secs: u64,
    pub refund_margin_secs: u64,
    /// Latest block time seen.
    pub now_unix: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Addresses {
    /// "FerryLock 0x… · swap 0x…": where the tokens sit.
    pub btc_lock: String,
    pub zec_joint: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Observer {
    pub btc: Vec<String>,
    pub zec: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SwapCounter {
    pub kind: &'static str,
    pub chain_id: u64,
    pub contract: String,
    pub token: String,
    pub symbol: String,
    pub decimals: u8,
    pub swap_id: String,
    pub claimer: String,
    pub refunder: String,
    /// Commitments to the two shares: addresses of Z_s and B_s.
    pub z_addr: String,
    pub b_addr: String,
    pub max_tip: u64,
    pub ready_signed: bool,
}

pub fn swap_view(rec: &EvmRecord) -> EvmSwapView {
    let s = rec.swap.session();
    let p = &s.params;
    let terms = s.lock_terms().ok();
    let swap_id = format!("0x{}", hex::encode(s.swap_id()));
    let a = |f: fn(&ferry_core::evm::LockTerms) -> [u8; 20]| {
        terms.as_ref().map(|t| addr_str(&f(t))).unwrap_or_default()
    };
    EvmSwapView {
        id: rec.id.clone(),
        role: rec.role(),
        counterparty: rec.counterparty.clone(),
        state: rec.state(),
        outcome: rec.outcome(),
        amounts: Amounts {
            zec_zat: p.zec_amount,
            btc_sat: p.token_amount,
        },
        deadlines: Deadlines {
            t1_blocks: 0,
            t2_blocks: 0,
            btc_lock_height: rec.evm_tx("lock").and_then(|t| t.block),
            cancel_height: None,
            t1_unix: p.t1,
            t2_unix: p.t2,
            claim_margin_secs: p.claim_margin,
            refund_margin_secs: p.refund_margin,
            now_unix: rec.now,
        },
        keys: Keys {
            my_share_point_pallas: hex::encode(s.me.setup.pallas_pub),
            my_share_point_secp: hex::encode(s.me.setup.secp_pub),
            peer_share_point_pallas: hex::encode(s.peer.setup.pallas_pub),
            peer_share_point_secp: hex::encode(s.peer.setup.secp_pub),
            dleq_verified: true,
            joint_ak: s.joint_ak_bytes().map(hex::encode).unwrap_or_default(),
            sigma: s.joint_sigma().unwrap_or(1),
        },
        addresses: Addresses {
            btc_lock: format!("FerryLock {} · swap {swap_id}", addr_str(&p.contract)),
            zec_joint: rec.zec_joint.clone(),
        },
        secrets: Secrets {
            mine_revealed: rec.mine_revealed,
            peer_learned: rec.peer_learned,
        },
        timeline: rec.timeline.clone(),
        observer: Observer {
            btc: ordered(&rec.observer_evm, &["lock", "claim", "refund", "punish"]),
            zec: ordered(&rec.observer_zec, &["lock", "sweep"]),
        },
        watchtower: rec.watchtower.clone(),
        counter: SwapCounter {
            kind: "evm",
            chain_id: p.chain_id,
            contract: addr_str(&p.contract),
            token: addr_str(&p.token),
            symbol: p.token_symbol.clone(),
            decimals: p.token_decimals,
            swap_id,
            claimer: a(|t| t.claimer),
            refunder: a(|t| t.refunder),
            z_addr: a(|t| t.z_addr),
            b_addr: a(|t| t.b_addr),
            max_tip: p.max_tip,
            ready_signed: rec.has("redeem_adaptor_sent") || rec.has("redeem_adaptor_received"),
        },
    }
}

fn ordered(lines: &[(String, String)], order: &[&str]) -> Vec<String> {
    order
        .iter()
        .filter_map(|k| {
            lines
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, l)| l.clone())
        })
        .collect()
}
