//! FerryLock client: lock / claim / refund / punish and reads.

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
            mined(approve.send().await?.get_receipt().await?)?;
        }
        let c = self.lock_contract();
        let call = c.lock(salt, terms.clone());
        simulate(call.call().await.map(|_| ()))?;
        let tx = mined(call.send().await?.get_receipt().await?)?;
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
        mined(call.send().await?.get_receipt().await?)
    }

    /// Refund to B by publishing `b`. Same pre-checks as [`EvmClient::claim`]: a reverted
    /// refund (sent before t1) would hand Z b while Z can still claim the tokens.
    pub async fn refund(&self, id: B256, b: &[u8; 32]) -> Result<TxInfo, Error> {
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
