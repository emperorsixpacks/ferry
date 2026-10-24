//! Z: holds shielded ZEC, wants BTC.
//!
//! ```text
//! Negotiated → CancelSigsSent → CancelSigned → BtcLockSeen → ZecLocked → RedeemSigReceived
//!   → Redeeming → BtcRedeemed ✔
//! lock_confs ≥ T1 → Cancelled → (B refunds: b extracted) → ZecReclaiming → ZecReclaimed ✔
//!                             → (no refund by T2) → Punishing → Punished (BTC taken) ✔
//! ```

use ferry_btc::adaptor::{self, EncryptedSignature, Signature};
use ferry_btc::bitcoin::{OutPoint, Transaction, TxOut};
use ferry_btc::musig::{PartialSig, PubNonce};
use ferry_btc::SwapTxs;
use serde::{Deserialize, Serialize};

use crate::{Action, ChainEvent, Error, Event, Message, Role, Secret32, Session, Spend};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ZState {
    /// Keys exchanged; waiting for B's lock template.
    Negotiated,
    /// Our tx_cancel signature and tx_refund adaptor are out.
    CancelSigsSent,
    /// tx_cancel fully signed; waiting for the lock to confirm.
    CancelSigned,
    /// The lock is on chain, possibly not yet buried enough to lock ZEC.
    BtcLockSeen,
    /// ZEC sent to the joint address; waiting for B's redeem adaptor.
    ZecLocked,
    /// Our wallet refused to fund the ZEC lock and nothing was sent (or a lock that may have
    /// gone out provably never landed); waiting for tx_cancel, after which B's refund moves us
    /// to `Refunded`.
    ZecLockRefused,
    /// B's redeem adaptor verified.
    RedeemSigReceived,
    /// tx_redeem broadcast.
    Redeeming,
    BtcRedeemed,
    /// tx_cancel broadcast or seen.
    Cancelled,
    /// B refunded and `b` is extracted; sweeping our ZEC back.
    ZecReclaiming,
    ZecReclaimed,
    /// B refunded before any ZEC was locked: nothing to reclaim.
    Refunded,
    Punishing,
    Punished,
    Aborted,
}

impl ZState {
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            ZState::BtcRedeemed
                | ZState::ZecReclaimed
                | ZState::Refunded
                | ZState::Punished
                | ZState::Aborted
        )
    }

    /// Lock may be on chain, cancel not yet seen, and we are not redeeming.
    fn may_cancel(&self) -> bool {
        matches!(
            self,
            ZState::CancelSigned
                | ZState::BtcLockSeen
                | ZState::ZecLocked
                | ZState::ZecLockRefused
                | ZState::RedeemSigReceived
        )
    }
}

/// Key path: public MuSig2 nonces and our partial signature on tx_redeem.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Musig {
    #[serde(with = "crate::hex_serde")]
    b_nonce: PubNonce,
    #[serde(with = "crate::hex_serde")]
    z_nonce: PubNonce,
    #[serde(with = "crate::hex_serde")]
    z_partial: PartialSig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ZSwap {
    pub session: Session,
    pub state: ZState,
    lock_outpoint: Option<OutPoint>,
    /// Our tx_cancel signature.
    cancel_sig: Option<Signature>,
    /// Fully signed tx_cancel.
    cancel_tx: Option<Transaction>,
    /// Our adaptor signature on tx_refund, under B_s.
    refund_enc_sig: Option<EncryptedSignature>,
    /// B's adaptor signature on tx_redeem, under Z_s.
    redeem_enc_sig: Option<EncryptedSignature>,
    /// Key path: public nonces `[B's, Z's]` and our partial signature on tx_redeem. Our secret
    /// nonce is used once, when the nonces are fixed, and never stored.
    #[serde(default)]
    musig: Option<Musig>,
    /// Key path: the combined adaptor signature on tx_redeem, under Z_s.
    #[serde(default)]
    keypath_enc_sig: Option<EncryptedSignature>,
    zec_locked: bool,
    /// The joint `ask`, kept once B refunded, so a note that turns up at the joint address
    /// after we concluded none was locked (refused or lapsed) can still be reclaimed.
    #[serde(default)]
    reclaim_ask: Option<Secret32>,
    lock_confs: u32,
    cancel_confs: Option<u32>,
}

impl ZSwap {
    pub(crate) fn new(session: Session) -> Self {
        ZSwap {
            session,
            state: ZState::Negotiated,
            lock_outpoint: None,
            cancel_sig: None,
            cancel_tx: None,
            refund_enc_sig: None,
            redeem_enc_sig: None,
            musig: None,
            keypath_enc_sig: None,
            zec_locked: false,
            reclaim_ask: None,
            lock_confs: 0,
            cancel_confs: None,
        }
    }

    pub fn lock_outpoint(&self) -> Option<OutPoint> {
        self.lock_outpoint
    }

    /// Whether we have sent ZEC to the joint address.
    pub fn zec_locked(&self) -> bool {
        self.zec_locked
    }

    fn txs(&self) -> Result<SwapTxs, Error> {
        self.session
            .txs(self.lock_outpoint.ok_or(Error::LockMismatch)?)
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
            Event::LockFunded { .. } => Err(self.unexpected("LockFunded")),
            Event::ZecLockRefused => {
                if self.state != ZState::ZecLocked {
                    return Err(self.unexpected("ZecLockRefused"));
                }
                // Nothing reached the joint address, so a refund leaves nothing to reclaim.
                self.zec_locked = false;
                self.state = ZState::ZecLockRefused;
                Ok(vec![])
            }
            Event::ZecLockLapsed => {
                // A lock we may have sent can no longer land. Before cancel the swap runs into
                // cancel + refund as if refused; after B's refund there is nothing to reclaim.
                // The joint ask stays kept, so a note that turns up anyway is still reclaimed.
                match self.state {
                    ZState::ZecLocked => self.state = ZState::ZecLockRefused,
                    ZState::Cancelled => {}
                    ZState::ZecReclaiming => self.state = ZState::Refunded,
                    _ => return Err(self.unexpected("ZecLockLapsed")),
                }
                self.zec_locked = false;
                Ok(vec![])
            }
            Event::Chain(c) => self.on_chain(c),
            Event::Timeout => {
                if matches!(
                    self.state,
                    ZState::Negotiated | ZState::CancelSigsSent | ZState::CancelSigned
                ) {
                    self.state = ZState::Aborted;
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

    fn on_message(&mut self, msg: &Message) -> Result<Vec<Action>, Error> {
        match (msg, &self.state) {
            (
                Message::LockTemplate {
                    outpoint,
                    amount,
                    redeem_nonce,
                },
                ZState::Negotiated,
            ) => {
                if *amount != self.session.params.btc_amount {
                    return Err(Error::LockMismatch);
                }
                let txs = self.session.txs(*outpoint)?;
                let key = self.session.me.btc_key();
                let cancel_sig = key.sign(&txs.sighash(Spend::Cancel));
                let refund_enc_sig = key.encrypted_sign(
                    &self.session.b_encryption_key(),
                    &txs.sighash(Spend::Refund),
                );
                let (mut z_nonce, mut z_partial) = (None, None);
                if let Some(ks) = self.session.key_spend() {
                    let b_nonce = redeem_nonce.ok_or(Error::Musig("B sent no nonce"))?;
                    let (secret, public) = ferry_btc::musig::new_nonce();
                    let partial = ks
                        .partial_sign(
                            &key,
                            Role::Z,
                            &secret,
                            [&b_nonce, &public],
                            &self.session.z_encryption_key(),
                            &txs.keypath_redeem_sighash(),
                        )
                        .ok_or(Error::Musig("B's nonce is invalid"))?;
                    self.musig = Some(Musig {
                        b_nonce,
                        z_nonce: public,
                        z_partial: partial,
                    });
                    (z_nonce, z_partial) = (Some(public), Some(partial));
                }
                self.lock_outpoint = Some(*outpoint);
                self.cancel_sig = Some(cancel_sig);
                self.refund_enc_sig = Some(refund_enc_sig.clone());
                self.state = ZState::CancelSigsSent;
                let env = self.session.seal(Message::CancelSigs {
                    cancel_sig,
                    refund_enc_sig,
                    redeem_nonce: z_nonce,
                    redeem_partial: z_partial,
                });
                Ok(vec![Action::SendMessage(env)])
            }
            (Message::CancelSig { cancel_sig }, ZState::CancelSigsSent) => {
                let txs = self.txs()?;
                if !adaptor::verify(
                    &self.session.peer.btc_key,
                    &txs.sighash(Spend::Cancel),
                    cancel_sig,
                ) {
                    return Err(Error::BadSignature("B's tx_cancel signature"));
                }
                let mine = self.cancel_sig.expect("sent with CancelSigs");
                self.cancel_tx = Some(txs.complete(Spend::Cancel, cancel_sig, &mine)?);
                self.state = ZState::CancelSigned;
                Ok(vec![])
            }
            (
                Message::RedeemAdaptor {
                    redeem_enc_sig,
                    redeem_partial,
                },
                // B sends this only once it sees our note, so a refused lock that went out after
                // all is accepted too (and counts as locked from here on).
                ZState::ZecLocked | ZState::ZecLockRefused,
            ) => {
                let txs = self.txs()?;
                let ok = adaptor::verify_encrypted(
                    &self.session.peer.btc_key,
                    &self.session.z_encryption_key(),
                    &txs.sighash(Spend::Redeem),
                    redeem_enc_sig,
                );
                if !ok {
                    return Err(Error::BadSignature("B's tx_redeem adaptor signature"));
                }
                if let Some(ks) = self.session.key_spend() {
                    let m = self.musig.as_ref().expect("signed with CancelSigs");
                    let b_partial =
                        redeem_partial.ok_or(Error::Musig("B sent no partial signature"))?;
                    let t = self.session.z_encryption_key();
                    let hash = txs.keypath_redeem_sighash();
                    let nonces = [&m.b_nonce, &m.z_nonce];
                    if !ks.verify_partial(Role::B, &b_partial, nonces, &t, &hash) {
                        return Err(Error::BadSignature(
                            "B's MuSig2 partial signature on tx_redeem",
                        ));
                    }
                    let enc = ks
                        .combine([&b_partial, &m.z_partial], nonces, &t, &hash)
                        .filter(|e| adaptor::verify_encrypted(&ks.output_key(), &t, &hash, e))
                        .ok_or(Error::Musig("combined adaptor signature invalid"))?;
                    self.keypath_enc_sig = Some(enc);
                }
                self.redeem_enc_sig = Some(redeem_enc_sig.clone());
                self.zec_locked = true;
                self.state = ZState::RedeemSigReceived;
                Ok(vec![])
            }
            (m, _) => Err(self.unexpected(m.name())),
        }
    }

    fn on_chain(&mut self, event: ChainEvent) -> Result<Vec<Action>, Error> {
        if self.cancel_tx.is_none() {
            return Ok(vec![]);
        }
        match event {
            ChainEvent::BtcLockConfirmed { confs, txout } => self.on_lock_confirmed(confs, &txout),
            ChainEvent::BtcSpend { tx, confs } => self.on_spend(&tx, confs),
            ChainEvent::ZecSwept { confs } => {
                if self.state == ZState::ZecReclaiming && confs >= 1 {
                    self.state = ZState::ZecReclaimed;
                }
                Ok(vec![])
            }
            ChainEvent::ZecNoteSeen { value, .. } => {
                // A refused send that went out after all: the note is our lock again. Before
                // cancel the swap simply carries on; after it, B's refund still reveals b and we
                // reclaim instead of leaving the note stranded.
                if !self.zec_locked && value >= self.session.params.zec_amount {
                    match self.state {
                        ZState::ZecLockRefused => {
                            self.zec_locked = true;
                            self.state = ZState::ZecLocked;
                        }
                        ZState::Cancelled => self.zec_locked = true,
                        // B already refunded, and we kept the joint ask for exactly this.
                        ZState::Refunded => {
                            if let Some(ask) = self.reclaim_ask.clone() {
                                self.zec_locked = true;
                                self.state = ZState::ZecReclaiming;
                                return Ok(vec![Action::SweepZec {
                                    joint_fvk: self.session.joint_fvk()?,
                                    ask,
                                }]);
                            }
                        }
                        _ => {}
                    }
                }
                Ok(vec![])
            }
        }
    }

    fn on_lock_confirmed(&mut self, confs: u32, txout: &TxOut) -> Result<Vec<Action>, Error> {
        // Everything we risk rests on this output being the agreed script and amount.
        if *txout != self.txs()?.lock_txout {
            return Err(Error::LockMismatch);
        }
        self.lock_confs = confs;
        if self.state == ZState::CancelSigned && confs >= 1 {
            self.state = ZState::BtcLockSeen;
        }
        Ok(vec![])
    }

    fn on_spend(&mut self, tx: &Transaction, confs: u32) -> Result<Vec<Action>, Error> {
        let txs = self.txs()?;
        match txs.classify(tx) {
            Some(Spend::Redeem) if confs >= 1 => {
                self.state = ZState::BtcRedeemed;
                Ok(vec![])
            }
            Some(Spend::Cancel) => {
                self.cancel_confs = Some(confs);
                if self.state.may_cancel() || self.state == ZState::Redeeming {
                    self.state = ZState::Cancelled;
                }
                Ok(vec![])
            }
            Some(Spend::Refund)
                if !matches!(
                    self.state,
                    ZState::ZecReclaiming | ZState::ZecReclaimed | ZState::Refunded
                ) =>
            {
                // Our completed refund signature is on chain: s − ŝ reveals b. Extracted even
                // when we believe nothing was locked, in case a note turns up later.
                let enc = self.refund_enc_sig.as_ref().expect("sent with CancelSigs");
                let sig_z = SwapTxs::witness_sig(tx, Spend::Refund, Role::Z)?;
                let y = adaptor::recover(&self.session.b_encryption_key(), enc, &sig_z).ok_or(
                    Error::Recovery("refund signature does not complete our adaptor"),
                )?;
                let b = self.session.peer_share_from_secp(&y)?;
                let ask = self.session.joint_ask(&b)?;
                self.reclaim_ask = Some(Secret32::new(*ask));
                if !self.zec_locked {
                    self.state = ZState::Refunded;
                    return Ok(vec![]);
                }
                self.state = ZState::ZecReclaiming;
                Ok(vec![Action::SweepZec {
                    joint_fvk: self.session.joint_fvk()?,
                    ask: Secret32::new(*ask),
                }])
            }
            Some(Spend::Punish) => {
                self.state = if confs >= 1 {
                    ZState::Punished
                } else {
                    ZState::Punishing
                };
                Ok(vec![])
            }
            _ => Ok(vec![]),
        }
    }

    /// Timelock-driven transitions.
    fn tick(&mut self) -> Result<Vec<Action>, Error> {
        let params = self.session.params.clone();
        let mut actions = vec![];
        if self.state == ZState::BtcLockSeen && params.can_lock_zec(self.lock_confs) {
            self.zec_locked = true;
            self.state = ZState::ZecLocked;
            actions.push(Action::SendZec {
                joint_fvk: self.session.joint_fvk()?,
                amount: params.zec_amount,
            });
        }
        if self.state == ZState::RedeemSigReceived && params.can_redeem(self.lock_confs) {
            let txs = self.txs()?;
            if let (Some(enc), Some(ks)) = (&self.keypath_enc_sig, self.session.key_spend()) {
                // Key path: one aggregate signature, completed with z.
                let hash = txs.keypath_redeem_sighash();
                let sig = adaptor::decrypt(&self.session.me.share_secp_bytes(), enc)
                    .filter(|s| adaptor::verify_libsecp(&ks.output_key(), &hash, s))
                    .ok_or(Error::BadSignature("decrypted key-path redeem signature"))?;
                self.state = ZState::Redeeming;
                actions.push(Action::BroadcastBtc(txs.complete_keypath_redeem(&sig)));
                return Ok(actions);
            }
            let hash = txs.sighash(Spend::Redeem);
            let enc = self.redeem_enc_sig.as_ref().expect("verified adaptor");
            let sig_b = adaptor::decrypt(&self.session.me.share_secp_bytes(), enc)
                .filter(|s| adaptor::verify_libsecp(&self.session.peer.btc_key, &hash, s))
                .ok_or(Error::BadSignature("decrypted redeem signature"))?;
            let sig_z = self.session.me.btc_key().sign(&hash);
            self.state = ZState::Redeeming;
            actions.push(Action::BroadcastBtc(txs.complete(
                Spend::Redeem,
                &sig_b,
                &sig_z,
            )?));
        }
        if self.state.may_cancel() && params.can_cancel(self.lock_confs) {
            self.state = ZState::Cancelled;
            actions.push(Action::BroadcastBtc(
                self.cancel_tx.clone().expect("cancel signed"),
            ));
        }
        if self.state == ZState::Cancelled
            && self.cancel_confs.is_some_and(|c| params.can_punish(c))
        {
            let txs = self.txs()?;
            let sig = self.session.me.btc_key().sign(&txs.sighash(Spend::Punish));
            self.state = ZState::Punishing;
            actions.push(Action::BroadcastBtc(txs.complete_punish(&sig)));
        }
        Ok(actions)
    }
}
