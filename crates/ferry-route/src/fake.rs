//! A fake ferryd for tests: answers the control API from memory, enforces one swap at a time
//! like ferryd's `check_idle`, and records every start it receives.

use std::sync::{Arc, Mutex};

use crate::legs::{
    DaemonStatus, Ferryd, LegError, LegSwap, Role, StartError, StartSwap, SwapAmounts, SwapEntry,
    ROUTE_FEATURE,
};

#[derive(Default)]
struct State {
    status: DaemonStatus,
    address: Option<String>,
    swaps: Vec<LegSwap>,
    starts: Vec<StartSwap>,
    /// Every start is answered with this (no swap is created).
    refuse: Option<StartError>,
    /// The next start creates the swap but the answer is lost.
    lose_answer: bool,
    /// The next start never reaches the daemon.
    drop_start: bool,
    down: bool,
    next_id: u32,
}

#[derive(Clone)]
pub struct FakeFerryd(Arc<Mutex<State>>);

impl FakeFerryd {
    pub fn new(role: Role, pair: &str, name: &str) -> FakeFerryd {
        let (coin, network, evm, ticker, decimals) = match pair.split_once('-') {
            Some((token, chain)) => (token, chain, true, token.to_uppercase(), 6),
            None => (pair, "regtest", false, pair.to_uppercase(), 8),
        };
        FakeFerryd(Arc::new(Mutex::new(State {
            status: DaemonStatus {
                role,
                name: name.into(),
                coin: coin.into(),
                network: network.into(),
                evm,
                ticker,
                decimals,
                zec_network: "regtest".into(),
                zec_height: 1,
                spendable_zat: 0,
                features: vec![ROUTE_FEATURE.into()],
            },
            address: Some(format!("utest1{name}")),
            ..State::default()
        })))
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.0.lock().unwrap())
    }

    pub fn starts(&self) -> Vec<StartSwap> {
        self.with(|s| s.starts.clone())
    }

    pub fn swap_count(&self) -> usize {
        self.with(|s| s.swaps.len())
    }

    pub fn set_state(&self, id: &str, state: &str, outcome: Option<&str>) {
        self.with(|s| {
            let sw = s.swaps.iter_mut().find(|w| w.id == id).expect("swap");
            sw.state = state.into();
            sw.outcome = outcome.map(Into::into);
        })
    }

    pub fn push_timeline(&self, id: &str, e: SwapEntry) {
        self.with(|s| {
            let sw = s.swaps.iter_mut().find(|w| w.id == id).expect("swap");
            sw.timeline.push(e);
        })
    }

    pub fn set_zec(&self, height: u64, spendable: u64) {
        self.with(|s| {
            s.status.zec_height = height;
            s.status.spendable_zat = spendable;
        })
    }

    pub fn set_address(&self, a: Option<String>) {
        self.with(|s| s.address = a)
    }

    pub fn set_features(&self, f: Vec<String>) {
        self.with(|s| s.status.features = f)
    }

    pub fn set_down(&self, down: bool) {
        self.with(|s| s.down = down)
    }

    pub fn refuse_starts(&self, e: StartError) {
        self.with(|s| s.refuse = Some(e))
    }

    pub fn accept_starts(&self) {
        self.with(|s| s.refuse = None)
    }

    pub fn lose_next_answer(&self) {
        self.with(|s| s.lose_answer = true)
    }

    pub fn drop_next_start(&self) {
        self.with(|s| s.drop_start = true)
    }

    /// A swap carrying `label`, as if another process had started it.
    pub fn insert_swap(&self, label: &str, zec_zat: u64) {
        self.with(|s| {
            s.next_id += 1;
            let sw = LegSwap {
                id: format!("{:064x}", 0xf00 + s.next_id),
                role: s.status.role,
                state: "Negotiated".into(),
                amounts: SwapAmounts {
                    zec_zat,
                    btc_sat: 39_200_001,
                },
                route: Some(label.into()),
                ..LegSwap::default()
            };
            s.swaps.push(sw);
        })
    }
}

impl Ferryd for FakeFerryd {
    async fn status(&self) -> Result<DaemonStatus, LegError> {
        self.with(|s| {
            if s.down {
                return Err(LegError::Unreachable("connection refused".into()));
            }
            Ok(s.status.clone())
        })
    }

    async fn zec_address(&self) -> Result<Option<String>, LegError> {
        self.with(|s| {
            if s.down {
                return Err(LegError::Unreachable("connection refused".into()));
            }
            Ok(s.address.clone())
        })
    }

    async fn swaps(&self) -> Result<Vec<LegSwap>, LegError> {
        self.with(|s| {
            if s.down {
                return Err(LegError::Unreachable("connection refused".into()));
            }
            Ok(s.swaps.clone())
        })
    }

    async fn swap(&self, id: &str) -> Result<LegSwap, LegError> {
        self.with(|s| {
            if s.down {
                return Err(LegError::Unreachable("connection refused".into()));
            }
            s.swaps
                .iter()
                .find(|w| w.id == id)
                .cloned()
                .ok_or(LegError::Status(404, "no such swap".into()))
        })
    }

    async fn start(&self, req: &StartSwap) -> Result<String, StartError> {
        self.with(|s| {
            if s.down {
                return Err(StartError::Unknown("connection refused".into()));
            }
            if std::mem::take(&mut s.drop_start) {
                return Err(StartError::Unknown("connection reset".into()));
            }
            s.starts.push(req.clone());
            if let Some(e) = &s.refuse {
                return Err(e.clone());
            }
            // ferryd's check_idle (crates/ferryd/src/daemon.rs:466-473).
            if s.swaps
                .iter()
                .any(|w| w.outcome.is_none() && w.state != "Aborted")
            {
                return Err(StartError::Refused {
                    status: 409,
                    message: "A swap is already in progress".into(),
                });
            }
            s.next_id += 1;
            let id = format!("{:064x}", s.next_id);
            let counter = req.max_counter.or(req.min_counter).unwrap_or(1_000);
            s.swaps.push(LegSwap {
                id: id.clone(),
                role: s.status.role,
                counterparty: req.maker.clone(),
                state: "Negotiated".into(),
                outcome: None,
                amounts: SwapAmounts {
                    zec_zat: req.zec_zat,
                    btc_sat: counter,
                },
                timeline: vec![],
                watchtower: None,
                route: Some(req.route.clone()),
                sweep_to: req.sweep_to.clone(),
                payout_to: req.payout_to.clone(),
            });
            if std::mem::take(&mut s.lose_answer) {
                return Err(StartError::Unknown("timed out".into()));
            }
            Ok(id)
        })
    }
}
