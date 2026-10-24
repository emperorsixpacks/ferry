//! Shielded ZEC ↔ an ERC-20 (USDC) locked in FerryLock on an EVM chain (docs/EVM.md).
//!
//! The Zcash side is the Bitcoin flow's: the joint key `ask = σ(z + b)`, cross-group DLEQ
//! proofs, and the same [`crate::ZecLeg`] actions (`SendZec` / `SweepZec`), driven by the same
//! timing ideas. What differs is the counter-chain: instead of presigned Taproot transactions
//! and adaptor signatures, B locks tokens in FerryLock, signs an EIP-712 `Ready(id)` once the
//! ZEC lock is buried, and the shares are revealed in claim / refund calldata.
//!
//! Like the Bitcoin machines these are pure: the daemon feeds [`EvmEvent`]s in (one chain
//! [`EvmObservation`] snapshot per tick, so every transition is idempotent) and executes the
//! returned [`EvmAction`]s.

mod b;
mod keys;
mod messages;
mod params;
mod session;
mod z;

pub use b::{EvmBState, EvmBSwap};
pub use keys::{EvmKeys, EvmPeer, EvmSetup};
pub use messages::{EvmEnvelope, EvmMessage, EvmTranscript, EVM_PROTOCOL_VERSION};
pub use params::{EvmParams, EvmPolicy, ANVIL_CHAIN_ID, BASE_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID};
pub use session::EvmSession;
pub use z::{EvmZState, EvmZSwap};

use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::{Error, Role, Secret32};

/// `FerryLock.Terms`, in plain bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockTerms {
    #[serde(with = "crate::hex_serde")]
    pub token: [u8; 20],
    pub amount: u64,
    #[serde(with = "crate::hex_serde")]
    pub z_addr: [u8; 20],
    #[serde(with = "crate::hex_serde")]
    pub b_addr: [u8; 20],
    #[serde(with = "crate::hex_serde")]
    pub claimer: [u8; 20],
    #[serde(with = "crate::hex_serde")]
    pub refunder: [u8; 20],
    pub t1: u64,
    pub t2: u64,
    pub max_tip: u64,
}

/// The lock as the chain shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedLock {
    pub terms: LockTerms,
    pub confs: u32,
}

/// One look at the swap on the EVM chain: everything FerryLock's events say, as of the latest
/// block. The watcher reports it every tick; the machines take it as a whole.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EvmObservation {
    /// Timestamp of the latest block: what the contract's windows compare against.
    pub now: u64,
    pub lock: Option<ObservedLock>,
    /// Z's share from a `Claimed` event (big-endian secp256k1 scalar), with confirmations.
    pub claimed: Option<([u8; 32], u32)>,
    /// B's share from a `Refunded` event, with confirmations.
    pub refunded: Option<([u8; 32], u32)>,
    /// Confirmations of the `Punished` event.
    pub punished: Option<u32>,
}

#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)] // transient values
pub enum EvmChainEvent {
    Observed(EvmObservation),
    /// The ZEC lock note at the joint address.
    ZecNoteSeen {
        value: u64,
        confs: u32,
    },
    /// Our sweep of the joint address.
    ZecSwept {
        confs: u32,
    },
}

/// Inputs to an EVM state machine.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
pub enum EvmEvent {
    Peer(EvmEnvelope),
    Chain(EvmChainEvent),
    /// B only: the daemon signed [`EvmAction::SignReady`]'s digest with B's EVM key.
    ReadySigned {
        sig: [u8; 65],
    },
    /// The negotiation deadline passed. Aborts only while nothing is locked.
    Timeout,
    /// Z only: the wallet refused [`EvmAction::SendZec`] before broadcasting anything.
    ZecLockRefused,
    /// Z only: a lock that may have been sent provably never landed.
    ZecLockLapsed,
}

/// Outputs for the daemon to execute.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
pub enum EvmAction {
    SendMessage(EvmEnvelope),
    /// B only: approve the token and lock under `terms` with `salt`. Never send once the
    /// latest block's time is at or past `terms.t1` (the contract would refuse it anyway).
    Lock {
        salt: [u8; 32],
        terms: LockTerms,
    },
    /// B only: sign this EIP-712 digest with the refunder key, then feed back
    /// [`EvmEvent::ReadySigned`].
    SignReady {
        digest: [u8; 32],
    },
    /// Z only: claim, publishing `z`. Never send once the latest block time is at or past
    /// `not_after` (t1 − Δ): a claim that lands late reverts and still publishes z.
    Claim {
        id: [u8; 32],
        z: Secret32,
        ready_sig: [u8; 65],
        not_after: u64,
    },
    /// B only: refund, publishing `b`. Only while `not_before <= now < not_after`
    /// (t1 ≤ now < t2 − Δ): a refund that lands outside reverts and still publishes b.
    Refund {
        id: [u8; 32],
        b: Secret32,
        not_before: u64,
        not_after: u64,
    },
    /// Z only: after t2 with no refund, take the tokens.
    Punish {
        id: [u8; 32],
    },
    /// Z only: lock the ZEC at the joint address.
    SendZec {
        joint_fvk: [u8; 96],
        amount: u64,
    },
    /// Sweep the joint address with the now-complete `ask`.
    SweepZec {
        joint_fvk: [u8; 96],
        ask: Secret32,
    },
}

/// Taker side before the maker has answered.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmProposal {
    #[serde(with = "crate::hex_serde")]
    session_id: [u8; 32],
    params: EvmParams,
    me: EvmKeys,
    transcript: EvmTranscript,
}

impl EvmProposal {
    /// Start a swap as taker in `role`, with our EVM account `evm_address`.
    pub fn new<R: RngCore + CryptoRng>(
        rng: &mut R,
        session_id: [u8; 32],
        role: Role,
        params: EvmParams,
        evm_address: [u8; 20],
    ) -> Result<(EvmProposal, EvmEnvelope), Error> {
        params.validate()?;
        let me = EvmKeys::generate(rng, &session_id, role, evm_address);
        let mut transcript = EvmTranscript::new(&session_id);
        let env = EvmEnvelope {
            version: EVM_PROTOCOL_VERSION,
            session_id,
            transcript: transcript.hash(),
            message: EvmMessage::Propose {
                params: params.clone(),
                setup: me.setup.clone(),
            },
        };
        transcript.absorb(&env.message);
        Ok((
            EvmProposal {
                session_id,
                params,
                me,
                transcript,
            },
            env,
        ))
    }

    pub fn session_id(&self) -> [u8; 32] {
        self.session_id
    }

    /// Handle the maker's `Accept`.
    pub fn on_accept<R: RngCore + CryptoRng>(
        self,
        rng: &mut R,
        env: &EvmEnvelope,
    ) -> Result<(EvmSwap, Vec<EvmAction>), Error> {
        self.transcript.check(env, &self.session_id)?;
        let EvmMessage::Accept { setup } = &env.message else {
            return Err(Error::Unexpected {
                state: "Proposed".into(),
                message: env.message.name(),
            });
        };
        let peer = EvmPeer::verify(rng, &self.session_id, self.me.role().peer(), setup.clone())?;
        let mut transcript = self.transcript;
        transcript.absorb(&env.message);
        let session = EvmSession {
            session_id: self.session_id,
            params: self.params,
            me: self.me,
            peer,
            transcript,
        };
        EvmSwap::start(session)
    }
}

/// Maker side: accept a `Propose` (after checking its terms against our offer). Returns the
/// running swap and its first actions, starting with the `Accept` message.
pub fn evm_accept<R: RngCore + CryptoRng>(
    rng: &mut R,
    env: &EvmEnvelope,
    evm_address: [u8; 20],
) -> Result<(EvmSwap, Vec<EvmAction>), Error> {
    let mut transcript = EvmTranscript::new(&env.session_id);
    transcript.check(env, &env.session_id)?;
    let EvmMessage::Propose { params, setup } = &env.message else {
        return Err(Error::Unexpected {
            state: "Listening".into(),
            message: env.message.name(),
        });
    };
    params.validate()?;
    let peer = EvmPeer::verify(rng, &env.session_id, setup.role, setup.clone())?;
    transcript.absorb(&env.message);
    let me = EvmKeys::generate(rng, &env.session_id, setup.role.peer(), evm_address);
    let mut session = EvmSession {
        session_id: env.session_id,
        params: params.clone(),
        me,
        peer,
        transcript,
    };
    let reply = session.seal(EvmMessage::Accept {
        setup: session.me.setup.clone(),
    });
    let (swap, mut actions) = EvmSwap::start(session)?;
    actions.insert(0, EvmAction::SendMessage(reply));
    Ok((swap, actions))
}

/// A running EVM swap in either role.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum EvmSwap {
    B(EvmBSwap),
    Z(EvmZSwap),
}

impl EvmSwap {
    fn start(session: EvmSession) -> Result<(EvmSwap, Vec<EvmAction>), Error> {
        if session.me.setup.evm_address == session.peer.setup.evm_address {
            return Err(Error::InvalidSetup {
                role: session.peer.setup.role,
                reason: "same EVM address as ours",
            });
        }
        // Both lock terms must be derivable (valid points) before anything happens.
        session.lock_terms()?;
        Ok(match session.role() {
            Role::B => {
                let (b, actions) = EvmBSwap::start(session)?;
                (EvmSwap::B(b), actions)
            }
            Role::Z => (EvmSwap::Z(EvmZSwap::new(session)), vec![]),
        })
    }

    /// Advance the state machine. On error the state is left unchanged.
    pub fn handle(&mut self, event: EvmEvent) -> Result<Vec<EvmAction>, Error> {
        match self {
            EvmSwap::B(b) => b.handle(event),
            EvmSwap::Z(z) => z.handle(event),
        }
    }

    pub fn session(&self) -> &EvmSession {
        match self {
            EvmSwap::B(b) => &b.session,
            EvmSwap::Z(z) => &z.session,
        }
    }

    pub fn role(&self) -> Role {
        self.session().role()
    }

    pub fn state_name(&self) -> String {
        match self {
            EvmSwap::B(b) => format!("{:?}", b.state),
            EvmSwap::Z(z) => format!("{:?}", z.state),
        }
    }

    /// No further actions will ever be produced.
    pub fn is_final(&self) -> bool {
        match self {
            EvmSwap::B(b) => b.state.is_final(),
            EvmSwap::Z(z) => z.state.is_final(),
        }
    }

    /// Whether anything of ours may be locked on either chain (the lock was emitted or seen).
    pub fn lock_seen(&self) -> bool {
        match self {
            EvmSwap::B(b) => b.lock_seen(),
            EvmSwap::Z(z) => z.lock_seen(),
        }
    }

    /// Z only: whether we have (or may have) sent ZEC to the joint address.
    pub fn zec_locked(&self) -> bool {
        match self {
            EvmSwap::B(_) => false,
            EvmSwap::Z(z) => z.zec_locked(),
        }
    }
}
