//! Both state machines against a simulated chain (no signatures checked here; the
//! regtest test covers consensus validity).

use std::collections::{HashMap, VecDeque};

use ferry_btc::bitcoin::{
    self, absolute::LockTime, transaction::Version, Address, Amount, Network, OutPoint, Sequence,
    Transaction, TxIn, TxOut, Txid, Witness,
};
use ferry_core::{
    accept, Action, BState, ChainEvent, Error, Event, Message, Proposal, Role, Swap, SwapParams,
    ZState,
};
use rand_core::OsRng;

fn params() -> SwapParams {
    SwapParams {
        network: Network::Regtest,
        btc_amount: 100_000_000,
        zec_amount: 5_000_000_000,
        t1: 12,
        t2: 12,
        btc_fee: 2_000,
        btc_lock_confirmations: 1,
        zec_confirmations: 2,
        cancel_confirmations: 1,
        redeem_margin: 3,
        refund_margin: 3,
        keypath: true,
    }
}

fn address(seed: u8) -> Address {
    let secp = bitcoin::key::Secp256k1::new();
    let sk = bitcoin::secp256k1::SecretKey::from_slice(&[seed; 32]).unwrap();
    let (xonly, _) = sk.x_only_public_key(&secp);
    Address::p2tr(&secp, xonly, None, Network::Regtest)
}

#[derive(Default)]
struct Faults {
    /// Redeem through the 2-of-2 script leaf instead of the MuSig2 key path.
    script_path: bool,
    drop_redeem_adaptor: bool,
    /// B stops processing anything once the lock is broadcast.
    b_offline_after_lock: bool,
    /// Z's wallet never actually sends the ZEC.
    z_never_sends_zec: bool,
    /// Z's wallet refuses to send the ZEC (and says so), e.g. too few Ironwood notes.
    z_wallet_refuses_zec: bool,
    /// ...but the note reaches the joint address anyway (the refusal was wrong).
    refused_zec_lands_anyway: bool,
    /// ...and only shows up once tx_cancel is mined (B will not redeem by then).
    refused_zec_lands_after_cancel: bool,
    /// Deliver the redeem adaptor only after this many lock confirmations.
    delay_redeem_adaptor_until: Option<u32>,
    /// B ignores the chain while the mined cancel has fewer confirmations than this.
    b_asleep_until_cancel_confs: Option<u32>,
}

struct Sim {
    b: Swap,
    z: Swap,
    faults: Faults,
    to_b: VecDeque<Event>,
    to_z: VecDeque<Event>,
    held_adaptor: Option<Event>,
    height: u32,
    /// txid -> (tx, height mined; None in mempool)
    chain: HashMap<Txid, (Transaction, Option<u32>)>,
    zec_note: Option<(u64, u32)>,
    sweeps: Vec<(Role, [u8; 96], [u8; 32])>,
    rejected: Vec<String>,
    b_lock_broadcast: bool,
    refused_amount: Option<u64>,
}

impl Sim {
    fn new(faults: Faults) -> Sim {
        // B is the taker here, Z the maker.
        let sid = [42u8; 32];
        let p = SwapParams {
            keypath: !faults.script_path,
            ..params()
        };
        let (proposal, propose) = Proposal::new(&mut OsRng, sid, Role::B, p, address(1)).unwrap();
        let (z, z_actions) = accept(&mut OsRng, &propose, address(2)).unwrap();
        let Action::SendMessage(accept_env) = &z_actions[0] else {
            panic!("expected Accept")
        };
        let (b, b_actions) = proposal.on_accept(&mut OsRng, accept_env).unwrap();
        let mut sim = Sim {
            b,
            z,
            faults,
            to_b: VecDeque::new(),
            to_z: VecDeque::new(),
            held_adaptor: None,
            height: 100,
            chain: HashMap::new(),
            zec_note: None,
            sweeps: vec![],
            rejected: vec![],
            b_lock_broadcast: false,
            refused_amount: None,
        };
        sim.exec(Role::Z, z_actions[1..].to_vec());
        sim.exec(Role::B, b_actions);
        sim.pump();
        sim
    }

    fn swap(&mut self, role: Role) -> &mut Swap {
        match role {
            Role::B => &mut self.b,
            Role::Z => &mut self.z,
        }
    }

    fn b_offline(&self) -> bool {
        self.faults.b_offline_after_lock && self.b_lock_broadcast
    }

    fn exec(&mut self, from: Role, actions: Vec<Action>) {
        for a in actions {
            match a {
                Action::SendMessage(env) => {
                    let ev = Event::Peer(env.clone());
                    match (from, &env.message) {
                        (Role::B, Message::RedeemAdaptor { .. })
                            if self.faults.drop_redeem_adaptor => {}
                        (Role::B, Message::RedeemAdaptor { .. })
                            if self.faults.delay_redeem_adaptor_until.is_some() =>
                        {
                            self.held_adaptor = Some(ev)
                        }
                        (Role::B, _) => self.to_z.push_back(ev),
                        (Role::Z, _) => self.to_b.push_back(ev),
                    }
                }
                Action::FundBtcLock { address, amount } => {
                    let tx = Transaction {
                        version: Version::TWO,
                        lock_time: LockTime::ZERO,
                        input: vec![TxIn {
                            previous_output: OutPoint {
                                txid: Txid::from_raw_hash(bitcoin::hashes::Hash::all_zeros()),
                                vout: 7,
                            },
                            sequence: Sequence::MAX,
                            witness: Witness::from_slice(&[[1u8; 64]]),
                            ..Default::default()
                        }],
                        output: vec![TxOut {
                            value: amount,
                            script_pubkey: address.script_pubkey(),
                        }],
                    };
                    self.to_b.push_back(Event::LockFunded { tx, vout: 0 });
                }
                Action::BroadcastBtc(tx) => {
                    if from == Role::B && self.chain.is_empty() {
                        self.b_lock_broadcast = true;
                    }
                    if let Err(e) = self.broadcast(tx) {
                        self.rejected.push(format!("{from:?}: {e}"));
                    }
                }
                Action::SendZec { joint_fvk, amount } => {
                    assert_eq!(from, Role::Z);
                    assert_eq!(joint_fvk, self.b.session().joint_fvk().unwrap());
                    if self.faults.z_wallet_refuses_zec {
                        self.to_z.push_back(Event::ZecLockRefused);
                        if self.faults.refused_zec_lands_anyway {
                            self.zec_note = Some((amount, self.height));
                        }
                        self.refused_amount = Some(amount);
                    } else if !self.faults.z_never_sends_zec {
                        self.zec_note = Some((amount, self.height));
                    }
                }
                Action::SweepZec { joint_fvk, ask } => {
                    self.sweeps.push((from, joint_fvk, *ask.expose()));
                }
            }
        }
    }

    fn confs(&self, txid: &Txid) -> Option<u32> {
        self.chain
            .get(txid)
            .map(|(_, h)| h.map_or(0, |h| self.height - h + 1))
    }

    /// Minimal mempool policy: inputs exist and are unspent, BIP68 heights are met.
    fn broadcast(&mut self, tx: Transaction) -> Result<(), String> {
        let txid = tx.compute_txid();
        if self.chain.contains_key(&txid) {
            return Err("already known".into());
        }
        for input in &tx.input {
            let prev = input.previous_output;
            if self.chain.is_empty() {
                break; // the lock: funded from outside the simulation
            }
            let confs = self.confs(&prev.txid).ok_or("missing input")?;
            let spent = self
                .chain
                .values()
                .any(|(t, _)| t.input.iter().any(|i| i.previous_output == prev));
            if spent {
                return Err("input already spent".into());
            }
            if let Some(h) = input.sequence.to_relative_lock_time() {
                let need = match h {
                    bitcoin::relative::LockTime::Blocks(b) => u32::from(b.value()),
                    _ => unreachable!(),
                };
                if confs < need {
                    return Err(format!("non-BIP68-final ({confs} < {need})"));
                }
            }
        }
        self.chain.insert(txid, (tx, None));
        Ok(())
    }

    fn deliver(&mut self, role: Role, ev: Event) -> Result<(), Error> {
        if role == Role::B && self.b_offline() {
            return Ok(());
        }
        if let (Role::B, Some(wake), Event::Chain(_)) =
            (role, self.faults.b_asleep_until_cancel_confs, &ev)
        {
            let cancel = self.txid(ferry_core::Spend::Cancel);
            if self.mined(&cancel) && self.confs(&cancel).unwrap() < wake {
                return Ok(());
            }
        }
        let actions = self.swap(role).handle(ev)?;
        self.exec(role, actions);
        Ok(())
    }

    fn pump(&mut self) {
        loop {
            if let Some(ev) = self.to_z.pop_front() {
                self.deliver(Role::Z, ev).unwrap();
            } else if let Some(ev) = self.to_b.pop_front() {
                self.deliver(Role::B, ev).unwrap();
            } else {
                break;
            }
        }
    }

    fn chain_events(&self, swap: &Swap) -> Vec<ChainEvent> {
        let mut out = vec![];
        let Some(lock) = swap.lock_outpoint() else {
            return out;
        };
        if let Some((tx, Some(_))) = self.chain.get(&lock.txid) {
            let txout = tx.output[lock.vout as usize].clone();
            out.push(ChainEvent::BtcLockConfirmed {
                confs: self.confs(&lock.txid).unwrap(),
                txout,
            });
        }
        for (_, txid) in swap.watch_txids() {
            if let Some((tx, _)) = self.chain.get(&txid) {
                out.push(ChainEvent::BtcSpend {
                    tx: tx.clone(),
                    confs: self.confs(&txid).unwrap(),
                });
            }
        }
        if let Some((value, h)) = self.zec_note {
            out.push(ChainEvent::ZecNoteSeen {
                value,
                confs: self.height - h,
            });
        }
        if self.sweeps.iter().any(|(r, ..)| *r == swap.role()) {
            out.push(ChainEvent::ZecSwept { confs: 1 });
        }
        out
    }

    fn mine(&mut self, n: u32) {
        for _ in 0..n {
            self.height += 1;
            let h = self.height;
            for (_, mined) in self.chain.values_mut() {
                mined.get_or_insert(h);
            }
            if self.faults.refused_zec_lands_after_cancel && self.zec_note.is_none() {
                if let Some(amount) = self.refused_amount {
                    let cancel = self.txid(ferry_core::Spend::Cancel);
                    if self.mined(&cancel) {
                        self.zec_note = Some((amount, h));
                    }
                }
            }
            for role in [Role::Z, Role::B] {
                let swap = match role {
                    Role::B => &self.b,
                    Role::Z => &self.z,
                };
                for ev in self.chain_events(swap) {
                    self.deliver(role, Event::Chain(ev)).unwrap();
                }
            }
            if let (Some(until), Some(lock)) = (
                self.faults.delay_redeem_adaptor_until,
                self.z.lock_outpoint(),
            ) {
                if self.confs(&lock.txid).unwrap_or(0) >= until {
                    if let Some(ev) = self.held_adaptor.take() {
                        self.to_z.push_back(ev);
                    }
                }
            }
            self.pump();
        }
    }

    fn mine_until(&mut self, max: u32, done: impl Fn(&Sim) -> bool) {
        for _ in 0..max {
            if done(self) {
                return;
            }
            self.mine(1);
        }
        assert!(
            done(self),
            "not done after {max} blocks: B {} / Z {}",
            self.b.state_name(),
            self.z.state_name()
        );
    }

    fn b_state(&self) -> BState {
        match &self.b {
            Swap::B(b) => b.state.clone(),
            _ => unreachable!(),
        }
    }

    fn z_state(&self) -> ZState {
        match &self.z {
            Swap::Z(z) => z.state.clone(),
            _ => unreachable!(),
        }
    }

    fn mined(&self, txid: &Txid) -> bool {
        matches!(self.chain.get(txid), Some((_, Some(_))))
    }

    fn txid(&self, spend: ferry_core::Spend) -> Txid {
        self.z
            .watch_txids()
            .into_iter()
            .find(|(s, _)| *s == spend)
            .unwrap()
            .1
    }

    /// The swept `ask` must be the discrete log of the joint `ak`.
    fn assert_sweep_valid(&self, role: Role) {
        let (_, fvk, ask) = self
            .sweeps
            .iter()
            .find(|(r, ..)| *r == role)
            .expect("sweep");
        let ask = ferry_dleq::pallas_scalar_from_bytes(ask).unwrap();
        assert_eq!(
            ferry_dleq::pallas_bytes(&(ferry_dleq::spend_auth_g() * ask)),
            fvk[..32]
        );
        assert_eq!(*fvk, self.z.session().joint_fvk().unwrap());
    }
}

#[test]
fn happy_path() {
    let mut sim = Sim::new(Faults::default());
    assert_eq!(sim.b_state(), BState::CancelSigned);
    assert_eq!(sim.z_state(), ZState::CancelSigned);
    sim.mine_until(10, |s| {
        s.b_state() == BState::ZecSwept && s.z_state() == ZState::BtcRedeemed
    });
    let redeem = sim.txid(ferry_core::Spend::Redeem);
    assert!(sim.mined(&redeem));
    assert_eq!(
        sim.chain[&redeem].0.input[0].witness.len(),
        1,
        "MuSig2 key-path spend"
    );
    assert!(!sim.chain.contains_key(&sim.txid(ferry_core::Spend::Cancel)));
    sim.assert_sweep_valid(Role::B);
    assert!(sim.rejected.is_empty(), "{:?}", sim.rejected);
}

#[test]
fn joint_viewing_key_needs_the_ecdh_secret() {
    let sim = Sim::new(Faults::default());
    let (zs, bs) = (sim.z.session(), sim.b.session());
    assert_eq!(zs.joint_fvk().unwrap(), bs.joint_fvk().unwrap());
    assert_eq!(zs.peer_token(), bs.peer_token());
    assert!(zs.peer_token().is_some());
    // Everything an observer of the plaintext peer channel has: not enough.
    let (z_p, b_p) = zs.pallas_pubs();
    let (nz, nb) = (zs.me.setup.nonce, bs.me.setup.nonce);
    let public_only =
        ferry_core::joint::joint_fvk_bytes(&zs.session_id, &z_p, &b_p, &nz, &nb, None).unwrap();
    assert_eq!(
        public_only[..32],
        zs.joint_fvk().unwrap()[..32],
        "ak is public by design"
    );
    assert_ne!(
        public_only[32..],
        zs.joint_fvk().unwrap()[32..],
        "nk/rivk depend on the ECDH secret"
    );
}

#[test]
fn happy_path_script_path() {
    let mut sim = Sim::new(Faults {
        script_path: true,
        ..Default::default()
    });
    sim.mine_until(10, |s| {
        s.b_state() == BState::ZecSwept && s.z_state() == ZState::BtcRedeemed
    });
    let redeem = sim.txid(ferry_core::Spend::Redeem);
    assert_eq!(
        sim.chain[&redeem].0.input[0].witness.len(),
        4,
        "sig, sig, script, control block"
    );
    sim.assert_sweep_valid(Role::B);
}

#[test]
fn refund_when_b_withholds_redeem_adaptor() {
    let mut sim = Sim::new(Faults {
        drop_redeem_adaptor: true,
        ..Default::default()
    });
    sim.mine_until(40, |s| {
        s.b_state() == BState::Refunded && s.z_state() == ZState::ZecReclaimed
    });
    assert!(sim.mined(&sim.txid(ferry_core::Spend::Refund)));
    sim.assert_sweep_valid(Role::Z);
    assert!(sim.sweeps.iter().all(|(r, ..)| *r == Role::Z));
}

#[test]
fn refund_when_z_never_locks() {
    let mut sim = Sim::new(Faults {
        z_never_sends_zec: true,
        ..Default::default()
    });
    sim.mine_until(40, |s| {
        s.b_state() == BState::Refunded && s.z_state() == ZState::ZecReclaimed
    });
    // Z believes it locked (its wallet lied); reclaiming is still safe and harmless.
    assert!(sim.mined(&sim.txid(ferry_core::Spend::Refund)));
}

#[test]
fn refund_when_z_wallet_refuses_the_lock() {
    let mut sim = Sim::new(Faults {
        z_wallet_refuses_zec: true,
        ..Default::default()
    });
    sim.mine_until(10, |s| s.z_state() == ZState::ZecLockRefused);
    let Swap::Z(z) = &sim.z else { unreachable!() };
    assert!(!z.zec_locked(), "a refused lock is not a lock");
    sim.mine_until(40, |s| {
        s.b_state() == BState::Refunded && s.z_state() == ZState::Refunded
    });
    assert!(sim.mined(&sim.txid(ferry_core::Spend::Refund)));
    // Nothing reached the joint address, so nobody tries to sweep it.
    assert!(sim.sweeps.is_empty());
    // Both parties broadcast tx_cancel at T1; the second copy is merely a duplicate.
    assert!(
        sim.rejected.iter().all(|r| r.ends_with("already known")),
        "{:?}",
        sim.rejected
    );
}

#[test]
fn refused_lock_that_lands_anyway_still_completes() {
    let mut sim = Sim::new(Faults {
        z_wallet_refuses_zec: true,
        refused_zec_lands_anyway: true,
        ..Default::default()
    });
    // Z sees the note, takes its lock back, and the swap completes normally.
    sim.mine_until(40, |s| {
        s.b_state() == BState::ZecSwept && s.z_state() == ZState::BtcRedeemed
    });
    sim.assert_sweep_valid(Role::B);
}

#[test]
fn refused_lock_that_lands_after_cancel_is_reclaimed() {
    let mut sim = Sim::new(Faults {
        z_wallet_refuses_zec: true,
        refused_zec_lands_after_cancel: true,
        ..Default::default()
    });
    sim.mine_until(40, |s| {
        s.b_state() == BState::Refunded && s.z_state() == ZState::ZecReclaimed
    });
    sim.assert_sweep_valid(Role::Z);
}

#[test]
fn punish_when_b_disappears_after_lock() {
    let mut sim = Sim::new(Faults {
        b_offline_after_lock: true,
        ..Default::default()
    });
    sim.mine_until(60, |s| s.z_state() == ZState::Punished);
    assert!(sim.mined(&sim.txid(ferry_core::Spend::Punish)));
    // Z cancelled exactly at T1 and punished exactly at T2; nothing was rejected.
    assert!(sim.rejected.is_empty(), "{:?}", sim.rejected);
}

#[test]
fn z_never_redeems_after_t1_minus_delta() {
    let p = params();
    let late = u32::from(p.t1 - p.redeem_margin);
    let mut sim = Sim::new(Faults {
        delay_redeem_adaptor_until: Some(late),
        ..Default::default()
    });
    sim.mine_until(40, |s| {
        s.b_state() == BState::Refunded && s.z_state() == ZState::ZecReclaimed
    });
    assert!(!sim.chain.contains_key(&sim.txid(ferry_core::Spend::Redeem)));
}

#[test]
fn b_never_refunds_after_t2_minus_delta() {
    let p = params();
    let wake = u32::from(p.t2 - p.refund_margin);
    let mut sim = Sim::new(Faults {
        drop_redeem_adaptor: true,
        b_asleep_until_cancel_confs: Some(wake),
        ..Default::default()
    });
    sim.mine_until(60, |s| {
        s.b_state() == BState::Punished && s.z_state() == ZState::Punished
    });
    assert!(!sim.chain.contains_key(&sim.txid(ferry_core::Spend::Refund)));
    assert!(sim.sweeps.is_empty());
}

#[test]
fn messages_must_extend_the_transcript() {
    let sid = [7u8; 32];
    let (proposal, propose) =
        Proposal::new(&mut OsRng, sid, Role::Z, params(), address(3)).unwrap();
    let (mut b, b_actions) = accept(&mut OsRng, &propose, address(4)).unwrap();
    let Action::SendMessage(accept_env) = &b_actions[0] else {
        panic!()
    };

    let mut wrong = accept_env.clone();
    wrong.transcript[0] ^= 1;
    assert!(matches!(
        proposal.clone().on_accept(&mut OsRng, &wrong),
        Err(Error::TranscriptMismatch)
    ));
    let mut wrong = accept_env.clone();
    wrong.session_id[0] ^= 1;
    assert!(matches!(
        proposal.clone().on_accept(&mut OsRng, &wrong),
        Err(Error::SessionMismatch)
    ));
    let mut wrong = accept_env.clone();
    wrong.version = 2;
    assert!(matches!(
        proposal.clone().on_accept(&mut OsRng, &wrong),
        Err(Error::Version(2))
    ));

    let (_z, _) = proposal.on_accept(&mut OsRng, accept_env).unwrap();
    // Replaying the Propose to the running B is rejected and leaves it untouched.
    let before = b.state_name();
    assert!(b.handle(Event::Peer(propose)).is_err());
    assert_eq!(b.state_name(), before);
}

#[test]
fn forged_cancel_signatures_rejected_without_state_change() {
    let sid = [8u8; 32];
    let (proposal, propose) =
        Proposal::new(&mut OsRng, sid, Role::B, params(), address(5)).unwrap();
    let (mut z, z_actions) = accept(&mut OsRng, &propose, address(6)).unwrap();
    let Action::SendMessage(acc) = &z_actions[0] else {
        panic!()
    };
    let (mut b, b_actions) = proposal.on_accept(&mut OsRng, acc).unwrap();
    let Action::FundBtcLock { address, amount } = &b_actions[0] else {
        panic!()
    };
    let lock = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            witness: Witness::from_slice(&[[1u8; 64]]),
            ..Default::default()
        }],
        output: vec![TxOut {
            value: *amount,
            script_pubkey: address.script_pubkey(),
        }],
    };
    // Wrong amount is refused.
    let mut short = lock.clone();
    short.output[0].value = Amount::from_sat(1);
    assert!(matches!(
        b.handle(Event::LockFunded { tx: short, vout: 0 }),
        Err(Error::LockMismatch)
    ));

    let actions = b.handle(Event::LockFunded { tx: lock, vout: 0 }).unwrap();
    let Action::SendMessage(template) = &actions[0] else {
        panic!()
    };
    let actions = z.handle(Event::Peer(template.clone())).unwrap();
    let Action::SendMessage(cancel_sigs) = &actions[0] else {
        panic!()
    };

    let mut forged = cancel_sigs.clone();
    if let Message::CancelSigs { refund_enc_sig, .. } = &mut forged.message {
        refund_enc_sig.needs_negation = !refund_enc_sig.needs_negation;
    }
    assert!(matches!(
        b.handle(Event::Peer(forged)),
        Err(Error::BadSignature(_))
    ));
    assert_eq!(b.state_name(), "LockBuilt");

    // The genuine message still applies afterwards (transcript untouched by the failure).
    let actions = b.handle(Event::Peer(cancel_sigs.clone())).unwrap();
    assert!(matches!(actions[1], Action::BroadcastBtc(_)));
    assert_eq!(b.state_name(), "CancelSigned");
}

#[test]
fn swap_state_survives_json_roundtrip() {
    let mut sim = Sim::new(Faults::default());
    sim.mine(1);
    let json = serde_json::to_string(&sim.b).unwrap();
    sim.b = serde_json::from_str(&json).unwrap();
    let json = serde_json::to_string(&sim.z).unwrap();
    sim.z = serde_json::from_str(&json).unwrap();
    sim.mine_until(10, |s| {
        s.b_state() == BState::ZecSwept && s.z_state() == ZState::BtcRedeemed
    });
    sim.assert_sweep_valid(Role::B);
}

#[test]
fn timeout_aborts_only_before_lock() {
    let sid = [9u8; 32];
    let (proposal, propose) =
        Proposal::new(&mut OsRng, sid, Role::B, params(), address(5)).unwrap();
    let (mut z, z_actions) = accept(&mut OsRng, &propose, address(6)).unwrap();
    let Action::SendMessage(acc) = &z_actions[0] else {
        panic!()
    };
    let (mut b, _) = proposal.on_accept(&mut OsRng, acc).unwrap();
    b.handle(Event::Timeout).unwrap();
    z.handle(Event::Timeout).unwrap();
    assert!(b.is_final() && z.is_final());

    let mut sim = Sim::new(Faults::default());
    sim.mine(1);
    let before = (sim.b.state_name(), sim.z.state_name());
    sim.b.handle(Event::Timeout).unwrap();
    sim.z.handle(Event::Timeout).unwrap();
    assert_eq!(before, (sim.b.state_name(), sim.z.state_name()));
}
