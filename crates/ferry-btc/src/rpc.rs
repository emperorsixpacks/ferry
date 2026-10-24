//! Minimal async bitcoind JSON-RPC client: what a swap needs, nothing more.
//!
//! It also drives litecoind (Litecoin Core ≥ 0.21.2), whose RPC is the same for every call
//! used here; only addresses are written differently, see [`BitcoinRpc::with_coin`].

use bitcoin::consensus::encode::{deserialize_hex, serialize_hex};
use bitcoin::{Address, Amount, BlockHash, Network, OutPoint, Transaction, Txid};

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

/// `{"txid", "vout"}` as `listunspent` and `listlockunspent` write it.
fn outpoint_of(v: &Value) -> Option<OutPoint> {
    Some(OutPoint {
        txid: v["txid"].as_str()?.parse().ok()?,
        vout: u32::try_from(v["vout"].as_u64()?).ok()?,
    })
}

fn outpoint_json(op: &OutPoint) -> Value {
    json!({"txid": op.txid.to_string(), "vout": op.vout})
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

/// The node's fee floors, in satoshis per 1000 vbytes (the node's own unit, so a 0.1 sat/vB
/// floor, as Bitcoin Core 30 uses, is exact). Always read from the node, never assumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeFloors {
    /// `minrelaytxfee`: the static floor for relaying a transaction.
    pub min_relay: u64,
    /// `mempoolminfee`: the floor now, which rises above `min_relay` when the mempool is full.
    pub mempool_min: u64,
    /// `incrementalrelayfee`: what a replacement must add per vbyte of its own size (BIP125).
    pub incremental: u64,
}

impl FeeFloors {
    /// The lowest fee rate the mempool takes now.
    pub fn floor(&self) -> u64 {
        self.min_relay.max(self.mempool_min)
    }
}

/// A transaction in the node's mempool (`getmempoolentry`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MempoolEntry {
    pub vsize: u64,
    /// The transaction's own fee.
    pub base_fee: Amount,
    /// Fee and vsize of the transaction and its unconfirmed ancestors.
    pub ancestor_fee: Amount,
    pub ancestor_vsize: u64,
    /// Fee and vsize of the transaction and its unconfirmed descendants.
    pub descendant_fee: Amount,
    pub descendant_vsize: u64,
    /// Unconfirmed parents, and the unconfirmed transactions that spend it.
    pub depends: Vec<Txid>,
    pub spent_by: Vec<Txid>,
}

/// One transaction's verdict from `testmempoolaccept`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptResult {
    pub txid: Txid,
    pub allowed: bool,
    pub vsize: Option<u64>,
    pub fee: Option<Amount>,
    /// Why the node would refuse it (`reject-reason`, or the package's `package-error`).
    pub reject_reason: Option<String>,
}

/// The outcome of `submitpackage`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageResult {
    /// `package_msg` was "success": every transaction is in the mempool.
    pub success: bool,
    pub message: String,
    /// Per-transaction errors the node reported.
    pub errors: Vec<(Txid, String)>,
    /// Transactions the package replaced.
    pub replaced: Vec<Txid>,
}

#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    /// This node has no package submission (Litecoin Core 0.21).
    #[error("this node does not take packages")]
    Unsupported,
    #[error(transparent)]
    Rpc(#[from] RpcError),
}

/// JSON-RPC "Method not found".
const RPC_METHOD_NOT_FOUND: i64 = -32601;

/// Satoshis per 1000 vbytes of a rate the node writes in coin per 1000 vbytes.
fn sat_per_kvb(coin_per_kvb: f64) -> Option<u64> {
    Amount::from_btc(coin_per_kvb).ok().map(|a| a.to_sat())
}

/// A coin amount the node writes as a JSON number.
fn amount_of(v: &Value) -> Option<Amount> {
    v.as_f64().and_then(|f| Amount::from_btc(f).ok())
}

fn txids_of(v: &Value) -> Option<Vec<Txid>> {
    v.as_array()?
        .iter()
        .map(|t| t.as_str()?.parse().ok())
        .collect()
}

/// `maxfeerate` as the node takes it: coin per 1000 vbytes, written as text so no float
/// formatting (1e-5) reaches the node.
fn max_fee_rate_param(sat_per_kvb: u64) -> Value {
    json!(Amount::from_sat(sat_per_kvb).to_string_in(bitcoin::Denomination::Bitcoin))
}

/// The floors in a `getmempoolinfo` reply. `incremental_fallback` is `getnetworkinfo`'s
/// `incrementalfee`, for a node whose `getmempoolinfo` does not carry it.
fn parse_floors(info: &Value, incremental_fallback: Option<f64>) -> Result<FeeFloors, String> {
    let field = |k: &str| {
        info[k]
            .as_f64()
            .and_then(sat_per_kvb)
            .ok_or_else(|| format!("no {k} in {info}"))
    };
    let incremental = match info["incrementalrelayfee"]
        .as_f64()
        .or(incremental_fallback)
    {
        Some(f) => sat_per_kvb(f).ok_or_else(|| format!("bad incremental relay fee {f}"))?,
        None => return Err("the node reports no incremental relay fee".into()),
    };
    Ok(FeeFloors {
        min_relay: field("minrelaytxfee")?,
        mempool_min: field("mempoolminfee")?,
        incremental,
    })
}

fn parse_mempool_entry(v: &Value) -> Result<MempoolEntry, String> {
    let bad = |k: &str| format!("no {k} in {v}");
    let fee = |k: &str| amount_of(&v["fees"][k]).ok_or_else(|| bad(k));
    let size = |k: &str| v[k].as_u64().ok_or_else(|| bad(k));
    Ok(MempoolEntry {
        vsize: size("vsize")?,
        base_fee: fee("base")?,
        ancestor_fee: fee("ancestor")?,
        ancestor_vsize: size("ancestorsize")?,
        descendant_fee: fee("descendant")?,
        descendant_vsize: size("descendantsize")?,
        depends: txids_of(&v["depends"]).ok_or_else(|| bad("depends"))?,
        spent_by: txids_of(&v["spentby"]).ok_or_else(|| bad("spentby"))?,
    })
}

fn parse_accept(v: &Value) -> Result<Vec<AcceptResult>, String> {
    v.as_array()
        .ok_or_else(|| format!("not an array: {v}"))?
        .iter()
        .map(|r| {
            Ok(AcceptResult {
                txid: r["txid"]
                    .as_str()
                    .and_then(|t| t.parse().ok())
                    .ok_or_else(|| format!("no txid in {r}"))?,
                allowed: r["allowed"].as_bool() == Some(true),
                vsize: r["vsize"].as_u64(),
                fee: amount_of(&r["fees"]["base"]),
                reject_reason: r["reject-reason"]
                    .as_str()
                    .or_else(|| r["package-error"].as_str())
                    .map(str::to_owned),
            })
        })
        .collect()
}

fn parse_package(v: &Value) -> Result<PackageResult, String> {
    let message = v["package_msg"]
        .as_str()
        .ok_or_else(|| format!("no package_msg in {v}"))?
        .to_owned();
    let mut errors = vec![];
    if let Some(results) = v["tx-results"].as_object() {
        for r in results.values() {
            if let (Some(txid), Some(err)) = (
                r["txid"].as_str().and_then(|t| t.parse().ok()),
                r["error"].as_str(),
            ) {
                errors.push((txid, err.to_owned()));
            }
        }
    }
    Ok(PackageResult {
        success: message == "success",
        message,
        errors,
        replaced: txids_of(&v["replaced-transactions"]).unwrap_or_default(),
    })
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
    ///
    /// The wallet locks the coins it picks (`lockUnspents`): until this transaction is
    /// broadcast, nothing else the wallet funds (another swap's lock, a withdrawal) can pick
    /// them, and [`BitcoinRpc::spendable_balance`] leaves them out. If anything after the
    /// funding fails they are unlocked again. The node keeps these locks in memory only, so a
    /// caller holding an unbroadcast lock across a node restart locks its inputs again
    /// ([`BitcoinRpc::lock_coins`]).
    pub async fn fund_lock(&self, to: &Address, amount: Amount) -> Result<FundedLock, RpcError> {
        let raw: String = self
            .wallet_call(
                "createrawtransaction",
                json!([[], {self.addr_str(to): amount.to_btc()}]),
            )
            .await?;
        let funded: Value = self
            .wallet_call("fundrawtransaction", json!([raw, {"lockUnspents": true}]))
            .await?;
        let picked: Vec<OutPoint> =
            deserialize_hex::<Transaction>(funded["hex"].as_str().unwrap_or_default())
                .map(|tx| tx.input.iter().map(|i| i.previous_output).collect())
                .unwrap_or_default();
        let signed = self.sign_lock(&funded, to, amount).await;
        if signed.is_err() {
            // Best effort: a lock that stays behind only keeps these coins idle until the node
            // restarts, and the daemon's next funding releases nothing it still needs.
            let _ = self.unlock_coins(&picked).await;
        }
        signed
    }

    /// The rest of [`BitcoinRpc::fund_lock`]: sign the funded transaction and check it.
    async fn sign_lock(
        &self,
        funded: &Value,
        to: &Address,
        amount: Amount,
    ) -> Result<FundedLock, RpcError> {
        let decode = |detail: String| RpcError::Decode {
            method: "fund_lock".into(),
            detail,
        };
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

    /// What the wallet can fund right now: its safe unspent coins (confirmed, or change of our
    /// own unconfirmed transactions), less every coin it has locked. Unlike `getbalance`, the
    /// coins of a lock that is funded but not broadcast yet are left out, as coin selection
    /// leaves them out.
    pub async fn spendable_balance(&self) -> Result<Amount, RpcError> {
        let decode = |detail: String| RpcError::Decode {
            method: "listunspent".into(),
            detail,
        };
        let locked = self.locked_coins().await?;
        // minconf 0, any confirmations, any address, include_unsafe = false
        let coins: Vec<Value> = self
            .wallet_call("listunspent", json!([0, 9_999_999, [], false]))
            .await?;
        let mut sat = 0u64;
        for c in &coins {
            if c["spendable"].as_bool() == Some(false) || c["safe"].as_bool() == Some(false) {
                continue;
            }
            let op = outpoint_of(c).ok_or_else(|| decode(format!("no outpoint in {c}")))?;
            if locked.contains(&op) {
                continue;
            }
            let value = c["amount"]
                .as_f64()
                .and_then(|a| Amount::from_btc(a).ok())
                .ok_or_else(|| decode(format!("no amount in {c}")))?;
            sat = sat.saturating_add(value.to_sat());
        }
        Ok(Amount::from_sat(sat))
    }

    /// The coins the wallet has locked (`listlockunspent`).
    pub async fn locked_coins(&self) -> Result<Vec<OutPoint>, RpcError> {
        let list: Vec<Value> = self.wallet_call("listlockunspent", json!([])).await?;
        list.iter()
            .map(|v| {
                outpoint_of(v).ok_or_else(|| RpcError::Decode {
                    method: "listlockunspent".into(),
                    detail: v.to_string(),
                })
            })
            .collect()
    }

    /// Lock each of `coins` the wallet has not locked yet, so coin selection leaves them alone.
    /// Each is locked on its own, so one that can't be (already spent, unknown to the wallet)
    /// doesn't stop the others; those come back with the node's error.
    pub async fn lock_coins(
        &self,
        coins: &[OutPoint],
    ) -> Result<Vec<(OutPoint, RpcError)>, RpcError> {
        let locked = self.locked_coins().await?;
        let mut failed = vec![];
        for op in coins.iter().filter(|op| !locked.contains(op)) {
            if let Err(e) = self
                .wallet_call::<Value>("lockunspent", json!([false, [outpoint_json(op)]]))
                .await
            {
                failed.push((*op, e));
            }
        }
        Ok(failed)
    }

    /// Unlock those of `coins` the wallet has locked (the others are left as they are).
    pub async fn unlock_coins(&self, coins: &[OutPoint]) -> Result<(), RpcError> {
        let locked = self.locked_coins().await?;
        let mine: Vec<Value> = coins
            .iter()
            .filter(|op| locked.contains(op))
            .map(outpoint_json)
            .collect();
        if mine.is_empty() {
            return Ok(());
        }
        self.wallet_call::<Value>("lockunspent", json!([true, mine]))
            .await
            .map(|_| ())
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

    /// [`BitcoinRpc::broadcast`] for a transaction whose fee rate must stay at or below
    /// `max_fee_rate` (sat per 1000 vbytes): the node refuses it (`max-fee-exceeded`) otherwise,
    /// as a second guard beside the caller's own cap.
    pub async fn broadcast_capped(
        &self,
        tx: &Transaction,
        max_fee_rate: u64,
    ) -> Result<Txid, RpcError> {
        self.call(
            "sendrawtransaction",
            json!([serialize_hex(tx), max_fee_rate_param(max_fee_rate)]),
        )
        .await
    }

    /// What the node would say to `txs` (`testmempoolaccept`) without taking them. One
    /// transaction is tested alone; several are tested as one package (a child with its
    /// parents), which only a node with package support can do. Replacements are not predicted
    /// for a package. `max_fee_rate`: sat per 1000 vbytes.
    pub async fn test_accept(
        &self,
        txs: &[Transaction],
        max_fee_rate: Option<u64>,
    ) -> Result<Vec<AcceptResult>, PackageError> {
        if txs.len() > 1 && !self.coin.supports_packages() {
            return Err(PackageError::Unsupported);
        }
        let hexes: Vec<String> = txs.iter().map(serialize_hex).collect();
        let mut params = vec![json!(hexes)];
        params.extend(max_fee_rate.map(max_fee_rate_param));
        let v: Value = self.call("testmempoolaccept", Value::Array(params)).await?;
        parse_accept(&v).map_err(|detail| {
            PackageError::Rpc(RpcError::Decode {
                method: "testmempoolaccept".into(),
                detail,
            })
        })
    }

    /// Submit `txs`, a child last and every unconfirmed parent before it, as one package
    /// (`submitpackage`): the child's fee can then pay for a parent that is below the mempool's
    /// floor. Only where [`Coin::supports_packages`]; Litecoin Core 0.21 answers
    /// [`PackageError::Unsupported`] without being asked. `max_fee_rate`: sat per 1000 vbytes.
    pub async fn submit_package(
        &self,
        txs: &[Transaction],
        max_fee_rate: Option<u64>,
    ) -> Result<PackageResult, PackageError> {
        if !self.coin.supports_packages() {
            return Err(PackageError::Unsupported);
        }
        let hexes: Vec<String> = txs.iter().map(serialize_hex).collect();
        let mut params = vec![json!(hexes)];
        params.extend(max_fee_rate.map(max_fee_rate_param));
        let v: Value = match self.call("submitpackage", Value::Array(params)).await {
            Ok(v) => v,
            Err(e) if e.code() == Some(RPC_METHOD_NOT_FOUND) => {
                return Err(PackageError::Unsupported)
            }
            Err(e) => return Err(e.into()),
        };
        parse_package(&v).map_err(|detail| {
            PackageError::Rpc(RpcError::Decode {
                method: "submitpackage".into(),
                detail,
            })
        })
    }

    /// `txid` in the node's mempool (`getmempoolentry`); None if it is not there (confirmed,
    /// evicted, replaced or never seen).
    pub async fn mempool_entry(&self, txid: &Txid) -> Result<Option<MempoolEntry>, RpcError> {
        match self
            .call::<Value>("getmempoolentry", json!([txid.to_string()]))
            .await
        {
            Ok(v) => parse_mempool_entry(&v)
                .map(Some)
                .map_err(|detail| RpcError::Decode {
                    method: "getmempoolentry".into(),
                    detail,
                }),
            Err(e) if e.code() == Some(RPC_INVALID_ADDRESS_OR_KEY) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The node's fee floors now: `minrelaytxfee`, `mempoolminfee` and `incrementalrelayfee`,
    /// all read from the node (`getmempoolinfo`, and `getnetworkinfo` for a node whose mempool
    /// info lacks the incremental fee). Nothing is assumed: Core 30 lowers all three to
    /// 0.1 sat/vB, and the mempool floor moves with congestion.
    pub async fn fee_floors(&self) -> Result<FeeFloors, RpcError> {
        let info: Value = self.call("getmempoolinfo", json!([])).await?;
        let fallback = if info["incrementalrelayfee"].is_null() {
            let net: Value = self.call("getnetworkinfo", json!([])).await?;
            net["incrementalfee"].as_f64()
        } else {
            None
        };
        parse_floors(&info, fallback).map_err(|detail| RpcError::Decode {
            method: "getmempoolinfo".into(),
            detail,
        })
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

impl crate::child::ChildWallet for BitcoinRpc {
    async fn locked_coins(&self) -> Result<Vec<OutPoint>, RpcError> {
        BitcoinRpc::locked_coins(self).await
    }

    /// `signrawtransactionwithwallet` with the previous output handed over (`prevtxs`), so a
    /// parent that has left the mempool can still be spent. `tx` has one input.
    async fn sign_child(
        &self,
        tx: &Transaction,
        prevout: &bitcoin::TxOut,
    ) -> Result<(Transaction, bool), RpcError> {
        let decode = |detail: String| RpcError::Decode {
            method: "signrawtransactionwithwallet".into(),
            detail,
        };
        let spent = tx
            .input
            .first()
            .ok_or_else(|| decode("no input to sign".into()))?
            .previous_output;
        let prev = json!([{
            "txid": spent.txid.to_string(),
            "vout": spent.vout,
            "scriptPubKey": prevout.script_pubkey.to_hex_string(),
            "amount": prevout.value.to_string_in(bitcoin::Denomination::Bitcoin),
        }]);
        let signed: Value = self
            .wallet_call(
                "signrawtransactionwithwallet",
                json!([serialize_hex(tx), prev]),
            )
            .await?;
        let signed_tx: Transaction = deserialize_hex(signed["hex"].as_str().unwrap_or_default())
            .map_err(|e| decode(e.to_string()))?;
        Ok((signed_tx, signed["complete"].as_bool() == Some(true)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_fee_rates_in_sat_per_vbyte() {
        assert_eq!(per_kvb_to_sat_vb(0.00001), Some(1)); // the default relay fee
        assert_eq!(per_kvb_to_sat_vb(0.0002), Some(20));
        assert_eq!(per_kvb_to_sat_vb(0.000015), Some(2), "rounded up");
        assert_eq!(per_kvb_to_sat_vb(0.0), None);
        assert_eq!(per_kvb_to_sat_vb(-1.0), None);
    }

    fn json(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    // Replies recorded from Bitcoin Core 28.1 on regtest (docker bitcoin/bitcoin:28.1).

    #[test]
    fn floors_are_read_in_satoshis_per_kvb() {
        let info = json(
            r#"{"loaded": true, "size": 0, "maxmempool": 300000000, "mempoolminfee": 0.00001000,
                "minrelaytxfee": 0.00001000, "incrementalrelayfee": 0.00001000, "fullrbf": true}"#,
        );
        let f = parse_floors(&info, None).unwrap();
        assert_eq!(
            f,
            FeeFloors {
                min_relay: 1_000,
                mempool_min: 1_000,
                incremental: 1_000
            }
        );
        assert_eq!(f.floor(), 1_000);
        // A full mempool raises the floor above the relay minimum; Core 30 lowers all three to
        // 0.1 sat/vB, which is exact in sat/kvB.
        let busy = json(
            r#"{"mempoolminfee": 0.00012345, "minrelaytxfee": 0.000001,
                "incrementalrelayfee": 0.000001}"#,
        );
        let f = parse_floors(&busy, None).unwrap();
        assert_eq!(
            (f.min_relay, f.mempool_min, f.incremental, f.floor()),
            (100, 12_345, 100, 12_345)
        );
        // No incremental fee in the mempool info: the network info's is used, else an error.
        let old = json(r#"{"mempoolminfee": 0.00001, "minrelaytxfee": 0.00001}"#);
        assert_eq!(
            parse_floors(&old, Some(0.00001)).unwrap().incremental,
            1_000
        );
        assert!(parse_floors(&old, None).is_err());
        // Anything missing is an error, never a default.
        assert!(parse_floors(&json(r#"{"minrelaytxfee": 0.00001}"#), Some(0.00001)).is_err());
        assert!(parse_floors(&json("{}"), Some(0.00001)).is_err());
    }

    #[test]
    fn mempool_entry_with_and_without_a_child() {
        let alone = json(
            r#"{"vsize": 154, "weight": 616, "time": 1792700609, "height": 101,
                "descendantcount": 1, "descendantsize": 154, "ancestorcount": 1,
                "ancestorsize": 154,
                "wtxid": "9852fd4d9048e8f361b001a98a11e9394c31b4f8cef5e020d791ad3cb74761a8",
                "fees": {"base": 0.00000310, "modified": 0.00000310, "ancestor": 0.00000310,
                         "descendant": 0.00000310},
                "depends": [], "spentby": [], "bip125-replaceable": true, "unbroadcast": true}"#,
        );
        let e = parse_mempool_entry(&alone).unwrap();
        assert_eq!(e.vsize, 154);
        assert_eq!(e.base_fee, Amount::from_sat(310));
        assert_eq!(e.descendant_fee, Amount::from_sat(310));
        assert!(e.spent_by.is_empty() && e.depends.is_empty());

        let with_child = json(
            r#"{"vsize": 154, "descendantcount": 2, "descendantsize": 265, "ancestorcount": 1,
                "ancestorsize": 154,
                "fees": {"base": 0.00000310, "modified": 0.00000310, "ancestor": 0.00000310,
                         "descendant": 0.00003310},
                "depends": [],
                "spentby": ["4ee66cb92c6b923c31052c8e5391cd9e013bb4ee40b169695def7f84f2081640"],
                "bip125-replaceable": true}"#,
        );
        let e = parse_mempool_entry(&with_child).unwrap();
        assert_eq!(e.descendant_fee, Amount::from_sat(3_310));
        assert_eq!(e.descendant_vsize, 265);
        assert_eq!(e.ancestor_fee, Amount::from_sat(310));
        assert_eq!(e.spent_by.len(), 1);
        assert_eq!(
            e.spent_by[0].to_string(),
            "4ee66cb92c6b923c31052c8e5391cd9e013bb4ee40b169695def7f84f2081640"
        );
        assert!(parse_mempool_entry(&json(r#"{"vsize": 1}"#)).is_err());
    }

    #[test]
    fn accept_results() {
        let ok = json(
            r#"[{"txid": "4ee66cb92c6b923c31052c8e5391cd9e013bb4ee40b169695def7f84f2081640",
                 "wtxid": "43431444f176f3811a5fb2ea8bf57f781bfa95f53101658d8f7797bb78b3b357",
                 "allowed": true, "vsize": 111,
                 "fees": {"base": 0.00003000, "effective-feerate": 0.00027027,
                          "effective-includes": ["43431444f176f3811a5fb2ea8bf57f781bfa95f53101658d8f7797bb78b3b357"]}}]"#,
        );
        let r = parse_accept(&ok).unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].allowed);
        assert_eq!(
            (r[0].vsize, r[0].fee),
            (Some(111), Some(Amount::from_sat(3_000)))
        );
        assert_eq!(r[0].reject_reason, None);

        let no = json(
            r#"[{"txid": "4ee66cb92c6b923c31052c8e5391cd9e013bb4ee40b169695def7f84f2081640",
                 "wtxid": "43431444f176f3811a5fb2ea8bf57f781bfa95f53101658d8f7797bb78b3b357",
                 "allowed": false, "reject-reason": "max-fee-exceeded"}]"#,
        );
        let r = parse_accept(&no).unwrap();
        assert!(!r[0].allowed);
        assert_eq!(r[0].reject_reason.as_deref(), Some("max-fee-exceeded"));
        assert_eq!(r[0].fee, None);

        // A package that fails as a whole carries `package-error`, and no `allowed` at all.
        let pkg = json(
            r#"[{"txid": "4ee66cb92c6b923c31052c8e5391cd9e013bb4ee40b169695def7f84f2081640",
                 "wtxid": "43431444f176f3811a5fb2ea8bf57f781bfa95f53101658d8f7797bb78b3b357",
                 "package-error": "package-not-child-with-parents"}]"#,
        );
        let r = parse_accept(&pkg).unwrap();
        assert!(!r[0].allowed);
        assert_eq!(
            r[0].reject_reason.as_deref(),
            Some("package-not-child-with-parents")
        );
        assert!(parse_accept(&json(r#"{"not": "an array"}"#)).is_err());
    }

    #[test]
    fn package_results() {
        let ok = json(
            r#"{"package_msg": "success",
                "tx-results": {
                  "9852fd4d9048e8f361b001a98a11e9394c31b4f8cef5e020d791ad3cb74761a8": {
                    "txid": "633fd32121ea37e1eda217eae4d0e109d212d9af87445aef7b1f50970f03b780",
                    "vsize": 154, "fees": {"base": 0.00000310}},
                  "43431444f176f3811a5fb2ea8bf57f781bfa95f53101658d8f7797bb78b3b357": {
                    "txid": "4ee66cb92c6b923c31052c8e5391cd9e013bb4ee40b169695def7f84f2081640",
                    "vsize": 111, "fees": {"base": 0.00003000, "effective-feerate": 0.00027027}}},
                "replaced-transactions": []}"#,
        );
        let r = parse_package(&ok).unwrap();
        assert!(r.success && r.errors.is_empty() && r.replaced.is_empty());

        // The shape of a failure follows rpc/mempool.cpp (`package_msg` plus a per-transaction
        // `error`); the text of the error here is made up, not a recorded reply.
        let bad = json(
            r#"{"package_msg": "transaction failed",
                "tx-results": {
                  "43431444f176f3811a5fb2ea8bf57f781bfa95f53101658d8f7797bb78b3b357": {
                    "txid": "4ee66cb92c6b923c31052c8e5391cd9e013bb4ee40b169695def7f84f2081640",
                    "error": "mempool min fee not met, 1 < 2"}},
                "replaced-transactions": ["633fd32121ea37e1eda217eae4d0e109d212d9af87445aef7b1f50970f03b780"]}"#,
        );
        let r = parse_package(&bad).unwrap();
        assert!(!r.success);
        assert_eq!(r.message, "transaction failed");
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.errors[0].1, "mempool min fee not met, 1 < 2");
        assert_eq!(r.replaced.len(), 1);
        assert!(parse_package(&json("{}")).is_err());
    }

    #[test]
    fn max_fee_rate_is_sent_as_plain_decimal_text() {
        // 100 sat/vB is 0.001 BTC per kvB; one sat/vB would be 1e-5 as a float.
        assert_eq!(max_fee_rate_param(100_000), json("\"0.001\""));
        assert_eq!(max_fee_rate_param(1_000), json("\"0.00001\""));
        assert_eq!(max_fee_rate_param(100), json("\"0.000001\""));
    }

    #[tokio::test]
    async fn litecoin_is_never_asked_for_packages() {
        // A URL nothing listens on: the answer must come before any request is made.
        let ltc = BitcoinRpc::new("http://127.0.0.1:1", "u", "p").with_coin(Coin::Ltc);
        let tx = Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: vec![],
            output: vec![],
        };
        assert!(matches!(
            ltc.submit_package(&[tx.clone(), tx.clone()], None).await,
            Err(PackageError::Unsupported)
        ));
        assert!(matches!(
            ltc.test_accept(&[tx.clone(), tx.clone()], None).await,
            Err(PackageError::Unsupported)
        ));
        assert!(!Coin::Ltc.supports_packages());
        assert!(Coin::Btc.supports_packages());
        // A single transaction is tested alone on Litecoin: it does try the node.
        assert!(matches!(
            ltc.test_accept(&[tx], None).await,
            Err(PackageError::Rpc(_))
        ));
    }
}
