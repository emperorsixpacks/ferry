//! BTC leg of a full swap against a real bitcoind (regtest), with a mock [`ZecLeg`].
//!
//! Needs `spikes/btc/scripts/regtest.sh start` (RPC 127.0.0.1:18543, ferry/ferry; override
//! with FERRY_BTC_RPC). Run: `cargo test -p ferry-core --test regtest -- --ignored --test-threads=1`

use std::collections::VecDeque;
use std::sync::Mutex;

use ferry_btc::bitcoin::{Address, Amount, Network, OutPoint, Txid};
use ferry_btc::rpc::BitcoinRpc;
use ferry_core::{
    accept, Action, BState, ChainEvent, Envelope, Event, Message, Proposal, Role, Spend, Swap,
    SwapParams, ZState, ZecLeg, ZecNote, ZecStatus,
};
use rand_core::{OsRng, RngCore};

fn params() -> SwapParams {
    SwapParams {
        network: Network::Regtest,
        btc_amount: 50_000_000,
        zec_amount: 1_000_000_000,
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

// ------------------------------------------------------------------ mock Zcash

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct MockError(String);

#[derive(Default)]
struct MockState {
    height: u32,
    /// (fvk, amount, height sent)
    notes: Vec<([u8; 96], u64, u32)>,
    /// (txid, fvk, ask)
    sweeps: Vec<(String, [u8; 96], [u8; 32])>,
}

/// In-memory Zcash: one block per BTC block. `sweep` only succeeds if `ask` really is the
/// spend authorizing key of the joint `ak` (`ask·SpendAuthG == ak`).
#[derive(Default)]
struct MockZec(Mutex<MockState>);

impl MockZec {
    fn mine(&self) {
        self.0.lock().unwrap().height += 1;
    }

    fn sweeps(&self) -> Vec<(String, [u8; 96], [u8; 32])> {
        self.0.lock().unwrap().sweeps.clone()
    }
}

impl ZecLeg for MockZec {
    type Error = MockError;

    async fn status(&self) -> Result<ZecStatus, MockError> {
        let s = self.0.lock().unwrap();
        Ok(ZecStatus {
            network: "regtest".into(),
            height: s.height.into(),
            shielded_balance: 0,
        })
    }

    fn joint_address(&self, fvk: &[u8; 96]) -> Result<String, MockError> {
        Ok(format!("uregtest-mock-{}", hex::encode(&fvk[..8])))
    }

    async fn send(&self, fvk: &[u8; 96], amount: u64) -> Result<String, MockError> {
        let mut s = self.0.lock().unwrap();
        let h = s.height;
        s.notes.push((*fvk, amount, h));
        Ok(format!("zsend-{}", s.notes.len()))
    }

    async fn watch(&self, fvk: &[u8; 96]) -> Result<Vec<ZecNote>, MockError> {
        let s = self.0.lock().unwrap();
        Ok(s.notes
            .iter()
            .enumerate()
            .filter(|(_, (f, ..))| f == fvk)
            .map(|(i, (_, value, h))| ZecNote {
                txid: format!("zsend-{}", i + 1),
                value: *value,
                confirmations: s.height - h,
                spent_by: s
                    .sweeps
                    .iter()
                    .find(|(_, f, _)| f == fvk)
                    .map(|(t, ..)| t.clone()),
            })
            .collect())
    }

    async fn sweep(
        &self,
        fvk: &[u8; 96],
        ask: &[u8; 32],
        _lock_value: u64,
    ) -> Result<String, MockError> {
        let scalar = ferry_dleq::pallas_scalar_from_bytes(ask)
            .ok_or(MockError("ask not canonical".into()))?;
        let ak = ferry_dleq::pallas_bytes(&(ferry_dleq::spend_auth_g() * scalar));
        if ak[..] != fvk[..32] {
            return Err(MockError("ask does not authorize the joint ak".into()));
        }
        let mut s = self.0.lock().unwrap();
        if !s.notes.iter().any(|(f, ..)| f == fvk) {
            return Err(MockError("nothing to sweep".into()));
        }
        let txid = format!("zsweep-{}", s.sweeps.len() + 1);
        s.sweeps.push((txid.clone(), *fvk, *ask));
        Ok(txid)
    }

    async fn confirmations(&self, txid: &str) -> Result<Option<u32>, MockError> {
        let s = self.0.lock().unwrap();
        Ok(s.sweeps.iter().any(|(t, ..)| t == txid).then_some(1))
    }
}

// ------------------------------------------------------------------ driver

#[derive(Default)]
struct Faults {
    script_path: bool,
    drop_redeem_adaptor: bool,
    b_offline_after_lock: bool,
}

struct World {
    rpc: BitcoinRpc,
    zec: MockZec,
    b: Swap,
    z: Swap,
    faults: Faults,
    queue: VecDeque<(Role, Event)>,
    sweep_txid: [Option<String>; 2],
    b_lock_broadcast: bool,
    miner: Address,
    log: Vec<String>,
}

fn idx(role: Role) -> usize {
    match role {
        Role::B => 0,
        Role::Z => 1,
    }
}

impl World {
    async fn new(faults: Faults) -> World {
        let url =
            std::env::var("FERRY_BTC_RPC").unwrap_or_else(|_| "http://127.0.0.1:18543".into());
        let rpc = BitcoinRpc::new(url, "ferry", "ferry").with_wallet("ferry-core-it");
        rpc.ensure_wallet()
            .await
            .expect("bitcoind up? (spikes/btc/scripts/regtest.sh start)");
        let miner = rpc.new_address(Network::Regtest).await.unwrap();
        if rpc.balance().await.unwrap() < Amount::from_btc(2.0).unwrap() {
            rpc.generate_to_address(101, &miner).await.unwrap();
        }
        let mut sid = [0u8; 32];
        OsRng.fill_bytes(&mut sid);

        // Z is the taker, B the maker.
        let z_payout = rpc.new_address(Network::Regtest).await.unwrap();
        let b_refund = rpc.new_address(Network::Regtest).await.unwrap();
        let p = SwapParams {
            keypath: !faults.script_path,
            ..params()
        };
        let (proposal, propose) = Proposal::new(&mut OsRng, sid, Role::Z, p, z_payout).unwrap();
        let (b, b_actions) = accept(&mut OsRng, &propose, b_refund).unwrap();
        let Action::SendMessage(acc) = &b_actions[0] else {
            panic!("expected Accept")
        };
        let (z, z_actions) = proposal.on_accept(&mut OsRng, acc).unwrap();

        let mut w = World {
            rpc,
            zec: MockZec::default(),
            b,
            z,
            faults,
            queue: VecDeque::new(),
            sweep_txid: [None, None],
            b_lock_broadcast: false,
            miner,
            log: vec![],
        };
        w.exec(Role::B, b_actions[1..].to_vec()).await;
        w.exec(Role::Z, z_actions).await;
        w.drain().await;
        w
    }

    fn swap(&mut self, role: Role) -> &mut Swap {
        match role {
            Role::B => &mut self.b,
            Role::Z => &mut self.z,
        }
    }

    fn deliver_to(&mut self, to: Role, env: Envelope) {
        self.queue.push_back((to, Event::Peer(env)));
    }

    async fn exec(&mut self, from: Role, actions: Vec<Action>) {
        for a in actions {
            match a {
                Action::SendMessage(env) => {
                    let drop = matches!(env.message, Message::RedeemAdaptor { .. })
                        && self.faults.drop_redeem_adaptor;
                    if !drop {
                        self.deliver_to(from.peer(), env);
                    }
                }
                Action::FundBtcLock { address, amount } => {
                    let funded = self.rpc.fund_lock(&address, amount).await.unwrap();
                    self.queue.push_back((
                        from,
                        Event::LockFunded {
                            tx: funded.tx,
                            vout: funded.vout,
                        },
                    ));
                }
                Action::BroadcastBtc(tx) => {
                    let txid = tx.compute_txid();
                    if from == Role::B && !self.b_lock_broadcast {
                        self.b_lock_broadcast = true;
                    }
                    match self.rpc.broadcast(&tx).await {
                        Ok(_) => self.log.push(format!("{from:?} broadcast {txid}")),
                        Err(e) => self
                            .log
                            .push(format!("{from:?} broadcast {txid} rejected: {e}")),
                    }
                }
                Action::SendZec { joint_fvk, amount } => {
                    self.zec.joint_address(&joint_fvk).unwrap();
                    self.zec.send(&joint_fvk, amount).await.unwrap();
                }
                Action::SweepZec { joint_fvk, ask } => {
                    let txid = self
                        .zec
                        .sweep(&joint_fvk, ask.expose(), 0)
                        .await
                        .expect("sweep with recovered ask");
                    self.sweep_txid[idx(from)] = Some(txid);
                }
            }
        }
    }

    fn offline(&self, role: Role) -> bool {
        role == Role::B && self.faults.b_offline_after_lock && self.b_lock_broadcast
    }

    async fn drain(&mut self) {
        while let Some((role, ev)) = self.queue.pop_front() {
            if self.offline(role) {
                continue;
            }
            let actions = self
                .swap(role)
                .handle(ev)
                .unwrap_or_else(|e| panic!("{role:?}: {e}"));
            self.exec(role, actions).await;
        }
    }

    async fn chain_events(&self, role: Role) -> Vec<ChainEvent> {
        let swap = match role {
            Role::B => &self.b,
            Role::Z => &self.z,
        };
        let mut out = vec![];
        let Some(lock) = swap.lock_outpoint() else {
            return out;
        };
        if let Some(confs) = self
            .rpc
            .confirmations(&lock.txid)
            .await
            .unwrap()
            .filter(|c| *c > 0)
        {
            let tx = self.rpc.raw_transaction(&lock.txid).await.unwrap().unwrap();
            out.push(ChainEvent::BtcLockConfirmed {
                confs,
                txout: tx.output[lock.vout as usize].clone(),
            });
        }
        for (_, txid) in swap.watch_txids() {
            if let Some(tx) = self.rpc.raw_transaction(&txid).await.unwrap() {
                let confs = self.rpc.confirmations(&txid).await.unwrap().unwrap_or(0);
                out.push(ChainEvent::BtcSpend { tx, confs });
            }
        }
        let fvk = swap.session().joint_fvk().unwrap();
        for note in self.zec.watch(&fvk).await.unwrap() {
            out.push(ChainEvent::ZecNoteSeen {
                value: note.value,
                confs: note.confirmations,
                spent: note.spent_by.is_some(),
            });
        }
        if let Some(txid) = &self.sweep_txid[idx(role)] {
            if let Some(confs) = self.zec.confirmations(txid).await.unwrap() {
                out.push(ChainEvent::ZecSwept { confs });
            }
        }
        out
    }

    async fn mine(&mut self) {
        self.rpc.generate_to_address(1, &self.miner).await.unwrap();
        self.zec.mine();
        for role in [Role::Z, Role::B] {
            for ev in self.chain_events(role).await {
                self.queue.push_back((role, Event::Chain(ev)));
            }
        }
        self.drain().await;
    }

    async fn mine_until(&mut self, max: u32, done: impl Fn(&World) -> bool) {
        for _ in 0..max {
            if done(self) {
                return;
            }
            self.mine().await;
        }
        assert!(
            done(self),
            "B {} / Z {}\n{}",
            self.b.state_name(),
            self.z.state_name(),
            self.log.join("\n")
        );
    }

    fn b_state(&self) -> BState {
        let Swap::B(b) = &self.b else { unreachable!() };
        b.state.clone()
    }

    fn z_state(&self) -> ZState {
        let Swap::Z(z) = &self.z else { unreachable!() };
        z.state.clone()
    }

    fn txid(&self, spend: Spend) -> Txid {
        self.z
            .watch_txids()
            .into_iter()
            .find(|(s, _)| *s == spend)
            .unwrap()
            .1
    }

    async fn confs(&self, spend: Spend) -> Option<u32> {
        self.rpc.confirmations(&self.txid(spend)).await.unwrap()
    }

    fn lock(&self) -> OutPoint {
        self.b.lock_outpoint().unwrap()
    }
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn regtest_happy_path() {
    happy(Faults::default(), 1).await;
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn regtest_happy_path_script_path() {
    happy(
        Faults {
            script_path: true,
            ..Default::default()
        },
        4,
    )
    .await;
}

/// `witness_items`: 1 for the MuSig2 key path, 4 (two signatures, leaf, control block) for the
/// script path.
async fn happy(faults: Faults, witness_items: usize) {
    let mut w = World::new(faults).await;
    assert_eq!(w.b_state(), BState::CancelSigned);
    w.mine_until(10, |w| {
        w.b_state() == BState::ZecSwept && w.z_state() == ZState::BtcRedeemed
    })
    .await;

    let redeem = w
        .rpc
        .raw_transaction(&w.txid(Spend::Redeem))
        .await
        .unwrap()
        .expect("redeem on chain");
    assert!(w.confs(Spend::Redeem).await.unwrap() >= 1);
    assert_eq!(redeem.input[0].previous_output, w.lock());
    assert_eq!(redeem.input[0].witness.len(), witness_items);
    assert_eq!(
        redeem.output[0].value,
        Amount::from_sat(params().btc_amount - params().btc_fee)
    );
    assert_eq!(w.confs(Spend::Cancel).await, None);
    let sweeps = w.zec.sweeps();
    assert_eq!(
        sweeps.len(),
        1,
        "B swept once with the ask recovered from the redeem witness"
    );
    println!("{}", w.log.join("\n"));
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn regtest_refund_path() {
    // ZEC gets locked but B's redeem adaptor never reaches Z: cancel at T1, refund, and Z
    // sweeps its ZEC back with the b extracted from the refund witness.
    let mut w = World::new(Faults {
        drop_redeem_adaptor: true,
        ..Default::default()
    })
    .await;
    w.mine_until(40, |w| {
        w.b_state() == BState::Refunded && w.z_state() == ZState::ZecReclaimed
    })
    .await;

    assert!(w.confs(Spend::Cancel).await.unwrap() >= 1);
    assert!(w.confs(Spend::Refund).await.unwrap() >= 1);
    assert_eq!(w.confs(Spend::Redeem).await, None);
    let refund = w
        .rpc
        .raw_transaction(&w.txid(Spend::Refund))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        refund.output[0].value,
        Amount::from_sat(params().btc_amount - 2 * params().btc_fee)
    );
    assert_eq!(
        w.zec.sweeps().len(),
        1,
        "Z reclaimed with the recovered ask"
    );
    println!("{}", w.log.join("\n"));
}

#[tokio::test]
#[ignore = "needs regtest bitcoind (spikes/btc/scripts/regtest.sh start)"]
async fn regtest_punish_path() {
    let mut w = World::new(Faults {
        b_offline_after_lock: true,
        ..Default::default()
    })
    .await;
    w.mine_until(60, |w| w.z_state() == ZState::Punished).await;

    assert!(w.confs(Spend::Punish).await.unwrap() >= 1);
    assert_eq!(w.confs(Spend::Refund).await, None);
    assert!(w.zec.sweeps().is_empty());
    println!("{}", w.log.join("\n"));
}
