//! B: holds BTC, wants shielded ZEC.
//!
//! ```text
//! Negotiated → LockBuilt → CancelSigned → BtcLocked → ZecSeen → RedeemSigSent
//!   → BtcRedeemed (z extracted, sweep) → ZecSwept ✔
//! lock_confs ≥ T1 → Cancelled → Refunding → Refunded ✔ (b revealed)
//! cancel_confs ≥ T2 − Δ without refund → (Z punishes) → Punished ✘
//! ```

use ferry_btc::adaptor::{self, EncryptedSignature};
use ferry_btc::bitcoin::{OutPoint, Transaction, TxOut};
use ferry_btc::musig::{KeySpend, PartialSig, PubNonce};
use ferry_btc::SwapTxs;
use serde::{Deserialize, Serialize};

use crate::{Action, ChainEvent, Error, Event, Message, Role, Secret32, Secret64, Session, Spend};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BState {
    /// Keys exchanged; the wallet is funding the lock.
    Negotiated,
    /// Lock funded and signed (not broadcast), template sent; waiting for Z's signatures.
    LockBuilt,
    /// tx_cancel co-signed and the lock broadcast.
    CancelSigned,
    /// The lock has at least one confirmation.
    BtcLocked,
    /// The ZEC lock note is visible but not yet buried under N confirmations.
    ZecSeen {
        confs: u32,
    },
    /// Our adaptor signature on tx_redeem is out; waiting for Z to redeem.
    RedeemSigSent,
    /// Z redeemed, `z` is extracted and the sweep requested.
    BtcRedeemed,
    ZecSwept,
    /// tx_cancel broadcast or seen; refund once it has k confirmations.
    Cancelled,
    Refunding,
    Refunded,
    Punished,
    Aborted,
}

impl BState {
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            BState::ZecSwept | BState::Refunded | BState::Punished | BState::Aborted
        )
    }

    fn is_locked_pre_cancel(&self) -> bool {
        matches!(
            self,
            BState::CancelSigned
                | BState::BtcLocked
                | BState::ZecSeen { .. }
                | BState::RedeemSigSent
        )
    }
}

/// Key path: public MuSig2 nonces and Z's partial signature on tx_redeem.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Musig {
    #[serde(with = "crate::hex_serde")]
    b_nonce: PubNonce,
    #[serde(default, with = "crate::hex_opt")]
    z_nonce: Option<PubNonce>,
    #[serde(default, with = "crate::hex_opt")]
    z_partial: Option<PartialSig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BSwap {
    pub session: Session,
    pub state: BState,
    /// Signed lock transaction and the lock output index.
    lock: Option<(Transaction, u32)>,
    /// Fully signed tx_cancel.
    cancel_tx: Option<Transaction>,
    /// Z's adaptor signature on tx_refund, under B_s.
    refund_enc_sig: Option<EncryptedSignature>,
    /// Our adaptor signature on tx_redeem, under Z_s.
    redeem_enc_sig: Option<EncryptedSignature>,
    /// Key path: our secret MuSig2 nonce, until it signs once.
    #[serde(default)]
    musig_secret: Option<Secret64>,
    /// Key path: public nonces `[B's, Z's]` and Z's partial signature.
    #[serde(default)]
    musig: Option<Musig>,
    /// Key path: the combined adaptor signature on tx_redeem, under Z_s.
    #[serde(default)]
    keypath_enc_sig: Option<EncryptedSignature>,
    lock_confs: u32,
    cancel_confs: Option<u32>,
}

impl BSwap {
    pub(crate) fn start(session: Session) -> (Self, Vec<Action>) {
        let fund = Action::FundBtcLock {
            address: session.lock_address(),
            amount: session.params.btc_amount(),
        };
        let b = BSwap {
            session,
            state: BState::Negotiated,
            lock: None,
            cancel_tx: None,
            refund_enc_sig: None,
            redeem_enc_sig: None,
            musig_secret: None,
            musig: None,
            keypath_enc_sig: None,
            lock_confs: 0,
            cancel_confs: None,
        };
        (b, vec![fund])
    }

    pub fn lock_outpoint(&self) -> Option<OutPoint> {
        self.lock.as_ref().map(|(tx, vout)| OutPoint {
            txid: tx.compute_txid(),
            vout: *vout,
        })
    }

    /// The signed lock transaction (for rebroadcasting).
    pub fn lock_tx(&self) -> Option<&Transaction> {
        self.lock.as_ref().map(|(tx, _)| tx)
    }

    fn txs(&self) -> Result<SwapTxs, Error> {
        let outpoint = self.lock_outpoint().ok_or(Error::LockMismatch)?;
        self.session.txs(outpoint)
    }

    pub(crate) fn handle(&mut self, event: Event) -> Result<Vec<Action>, Error> {
        let mut next = self.clone();
        let mut actions = next.on_event(event)?;
        actions.extend(next.tick()?);
        *self = next;
        Ok(actions)
    }

    fn on_event(&mut self, event: Event) -> Result<Vec<Action>, Error> {
        match event {
            Event::Peer(env) => {
                let msg = self.session.open(&env)?;
                self.on_message(msg)
            }
            Event::LockFunded { tx, vout } => self.on_lock_funded(tx, vout),
            Event::Chain(c) => self.on_chain(c),
            Event::Timeout => {
                if matches!(self.state, BState::Negotiated | BState::LockBuilt) {
                    self.state = BState::Aborted;
                }
                Ok(vec![])
            }
        }
    }

    fn unexpected(&self, what: &'static str) -> Error {
        Error::Unexpected {
            state: format!("{:?}", self.state),
            message: what,
        }
    }

    fn on_lock_funded(&mut self, tx: Transaction, vout: u32) -> Result<Vec<Action>, Error> {
        if self.state != BState::Negotiated {
            return Err(self.unexpected("LockFunded"));
        }
        let outpoint = OutPoint {
            txid: tx.compute_txid(),
            vout,
        };
        let txs = self.session.txs(outpoint)?;
        if tx.output.get(vout as usize) != Some(&txs.lock_txout) {
            return Err(Error::LockMismatch);
        }
        // A non-segwit input would make the txid (and every presigned spend) malleable.
        if tx
            .input
            .iter()
            .any(|i| i.witness.is_empty() || !i.script_sig.is_empty())
        {
            return Err(Error::LockMismatch);
        }
        self.lock = Some((tx, vout));
        self.state = BState::LockBuilt;
        let redeem_nonce = self.session.params.keypath.then(|| {
            let (secret, public) = ferry_btc::musig::new_nonce();
            self.musig_secret = Some(Secret64::new(*secret));
            self.musig = Some(Musig {
                b_nonce: public,
                z_nonce: None,
                z_partial: None,
            });
            public
        });
        let msg = Message::LockTemplate {
            outpoint,
            amount: self.session.params.btc_amount,
            redeem_nonce,
        };
        Ok(vec![Action::SendMessage(self.session.seal(msg))])
    }

    fn on_message(&mut self, msg: &Message) -> Result<Vec<Action>, Error> {
        match (msg, &self.state) {
            (
                Message::CancelSigs {
                    cancel_sig,
                    refund_enc_sig,
                    redeem_nonce,
                    redeem_partial,
                },
                BState::LockBuilt,
            ) => {
                let txs = self.txs()?;
                if let Some(ks) = self.session.key_spend() {
                    let (Some(z_nonce), Some(z_partial)) = (redeem_nonce, redeem_partial) else {
                        return Err(Error::Musig("Z sent no nonce/partial signature"));
                    };
                    let m = self.musig.as_mut().expect("nonce sent with LockTemplate");
                    let ok = ks.verify_partial(
                        Role::Z,
                        z_partial,
                        [&m.b_nonce, z_nonce],
                        &self.session.z_encryption_key(),
                        &txs.keypath_redeem_sighash(),
                    );
                    if !ok {
                        return Err(Error::BadSignature(
                            "Z's MuSig2 partial signature on tx_redeem",
                        ));
                    }
                    m.z_nonce = Some(*z_nonce);
                    m.z_partial = Some(*z_partial);
                }
                let kz = self.session.peer.btc_key;
                let cancel_hash = txs.sighash(Spend::Cancel);
                if !adaptor::verify(&kz, &cancel_hash, cancel_sig) {
                    return Err(Error::BadSignature("Z's tx_cancel signature"));
                }
                let refund_hash = txs.sighash(Spend::Refund);
                if !adaptor::verify_encrypted(
                    &kz,
                    &self.session.b_encryption_key(),
                    &refund_hash,
                    refund_enc_sig,
                ) {
                    return Err(Error::BadSignature("Z's tx_refund adaptor signature"));
                }
                let my_sig = self.session.me.btc_key().sign(&cancel_hash);
                self.cancel_tx = Some(txs.complete(Spend::Cancel, &my_sig, cancel_sig)?);
                self.refund_enc_sig = Some(refund_enc_sig.clone());
                self.state = BState::CancelSigned;
                let reply = self.session.seal(Message::CancelSig { cancel_sig: my_sig });
                let lock_tx = self.lock_tx().expect("lock built").clone();
                Ok(vec![
                    Action::SendMessage(reply),
                    Action::BroadcastBtc(lock_tx),
                ])
            }
            (m, _) => Err(self.unexpected(m.name())),
        }
    }

    fn on_chain(&mut self, event: ChainEvent) -> Result<Vec<Action>, Error> {
        if self.lock.is_none() {
            return Ok(vec![]);
        }
        match event {
            ChainEvent::BtcLockConfirmed { confs, txout } => self.on_lock_confirmed(confs, &txout),
            ChainEvent::ZecNoteSeen { value, confs } => self.on_zec_note(value, confs),
            ChainEvent::BtcSpend { tx, confs } => self.on_spend(&tx, confs),
            ChainEvent::ZecSwept { confs } => {
                if self.state == BState::BtcRedeemed && confs >= 1 {
                    self.state = BState::ZecSwept;
                }
                Ok(vec![])
            }
        }
    }

    fn on_lock_confirmed(&mut self, confs: u32, txout: &TxOut) -> Result<Vec<Action>, Error> {
        if *txout != self.txs()?.lock_txout {
            return Err(Error::LockMismatch);
        }
        self.lock_confs = confs;
        if self.state == BState::CancelSigned && confs >= 1 {
            self.state = BState::BtcLocked;
        }
        Ok(vec![])
    }

    fn on_zec_note(&mut self, value: u64, confs: u32) -> Result<Vec<Action>, Error> {
        let params = &self.session.params;
        let waiting = matches!(self.state, BState::BtcLocked | BState::ZecSeen { .. });
        // A short note never gets the redeem signature: the swap runs into cancel + refund.
        if !waiting || value < params.zec_amount {
            return Ok(vec![]);
        }
        if confs < params.zec_confirmations || params.can_cancel(self.lock_confs) {
            self.state = BState::ZecSeen { confs };
            return Ok(vec![]);
        }
        let txs = self.txs()?;
        let enc = self.session.me.btc_key().encrypted_sign(
            &self.session.z_encryption_key(),
            &txs.sighash(Spend::Redeem),
        );
        self.redeem_enc_sig = Some(enc.clone());
        let redeem_partial = match self.session.key_spend() {
            Some(ks) => Some(self.keypath_partial(&ks, &txs)?),
            None => None,
        };
        self.state = BState::RedeemSigSent;
        let env = self.session.seal(Message::RedeemAdaptor {
            redeem_enc_sig: enc,
            redeem_partial,
        });
        Ok(vec![Action::SendMessage(env)])
    }

    fn on_spend(&mut self, tx: &Transaction, confs: u32) -> Result<Vec<Action>, Error> {
        let txs = self.txs()?;
        match txs.classify(tx) {
            Some(Spend::Cancel) => {
                self.cancel_confs = Some(confs);
                if self.state.is_locked_pre_cancel() {
                    self.state = BState::Cancelled;
                }
                Ok(vec![])
            }
            Some(Spend::Redeem)
                if !matches!(self.state, BState::BtcRedeemed | BState::ZecSwept) =>
            {
                // The completed signature is on chain: s − ŝ reveals z. Key path: the
                // aggregate signature completes the combined MuSig2 adaptor signature.
                let (enc, sig) = match SwapTxs::keypath_sig(tx) {
                    Some(sig) => (self.keypath_enc_sig.as_ref(), sig),
                    None => (
                        self.redeem_enc_sig.as_ref(),
                        SwapTxs::witness_sig(tx, Spend::Redeem, Role::B)?,
                    ),
                };
                let enc = enc.ok_or(Error::Recovery("redeem without our adaptor"))?;
                let y = adaptor::recover(&self.session.z_encryption_key(), enc, &sig).ok_or(
                    Error::Recovery("redeem signature does not complete our adaptor"),
                )?;
                let z = self.session.peer_share_from_secp(&y)?;
                let ask = self.session.joint_ask(&z)?;
                self.state = BState::BtcRedeemed;
                Ok(vec![Action::SweepZec {
                    joint_fvk: self.session.joint_fvk()?,
                    ask: Secret32::new(*ask),
                }])
            }
            Some(Spend::Refund) if self.state != BState::Refunded => {
                self.state = if confs >= 1 {
                    BState::Refunded
                } else {
                    BState::Refunding
                };
                Ok(vec![])
            }
            Some(Spend::Punish) => {
                self.state = BState::Punished;
                Ok(vec![])
            }
            _ => Ok(vec![]),
        }
    }

    /// Our MuSig2 partial signature on tx_redeem (once: the secret nonce is then erased), and
    /// the combined key-path adaptor signature we will need to extract z.
    fn keypath_partial(&mut self, ks: &KeySpend, txs: &SwapTxs) -> Result<PartialSig, Error> {
        let m = self.musig.clone().ok_or(Error::Musig("no nonces"))?;
        let (Some(z_nonce), Some(z_partial)) = (m.z_nonce, m.z_partial) else {
            return Err(Error::Musig("no partial signature from Z"));
        };
        let secret = self
            .musig_secret
            .take()
            .ok_or(Error::Musig("nonce already used"))?;
        let t = self.session.z_encryption_key();
        let hash = txs.keypath_redeem_sighash();
        let nonces = [&m.b_nonce, &z_nonce];
        let key = self.session.me.btc_key();
        let ours = ks
            .partial_sign(&key, Role::B, secret.expose(), nonces, &t, &hash)
            .ok_or(Error::Musig("signing failed"))?;
        let enc = ks
            .combine([&ours, &z_partial], nonces, &t, &hash)
            .filter(|e| adaptor::verify_encrypted(&ks.output_key(), &t, &hash, e))
            .ok_or(Error::Musig("combined adaptor signature invalid"))?;
        self.keypath_enc_sig = Some(enc);
        Ok(ours)
    }

    /// Timelock-driven transitions.
    fn tick(&mut self) -> Result<Vec<Action>, Error> {
        let params = &self.session.params;
        if self.state.is_locked_pre_cancel() && params.can_cancel(self.lock_confs) {
            self.state = BState::Cancelled;
            let tx = self.cancel_tx.clone().expect("cancel signed before lock");
            return Ok(vec![Action::BroadcastBtc(tx)]);
        }
        if self.state == BState::Cancelled
            && self.cancel_confs.is_some_and(|c| params.can_refund(c))
        {
            let txs = self.txs()?;
            let hash = txs.sighash(Spend::Refund);
            let enc = self
                .refund_enc_sig
                .as_ref()
                .expect("refund adaptor received before lock");
            let sig_z = adaptor::decrypt(&self.session.me.share_secp_bytes(), enc)
                .filter(|s| adaptor::verify_libsecp(&self.session.peer.btc_key, &hash, s))
                .ok_or(Error::BadSignature("decrypted refund signature"))?;
            let sig_b = self.session.me.btc_key().sign(&hash);
            self.state = BState::Refunding;
            return Ok(vec![Action::BroadcastBtc(txs.complete(
                Spend::Refund,
                &sig_b,
                &sig_z,
            )?)]);
        }
        Ok(vec![])
    }
}
