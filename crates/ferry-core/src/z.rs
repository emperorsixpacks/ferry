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
                | ZState::RedeemSigReceived
        )
    }
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
    zec_locked: bool,
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
            zec_locked: false,
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
            (Message::LockTemplate { outpoint, amount }, ZState::Negotiated) => {
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
                self.lock_outpoint = Some(*outpoint);
                self.cancel_sig = Some(cancel_sig);
                self.refund_enc_sig = Some(refund_enc_sig.clone());
                self.state = ZState::CancelSigsSent;
                let env = self.session.seal(Message::CancelSigs {
                    cancel_sig,
                    refund_enc_sig,
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
            (Message::RedeemAdaptor { redeem_enc_sig }, ZState::ZecLocked) => {
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
                self.redeem_enc_sig = Some(redeem_enc_sig.clone());
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
            ChainEvent::ZecNoteSeen { .. } => Ok(vec![]),
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
                if !self.zec_locked {
                    self.state = ZState::Refunded;
                    return Ok(vec![]);
                }
                // Our completed refund signature is on chain: s − ŝ reveals b.
                let enc = self.refund_enc_sig.as_ref().expect("sent with CancelSigs");
                let sig_z = SwapTxs::witness_sig(tx, Spend::Refund, Role::Z)?;
                let y = adaptor::recover(&self.session.b_encryption_key(), enc, &sig_z).ok_or(
                    Error::Recovery("refund signature does not complete our adaptor"),
                )?;
                let b = self.session.peer_share_from_secp(&y)?;
                let ask = self.session.joint_ask(&b)?;
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
