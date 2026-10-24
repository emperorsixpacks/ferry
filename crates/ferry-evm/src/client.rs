//! FerryLock client: lock / claim / refund / punish and reads.

use std::time::Duration;

use alloy::network::{EthereumWallet, ReceiptResponse};
use alloy::primitives::{Address, B256, U256};
use alloy::providers::{DynProvider, PendingTransactionBuilder, Provider, ProviderBuilder};
use alloy::rpc::client::ClientBuilder;
use alloy::signers::local::PrivateKeySigner;
use alloy::transports::http::{reqwest, Http};
use alloy::transports::layers::RetryBackoffLayer;

use crate::bindings::{FerryLock, IERC20};
use crate::{address, swap_id, Error, Terms};

/// One RPC request may take this long; a hung public endpoint must not stall the daemon.
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// Rate-limited (HTTP 429/503, or a "rate limit" JSON-RPC error) requests are retried this many
/// times, `RPC_BACKOFF_MS` apart plus a share of the request budget below.
const RPC_RETRIES: u32 = 8;
const RPC_BACKOFF_MS: u64 = 1_000;
/// Request budget in compute units per second (alloy counts about 20 per request, so ~10 req/s).
const RPC_COMPUTE_UNITS: u64 = 200;
/// A sent transaction not mined by then is reported as an error. Every call re-reads the swap
/// (or allowance) first, so a retry never repeats a transaction that landed; one still pending
/// can be sent again with the next nonce, and that copy reverts without revealing anything new.
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(180);

/// `FerryLock.State`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapState {
    None,
    Locked,
    Claimed,
    Refunded,
    Punished,
}

impl SwapState {
    fn from_u8(v: u8) -> Result<Self, Error> {
        Ok(match v {
            0 => SwapState::None,
            1 => SwapState::Locked,
            2 => SwapState::Claimed,
            3 => SwapState::Refunded,
            4 => SwapState::Punished,
            _ => return Err(Error::Rpc(format!("unknown swap state {v}"))),
        })
    }

    /// Tokens are still in the contract.
    pub fn is_open(self) -> bool {
        self == SwapState::Locked
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OnChainSwap {
    pub terms: Terms,
    pub state: SwapState,
}

/// What an ERC-20 says about itself (`symbol()`, `decimals()`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenInfo {
    pub symbol: String,
    pub decimals: u8,
}

/// A mined, successful transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TxInfo {
    pub tx_hash: B256,
    pub block_number: u64,
}

/// What the node knows about a transaction we sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxStatus {
    /// Neither mined nor in the node's mempool: dropped, or it never arrived.
    Unknown,
    Pending,
    /// Mined; `ok` is false if it reverted.
    Mined {
        ok: bool,
        block: u64,
    },
}

/// One account talking to one FerryLock deployment.
#[derive(Clone, Debug)]
pub struct EvmClient {
    provider: DynProvider,
    contract: Address,
    from: Address,
    /// Largest block range per `eth_getLogs` request.
    pub(crate) log_chunk: u64,
}

impl EvmClient {
    /// HTTP provider signing with `signer` (gas, nonce and chain id filled automatically).
    /// Requests time out after 30 s, and rate-limited ones are retried with a backoff, since
    /// public endpoints such as https://sepolia.base.org throttle.
    pub fn connect_http(
        rpc_url: &str,
        contract: Address,
        signer: PrivateKeySigner,
    ) -> Result<Self, Error> {
        let url: reqwest::Url = rpc_url.parse().map_err(|e| Error::Url(format!("{e}")))?;
        let http = reqwest::Client::builder()
            .timeout(RPC_TIMEOUT)
            .build()
            .map_err(|e| Error::Rpc(e.to_string()))?;
        let transport = Http::with_client(http, url);
        let local = transport.guess_local();
        let client = ClientBuilder::default()
            .layer(RetryBackoffLayer::new(
                RPC_RETRIES,
                RPC_BACKOFF_MS,
                RPC_COMPUTE_UNITS,
            ))
            .transport(transport, local);
        let from = signer.address();
        // The nonce comes from the node on every send. alloy's default cache counts a nonce as
        // used even when the send then fails, which on a flaky public RPC would leave every
        // later transaction (a claim, a refund) waiting behind a gap.
        let provider = ProviderBuilder::new()
            .disable_recommended_fillers()
            .with_gas_estimation()
            .with_simple_nonce_management()
            .fetch_chain_id()
            .wallet(EthereumWallet::from(signer))
            .connect_client(client)
            .erased();
        Ok(Self::from_provider(provider, contract, from))
    }

    /// Use an existing provider whose wallet signs for `from`.
    pub fn from_provider(provider: DynProvider, contract: Address, from: Address) -> Self {
        EvmClient {
            provider,
            contract,
            from,
            log_chunk: 2_000,
        }
    }

    pub fn with_log_chunk(mut self, blocks: u64) -> Self {
        self.log_chunk = blocks.max(1);
        self
    }

    pub fn provider(&self) -> &DynProvider {
        &self.provider
    }

    /// The same node and account, talking to another FerryLock deployment.
    pub fn at(&self, contract: Address) -> EvmClient {
        EvmClient {
            contract,
            ..self.clone()
        }
    }

    pub fn contract(&self) -> Address {
        self.contract
    }

    /// Our account.
    pub fn address(&self) -> Address {
        self.from
    }

    fn lock_contract(&self) -> FerryLock::FerryLockInstance<DynProvider> {
        FerryLock::new(self.contract, self.provider.clone())
    }

    pub async fn block_number(&self) -> Result<u64, Error> {
        Ok(self.provider.get_block_number().await?)
    }

    /// Timestamp of the latest block: what the contract's windows compare against.
    pub async fn latest_timestamp(&self) -> Result<u64, Error> {
        Ok(self.latest_block().await?.1)
    }

    /// Number and timestamp of the latest block, from one response (so a log scan up to that
    /// number and the time it is judged at agree).
    pub async fn latest_block(&self) -> Result<(u64, u64), Error> {
        let block = self
            .provider
            .get_block(alloy::eips::BlockId::latest())
            .await?
            .ok_or_else(|| Error::Rpc("no latest block".into()))?;
        Ok((block.header.number, block.header.timestamp))
    }

    /// Our native balance (wei), for gas.
    pub async fn eth_balance(&self) -> Result<U256, Error> {
        Ok(self.provider.get_balance(self.from).await?)
    }

    pub async fn chain_id(&self) -> Result<u64, Error> {
        Ok(self.provider.get_chain_id().await?)
    }

    /// The code at `contract()` is exactly the FerryLock this build was compiled against (it
    /// has no immutables, so the deployed code equals the compiled runtime code).
    pub async fn check_deployment(&self) -> Result<(), Error> {
        let code = self.provider.get_code_at(self.contract).await?;
        if code != FerryLock::DEPLOYED_BYTECODE {
            return Err(Error::UnknownContract);
        }
        Ok(())
    }

    /// The token's own `symbol()` and `decimals()`. An address without code, or a token whose
    /// `symbol()` is not an ABI string (some old tokens return bytes32), is an error.
    pub async fn token_info(&self, token: Address) -> Result<TokenInfo, Error> {
        if self.provider.get_code_at(token).await?.is_empty() {
            return Err(Error::Rpc(format!("no contract at {token}")));
        }
        let t = IERC20::new(token, &self.provider);
        Ok(TokenInfo {
            symbol: t.symbol().call().await?,
            decimals: t.decimals().call().await?,
        })
    }

    pub async fn token_balance(&self, token: Address, who: Address) -> Result<U256, Error> {
        Ok(IERC20::new(token, &self.provider)
            .balanceOf(who)
            .call()
            .await?)
    }

    pub async fn swap(&self, id: B256) -> Result<OnChainSwap, Error> {
        let r = self.lock_contract().getSwap(id).call().await?;
        Ok(OnChainSwap {
            terms: r.terms,
            state: SwapState::from_u8(r.state)?,
        })
    }

    /// Z, before locking any ZEC: the lock exists, is still open, and every term matches what
    /// was agreed. Z must also have checked the deployment ([`EvmClient::check_deployment`])
    /// and that `expected.token` is the agreed token.
    pub async fn check_lock(&self, id: B256, expected: &Terms) -> Result<OnChainSwap, Error> {
        let s = self.swap(id).await?;
        if s.state != SwapState::Locked {
            return Err(Error::WrongState(s.state, "Locked"));
        }
        let t = &s.terms;
        let checks = [
            (t.token == expected.token, "token"),
            (t.amount == expected.amount, "amount"),
            (t.zAddr == expected.zAddr, "zAddr"),
            (t.bAddr == expected.bAddr, "bAddr"),
            (t.claimer == expected.claimer, "claimer"),
            (t.refunder == expected.refunder, "refunder"),
            (t.t1 == expected.t1, "t1"),
            (t.t2 == expected.t2, "t2"),
            (t.maxTip == expected.maxTip, "maxTip"),
        ];
        if let Some((_, what)) = checks.iter().find(|(ok, _)| !ok) {
            return Err(Error::TermsMismatch(what));
        }
        Ok(s)
    }

    /// B: approve the contract if needed, then lock `terms.amount` of `terms.token`.
    /// Returns the swap id and the lock transaction.
    pub async fn lock(&self, salt: B256, terms: &Terms) -> Result<(B256, TxInfo), Error> {
        let token = IERC20::new(terms.token, &self.provider);
        let allowance = token.allowance(self.from, self.contract).call().await?;
        if allowance < terms.amount {
            let approve = token.approve(self.contract, terms.amount);
            simulate(approve.call().await.map(|_| ()))?;
            confirmed(approve.send().await?).await?;
        }
        let c = self.lock_contract();
        let call = c.lock(salt, terms.clone());
        simulate(call.call().await.map(|_| ()))?;
        let tx = confirmed(call.send().await?).await?;
        Ok((swap_id(self.from, salt), tx))
    }

    /// Claim for Z by publishing `z` (big-endian secp256k1 scalar) with B's EIP-712
    /// `Ready(id)` signature, taking `tip` of the tokens for the sender. Refuses to broadcast
    /// unless the share and signature check out and a simulation passes, because a reverted
    /// claim would still publish `z`.
    pub async fn claim(
        &self,
        id: B256,
        z: &[u8; 32],
        tip: U256,
        ready_sig: &[u8; 65],
    ) -> Result<TxInfo, Error> {
        let s = self.swap(id).await?;
        if s.state != SwapState::Locked {
            return Err(Error::WrongState(s.state, "Locked"));
        }
        address::verify_share(z, s.terms.zAddr)?;
        let digest = crate::ready_digest(self.chain_id().await?, self.contract, id);
        if crate::ready_signer(&digest, ready_sig) != Some(s.terms.refunder) {
            return Err(Error::WouldRevert("not B's ready signature".into()));
        }
        let c = self.lock_contract();
        let call = c.claim(
            id,
            U256::from_be_bytes(*z),
            tip,
            alloy::primitives::Bytes::copy_from_slice(ready_sig),
        );
        simulate(call.call().await.map(|_| ()))?;
        confirmed(call.send().await?).await
    }

    /// Refund to B by publishing `b`. Same pre-checks as [`EvmClient::claim`]: a reverted
    /// refund (sent before t1) would hand Z b while Z can still claim the tokens.
    pub async fn refund(&self, id: B256, b: &[u8; 32]) -> Result<TxInfo, Error> {
        self.check_refund(id, b).await?;
        let c = self.lock_contract();
        let call = c.refund(id, U256::from_be_bytes(*b));
        simulate(call.call().await.map(|_| ()))?;
        confirmed(call.send().await?).await
    }

    /// [`EvmClient::refund`] without waiting for it to be mined (a watchtower follows it with
    /// [`EvmClient::tx_status`]). The same pre-checks, then `eth_call` and `eth_estimateGas`;
    /// nothing is sent if any of them fails. The caller enforces the `t2 − Δ` end of the window.
    pub async fn submit_refund(&self, id: B256, b: &[u8; 32]) -> Result<B256, Error> {
        self.check_refund(id, b).await?;
        let c = self.lock_contract();
        submit(c.refund(id, U256::from_be_bytes(*b))).await
    }

    async fn check_refund(&self, id: B256, b: &[u8; 32]) -> Result<(), Error> {
        let s = self.swap(id).await?;
        if !s.state.is_open() {
            return Err(Error::WrongState(s.state, "Locked"));
        }
        address::verify_share(b, s.terms.bAddr)?;
        let now = self.latest_timestamp().await?;
        if now < s.terms.t1 {
            return Err(Error::WouldRevert(format!(
                "latest block time {now} is before t1 {}",
                s.terms.t1
            )));
        }
        Ok(())
    }

    /// After t2 with no refund: pay Z. Anyone may send it.
    pub async fn punish(&self, id: B256) -> Result<TxInfo, Error> {
        let c = self.lock_contract();
        let call = c.punish(id);
        simulate(call.call().await.map(|_| ()))?;
        confirmed(call.send().await?).await
    }

    /// [`EvmClient::punish`] without waiting for it to be mined; simulated first, like
    /// [`EvmClient::submit_refund`].
    pub async fn submit_punish(&self, id: B256) -> Result<B256, Error> {
        let c = self.lock_contract();
        submit(c.punish(id)).await
    }

    pub async fn tx_status(&self, hash: B256) -> Result<TxStatus, Error> {
        if let Some(r) = self.provider.get_transaction_receipt(hash).await? {
            return Ok(TxStatus::Mined {
                ok: r.status(),
                block: r.block_number().unwrap_or_default(),
            });
        }
        Ok(match self.provider.get_transaction_by_hash(hash).await? {
            Some(_) => TxStatus::Pending,
            None => TxStatus::Unknown,
        })
    }
}

/// Simulate `call` (`eth_call`, then `eth_estimateGas`) and broadcast it only if both pass,
/// without waiting for it to be mined.
async fn submit<P: Provider, C: alloy::sol_types::SolCall>(
    call: alloy::contract::SolCallBuilder<P, C>,
) -> Result<B256, Error> {
    simulate(call.call().await.map(|_| ()))?;
    let gas = call.estimate_gas().await.map_err(would_revert)?;
    let pending = call.gas(gas.saturating_add(gas / 5)).send().await?;
    Ok(*pending.tx_hash())
}

/// Turn a failed `eth_call` into [`Error::WouldRevert`], naming the contract error if known.
fn simulate(result: Result<(), alloy::contract::Error>) -> Result<(), Error> {
    result.map_err(would_revert)
}

fn would_revert(e: alloy::contract::Error) -> Error {
    let reason = e
        .as_decoded_interface_error::<FerryLock::FerryLockErrors>()
        .map(|d| format!("{d:?}"))
        .unwrap_or_else(|| e.to_string());
    Error::WouldRevert(reason)
}

/// Wait for a sent transaction's receipt, at most [`RECEIPT_TIMEOUT`].
async fn confirmed(
    pending: PendingTransactionBuilder<alloy::network::Ethereum>,
) -> Result<TxInfo, Error> {
    mined(
        pending
            .with_timeout(Some(RECEIPT_TIMEOUT))
            .get_receipt()
            .await?,
    )
}

fn mined<R: ReceiptResponse>(receipt: R) -> Result<TxInfo, Error> {
    let tx_hash = receipt.transaction_hash();
    if !receipt.status() {
        return Err(Error::Reverted(tx_hash));
    }
    Ok(TxInfo {
        tx_hash,
        block_number: receipt
            .block_number()
            .ok_or_else(|| Error::Rpc("receipt without block".into()))?,
    })
}
