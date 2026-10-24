//! Minimal async bitcoind JSON-RPC client: what a swap needs, nothing more.
//!
//! It also drives litecoind (Litecoin Core ≥ 0.21.2), whose RPC is the same for every call
//! used here; only addresses are written differently, see [`BitcoinRpc::with_coin`].

use bitcoin::consensus::encode::{deserialize_hex, serialize_hex};
use bitcoin::{Address, Amount, BlockHash, Network, Transaction, Txid};

use crate::chain::{Chain, Coin};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

/// bitcoind's "No such mempool or blockchain transaction".
const RPC_INVALID_ADDRESS_OR_KEY: i64 = -5;

/// Time limit for one RPC call, and for `importdescriptors` / `importmulti`, which rescan recent
/// blocks.
const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const RESCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("rpc {method} error {code}: {message}")]
    Rpc {
        method: String,
        code: i64,
        message: String,
    },
    #[error("rpc {method}: unexpected response: {detail}")]
    Decode { method: String, detail: String },
}

impl RpcError {
    pub fn code(&self) -> Option<i64> {
        match self {
            RpcError::Rpc { code, .. } => Some(*code),
            _ => None,
        }
    }
}

/// A node fee rate in coin per 1000 vbytes, as sat/vB rounded up (None if not positive).
fn per_kvb_to_sat_vb(per_kvb: f64) -> Option<u64> {
    let sat_per_kvb = Amount::from_btc(per_kvb).ok()?.to_sat();
    (sat_per_kvb > 0).then(|| sat_per_kvb.div_ceil(1000))
}

/// A funded and wallet-signed lock transaction that has not been broadcast.
#[derive(Clone, Debug)]
pub struct FundedLock {
    pub tx: Transaction,
    pub vout: u32,
}

/// A wallet-funded and wallet-signed payment that has not been broadcast
/// ([`BitcoinRpc::fund_payment`]).
#[derive(Clone, Debug)]
pub struct FundedPayment {
    pub tx: Transaction,
    /// What the inputs pay above the outputs.
    pub fee: Amount,
}

#[derive(Clone, Debug)]
pub struct BitcoinRpc {
    http: reqwest::Client,
    url: String,
    user: String,
    pass: String,
    wallet: Option<String>,
    watch_wallet: Option<String>,
    coin: Coin,
}

impl BitcoinRpc {
    pub fn new(url: impl Into<String>, user: impl Into<String>, pass: impl Into<String>) -> Self {
        BitcoinRpc {
            http: reqwest::Client::new(),
            url: url.into().trim_end_matches('/').to_string(),
            user: user.into(),
            pass: pass.into(),
            wallet: None,
            watch_wallet: None,
            coin: Coin::Btc,
        }
    }

    /// Talk to the node of `coin` (default Bitcoin): addresses sent to and read from the node
    /// use that coin's text encoding, and new wallet addresses its supported type.
    pub fn with_coin(mut self, coin: Coin) -> Self {
        self.coin = coin;
        self
    }

    pub fn coin(&self) -> Coin {
        self.coin
    }

    /// `addr` as the node writes it. The network tier (main / test / regtest) is the
    /// address's own.
    fn addr_str(&self, addr: &Address) -> String {
        let network = [Network::Bitcoin, Network::Regtest, Network::Testnet]
            .into_iter()
            .find(|n| addr.as_unchecked().is_valid_for_network(*n))
            .unwrap_or(Network::Bitcoin);
        Chain {
            coin: self.coin,
            network,
        }
        .encode_address(addr)
    }

    fn parse_addr(&self, method: &str, s: &str, network: Network) -> Result<Address, RpcError> {
        Chain {
            coin: self.coin,
            network,
        }
        .parse_address(s)
        .map_err(|e| RpcError::Decode {
            method: method.into(),
            detail: e.to_string(),
        })
    }

    /// Route wallet RPCs to `/wallet/<name>`.
    pub fn with_wallet(mut self, name: impl Into<String>) -> Self {
        self.wallet = Some(name.into());
        self
    }

    /// Track the swap's transactions through a watch-only descriptor wallet (see
    /// [`BitcoinRpc::watch_address`]). This works on pruned nodes without `-txindex`, where
    /// `getrawtransaction` only knows the mempool.
    pub fn with_watch_wallet(mut self, name: impl Into<String>) -> Self {
        self.watch_wallet = Some(name.into());
        self
    }

    async fn watch_call<T: DeserializeOwned>(
        &self,
        w: &str,
        method: &str,
        params: Value,
    ) -> Result<T, RpcError> {
        self.request(&format!("{}/wallet/{w}", self.url), method, params)
            .await
    }

    /// Load the watch-only wallet, creating it (blank, no private keys) if it does not exist.
    pub async fn ensure_watch_wallet(&self) -> Result<(), RpcError> {
        let Some(name) = &self.watch_wallet else {
            return Ok(());
        };
        let loaded: Vec<String> = self.call("listwallets", json!([])).await?;
        if loaded.iter().any(|w| w == name) {
            return Ok(());
        }
        if self
            .call::<Value>("loadwallet", json!([name]))
            .await
            .is_err()
        {
            // name, disable_private_keys, blank, passphrase, avoid_reuse, descriptors.
            // Litecoin Core 0.21 has no descriptor wallets: a legacy watch-only wallet then.
            let descriptors = self.coin == Coin::Btc;
            self.call::<Value>(
                "createwallet",
                json!([name, true, true, "", false, descriptors]),
            )
            .await?;
        }
        Ok(())
    }

    /// Watch every transaction paying to or spending from `address` (idempotent). Rescans the
    /// last `rescan_secs` seconds of blocks, which a pruned node still has.
    pub async fn watch_address(&self, address: &Address, rescan_secs: u64) -> Result<(), RpcError> {
        let Some(w) = &self.watch_wallet else {
            return Ok(());
        };
        let address = self.addr_str(address);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let timestamp = now.saturating_sub(rescan_secs);
        if self.coin == Coin::Ltc {
            // Legacy watch-only wallet (see ensure_watch_wallet).
            let res: Value = self
                .watch_call(
                    w,
                    "importmulti",
                    json!([[{"scriptPubKey": {"address": address}, "timestamp": timestamp,
                             "watchonly": true}]]),
                )
                .await?;
            if res[0]["success"].as_bool() != Some(true) {
                return Err(RpcError::Decode {
                    method: "importmulti".into(),
                    detail: res.to_string(),
                });
            }
            return Ok(());
        }
        let info: Value = self
            .call("getdescriptorinfo", json!([format!("addr({address})")]))
            .await?;
        let desc = format!(
            "addr({address})#{}",
            info["checksum"].as_str().unwrap_or_default()
        );
        let res: Value = self
            .watch_call(
                w,
                "importdescriptors",
                json!([[{"desc": desc, "timestamp": timestamp}]]),
            )
            .await?;
        if res[0]["success"].as_bool() != Some(true) {
            return Err(RpcError::Decode {
                method: "importdescriptors".into(),
                detail: res.to_string(),
            });
        }
        Ok(())
    }

    /// `gettransaction` in the watch wallet: (confirmations, tx). None if the wallet doesn't
    /// know the txid or it was conflicted out.
    async fn watched_tx(&self, txid: &Txid) -> Result<Option<(u32, Transaction)>, RpcError> {
        let Some(w) = &self.watch_wallet else {
            return Ok(None);
        };
        match self
            .watch_call::<Value>(w, "gettransaction", json!([txid.to_string(), true]))
            .await
        {
            Ok(v) => {
                let confs = v["confirmations"].as_i64().unwrap_or(0);
                if confs < 0 {
                    return Ok(None);
                }
                let tx = deserialize_hex(v["hex"].as_str().unwrap_or_default()).map_err(|e| {
                    RpcError::Decode {
                        method: "gettransaction".into(),
                        detail: e.to_string(),
                    }
                })?;
                Ok(Some((confs as u32, tx)))
            }
            Err(e) if e.code() == Some(RPC_INVALID_ADDRESS_OR_KEY) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn request<T: DeserializeOwned>(
        &self,
        url: &str,
        method: &str,
        params: Value,
    ) -> Result<T, RpcError> {
        // A hung node must not freeze the caller; only an import's rescan may take long.
        let limit = if method == "importdescriptors" || method == "importmulti" {
            RESCAN_TIMEOUT
        } else {
            RPC_TIMEOUT
        };
        let resp = self
            .http
            .post(url)
            .timeout(limit)
            .basic_auth(&self.user, Some(&self.pass))
            .json(&json!({"jsonrpc": "1.0", "id": "ferry", "method": method, "params": params}))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(RpcError::Decode {
                method: method.into(),
                detail: "401 unauthorized: wrong bitcoind RPC user or password".into(),
            });
        }
        let resp: Value = resp.json().await?;
        if let Some(err) = resp.get("error").filter(|e| !e.is_null()) {
            return Err(RpcError::Rpc {
                method: method.into(),
                code: err["code"].as_i64().unwrap_or(0),
                message: err["message"].as_str().unwrap_or_default().into(),
            });
        }
        serde_json::from_value(resp["result"].clone()).map_err(|e| RpcError::Decode {
            method: method.into(),
            detail: e.to_string(),
        })
    }

    /// Node-level call.
    pub async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<T, RpcError> {
        self.request(&self.url, method, params).await
    }

    /// Wallet-level call (uses the configured wallet, if any).
    pub async fn wallet_call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<T, RpcError> {
        match &self.wallet {
            Some(w) => {
                self.request(&format!("{}/wallet/{w}", self.url), method, params)
                    .await
            }
            None => self.call(method, params).await,
        }
    }

    /// Load the configured wallet, creating it if it does not exist.
    pub async fn ensure_wallet(&self) -> Result<(), RpcError> {
        let Some(name) = &self.wallet else {
            return Ok(());
        };
        let loaded: Vec<String> = self.call("listwallets", json!([])).await?;
        if loaded.iter().any(|w| w == name) {
            return Ok(());
        }
        if self
            .call::<Value>("loadwallet", json!([name]))
            .await
            .is_err()
        {
            self.call::<Value>("createwallet", json!([name])).await?;
        }
        Ok(())
    }

    pub async fn block_count(&self) -> Result<u64, RpcError> {
        self.call("getblockcount", json!([])).await
    }

    pub async fn balance(&self) -> Result<Amount, RpcError> {
        let btc: f64 = self.wallet_call("getbalance", json!([])).await?;
        Amount::from_btc(btc).map_err(|e| RpcError::Decode {
            method: "getbalance".into(),
            detail: e.to_string(),
        })
    }

    pub async fn new_address(&self, network: Network) -> Result<Address, RpcError> {
        let s: String = self
            .wallet_call(
                "getnewaddress",
                json!(["", self.coin.wallet_address_type()]),
            )
            .await?;
        self.parse_addr("getnewaddress", &s, network)
    }

    /// A stable receiving address of the wallet under `label` (created on first use).
    pub async fn labeled_address(
        &self,
        label: &str,
        network: Network,
    ) -> Result<Address, RpcError> {
        let existing: Result<Value, _> = self
            .wallet_call("getaddressesbylabel", json!([label]))
            .await;
        let addr = match existing
            .ok()
            .and_then(|v| v.as_object().and_then(|m| m.keys().min().cloned()))
        {
            Some(a) => a,
            None => {
                self.wallet_call::<String>(
                    "getnewaddress",
                    json!([label, self.coin.wallet_address_type()]),
                )
                .await?
            }
        };
        self.parse_addr("labeled_address", &addr, network)
    }

    /// A new receiving address of the wallet, under `label`.
    pub async fn labeled_new_address(
        &self,
        label: &str,
        network: Network,
    ) -> Result<Address, RpcError> {
        let s: String = self
            .wallet_call(
                "getnewaddress",
                json!([label, self.coin.wallet_address_type()]),
            )
            .await?;
        self.parse_addr("getnewaddress", &s, network)
    }

    /// Regtest only: mine `n` blocks to `to`.
    pub async fn generate_to_address(
        &self,
        n: u64,
        to: &Address,
    ) -> Result<Vec<BlockHash>, RpcError> {
        self.call("generatetoaddress", json!([n, self.addr_str(to)]))
            .await
    }

    /// Fund and sign a transaction paying `amount` to `to` from the wallet, without
    /// broadcasting it. Only segwit inputs are accepted, so the txid is final.
    pub async fn fund_lock(&self, to: &Address, amount: Amount) -> Result<FundedLock, RpcError> {
        let decode = |detail: String| RpcError::Decode {
            method: "fund_lock".into(),
            detail,
        };
        let raw: String = self
            .wallet_call(
                "createrawtransaction",
                json!([[], {self.addr_str(to): amount.to_btc()}]),
            )
            .await?;
        let funded: Value = self.wallet_call("fundrawtransaction", json!([raw])).await?;
        let signed: Value = self
            .wallet_call("signrawtransactionwithwallet", json!([funded["hex"]]))
            .await?;
        if signed["complete"].as_bool() != Some(true) {
            return Err(decode(
                "wallet could not fully sign the lock transaction".into(),
            ));
        }
        let tx: Transaction = deserialize_hex(signed["hex"].as_str().unwrap_or_default())
            .map_err(|e| decode(e.to_string()))?;
        if tx
            .input
            .iter()
            .any(|i| i.witness.is_empty() || !i.script_sig.is_empty())
        {
            return Err(decode(
                "lock transaction has non-segwit inputs (malleable txid)".into(),
            ));
        }
        let spk = to.script_pubkey();
        let vout = tx
            .output
            .iter()
            .position(|o| o.script_pubkey == spk && o.value == amount)
            .ok_or_else(|| decode("lock output missing".into()))?;
        Ok(FundedLock {
            tx,
            vout: vout as u32,
        })
    }

    /// The node's fee estimate for confirmation within `blocks` blocks, in sat/vB (rounded
    /// up); None when it has none (a regtest node, a fresh one).
    pub async fn estimate_fee_rate(&self, blocks: u16) -> Result<Option<u64>, RpcError> {
        let v: Value = self.call("estimatesmartfee", json!([blocks])).await?;
        Ok(v["feerate"].as_f64().and_then(per_kvb_to_sat_vb))
    }

    /// The lowest fee rate the node's mempool takes now, in sat/vB (rounded up): the larger of
    /// `mempoolminfee` and `minrelaytxfee`.
    pub async fn min_fee_rate(&self) -> Result<u64, RpcError> {
        let v: Value = self.call("getmempoolinfo", json!([])).await?;
        Ok(["mempoolminfee", "minrelaytxfee"]
            .iter()
            .filter_map(|k| v[*k].as_f64().and_then(per_kvb_to_sat_vb))
            .max()
            .unwrap_or(1))
    }

    /// Fund and sign a payment of `amount` to `to` from the wallet at `fee_rate` sat/vB, with
    /// change back to the wallet, without broadcasting it. Like [`BitcoinRpc::fund_lock`], only
    /// segwit inputs are accepted, so its txid is final once signed and it can be recorded
    /// before it goes out. Nothing is locked or reserved in the wallet.
    pub async fn fund_payment(
        &self,
        to: &Address,
        amount: Amount,
        fee_rate: u64,
    ) -> Result<FundedPayment, RpcError> {
        let decode = |detail: String| RpcError::Decode {
            method: "fund_payment".into(),
            detail,
        };
        let raw: String = self
            .wallet_call(
                "createrawtransaction",
                json!([[], {self.addr_str(to): amount.to_btc()}]),
            )
            .await?;
        let funded: Value = self
            .wallet_call(
                "fundrawtransaction",
                json!([raw, {"fee_rate": fee_rate, "lockUnspents": false}]),
            )
            .await?;
        let fee = funded["fee"]
            .as_f64()
            .and_then(|f| Amount::from_btc(f).ok())
            .ok_or_else(|| decode(format!("no fee in {funded}")))?;
        let signed: Value = self
            .wallet_call("signrawtransactionwithwallet", json!([funded["hex"]]))
            .await?;
        if signed["complete"].as_bool() != Some(true) {
            return Err(decode("wallet could not fully sign the payment".into()));
        }
        let tx: Transaction = deserialize_hex(signed["hex"].as_str().unwrap_or_default())
            .map_err(|e| decode(e.to_string()))?;
        if tx
            .input
            .iter()
            .any(|i| i.witness.is_empty() || !i.script_sig.is_empty())
        {
            return Err(decode(
                "the wallet funded it with non-segwit inputs (malleable txid)".into(),
            ));
        }
        let spk = to.script_pubkey();
        if !tx
            .output
            .iter()
            .any(|o| o.script_pubkey == spk && o.value == amount)
        {
            return Err(decode("the payment output is missing".into()));
        }
        Ok(FundedPayment { tx, fee })
    }

    /// Confirmations of a transaction of our own wallet (`gettransaction`): negative when a
    /// conflicting transaction has that many, None when the wallet does not know it.
    pub async fn wallet_tx_confirmations(&self, txid: &Txid) -> Result<Option<i64>, RpcError> {
        match self
            .wallet_call::<Value>("gettransaction", json!([txid.to_string()]))
            .await
        {
            Ok(v) => Ok(Some(v["confirmations"].as_i64().unwrap_or(0))),
            Err(e) if e.code() == Some(RPC_INVALID_ADDRESS_OR_KEY) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn broadcast(&self, tx: &Transaction) -> Result<Txid, RpcError> {
        self.call("sendrawtransaction", json!([serialize_hex(tx)]))
            .await
    }

    /// A transaction from the watch wallet, the mempool or (with `-txindex`) the chain; None if
    /// unknown.
    pub async fn raw_transaction(&self, txid: &Txid) -> Result<Option<Transaction>, RpcError> {
        if let Some((_, tx)) = self.watched_tx(txid).await? {
            return Ok(Some(tx));
        }
        match self
            .call::<String>("getrawtransaction", json!([txid.to_string()]))
            .await
        {
            Ok(hex) => deserialize_hex(&hex)
                .map(Some)
                .map_err(|e| RpcError::Decode {
                    method: "getrawtransaction".into(),
                    detail: e.to_string(),
                }),
            Err(e) if e.code() == Some(RPC_INVALID_ADDRESS_OR_KEY) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Height of the block that confirmed `txid`; None while unconfirmed or unknown.
    pub async fn block_height(&self, txid: &Txid) -> Result<Option<u64>, RpcError> {
        if let Some(w) = &self.watch_wallet {
            match self
                .watch_call::<Value>(w, "gettransaction", json!([txid.to_string(), true]))
                .await
            {
                Ok(v) => return Ok(v["blockheight"].as_u64()),
                Err(e) if e.code() == Some(RPC_INVALID_ADDRESS_OR_KEY) => {}
                Err(e) => return Err(e),
            }
        }
        let v = match self
            .call::<Value>("getrawtransaction", json!([txid.to_string(), true]))
            .await
        {
            Ok(v) => v,
            Err(e) if e.code() == Some(RPC_INVALID_ADDRESS_OR_KEY) => return Ok(None),
            Err(e) => return Err(e),
        };
        let Some(hash) = v["blockhash"].as_str() else {
            return Ok(None);
        };
        let header: Value = self.call("getblockheader", json!([hash])).await?;
        Ok(header["height"].as_u64())
    }

    /// Confirmations of a transaction: Some(0) in the mempool, None if unknown.
    pub async fn confirmations(&self, txid: &Txid) -> Result<Option<u32>, RpcError> {
        if let Some((confs, _)) = self.watched_tx(txid).await? {
            return Ok(Some(confs));
        }
        match self
            .call::<Value>("getrawtransaction", json!([txid.to_string(), true]))
            .await
        {
            Ok(v) => Ok(Some(v["confirmations"].as_u64().unwrap_or(0) as u32)),
            Err(e) if e.code() == Some(RPC_INVALID_ADDRESS_OR_KEY) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::per_kvb_to_sat_vb;

    #[test]
    fn node_fee_rates_in_sat_per_vbyte() {
        assert_eq!(per_kvb_to_sat_vb(0.00001), Some(1)); // the default relay fee
        assert_eq!(per_kvb_to_sat_vb(0.0002), Some(20));
        assert_eq!(per_kvb_to_sat_vb(0.000015), Some(2), "rounded up");
        assert_eq!(per_kvb_to_sat_vb(0.0), None);
        assert_eq!(per_kvb_to_sat_vb(-1.0), None);
    }
}
