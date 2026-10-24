//! Z on EVM: holds shielded ZEC, wants the token (USDC).
//!
//! ```text
//! Negotiated → LockSeen → ZecLocked → ReadyReceived → Claiming → Claimed ✔
//! now ≥ t1 without a claim → Expired → (B refunds: b extracted) → ZecReclaiming → ZecReclaimed ✔
//!                                    → (no refund by t2) → Punishing → Punished (tokens taken) ✔
//! ```
//!
//! The ZEC side keeps the Bitcoin machine's rules: a refused or lapsed lock means nothing is
//! locked, and the joint `ask` is kept once B refunds, so a note that turns up at the joint
//! address after all is still reclaimed.

use serde::{Deserialize, Serialize};

use super::{EvmAction, EvmChainEvent, EvmEvent, EvmMessage, EvmObservation, EvmSession};
use crate::{Error, Secret32};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvmZState {
    /// Keys exchanged; waiting for B's lock.
    Negotiated,
    /// The lock is on chain with the agreed terms, possibly not yet buried enough.
    LockSeen,
    /// ZEC sent to the joint address; waiting for B's Ready(id) signature.
    ZecLocked,
    /// Our wallet refused to fund the ZEC lock and nothing was sent (or a lock that may have
    /// gone out provably never landed); waiting for t1 and B's refund.
    ZecLockRefused,
    /// B's Ready(id) signature verified.
    ReadyReceived,
    /// Claim requested.
    Claiming,
    /// The claim is mined: the tokens are ours.
    Claimed,
    /// Past t1 without a claim: waiting for B's refund (or t2).
    Expired,
    /// B refunded and `b` is extracted; sweeping our ZEC back.
    ZecReclaiming,
    ZecReclaimed,
    /// B refunded before any ZEC was locked: nothing to reclaim.
    Refunded,
    Punishing,
    Punished,
    Aborted,
}

impl EvmZState {
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            EvmZState::Claimed
                | EvmZState::ZecReclaimed
                | EvmZState::Refunded
                | EvmZState::Punished
                | EvmZState::Aborted
        )
    }

    /// Before t1 with the lock open: these move to `Expired` at t1.
    fn pre_expiry(&self) -> bool {
        matches!(
            self,
            EvmZState::LockSeen
                | EvmZState::ZecLocked
                | EvmZState::ZecLockRefused
                | EvmZState::ReadyReceived
                | EvmZState::Claiming
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmZSwap {
    pub session: EvmSession,
    pub state: EvmZState,
    now: u64,
    lock_confs: u32,
    lock_seen: bool,
    #[serde(default, with = "crate::hex_opt")]
    ready_sig: Option<[u8; 65]>,
    zec_locked: bool,
    /// The joint `ask`, kept once B refunded, so a note that turns up at the joint address
    /// after we concluded none was locked (refused or lapsed) can still be reclaimed.
    #[serde(default)]
    reclaim_ask: Option<Secret32>,
}

impl EvmZSwap {
    pub(crate) fn new(session: EvmSession) -> Self {
        EvmZSwap {
            session,
            state: EvmZState::Negotiated,
            now: 0,
            lock_confs: 0,
            lock_seen: false,
            ready_sig: None,
            zec_locked: false,
            reclaim_ask: None,
        }
    }

    pub fn lock_seen(&self) -> bool {
        self.lock_seen
    }

    /// Whether we have sent ZEC to the joint address.
    pub fn zec_locked(&self) -> bool {
        self.zec_locked
    }

    pub fn now(&self) -> u64 {
        self.now
    }

    pub(crate) fn handle(&mut self, event: EvmEvent) -> Result<Vec<EvmAction>, Error> {
        let mut next = self.clone();
        let mut actions = next.on_event(event)?;
        actions.extend(next.tick()?);
        *self = next;
        Ok(actions)
    }

    fn unexpected(&self, what: &'static str) -> Error {
        Error::Unexpected {
            state: format!("{:?}", self.state),
            message: what,
        }
    }

    fn on_event(&mut self, event: EvmEvent) -> Result<Vec<EvmAction>, Error> {
        match event {
            EvmEvent::Peer(env) => {
                let msg = self.session.open(&env)?;
                self.on_message(msg)
            }
            EvmEvent::Chain(EvmChainEvent::Observed(o)) => self.on_observed(o),
            EvmEvent::Chain(EvmChainEvent::ZecNoteSeen { value, .. }) => self.on_zec_note(value),
            EvmEvent::Chain(EvmChainEvent::ZecSwept { confs }) => {
                if self.state == EvmZState::ZecReclaiming && confs >= 1 {
                    self.state = EvmZState::ZecReclaimed;
                }
                Ok(vec![])
            }
            EvmEvent::ReadySigned { .. } => Err(self.unexpected("ReadySigned")),
            EvmEvent::ZecLockRefused => {
                if self.state != EvmZState::ZecLocked {
                    return Err(self.unexpected("ZecLockRefused"));
                }
                // Nothing reached the joint address, so a refund leaves nothing to reclaim.
                self.zec_locked = false;
                self.state = EvmZState::ZecLockRefused;
                Ok(vec![])
            }
            EvmEvent::ZecLockLapsed => {
                match self.state {
                    EvmZState::ZecLocked => self.state = EvmZState::ZecLockRefused,
                    EvmZState::Expired => {}
                    EvmZState::ZecReclaiming => self.state = EvmZState::Refunded,
                    _ => return Err(self.unexpected("ZecLockLapsed")),
                }
                self.zec_locked = false;
                Ok(vec![])
            }
            EvmEvent::Timeout => {
                if self.state == EvmZState::Negotiated && !self.lock_seen {
                    self.state = EvmZState::Aborted;
                }
                Ok(vec![])
            }
        }
    }

    fn on_message(&mut self, msg: &EvmMessage) -> Result<Vec<EvmAction>, Error> {
        match (msg, &self.state) {
            // B signs only once it sees our note, so a refused lock that went out after all is
            // accepted too (and counts as locked from here on).
            (EvmMessage::ReadySig { sig }, EvmZState::ZecLocked | EvmZState::ZecLockRefused) => {
                if !self.session.is_ready_sig(sig) {
                    return Err(Error::BadSignature("B's Ready(id) signature"));
                }
                self.ready_sig = Some(*sig);
                self.zec_locked = true;
                self.state = EvmZState::ReadyReceived;
                Ok(vec![])
            }
            (m, _) => Err(self.unexpected(m.name())),
        }
    }

    fn on_observed(&mut self, o: EvmObservation) -> Result<Vec<EvmAction>, Error> {
        self.now = self.now.max(o.now);
        if let Some(lock) = &o.lock {
            // Everything we risk rests on these terms, bAddr above all: a refund under another
            // b would leave our ZEC stuck.
            if lock.terms != self.session.lock_terms()? {
                return Err(Error::LockMismatch);
            }
            self.lock_seen = true;
            self.lock_confs = lock.confs;
            if self.state == EvmZState::Negotiated && lock.confs >= 1 {
                self.state = EvmZState::LockSeen;
            }
        }
        if o.claimed.is_some_and(|(_, confs)| confs >= 1) {
            self.state = EvmZState::Claimed;
            return Ok(vec![]);
        }
        if let Some((b, _)) = o.refunded {
            if !matches!(
                self.state,
                EvmZState::ZecReclaiming | EvmZState::ZecReclaimed | EvmZState::Refunded
            ) {
                // b is public in the refund. Extracted even when we believe nothing was
                // locked, in case a note turns up later.
                let b = self.session.peer_share_from_secp(&b)?;
                let ask = Secret32::new(*self.session.joint_ask(&b)?);
                self.reclaim_ask = Some(ask.clone());
                if !self.zec_locked {
                    self.state = EvmZState::Refunded;
                    return Ok(vec![]);
                }
                self.state = EvmZState::ZecReclaiming;
                return Ok(vec![EvmAction::SweepZec {
                    joint_fvk: self.session.joint_fvk()?,
                    ask,
                }]);
            }
        }
        if let Some(confs) = o.punished {
            self.state = if confs >= 1 {
                EvmZState::Punished
            } else {
                EvmZState::Punishing
            };
        }
        Ok(vec![])
    }

    fn on_zec_note(&mut self, value: u64) -> Result<Vec<EvmAction>, Error> {
        // A refused send that went out after all: the note is our lock again. Before t1 the
        // swap carries on; after it, B's refund still reveals b and we reclaim.
        if self.zec_locked || value < self.session.params.zec_amount {
            return Ok(vec![]);
        }
        match self.state {
            EvmZState::ZecLockRefused => {
                self.zec_locked = true;
                self.state = EvmZState::ZecLocked;
            }
            EvmZState::Expired => self.zec_locked = true,
            // B already refunded, and we kept the joint ask for exactly this.
            EvmZState::Refunded => {
                if let Some(ask) = self.reclaim_ask.clone() {
                    self.zec_locked = true;
                    self.state = EvmZState::ZecReclaiming;
                    return Ok(vec![EvmAction::SweepZec {
                        joint_fvk: self.session.joint_fvk()?,
                        ask,
                    }]);
                }
            }
            _ => {}
        }
        Ok(vec![])
    }

    /// Time-driven transitions.
    fn tick(&mut self) -> Result<Vec<EvmAction>, Error> {
        let params = self.session.params.clone();
        let mut actions = vec![];
        if self.state == EvmZState::LockSeen && params.can_lock_zec(self.lock_confs, self.now) {
            self.zec_locked = true;
            self.state = EvmZState::ZecLocked;
            actions.push(EvmAction::SendZec {
                joint_fvk: self.session.joint_fvk()?,
                amount: params.zec_amount,
            });
        }
        if self.state == EvmZState::ReadyReceived && params.can_claim(self.now) {
            self.state = EvmZState::Claiming;
            actions.push(EvmAction::Claim {
                id: self.session.swap_id(),
                z: Secret32::new(*self.session.me.share_secp_bytes()),
                ready_sig: self.ready_sig.expect("verified with ReadyReceived"),
                not_after: params.t1 - params.claim_margin,
            });
        }
        if params.claim_closed(self.now) {
            if self.state.pre_expiry() {
                self.state = EvmZState::Expired;
            } else if self.state == EvmZState::Negotiated && !self.lock_seen {
                // No lock can land any more: nothing happened on either chain.
                self.state = EvmZState::Aborted;
            }
        }
        if self.state == EvmZState::Expired && params.can_punish(self.now) {
            self.state = EvmZState::Punishing;
            actions.push(EvmAction::Punish {
                id: self.session.swap_id(),
            });
        }
        Ok(actions)
    }
}
