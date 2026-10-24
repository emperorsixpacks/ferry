//! Taproot leaves for the lock and cancel outputs.

use bitcoin::key::{Secp256k1, XOnlyPublicKey};
use bitcoin::opcodes::all::{OP_CHECKSIG, OP_CHECKSIGVERIFY, OP_CSV, OP_DROP};
use bitcoin::script::{Builder, ScriptBuf};
use bitcoin::taproot::{ControlBlock, LeafVersion, TaprootBuilder, TaprootSpendInfo};
use bitcoin::{Address, Network};

/// BIP341 NUMS point `lift_x(sha256(G))`: no known discrete log, so the key path is unspendable.
pub const NUMS: [u8; 32] = [
    0x50, 0x92, 0x9b, 0x74, 0xc1, 0xa0, 0x49, 0x54, 0xb7, 0x8b, 0x4b, 0x60, 0x35, 0xe9, 0x7a, 0x5e,
    0x07, 0x8a, 0x5a, 0x0f, 0x28, 0xec, 0x96, 0xd5, 0x47, 0xbf, 0xee, 0x9a, 0xce, 0x80, 0x3a, 0xc0,
];

pub fn nums_key() -> XOnlyPublicKey {
    XOnlyPublicKey::from_slice(&NUMS).expect("NUMS is a valid x-only key")
}

/// A two-leaf Taproot output with the NUMS internal key.
#[derive(Clone, Debug)]
pub struct TapOut {
    pub spend_info: TaprootSpendInfo,
}

impl TapOut {
    pub fn new(left: &ScriptBuf, right: &ScriptBuf) -> Self {
        let secp = Secp256k1::verification_only();
        let spend_info = TaprootBuilder::new()
            .add_leaf(1, left.clone())
            .and_then(|b| b.add_leaf(1, right.clone()))
            .expect("two leaves at depth 1 form a complete tree")
            .finalize(&secp, nums_key())
            .expect("complete tree");
        TapOut { spend_info }
    }

    pub fn script_pubkey(&self) -> ScriptBuf {
        ScriptBuf::new_p2tr_tweaked(self.spend_info.output_key())
    }

    pub fn address(&self, network: Network) -> Address {
        Address::p2tr_tweaked(self.spend_info.output_key(), network)
    }

    pub fn control_block(&self, leaf: &ScriptBuf) -> Option<ControlBlock> {
        self.spend_info
            .control_block(&(leaf.clone(), LeafVersion::TapScript))
    }
}

/// All four leaves and both Taproot outputs of a swap.
#[derive(Clone, Debug)]
pub struct SwapScripts {
    /// B's BTC key.
    pub kb: XOnlyPublicKey,
    /// Z's BTC key.
    pub kz: XOnlyPublicKey,
    /// Relative timelock (blocks) of the cancel leaf on the lock output.
    pub t1: u16,
    /// Relative timelock (blocks) of the punish leaf on the cancel output.
    pub t2: u16,
    pub redeem: ScriptBuf,
    pub cancel: ScriptBuf,
    pub refund: ScriptBuf,
    pub punish: ScriptBuf,
    pub lock: TapOut,
    pub cancel_out: TapOut,
}

impl SwapScripts {
    pub fn new(kb: XOnlyPublicKey, kz: XOnlyPublicKey, t1: u16, t2: u16) -> Self {
        let redeem = two_of_two(None, &kb, &kz);
        let cancel = two_of_two(Some(t1), &kb, &kz);
        let refund = two_of_two(None, &kz, &kb);
        let punish = Builder::new()
            .push_int(i64::from(t2))
            .push_opcode(OP_CSV)
            .push_opcode(OP_DROP)
            .push_x_only_key(&kz)
            .push_opcode(OP_CHECKSIG)
            .into_script();
        let lock = TapOut::new(&redeem, &cancel);
        let cancel_out = TapOut::new(&refund, &punish);
        SwapScripts {
            kb,
            kz,
            t1,
            t2,
            redeem,
            cancel,
            refund,
            punish,
            lock,
            cancel_out,
        }
    }
}

/// `<first> CHECKSIGVERIFY <second> CHECKSIG`, optionally behind `<csv> CSV DROP`.
fn two_of_two(csv: Option<u16>, first: &XOnlyPublicKey, second: &XOnlyPublicKey) -> ScriptBuf {
    let mut b = Builder::new();
    if let Some(t) = csv {
        b = b
            .push_int(i64::from(t))
            .push_opcode(OP_CSV)
            .push_opcode(OP_DROP);
    }
    b.push_x_only_key(first)
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_x_only_key(second)
        .push_opcode(OP_CHECKSIG)
        .into_script()
}
