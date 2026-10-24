//! One party's EVM swaps: negotiation, the peer exchange, the chain driver and narration.
//! The Bitcoin daemon's structure (crate::daemon) with FerryLock in place of bitcoind.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use ferry_core::evm::{
    evm_accept, EvmChainEvent, EvmEvent, EvmMessage, EvmObservation, EvmParams, EvmPolicy,
    EvmProposal, EvmSwap, LockTerms, ObservedLock,
};
use ferry_core::{Role, SendFailure, ZecLeg};
use ferry_evm::{Address, EvmClient, PrivateKeySigner, SwapEventKind, B256, U256};
use futures_util::FutureExt;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Mutex};

use super::config::{
    addr_str, network_name, parse_address, token_str, Counter, EvmOffer, EvmProposeRequest,
    EvmTerms,
};
use super::record::{bytes, EvmPending, EvmRecord, EvmStore};
use super::view::{self, EvmStatusView};
use crate::config::{Cli, Delivery};
use crate::daemon::{ApiError, SseEvent};
use crate::record::fvk_from_hex;

const PROPOSALS_PER_MINUTE: usize = 6;
const MAX_REJECTED: u32 = 16;
const MAX_RECEIVED: usize = 32;
/// A taker's t1 may differ from ours by this much (clock and block-time skew).
const T1_TOLERANCE_SECS: u64 = 120;

#[derive(Default)]
pub struct EvmState {
    pub swaps: BTreeMap<String, EvmRecord>,
    pub status: Option<EvmStatusView>,
    published: HashMap<String, String>,
}

pub struct EvmDaemon<L> {
    pub cli: Cli,
    pub role: Role,
    pub offer: EvmOffer,
    pub leg: L,
    pub client: EvmClient,
    signer: PrivateKeySigner,
    pub chain_id: u64,
    http: reqwest::Client,
    store: EvmStore,
    pub state: Mutex<EvmState>,
    pub events: broadcast::Sender<SseEvent>,
    pub api_token: String,
    pub policy: EvmPolicy,
    proposals: std::sync::Mutex<VecDeque<Instant>>,
    pub price: Option<Arc<crate::pricefeed::LiveRate>>,
}

struct Retry;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn zec_str(zat: u64) -> String {
    format!("{:.2} ZEC", zat as f64 / 1e8)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn to_terms(t: &LockTerms) -> ferry_evm::Terms {
    ferry_evm::Terms {
        token: Address::from(t.token),
        amount: U256::from(t.amount),
        zAddr: Address::from(t.z_addr),
        bAddr: Address::from(t.b_addr),
        claimer: Address::from(t.claimer),
        refunder: Address::from(t.refunder),
        t1: t.t1,
        t2: t.t2,
        maxTip: U256::from(t.max_tip),
    }
}

/// On-chain terms in plain bytes; amounts above u64 cannot be ours, so they never match.
fn from_terms(t: &ferry_evm::Terms) -> LockTerms {
    let small = |v: U256| u64::try_from(v).unwrap_or(u64::MAX);
    LockTerms {
        token: t.token.0 .0,
        amount: small(t.amount),
        z_addr: t.zAddr.0 .0,
        b_addr: t.bAddr.0 .0,
        claimer: t.claimer.0 .0,
        refunder: t.refunder.0 .0,
        t1: t.t1,
        t2: t.t2,
        max_tip: small(t.maxTip),
    }
}

fn load_key(path: &std::path::Path) -> anyhow::Result<PrivateKeySigner> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading the EVM key {}", path.display()))?;
    let hex = text.trim().trim_start_matches("0x");
    let bytes: [u8; 32] = hex::decode(hex)
        .ok()
        .and_then(|v| v.try_into().ok())
        .context("the EVM key file must hold a 32-byte hex private key")?;
    PrivateKeySigner::from_bytes(&B256::from(bytes)).context("invalid EVM private key")
}

impl<L: ZecLeg + 'static> EvmDaemon<L> {
    pub async fn new(cli: Cli, leg: L) -> anyhow::Result<Arc<Self>> {
        let e = &cli.evm;
        let contract = parse_address(e.evm_contract.as_deref().context("--evm-contract")?)
            .map_err(anyhow::Error::msg)?;
        let token = parse_address(e.evm_token.as_deref().context("--evm-token")?)
            .map_err(anyhow::Error::msg)?;
        let signer = load_key(e.evm_key_file.as_deref().context("--evm-key-file")?)?;
        let client = EvmClient::connect_http(&e.evm_rpc, Address::from(contract), signer.clone())?
            .with_log_chunk(e.evm_log_chunk);
        let chain_id = client
            .chain_id()
            .await
            .with_context(|| format!("reaching the EVM node at {}", e.evm_rpc))?;
        client.check_deployment().await.with_context(|| {
            format!(
                "checking the FerryLock deployment at {}",
                addr_str(&contract)
            )
        })?;
        let policy = EvmPolicy::for_chain(chain_id, cli.dev_policy)
            .map_err(|e| anyhow::anyhow!("{e} (pass --dev-policy for a local anvil setup)"))?;
        let role: Role = cli.role.into();
        let o = cli.maker_offer.unwrap_or(crate::config::OfferArg {
            rate_sat_per_zec: 40_000_000,
            min_zat: 10_000_000,
            max_zat: 1_000_000_000,
        });
        let offer = EvmOffer {
            counter: Counter::Evm,
            role,
            chain_id,
            network: network_name(chain_id),
            contract,
            token,
            token_symbol: e.evm_token_symbol.clone(),
            token_decimals: e.evm_token_decimals,
            making: cli.maker_offer.is_some(),
            rate_sat_per_zec: o.rate_sat_per_zec,
            min_zat: o.min_zat,
            max_zat: o.max_zat,
            terms: EvmTerms {
                t1_secs: e.evm_t1_secs,
                refund_secs: e.evm_refund_secs,
                claim_margin: e.evm_delta_secs,
                refund_margin: e.evm_delta_secs,
                lock_confirmations: e.evm_lock_confs,
                zec_confirmations: cli.zec_confs,
                max_tip: e.evm_max_tip,
            },
            rate_source: None,
            rate_updated_at: None,
            liquidity: None,
            paused: false,
        };
        let store = EvmStore::open(&cli.data_dir)?;
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
        let mut state = EvmState::default();
        for rec in store.load_all()? {
            tracing::info!(id = %rec.id, state = %rec.state(), "resuming EVM swap");
            state.swaps.insert(rec.id.clone(), rec);
        }
        let (events, _) = broadcast::channel(256);
        let daemon = EvmDaemon {
            price: cli.live_rate().map(Arc::new),
            role,
            offer,
            leg,
            client,
            signer,
            chain_id,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()?,
            store,
            state: Mutex::new(state),
            events,
            api_token,
            policy,
            proposals: std::sync::Mutex::new(VecDeque::new()),
            cli,
        };
        if daemon.offer.making {
            // Our own maker terms must pass our own policy.
            let now = daemon.client.latest_timestamp().await?;
            daemon
                .params_for(
                    daemon.offer.max_zat,
                    daemon.offer.token_for(daemon.offer.max_zat),
                    now,
                )
                .check_policy(&daemon.policy, now)
                .map_err(|e| anyhow::anyhow!("our own maker terms: {e}"))?;
        }
        Ok(Arc::new(daemon))
    }

    fn save(&self, rec: &EvmRecord) -> bool {
        match self.store.save(rec) {
            Ok(()) => true,
            Err(e) => {
                tracing::error!(id = %rec.id, "persisting swap: {e}");
                false
            }
        }
    }

    fn token(&self, amount: u64) -> String {
        token_str(amount, self.offer.token_decimals, &self.offer.token_symbol)
    }

    /// Our offer's terms applied to an amount, with deadlines from `now`.
    fn params_for(&self, zec_zat: u64, token_amount: u64, now: u64) -> EvmParams {
        let t = &self.offer.terms;
        let t1 = now + t.t1_secs;
        EvmParams {
            chain_id: self.chain_id,
            contract: self.offer.contract,
            token: self.offer.token,
            token_amount,
            token_symbol: self.offer.token_symbol.clone(),
            token_decimals: self.offer.token_decimals,
            zec_amount: zec_zat,
            t1,
            t2: t1 + t.refund_secs,
            claim_margin: t.claim_margin,
            refund_margin: t.refund_margin,
            lock_confirmations: t.lock_confirmations,
            zec_confirmations: t.zec_confirmations,
            max_tip: t.max_tip,
        }
    }

    // ------------------------------------------------------------------ views & events

    pub async fn status_view(&self) -> anyhow::Result<EvmStatusView> {
        let zec = self.leg.status().await?;
        let (height, time) = self.client.latest_block().await?;
        let tokens = self
            .client
            .token_balance(Address::from(self.offer.token), self.client.address())
            .await?;
        let eth = self.client.eth_balance().await?;
        let balances = view::Balances {
            zec_shielded_zat: zec.shielded_balance,
            btc_sat: u64::try_from(tokens).unwrap_or(u64::MAX),
            eth_wei: eth.to_string(),
        };
        let offer = self.offer_with(Some(&balances));
        Ok(EvmStatusView {
            role: self.role,
            name: self.cli.name.clone(),
            chains: view::Chains {
                btc: view::CounterChain {
                    network: self.offer.network.clone(),
                    height,
                    coin: self.offer.token_symbol.to_lowercase(),
                    ticker: self.offer.token_symbol.clone(),
                    decimals: self.offer.token_decimals,
                    time,
                },
                zec: crate::view::ZecChain {
                    network: zec.network,
                    height: zec.height,
                    pool: "ironwood".into(),
                },
            },
            offer: view::OfferView::of(&offer),
            counter: view::CounterInfo {
                kind: "evm",
                chain_id: self.chain_id,
                contract: addr_str(&self.offer.contract),
                token: addr_str(&self.offer.token),
                symbol: self.offer.token_symbol.clone(),
                decimals: self.offer.token_decimals,
                account: self.client.address().to_checksum(None),
            },
            balances,
        })
    }

    /// Our offer right now: the live rate (when following a feed) and our liquidity.
    pub fn offer_with(&self, balances: Option<&view::Balances>) -> EvmOffer {
        let mut offer = self.offer.clone();
        match self.price.as_deref() {
            None => offer.rate_source = Some("fixed".into()),
            Some(live) => match live.quote() {
                Some(q) => {
                    offer.rate_sat_per_zec = q.rate;
                    offer.rate_source = Some(q.source);
                    offer.rate_updated_at = Some(q.updated_at);
                    if q.paused {
                        offer.paused = true;
                        offer.making = false;
                    }
                }
                None => {
                    offer.rate_source = Some("waiting for the first price".into());
                    offer.paused = true;
                    offer.making = false;
                }
            },
        }
        if let Some(b) = balances.filter(|_| self.offer.making) {
            let fillable = match self.role {
                Role::Z => b.zec_shielded_zat,
                Role::B if offer.rate_sat_per_zec == 0 => 0,
                Role::B => {
                    (u128::from(b.btc_sat) * 100_000_000 / u128::from(offer.rate_sat_per_zec))
                        as u64
                }
            };
            offer.liquidity = Some(crate::config::Liquidity {
                zec_zat: fillable.min(self.offer.max_zat),
            });
        }
        offer
    }

    pub async fn offer_now(&self) -> EvmOffer {
        let balances = self
            .state
            .lock()
            .await
            .status
            .as_ref()
            .map(|s| s.balances.clone());
        self.offer_with(balances.as_ref())
    }

    fn rate_matches(&self, zec_amount: u64, token_amount: u64) -> bool {
        match &self.price {
            Some(live) => live.amount_matches(zec_amount, token_amount),
            None => self.offer.token_for(zec_amount) == token_amount,
        }
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

    fn publish(&self, st: &mut EvmState) {
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
            return Err(ApiError(400, "maker URL is required".into()));
        }
        self.check_idle().await?;
        let offer: EvmOffer = self
            .http
            .get(format!("{maker}/peer/offer"))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| ApiError(502, format!("maker unreachable: {e}")))?
            .json()
            .await
            .map_err(|e| ApiError(502, format!("maker offer (not an EVM maker?): {e}")))?;
        let bad = |m: String| Err(ApiError(400, m));
        if offer.counter != Counter::Evm {
            return bad("the counterparty does not swap against an EVM token".into());
        }
        if !offer.making {
            return bad("the counterparty is not making offers".into());
        }
        if offer.role == self.role {
            return bad(format!(
                "the counterparty also has role {}",
                self.role.as_str()
            ));
        }
        if offer.chain_id != self.chain_id
            || offer.contract != self.offer.contract
            || offer.token != self.offer.token
        {
            return bad("the counterparty uses another chain, FerryLock or token".into());
        }
        // Whoever sees Z's claim in the mempool can resubmit it with the largest tip the lock
        // allows, so Z never takes a maker's tip cap above its own --evm-max-tip (0 by default).
        if self.role == Role::Z && offer.terms.max_tip > self.offer.terms.max_tip {
            return bad(format!(
                "the maker allows a claim tip of up to {} token units, above our --evm-max-tip of {}",
                offer.terms.max_tip, self.offer.terms.max_tip
            ));
        }
        if zec_zat < offer.min_zat || zec_zat > offer.max_zat {
            return bad(format!(
                "Amount must be between {} and {}",
                zec_str(offer.min_zat),
                zec_str(offer.max_zat)
            ));
        }
        let (head, now) = self
            .client
            .latest_block()
            .await
            .map_err(|e| ApiError(503, e.to_string()))?;
        let t = &offer.terms;
        let t1 = now + t.t1_secs;
        let params = EvmParams {
            chain_id: self.chain_id,
            contract: self.offer.contract,
            token: self.offer.token,
            token_amount: offer.token_for(zec_zat),
            token_symbol: offer.token_symbol.clone(),
            token_decimals: offer.token_decimals,
            zec_amount: zec_zat,
            t1,
            t2: t1 + t.refund_secs,
            claim_margin: t.claim_margin,
            refund_margin: t.refund_margin,
            lock_confirmations: t.lock_confirmations,
            zec_confirmations: t.zec_confirmations,
            max_tip: t.max_tip,
        };
        params
            .check_policy(&self.policy, now)
            .map_err(|e| ApiError(400, format!("The maker's terms are not acceptable: {e}")))?;
        self.check_funds(&params).await?;
        let mut sid = [0u8; 32];
        OsRng.fill_bytes(&mut sid);
        let me = self.client.address().0 .0;
        let (proposal, propose) = EvmProposal::new(&mut OsRng, sid, self.role, params, me)
            .map_err(|e| ApiError(400, e.to_string()))?;
        let resp = self
            .http
            .post(format!("{maker}/peer/swaps"))
            .json(&EvmProposeRequest {
                envelope: propose,
                taker_url: self.cli.public_url(),
            })
            .send()
            .await
            .map_err(|e| ApiError(502, format!("maker unreachable: {e}")))?;
        if !resp.status().is_success() {
            let code = if resp.status().is_client_error() {
                400
            } else {
                502
            };
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let msg = body["error"].as_str().unwrap_or("proposal refused");
            return Err(ApiError(code, format!("The maker refused: {msg}")));
        }
        let accept_env = resp
            .json()
            .await
            .map_err(|e| ApiError(502, e.to_string()))?;
        let (swap, actions) = proposal
            .on_accept(&mut OsRng, &accept_env)
            .map_err(|e| ApiError(502, format!("maker's Accept rejected: {e}")))?;
        let id = hex::encode(sid);
        let mut rec = self.new_record(id.clone(), swap, maker, true, head)?;
        rec.peer_seen = 1;
        let p = rec.role().peer().as_str();
        rec.log(
            "peer",
            "propose_sent",
            format!("Sent Propose to {p}: amounts, deadlines, Pallas and secp256k1 points, DLEQ proof, our EVM account"),
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
        rec.log(
            "peer",
            "terms_agreed",
            "Agreed the terms: nothing to presign on an EVM chain, FerryLock enforces the deadlines",
            None,
        );
        rec.pending
            .extend(actions.into_iter().map(EvmPending::from));
        let mut st = self.state.lock().await;
        self.drive_pending(&mut rec).await;
        self.save(&rec);
        st.swaps.insert(id.clone(), rec);
        self.publish(&mut st);
        Ok(id)
    }

    pub async fn funding_addresses(&self) -> Result<serde_json::Value, ApiError> {
        Ok(serde_json::json!({
            "role": self.role,
            "name": self.cli.name,
            "btc": {
                "network": self.offer.network,
                "address": self.client.address().to_checksum(None),
                "token": addr_str(&self.offer.token),
                "symbol": self.offer.token_symbol,
            },
            "zec": { "address": self.leg.receive_address() },
        }))
    }

    async fn check_idle(&self) -> Result<(), ApiError> {
        let st = self.state.lock().await;
        if st.swaps.values().any(|r| !r.swap.is_final()) {
            return Err(ApiError(409, "A swap is already in progress".into()));
        }
        Ok(())
    }

    async fn check_funds(&self, params: &EvmParams) -> Result<(), ApiError> {
        let unavailable = |e: String| ApiError(503, e);
        match self.role {
            Role::Z => {
                let have = self
                    .leg
                    .status()
                    .await
                    .map_err(|e| unavailable(e.to_string()))?
                    .shielded_balance;
                let need = params.zec_amount + self.leg.send_fee_reserve();
                if have < need {
                    return Err(ApiError(
                        400,
                        format!(
                            "Z does not have enough shielded ZEC: {have} zat spendable in Ironwood, \
                             {need} zat needed (the amount plus fees)"
                        ),
                    ));
                }
            }
            Role::B => {
                let have = self
                    .client
                    .token_balance(Address::from(params.token), self.client.address())
                    .await
                    .map_err(|e| unavailable(e.to_string()))?;
                if have < U256::from(params.token_amount) {
                    return Err(ApiError(
                        400,
                        format!("B does not have enough {}", params.token_symbol),
                    ));
                }
            }
        }
        // Z sends the claim, B the lock and refund: both need gas.
        let eth = self
            .client
            .eth_balance()
            .await
            .map_err(|e| unavailable(e.to_string()))?;
        if eth.is_zero() {
            return Err(ApiError(400, "Our EVM account has no ETH for gas".into()));
        }
        Ok(())
    }

    fn new_record(
        &self,
        id: String,
        swap: EvmSwap,
        counterparty: String,
        taker: bool,
        head: u64,
    ) -> Result<EvmRecord, ApiError> {
        let fvk = swap
            .session()
            .joint_fvk()
            .map_err(|e| ApiError(500, e.to_string()))?;
        let joint = self
            .leg
            .joint_address(&fvk)
            .map_err(|e| ApiError(500, e.to_string()))?;
        Ok(EvmRecord::new(id, swap, counterparty, taker, joint, head))
    }

    /// Maker: handle a `Propose`. Idempotent per session id.
    pub async fn accept_proposal(
        &self,
        req: EvmProposeRequest,
    ) -> Result<ferry_core::evm::EvmEnvelope, ApiError> {
        let offer = self.offer_now().await;
        if !offer.making {
            return Err(ApiError(403, "not making offers".into()));
        }
        {
            let mut recent = self.proposals.lock().expect("not poisoned");
            let now = Instant::now();
            while recent
                .front()
                .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60))
            {
                recent.pop_front();
            }
            if recent.len() >= PROPOSALS_PER_MINUTE {
                return Err(ApiError(
                    429,
                    "Too many proposals; try again in a minute".into(),
                ));
            }
            recent.push_back(now);
        }
        let env = req.envelope;
        let EvmMessage::Propose { params, setup } = &env.message else {
            return Err(ApiError(400, "expected a Propose message".into()));
        };
        let id = hex::encode(env.session_id);
        let mut st = self.state.lock().await;
        if let Some(rec) = st.swaps.get(&id) {
            return rec
                .outbox
                .first()
                .cloned()
                .ok_or_else(|| ApiError(409, "swap id in use".into()));
        }
        if st.swaps.values().any(|r| !r.swap.is_final()) {
            return Err(ApiError(409, "A swap is already in progress".into()));
        }
        let bad = |m: &str| Err(ApiError(400, m.to_string()));
        if setup.role != self.role.peer() {
            return bad("taker has our role");
        }
        if params.chain_id != self.chain_id
            || params.contract != self.offer.contract
            || params.token != self.offer.token
        {
            return bad("another chain, FerryLock or token than this maker's");
        }
        if params.token_symbol != self.offer.token_symbol
            || params.token_decimals != self.offer.token_decimals
        {
            return bad("token symbol or decimals differ from the offer");
        }
        if !self.offer.terms.same_shape(params) {
            return bad("timing terms differ from the offer");
        }
        if params.zec_amount < self.offer.min_zat || params.zec_amount > self.offer.max_zat {
            return bad("amount outside the offer's range");
        }
        if !self.rate_matches(params.zec_amount, params.token_amount) {
            return bad("token amount does not match the offer's rate");
        }
        let (head, now) = self
            .client
            .latest_block()
            .await
            .map_err(|e| ApiError(503, e.to_string()))?;
        let want_t1 = now + self.offer.terms.t1_secs;
        if params.t1.abs_diff(want_t1) > T1_TOLERANCE_SECS {
            return bad("t1 is not the offer's claim window from now");
        }
        params
            .check_policy(&self.policy, now)
            .map_err(|e| ApiError(400, e.to_string()))?;
        self.check_funds(params).await?;
        let me = self.client.address().0 .0;
        let (swap, actions) =
            evm_accept(&mut OsRng, &env, me).map_err(|e| ApiError(400, e.to_string()))?;
        let mut rec = self.new_record(id.clone(), swap, req.taker_url, false, head)?;
        let p = rec.role().peer().as_str();
        rec.log(
            "peer",
            "propose_received",
            format!(
                "Received {p}'s Propose: {} for {}",
                zec_str(params.zec_amount),
                self.token(params.token_amount)
            ),
            None,
        );
        rec.log(
            "local",
            "dleq_verified",
            format!("Verified {p}'s DLEQ proof: {p}_p and {p}_s share one discrete log"),
            None,
        );
        rec.log(
            "peer",
            "terms_agreed",
            "Agreed the terms: nothing to presign on an EVM chain, FerryLock enforces the deadlines",
            None,
        );
        rec.pending
            .extend(actions.into_iter().map(EvmPending::from));
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

    fn check_peer_token(rec: &EvmRecord, presented: Option<&str>) -> Result<(), ApiError> {
        match rec.swap.session().peer_token() {
            Some(t) if presented.is_some_and(|p| constant_time_eq(p.as_bytes(), t.as_bytes())) => {
                Ok(())
            }
            _ => Err(ApiError(401, "missing or wrong peer token".into())),
        }
    }

    pub async fn peer_deliver(
        &self,
        id: &str,
        env: ferry_core::evm::EvmEnvelope,
        token: Option<&str>,
    ) -> Result<Delivery, ApiError> {
        let mut st = self.state.lock().await;
        let rec = st
            .swaps
            .get_mut(id)
            .ok_or(ApiError(404, "no such swap".into()))?;
        Self::check_peer_token(rec, token)?;
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
        if rec.rejected >= MAX_REJECTED || rec.received.len() >= MAX_RECEIVED {
            return Err(ApiError(429, "too many messages for this swap".into()));
        }
        let name = env.message.name();
        let result = self.process(rec, EvmEvent::Peer(env)).await;
        match &result {
            Ok(()) => rec.received.push(digest),
            Err(e) => {
                rec.rejected += 1;
                Self::log_rejected(rec, name, e);
            }
        }
        self.save(rec);
        self.publish(&mut st);
        Ok(Delivery {
            accepted: result.is_ok(),
            error: result.err().map(|e| e.to_string()),
        })
    }

    pub async fn peer_outbox(
        &self,
        id: &str,
        after: usize,
        token: Option<&str>,
    ) -> Result<Vec<ferry_core::evm::EvmEnvelope>, ApiError> {
        let st = self.state.lock().await;
        let rec = st
            .swaps
            .get(id)
            .ok_or(ApiError(404, "no such swap".into()))?;
        Self::check_peer_token(rec, token)?;
        if rec.stalled {
            return Err(ApiError(503, "stalled".into()));
        }
        Ok(rec.outbox.get(after..).unwrap_or_default().to_vec())
    }

    /// Demo fault injection: `stall`.
    /// Z stalls before claiming and wakes once the claim window has closed (refund story).
    /// B stalls after locking and never refunds (punish story).
    pub async fn fault(&self, id: &str, fault: &str) -> Result<(), ApiError> {
        if fault != "stall" {
            return Err(ApiError(400, "unknown fault".into()));
        }
        let mut st = self.state.lock().await;
        let rec = st
            .swaps
            .get_mut(id)
            .ok_or(ApiError(404, "no such swap".into()))?;
        if rec.stalled {
            return Err(ApiError(409, "already stalled".into()));
        }
        let state = rec.state();
        let allowed = match rec.role() {
            Role::Z => matches!(
                state.as_str(),
                "Negotiated" | "LockSeen" | "ZecLocked" | "ReadyReceived"
            ),
            Role::B => matches!(state.as_str(), "Locking" | "Locked" | "ZecSeen"),
        };
        if !allowed {
            return Err(ApiError(
                409,
                match rec.role() {
                    Role::Z => "Z can only stall before it claims",
                    Role::B => "B can only stall after locking and before signing Ready",
                }
                .into(),
            ));
        }
        rec.stalled = true;
        rec.resume_at_t1 = rec.role() == Role::Z;
        let label = match rec.role() {
            Role::Z => "Demo fault: Z stops responding until the claim window has closed",
            Role::B => "Demo fault: B stops responding and will not refund",
        };
        rec.log("local", "fault_injected", label, None);
        self.save(rec);
        self.publish(&mut st);
        Ok(())
    }

    // ------------------------------------------------------------------ state machine driving

    async fn process(&self, rec: &mut EvmRecord, event: EvmEvent) -> Result<(), ferry_core::Error> {
        self.apply(rec, event)?;
        self.drive_pending(rec).await;
        Ok(())
    }

    async fn drive_pending(&self, rec: &mut EvmRecord) {
        let mut queue: VecDeque<EvmEvent> = self.run_pending(rec).await.into();
        while let Some(ev) = queue.pop_front() {
            if let Err(e) = self.apply(rec, ev) {
                tracing::warn!(id = %rec.id, "follow-up event rejected: {e}");
            }
            queue.extend(self.run_pending(rec).await);
        }
    }

    fn apply(&self, rec: &mut EvmRecord, event: EvmEvent) -> Result<(), ferry_core::Error> {
        let before = rec.state();
        let actions = rec.swap.handle(event.clone())?;
        self.narrate(rec, &event, &before);
        if rec.sweep_not_before.is_none()
            && actions
                .iter()
                .any(|a| matches!(a, ferry_core::evm::EvmAction::SweepZec { .. }))
        {
            self.schedule_sweep(rec);
        }
        rec.pending
            .extend(actions.into_iter().map(EvmPending::from));
        self.save(rec);
        Ok(())
    }

    fn schedule_sweep(&self, rec: &mut EvmRecord) {
        let d = self.cli.sweep_delay_secs;
        let secs = d.min_secs + OsRng.next_u64() % (d.max_secs - d.min_secs + 1);
        rec.sweep_not_before = Some(now_ms() + secs * 1000);
        rec.log(
            "local",
            "sweep_delayed",
            format!("Waiting {secs}s before sweeping, so the ZEC sweep does not line up with the FerryLock claim or refund"),
            None,
        );
    }

    /// While stalled: keep watching, but only take transitions that need no action.
    fn observe(&self, rec: &mut EvmRecord, event: EvmEvent) {
        let before = rec.state();
        let mut probe = rec.swap.clone();
        if let Ok(actions) = probe.handle(event.clone()) {
            if actions.is_empty() {
                rec.swap = probe;
                self.narrate(rec, &event, &before);
            }
        }
    }

    async fn run_pending(&self, rec: &mut EvmRecord) -> Vec<EvmEvent> {
        let mut follow = vec![];
        let mut i = 0;
        while let Some(p) = rec.pending.get(i).cloned() {
            if rec.stalled || !self.save(rec) {
                break;
            }
            let zec = p.is_zec();
            match self.execute(rec, p).await {
                Ok(ev) => follow.extend(ev),
                // A Zcash action waiting on its chain never holds up the EVM deadline calls.
                Err(Retry) if zec => {
                    i += 1;
                    continue;
                }
                Err(Retry) => break,
            }
            rec.pending.remove(i);
        }
        self.save(rec);
        follow
    }

    async fn execute(&self, rec: &mut EvmRecord, p: EvmPending) -> Result<Option<EvmEvent>, Retry> {
        match p {
            EvmPending::Send { envelope } => {
                self.narrate_sent(rec, &envelope.message);
                rec.outbox.push(*envelope);
                Ok(None)
            }
            EvmPending::SignReady { digest } => {
                let sig =
                    ferry_evm::sign_ready_digest(&self.signer, &B256::from(bytes::<32>(&digest)));
                Ok(Some(EvmEvent::ReadySigned { sig }))
            }
            EvmPending::Lock { salt, terms } => self.exec_lock(rec, &salt, &terms).await,
            EvmPending::Claim {
                id,
                z,
                ready_sig,
                not_after,
            } => {
                if rec.evm_tx("claim").is_some() {
                    return Ok(None);
                }
                let now = self.chain_now(rec).await?;
                // A claim that lands at or after t1 reverts but still publishes z.
                if now >= not_after {
                    rec.log(
                        "local",
                        "claim_too_late",
                        "Too close to t1 to claim safely: not sending the claim. B refunds after t1 and Z reclaims its ZEC",
                        None,
                    );
                    return Ok(None);
                }
                let id = B256::from(bytes::<32>(&id));
                let sig = bytes::<65>(&ready_sig);
                match self.client.claim(id, z.expose(), U256::ZERO, &sig).await {
                    Ok(tx) => {
                        rec.mine_revealed = true;
                        let amount = rec.swap.session().params.token_amount;
                        let hash = tx.tx_hash.to_string();
                        rec.set_evm_tx("claim", hash.clone(), Some(tx.block_number));
                        rec.log(
                            "btc",
                            "btc_redeem_broadcast",
                            format!(
                                "Claimed {} from FerryLock with B's Ready signature. The claim publishes z in its calldata",
                                self.token(amount)
                            ),
                            Some(hash),
                        );
                        self.fill_height(rec, "claim", tx.block_number);
                        Ok(None)
                    }
                    Err(e) => {
                        tracing::warn!(id = %rec.id, "claim (nothing sent): {e}");
                        Err(Retry)
                    }
                }
            }
            EvmPending::Refund {
                id,
                b,
                not_before,
                not_after,
            } => {
                if rec.evm_tx("refund").is_some() {
                    return Ok(None);
                }
                let now = self.chain_now(rec).await?;
                if now < not_before {
                    return Err(Retry);
                }
                if now >= not_after {
                    if !rec.has("refund_too_late") {
                        rec.log(
                            "local",
                            "refund_too_late",
                            "Too close to t2 to refund safely: not sending the refund",
                            None,
                        );
                    }
                    return Ok(None);
                }
                let id = B256::from(bytes::<32>(&id));
                match self.client.refund(id, b.expose()).await {
                    Ok(tx) => {
                        rec.mine_revealed = true;
                        let hash = tx.tx_hash.to_string();
                        rec.set_evm_tx("refund", hash.clone(), Some(tx.block_number));
                        rec.log(
                            "btc",
                            "refund_broadcast",
                            "t1 passed without a claim. Refunded from FerryLock; the refund publishes b in its calldata",
                            Some(hash),
                        );
                        self.fill_height(rec, "refund", tx.block_number);
                        Ok(None)
                    }
                    Err(e) => {
                        tracing::warn!(id = %rec.id, "refund (nothing sent): {e}");
                        Err(Retry)
                    }
                }
            }
            EvmPending::Punish { id } => {
                if rec.evm_tx("punish").is_some() {
                    return Ok(None);
                }
                let id = B256::from(bytes::<32>(&id));
                match self.client.punish(id).await {
                    Ok(tx) => {
                        let hash = tx.tx_hash.to_string();
                        rec.set_evm_tx("punish", hash.clone(), Some(tx.block_number));
                        rec.log(
                            "btc",
                            "punish_broadcast",
                            "t2 passed without a refund. Called punish: the locked tokens go to Z",
                            Some(hash),
                        );
                        self.fill_height(rec, "punish", tx.block_number);
                        Ok(None)
                    }
                    Err(e) => {
                        tracing::warn!(id = %rec.id, "punish: {e}");
                        Err(Retry)
                    }
                }
            }
            EvmPending::SendZec { fvk, amount } => self.exec_send_zec(rec, &fvk, amount).await,
            EvmPending::SweepZec { fvk, ask } => {
                if rec.swap.is_final() {
                    return Ok(None);
                }
                if rec.zec_sweep_txid.is_some() {
                    return Err(Retry);
                }
                if rec.sweep_not_before.is_some_and(|t| now_ms() < t) {
                    return Err(Retry);
                }
                let fvk = fvk_from_hex(&fvk);
                let lock_value = rec.swap.session().params.zec_amount;
                match self.leg.sweep(&fvk, ask.expose(), lock_value).await {
                    Ok(txid) => {
                        rec.zec_sweep_txid = Some(txid.clone());
                        let (kind, label) = match rec.role() {
                            Role::B => (
                                "zec_sweep_broadcast",
                                "Swept the joint note to B's own shielded address, signing with ask = σ(z + b)",
                            ),
                            Role::Z => (
                                "zec_reclaim_broadcast",
                                "Swept the joint note back to Z's own shielded address",
                            ),
                        };
                        rec.log("zec", kind, label, Some(txid));
                        Err(Retry)
                    }
                    Err(e) => {
                        tracing::warn!(id = %rec.id, "zec sweep: {e}");
                        if rec.state() == "ZecReclaiming"
                            && matches!(self.leg.lock_lapsed(&fvk, lock_value).await, Ok(true))
                        {
                            self.lock_lapsed(rec);
                            return Ok(None);
                        }
                        Err(Retry)
                    }
                }
            }
        }
    }

    /// Latest block time (also kept on the record for the view).
    async fn chain_now(&self, rec: &mut EvmRecord) -> Result<u64, Retry> {
        match self.client.latest_timestamp().await {
            Ok(t) => {
                rec.now = rec.now.max(t);
                Ok(t)
            }
            Err(e) => {
                tracing::warn!(id = %rec.id, "EVM node: {e}");
                Err(Retry)
            }
        }
    }

    async fn exec_lock(
        &self,
        rec: &mut EvmRecord,
        salt: &str,
        terms: &LockTerms,
    ) -> Result<Option<EvmEvent>, Retry> {
        let id = B256::from(rec.swap.session().swap_id());
        // Already locked (a crash after sending, or a rebroadcast): never lock twice.
        match self.client.swap(id).await {
            Ok(s) if s.state != ferry_evm::SwapState::None => return Ok(None),
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(id = %rec.id, "EVM node: {e}");
                return Err(Retry);
            }
        }
        let now = self.chain_now(rec).await?;
        if now >= terms.t1 {
            rec.log(
                "local",
                "lock_window_passed",
                "t1 passed before the lock went out: nothing is locked",
                None,
            );
            return Ok(None);
        }
        let salt = B256::from(bytes::<32>(salt));
        match self.client.lock(salt, &to_terms(terms)).await {
            Ok((_, tx)) => {
                let hash = tx.tx_hash.to_string();
                rec.set_evm_tx("lock", hash.clone(), Some(tx.block_number));
                rec.log(
                    "btc",
                    "btc_lock_broadcast",
                    format!(
                        "Locked {} in FerryLock for Z, committed to address(Z_s) and address(B_s)",
                        self.token(terms.amount)
                    ),
                    Some(hash),
                );
                self.fill_height(rec, "lock", tx.block_number);
                Ok(None)
            }
            Err(e) => {
                tracing::warn!(id = %rec.id, "lock: {e}");
                Err(Retry)
            }
        }
    }

    /// Same rules as the Bitcoin daemon's ZEC lock: an intent persisted before calling the
    /// wallet, never a second send, and a refused or lapsed lock fed back to the machine.
    async fn exec_send_zec(
        &self,
        rec: &mut EvmRecord,
        fvk: &str,
        amount: u64,
    ) -> Result<Option<EvmEvent>, Retry> {
        let fvk = fvk_from_hex(fvk);
        if !rec.swap.zec_locked() {
            return Ok(None);
        }
        if rec.state() != "ZecLocked" {
            if rec.zec_lock_txid.is_none() && !rec.has("zec_send_stopped") {
                rec.log(
                    "local",
                    "zec_send_stopped",
                    "Stopped trying to lock ZEC: the swap is past the lock. No ZEC is sent from here on",
                    None,
                );
            }
            return Ok(None);
        }
        if rec.zec_send_intent {
            if rec.zec_lock_txid.is_some() {
                return Ok(None);
            }
            match self.leg.watch(&fvk).await {
                Ok(notes) => {
                    if let Some(n) = notes.iter().find(|n| n.value >= amount) {
                        rec.zec_lock_txid = Some(n.txid.clone());
                        return Ok(None);
                    }
                }
                Err(e) => tracing::warn!(id = %rec.id, "zec watch: {e}"),
            }
            if matches!(self.leg.lock_lapsed(&fvk, amount).await, Ok(true)) {
                self.lock_lapsed(rec);
                return Ok(None);
            }
            if !rec.has("zec_send_uncertain") {
                rec.log(
                    "local",
                    "zec_send_uncertain",
                    "The ZEC send may not have completed. Waiting for the lock note instead of sending again",
                    None,
                );
            }
            return Err(Retry);
        }
        rec.zec_send_intent = true;
        if !self.save(rec) {
            rec.zec_send_intent = false;
            return Err(Retry);
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
            Err(e) => match self.leg.send_failure(&e) {
                SendFailure::Refused => {
                    rec.zec_send_intent = false;
                    rec.log(
                        "local",
                        "zec_lock_refused",
                        format!(
                            "Refused to lock ZEC, nothing was sent: {e}. The swap now waits for t1 and B's refund"
                        ),
                        None,
                    );
                    if let Err(err) = self.apply(rec, EvmEvent::ZecLockRefused) {
                        tracing::error!(id = %rec.id, "applying the refused lock: {err}");
                    }
                    Ok(None)
                }
                SendFailure::NotSent => {
                    rec.zec_send_intent = false;
                    self.save(rec);
                    tracing::warn!(id = %rec.id, "zec send (nothing sent, will retry): {e}");
                    Err(Retry)
                }
                SendFailure::MaybeSent => {
                    tracing::warn!(id = %rec.id, "zec send: {e}");
                    Err(Retry)
                }
            },
        }
    }

    fn lock_lapsed(&self, rec: &mut EvmRecord) {
        rec.log(
            "zec",
            "zec_lock_lapsed",
            "The ZEC lock never reached the chain and its transaction has expired, so no ZEC is locked",
            None,
        );
        if let Err(err) = self.apply(rec, EvmEvent::ZecLockLapsed) {
            tracing::error!(id = %rec.id, "applying the lapsed lock: {err}");
        }
    }

    fn fill_height(&self, rec: &mut EvmRecord, key: &str, block: u64) {
        let Some(hash) = rec.evm_tx(key).map(|t| t.hash.clone()) else {
            return;
        };
        for e in rec
            .timeline
            .iter_mut()
            .filter(|e| e.txid.as_deref() == Some(hash.as_str()))
        {
            e.height.get_or_insert(block);
        }
    }

    // ------------------------------------------------------------------ narration

    fn narrate_sent(&self, rec: &mut EvmRecord, msg: &EvmMessage) {
        let (kind, label) = match msg {
            EvmMessage::Accept { .. } => (
                "accept_sent",
                format!(
                    "Sent Accept with {}'s points, DLEQ proof and EVM account. Derived the joint Ironwood address",
                    self.role.as_str()
                ),
            ),
            EvmMessage::ReadySig { .. } => (
                "redeem_adaptor_sent",
                "Signed Ready(id) (EIP-712) and sent it to Z: Z may now claim. Nothing goes on chain".into(),
            ),
            EvmMessage::Propose { .. } => return,
        };
        rec.log("peer", kind, label, None);
    }

    fn narrate(&self, rec: &mut EvmRecord, event: &EvmEvent, before: &str) {
        if let (EvmEvent::Peer(env), Role::Z) = (event, rec.role()) {
            if let EvmMessage::ReadySig { .. } = env.message {
                rec.log(
                    "peer",
                    "redeem_adaptor_received",
                    "Received B's Ready(id) signature and checked it recovers to B's account",
                    None,
                );
            }
        }
        let after = rec.state();
        if after == before {
            return;
        }
        let p = rec.swap.session().params.clone();
        let tx = |rec: &EvmRecord, k: &str| rec.evm_tx(k).map(|t| t.hash.clone());
        match (rec.role(), after.as_str()) {
            (Role::Z, "LockSeen" | "ZecLocked") if !rec.has("btc_lock_seen") => rec.log(
                "btc",
                "btc_lock_seen",
                format!(
                    "FerryLock holds {} for this swap, and every term matches: token, amount, deadlines, our payout address and the commitments to Z_s and B_s",
                    self.token(p.token_amount)
                ),
                tx(rec, "lock"),
            ),
            (Role::B, "Locked") => rec.log(
                "btc",
                "evm_lock_confirmed",
                "The lock is confirmed. Waiting for Z's ZEC",
                tx(rec, "lock"),
            ),
            (Role::Z, "Claimed") => rec.log(
                "local",
                "swap_complete",
                format!("Swap complete. {} is at Z's address", self.token(p.token_amount)),
                None,
            ),
            (Role::Z, "Expired") => rec.log(
                "local",
                "cancel_seen",
                "t1 passed without a claim: waiting for B's refund (or t2)",
                None,
            ),
            (Role::Z, "ZecReclaiming") => {
                rec.peer_learned = true;
                rec.log(
                    "btc",
                    "secret_extracted",
                    "Read b from B's refund. Z can now spend the joint note on its own",
                    tx(rec, "refund"),
                );
            }
            (Role::Z, "Refunded") if !rec.has("secret_extracted") => {
                rec.peer_learned = true;
                rec.log(
                    "btc",
                    "secret_extracted",
                    "Read b from B's refund. No ZEC was locked, so there is nothing to reclaim",
                    tx(rec, "refund"),
                );
            }
            (Role::Z, "ZecReclaimed") => rec.log(
                "local",
                "reclaimed",
                format!("{} is back in Z's own Ironwood notes", zec_str(p.zec_amount)),
                None,
            ),
            (Role::Z, "Punished") => rec.log(
                "local",
                "punished",
                format!(
                    "Z holds the {}. Z's ZEC stays in the joint note, which is B's penalty for not refunding",
                    p.token_symbol
                ),
                None,
            ),
            (Role::B, "ZecSeen" | "ReadySigning") => {
                if !rec.has("zec_note_seen") {
                    rec.log(
                        "zec",
                        "zec_note_seen",
                        "Found the lock note at the joint address with the shared viewing key",
                        rec.zec_lock_txid.clone(),
                    );
                }
                if after == "ReadySigning" {
                    rec.log(
                        "zec",
                        "zec_confirmed",
                        format!(
                            "Lock note has {} confirmations and holds {}",
                            p.zec_confirmations,
                            zec_str(p.zec_amount)
                        ),
                        None,
                    );
                }
            }
            (Role::B, "Claimed") => {
                rec.peer_learned = true;
                rec.log(
                    "btc",
                    "secret_extracted",
                    "Read z from Z's claim (calldata and event) and checked it against Z's points. B can now spend the joint Ironwood note",
                    tx(rec, "claim"),
                );
            }
            (Role::B, "Refunding") => rec.log(
                "btc",
                "cancel_seen",
                "t1 passed without a claim: the swap is called off. Refunding from FerryLock",
                None,
            ),
            (Role::B, "ZecSwept") => rec.log(
                "local",
                "swap_complete",
                format!(
                    "Swap complete. B holds {} in its own Ironwood notes",
                    zec_str(p.zec_amount)
                ),
                None,
            ),
            (Role::B, "Refunded") => rec.log(
                "local",
                "refunded",
                format!(
                    "{} is back at B's address. Revealing b unlocks nothing for B",
                    p.token_symbol
                ),
                None,
            ),
            (Role::B, "Punished") => rec.log(
                "btc",
                "punish_seen",
                format!(
                    "Z took the locked {} with punish after t2. B never refunded",
                    p.token_symbol
                ),
                tx(rec, "punish"),
            ),
            (_, "Aborted") => rec.log(
                "local",
                "aborted",
                "Nothing was locked before the deadline",
                None,
            ),
            _ => {}
        }
    }

    fn log_rejected(rec: &mut EvmRecord, message: &str, e: &ferry_core::Error) {
        let peer = rec.role().peer().as_str();
        match e {
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

    // ------------------------------------------------------------------ driver

    pub async fn run(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_millis(self.cli.poll_ms));
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
            let Some(rec) = st.swaps.get_mut(&id) else {
                continue;
            };
            if rec.settled() {
                continue;
            }
            match AssertUnwindSafe(self.tick_swap(rec)).catch_unwind().await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => tracing::warn!(%id, "tick: {e}"),
                Err(_) => tracing::error!(%id, "tick panicked; the swap is kept and retried"),
            }
            self.save(rec);
        }
        self.publish(&mut st);
    }

    async fn tick_swap(&self, rec: &mut EvmRecord) -> anyhow::Result<()> {
        if !rec.stalled {
            self.drive_pending(rec).await;
            if rec.taker {
                self.exchange(rec).await;
            }
        }
        self.maybe_timeout(rec).await;
        for ev in self.chain_events(rec).await {
            if rec.stalled {
                self.observe(rec, ev);
            } else if let Err(e) = self.process(rec, ev).await {
                tracing::warn!(id = %rec.id, "chain event rejected: {e}");
                if matches!(e, ferry_core::Error::LockMismatch) && !rec.has("evm_lock_mismatch") {
                    rec.log(
                        "btc",
                        "evm_lock_mismatch",
                        "The lock on chain does not have the agreed terms. No ZEC will be locked",
                        None,
                    );
                }
            }
        }
        // Z's stall ends once no claim can land any more (the refund story).
        if rec.stalled && rec.resume_at_t1 && rec.now >= rec.swap.session().params.t1 {
            rec.stalled = false;
            rec.resume_at_t1 = false;
            rec.log(
                "local",
                "fault_cleared",
                "Z is back online; the claim window has closed",
                None,
            );
        }
        Ok(())
    }

    async fn exchange(&self, rec: &mut EvmRecord) {
        let base = format!("{}/peer/swaps/{}/messages", rec.counterparty, rec.id);
        let token = rec.swap.session().peer_token().unwrap_or_default();
        while rec.sent < rec.outbox.len() {
            let resp = self
                .http
                .post(&base)
                .bearer_auth(&token)
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
            .bearer_auth(&token)
            .send()
            .await;
        let Ok(r) = resp.and_then(|r| r.error_for_status()) else {
            return;
        };
        let Ok(msgs) = r.json::<Vec<ferry_core::evm::EvmEnvelope>>().await else {
            return;
        };
        for env in msgs {
            rec.peer_seen += 1;
            let name = env.message.name();
            if let Err(e) = self.process(rec, EvmEvent::Peer(env)).await {
                Self::log_rejected(rec, name, &e);
            }
        }
    }

    async fn maybe_timeout(&self, rec: &mut EvmRecord) {
        let deadline = rec.created_ms + self.cli.negotiation_timeout_secs * 1000;
        if rec.created_ms == 0 || now_ms() < deadline || rec.swap.is_final() {
            return;
        }
        if let Err(e) = self.process(rec, EvmEvent::Timeout).await {
            tracing::warn!(id = %rec.id, "timeout: {e}");
        }
    }

    async fn chain_events(&self, rec: &mut EvmRecord) -> Vec<EvmEvent> {
        let mut out = vec![];
        match self.evm_observation(rec).await {
            Ok(o) => out.push(EvmEvent::Chain(EvmChainEvent::Observed(o))),
            Err(e) => tracing::warn!(id = %rec.id, "EVM watch: {e}"),
        }
        if let Err(e) = self.zec_events(rec, &mut out).await {
            tracing::warn!(id = %rec.id, "zcash watch (skipped this tick): {e}");
        }
        self.zec_observer(rec).await;
        out
    }

    /// Everything FerryLock's events say about this swap, up to the latest block.
    async fn evm_observation(&self, rec: &mut EvmRecord) -> anyhow::Result<EvmObservation> {
        let (head, now) = self.client.latest_block().await?;
        rec.now = rec.now.max(now);
        let id = B256::from(rec.swap.session().swap_id());
        let events = self.client.events(id, rec.from_block, head).await?;
        let mut o = EvmObservation {
            now,
            ..Default::default()
        };
        let confs = |block: u64| (head + 1).saturating_sub(block) as u32;
        let p = rec.swap.session().params.clone();
        for ev in events {
            let c = confs(ev.block_number);
            let hash = ev.tx_hash.to_string();
            let (key, line) = match &ev.kind {
                SwapEventKind::Locked(t) => {
                    o.lock = Some(ObservedLock {
                        terms: from_terms(t),
                        confs: c,
                    });
                    (
                        "lock",
                        format!(
                            "FerryLock.lock: {} from {} under swap 0x{}…, payable to {} with z, refundable to {} with b after t1. A visible call to a swap contract, with the amount, both addresses and both deadlines (tx {}…).",
                            self.token(p.token_amount),
                            short_addr(&t.refunder),
                            &hex::encode(id)[..8],
                            short_addr(&t.claimer),
                            short_addr(&t.refunder),
                            &hash[..10]
                        ),
                    )
                }
                SwapEventKind::Claimed { z, caller, tip } => {
                    o.claimed = Some((*z, c));
                    (
                        "claim",
                        format!(
                            "FerryLock.claim: publishes a 32-byte scalar (Z's share z) in calldata and in the Claimed event; pays {} to {}{} (sent by {}, tx {}…). Nothing here points to Zcash.",
                            self.token(p.token_amount - u64::try_from(*tip).unwrap_or(0)),
                            short_addr(&ferry_evm::Address::from(p_claimer(rec))),
                            if tip.is_zero() { String::new() } else { format!(" and a {} tip", self.token(u64::try_from(*tip).unwrap_or(0))) },
                            short_addr(caller),
                            &hash[..10]
                        ),
                    )
                }
                SwapEventKind::Refunded { b } => {
                    o.refunded = Some((*b, c));
                    (
                        "refund",
                        format!(
                            "FerryLock.refund: publishes B's share b in calldata and in the Refunded event; returns {} to B after t1 (tx {}…). The swap's abort is public.",
                            self.token(p.token_amount),
                            &hash[..10]
                        ),
                    )
                }
                SwapEventKind::Punished => {
                    o.punished = Some(c);
                    (
                        "punish",
                        format!(
                            "FerryLock.punish: after t2 with no refund, {} goes to Z's address; no secret is revealed (tx {}…).",
                            self.token(p.token_amount),
                            &hash[..10]
                        ),
                    )
                }
            };
            let first = rec.set_evm_tx(key, hash.clone(), Some(ev.block_number));
            EvmRecord::set_observer(&mut rec.observer_evm, key, line);
            self.fill_height(rec, key, ev.block_number);
            if first && (key == "claim" || key == "refund") {
                // Someone else's call (or a relayer's): it goes on the timeline too.
                let label = match key {
                    "claim" => "Saw Z's claim on FerryLock: z is now public",
                    _ => "Saw B's refund on FerryLock: b is now public",
                };
                rec.log("btc", &format!("{key}_seen"), label, Some(hash));
                self.fill_height(rec, key, ev.block_number);
            }
        }
        Ok(o)
    }

    async fn zec_events(&self, rec: &mut EvmRecord, out: &mut Vec<EvmEvent>) -> anyhow::Result<()> {
        if !rec.swap.lock_seen() {
            return Ok(());
        }
        let fvk = rec.swap.session().joint_fvk()?;
        let amount = rec.swap.session().params.zec_amount;
        let notes = self.leg.watch(&fvk).await?;
        let lock = notes
            .iter()
            .filter(|n| n.value >= amount)
            .find(|n| rec.zec_lock_txid.as_deref() == Some(n.txid.as_str()))
            .or_else(|| notes.iter().find(|n| n.value >= amount))
            .cloned();
        if let Some(lock) = &lock {
            if rec.role() == Role::B {
                rec.zec_lock_txid.get_or_insert(lock.txid.clone());
            }
            let ours_live = |t: &str| notes.iter().any(|n| n.spent_by.as_deref() == Some(t));
            if lock.spent_by.is_none()
                && rec.zec_sweep_txid.as_deref().is_some_and(|t| !ours_live(t))
            {
                rec.zec_sweep_txid = None;
                rec.log(
                    "zec",
                    "zec_sweep_expired",
                    "The ZEC sweep expired without being mined. The lock note is unspent again; sweeping it again",
                    None,
                );
            }
            if rec.zec_spent_by != lock.spent_by {
                rec.zec_spent_by = lock.spent_by.clone();
                rec.observer_zec.retain(|(k, _)| k != "sweep");
            }
        }
        let lock_spent_by = lock.and_then(|n| n.spent_by);
        for note in notes {
            out.push(EvmEvent::Chain(EvmChainEvent::ZecNoteSeen {
                value: note.value,
                confs: note.confirmations,
                spent: note.spent_by.is_some(),
            }));
        }
        if let Some(txid) = rec.zec_sweep_txid.clone() {
            if lock_spent_by.as_deref() == Some(txid.as_str()) {
                if let Some(confs) = self.leg.confirmations(&txid).await? {
                    out.push(EvmEvent::Chain(EvmChainEvent::ZecSwept { confs }));
                }
            }
        }
        // Timeline heights of ZEC transactions, from their confirmations.
        let zec_tip = self.leg.status().await.ok().map(|s| s.height);
        for i in 0..rec.timeline.len() {
            let e = &rec.timeline[i];
            if e.chain != "zec" || e.height.is_some() {
                continue;
            }
            let Some(txid) = e.txid.clone() else { continue };
            if let (Some(tip), Ok(Some(c))) = (zec_tip, self.leg.confirmations(&txid).await) {
                if c > 0 {
                    rec.timeline[i].height = Some(tip + 1 - u64::from(c));
                }
            }
        }
        Ok(())
    }

    async fn zec_observer(&self, rec: &mut EvmRecord) {
        let sweep = rec.zec_spent_by.clone().or(rec.zec_sweep_txid.clone());
        for (key, txid) in [("lock", rec.zec_lock_txid.clone()), ("sweep", sweep)] {
            let Some(txid) = txid else { continue };
            if rec.observer_zec.iter().any(|(k, _)| k == key) {
                continue;
            }
            if let Ok(Some(line)) = self.leg.describe_tx(&txid).await {
                // The Zcash leg describes itself against Bitcoin; here the other chain is EVM.
                let line = line.replace("Bitcoin", "the EVM chain");
                EvmRecord::set_observer(&mut rec.observer_zec, key, line);
            }
        }
    }
}

fn short_addr(a: &Address) -> String {
    let s = a.to_checksum(None);
    format!("{}…{}", &s[..6], &s[s.len() - 4..])
}

fn p_claimer(rec: &EvmRecord) -> [u8; 20] {
    rec.swap.session().evm_addresses().0
}
