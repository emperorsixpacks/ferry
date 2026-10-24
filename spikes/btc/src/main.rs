//! Ferry spike S2: Bitcoin leg of a Gugger-style ZEC<->BTC atomic swap.
//!
//! E holds BTC, Z holds ZEC. As in XMR-BTC (Gugger 2020) there are two
//! Taproot outputs:
//!   lock   = {redeem: <E> CSV <Z>, cancel: <T1> CSV DROP <E> CSV <Z>}
//!   cancel = {refund: <Z> CSV <E>, punish: <T2> CSV DROP <Z> CHECKSIG}
//! (CSV here = CHECKSIGVERIFY.) tx_cancel moves the BTC out of reach of redeem
//! before refund can reveal b, closing the redeem-vs-refund race.
//! Adaptor signatures (BIP340, schnorr_fun) encrypted under T_a = a*G and
//! T_b = b*G leak the Zcash key shares a / b when redeem / refund hit the chain.
//!
//! Usage: cargo run --release -- happy|refund|punish
//! Needs scripts/regtest.sh start (bitcoind regtest RPC on 127.0.0.1:18543).

use anyhow::{Context, Result, anyhow, bail, ensure};
use bitcoin::absolute::LockTime;
use bitcoin::consensus::encode::{deserialize_hex, serialize_hex};
use bitcoin::hashes::Hash;
use bitcoin::key::{Secp256k1, XOnlyPublicKey};
use bitcoin::opcodes::all::{OP_CHECKSIG, OP_CHECKSIGVERIFY, OP_CSV, OP_DROP};
use bitcoin::script::{Builder, ScriptBuf};
use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{LeafVersion, TapLeafHash, TaprootBuilder, TaprootSpendInfo};
use bitcoin::transaction::Version;
use bitcoin::{Address, Amount, Network, OutPoint, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
use schnorr_fun::adaptor::{Adaptor, EncryptedSign, EncryptedSignature};
use schnorr_fun::fun::marker::*;
use schnorr_fun::fun::{KeyPair, Point, Scalar};
use schnorr_fun::{Message, Schnorr, Signature, nonce};
use serde_json::{Value, json};
use sha2::Sha256;
use std::str::FromStr;

const RPC_URL: &str = "http://127.0.0.1:18543";
const RPC_AUTH: (&str, &str) = ("ferry", "ferry");
/// Relative timelocks (blocks): cancel after T1 on the lock, punish after T2 on the cancel output.
const T1: u16 = 10;
const T2: u16 = 20;
const SWAP_AMOUNT: Amount = Amount::from_sat(100_000_000);
const FEE: Amount = Amount::from_sat(2_000);
/// BIP341 NUMS point (H = lift_x(sha256(G))), no known discrete log -> key path unspendable.
const NUMS: &str = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

type Sch = Schnorr<Sha256, nonce::Synthetic<Sha256, nonce::GlobalRng<rand::rngs::ThreadRng>>>;

// ---------------------------------------------------------------- RPC

struct Rpc {
    http: reqwest::blocking::Client,
}

impl Rpc {
    fn new() -> Self {
        Rpc { http: reqwest::blocking::Client::new() }
    }

    fn call(&self, wallet: Option<&str>, method: &str, params: Value) -> Result<Value> {
        let url = match wallet {
            Some(w) => format!("{RPC_URL}/wallet/{w}"),
            None => RPC_URL.to_string(),
        };
        let resp: Value = self
            .http
            .post(url)
            .basic_auth(RPC_AUTH.0, Some(RPC_AUTH.1))
            .json(&json!({"jsonrpc": "1.0", "id": "ferry", "method": method, "params": params}))
            .send()
            .with_context(|| format!("rpc {method}: is bitcoind up? (scripts/regtest.sh start)"))?
            .json()?;
        if !resp["error"].is_null() {
            bail!("rpc {method} error: {}", resp["error"]);
        }
        Ok(resp["result"].clone())
    }

    fn w(&self, method: &str, params: Value) -> Result<Value> {
        self.call(Some("ferry"), method, params)
    }

    fn new_address(&self) -> Result<Address> {
        let s = self.w("getnewaddress", json!(["", "bech32m"]))?;
        Ok(Address::from_str(s.as_str().unwrap())?.require_network(Network::Regtest)?)
    }

    fn mine(&self, n: u64) -> Result<()> {
        let addr = self.new_address()?;
        self.call(None, "generatetoaddress", json!([n, addr.to_string()]))?;
        Ok(())
    }

    fn height(&self) -> Result<u64> {
        Ok(self.call(None, "getblockcount", json!([]))?.as_u64().unwrap())
    }

    fn broadcast(&self, tx: &Transaction) -> Result<Txid> {
        let txid = self.call(None, "sendrawtransaction", json!([serialize_hex(tx)]))?;
        Ok(Txid::from_str(txid.as_str().unwrap())?)
    }

    fn get_tx(&self, txid: &Txid) -> Result<Transaction> {
        let hex = self.call(None, "getrawtransaction", json!([txid.to_string()]))?;
        Ok(deserialize_hex(hex.as_str().unwrap())?)
    }

    fn confirmations(&self, txid: &Txid) -> Result<u64> {
        let v = self.call(None, "getrawtransaction", json!([txid.to_string(), true]))?;
        Ok(v["confirmations"].as_u64().unwrap_or(0))
    }

    /// Create the regtest wallet (idempotent) and make sure it has mature coins.
    fn setup(&self) -> Result<()> {
        let wallets = self.call(None, "listwallets", json!([]))?;
        if !wallets.as_array().unwrap().iter().any(|w| w == "ferry") {
            if self.call(None, "loadwallet", json!(["ferry"])).is_err() {
                self.call(None, "createwallet", json!(["ferry"]))?;
            }
        }
        let bal = self.w("getbalance", json!([]))?.as_f64().unwrap_or(0.0);
        if bal < 5.0 {
            self.mine(101)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- swap

struct Party {
    btc: KeyPair<EvenY>,
}

impl Party {
    fn xonly(&self) -> XOnlyPublicKey {
        XOnlyPublicKey::from_slice(&self.btc.public_key().to_xonly_bytes()).unwrap()
    }
}

/// A taproot output (NUMS internal key) with its script leaves.
struct TapOut {
    spend_info: TaprootSpendInfo,
    address: Address,
}

fn tap_out(leaves: &[&ScriptBuf]) -> TapOut {
    let secp = Secp256k1::verification_only();
    let internal = XOnlyPublicKey::from_str(NUMS).unwrap();
    let mut b = TaprootBuilder::new();
    for leaf in leaves {
        // all scripts here come in pairs -> both at depth 1
        b = b.add_leaf(1, (*leaf).clone()).unwrap();
    }
    let spend_info = b.finalize(&secp, internal).unwrap();
    let address = Address::p2tr_tweaked(spend_info.output_key(), Network::Regtest);
    TapOut { spend_info, address }
}

/// `<first> CHECKSIGVERIFY <second> CHECKSIG`, optionally behind `<csv> CSV DROP`.
fn two_of_two(csv: Option<u16>, first: &Party, second: &Party) -> ScriptBuf {
    let mut b = Builder::new();
    if let Some(t) = csv {
        b = b.push_int(t as i64).push_opcode(OP_CSV).push_opcode(OP_DROP);
    }
    b.push_x_only_key(&first.xonly())
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_x_only_key(&second.xonly())
        .push_opcode(OP_CHECKSIG)
        .into_script()
}

struct Scripts {
    // lock output
    redeem: ScriptBuf,
    cancel: ScriptBuf,
    lock: TapOut,
    // cancel output
    refund: ScriptBuf,
    punish: ScriptBuf,
    cancel_out: TapOut,
}

fn build_scripts(e: &Party, z: &Party) -> Scripts {
    let redeem = two_of_two(None, e, z);
    let cancel = two_of_two(Some(T1), e, z);
    let refund = two_of_two(None, z, e);
    let punish = Builder::new()
        .push_int(T2 as i64)
        .push_opcode(OP_CSV)
        .push_opcode(OP_DROP)
        .push_x_only_key(&z.xonly())
        .push_opcode(OP_CHECKSIG)
        .into_script();
    let lock = tap_out(&[&redeem, &cancel]);
    let cancel_out = tap_out(&[&refund, &punish]);
    Scripts { redeem, cancel, lock, refund, punish, cancel_out }
}

/// Unsigned 1-in-1-out spend of `prev` paying `prev_value - FEE` to `to`.
fn spend_tx(prev: OutPoint, prev_value: Amount, to: &Address, sequence: Sequence) -> Transaction {
    Transaction {
        version: Version::TWO, // BIP68 relative locktime requires v2
        lock_time: LockTime::ZERO,
        input: vec![TxIn { previous_output: prev, sequence, ..Default::default() }],
        output: vec![TxOut { value: prev_value - FEE, script_pubkey: to.script_pubkey() }],
    }
}

fn leaf_sighash(tx: &Transaction, prevout: &TxOut, leaf: &ScriptBuf) -> [u8; 32] {
    let leaf_hash = TapLeafHash::from_script(leaf, LeafVersion::TapScript);
    SighashCache::new(tx)
        .taproot_script_spend_signature_hash(0, &Prevouts::All(&[prevout]), leaf_hash, TapSighashType::Default)
        .unwrap()
        .to_byte_array()
}

/// Witness = sigs (bottom..top), leaf script, control block. For
/// `<K1> CHECKSIGVERIFY <K2> CHECKSIG` K1's sig is popped first, so pass [sig_K2, sig_K1].
fn attach_witness(tx: &mut Transaction, sigs: &[&Signature], leaf: &ScriptBuf, out: &TapOut) {
    let control = out.spend_info.control_block(&(leaf.clone(), LeafVersion::TapScript)).unwrap();
    let mut w = Witness::new();
    for sig in sigs {
        w.push(sig.to_bytes());
    }
    w.push(leaf.as_bytes());
    w.push(control.serialize());
    tx.input[0].witness = w;
}

/// Independent check with libsecp256k1 (what bitcoind uses) that a schnorr_fun
/// signature is a plain BIP340 signature over the sighash.
fn libsecp_verify(sig: &Signature, sighash: &[u8; 32], pk: &XOnlyPublicKey) -> Result<()> {
    let secp = Secp256k1::verification_only();
    let s = bitcoin::secp256k1::schnorr::Signature::from_slice(&sig.to_bytes())?;
    let m = bitcoin::secp256k1::Message::from_digest(*sighash);
    secp.verify_schnorr(&s, &m, pk).map_err(|e| anyhow!("libsecp BIP340 verify failed: {e}"))
}

fn witness_sig(tx: &Transaction, i: usize) -> Result<Signature> {
    let bytes: [u8; 64] = tx.input[0].witness.nth(i).ok_or_else(|| anyhow!("no witness item {i}"))?.try_into()?;
    Signature::from_bytes(bytes).ok_or_else(|| anyhow!("bad witness sig"))
}

fn scalar_eq(x: &Scalar, y: &Scalar) -> bool {
    x.to_bytes() == y.to_bytes()
}

struct Swap {
    schnorr: Sch,
    rpc: Rpc,
    e: Party,
    z: Party,
    a: Scalar,
    b: Scalar,
    t_a: Point,
    t_b: Point,
    s: Scripts,
    /// tx_cancel, fully signed by both parties before the lock is broadcast.
    cancel_tx: Transaction,
    cancel_txout: TxOut,
    refund_tx: Transaction,
    refund_sighash: [u8; 32],
    /// Z's adaptor sig on tx_refund, encrypted under T_b, held by E.
    refund_enc_sig_z: EncryptedSignature,
    redeem_tx: Transaction,
    redeem_sighash: [u8; 32],
    z_addr: Address,
}

/// Key setup, pre-lock signing round, lock broadcast.
fn setup_and_lock() -> Result<Swap> {
    let rng = &mut rand::thread_rng();
    let schnorr: Sch = schnorr_fun::new_with_synthetic_nonces::<Sha256, rand::rngs::ThreadRng>();
    let rpc = Rpc::new();
    rpc.setup()?;

    let e = Party { btc: schnorr.new_keypair(Scalar::random(rng)) };
    let z = Party { btc: schnorr.new_keypair(Scalar::random(rng)) };
    // Zcash key shares (in the full protocol: spend-key shares, with a DLEQ
    // proof linking them to the ZEC curve). Here only their secp256k1 images matter.
    let a = Scalar::random(rng); // Z's share
    let b = Scalar::random(rng); // E's share
    let t_a = schnorr.encryption_key_for(&a);
    let t_b = schnorr.encryption_key_for(&b);

    let s = build_scripts(&e, &z);
    println!("lock   address {{redeem, cancel(CSV {T1})}}: {}", s.lock.address);
    println!("cancel address {{refund, punish(CSV {T2})}}: {}", s.cancel_out.address);

    // E builds+signs the lock tx but does NOT broadcast yet (segwit txid is final).
    let raw = rpc.w("createrawtransaction", json!([[], {s.lock.address.to_string(): SWAP_AMOUNT.to_btc()}]))?;
    let funded = rpc.w("fundrawtransaction", json!([raw, {"changePosition": 1}]))?;
    let signed = rpc.w("signrawtransactionwithwallet", json!([funded["hex"]]))?;
    ensure!(signed["complete"].as_bool() == Some(true), "lock tx signing incomplete");
    let lock_tx: Transaction = deserialize_hex(signed["hex"].as_str().unwrap())?;
    let lock_out = OutPoint { txid: lock_tx.compute_txid(), vout: 0 };
    let lock_txout = lock_tx.output[0].clone();
    ensure!(lock_txout.script_pubkey == s.lock.address.script_pubkey());

    let e_addr = rpc.new_address()?;
    let z_addr = rpc.new_address()?;

    // --- pre-lock round ---
    // (a) tx_cancel: both sign fully and exchange; each verifies the other's sig.
    let mut cancel_tx = spend_tx(lock_out, SWAP_AMOUNT, &s.cancel_out.address, Sequence::from_height(T1));
    let cancel_sighash = leaf_sighash(&cancel_tx, &lock_txout, &s.cancel);
    let cancel_sig_e = schnorr.sign(&e.btc, Message::raw(&cancel_sighash));
    let cancel_sig_z = schnorr.sign(&z.btc, Message::raw(&cancel_sighash));
    ensure!(schnorr.verify(&e.btc.public_key(), Message::raw(&cancel_sighash), &cancel_sig_e));
    ensure!(schnorr.verify(&z.btc.public_key(), Message::raw(&cancel_sighash), &cancel_sig_z));
    attach_witness(&mut cancel_tx, &[&cancel_sig_z, &cancel_sig_e], &s.cancel, &s.lock);
    let cancel_out = OutPoint { txid: cancel_tx.compute_txid(), vout: 0 };
    let cancel_txout = cancel_tx.output[0].clone();
    println!("[pre-lock] tx_cancel fully co-signed by E and Z: {}", cancel_out.txid);

    // (b) Z -> E: adaptor sig on tx_refund (spends the cancel output), encrypted under T_b.
    let refund_tx = spend_tx(cancel_out, cancel_txout.value, &e_addr, Sequence::ENABLE_RBF_NO_LOCKTIME);
    let refund_sighash = leaf_sighash(&refund_tx, &cancel_txout, &s.refund);
    let refund_enc_sig_z = schnorr.encrypted_sign(&z.btc, &t_b, Message::raw(&refund_sighash));
    ensure!(
        schnorr.verify_encrypted_signature(&z.btc.public_key(), &t_b, Message::raw(&refund_sighash), &refund_enc_sig_z),
        "E: Z's refund adaptor signature invalid"
    );
    println!("[pre-lock] Z -> E: tx_refund adaptor sig (enc. under T_b) verified by E");

    // E broadcasts lock.
    let txid = rpc.broadcast(&lock_tx)?;
    ensure!(txid == lock_out.txid);
    rpc.mine(1)?;
    println!("[lock] tx_lock broadcast+mined: {txid} (vout 0, {SWAP_AMOUNT})");

    let redeem_tx = spend_tx(lock_out, SWAP_AMOUNT, &z_addr, Sequence::ENABLE_RBF_NO_LOCKTIME);
    let redeem_sighash = leaf_sighash(&redeem_tx, &lock_txout, &s.redeem);

    Ok(Swap {
        schnorr,
        rpc,
        e,
        z,
        a,
        b,
        t_a,
        t_b,
        s,
        cancel_tx,
        cancel_txout,
        refund_tx,
        refund_sighash,
        refund_enc_sig_z,
        redeem_tx,
        redeem_sighash,
        z_addr,
    })
}

impl Swap {
    /// After the ZEC lock confirms (out of scope): E -> Z adaptor sig on tx_redeem under T_a.
    fn redeem_adaptor(&self) -> Result<EncryptedSignature> {
        let msg = Message::raw(&self.redeem_sighash);
        let enc = self.schnorr.encrypted_sign(&self.e.btc, &self.t_a, msg);
        ensure!(
            self.schnorr.verify_encrypted_signature(&self.e.btc.public_key(), &self.t_a, msg, &enc),
            "Z: E's redeem adaptor signature invalid"
        );
        println!("[zec-locked] E -> Z: tx_redeem adaptor sig (enc. under T_a) verified by Z");
        Ok(enc)
    }

    /// Z completes tx_redeem with `a` and its own sig.
    fn complete_redeem(&self, enc_sig_e: &EncryptedSignature) -> Result<Transaction> {
        let sig_e = self.schnorr.decrypt_signature(self.a.clone(), enc_sig_e.clone());
        let sig_z = self.schnorr.sign(&self.z.btc, Message::raw(&self.redeem_sighash));
        libsecp_verify(&sig_e, &self.redeem_sighash, &self.e.xonly())?;
        libsecp_verify(&sig_z, &self.redeem_sighash, &self.z.xonly())?;
        let mut tx = self.redeem_tx.clone();
        attach_witness(&mut tx, &[&sig_z, &sig_e], &self.s.redeem, &self.s.lock);
        Ok(tx)
    }

    /// tx_cancel is rejected before T1, accepted once the lock has T1 confirmations.
    fn publish_cancel(&self) -> Result<()> {
        match self.rpc.broadcast(&self.cancel_tx) {
            Err(e) => println!("[cancel] tx_cancel before T1 rejected as expected: {e}"),
            Ok(t) => bail!("tx_cancel accepted before T1 ({t}): timelock broken"),
        }
        self.rpc.mine(T1 as u64 - 1)?; // lock already has 1 conf
        let txid = self.rpc.broadcast(&self.cancel_tx)?;
        self.rpc.mine(1)?;
        println!(
            "[cancel] tx_cancel broadcast after T1={T1} (height {}): {txid} (confirmations: {})",
            self.rpc.height()?,
            self.rpc.confirmations(&txid)?
        );
        Ok(())
    }
}

fn happy() -> Result<()> {
    let sw = setup_and_lock()?;
    let enc_sig_e = sw.redeem_adaptor()?;
    let redeem_tx = sw.complete_redeem(&enc_sig_e)?;
    let txid = sw.rpc.broadcast(&redeem_tx)?;
    sw.rpc.mine(1)?;
    println!("[redeem] Z broadcast tx_redeem: {txid} (confirmations: {})", sw.rpc.confirmations(&txid)?);

    // E watches the chain, pulls sig_E (witness[1]) and recovers a.
    let onchain = sw.rpc.get_tx(&txid)?;
    let recovered = sw
        .schnorr
        .recover_decryption_key(&sw.t_a, &enc_sig_e, &witness_sig(&onchain, 1)?)
        .ok_or_else(|| anyhow!("E could not recover a"))?;
    println!("    a (Z's secret)   = {}", sw.a);
    println!("    a recovered by E = {recovered}");
    ensure!(scalar_eq(&recovered, &sw.a), "recovered a mismatch");

    // tx_cancel is now dead too (lock output spent).
    match sw.rpc.broadcast(&sw.cancel_tx) {
        Err(e) => println!("[neg] tx_cancel after redeem rejected as expected: {e}"),
        Ok(t) => bail!("tx_cancel accepted after redeem ({t})"),
    }
    println!("HAPPY PATH OK: E recovered a from the on-chain redeem witness (match = true)");
    Ok(())
}

fn refund() -> Result<()> {
    let sw = setup_and_lock()?;
    // ZEC got locked and E handed over the redeem adaptor, but Z stalls past T1.
    let enc_sig_e = sw.redeem_adaptor()?;
    let redeem_tx = sw.complete_redeem(&enc_sig_e)?;

    sw.publish_cancel()?;

    // Negative test: with tx_cancel confirmed, the redeem leaf is unspendable.
    match sw.rpc.broadcast(&redeem_tx) {
        Err(e) => println!("[neg] tx_redeem after tx_cancel confirmed rejected as expected: {e}"),
        Ok(t) => bail!("tx_redeem accepted after cancel ({t}): race not closed"),
    }

    // E completes Z's refund adaptor sig with b and broadcasts tx_refund.
    let sig_z = sw.schnorr.decrypt_signature(sw.b.clone(), sw.refund_enc_sig_z.clone());
    let sig_e = sw.schnorr.sign(&sw.e.btc, Message::raw(&sw.refund_sighash));
    libsecp_verify(&sig_z, &sw.refund_sighash, &sw.z.xonly())?;
    libsecp_verify(&sig_e, &sw.refund_sighash, &sw.e.xonly())?;
    let mut refund_tx = sw.refund_tx.clone();
    // refund leaf = <Z> CHECKSIGVERIFY <E> CHECKSIG -> witness [sig_E, sig_Z]
    attach_witness(&mut refund_tx, &[&sig_e, &sig_z], &sw.s.refund, &sw.s.cancel_out);
    let txid = sw.rpc.broadcast(&refund_tx)?;
    sw.rpc.mine(1)?;
    println!("[refund] E broadcast tx_refund: {txid} (confirmations: {})", sw.rpc.confirmations(&txid)?);

    // Z watches the chain, pulls sig_Z (witness[1]) and recovers b.
    let onchain = sw.rpc.get_tx(&txid)?;
    let recovered = sw
        .schnorr
        .recover_decryption_key(&sw.t_b, &sw.refund_enc_sig_z, &witness_sig(&onchain, 1)?)
        .ok_or_else(|| anyhow!("Z could not recover b"))?;
    println!("    b (E's secret)   = {}", sw.b);
    println!("    b recovered by Z = {recovered}");
    ensure!(scalar_eq(&recovered, &sw.b), "recovered b mismatch");
    println!("REFUND PATH OK: lock -> cancel -> refund; Z recovered b from the refund witness (match = true)");
    Ok(())
}

fn punish() -> Result<()> {
    let sw = setup_and_lock()?;
    // Cancel got published (by either party) but E never refunds. Z sweeps after T2.
    sw.publish_cancel()?;

    let cancel_out = OutPoint { txid: sw.cancel_tx.compute_txid(), vout: 0 };
    let mut punish_tx = spend_tx(cancel_out, sw.cancel_txout.value, &sw.z_addr, Sequence::from_height(T2));
    let sighash = leaf_sighash(&punish_tx, &sw.cancel_txout, &sw.s.punish);
    let sig_z = sw.schnorr.sign(&sw.z.btc, Message::raw(&sighash));
    libsecp_verify(&sig_z, &sighash, &sw.z.xonly())?;
    attach_witness(&mut punish_tx, &[&sig_z], &sw.s.punish, &sw.s.cancel_out);

    match sw.rpc.broadcast(&punish_tx) {
        Err(e) => println!("[punish] tx_punish before T2 rejected as expected: {e}"),
        Ok(t) => bail!("tx_punish accepted before T2 ({t}): timelock broken"),
    }
    sw.rpc.mine(T2 as u64 - 1)?; // cancel already has 1 conf
    let txid = sw.rpc.broadcast(&punish_tx)?;
    sw.rpc.mine(1)?;
    println!(
        "[punish] Z broadcast tx_punish {T2} blocks after cancel (height {}): {txid} (confirmations: {})",
        sw.rpc.height()?,
        sw.rpc.confirmations(&txid)?
    );
    println!("PUNISH PATH OK: lock -> cancel -> T2 -> Z swept the cancel output alone");
    Ok(())
}

fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("happy") => happy(),
        Some("refund") => refund(),
        Some("punish") => punish(),
        _ => {
            eprintln!("usage: btc-swap-spike happy|refund|punish");
            std::process::exit(2);
        }
    }
}
