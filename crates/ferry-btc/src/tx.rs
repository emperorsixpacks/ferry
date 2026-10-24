//! Transaction templates spending the lock and cancel outputs, sighashes and witnesses.

use bitcoin::absolute::LockTime;
use bitcoin::hashes::Hash;
use bitcoin::script::ScriptBuf;
use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{LeafVersion, TapLeafHash};
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, Sequence, Transaction, TxIn, TxOut, Txid, VarInt, Witness};

use crate::adaptor::Signature;
use crate::chain::Coin;
use crate::scripts::{SwapScripts, TapOut};
use crate::Role;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TxError {
    #[error("output below dust after fees ({0})")]
    Dust(Amount),
    #[error("{0:?} has no signature slot for {1:?}")]
    NoSlot(Spend, Role),
    #[error("witness has no 64-byte signature at index {0}")]
    BadWitness(usize),
}

/// The four presigned spends of a swap.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Spend {
    /// lock → cancel output, after T1 (both sign up front).
    Cancel,
    /// lock → Z (B's signature is an adaptor signature under Z_s).
    Redeem,
    /// cancel output → B (Z's signature is an adaptor signature under B_s).
    Refund,
    /// cancel output → Z, after T2 (Z alone).
    Punish,
}

/// Unsigned transactions for every spend of one lock output.
#[derive(Clone, Debug)]
pub struct SwapTxs {
    pub scripts: SwapScripts,
    pub lock_outpoint: OutPoint,
    pub lock_txout: TxOut,
    pub cancel: Transaction,
    pub redeem: Transaction,
    pub refund: Transaction,
    pub punish: Transaction,
}

impl SwapTxs {
    /// Build all templates. Each transaction pays one fixed `fee`; refund and punish come
    /// out of the cancel output, so they pay `lock_amount - 2·fee`. Every output must clear
    /// `coin`'s dust threshold for its script type.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        coin: Coin,
        scripts: SwapScripts,
        lock_outpoint: OutPoint,
        lock_amount: Amount,
        fee: Amount,
        redeem_to: ScriptBuf,
        refund_to: ScriptBuf,
        punish_to: ScriptBuf,
    ) -> Result<Self, TxError> {
        let cancel_value = checked_sub(lock_amount, fee)?;
        let final_value = checked_sub(cancel_value, fee)?;
        let cancel_spk = scripts.cancel_out.script_pubkey();
        for (value, spk) in [
            (cancel_value, &cancel_spk),
            (cancel_value, &redeem_to),
            (final_value, &refund_to),
            (final_value, &punish_to),
        ] {
            if value < coin.dust(spk) {
                return Err(TxError::Dust(value));
            }
        }
        let lock_txout = TxOut {
            value: lock_amount,
            script_pubkey: scripts.lock.script_pubkey(),
        };

        let cancel = spend_tx(
            lock_outpoint,
            Sequence::from_height(scripts.t1),
            TxOut {
                value: cancel_value,
                script_pubkey: scripts.cancel_out.script_pubkey(),
            },
        );
        let cancel_outpoint = OutPoint {
            txid: cancel.compute_txid(),
            vout: 0,
        };
        let redeem = spend_tx(
            lock_outpoint,
            Sequence::ENABLE_RBF_NO_LOCKTIME,
            TxOut {
                value: cancel_value,
                script_pubkey: redeem_to,
            },
        );
        let refund = spend_tx(
            cancel_outpoint,
            Sequence::ENABLE_RBF_NO_LOCKTIME,
            TxOut {
                value: final_value,
                script_pubkey: refund_to,
            },
        );
        let punish = spend_tx(
            cancel_outpoint,
            Sequence::from_height(scripts.t2),
            TxOut {
                value: final_value,
                script_pubkey: punish_to,
            },
        );
        Ok(SwapTxs {
            scripts,
            lock_outpoint,
            lock_txout,
            cancel,
            redeem,
            refund,
            punish,
        })
    }

    pub fn tx(&self, spend: Spend) -> &Transaction {
        match spend {
            Spend::Cancel => &self.cancel,
            Spend::Redeem => &self.redeem,
            Spend::Refund => &self.refund,
            Spend::Punish => &self.punish,
        }
    }

    /// Final txid (segwit: signatures do not change it).
    pub fn txid(&self, spend: Spend) -> Txid {
        self.tx(spend).compute_txid()
    }

    /// Which spend `tx` is, matched by txid.
    pub fn classify(&self, tx: &Transaction) -> Option<Spend> {
        let txid = tx.compute_txid();
        [Spend::Cancel, Spend::Redeem, Spend::Refund, Spend::Punish]
            .into_iter()
            .find(|s| self.txid(*s) == txid)
    }

    /// The output being spent.
    pub fn prevout(&self, spend: Spend) -> &TxOut {
        match spend {
            Spend::Cancel | Spend::Redeem => &self.lock_txout,
            Spend::Refund | Spend::Punish => &self.cancel.output[0],
        }
    }

    pub fn leaf(&self, spend: Spend) -> &ScriptBuf {
        match spend {
            Spend::Cancel => &self.scripts.cancel,
            Spend::Redeem => &self.scripts.redeem,
            Spend::Refund => &self.scripts.refund,
            Spend::Punish => &self.scripts.punish,
        }
    }

    fn tap_out(&self, spend: Spend) -> &TapOut {
        match spend {
            Spend::Cancel | Spend::Redeem => &self.scripts.lock,
            Spend::Refund | Spend::Punish => &self.scripts.cancel_out,
        }
    }

    /// Virtual size, in vbytes, that `spend` will have once signed, from its template alone (no
    /// signatures needed). tx_redeem of a key-path swap (`scripts.keypath`) is predicted with
    /// the one-signature key-path witness [`SwapTxs::complete_keypath_redeem`] builds; every
    /// other spend, and a script-path redeem, with the leaf witness [`SwapTxs::complete`] builds.
    /// A fee bump needs this to turn a fee rate into a fee before anything is signed.
    pub fn vsize(&self, spend: Spend) -> u64 {
        self.vsize_shaped(spend, spend == Spend::Redeem && self.scripts.keypath)
    }

    /// [`SwapTxs::vsize`] with the witness shape named: `key_path` is honoured for
    /// [`Spend::Redeem`] only (the other three spends have no key path).
    pub fn vsize_shaped(&self, spend: Spend, key_path: bool) -> u64 {
        let tx = self.tx(spend);
        // Without witness: version, inputs (outpoint 36 + empty scriptSig 1 + sequence 4),
        // outputs (value 8 + script length + script), locktime.
        let mut base = 4 + VarInt(tx.input.len() as u64).size() + tx.input.len() * 41;
        base += VarInt(tx.output.len() as u64).size();
        for out in &tx.output {
            let spk = out.script_pubkey.len();
            base += 8 + VarInt(spk as u64).size() + spk;
        }
        base += 4;
        // Witness of the single input: item count, then each item behind its length.
        let item = |len: usize| VarInt(len as u64).size() + len;
        let items = if key_path && spend == Spend::Redeem {
            item(64)
        } else {
            let sigs = if spend == Spend::Punish { 1 } else { 2 };
            let control = self
                .tap_out(spend)
                .control_block(self.leaf(spend))
                .expect("leaf is in the tree")
                .serialize()
                .len();
            sigs * item(64) + item(self.leaf(spend).len()) + item(control)
        };
        let count = if key_path && spend == Spend::Redeem {
            1
        } else if spend == Spend::Punish {
            3
        } else {
            4
        };
        // Segwit marker and flag (2 bytes), then the witness.
        let witness = 2 + VarInt(count).size() + items;
        (base * 4 + witness).div_ceil(4) as u64
    }

    /// BIP341 script-path sighash (SIGHASH_DEFAULT) for the spend's leaf.
    pub fn sighash(&self, spend: Spend) -> [u8; 32] {
        let leaf_hash = TapLeafHash::from_script(self.leaf(spend), LeafVersion::TapScript);
        SighashCache::new(self.tx(spend))
            .taproot_script_spend_signature_hash(
                0,
                &Prevouts::All(&[self.prevout(spend)]),
                leaf_hash,
                TapSighashType::Default,
            )
            .expect("single input, matching prevout")
            .to_byte_array()
    }

    /// BIP341 key-path sighash (SIGHASH_DEFAULT) of tx_redeem, for the MuSig2 key path.
    pub fn keypath_redeem_sighash(&self) -> [u8; 32] {
        SighashCache::new(&self.redeem)
            .taproot_key_spend_signature_hash(
                0,
                &Prevouts::All(&[&self.lock_txout]),
                TapSighashType::Default,
            )
            .expect("single input, matching prevout")
            .to_byte_array()
    }

    /// tx_redeem spent through the key path: the witness is one 64-byte signature.
    pub fn complete_keypath_redeem(&self, sig: &Signature) -> Transaction {
        let mut tx = self.redeem.clone();
        let mut w = Witness::new();
        w.push(sig.to_bytes());
        tx.input[0].witness = w;
        tx
    }

    /// The key-path signature of a published spend, if it was a key-path spend.
    pub fn keypath_sig(tx: &Transaction) -> Option<Signature> {
        let w = &tx.input.first()?.witness;
        if w.len() != 1 {
            return None;
        }
        Signature::from_bytes(w.nth(0)?.try_into().ok()?)
    }

    /// Witness index of `role`'s signature. The script's first key is checked first and so
    /// pops the top-most signature: `<K1> CHECKSIGVERIFY <K2> CHECKSIG` takes `[sig_K2, sig_K1]`.
    pub fn sig_index(spend: Spend, role: Role) -> Result<usize, TxError> {
        match (spend, role) {
            (Spend::Cancel | Spend::Redeem, Role::Z) => Ok(0),
            (Spend::Cancel | Spend::Redeem, Role::B) => Ok(1),
            (Spend::Refund, Role::B) => Ok(0),
            (Spend::Refund, Role::Z) => Ok(1),
            (Spend::Punish, Role::Z) => Ok(0),
            (Spend::Punish, Role::B) => Err(TxError::NoSlot(spend, role)),
        }
    }

    /// Signed transaction for a two-party leaf (cancel, redeem, refund).
    pub fn complete(
        &self,
        spend: Spend,
        sig_b: &Signature,
        sig_z: &Signature,
    ) -> Result<Transaction, TxError> {
        let mut sigs = [sig_z, sig_b];
        if Self::sig_index(spend, Role::B)? == 0 {
            sigs.swap(0, 1);
        }
        Ok(self.with_witness(spend, &sigs))
    }

    /// Signed punish transaction (Z alone).
    pub fn complete_punish(&self, sig_z: &Signature) -> Transaction {
        self.with_witness(Spend::Punish, &[sig_z])
    }

    fn with_witness(&self, spend: Spend, sigs: &[&Signature]) -> Transaction {
        let leaf = self.leaf(spend);
        let control = self
            .tap_out(spend)
            .control_block(leaf)
            .expect("leaf is in the tree");
        let mut w = Witness::new();
        for sig in sigs {
            w.push(sig.to_bytes());
        }
        w.push(leaf.as_bytes());
        w.push(control.serialize());
        let mut tx = self.tx(spend).clone();
        tx.input[0].witness = w;
        tx
    }

    /// `role`'s signature from a published spend.
    pub fn witness_sig(tx: &Transaction, spend: Spend, role: Role) -> Result<Signature, TxError> {
        let i = Self::sig_index(spend, role)?;
        let item = tx
            .input
            .first()
            .and_then(|inp| inp.witness.nth(i))
            .ok_or(TxError::BadWitness(i))?;
        let bytes: [u8; 64] = item.try_into().map_err(|_| TxError::BadWitness(i))?;
        Signature::from_bytes(bytes).ok_or(TxError::BadWitness(i))
    }
}

fn checked_sub(value: Amount, fee: Amount) -> Result<Amount, TxError> {
    value.checked_sub(fee).ok_or(TxError::Dust(value))
}

/// 1-in-1-out, version 2 (BIP68 relative locktimes need it).
fn spend_tx(prev: OutPoint, sequence: Sequence, out: TxOut) -> Transaction {
    Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: prev,
            sequence,
            ..Default::default()
        }],
        output: vec![out],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adaptor::{self, BtcKey, EncryptionKey};

    fn fixture() -> (BtcKey, BtcKey, SwapTxs) {
        let (b, z) = (BtcKey::random(), BtcKey::random());
        let scripts = SwapScripts::new(b.xonly(), z.xonly(), 10, 20, false);
        let lock = OutPoint {
            txid: Txid::all_zeros(),
            vout: 0,
        };
        let to = |k: &BtcKey| ScriptBuf::new_p2tr(&bitcoin::key::Secp256k1::new(), k.xonly(), None);
        let txs = SwapTxs::new(
            Coin::Btc,
            scripts,
            lock,
            Amount::from_sat(100_000),
            Amount::from_sat(1_000),
            to(&z),
            to(&b),
            to(&z),
        )
        .unwrap();
        (b, z, txs)
    }

    /// Fixed keys, a fixed lock outpoint and fixed amounts: every txid and sighash below is a
    /// pure function of these, so they are the same on every run.
    fn golden(keypath: bool) -> SwapTxs {
        let b = BtcKey::from_secret_bytes(&[0x11; 32]).unwrap();
        let z = BtcKey::from_secret_bytes(&[0x22; 32]).unwrap();
        let scripts = SwapScripts::new(b.xonly(), z.xonly(), 12, 24, keypath);
        let lock = OutPoint {
            txid: Txid::from_byte_array([0x33; 32]),
            vout: 1,
        };
        let secp = bitcoin::key::Secp256k1::new();
        let to = |k: &BtcKey| ScriptBuf::new_p2tr(&secp, k.xonly(), None);
        SwapTxs::new(
            Coin::Btc,
            scripts,
            lock,
            Amount::from_sat(1_000_000),
            Amount::from_sat(2_000),
            to(&z),
            to(&b),
            to(&z),
        )
        .unwrap()
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// The templates are a protocol: the same params must give the same txids and sighashes
    /// in every release, or a swap in flight across an upgrade would sign and broadcast
    /// different transactions than its peer. These values were taken from the code before
    /// `vsize` and every fee-bump change existed. If this test fails, a template changed.
    #[test]
    fn golden_txids_and_sighashes_are_unchanged() {
        let ids = [
            (
                "cancel",
                "57e506808fed029469373edc25384764d7ace3f89a061dddf66331977fa09118",
            ),
            (
                "redeem",
                "78159217167d3830ce7c01ce85dd815e825b61f3e5c27a65a2dba0b4fbfbffd4",
            ),
            (
                "refund",
                "06dd96fea9935aa09c9f2f539745751c522b87d62be7e12e9582b3a684ec2222",
            ),
            (
                "punish",
                "37b8615d8ffa0690d96203f6a57cc6e559eaefb2a44fc76b1c81e5d107e23ede",
            ),
        ];
        // Script-path sighashes [cancel, redeem, refund, punish], the key-path redeem sighash,
        // and the lock output script, for a script-path swap and a key-path swap.
        let cases = [
            (
                false,
                [
                    "1598c059fd4f64b3dbe0753880acde9d380f16d8c4558b4d24689bfeae067765",
                    "42436106e031a52cf1de01a48b959d680ffd49d11df4c7891d177dba96ed4eb6",
                    "6f2a58f846733b9c31b2ec786e2a1892f02085c3c2128f55383b6d11f8357e48",
                    "c6cf3ac5c6a376226cf53075046bb2492aef7a6dd77b32a99555e8a6e76be669",
                ],
                "65f5461068852be04b43a7b969a75ca04649c05511a635363784dbcad3c8a03e",
                "512008d2b2c421eccd49b190298c723d3e45a78f4865e26a3006fee38ec89f814d52",
            ),
            (
                true,
                [
                    "c10e625e72db0639a570553f02a95e13839ddd35ed3867c91f8b96d0b7fa19c2",
                    "a001db633c9885056eead0867283d7973d455dcaf52475601b2c1926a8555d67",
                    "6f2a58f846733b9c31b2ec786e2a1892f02085c3c2128f55383b6d11f8357e48",
                    "c6cf3ac5c6a376226cf53075046bb2492aef7a6dd77b32a99555e8a6e76be669",
                ],
                "53baccdddd9b7a4db0e6b907f346fa1870e1b1b403682820f89afd1d6b9490de",
                "512001fe52436d62c2009f0be8be024732073666c99fff9832bd6a2c795a61a1682c",
            ),
        ];
        let spends = [Spend::Cancel, Spend::Redeem, Spend::Refund, Spend::Punish];
        for (keypath, hashes, keypath_hash, lock_spk) in cases {
            let t = golden(keypath);
            // The txids do not depend on the lock script: they commit to the lock outpoint.
            for (spend, (name, id)) in spends.iter().zip(ids) {
                assert_eq!(
                    t.txid(*spend).to_string(),
                    id,
                    "{name} txid, keypath={keypath}"
                );
            }
            for (spend, h) in spends.iter().zip(hashes) {
                assert_eq!(
                    hex(&t.sighash(*spend)),
                    h,
                    "{spend:?} sighash, keypath={keypath}"
                );
            }
            assert_eq!(hex(&t.keypath_redeem_sighash()), keypath_hash);
            assert_eq!(t.lock_txout.script_pubkey.to_hex_string(), lock_spk);
            // The shape the fee-bump code relies on: one input, one output, version 2.
            for s in spends {
                let tx = t.tx(s);
                assert_eq!(
                    (tx.version, tx.input.len(), tx.output.len()),
                    (Version::TWO, 1, 1)
                );
            }
        }
    }

    /// Payout script types the daemon may meet: P2TR, P2WPKH, P2WSH, P2PKH, P2SH.
    fn payout_scripts(k: &BtcKey) -> Vec<ScriptBuf> {
        use bitcoin::{PubkeyHash, ScriptHash, WPubkeyHash, WScriptHash};
        vec![
            ScriptBuf::new_p2tr(&bitcoin::key::Secp256k1::new(), k.xonly(), None),
            ScriptBuf::new_p2wpkh(&WPubkeyHash::from_byte_array([7; 20])),
            ScriptBuf::new_p2wsh(&WScriptHash::from_byte_array([8; 32])),
            ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array([9; 20])),
            ScriptBuf::new_p2sh(&ScriptHash::from_byte_array([10; 20])),
        ]
    }

    #[test]
    fn vsize_matches_the_signed_transactions() {
        let b = BtcKey::from_secret_bytes(&[0x11; 32]).unwrap();
        let z = BtcKey::from_secret_bytes(&[0x22; 32]).unwrap();
        let lock = OutPoint {
            txid: Txid::from_byte_array([0x33; 32]),
            vout: 0,
        };
        // Timelock push widths: OP_N (1 byte), then pushes of 1, 2 and 3 bytes; the top of the
        // u16 range needs a sign byte.
        let timelocks = [
            (1u16, 2u16),
            (16, 17),
            (127, 128),
            (500, 12_000),
            (32_767, 32_768),
            (65_535, 65_534),
        ];
        let mut checked = 0;
        for (t1, t2) in timelocks {
            for keypath in [false, true] {
                for to in payout_scripts(&z) {
                    let scripts = SwapScripts::new(b.xonly(), z.xonly(), t1, t2, keypath);
                    let txs = SwapTxs::new(
                        Coin::Btc,
                        scripts,
                        lock,
                        Amount::from_sat(1_000_000),
                        Amount::from_sat(2_000),
                        to.clone(),
                        to.clone(),
                        to.clone(),
                    )
                    .unwrap();
                    for spend in [Spend::Cancel, Spend::Redeem, Spend::Refund, Spend::Punish] {
                        let h = txs.sighash(spend);
                        let (sig_b, sig_z) = (b.sign(&h), z.sign(&h));
                        let signed = if spend == Spend::Punish {
                            txs.complete_punish(&sig_z)
                        } else {
                            txs.complete(spend, &sig_b, &sig_z).unwrap()
                        };
                        assert_eq!(
                            txs.vsize_shaped(spend, false),
                            signed.vsize() as u64,
                            "{spend:?} script path, t1={t1} t2={t2} keypath={keypath}"
                        );
                        checked += 1;
                        if spend == Spend::Redeem {
                            let kp =
                                txs.complete_keypath_redeem(&z.sign(&txs.keypath_redeem_sighash()));
                            assert_eq!(
                                txs.vsize_shaped(Spend::Redeem, true),
                                kp.vsize() as u64,
                                "redeem key path, t1={t1} t2={t2}"
                            );
                            // vsize() picks the shape the swap's mode completes with.
                            let expect = if keypath { kp.vsize() } else { signed.vsize() };
                            assert_eq!(txs.vsize(Spend::Redeem), expect as u64);
                            checked += 1;
                        } else {
                            assert_eq!(txs.vsize(spend), signed.vsize() as u64);
                        }
                    }
                }
            }
        }
        // 6 timelock pairs x 2 modes x 5 payout types x 4 spends, plus the key-path redeem.
        assert_eq!(checked, 6 * 2 * 5 * 5);
    }

    /// The figures the fee-bump plan quotes (t1=12, t2=24, P2TR payouts): cancel 162, redeem
    /// 111 on the key path and 161 on a script path, refund 161, punish 138 vbytes.
    #[test]
    fn vsize_of_the_documented_swap() {
        let script = golden(false);
        let key = golden(true);
        assert_eq!(script.vsize(Spend::Cancel), 162);
        assert_eq!(script.vsize(Spend::Redeem), 161);
        assert_eq!(script.vsize(Spend::Refund), 161);
        assert_eq!(script.vsize(Spend::Punish), 138);
        assert_eq!(key.vsize(Spend::Redeem), 111);
        assert_eq!(key.vsize_shaped(Spend::Redeem, false), 161);
        assert_eq!(
            key.vsize(Spend::Cancel),
            162,
            "only the redeem has a key path"
        );
    }

    #[test]
    fn templates_chain_and_carry_timelocks() {
        let (_, _, txs) = fixture();
        assert_eq!(
            txs.refund.input[0].previous_output.txid,
            txs.txid(Spend::Cancel)
        );
        assert_eq!(
            txs.punish.input[0].previous_output.txid,
            txs.txid(Spend::Cancel)
        );
        assert_eq!(txs.cancel.input[0].sequence, Sequence::from_height(10));
        assert_eq!(txs.punish.input[0].sequence, Sequence::from_height(20));
        assert_eq!(txs.refund.output[0].value, Amount::from_sat(98_000));
        for s in [Spend::Cancel, Spend::Redeem, Spend::Refund, Spend::Punish] {
            assert_eq!(txs.tx(s).version, Version::TWO);
            assert_eq!(txs.classify(txs.tx(s)), Some(s));
        }
    }

    #[test]
    fn dust_rejected() {
        let (b, z) = (BtcKey::random(), BtcKey::random());
        let scripts = SwapScripts::new(b.xonly(), z.xonly(), 10, 20, false);
        let lock = OutPoint {
            txid: Txid::all_zeros(),
            vout: 0,
        };
        let r = SwapTxs::new(
            Coin::Btc,
            scripts,
            lock,
            Amount::from_sat(2_200),
            Amount::from_sat(1_000),
            ScriptBuf::new(),
            ScriptBuf::new(),
            ScriptBuf::new(),
        );
        assert!(matches!(r, Err(TxError::Dust(_))));

        // 3000 after two fees clears P2TR dust on Bitcoin (330) but not on Litecoin (3300).
        let to = ScriptBuf::new_p2tr(&bitcoin::key::Secp256k1::new(), z.xonly(), None);
        let build = |coin| {
            SwapTxs::new(
                coin,
                SwapScripts::new(b.xonly(), z.xonly(), 10, 20, false),
                lock,
                Amount::from_sat(5_000),
                Amount::from_sat(1_000),
                to.clone(),
                to.clone(),
                to.clone(),
            )
        };
        assert!(build(Coin::Btc).is_ok());
        assert_eq!(
            build(Coin::Ltc).unwrap_err(),
            TxError::Dust(Amount::from_sat(3_000))
        );
    }

    #[test]
    fn witness_order_and_extraction() {
        let (b, z, txs) = fixture();
        let t = EncryptionKey::from_secret(&[9u8; 32]).unwrap();
        let h = txs.sighash(Spend::Redeem);
        let enc_b = b.encrypted_sign(&t, &h);
        let sig_b = adaptor::decrypt(&[9u8; 32], &enc_b).unwrap();
        let sig_z = z.sign(&h);
        let tx = txs.complete(Spend::Redeem, &sig_b, &sig_z).unwrap();
        assert_eq!(
            SwapTxs::witness_sig(&tx, Spend::Redeem, Role::B).unwrap(),
            sig_b
        );
        assert_eq!(
            SwapTxs::witness_sig(&tx, Spend::Redeem, Role::Z).unwrap(),
            sig_z
        );
        assert_eq!(*adaptor::recover(&t, &enc_b, &sig_b).unwrap(), [9u8; 32]);

        let h = txs.sighash(Spend::Refund);
        let (sig_b, sig_z) = (b.sign(&h), z.sign(&h));
        let tx = txs.complete(Spend::Refund, &sig_b, &sig_z).unwrap();
        // refund leaf is <kz> CHECKSIGVERIFY <kb> CHECKSIG -> [sig_b, sig_z]
        assert_eq!(tx.input[0].witness.nth(0).unwrap(), sig_b.to_bytes());
        assert_eq!(
            SwapTxs::witness_sig(&tx, Spend::Refund, Role::Z).unwrap(),
            sig_z
        );
        assert!(txs.complete(Spend::Punish, &sig_b, &sig_z).is_err());
    }
}
