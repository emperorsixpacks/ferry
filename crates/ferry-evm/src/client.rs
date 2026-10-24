//! FerryLock client: lock / ready / claim / refund / punish and reads.

use alloy::network::{EthereumWallet, ReceiptResponse};
use alloy::primitives::{Address, B256, U256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;

use crate::bindings::{FerryLock, IERC20};
use crate::{address, swap_id, Error, Terms};

/// `FerryLock.State`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapState {
    None,
    Locked,
    Ready,
    Claimed,
    Refunded,
    Punished,
}

impl SwapState {
    fn from_u8(v: u8) -> Result<Self, Error> {
        Ok(match v {
            0 => SwapState::None,
            1 => SwapState::Locked,
            2 => SwapState::Ready,
            3 => SwapState::Claimed,
            4 => SwapState::Refunded,
            5 => SwapState::Punished,
            _ => return Err(Error::Rpc(format!("unknown swap state {v}"))),
        })
    }

    /// Tokens are still in the contract.
    pub fn is_open(self) -> bool {
        matches!(self, SwapState::Locked | SwapState::Ready)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OnChainSwap {
    pub terms: Terms,
    pub state: SwapState,
}

/// A mined, successful transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TxInfo {
    pub tx_hash: B256,
    pub block_number: u64,
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
    pub fn connect_http(
        rpc_url: &str,
        contract: Address,
        signer: PrivateKeySigner,
    ) -> Result<Self, Error> {
        let url: alloy::transports::http::reqwest::Url =
            rpc_url.parse().map_err(|e| Error::Url(format!("{e}")))?;
        let from = signer.address();
        let provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(signer))
            .connect_http(url)
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
        let block = self
            .provider
            .get_block(alloy::eips::BlockId::latest())
            .await?
            .ok_or_else(|| Error::Rpc("no latest block".into()))?;
        Ok(block.header.timestamp)
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

    /// Z, before locking any ZEC: the lock exists, is still un-ready, and every term matches
    /// what was agreed. Z must also have checked that `contract()` is the agreed FerryLock
    /// deployment and that `expected.token` is the agreed token.
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
            mined(approve.send().await?.get_receipt().await?)?;
        }
        let c = self.lock_contract();
        let call = c.lock(salt, terms.clone());
        simulate(call.call().await.map(|_| ()))?;
        let tx = mined(call.send().await?.get_receipt().await?)?;
        Ok((swap_id(self.from, salt), tx))
    }

    /// B, once the ZEC lock has N confirmations: let Z claim.
    pub async fn ready(&self, id: B256) -> Result<TxInfo, Error> {
        let c = self.lock_contract();
        let call = c.ready(id);
        simulate(call.call().await.map(|_| ()))?;
        mined(call.send().await?.get_receipt().await?)
    }

    /// Claim for Z by publishing `z` (big-endian secp256k1 scalar), taking `tip` of the tokens
    /// for the sender. Refuses to broadcast unless the share matches and a simulation passes,
    /// because a reverted claim would still publish `z`.
    pub async fn claim(&self, id: B256, z: &[u8; 32], tip: U256) -> Result<TxInfo, Error> {
        let s = self.swap(id).await?;
        if s.state != SwapState::Ready {
            return Err(Error::WrongState(s.state, "Ready"));
        }
        address::verify_share(z, s.terms.zAddr)?;
        let c = self.lock_contract();
        let call = c.claim(id, U256::from_be_bytes(*z), tip);
        simulate(call.call().await.map(|_| ()))?;
        mined(call.send().await?.get_receipt().await?)
    }

    /// Refund to B by publishing `b`. Same pre-checks as [`EvmClient::claim`]: a reverted
    /// refund (sent before t1) would hand Z both b and, if ready, the tokens.
    pub async fn refund(&self, id: B256, b: &[u8; 32]) -> Result<TxInfo, Error> {
        let s = self.swap(id).await?;
        if !s.state.is_open() {
            return Err(Error::WrongState(s.state, "Locked or Ready"));
        }
        address::verify_share(b, s.terms.bAddr)?;
        let now = self.latest_timestamp().await?;
        if now < s.terms.t1 {
            return Err(Error::WouldRevert(format!(
                "latest block time {now} is before t1 {}",
                s.terms.t1
            )));
        }
        let c = self.lock_contract();
        let call = c.refund(id, U256::from_be_bytes(*b));
        simulate(call.call().await.map(|_| ()))?;
        mined(call.send().await?.get_receipt().await?)
    }

    /// After t2 with no refund: pay Z. Anyone may send it.
    pub async fn punish(&self, id: B256) -> Result<TxInfo, Error> {
        let c = self.lock_contract();
        let call = c.punish(id);
        simulate(call.call().await.map(|_| ()))?;
        mined(call.send().await?.get_receipt().await?)
    }
}

/// Turn a failed `eth_call` into [`Error::WouldRevert`], naming the contract error if known.
fn simulate(result: Result<(), alloy::contract::Error>) -> Result<(), Error> {
    result.map_err(|e| {
        let reason = e
            .as_decoded_interface_error::<FerryLock::FerryLockErrors>()
            .map(|d| format!("{d:?}"))
            .unwrap_or_else(|| e.to_string());
        Error::WouldRevert(reason)
    })
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
