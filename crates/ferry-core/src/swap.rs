//! Negotiation and the role-independent driver interface.

use ferry_btc::bitcoin::{Address, Amount, OutPoint, Transaction, TxOut, Txid};
use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::session::check_envelope;
use crate::{
    BSwap, Envelope, Error, LocalKeys, Message, Peer, Role, Secret32, Session, Spend, SwapParams,
    Transcript, ZSwap,
};

/// Inputs to a state machine.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)] // transient values; boxing would only burden callers
pub enum Event {
    /// A message from the counterparty.
    Peer(Envelope),
    Chain(ChainEvent),
    /// B only: the wallet funded and signed the lock transaction requested by
    /// [`Action::FundBtcLock`] (not broadcast).
    LockFunded {
        tx: Transaction,
        vout: u32,
    },
    /// The negotiation deadline passed. Aborts only while nothing is locked.
    Timeout,
    /// Z only: the wallet refused [`Action::SendZec`] before broadcasting anything (for
    /// example, not enough Ironwood notes to fund it shielded-only). No ZEC is locked; the
    /// swap waits for tx_cancel and B's refund.
    ZecLockRefused,
    /// Z only: a lock that may have been sent provably never landed: no note worth the amount
    /// at the joint address, and no transaction of ours that could still create one (see
    /// [`crate::ZecLeg::lock_lapsed`]). Nothing is locked, so nothing is reclaimed.
    ZecLockLapsed,
}

/// What the chain watchers report. Emitted again whenever the confirmation count changes.
#[derive(Clone, Debug)]
pub enum ChainEvent {
    /// The lock output, with its confirmation count (drives T1).
    BtcLockConfirmed { confs: u32, txout: TxOut },
    /// One of the swap's spends (see [`Swap::watch_txids`]) in the mempool (`confs = 0`) or
    /// a block. The cancel's count drives T2.
    BtcSpend { tx: Transaction, confs: u32 },
    /// The ZEC lock note at the joint address.
    ZecNoteSeen { value: u64, confs: u32 },
    /// Our sweep of the joint address.
    ZecSwept { confs: u32 },
}

/// Outputs for the daemon to execute.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
pub enum Action {
    SendMessage(Envelope),
    /// B only: fund (and sign, but not broadcast) `amount` to the lock address, then feed
    /// back [`Event::LockFunded`].
    FundBtcLock {
        address: Address,
        amount: Amount,
    },
    BroadcastBtc(Transaction),
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
pub struct Proposal {
    #[serde(with = "crate::hex_serde")]
    session_id: [u8; 32],
    params: SwapParams,
    me: LocalKeys,
    transcript: Transcript,
}

impl Proposal {
    /// Start a swap as taker in `role`. `btc_address` is our payout (Z) or refund (B) address.
    pub fn new<R: RngCore + CryptoRng>(
        rng: &mut R,
        session_id: [u8; 32],
        role: Role,
        params: SwapParams,
        btc_address: Address,
    ) -> Result<(Proposal, Envelope), Error> {
        params.validate()?;
        check_address(&btc_address, &params, role)?;
        let me = LocalKeys::generate(rng, &session_id, role, btc_address);
        let mut transcript = Transcript::new(&session_id);
        let message = Message::Propose {
            params: params.clone(),
            setup: me.setup.clone(),
        };
        let env = Envelope {
            version: crate::PROTOCOL_VERSION,
            session_id,
            transcript: transcript.hash(),
            message,
        };
        transcript.absorb(&env.message);
        Ok((
            Proposal {
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
        env: &Envelope,
    ) -> Result<(Swap, Vec<Action>), Error> {
        check_envelope(env, &self.session_id, &self.transcript)?;
        let Message::Accept { setup } = &env.message else {
            return Err(Error::Unexpected {
                state: "Proposed".into(),
                message: env.message.name(),
            });
        };
        let peer = Peer::verify(
            rng,
            &self.session_id,
            self.me.role().peer(),
            self.params.network,
            setup.clone(),
        )?;
        let mut transcript = self.transcript;
        transcript.absorb(&env.message);
        let session = Session {
            session_id: self.session_id,
            params: self.params,
            me: self.me,
            peer,
            transcript,
        };
        Ok(Swap::start(session))
    }
}

/// Maker side: accept a `Propose` (after checking its terms against our offer). Returns the
/// running swap and its first actions, including the `Accept` message.
pub fn accept<R: RngCore + CryptoRng>(
    rng: &mut R,
    env: &Envelope,
    btc_address: Address,
) -> Result<(Swap, Vec<Action>), Error> {
    let mut transcript = Transcript::new(&env.session_id);
    check_envelope(env, &env.session_id, &transcript)?;
    let Message::Propose { params, setup } = &env.message else {
        return Err(Error::Unexpected {
            state: "Listening".into(),
            message: env.message.name(),
        });
    };
    params.validate()?;
    let role = setup.role.peer();
    check_address(&btc_address, params, role)?;
    let peer = Peer::verify(
        rng,
        &env.session_id,
        setup.role,
        params.network,
        setup.clone(),
    )?;
    transcript.absorb(&env.message);
    let me = LocalKeys::generate(rng, &env.session_id, role, btc_address);
    let mut session = Session {
        session_id: env.session_id,
        params: params.clone(),
        me,
        peer,
        transcript,
    };
    let reply = session.seal(Message::Accept {
        setup: session.me.setup.clone(),
    });
    let (swap, mut actions) = Swap::start(session);
    actions.insert(0, Action::SendMessage(reply));
    Ok((swap, actions))
}

fn check_address(addr: &Address, params: &SwapParams, role: Role) -> Result<(), Error> {
    if addr.as_unchecked().is_valid_for_network(params.network) {
        Ok(())
    } else {
        Err(Error::InvalidSetup {
            role,
            reason: "btc address network",
        })
    }
}

/// A running swap in either role.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Swap {
    B(BSwap),
    Z(ZSwap),
}

impl Swap {
    fn start(session: Session) -> (Swap, Vec<Action>) {
        match session.role() {
            Role::B => {
                let (b, actions) = BSwap::start(session);
                (Swap::B(b), actions)
            }
            Role::Z => (Swap::Z(ZSwap::new(session)), vec![]),
        }
    }

    /// Advance the state machine. On error the state is left unchanged.
    pub fn handle(&mut self, event: Event) -> Result<Vec<Action>, Error> {
        match self {
            Swap::B(b) => b.handle(event),
            Swap::Z(z) => z.handle(event),
        }
    }

    pub fn session(&self) -> &Session {
        match self {
            Swap::B(b) => &b.session,
            Swap::Z(z) => &z.session,
        }
    }

    pub fn role(&self) -> Role {
        self.session().role()
    }

    /// The lock outpoint, once B has funded it.
    pub fn lock_outpoint(&self) -> Option<OutPoint> {
        match self {
            Swap::B(b) => b.lock_outpoint(),
            Swap::Z(z) => z.lock_outpoint(),
        }
    }

    /// Txids of the spends to report as [`ChainEvent::BtcSpend`].
    pub fn watch_txids(&self) -> Vec<(Spend, Txid)> {
        let Some(txs) = self
            .lock_outpoint()
            .and_then(|o| self.session().txs(o).ok())
        else {
            return vec![];
        };
        [Spend::Cancel, Spend::Redeem, Spend::Refund, Spend::Punish]
            .into_iter()
            .map(|s| (s, txs.txid(s)))
            .collect()
    }

    pub fn state_name(&self) -> String {
        match self {
            Swap::B(b) => format!("{:?}", b.state),
            Swap::Z(z) => format!("{:?}", z.state),
        }
    }

    /// No further actions will ever be produced.
    pub fn is_final(&self) -> bool {
        match self {
            Swap::B(b) => b.state.is_final(),
            Swap::Z(z) => z.state.is_final(),
        }
    }
}
