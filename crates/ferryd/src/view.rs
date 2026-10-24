//! JSON views of docs/API.md and the "what a chain observer sees" lines.

use ferry_btc::bitcoin::opcodes::all::OP_CSV;
use ferry_btc::bitcoin::script::Instruction;
use ferry_btc::bitcoin::{Amount, Transaction};
use ferry_btc::scripts::NUMS;
use ferry_core::{Role, Spend};
use serde::Serialize;

use crate::record::{SwapRecord, TimelineEntry};

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StatusView {
    pub role: Role,
    pub name: String,
    pub balances: Balances,
    pub chains: Chains,
    pub offer: OfferView,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Balances {
    pub zec_shielded_zat: u64,
    pub btc_sat: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Chains {
    pub btc: BtcChain,
    pub zec: ZecChain,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct BtcChain {
    pub network: String,
    pub height: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ZecChain {
    pub network: String,
    pub height: u64,
    pub pool: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct OfferView {
    pub pair: String,
    pub rate_sat_per_zec: u64,
    pub min_zat: u64,
    pub max_zat: u64,
    /// Fixed fee of each presigned BTC transaction (sats).
    pub fee_sat: u64,
    pub t1_blocks: u16,
    pub t2_blocks: u16,
    pub btc_lock_confs: u32,
    pub zec_confs: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct SwapView {
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
}

#[derive(Clone, Debug, Serialize)]
pub struct Amounts {
    pub zec_zat: u64,
    pub btc_sat: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Deadlines {
    pub t1_blocks: u16,
    pub t2_blocks: u16,
    pub btc_lock_height: Option<u64>,
    pub cancel_height: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Keys {
    pub my_share_point_pallas: String,
    pub my_share_point_secp: String,
    pub peer_share_point_pallas: String,
    pub peer_share_point_secp: String,
    pub dleq_verified: bool,
    pub joint_ak: String,
    pub sigma: i8,
}

#[derive(Clone, Debug, Serialize)]
pub struct Addresses {
    pub btc_lock: String,
    pub zec_joint: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Secrets {
    pub mine_revealed: bool,
    pub peer_learned: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Observer {
    pub btc: Vec<String>,
    pub zec: Vec<String>,
}

pub fn swap_view(rec: &SwapRecord) -> SwapView {
    let s = rec.swap.session();
    let p = &s.params;
    SwapView {
        id: rec.id.clone(),
        role: rec.role(),
        counterparty: rec.counterparty.clone(),
        state: rec.state(),
        outcome: rec.outcome(),
        amounts: Amounts {
            zec_zat: p.zec_amount,
            btc_sat: p.btc_amount,
        },
        deadlines: Deadlines {
            t1_blocks: p.t1,
            t2_blocks: p.t2,
            btc_lock_height: rec.btc_lock_height,
            cancel_height: rec.cancel_height,
        },
        keys: Keys {
            my_share_point_pallas: hex::encode(s.me.setup.pallas_pub),
            my_share_point_secp: hex::encode(s.me.setup.secp_pub),
            peer_share_point_pallas: hex::encode(s.peer.setup.pallas_pub),
            peer_share_point_secp: hex::encode(s.peer.setup.secp_pub),
            // A running swap only exists once the peer's DLEQ proof verified.
            dleq_verified: true,
            joint_ak: s.joint_ak_bytes().map(hex::encode).unwrap_or_default(),
            sigma: s.joint_sigma().unwrap_or(1),
        },
        addresses: Addresses {
            btc_lock: s.lock_address().to_string(),
            zec_joint: rec.zec_joint.clone(),
        },
        secrets: Secrets {
            mine_revealed: rec.mine_revealed,
            peer_learned: rec.peer_learned,
        },
        timeline: rec.timeline.clone(),
        observer: Observer {
            btc: ordered(
                &rec.observer_btc,
                &["lock", "cancel", "redeem", "refund", "punish"],
            ),
            zec: ordered(&rec.observer_zec, &["lock", "sweep"]),
        },
        watchtower: rec.watchtower.clone(),
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

pub fn spend_key(spend: Spend) -> &'static str {
    match spend {
        Spend::Cancel => "cancel",
        Spend::Redeem => "redeem",
        Spend::Refund => "refund",
        Spend::Punish => "punish",
    }
}

fn btc(a: Amount) -> String {
    let s = format!("{:.8}", a.to_btc());
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("{s} BTC")
}

fn short(tx: &Transaction) -> String {
    tx.compute_txid().to_string()[..8].to_string()
}

/// The lock transaction as it appears on chain.
pub fn describe_lock(tx: &Transaction, vout: u32) -> String {
    let Some(lock) = tx.output.get(vout as usize) else {
        return format!("tx_lock: has no output {vout} (txid {}…)", short(tx));
    };
    let others = tx.output.len() - 1;
    format!(
        "tx_lock: {} input(s) → a P2TR output of {}{}, vsize {} (txid {}…). Until it is spent it looks like \
         any single-key Taproot payment; its two script leaves stay hidden.",
        tx.input.len(),
        btc(lock.value),
        if others > 0 { format!(" plus {others} change output(s)") } else { String::new() },
        tx.vsize(),
        short(tx),
    )
}

/// `<n> OP_CSV ...` → n
fn leaf_csv(script: &ferry_btc::bitcoin::Script) -> Option<i64> {
    let mut ins = script.instructions();
    let n = match ins.next()?.ok()? {
        Instruction::Op(op) if (0x51..=0x60).contains(&op.to_u8()) => i64::from(op.to_u8() - 0x50),
        Instruction::PushBytes(b) => {
            // minimal little-endian script number
            let bytes = b.as_bytes();
            if bytes.is_empty() || bytes.len() > 4 {
                return None;
            }
            let mut v = 0i64;
            for (i, byte) in bytes.iter().enumerate() {
                v |= i64::from(*byte) << (8 * i);
            }
            v
        }
        _ => return None,
    };
    match ins.next()?.ok()? {
        Instruction::Op(op) if op == OP_CSV => Some(n),
        _ => None,
    }
}

/// A script-path spend of the lock or cancel output, read from its witness.
pub fn describe_spend(spend: Spend, tx: &Transaction, prev_value: Amount) -> String {
    let name = match spend {
        Spend::Cancel => "tx_cancel",
        Spend::Redeem => "tx_redeem",
        Spend::Refund => "tx_refund",
        Spend::Punish => "tx_punish",
    };
    let witness: Vec<&[u8]> = tx.input[0].witness.iter().collect();
    let out = &tx.output[0];
    let fee = prev_value
        .checked_sub(tx.output.iter().map(|o| o.value).sum())
        .unwrap_or(Amount::ZERO);
    if let [sig] = witness.as_slice() {
        return format!(
            "{name}: key-path spend: one {}-byte Schnorr signature, no script and no second key revealed, \
             paying {} to a {} output, fee {} sat (txid {}…). Indistinguishable from an ordinary \
             single-key Taproot payment.",
            sig.len(),
            btc(out.value),
            if out.script_pubkey.is_p2tr() { "P2TR" } else { "non-Taproot" },
            fee.to_sat(),
            short(tx),
        );
    }
    let (control, script) = match witness.as_slice() {
        [.., script, control] => (*control, *script),
        _ => return format!("{name}: spends the swap output (txid {}…)", short(tx)),
    };
    let sigs = witness.iter().filter(|w| w.len() == 64).count();
    let leaves = 1usize << (control.len().saturating_sub(33) / 32);
    let nums = control.get(1..33) == Some(&NUMS[..]);
    let csv = leaf_csv(ferry_btc::bitcoin::Script::from_bytes(script));
    format!(
        "{name}: script-path spend revealing one of {leaves} leaves ({}{} Schnorr signature{}; internal key {}), \
         paying {} to a {} output, fee {} sat (txid {}…).",
        csv.map(|n| format!("{n}-block CSV, ")).unwrap_or_default(),
        sigs,
        if sigs == 1 { "" } else { "s" },
        if nums {
            "is the BIP341 NUMS point, so there is no key path"
        } else {
            "is an ordinary-looking key"
        },
        btc(out.value),
        if out.script_pubkey.is_p2tr() { "P2TR" } else { "non-Taproot" },
        fee.to_sat(),
        short(tx),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferry_btc::bitcoin::{absolute::LockTime, transaction::Version, ScriptBuf, TxOut};

    #[test]
    fn describe_lock_survives_a_bad_vout() {
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![],
            output: vec![TxOut {
                value: Amount::from_sat(1_000),
                script_pubkey: ScriptBuf::new(),
            }],
        };
        assert!(describe_lock(&tx, 0).starts_with("tx_lock: 0 input(s)"));
        assert!(describe_lock(&tx, 99).contains("has no output 99"));
    }
}
