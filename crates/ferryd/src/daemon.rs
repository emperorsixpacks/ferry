//! One party's swaps: negotiation, the peer exchange, the chain driver and narration.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::str::FromStr;
use std::sync::Arc;

use ferry_btc::bitcoin::{Address, Amount, Network, Transaction, Txid};
use ferry_btc::rpc::{BitcoinRpc, RpcError};
use ferry_core::{
    accept, ChainEvent, Envelope, Event, Message, Proposal, Role, Spend, Swap, ZecLeg,
};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Mutex};

use crate::config::{Cli, Delivery, Offer, ProposeRequest, Terms};
use crate::record::{fvk_from_hex, Pending, Store, SwapRecord};
use crate::view::{self, StatusView};

/// An HTTP-facing error: status code and message.
#[derive(Debug)]
pub struct ApiError(pub u16, pub String);

impl ApiError {
    fn bad(msg: impl Into<String>) -> Self {
        ApiError(400, msg.into())
    }
    fn not_found() -> Self {
        ApiError(404, "no such swap".into())
    }
    fn conflict(msg: impl Into<String>) -> Self {
        ApiError(409, msg.into())
    }
    fn upstream(msg: impl Into<String>) -> Self {
        ApiError(502, msg.into())
    }
}

/// A server-sent event: `event: <name>` with a JSON body.
#[derive(Clone, Debug)]
pub struct SseEvent {
    pub event: &'static str,
    pub data: String,
}

#[derive(Default)]
pub struct State {
    pub swaps: BTreeMap<String, SwapRecord>,
    pub status: Option<StatusView>,
    published: HashMap<String, String>,
}

pub struct Daemon<L> {
    pub cli: Cli,
    pub role: Role,
    pub offer: Offer,
    rpc: BitcoinRpc,
    pub leg: L,
    http: reqwest::Client,
    store: Store,
    pub state: Mutex<State>,
    pub events: broadcast::Sender<SseEvent>,
    /// Bearer token required on /api/*.
    pub api_token: String,
}

/// A failed action that should be retried on the next tick.
struct Retry;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn peer_name(role: Role) -> &'static str {
    role.peer().as_str()
}

fn btc_str(sat: u64) -> String {
    let s = format!("{:.8}", Amount::from_sat(sat).to_btc());
    format!("{} BTC", s.trim_end_matches('0').trim_end_matches('.'))
}

/// Rescan window when importing a swap's addresses (recent blocks are kept even when pruned).
const WATCH_RESCAN_SECS: u64 = 2 * 24 * 3600;

/// Have the watch-only wallet track the lock and cancel outputs, and so every swap transaction.
async fn watch_swap(rpc: &BitcoinRpc, rec: &SwapRecord) -> Result<(), RpcError> {
    let session = rec.swap.session();
    let scripts = session.scripts();
    for out in [&scripts.lock, &scripts.cancel_out] {
        rpc.watch_address(&out.address(session.params.network), WATCH_RESCAN_SECS)
            .await?;
    }
    Ok(())
}

fn zec_str(zat: u64) -> String {
    format!("{:.2} ZEC", zat as f64 / 1e8)
}

impl<L: ZecLeg + 'static> Daemon<L> {
    pub async fn new(cli: Cli, leg: L) -> anyhow::Result<Arc<Self>> {
        let wallet = cli.btc_wallet.clone().unwrap_or_else(|| cli.name.clone());
        let watch = cli
            .btc_watch_wallet
            .clone()
            .unwrap_or_else(|| format!("{wallet}-watch"));
        let rpc = BitcoinRpc::new(&cli.btc_rpc, &cli.btc_rpc_user, &cli.btc_rpc_pass)
            .with_wallet(wallet)
            .with_watch_wallet(watch);
        rpc.ensure_wallet().await?;
        rpc.ensure_watch_wallet().await?;
        let store = Store::open(&cli.data_dir)?;
        // Keep the token across restarts, so a running UI proxy stays authorized.
        let token_file = cli.data_dir.join("api-token");
        let existing = std::fs::read_to_string(&token_file)
            .ok()
            .map(|t| t.trim().to_string());
        let api_token = cli
            .api_token
            .clone()
            .or(existing.filter(|t| !t.is_empty()))
            .unwrap_or_else(|| {
                let mut b = [0u8; 32];
                OsRng.fill_bytes(&mut b);
                hex::encode(b)
            });
        crate::record::write_private(&token_file, api_token.as_bytes())?;
        let mut state = State::default();
        for rec in store.load_all()? {
            tracing::info!(id = %rec.id, state = %rec.state(), "resuming swap");
            if !rec.settled() {
                watch_swap(&rpc, &rec).await?;
            }
            state.swaps.insert(rec.id.clone(), rec);
        }
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Daemon {
            role: cli.role.into(),
            offer: cli.offer(),
            cli,
            rpc,
            leg,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()?,
            store,
            state: Mutex::new(state),
            events,
            api_token,
        }))
    }

    fn network(&self) -> Network {
        self.cli.network
    }

    fn save(&self, rec: &SwapRecord) {
        if let Err(e) = self.store.save(rec) {
            tracing::error!(id = %rec.id, "persisting swap: {e}");
        }
    }

    // ------------------------------------------------------------------ views & events

    pub async fn status_view(&self) -> anyhow::Result<StatusView> {
        let zec = self.leg.status().await?;
        Ok(StatusView {
            role: self.role,
            name: self.cli.name.clone(),
            balances: view::Balances {
                zec_shielded_zat: zec.shielded_balance,
                btc_sat: self.rpc.balance().await?.to_sat(),
            },
            chains: view::Chains {
                btc: view::BtcChain {
                    network: self.network().to_string(),
                    height: self.rpc.block_count().await?,
                },
                zec: view::ZecChain {
                    network: zec.network,
                    height: zec.height,
                    pool: "ironwood".into(),
                },
            },
            offer: view::OfferView {
                pair: "ZEC/BTC".into(),
                rate_sat_per_zec: self.offer.rate_sat_per_zec,
                min_zat: self.offer.min_zat,
                max_zat: self.offer.max_zat,
            },
        })
    }

    async fn refresh_status(&self) {
        match self.status_view().await {
            Ok(status) => {
                let mut st = self.state.lock().await;
                if st.status.as_ref() != Some(&status) {
                    let data = serde_json::to_string(&status).expect("status serializes");
                    st.status = Some(status);
                    let _ = self.events.send(SseEvent {
                        event: "status",
                        data,
                    });
                }
            }
            Err(e) => tracing::warn!("status: {e}"),
        }
    }

    /// Push `event: swap` for every swap whose view changed.
    fn publish(&self, st: &mut State) {
        for rec in st.swaps.values() {
            let data = serde_json::to_string(&view::swap_view(rec)).expect("view serializes");
            if st.published.get(&rec.id) != Some(&data) {
                st.published.insert(rec.id.clone(), data.clone());
                let _ = self.events.send(SseEvent {
                    event: "swap",
                    data,
                });
            }
        }
    }

    // ------------------------------------------------------------------ negotiation

    /// Taker: propose a swap to `maker`.
    pub async fn create_swap(&self, maker: String, zec_zat: u64) -> Result<String, ApiError> {
        let maker = maker.trim_end_matches('/').to_string();
        if maker.is_empty() {
            return Err(ApiError::bad("maker URL is required"));
        }
        self.check_idle().await?;
        let offer: Offer = self
            .http
            .get(format!("{maker}/peer/offer"))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| ApiError::upstream(format!("maker unreachable: {e}")))?
            .json()
            .await
            .map_err(|e| ApiError::upstream(format!("maker offer: {e}")))?;
        if !offer.making {
            return Err(ApiError::bad("the counterparty is not making offers"));
        }
        if offer.role == self.role {
            return Err(ApiError::bad(format!(
                "the counterparty also has role {}",
                self.role.as_str()
            )));
        }
        if offer.network != self.network() {
            return Err(ApiError::bad(format!(
                "the counterparty runs on {}",
                offer.network
            )));
        }
        if zec_zat < offer.min_zat || zec_zat > offer.max_zat {
            return Err(ApiError::bad(format!(
                "Amount must be between {} and {}",
                zec_str(offer.min_zat),
                zec_str(offer.max_zat)
            )));
        }
        let params = offer
            .terms
            .params(self.network(), zec_zat, offer.btc_for(zec_zat));
        params
            .validate()
            .map_err(|e| ApiError::bad(e.to_string()))?;
        self.check_funds(&params).await?;
        let address = self
            .rpc
            .new_address(self.network())
            .await
            .map_err(|e| ApiError(500, e.to_string()))?;

        let mut sid = [0u8; 32];
        OsRng.fill_bytes(&mut sid);
        let (proposal, propose) =
            Proposal::new(&mut OsRng, sid, self.role, params.clone(), address)
                .map_err(|e| ApiError::bad(e.to_string()))?;
        let resp = self
            .http
            .post(format!("{maker}/peer/swaps"))
            .json(&ProposeRequest {
                envelope: propose,
                taker_url: self.cli.public_url(),
            })
            .send()
            .await
            .map_err(|e| ApiError::upstream(format!("maker unreachable: {e}")))?;
        if !resp.status().is_success() {
            let code = if resp.status().is_client_error() {
                400
            } else {
                502
            };
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let msg = body["error"]
                .as_str()
                .unwrap_or("proposal refused")
                .to_string();
            return Err(ApiError(code, format!("The maker refused: {msg}")));
        }
        let accept_env: Envelope = resp
            .json()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let (swap, actions) = proposal
            .on_accept(&mut OsRng, &accept_env)
            .map_err(|e| ApiError::upstream(format!("maker's Accept rejected: {e}")))?;

        let id = hex::encode(sid);
        let mut rec = self.new_record(id.clone(), swap, maker, true)?;
        watch_swap(&self.rpc, &rec)
            .await
            .map_err(|e| ApiError(500, format!("watching the swap outputs: {e}")))?;
        rec.peer_seen = 1; // the maker's outbox starts with the Accept we just processed
        let p = peer_name(self.role);
        rec.log(
            "peer",
            "propose_sent",
            format!("Sent Propose to {p}: amounts, T1/T2, Pallas and secp256k1 points, DLEQ proof"),
            None,
        );
        rec.log(
            "local",
            "dleq_verified",
            format!(
                "Verified {p}'s DLEQ proof: {p}_p and {p}_s share one discrete log. Derived the joint Ironwood address"
            ),
            None,
        );
        rec.pending.extend(actions.into_iter().map(Pending::from));

        let mut st = self.state.lock().await;
        self.drive_pending(&mut rec).await;
        self.save(&rec);
        st.swaps.insert(id.clone(), rec);
        self.publish(&mut st);
        Ok(id)
    }

    /// Where the operator funds this party: a fresh address of our BTC wallet and, if the Zcash
    /// backend has one, our own Zcash address.
    pub async fn funding_addresses(&self) -> Result<serde_json::Value, ApiError> {
        let btc = self
            .rpc
            .labeled_address("ferry-funding", self.network())
            .await
            .map_err(|e| ApiError(503, e.to_string()))?;
        Ok(serde_json::json!({
            "role": self.role,
            "name": self.cli.name,
            "btc": { "network": self.network().to_string(), "address": btc.to_string() },
            "zec": { "address": self.leg.receive_address() },
        }))
    }

    /// One swap at a time: funds and the demo UI both assume it.
    async fn check_idle(&self) -> Result<(), ApiError> {
        let st = self.state.lock().await;
        if st.swaps.values().any(|r| !r.swap.is_final()) {
            return Err(ApiError::conflict("A swap is already in progress"));
        }
        Ok(())
    }

    /// Whether our wallet can fund our side of `params`.
    async fn check_funds(&self, params: &ferry_core::SwapParams) -> Result<(), ApiError> {
        match self.role {
            Role::Z => {
                let have = self
                    .leg
                    .status()
                    .await
                    .map_err(|e| ApiError(503, e.to_string()))?
                    .shielded_balance;
                if have < params.zec_amount {
                    return Err(ApiError::bad("Z does not have enough shielded ZEC"));
                }
            }
            Role::B => {
                let have = self
                    .rpc
                    .balance()
                    .await
                    .map_err(|e| ApiError(503, e.to_string()))?
                    .to_sat();
                // The lock pays its own (wallet-chosen) fee on top of the amount.
                if have < params.btc_amount + 10_000 {
                    return Err(ApiError::bad("B does not have enough BTC"));
                }
            }
        }
        Ok(())
    }

    fn new_record(
        &self,
        id: String,
        swap: Swap,
        counterparty: String,
        taker: bool,
    ) -> Result<SwapRecord, ApiError> {
        let fvk = swap
            .session()
            .joint_fvk()
            .map_err(|e| ApiError(500, e.to_string()))?;
        let joint = self
            .leg
            .joint_address(&fvk)
            .map_err(|e| ApiError(500, e.to_string()))?;
        Ok(SwapRecord::new(id, swap, counterparty, taker, joint))
    }

    /// Maker: handle a `Propose`. Idempotent per session id.
    pub async fn accept_proposal(&self, req: ProposeRequest) -> Result<Envelope, ApiError> {
        if !self.offer.making {
            return Err(ApiError(403, "not making offers".into()));
        }
        let env = req.envelope;
        let Message::Propose { params, setup } = &env.message else {
            return Err(ApiError::bad("expected a Propose message"));
        };
        let id = hex::encode(env.session_id);
        let mut st = self.state.lock().await;
        if let Some(rec) = st.swaps.get(&id) {
            return rec
                .outbox
                .first()
                .cloned()
                .ok_or_else(|| ApiError::conflict("swap id in use"));
        }
        if st.swaps.values().any(|r| !r.swap.is_final()) {
            return Err(ApiError::conflict("A swap is already in progress"));
        }
        if setup.role != self.role.peer() {
            return Err(ApiError::bad(format!(
                "taker must have role {}",
                self.role.peer().as_str()
            )));
        }
        if params.network != self.network() {
            return Err(ApiError::bad(format!(
                "this maker runs on {}",
                self.network()
            )));
        }
        if Terms::of(params) != self.offer.terms {
            return Err(ApiError::bad("timelock/fee terms differ from the offer"));
        }
        if params.zec_amount < self.offer.min_zat || params.zec_amount > self.offer.max_zat {
            return Err(ApiError::bad("amount outside the offer's range"));
        }
        if params.btc_amount != self.offer.btc_for(params.zec_amount) {
            return Err(ApiError::bad("BTC amount does not match the offer's rate"));
        }
        self.check_funds(params).await?;
        let address = self
            .rpc
            .new_address(self.network())
            .await
            .map_err(|e| ApiError(500, e.to_string()))?;
        let (swap, actions) =
            accept(&mut OsRng, &env, address).map_err(|e| ApiError::bad(e.to_string()))?;
        let mut rec = self.new_record(id.clone(), swap, req.taker_url, false)?;
        watch_swap(&self.rpc, &rec)
            .await
            .map_err(|e| ApiError(500, format!("watching the swap outputs: {e}")))?;
        let p = peer_name(self.role);
        rec.log(
            "peer",
            "propose_received",
            format!(
                "Received {p}'s Propose: {} for {}",
                zec_str(params.zec_amount),
                btc_str(params.btc_amount)
            ),
            None,
        );
        rec.log(
            "local",
            "dleq_verified",
            format!("Verified {p}'s DLEQ proof: {p}_p and {p}_s share one discrete log"),
            None,
        );
        rec.pending.extend(actions.into_iter().map(Pending::from));
        self.drive_pending(&mut rec).await;
        let reply = rec
            .outbox
            .first()
            .cloned()
            .ok_or_else(|| ApiError(500, "no Accept produced".into()))?;
        self.save(&rec);
        st.swaps.insert(id, rec);
        self.publish(&mut st);
        Ok(reply)
    }

    // ------------------------------------------------------------------ peer endpoints

    pub async fn peer_deliver(&self, id: &str, env: Envelope) -> Result<Delivery, ApiError> {
        let mut st = self.state.lock().await;
        let rec = st.swaps.get_mut(id).ok_or_else(ApiError::not_found)?;
        if rec.stalled {
            return Err(ApiError(503, "stalled".into()));
        }
        let digest = hex::encode(Sha256::digest(
            serde_json::to_vec(&env).expect("envelope serializes"),
        ));
        if rec.received.contains(&digest) {
            return Ok(Delivery {
                accepted: true,
                error: None,
            });
        }
        let name = env.message.name();
        let result = self.process(rec, Event::Peer(env)).await;
        rec.received.push(digest);
        if let Err(e) = &result {
            Self::log_rejected(rec, name, e);
        }
        self.save(rec);
        self.publish(&mut st);
        Ok(Delivery {
            accepted: result.is_ok(),
            error: result.err().map(|e| e.to_string()),
        })
    }

    pub async fn peer_outbox(&self, id: &str, after: usize) -> Result<Vec<Envelope>, ApiError> {
        let st = self.state.lock().await;
        let rec = st.swaps.get(id).ok_or_else(ApiError::not_found)?;
        if rec.stalled {
            return Err(ApiError(503, "stalled".into()));
        }
        Ok(rec.outbox.get(after..).unwrap_or_default().to_vec())
    }

    /// Demo fault injection.
    pub async fn fault(&self, id: &str, fault: &str) -> Result<(), ApiError> {
        if fault != "stall" {
            return Err(ApiError::bad("unknown fault"));
        }
        let mut st = self.state.lock().await;
        let rec = st.swaps.get_mut(id).ok_or_else(ApiError::not_found)?;
        if rec.stalled {
            return Err(ApiError::conflict("already stalled"));
        }
        let state = rec.state();
        let allowed = match rec.role() {
            Role::Z => matches!(
                state.as_str(),
                "CancelSigned" | "BtcLockSeen" | "ZecLocked" | "RedeemSigReceived"
            ),
            Role::B => matches!(state.as_str(), "BtcLocked" | "ZecSeen"),
        };
        if !allowed {
            return Err(ApiError::conflict(match rec.role() {
                Role::Z => "Z can only stall between presigning and broadcasting tx_redeem",
                Role::B => {
                    "B can only stall after locking BTC and before sending the redeem signature"
                }
            }));
        }
        rec.stalled = true;
        rec.resume_on_cancel = rec.role() == Role::Z;
        let label = match rec.role() {
            Role::Z => "Demo fault: Z stops responding until it sees tx_cancel",
            Role::B => "Demo fault: B stops responding and will not refund",
        };
        rec.log("local", "fault_injected", label, None);
        self.save(rec);
        self.publish(&mut st);
        Ok(())
    }

    // ------------------------------------------------------------------ state machine driving

    /// Feed one event and run the resulting actions, including follow-up events, to completion.
    async fn process(&self, rec: &mut SwapRecord, event: Event) -> Result<(), ferry_core::Error> {
        self.apply(rec, event)?;
        self.drive_pending(rec).await;
        Ok(())
    }

    /// Execute pending actions; feed back the events they produce (B's funded lock).
    async fn drive_pending(&self, rec: &mut SwapRecord) {
        let mut queue: VecDeque<Event> = self.run_pending(rec).await.into();
        while let Some(ev) = queue.pop_front() {
            if let Err(e) = self.apply(rec, ev) {
                tracing::warn!(id = %rec.id, "follow-up event rejected: {e}");
            }
            queue.extend(self.run_pending(rec).await);
        }
    }

    fn apply(&self, rec: &mut SwapRecord, event: Event) -> Result<(), ferry_core::Error> {
        let before = rec.state();
        let actions = rec.swap.handle(event.clone())?;
        self.narrate(rec, &event, &before, &actions);
        if rec.sweep_not_before.is_none()
            && actions
                .iter()
                .any(|a| matches!(a, ferry_core::Action::SweepZec { .. }))
        {
            self.schedule_sweep(rec);
        }
        rec.pending.extend(actions.into_iter().map(Pending::from));
        self.save(rec);
        Ok(())
    }

    /// Pick the random sweep delay (PROTOCOL.md: sweeps must not line up with the BTC spend).
    fn schedule_sweep(&self, rec: &mut SwapRecord) {
        let d = self.cli.sweep_delay_secs;
        let secs = d.min_secs + OsRng.next_u64() % (d.max_secs - d.min_secs + 1);
        rec.sweep_not_before = Some(now_ms() + secs * 1000);
        rec.log(
            "local",
            "sweep_delayed",
            format!("Waiting {secs}s before sweeping, so the ZEC sweep does not line up with the Bitcoin transaction"),
            None,
        );
    }

    /// While stalled: keep watching, but only take transitions that need no action.
    fn observe(&self, rec: &mut SwapRecord, event: Event) {
        let before = rec.state();
        let mut probe = rec.swap.clone();
        if let Ok(actions) = probe.handle(event.clone()) {
            if actions.is_empty() {
                rec.swap = probe;
                self.narrate(rec, &event, &before, &[]);
            }
        }
    }

    async fn run_pending(&self, rec: &mut SwapRecord) -> Vec<Event> {
        let mut follow = vec![];
        while let Some(p) = rec.pending.first().cloned() {
            if rec.stalled {
                break;
            }
            match self.execute(rec, p).await {
                Ok(ev) => follow.extend(ev),
                Err(Retry) => break,
            }
            rec.pending.remove(0);
            self.save(rec);
        }
        follow
    }

    async fn execute(&self, rec: &mut SwapRecord, p: Pending) -> Result<Option<Event>, Retry> {
        match p {
            Pending::Send { envelope } => {
                self.narrate_sent(rec, &envelope.message);
                rec.outbox.push(*envelope);
                Ok(None)
            }
            Pending::FundLock {
                address,
                amount_sat,
            } => {
                let address = Address::from_str(&address)
                    .ok()
                    .and_then(|a| a.require_network(self.network()).ok())
                    .expect("lock address from our own session");
                match self
                    .rpc
                    .fund_lock(&address, Amount::from_sat(amount_sat))
                    .await
                {
                    Ok(f) => Ok(Some(Event::LockFunded {
                        tx: f.tx,
                        vout: f.vout,
                    })),
                    Err(e) => {
                        tracing::warn!(id = %rec.id, "funding the lock: {e}");
                        Err(Retry)
                    }
                }
            }
            Pending::Broadcast { tx } => match self.rpc.broadcast(&tx).await {
                Ok(txid) => {
                    self.narrate_broadcast(rec, &tx, txid);
                    Ok(None)
                }
                // Rejected by the node (already known, already spent, not final): retrying
                // the identical transaction cannot help; the chain watcher reports what happened.
                Err(e @ RpcError::Rpc { .. }) => {
                    tracing::info!(id = %rec.id, "broadcast {} not accepted: {e}", tx.compute_txid());
                    Ok(None)
                }
                Err(e) => {
                    tracing::warn!(id = %rec.id, "broadcast: {e}");
                    Err(Retry)
                }
            },
            Pending::SendZec { fvk, amount } => {
                let fvk = fvk_from_hex(&fvk);
                // Never send twice (e.g. after a crash between sending and persisting).
                match self.leg.watch(&fvk).await {
                    Ok(notes) if !notes.is_empty() => {
                        rec.zec_lock_txid.get_or_insert(notes[0].txid.clone());
                        return Ok(None);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        tracing::warn!(id = %rec.id, "zec watch: {e}");
                        return Err(Retry);
                    }
                }
                match self.leg.send(&fvk, amount).await {
                    Ok(txid) => {
                        rec.zec_lock_txid = Some(txid.clone());
                        rec.log(
                            "zec",
                            "zec_lock_broadcast",
                            format!(
                                "Sent {} from Z's Ironwood notes to the joint address",
                                zec_str(amount)
                            ),
                            Some(txid),
                        );
                        Ok(None)
                    }
                    Err(e) => {
                        tracing::warn!(id = %rec.id, "zec send: {e}");
                        Err(Retry)
                    }
                }
            }
            Pending::SweepZec { fvk, ask } => {
                if rec.zec_sweep_txid.is_some() {
                    return Ok(None);
                }
                if rec.sweep_not_before.is_some_and(|t| now_ms() < t) {
                    return Err(Retry);
                }
                match self.leg.sweep(&fvk_from_hex(&fvk), ask.expose()).await {
                    Ok(txid) => {
                        rec.zec_sweep_txid = Some(txid.clone());
                        let (kind, label) = match rec.role() {
                            Role::B => (
                                "zec_sweep_broadcast",
                                "Swept the joint note to B's own shielded address, signing with ask = σ(z + b)",
                            ),
                            Role::Z => ("zec_reclaim_broadcast", "Swept the joint note back to Z's own shielded address"),
                        };
                        rec.log("zec", kind, label, Some(txid));
                        Ok(None)
                    }
                    Err(e) => {
                        tracing::warn!(id = %rec.id, "zec sweep: {e}");
                        Err(Retry)
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ narration

    fn spend_txid(rec: &SwapRecord, spend: Spend) -> Option<String> {
        rec.swap
            .watch_txids()
            .into_iter()
            .find(|(s, _)| *s == spend)
            .map(|(_, t)| t.to_string())
    }

    fn lock_txid(rec: &SwapRecord) -> Option<String> {
        rec.swap.lock_outpoint().map(|o| o.txid.to_string())
    }

    fn narrate_sent(&self, rec: &mut SwapRecord, msg: &Message) {
        let (kind, label) = match msg {
            Message::Accept { .. } => (
                "accept_sent",
                format!(
                    "Sent Accept with {}'s points and DLEQ proof. Derived the joint Ironwood address",
                    self.role.as_str()
                ),
            ),
            Message::LockTemplate { .. } => {
                ("lock_template_sent", "Built tx_lock from B's wallet (not broadcast) and sent the template".into())
            }
            Message::CancelSigs { .. } => (
                "cancel_sigs_sent",
                "Checked B's tx_lock template. Signed tx_cancel and sent an adaptor signature on tx_refund under B_s"
                    .into(),
            ),
            Message::CancelSig { .. } => (
                "refund_adaptor_verified",
                "Checked Z's adaptor signature on tx_refund under B_s. Sent B's tx_cancel signature".into(),
            ),
            Message::RedeemAdaptor { .. } => {
                ("redeem_adaptor_sent", "Sent Z an adaptor signature on tx_redeem, encrypted under Z_s".into())
            }
            Message::Propose { .. } => return,
        };
        rec.log("peer", kind, label, None);
    }

    fn narrate_broadcast(&self, rec: &mut SwapRecord, tx: &Transaction, txid: Txid) {
        let txid_s = Some(txid.to_string());
        if Self::lock_txid(rec) == txid_s {
            let amount = rec.swap.session().params.btc_amount;
            rec.log(
                "btc",
                "btc_lock_broadcast",
                format!(
                    "Broadcast tx_lock: {} to the Taproot lock address",
                    btc_str(amount)
                ),
                txid_s,
            );
            return;
        }
        let spend = rec
            .swap
            .lock_outpoint()
            .and_then(|o| rec.swap.session().txs(o).ok())
            .and_then(|txs| txs.classify(tx));
        let (kind, label) = match spend {
            Some(Spend::Cancel) => (
                "cancel_broadcast",
                match rec.role() {
                    Role::B => "T1 reached without a redeem. Broadcast the presigned tx_cancel",
                    Role::Z => {
                        "T1 reached without B's redeem signature. Broadcast the presigned tx_cancel"
                    }
                },
            ),
            Some(Spend::Redeem) => {
                rec.mine_revealed = true;
                if tx.input[0].witness.len() == 1 {
                    (
                        "btc_redeem_broadcast",
                        "Completed the MuSig2 adaptor signature with z and broadcast tx_redeem as a key-path spend",
                    )
                } else {
                    (
                        "btc_redeem_broadcast",
                        "Decrypted the adaptor with z, added Z's signature and broadcast tx_redeem",
                    )
                }
            }
            Some(Spend::Refund) => {
                rec.mine_revealed = true;
                (
                    "refund_broadcast",
                    "Broadcast tx_refund. Completing Z's adaptor signature puts b in the witness",
                )
            }
            Some(Spend::Punish) => (
                "punish_broadcast",
                "T2 passed without a refund. Broadcast tx_punish to take the BTC",
            ),
            None => ("btc_broadcast", "Broadcast a transaction"),
        };
        rec.log("btc", kind, label, txid_s);
    }

    fn narrate(
        &self,
        rec: &mut SwapRecord,
        event: &Event,
        before: &str,
        actions: &[ferry_core::Action],
    ) {
        if let Event::Peer(env) = event {
            match (&env.message, rec.role()) {
                (Message::CancelSig { .. }, Role::Z) => rec.log(
                    "peer",
                    "cancel_sig_received",
                    "Received B's tx_cancel signature. Both abort paths are now presigned",
                    None,
                ),
                (Message::RedeemAdaptor { .. }, Role::Z) => rec.log(
                    "peer",
                    "redeem_adaptor_received",
                    "Received B's adaptor signature on tx_redeem and verified it under Z_s",
                    None,
                ),
                _ => {}
            }
        }
        let after = rec.state();
        if after == before {
            return;
        }
        let params = rec.swap.session().params.clone();
        let broadcasting_cancel = actions.iter().any(|a| match a {
            ferry_core::Action::BroadcastBtc(tx) => {
                Some(tx.compute_txid().to_string()) == Self::spend_txid(rec, Spend::Cancel)
            }
            _ => false,
        });
        match (rec.role(), after.as_str()) {
            (_, "Cancelled") if !broadcasting_cancel => {
                let who = peer_name(rec.role());
                rec.log(
                    "btc",
                    "cancel_seen",
                    format!("Saw {who} broadcast tx_cancel after T1"),
                    Self::spend_txid(rec, Spend::Cancel),
                );
            }
            (Role::Z, "BtcLockSeen" | "ZecLocked") if !rec.has("btc_lock_seen") => rec.log(
                "btc",
                "btc_lock_seen",
                "tx_lock is confirmed and pays the agreed Taproot address",
                Self::lock_txid(rec),
            ),
            (Role::Z, "BtcRedeemed") => rec.log(
                "local",
                "swap_complete",
                format!("Swap complete. {} is in Z's wallet", btc_str(params.btc_amount - params.btc_fee)),
                None,
            ),
            (Role::Z, "ZecReclaiming") => {
                rec.peer_learned = true;
                rec.log(
                    "btc",
                    "secret_extracted",
                    "Read b from B's tx_refund witness. Z can now spend the joint note on its own",
                    Self::spend_txid(rec, Spend::Refund),
                );
            }
            (Role::Z, "Refunded") => {
                rec.peer_learned = true;
                rec.log(
                    "btc",
                    "secret_extracted",
                    "Read b from B's tx_refund witness. No ZEC was locked, so there is nothing to reclaim",
                    Self::spend_txid(rec, Spend::Refund),
                );
            }
            (Role::Z, "ZecReclaimed") => rec.log(
                "local",
                "reclaimed",
                format!("{} is back in Z's own Ironwood notes", zec_str(params.zec_amount)),
                None,
            ),
            (Role::Z, "Punished") => rec.log(
                "local",
                "punished",
                "Z holds the BTC. Z's ZEC stays in the joint note, which is B's penalty for not refunding",
                None,
            ),
            (Role::B, "ZecSeen" | "RedeemSigSent") => {
                if !rec.has("zec_note_seen") {
                    rec.log(
                        "zec",
                        "zec_note_seen",
                        "Found the lock note at the joint address with the shared viewing key",
                        rec.zec_lock_txid.clone(),
                    );
                }
                if after == "RedeemSigSent" {
                    rec.log(
                        "zec",
                        "zec_confirmed",
                        format!(
                            "Lock note has {} confirmations and holds {}",
                            params.zec_confirmations,
                            zec_str(params.zec_amount)
                        ),
                        None,
                    );
                }
            }
            (Role::B, "BtcRedeemed") => {
                rec.peer_learned = true;
                rec.log(
                    "btc",
                    "secret_extracted",
                    "Read z from Z's redeem signature in the tx_redeem witness (z = s − s′). B can now spend the \
                     joint Ironwood note",
                    Self::spend_txid(rec, Spend::Redeem),
                );
            }
            (Role::B, "ZecSwept") => rec.log(
                "local",
                "swap_complete",
                format!("Swap complete. B holds {} in its own Ironwood notes", zec_str(params.zec_amount)),
                None,
            ),
            (Role::B, "Refunded") => rec.log(
                "local",
                "refunded",
                "BTC is back in B's wallet. Revealing b unlocks nothing for B",
                None,
            ),
            (Role::B, "Punished") => rec.log(
                "btc",
                "punish_seen",
                "Z claimed the locked BTC with tx_punish after T2. B never refunded",
                Self::spend_txid(rec, Spend::Punish),
            ),
            (_, "Aborted") => rec.log("local", "aborted", "Negotiation timed out before anything was locked", None),
            _ => {}
        }
    }

    // ------------------------------------------------------------------ driver

    pub async fn run(self: Arc<Self>) {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(self.cli.poll_ms));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            self.refresh_status().await;
            self.tick().await;
        }
    }

    pub async fn tick(&self) {
        let mut st = self.state.lock().await;
        let ids: Vec<String> = st.swaps.keys().cloned().collect();
        for id in ids {
            let mut rec = st.swaps.remove(&id).expect("listed");
            if !rec.settled() {
                if let Err(e) = self.tick_swap(&mut rec).await {
                    tracing::warn!(%id, "tick: {e}");
                }
                self.save(&rec);
            }
            st.swaps.insert(id, rec);
        }
        self.publish(&mut st);
    }

    async fn tick_swap(&self, rec: &mut SwapRecord) -> anyhow::Result<()> {
        if !rec.stalled {
            self.drive_pending(rec).await;
            if rec.taker {
                self.exchange(rec).await;
            }
        }
        self.maybe_resume(rec).await?;
        for ev in self.chain_events(rec).await? {
            if rec.stalled {
                self.observe(rec, ev);
            } else if let Err(e) = self.process(rec, ev).await {
                tracing::warn!(id = %rec.id, "chain event rejected: {e}");
            }
        }
        self.fill_heights(rec).await?;
        Ok(())
    }

    /// Taker: deliver our outbox to the maker, then fetch and apply its new messages.
    async fn exchange(&self, rec: &mut SwapRecord) {
        let base = format!("{}/peer/swaps/{}/messages", rec.counterparty, rec.id);
        while rec.sent < rec.outbox.len() {
            let resp = self
                .http
                .post(&base)
                .json(&rec.outbox[rec.sent])
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    if let Ok(Delivery {
                        accepted: false,
                        error,
                    }) = r.json::<Delivery>().await
                    {
                        tracing::warn!(id = %rec.id, "peer rejected our message: {error:?}");
                    }
                    rec.sent += 1;
                }
                _ => return,
            }
        }
        let resp = self
            .http
            .get(format!("{base}?after={}", rec.peer_seen))
            .send()
            .await;
        let Ok(r) = resp.and_then(|r| r.error_for_status()) else {
            return;
        };
        let Ok(msgs) = r.json::<Vec<Envelope>>().await else {
            return;
        };
        for env in msgs {
            rec.peer_seen += 1;
            let name = env.message.name();
            if let Err(e) = self.process(rec, Event::Peer(env)).await {
                Self::log_rejected(rec, name, &e);
            }
        }
    }

    fn log_rejected(rec: &mut SwapRecord, message: &str, e: &ferry_core::Error) {
        let peer = peer_name(rec.role());
        match e {
            // A message that arrives after the swap moved on (e.g. after a stall) is harmless.
            ferry_core::Error::Unexpected { state, .. } => rec.log(
                "peer",
                "peer_message_ignored",
                format!(
                    "Ignored {peer}'s late {message}: this swap is already in {}",
                    crate::record::state_label(state)
                ),
                None,
            ),
            e => rec.log(
                "peer",
                "peer_message_rejected",
                format!("Rejected {peer}'s {message}: {e}"),
                None,
            ),
        }
    }

    async fn maybe_resume(&self, rec: &mut SwapRecord) -> anyhow::Result<()> {
        if !(rec.stalled && rec.resume_on_cancel) {
            return Ok(());
        }
        let Some(cancel) = rec
            .swap
            .watch_txids()
            .into_iter()
            .find(|(s, _)| *s == Spend::Cancel)
        else {
            return Ok(());
        };
        if self.rpc.confirmations(&cancel.1).await?.unwrap_or(0) > 0 {
            rec.stalled = false;
            rec.resume_on_cancel = false;
            rec.log(
                "local",
                "fault_cleared",
                "Z is back online and sees tx_cancel confirmed",
                None,
            );
        }
        Ok(())
    }

    async fn chain_events(&self, rec: &mut SwapRecord) -> anyhow::Result<Vec<Event>> {
        let mut out = vec![];
        let Some(lock) = rec.swap.lock_outpoint() else {
            return Ok(out);
        };
        let params = rec.swap.session().params.clone();

        if let Some(confs) = self.rpc.confirmations(&lock.txid).await? {
            if let Some(tx) = self.rpc.raw_transaction(&lock.txid).await? {
                SwapRecord::set_observer(
                    &mut rec.observer_btc,
                    "lock",
                    view::describe_lock(&tx, lock.vout),
                );
                if confs > 0 {
                    rec.btc_lock_height = self.rpc.block_height(&lock.txid).await?;
                    let txout = tx.output[lock.vout as usize].clone();
                    out.push(Event::Chain(ChainEvent::BtcLockConfirmed { confs, txout }));
                }
            }
        }
        let txs = rec.swap.session().txs(lock)?;
        for (spend, txid) in rec.swap.watch_txids() {
            let Some(tx) = self.rpc.raw_transaction(&txid).await? else {
                continue;
            };
            let confs = self.rpc.confirmations(&txid).await?.unwrap_or(0);
            if spend == Spend::Cancel && confs > 0 {
                rec.cancel_height = self.rpc.block_height(&txid).await?;
            }
            let prev = match spend {
                Spend::Cancel | Spend::Redeem => Amount::from_sat(params.btc_amount),
                Spend::Refund | Spend::Punish => txs.cancel.output[0].value,
            };
            SwapRecord::set_observer(
                &mut rec.observer_btc,
                view::spend_key(spend),
                view::describe_spend(spend, &tx, prev),
            );
            out.push(Event::Chain(ChainEvent::BtcSpend { tx, confs }));
        }

        let fvk = rec.swap.session().joint_fvk()?;
        let mut spent_by = None;
        for note in self.leg.watch(&fvk).await? {
            rec.zec_lock_txid.get_or_insert(note.txid.clone());
            spent_by = spent_by.or(note.spent_by);
            out.push(Event::Chain(ChainEvent::ZecNoteSeen {
                value: note.value,
                confs: note.confirmations,
            }));
        }
        if let Some(txid) = rec.zec_sweep_txid.clone() {
            if let Some(confs) = self.leg.confirmations(&txid).await? {
                out.push(Event::Chain(ChainEvent::ZecSwept { confs }));
            }
        }
        // Both parties describe the same public transactions: the lock and whoever's sweep.
        for (key, txid) in [
            ("lock", rec.zec_lock_txid.clone()),
            ("sweep", spent_by.or(rec.zec_sweep_txid.clone())),
        ] {
            let Some(txid) = txid else { continue };
            if rec.observer_zec.iter().any(|(k, _)| k == key) {
                continue;
            }
            if let Some(line) = self.leg.describe_tx(&txid).await? {
                SwapRecord::set_observer(&mut rec.observer_zec, key, line);
            }
        }
        Ok(out)
    }

    /// Fill in the confirmation height of timeline entries whose transaction confirmed.
    async fn fill_heights(&self, rec: &mut SwapRecord) -> anyhow::Result<()> {
        if rec
            .timeline
            .iter()
            .all(|e| e.txid.is_none() || e.height.is_some())
        {
            return Ok(());
        }
        let zec_tip = self.leg.status().await?.height;
        for e in rec.timeline.iter_mut().filter(|e| e.height.is_none()) {
            let Some(txid) = e.txid.clone() else { continue };
            e.height = match e.chain.as_str() {
                "btc" => match Txid::from_str(&txid) {
                    Ok(t) => self.rpc.block_height(&t).await?,
                    Err(_) => continue,
                },
                // The ZecLeg reports confirmations only; derive the height from the tip.
                "zec" => self
                    .leg
                    .confirmations(&txid)
                    .await?
                    .filter(|c| *c > 0)
                    .map(|c| zec_tip + 1 - u64::from(c)),
                _ => continue,
            };
        }
        Ok(())
    }
}
