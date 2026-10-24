//! B on EVM: holds the token (USDC), wants shielded ZEC.
//!
//! ```text
//! Locking → Locked → ZecSeen → ReadySigning → ReadySent → Claimed (z extracted, sweep) → ZecSwept ✔
//! now ≥ t1, not claimed → Refunding → Refunded ✔ (b revealed)
//! t2 − Δ passes without a refund → (Z punishes) → Punished ✘
//! now ≥ t1 and the lock never landed → Aborted
//! ```

use serde::{Deserialize, Serialize};

use super::{EvmAction, EvmChainEvent, EvmEvent, EvmMessage, EvmObservation, EvmSession};
use crate::{Error, Secret32};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvmBState {
    /// Lock requested from the wallet; waiting to see it on chain.
    Locking,
    /// The lock has at least one confirmation; waiting for Z's ZEC.
    Locked,
    /// The ZEC lock note is visible but not yet buried under N confirmations.
    ZecSeen {
        confs: u32,
    },
    /// Asked the daemon to sign Ready(id).
    ReadySigning,
    /// Our Ready(id) signature is out; waiting for Z to claim.
    ReadySent,
    /// Z claimed, `z` is extracted and the sweep requested.
    Claimed,
    ZecSwept,
    /// Past t1 without a claim: refund requested.
    Refunding,
    Refunded,
    Punished,
    /// The lock never landed before t1.
    Aborted,
}

impl EvmBState {
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            EvmBState::ZecSwept | EvmBState::Refunded | EvmBState::Punished | EvmBState::Aborted
        )
    }

    /// Our tokens are locked and nobody has taken them yet.
    fn open(&self) -> bool {
        matches!(
            self,
            EvmBState::Locked
                | EvmBState::ZecSeen { .. }
                | EvmBState::ReadySigning
                | EvmBState::ReadySent
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmBSwap {
    pub session: EvmSession,
    pub state: EvmBState,
    /// Latest block time seen.
    now: u64,
    lock_confs: u32,
    lock_seen: bool,
    /// Our Ready(id) signature, once made.
    #[serde(default, with = "crate::hex_opt")]
    ready_sig: Option<[u8; 65]>,
    /// A note at the joint address was spent before we signed Ready: someone else knows the
    /// joint key (e.g. Z learned `b` from a watchtower that leaked it). Never sign it then.
    #[serde(default)]
    zec_spent_early: bool,
}

impl EvmBSwap {
    pub(crate) fn start(session: EvmSession) -> Result<(Self, Vec<EvmAction>), Error> {
        let lock = EvmAction::Lock {
            salt: session.salt(),
            terms: session.lock_terms()?,
        };
        let b = EvmBSwap {
            session,
            state: EvmBState::Locking,
            now: 0,
            lock_confs: 0,
            lock_seen: false,
            ready_sig: None,
            zec_spent_early: false,
        };
        Ok((b, vec![lock]))
    }

    pub fn lock_seen(&self) -> bool {
        self.lock_seen
    }

    pub fn now(&self) -> u64 {
        self.now
    }

    pub(crate) fn handle(&mut self, event: EvmEvent) -> Result<Vec<EvmAction>, Error> {
        let mut next = self.clone();
        let mut actions = next.on_event(event)?;
        actions.extend(next.tick());
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
                Err(self.unexpected(msg.name()))
            }
            EvmEvent::Chain(EvmChainEvent::Observed(o)) => self.on_observed(o),
            EvmEvent::Chain(EvmChainEvent::ZecNoteSeen {
                value,
                confs,
                spent,
            }) => Ok(self.on_zec_note(value, confs, spent)),
            EvmEvent::Chain(EvmChainEvent::ZecSwept { confs }) => {
                if self.state == EvmBState::Claimed && confs >= 1 {
                    self.state = EvmBState::ZecSwept;
                }
                Ok(vec![])
            }
            EvmEvent::ReadySigned { sig } => {
                if self.state != EvmBState::ReadySigning {
                    return Err(self.unexpected("ReadySigned"));
                }
                if !self.session.is_ready_sig(&sig) {
                    return Err(Error::BadSignature(
                        "our Ready(id) signature does not recover to our address",
                    ));
                }
                self.ready_sig = Some(sig);
                self.state = EvmBState::ReadySent;
                let env = self.session.seal(EvmMessage::ReadySig { sig });
                Ok(vec![EvmAction::SendMessage(env)])
            }
            // B never aborts on the negotiation deadline: the lock is requested at once, and
            // a lock that never lands is settled by `tick` at t1.
            EvmEvent::Timeout => Ok(vec![]),
            EvmEvent::ZecLockRefused => Err(self.unexpected("ZecLockRefused")),
            EvmEvent::ZecLockLapsed => Err(self.unexpected("ZecLockLapsed")),
        }
    }

    fn on_observed(&mut self, o: EvmObservation) -> Result<Vec<EvmAction>, Error> {
        self.now = self.now.max(o.now);
        if let Some(lock) = &o.lock {
            if lock.terms != self.session.lock_terms()? {
                return Err(Error::LockMismatch);
            }
            self.lock_seen = true;
            self.lock_confs = lock.confs;
            if self.state == EvmBState::Locking && lock.confs >= 1 {
                self.state = EvmBState::Locked;
            }
        }
        if let Some((z, _)) = o.claimed {
            if !matches!(self.state, EvmBState::Claimed | EvmBState::ZecSwept) {
                // z is public in the claim: with b it completes the joint spend key.
                let z = self.session.peer_share_from_secp(&z)?;
                let ask = self.session.joint_ask(&z)?;
                self.state = EvmBState::Claimed;
                return Ok(vec![EvmAction::SweepZec {
                    joint_fvk: self.session.joint_fvk()?,
                    ask: Secret32::new(*ask),
                }]);
            }
        }
        if o.refunded.is_some_and(|(_, confs)| confs >= 1) {
            self.state = EvmBState::Refunded;
        }
        if o.punished.is_some() {
            self.state = EvmBState::Punished;
        }
        Ok(vec![])
    }

    fn on_zec_note(&mut self, value: u64, confs: u32, spent: bool) -> Vec<EvmAction> {
        let params = &self.session.params;
        let waiting = matches!(self.state, EvmBState::Locked | EvmBState::ZecSeen { .. });
        // We have not swept, so a spent note means someone else holds the joint key: Ready
        // would hand Z the tokens on top. Withhold it for good; the swap runs into the refund.
        if waiting && spent {
            self.zec_spent_early = true;
        }
        if self.zec_spent_early {
            return vec![];
        }
        // A short note never gets the ready signature: the swap runs into the refund.
        if !waiting || value < params.zec_amount {
            return vec![];
        }
        // Only sign while Z can still claim in time; otherwise wait for t1 and refund.
        if confs < params.zec_confirmations || !params.can_claim(self.now) {
            self.state = EvmBState::ZecSeen { confs };
            return vec![];
        }
        self.state = EvmBState::ReadySigning;
        vec![EvmAction::SignReady {
            digest: self.session.ready_digest(),
        }]
    }

    /// Time-driven transitions.
    fn tick(&mut self) -> Vec<EvmAction> {
        let params = &self.session.params;
        if self.state.open() && params.can_refund(self.now) {
            self.state = EvmBState::Refunding;
            return vec![EvmAction::Refund {
                id: self.session.swap_id(),
                b: Secret32::new(*self.session.me.share_secp_bytes()),
                not_before: params.t1,
                not_after: params.t2 - params.refund_margin,
            }];
        }
        // No block from here on can carry a lock (FerryLock needs t1 > now), and none before
        // the latest one did: the lock never landed.
        if self.state == EvmBState::Locking && !self.lock_seen && params.claim_closed(self.now) {
            self.state = EvmBState::Aborted;
        }
        vec![]
    }
}
