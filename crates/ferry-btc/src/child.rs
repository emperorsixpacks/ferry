//! The child of a fee bump (CPFP): an ordinary version-2 transaction that spends the output of a
//! presigned spend which its broadcaster owns, and pays the fee out of that output.
//!
//! Every deadline-critical spend of a swap already pays its broadcaster: tx_redeem pays Z's own
//! wallet address, tx_refund B's, tx_punish Z's. That party raises the parent's effective fee by
//! spending the output in a child that pays a higher fee, with no anchor output, no extra
//! presigned data and no change to any presigned transaction. This module builds that child and
//! refuses everything that could make it burn more than intended:
//!
//! * the fee may not exceed the caller's hard cap ([`ChildLimits::max_fee`]) and its rate may not
//!   exceed [`ChildLimits::max_fee_rate`];
//! * the child's output must clear the coin's dust threshold, so the fee is never "everything";
//! * the coin it spends may not be one the wallet has locked (an unbroadcast lock's input);
//! * the wallet must sign it completely, and the signed transaction must be exactly the template
//!   (same txid) and no larger than predicted, so the fee rate the planner chose is the rate paid.

use std::future::Future;

use bitcoin::absolute::LockTime;
use bitcoin::script::Script;
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, Sequence, Transaction, TxIn, TxOut, VarInt};

use crate::chain::Coin;
use crate::rpc::RpcError;

/// Fee, in satoshis, of `vsize` vbytes at `rate` satoshis per 1000 vbytes, rounded up to a whole
/// satoshi as the node rounds its own floors (saturating).
pub fn fee_for(rate: u64, vsize: u64) -> u64 {
    let fee = (u128::from(rate) * u128::from(vsize)).div_ceil(1000);
    u64::try_from(fee).unwrap_or(u64::MAX)
}

/// Fee rate, in satoshis per 1000 vbytes, of paying `fee` for `vsize` vbytes (rounded down;
/// zero for an empty transaction).
pub fn rate_of(fee: u64, vsize: u64) -> u64 {
    if vsize == 0 {
        return 0;
    }
    u64::try_from(u128::from(fee) * 1000 / u128::from(vsize)).unwrap_or(u64::MAX)
}

/// What a child may pay. There is no default: every caller states its cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChildLimits {
    /// The most the child may pay in fee.
    pub max_fee: Amount,
    /// The highest fee rate (sat per 1000 vbytes) the child may pay. It is also what the node is
    /// told as `maxfeerate` when the child is tested or sent.
    pub max_fee_rate: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ChildError {
    #[error("the parent has no output {0}")]
    NoOutput(u32),
    #[error("{0} is a coin the wallet has locked (the input of a lock not yet broadcast)")]
    LockedCoin(OutPoint),
    #[error("the fee {fee} is above the cap {cap}")]
    FeeAboveCap { fee: Amount, cap: Amount },
    #[error("the fee rate {rate} sat/kvB is above the cap {cap} sat/kvB")]
    RateAboveCap { rate: u64, cap: u64 },
    #[error("the fee {fee} is not below the output it is paid from ({value})")]
    FeeNotBelowValue { fee: Amount, value: Amount },
    #[error("the child's output would be {value}, below the dust threshold {dust}")]
    Dust { value: Amount, dust: Amount },
    #[error("cannot size an input that pays to {0}: only Taproot and P2WPKH outputs are bumped")]
    UnsupportedInput(String),
    #[error("the child must pay to a spendable output script")]
    BadPayTo,
    #[error("the wallet could not sign the child: the parent output is not one of its own, or the wallet is locked")]
    NotSigned,
    #[error("the wallet changed the child ({0})")]
    Altered(&'static str),
    #[error("the signed child is {actual} vB, larger than the {predicted} vB its fee was set for")]
    Larger { actual: u64, predicted: u64 },
    #[error("node: {0}")]
    Rpc(#[from] RpcError),
}

/// A signed child, ready for `testmempoolaccept` and then to be sent.
#[derive(Clone, Debug)]
pub struct BuiltChild {
    pub tx: Transaction,
    pub fee: Amount,
    pub vsize: u64,
}

/// The wallet side of building a child: what the node's wallet has locked, and signing.
pub trait ChildWallet {
    /// The coins the wallet has locked (`listlockunspent`).
    fn locked_coins(&self) -> impl Future<Output = Result<Vec<OutPoint>, RpcError>> + Send;

    /// Sign `tx`, which spends one `prevout`. The previous output is passed along, so a parent
    /// the node no longer has in its mempool can still be spent. Returns the transaction as
    /// signed and whether the wallet signed every input.
    fn sign_child(
        &self,
        tx: &Transaction,
        prevout: &TxOut,
    ) -> impl Future<Output = Result<(Transaction, bool), RpcError>> + Send;
}

/// Upper bound on the vsize of the child once signed, from the input and output scripts alone:
/// one input and one output, the wallet's signature at its largest (72 bytes for ECDSA, 64 for
/// Schnorr with the default sighash). Taproot and P2WPKH inputs only: those are what the node's
/// wallet addresses are, and they are segwit, so a child's txid is final as soon as it is signed.
pub fn vsize_bound(input: &Script, output: &Script) -> Result<u64, ChildError> {
    let item = |len: usize| VarInt(len as u64).size() + len;
    let witness_items = if input.is_p2tr() {
        item(64)
    } else if input.is_p2wpkh() {
        item(72) + item(33)
    } else {
        return Err(ChildError::UnsupportedInput(input.to_hex_string()));
    };
    let item_count = if input.is_p2tr() { 1 } else { 2 };
    // Without witness: version, one input (outpoint 36 + empty scriptSig 1 + sequence 4), one
    // output (value 8 + script length + script), locktime.
    let base = 4 + 1 + 41 + 1 + (8 + VarInt(output.len() as u64).size() + output.len()) + 4;
    // Segwit marker and flag, the item count, the items.
    let witness = 2 + VarInt(item_count).size() + witness_items;
    Ok((base * 4 + witness).div_ceil(4) as u64)
}

/// The unsigned child that spends `parent`'s output `vout` and pays `pay_to` the rest after
/// `fee`, with the vsize bound its fee was set for. Version 2, no locktime, signalling
/// replaceability (BIP125) so a later child can replace it on nodes without full RBF. Every
/// refusal of [`ChildError`] that needs no wallet is made here.
pub fn child_template(
    parent: &Transaction,
    vout: u32,
    pay_to: &Script,
    fee: Amount,
    coin: Coin,
    limits: &ChildLimits,
    locked: &[OutPoint],
) -> Result<(Transaction, u64), ChildError> {
    let prev = parent
        .output
        .get(vout as usize)
        .ok_or(ChildError::NoOutput(vout))?;
    let outpoint = OutPoint {
        txid: parent.compute_txid(),
        vout,
    };
    if locked.contains(&outpoint) {
        return Err(ChildError::LockedCoin(outpoint));
    }
    if pay_to.is_empty() || pay_to.is_op_return() {
        return Err(ChildError::BadPayTo);
    }
    let predicted = vsize_bound(&prev.script_pubkey, pay_to)?;
    if fee > limits.max_fee {
        return Err(ChildError::FeeAboveCap {
            fee,
            cap: limits.max_fee,
        });
    }
    // Even the largest the child can be does not make this rate acceptable; the signed size is
    // checked again once it is known.
    if fee.to_sat().saturating_mul(1000) > limits.max_fee_rate.saturating_mul(predicted) {
        return Err(ChildError::RateAboveCap {
            rate: rate_of(fee.to_sat(), predicted),
            cap: limits.max_fee_rate,
        });
    }
    let value = prev
        .value
        .checked_sub(fee)
        .ok_or(ChildError::FeeNotBelowValue {
            fee,
            value: prev.value,
        })?;
    let dust = coin.dust(pay_to);
    if value < dust {
        return Err(ChildError::Dust { value, dust });
    }
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: outpoint,
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            ..Default::default()
        }],
        output: vec![TxOut {
            value,
            script_pubkey: pay_to.to_owned(),
        }],
    };
    Ok((tx, predicted))
}

/// Build and sign the child of `parent` (see [`child_template`]) with `wallet`, and check what
/// the wallet returned: complete, exactly the template, segwit, and no larger than predicted.
pub async fn build_child<W: ChildWallet>(
    wallet: &W,
    parent: &Transaction,
    vout: u32,
    pay_to: &Script,
    fee: Amount,
    coin: Coin,
    limits: &ChildLimits,
) -> Result<BuiltChild, ChildError> {
    let locked = wallet.locked_coins().await?;
    let (template, predicted) = child_template(parent, vout, pay_to, fee, coin, limits, &locked)?;
    let prevout = &parent.output[vout as usize];
    let (signed, complete) = wallet.sign_child(&template, prevout).await?;
    if !complete {
        return Err(ChildError::NotSigned);
    }
    // A segwit transaction's txid does not cover its witness: the same txid means the wallet
    // changed neither inputs, outputs, version, locktime nor sequences.
    if signed.compute_txid() != template.compute_txid() {
        return Err(ChildError::Altered("txid differs from the template"));
    }
    if signed.input.len() != 1
        || !signed.input[0].script_sig.is_empty()
        || signed.input[0].witness.is_empty()
    {
        return Err(ChildError::Altered("the input is not a segwit spend"));
    }
    let vsize = signed.vsize() as u64;
    if vsize > predicted {
        return Err(ChildError::Larger {
            actual: vsize,
            predicted,
        });
    }
    if fee.to_sat().saturating_mul(1000) > limits.max_fee_rate.saturating_mul(vsize) {
        return Err(ChildError::RateAboveCap {
            rate: rate_of(fee.to_sat(), vsize),
            cap: limits.max_fee_rate,
        });
    }
    Ok(BuiltChild {
        tx: signed,
        fee,
        vsize,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::hashes::Hash;
    use bitcoin::key::Secp256k1;
    use bitcoin::{PubkeyHash, ScriptBuf, ScriptHash, Txid, WPubkeyHash, WScriptHash, Witness};

    use crate::adaptor::BtcKey;

    fn p2tr(seed: u8) -> ScriptBuf {
        let k = BtcKey::from_secret_bytes(&[seed; 32]).unwrap();
        ScriptBuf::new_p2tr(&Secp256k1::new(), k.xonly(), None)
    }

    fn p2wpkh() -> ScriptBuf {
        ScriptBuf::new_p2wpkh(&WPubkeyHash::from_byte_array([5; 20]))
    }

    /// A parent with its payout (the output the child spends) at index 1, so index 0 vs 1 is
    /// exercised, paying `value` to `spk`.
    fn parent(spk: ScriptBuf, value: u64) -> Transaction {
        Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_byte_array([1; 32]),
                    vout: 0,
                },
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                ..Default::default()
            }],
            output: vec![
                TxOut {
                    value: Amount::from_sat(10_000),
                    script_pubkey: p2tr(9),
                },
                TxOut {
                    value: Amount::from_sat(value),
                    script_pubkey: spk,
                },
            ],
        }
    }

    fn limits(max_fee: u64, max_rate: u64) -> ChildLimits {
        ChildLimits {
            max_fee: Amount::from_sat(max_fee),
            max_fee_rate: max_rate,
        }
    }

    #[test]
    fn fee_arithmetic_rounds_the_way_the_node_does() {
        assert_eq!(fee_for(1_000, 111), 111, "1 sat/vB");
        assert_eq!(fee_for(100, 111), 12, "0.1 sat/vB rounds up: 11.1 -> 12");
        assert_eq!(fee_for(1, 1), 1, "a fraction of a satoshi is a whole one");
        assert_eq!(fee_for(0, 500), 0);
        assert_eq!(fee_for(1_500, 222), 333);
        assert_eq!(fee_for(u64::MAX, u64::MAX), u64::MAX, "saturates");
        assert_eq!(rate_of(111, 111), 1_000);
        assert_eq!(rate_of(1, 3), 333, "rounded down");
        assert_eq!(rate_of(5, 0), 0);
        // fee_for and rate_of agree: paying fee_for(rate, v) never gives a lower rate.
        for rate in [1, 99, 100, 1_000, 1_234, 50_000] {
            for v in [1, 110, 111, 154, 222, 999] {
                assert!(rate_of(fee_for(rate, v), v) >= rate, "{rate} {v}");
            }
        }
    }

    #[test]
    fn vsize_bounds() {
        // Taproot to Taproot is what the node's wallet signs for Bitcoin: 111 vB, the size the
        // plan quotes, and the size the node reported for the real child on regtest.
        assert_eq!(vsize_bound(&p2tr(1), &p2tr(2)).unwrap(), 111);
        // P2WPKH (Litecoin's wallet addresses): 110 at the 72-byte signature bound.
        assert_eq!(vsize_bound(&p2wpkh(), &p2wpkh()).unwrap(), 110);
        assert!(vsize_bound(&p2tr(1), &p2wpkh()).unwrap() < 111);
        for legacy in [
            ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array([1; 20])),
            ScriptBuf::new_p2sh(&ScriptHash::from_byte_array([2; 20])),
            ScriptBuf::new_p2wsh(&WScriptHash::from_byte_array([3; 32])),
        ] {
            assert!(matches!(
                vsize_bound(&legacy, &p2tr(1)),
                Err(ChildError::UnsupportedInput(_))
            ));
        }
    }

    #[test]
    fn template_arithmetic() {
        let p = parent(p2tr(1), 50_000);
        let (tx, predicted) = child_template(
            &p,
            1,
            &p2tr(2),
            Amount::from_sat(3_000),
            Coin::Btc,
            &limits(5_000, 100_000),
            &[],
        )
        .unwrap();
        assert_eq!(predicted, 111);
        assert_eq!(tx.version, Version::TWO);
        assert_eq!(tx.lock_time, LockTime::ZERO);
        assert_eq!(tx.input.len(), 1);
        assert_eq!(
            tx.input[0].previous_output,
            OutPoint {
                txid: p.compute_txid(),
                vout: 1
            }
        );
        assert_eq!(tx.input[0].sequence, Sequence::ENABLE_RBF_NO_LOCKTIME);
        assert_eq!(tx.output.len(), 1);
        assert_eq!(tx.output[0].value, Amount::from_sat(47_000));
        assert_eq!(tx.output[0].script_pubkey, p2tr(2));
    }

    #[test]
    fn every_refusal_that_needs_no_wallet() {
        let p = parent(p2tr(1), 50_000);
        let ok = |fee: u64, lim: ChildLimits, locked: &[OutPoint], vout: u32, to: &ScriptBuf| {
            child_template(&p, vout, to, Amount::from_sat(fee), Coin::Btc, &lim, locked)
        };
        let lim = limits(5_000, 100_000);
        assert!(ok(3_000, lim, &[], 1, &p2tr(2)).is_ok());
        // No such output.
        assert!(matches!(
            ok(3_000, lim, &[], 2, &p2tr(2)),
            Err(ChildError::NoOutput(2))
        ));
        // A coin the wallet has locked.
        let spent = OutPoint {
            txid: p.compute_txid(),
            vout: 1,
        };
        assert!(matches!(
            ok(3_000, lim, &[spent], 1, &p2tr(2)),
            Err(ChildError::LockedCoin(o)) if o == spent
        ));
        // Another locked coin does not matter.
        let other = OutPoint {
            txid: p.compute_txid(),
            vout: 0,
        };
        assert!(ok(3_000, lim, &[other], 1, &p2tr(2)).is_ok());
        // Fee cap: exactly the cap passes, one satoshi more does not.
        assert!(ok(5_000, lim, &[], 1, &p2tr(2)).is_ok());
        assert!(matches!(
            ok(5_001, lim, &[], 1, &p2tr(2)),
            Err(ChildError::FeeAboveCap { .. })
        ));
        // A cap of zero allows no child at all with a fee.
        assert!(matches!(
            ok(1, limits(0, 100_000), &[], 1, &p2tr(2)),
            Err(ChildError::FeeAboveCap { .. })
        ));
        // Rate cap: 111 vB at 100 sat/vB is 11_100; the cap is in sat per 1000 vB.
        assert!(ok(11_100, limits(50_000, 100_000), &[], 1, &p2tr(2)).is_ok());
        assert!(matches!(
            ok(11_101, limits(50_000, 100_000), &[], 1, &p2tr(2)),
            Err(ChildError::RateAboveCap { .. })
        ));
        // Bad pay-to scripts.
        assert!(matches!(
            ok(3_000, lim, &[], 1, &ScriptBuf::new()),
            Err(ChildError::BadPayTo)
        ));
        let burn = ScriptBuf::new_op_return([1, 2, 3]);
        assert!(matches!(
            ok(3_000, lim, &[], 1, &burn),
            Err(ChildError::BadPayTo)
        ));
        // A legacy parent output cannot be sized.
        let legacy = parent(
            ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array([1; 20])),
            50_000,
        );
        assert!(matches!(
            child_template(
                &legacy,
                1,
                &p2tr(2),
                Amount::from_sat(100),
                Coin::Btc,
                &lim,
                &[]
            ),
            Err(ChildError::UnsupportedInput(_))
        ));
    }

    #[test]
    fn dust_and_value_bounds() {
        let lim = limits(u64::MAX / 2, u64::MAX / 2);
        let p = parent(p2tr(1), 1_000);
        let go = |coin: Coin, fee: u64, to: &ScriptBuf| {
            child_template(&p, 1, to, Amount::from_sat(fee), coin, &lim, &[])
        };
        // P2TR dust on Bitcoin is 330: leaving exactly 330 is allowed, 329 is not.
        assert!(go(Coin::Btc, 670, &p2tr(2)).is_ok());
        assert!(matches!(
            go(Coin::Btc, 671, &p2tr(2)),
            Err(ChildError::Dust { value, dust })
                if value == Amount::from_sat(329) && dust == Amount::from_sat(330)
        ));
        // P2WPKH dust is 294 on Bitcoin.
        let w = parent(p2wpkh(), 1_000);
        assert!(child_template(
            &w,
            1,
            &p2wpkh(),
            Amount::from_sat(706),
            Coin::Btc,
            &lim,
            &[]
        )
        .is_ok());
        assert!(matches!(
            child_template(
                &w,
                1,
                &p2wpkh(),
                Amount::from_sat(707),
                Coin::Btc,
                &lim,
                &[]
            ),
            Err(ChildError::Dust { .. })
        ));
        // Litecoin's dust is ten times that: 3300 for P2TR, so 1000 can never be paid out.
        assert!(matches!(
            go(Coin::Ltc, 0, &p2tr(2)),
            Err(ChildError::Dust { dust, .. }) if dust == Amount::from_sat(3_300)
        ));
        // A fee that is the whole output (or more) is refused as such, before dust.
        assert!(matches!(
            go(Coin::Btc, 1_000, &p2tr(2)),
            Err(ChildError::Dust { .. })
        ));
        assert!(matches!(
            go(Coin::Btc, 1_001, &p2tr(2)),
            Err(ChildError::FeeNotBelowValue { .. })
        ));
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Behaviour {
        Honest,
        Incomplete,
        ChangesOutput,
        NoWitness,
        LegacyScriptSig,
        BigWitness,
        SmallWitness,
    }

    struct Mock {
        locked: Vec<OutPoint>,
        behaviour: Behaviour,
        node_down: bool,
        signed_with: std::sync::Mutex<Vec<(Transaction, TxOut)>>,
    }

    impl Mock {
        fn new(behaviour: Behaviour) -> Self {
            Mock {
                locked: vec![],
                behaviour,
                node_down: false,
                signed_with: Default::default(),
            }
        }
    }

    fn rpc_down() -> RpcError {
        RpcError::Rpc {
            method: "mock".into(),
            code: -28,
            message: "loading".into(),
        }
    }

    impl ChildWallet for Mock {
        async fn locked_coins(&self) -> Result<Vec<OutPoint>, RpcError> {
            if self.node_down {
                return Err(rpc_down());
            }
            Ok(self.locked.clone())
        }

        async fn sign_child(
            &self,
            tx: &Transaction,
            prevout: &TxOut,
        ) -> Result<(Transaction, bool), RpcError> {
            self.signed_with
                .lock()
                .unwrap()
                .push((tx.clone(), prevout.clone()));
            let mut signed = tx.clone();
            let mut w = Witness::new();
            if prevout.script_pubkey.is_p2tr() {
                w.push([7u8; 64]);
            } else {
                w.push([7u8; 72]);
                w.push([8u8; 33]);
            }
            match self.behaviour {
                Behaviour::Honest => signed.input[0].witness = w,
                Behaviour::Incomplete => return Ok((tx.clone(), false)),
                Behaviour::ChangesOutput => {
                    signed.input[0].witness = w;
                    signed.output[0].value -= Amount::from_sat(1);
                }
                Behaviour::NoWitness => {}
                Behaviour::LegacyScriptSig => {
                    signed.input[0].script_sig = ScriptBuf::from_bytes(vec![0x51]);
                }
                Behaviour::BigWitness => {
                    let mut big = Witness::new();
                    big.push([7u8; 65]);
                    signed.input[0].witness = big;
                }
                Behaviour::SmallWitness => {
                    // 69-byte signature instead of the 72-byte bound: one vbyte less.
                    let mut small = Witness::new();
                    small.push([7u8; 69]);
                    small.push([8u8; 33]);
                    signed.input[0].witness = small;
                }
            }
            Ok((signed, true))
        }
    }

    async fn build(
        w: &Mock,
        parent: &Transaction,
        fee: u64,
        lim: ChildLimits,
        to: &ScriptBuf,
    ) -> Result<BuiltChild, ChildError> {
        build_child(w, parent, 1, to, Amount::from_sat(fee), Coin::Btc, &lim).await
    }

    #[tokio::test]
    async fn builds_a_child_and_hands_the_signer_the_parent_output() {
        let p = parent(p2tr(1), 50_000);
        let w = Mock::new(Behaviour::Honest);
        let c = build(&w, &p, 3_000, limits(5_000, 100_000), &p2tr(2))
            .await
            .unwrap();
        assert_eq!(c.fee, Amount::from_sat(3_000));
        assert_eq!(c.vsize, 111);
        assert_eq!(c.tx.output[0].value, Amount::from_sat(47_000));
        assert_eq!(c.tx.input[0].previous_output.vout, 1);
        // The signer is given the parent's output (script and amount), so a parent that is no
        // longer in the mempool can still be spent.
        {
            let seen = w.signed_with.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].1, p.output[1]);
        }
        // P2WPKH works too, with the 72-byte bound.
        let p = parent(p2wpkh(), 50_000);
        let c = build(
            &Mock::new(Behaviour::Honest),
            &p,
            3_000,
            limits(5_000, 100_000),
            &p2wpkh(),
        )
        .await
        .unwrap();
        assert_eq!(c.vsize, 110);
    }

    #[tokio::test]
    async fn refuses_what_the_wallet_gets_wrong() {
        let p = parent(p2tr(1), 50_000);
        let lim = limits(5_000, 100_000);
        let to = p2tr(2);
        let err = |b: Behaviour| {
            let (p, to) = (p.clone(), to.clone());
            async move { build(&Mock::new(b), &p, 3_000, lim, &to).await.unwrap_err() }
        };
        assert!(matches!(
            err(Behaviour::Incomplete).await,
            ChildError::NotSigned
        ));
        assert!(matches!(
            err(Behaviour::ChangesOutput).await,
            ChildError::Altered(_)
        ));
        assert!(matches!(
            err(Behaviour::NoWitness).await,
            ChildError::Altered(_)
        ));
        assert!(matches!(
            err(Behaviour::LegacyScriptSig).await,
            ChildError::Altered(_)
        ));
        // A 65-byte signature (a sighash byte) makes the child bigger than its fee was set for.
        assert!(matches!(
            err(Behaviour::BigWitness).await,
            ChildError::Larger {
                actual: 112,
                predicted: 111
            }
        ));
    }

    #[tokio::test]
    async fn refuses_a_locked_coin_and_a_down_node_and_checks_the_rate_after_signing() {
        let p = parent(p2tr(1), 50_000);
        let lim = limits(5_000, 100_000);
        let mut w = Mock::new(Behaviour::Honest);
        w.locked = vec![OutPoint {
            txid: p.compute_txid(),
            vout: 1,
        }];
        assert!(matches!(
            build(&w, &p, 3_000, lim, &p2tr(2)).await,
            Err(ChildError::LockedCoin(_))
        ));
        // The wallet is never asked to sign a child that was refused up front.
        assert!(w.signed_with.lock().unwrap().is_empty());

        let mut w = Mock::new(Behaviour::Honest);
        w.node_down = true;
        assert!(matches!(
            build(&w, &p, 3_000, lim, &p2tr(2)).await,
            Err(ChildError::Rpc(_))
        ));

        // The rate cap is checked with the signed size too. P2WPKH is bounded at 110 vB and a
        // 69-byte signature signs at 109: a fee that sits exactly on the cap for 110 vB is over
        // it for 109.
        let p = parent(p2wpkh(), 50_000);
        let w = Mock::new(Behaviour::SmallWitness);
        let fee = fee_for(100_000, 110);
        assert_eq!(fee, 11_000);
        let r = build(&w, &p, fee, limits(50_000, 100_000), &p2wpkh()).await;
        assert!(
            matches!(r, Err(ChildError::RateAboveCap { rate, cap })
                if cap == 100_000 && rate == 100_917),
            "{r:?}"
        );
    }
}
