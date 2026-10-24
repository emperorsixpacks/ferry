//! Transaction templates spending the lock and cancel outputs, sighashes and witnesses.

use bitcoin::absolute::LockTime;
use bitcoin::hashes::Hash;
use bitcoin::script::ScriptBuf;
use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{LeafVersion, TapLeafHash};
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, Sequence, Transaction, TxIn, TxOut, Txid, Witness};

use crate::adaptor::Signature;
use crate::scripts::{SwapScripts, TapOut};
use crate::Role;

/// Smallest output value relayed for a P2TR/P2WPKH-sized output.
pub const DUST_LIMIT: Amount = Amount::from_sat(330);

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
    /// out of the cancel output, so they pay `lock_amount - 2·fee`.
    pub fn new(
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
    match value.checked_sub(fee) {
        Some(v) if v >= DUST_LIMIT => Ok(v),
        _ => Err(TxError::Dust(value)),
    }
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
            scripts,
            lock,
            Amount::from_sat(2_200),
            Amount::from_sat(1_000),
            ScriptBuf::new(),
            ScriptBuf::new(),
            ScriptBuf::new(),
        );
        assert!(matches!(r, Err(TxError::Dust(_))));
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
