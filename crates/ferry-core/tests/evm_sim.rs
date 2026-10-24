//! Both EVM state machines against a simulated FerryLock and Zcash chain. The simulated
//! contract applies FerryLock's rules (windows, the EIP-712 ready signature, the scalar
//! commitments), and every action is checked against them, so a machine that sends a claim or
//! refund the contract would refuse (publishing its scalar for nothing) fails the test.

use std::collections::VecDeque;

use ferry_core::evm::{
    evm_accept, EvmAction, EvmBState, EvmChainEvent, EvmEvent, EvmObservation, EvmParams,
    EvmProposal, EvmSwap, EvmZState, LockTerms, ObservedLock, ANVIL_CHAIN_ID,
};
use ferry_core::Role;
use ferry_dleq::pasta_curves::group::GroupEncoding;
use ferry_evm::{Address, PrivateKeySigner, B256};
use rand_core::OsRng;

const T1: u64 = 10_000;
const T2: u64 = 20_000;
const START: u64 = 1_000;
const BLOCK_SECS: u64 = 10;

fn params() -> EvmParams {
    EvmParams {
        chain_id: ANVIL_CHAIN_ID,
        contract: [0x11; 20],
        token: [0x22; 20],
        token_amount: 250_000_000,
        token_symbol: "USDC".into(),
        token_decimals: 6,
        zec_amount: 500_000_000,
        t1: T1,
        t2: T2,
        claim_margin: 600,
        refund_margin: 600,
        lock_confirmations: 2,
        zec_confirmations: 3,
        max_tip: 0,
    }
}

#[derive(Default)]
struct Faults {
    /// Z processes nothing (and sends nothing) from this block time on.
    z_offline_from: Option<u64>,
    /// B processes nothing from this block time on.
    b_offline_from: Option<u64>,
    /// Z's wallet never actually sends the ZEC.
    z_never_sends_zec: bool,
    /// Z's wallet refuses to send (and says so).
    z_wallet_refuses: bool,
    /// B locks with a different bAddr than agreed.
    b_locks_wrong_b_addr: bool,
    /// The ready signature reaches Z only at this block time.
    delay_ready_until: Option<u64>,
}

#[derive(Default)]
struct Contract {
    lock: Option<(LockTerms, u64)>,
    claimed: Option<([u8; 32], u64)>,
    refunded: Option<([u8; 32], u64)>,
    punished: Option<u64>,
    /// Calls the contract refused: each would have published its calldata for nothing.
    reverted: Vec<String>,
}

struct Sim {
    b: EvmSwap,
    z: EvmSwap,
    b_key: PrivateKeySigner,
    faults: Faults,
    now: u64,
    block: u64,
    contract: Contract,
    to_b: VecDeque<EvmEvent>,
    to_z: VecDeque<EvmEvent>,
    held_ready: Option<EvmEvent>,
    zec_note: Option<(u64, u64)>,
    zec_block: u64,
    /// (role, ask valid for the joint ak)
    sweeps: Vec<(Role, bool)>,
    rejected: Vec<String>,
}

fn addr20(a: Address) -> [u8; 20] {
    a.0 .0
}

impl Sim {
    fn new(faults: Faults) -> Sim {
        Sim::with_params(faults, params())
    }

    fn with_params(faults: Faults, params: EvmParams) -> Sim {
        let b_key = PrivateKeySigner::random();
        let z_addr = addr20(PrivateKeySigner::random().address());
        // Z is the taker, B the maker (as in the demo UI).
        let sid = [7u8; 32];
        let (proposal, propose) =
            EvmProposal::new(&mut OsRng, sid, Role::Z, params, z_addr).unwrap();
        let (b, b_actions) = evm_accept(&mut OsRng, &propose, addr20(b_key.address())).unwrap();
        let EvmAction::SendMessage(accept) = &b_actions[0] else {
            panic!("expected Accept")
        };
        let (z, z_actions) = proposal.on_accept(&mut OsRng, accept).unwrap();
        let mut sim = Sim {
            b,
            z,
            b_key,
            faults,
            now: START,
            block: 1,
            contract: Contract::default(),
            to_b: VecDeque::new(),
            to_z: VecDeque::new(),
            held_ready: None,
            zec_note: None,
            zec_block: 1,
            sweeps: vec![],
            rejected: vec![],
        };
        sim.exec(Role::B, b_actions[1..].to_vec());
        sim.exec(Role::Z, z_actions);
        sim
    }

    fn offline(&self, role: Role) -> bool {
        let from = match role {
            Role::B => self.faults.b_offline_from,
            Role::Z => self.faults.z_offline_from,
        };
        from.is_some_and(|t| self.now >= t)
    }

    fn swap(&mut self, role: Role) -> &mut EvmSwap {
        match role {
            Role::B => &mut self.b,
            Role::Z => &mut self.z,
        }
    }

    fn confs(&self, at: u64) -> u32 {
        (self.block - at + 1) as u32
    }

    /// Only what is mined by the current block (a call made this block lands in the next).
    fn observation(&self) -> EvmObservation {
        let mined = |at: u64| at <= self.block;
        EvmObservation {
            now: self.now,
            lock: self
                .contract
                .lock
                .as_ref()
                .filter(|(_, at)| mined(*at))
                .map(|(terms, at)| ObservedLock {
                    terms: terms.clone(),
                    confs: self.confs(*at),
                }),
            claimed: self
                .contract
                .claimed
                .filter(|(_, at)| mined(*at))
                .map(|(z, at)| (z, self.confs(at))),
            refunded: self
                .contract
                .refunded
                .filter(|(_, at)| mined(*at))
                .map(|(b, at)| (b, self.confs(at))),
            punished: self
                .contract
                .punished
                .filter(|at| mined(*at))
                .map(|at| self.confs(at)),
        }
    }

    fn open(&self) -> bool {
        self.contract.lock.is_some()
            && self.contract.claimed.is_none()
            && self.contract.refunded.is_none()
            && self.contract.punished.is_none()
    }

    fn revert(&mut self, what: String) {
        self.contract.reverted.push(what);
    }

    fn exec(&mut self, role: Role, actions: Vec<EvmAction>) {
        for a in actions {
            match a {
                EvmAction::SendMessage(env) => {
                    let ev = EvmEvent::Peer(env);
                    match role {
                        Role::B => {
                            if self.faults.delay_ready_until.is_some() {
                                self.held_ready = Some(ev);
                            } else {
                                self.to_z.push_back(ev);
                            }
                        }
                        Role::Z => self.to_b.push_back(ev),
                    }
                }
                EvmAction::Lock { salt, mut terms } => {
                    assert_eq!(role, Role::B);
                    if self.faults.b_locks_wrong_b_addr {
                        terms.b_addr = [0x99; 20];
                    }
                    let id = ferry_evm::swap_id(self.b_key.address(), B256::from(salt));
                    assert_eq!(id.0, self.b.session().swap_id());
                    if self.now < terms.t1 && self.contract.lock.is_none() {
                        self.contract.lock = Some((terms, self.block + 1));
                    } else {
                        self.revert("lock".into());
                    }
                }
                EvmAction::SignReady { digest } => {
                    let sig = ferry_evm::sign_ready_digest(&self.b_key, &B256::from(digest));
                    self.to_b.push_back(EvmEvent::ReadySigned { sig });
                }
                EvmAction::Claim {
                    z,
                    ready_sig,
                    not_after,
                    ..
                } => {
                    assert_eq!(role, Role::Z);
                    assert!(self.now < not_after, "claim sent after t1 − Δ");
                    let (terms, _) = self.contract.lock.clone().expect("lock");
                    let digest = B256::from(self.b.session().ready_digest());
                    let ok = self.open()
                        && self.now < terms.t1
                        && ferry_evm::ready_signer(&digest, &ready_sig)
                            == Some(Address::from(terms.refunder))
                        && ferry_evm::scalar_address(z.expose())
                            == Some(Address::from(terms.z_addr));
                    if ok {
                        self.contract.claimed = Some((*z.expose(), self.block + 1));
                    } else {
                        self.revert("claim".into());
                    }
                }
                EvmAction::Refund {
                    b,
                    not_before,
                    not_after,
                    ..
                } => {
                    assert_eq!(role, Role::B);
                    assert!(
                        self.now >= not_before && self.now < not_after,
                        "refund outside [t1, t2 − Δ)"
                    );
                    let (terms, _) = self.contract.lock.clone().expect("lock");
                    let ok = self.open()
                        && self.now >= terms.t1
                        && self.now < terms.t2
                        && ferry_evm::scalar_address(b.expose())
                            == Some(Address::from(terms.b_addr));
                    if ok {
                        self.contract.refunded = Some((*b.expose(), self.block + 1));
                    } else {
                        self.revert("refund".into());
                    }
                }
                EvmAction::Punish { .. } => {
                    let t2 = self.contract.lock.as_ref().map(|(t, _)| t.t2).unwrap();
                    if self.open() && self.now >= t2 {
                        self.contract.punished = Some(self.block + 1);
                    } else {
                        self.revert("punish".into());
                    }
                }
                EvmAction::SendZec { amount, .. } => {
                    assert_eq!(role, Role::Z);
                    if self.faults.z_wallet_refuses {
                        self.to_z.push_back(EvmEvent::ZecLockRefused);
                    } else if !self.faults.z_never_sends_zec {
                        self.zec_note = Some((amount, self.zec_block + 1));
                    }
                }
                EvmAction::SweepZec { joint_fvk, ask } => {
                    let ask = ferry_dleq::pallas_scalar_from_bytes(ask.expose()).unwrap();
                    let ak = (ferry_dleq::spend_auth_g() * ask).to_bytes();
                    self.sweeps.push((role, ak[..] == joint_fvk[..32]));
                    // Mined in the next ZEC block; reported as swept from then on.
                }
            }
        }
    }

    fn deliver(&mut self, role: Role, ev: EvmEvent) {
        if self.offline(role) {
            return;
        }
        match self.swap(role).handle(ev) {
            Ok(actions) => self.exec(role, actions),
            Err(e) => self.rejected.push(format!("{role:?}: {e}")),
        }
    }

    /// One EVM block (and every few, a ZEC block), then both parties observe.
    fn step(&mut self) {
        self.now += BLOCK_SECS;
        self.block += 1;
        if self.block.is_multiple_of(3) {
            self.zec_block += 1;
        }
        if let Some(t) = self.faults.delay_ready_until {
            if self.now >= t {
                if let Some(ev) = self.held_ready.take() {
                    self.to_z.push_back(ev);
                }
            }
        }
        for role in [Role::B, Role::Z] {
            let obs = self.observation();
            self.deliver(role, EvmEvent::Chain(EvmChainEvent::Observed(obs)));
            if let Some((value, at)) = self.zec_note {
                if self.zec_block >= at {
                    let confs = (self.zec_block - at + 1) as u32;
                    self.deliver(
                        role,
                        EvmEvent::Chain(EvmChainEvent::ZecNoteSeen { value, confs }),
                    );
                }
            }
            if self.zec_note.is_some() && self.sweeps.iter().any(|(r, _)| *r == role) {
                self.deliver(role, EvmEvent::Chain(EvmChainEvent::ZecSwept { confs: 1 }));
            }
        }
        while let Some(ev) = self.to_b.pop_front() {
            self.deliver(Role::B, ev);
        }
        while let Some(ev) = self.to_z.pop_front() {
            self.deliver(Role::Z, ev);
        }
    }

    fn run_until(&mut self, limit: u64, done: impl Fn(&Sim) -> bool) {
        while !done(self) {
            assert!(
                self.now < limit,
                "timed out: B {} Z {} rejected {:?}",
                self.b.state_name(),
                self.z.state_name(),
                self.rejected
            );
            self.step();
        }
    }

    fn b_state(&self) -> EvmBState {
        match &self.b {
            EvmSwap::B(b) => b.state.clone(),
            _ => unreachable!(),
        }
    }

    fn z_state(&self) -> EvmZState {
        match &self.z {
            EvmSwap::Z(z) => z.state.clone(),
            _ => unreachable!(),
        }
    }

    fn assert_clean(&self) {
        assert!(
            self.contract.reverted.is_empty(),
            "calls the contract refused: {:?}",
            self.contract.reverted
        );
    }
}

#[test]
fn happy_path() {
    let mut sim = Sim::new(Faults::default());
    sim.run_until(T2, |s| s.b_state() == EvmBState::ZecSwept);
    assert_eq!(sim.z_state(), EvmZState::Claimed);
    assert!(sim.contract.claimed.is_some());
    // B swept with a valid joint ask (z from the claim + b).
    assert_eq!(sim.sweeps, vec![(Role::B, true)]);
    assert!(sim.now < T1, "finished before t1");
    sim.assert_clean();
    assert!(sim.rejected.is_empty(), "{:?}", sim.rejected);
}

#[test]
fn refund_when_z_goes_quiet_after_locking_zec() {
    // Z stops right after locking ZEC (before B's ready signature arrives); it is back after
    // t1, sees B's refund, extracts b and reclaims.
    let mut sim = Sim::new(Faults {
        z_offline_from: Some(START + 25),
        ..Faults::default()
    });
    sim.run_until(T1 - 1, |s| s.b_state() == EvmBState::ReadySent);
    sim.run_until(T1 + 200, |s| s.b_state() == EvmBState::Refunded);
    assert!(sim.contract.claimed.is_none());
    sim.faults.z_offline_from = None;
    sim.run_until(T2, |s| s.z_state() == EvmZState::ZecReclaimed);
    assert_eq!(sim.sweeps, vec![(Role::Z, true)]);
    sim.assert_clean();
}

#[test]
fn refund_when_z_never_locks() {
    let mut sim = Sim::new(Faults {
        z_never_sends_zec: true,
        ..Faults::default()
    });
    sim.run_until(T1 + 100, |s| s.b_state() == EvmBState::Refunded);
    // Z thought it locked, so it reclaims (the sweep finds nothing in reality; the daemon
    // settles that with ZecLockLapsed).
    sim.run_until(T1 + 200, |s| s.z_state() == EvmZState::ZecReclaiming);
    sim.deliver(Role::Z, EvmEvent::ZecLockLapsed);
    assert_eq!(sim.z_state(), EvmZState::Refunded);
    sim.assert_clean();
}

#[test]
fn refused_zec_lock_waits_for_refund() {
    let mut sim = Sim::new(Faults {
        z_wallet_refuses: true,
        ..Faults::default()
    });
    sim.run_until(T1 - 1, |s| s.z_state() == EvmZState::ZecLockRefused);
    sim.run_until(T2, |s| {
        s.b_state() == EvmBState::Refunded && s.z_state() == EvmZState::Refunded
    });
    assert!(sim.sweeps.is_empty());
    sim.assert_clean();
}

#[test]
fn punish_when_b_vanishes_after_locking() {
    let mut sim = Sim::new(Faults {
        b_offline_from: Some(START + 30),
        ..Faults::default()
    });
    sim.run_until(T2 + 100, |s| s.z_state() == EvmZState::Punished);
    assert!(sim.contract.punished.is_some());
    assert!(sim.contract.refunded.is_none());
    // Z's ZEC stays in the joint note: B's penalty.
    assert!(sim.zec_note.is_some() && sim.sweeps.is_empty());
    sim.assert_clean();
}

#[test]
fn late_ready_signature_is_not_used_near_t1() {
    // The ready signature reaches Z only after t1 − Δ: Z must not claim, B refunds.
    let mut sim = Sim::new(Faults {
        delay_ready_until: Some(T1 - 300),
        ..Faults::default()
    });
    sim.run_until(T2, |s| {
        s.b_state() == EvmBState::Refunded && s.z_state() == EvmZState::ZecReclaimed
    });
    assert!(sim.contract.claimed.is_none());
    sim.assert_clean();
}

#[test]
fn wrong_lock_terms_never_get_zec() {
    let mut sim = Sim::new(Faults {
        b_locks_wrong_b_addr: true,
        ..Faults::default()
    });
    for _ in 0..50 {
        sim.step();
    }
    assert!(sim.zec_note.is_none(), "Z locked ZEC under the wrong bAddr");
    assert_eq!(sim.z_state(), EvmZState::Negotiated);
    assert!(sim.rejected.iter().any(|r| r.contains("does not match")));
}

/// WETH: 18 decimals, at the per-swap cap (u64::MAX wei, about 18.44 WETH) with a tip cap.
/// The machines do no arithmetic on token amounts: the amount travels through negotiation
/// (JSON and the transcript), the lock terms and Z's check of the on-chain lock unchanged.
#[test]
fn weth_at_the_swap_cap() {
    let p = EvmParams {
        token: [0x33; 20],
        token_amount: u64::MAX,
        token_symbol: "WETH".into(),
        token_decimals: 18,
        max_tip: 10_000_000_000_000_000, // 0.01 WETH
        ..params()
    };
    let mut sim = Sim::with_params(Faults::default(), p.clone());
    let terms = sim.z.session().lock_terms().unwrap();
    assert_eq!((terms.amount, terms.max_tip), (u64::MAX, p.max_tip));
    assert_eq!(sim.b.session().lock_terms().unwrap(), terms);
    sim.run_until(T2, |s| s.b_state() == EvmBState::ZecSwept);
    assert_eq!(sim.z_state(), EvmZState::Claimed);
    assert_eq!(sim.contract.lock.as_ref().unwrap().0.amount, u64::MAX);
    sim.assert_clean();
    assert!(sim.rejected.is_empty(), "{:?}", sim.rejected);
    let back: EvmSwap = serde_json::from_str(&serde_json::to_string(&sim.z).unwrap()).unwrap();
    assert_eq!(back.session().params, p);
}

#[test]
fn messages_and_state_roundtrip_json() {
    let sim = Sim::new(Faults::default());
    for swap in [&sim.b, &sim.z] {
        let json = serde_json::to_string(swap).unwrap();
        let back: EvmSwap = serde_json::from_str(&json).unwrap();
        assert_eq!(back.state_name(), swap.state_name());
        assert_eq!(back.session().swap_id(), swap.session().swap_id());
        assert_eq!(
            back.session().joint_fvk().unwrap(),
            swap.session().joint_fvk().unwrap()
        );
    }
}
