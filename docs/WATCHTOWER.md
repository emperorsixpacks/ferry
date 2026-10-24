# Watchtower

Without help, a Ferry party has to stay online until its deadline. B has to be there to cancel
and refund before T2 − Δ, and Z has to be there to punish if B disappears. The watchtower takes
that job. You give it your **fully signed** deadline-critical Bitcoin transactions, and it
broadcasts each one when the timing rules allow, while you are offline.

It holds **no keys** and every transaction it gets pays only you (or the swap's own cancel
output), so it cannot redirect your coins. Acting on its own, the worst it can do is fail to
act. That is the old risk of being offline yourself. One caveat for B: B's package must stay
private until it is due (see [What a tower can do](#what-a-tower-can-do)). On EVM, B's package
holds B's key share itself, which makes that caveat stronger.

It guards all three counter-chains:

- **Bitcoin** and **Litecoin** (`--chain ltc`): the same presigned transactions and rules, below.
  Litecoin differs only in the node it follows ([Litecoin](#litecoin)).
- **USDC on an EVM chain** (`--counter evm`): FerryLock has no presigned transactions, so the
  tower calls the contract's `refund` or `punish` itself, from its own account. Z's package is
  still keyless; B's carries B's key share `b`. See [USDC on EVM](#usdc-on-evm-ferrylock).

Crate: `crates/ferry-watchtower` (library + `ferry-watchtower` binary).

## What each party hands over

| Owner | Transactions | When the owner can build them |
|---|---|---|
| **B** | `tx_cancel` (signed by both); `tx_refund`, **completed**: Z's adaptor signature decrypted with `b`, plus B's own signature | from `CancelSigned` |
| **Z** | `tx_cancel`; `tx_punish` (Z's signature) | from `CancelSigned` |

Not delegated:

- **Z's `tx_redeem`.** Z can always come back for it. If Z misses the redeem window, the swap
  is called off and Z gets its ZEC back through B's refund (or the BTC through its punish), so
  Z loses the swap but no funds.
- **The ZEC side.** B's sweep after a redeem and Z's reclaim after a refund have no deadline: the
  joint note waits until the owner returns.

## Rules

T1 and T2 are relative timelocks (`CSV`), counted in confirmations of the lock (T1) and of
`tx_cancel` (T2), exactly as in `ferry_core::SwapParams`.

| Transaction | Broadcast when | Never |
|---|---|---|
| `tx_cancel` | the lock has ≥ T1 confirmations and the lock output is unspent | — |
| `tx_refund` (B) | `tx_cancel` has ≥ k confirmations, **< T2 − Δ**, the cancel output is unspent and the node is out of IBD | at or after T2 − Δ: it would reveal `b` while Z can still punish |
| `tx_punish` (Z) | `tx_cancel` has ≥ T2 confirmations and the cancel output is unspent | — |

- **Stop** as soon as the relevant output is spent in a block by anything. A redeem spends the
  lock: both packages end. A refund spends the cancel output: Z's package ends, and the status
  tells Z to come back for its ZEC. A punish ends B's.
- **Hold**, without stopping, while someone else's spend of the output sits in the mempool. A
  mempool transaction can still be evicted.
- **Rebroadcast.** A transaction that drops out of the mempool is sent again on the next poll
  while its rule still allows it. A refund is never re-sent after T2 − Δ, the same rule as
  ferryd's own rebroadcaster.
- The tower concludes "spent by someone else" only once its watch wallet has processed the
  node's tip and is not rescanning. A wallet that lags the node never makes it give up early.

The rules are a pure function, `engine::decide(rules, observation)`, with unit tests for every
case above.

## Validation on upload

`POST /packages` refuses a package unless:

- its coin and network are the tower's, and the terms leave a refund window (`t2 > Δ + k`, `k ≥ 1`,
  `Δ ≥ 1`);
- every transaction parses and is 1-in-1-out. `tx_cancel` spends `lock_outpoint`, and
  `tx_refund` / `tx_punish` spends the output of this `tx_cancel`;
- each transaction is **exactly the swap's template**. The tower rebuilds the scripts and
  transactions from `kb`, `kz`, T1, T2, the lock and the fee, so the timelocks, the cancel script
  and the amounts are the agreed ones;
- **every signature verifies**, under the right leaf and control block. A refund whose Z
  signature was never decrypted is refused at upload, not discovered at the deadline;
- `tx_refund` / `tx_punish` pays one of the owner's `payout_addresses`.

## API

```
POST /packages        Package JSON          → 201 {id, created: true, status}
                                              200 {id, created: false, ...} same txs already registered
                                              400 invalid · 401 token · 409 different txs for this lock · 503 node
GET  /packages/{id}                         → status view (below)
GET  /health                                → {ok, counter: "btc", chain, network}   (no auth)
                                              {ok, counter: "evm", chain_id, account}  (--counter evm)
```

A package for the other kind of tower (an EVM package on a Bitcoin tower, or the reverse) is
refused with `400` and says what the tower watches.

With `--token-file`, `/packages*` need `Authorization: Bearer <token>`.

Package (`ferry_watchtower::Package`; `Package::new` builds one from a `SwapTxs`):

```json
{
  "version": 1, "role": "B", "coin": "ltc (absent for btc)", "network": "regtest",
  "lock_outpoint": "<txid>:<vout>", "lock_amount_sat": 50000000,
  "kb": "<x-only hex>", "kz": "<x-only hex>", "keypath": true,
  "t1": 12, "t2": 24, "cancel_confirmations": 1, "refund_margin": 3,
  "cancel_tx": "<hex>", "refund_tx": "<hex>",
  "payout_addresses": ["bcrt1p..."], "label": "optional, e.g. the swap id"
}
```

A Z package carries `punish_tx` instead of `refund_tx`.

The status view has `status` (`armed` → `cancel_broadcast` → `refund_broadcast` /
`punish_broadcast` → `done`), `outcome` (`redeemed`, `refunded`, `punished`,
`lock_mismatch`), `advice` (what the owner should do next), `note` (what the tower is waiting
for), the txids, the confirmation counts, a broadcast log with the counts each transaction was
sent at, and an event log. It **never contains the transactions themselves**.

## With ferryd

```
ferryd … --watchtower http://127.0.0.1:7700 --watchtower-token-file ~/.ferry-watchtower/token [--watchtower-own]
```

Once tx_cancel is co-signed (`CancelSigned`, for both roles) ferryd builds its package and uploads
it. A failed upload is retried every 10 seconds. The swap view and the UI then show **Watchtower
armed**, and the timeline gets a `watchtower_armed` entry. The same flags work with `--chain ltc`
(the tower must run with `--chain ltc`) and with `--counter evm` (the tower must run with
`--counter evm`; ferryd uploads once the FerryLock lock is on chain).

- **B arms only a tower marked as its own** (`--watchtower-own`). Without the flag, B logs why,
  marks the tower `refused` in the swap view, and adds a `watchtower_refused` timeline entry.
  Z's package holds no secret, so Z arms any tower.
- **B reaches its tower over https, or plain http only on this machine** (127.0.0.0/8, ::1,
  `localhost`). B's package lets whoever reads it publish `b`, so ferryd refuses to start with
  `--watchtower-own` and a remote `http://` URL. Z may use plain http.
- **B never sends the redeem adaptor once the ZEC lock note is spent.** B has not swept, so a spent
  note means someone else already holds the joint key, for example Z after learning `b` from a
  leaked refund. Sending the adaptor would then hand Z the BTC as well, so B withholds it and the
  swap runs into cancel and refund. ferryd reports the note as spent only for a mined or still-live
  transaction. (Sim test `no_redeem_adaptor_once_the_lock_note_is_spent`.)

`infra/demo-watchtower.sh run` plays this end to end on regtest with mock ZEC. B arms its own tower,
locks BTC and is killed; its tower calls the swap off and refunds it, and Z reclaims its ZEC. Then B
runs without `--watchtower-own` and refuses to arm. B is killed after locking and Z after
locking ZEC; Z's tower calls the swap off and punishes. Each party comes back to a finished swap.
`CHAIN=ltc` plays the same against litecoind regtest (MWEB active, no `-txindex`), and
`CHAIN=evm` against FerryLock on anvil: B's tower refunds at t1 (anvil's clock is jumped to the
deadlines) and Z's tower punishes at t2, after checking nothing went out before.

## Running it

```
ferry-watchtower --data-dir ~/.ferry-watchtower --network signet \
  --btc-rpc http://127.0.0.1:38332 --btc-rpc-user ferry --btc-rpc-pass-file rpcpass \
  --token-file ~/.ferry-watchtower/token --listen 127.0.0.1:7700
```

One tower follows one chain. For Litecoin add `--chain ltc` and point `--btc-rpc` at litecoind;
for FerryLock see [USDC on EVM](#usdc-on-evm-ferrylock).

- Needs a bitcoind with wallet support. The tower creates a blank watch-only wallet
  (`--btc-watch-wallet`, default `ferry-watchtower`), with no keys, and imports each swap's
  lock and cancel addresses into it. That works on a pruned node without `-txindex`. Bitcoin Core
  26 or newer is recommended (`getwalletinfo.lastprocessedblock`).
- One JSON file per package under `<data-dir>/packages` (mode 0600, directory 0700), written
  atomically. A restarted tower picks up where it left off.
- Off loopback, `--token-file` is required (or `--open` for a private network).
- Run more than one tower for redundancy: packages are plain data and any number of towers can
  hold the same one. For B, every extra tower is one more party that must keep the package
  private (below).

## Litecoin

`ferry-watchtower --chain ltc --btc-rpc <litecoind>` follows a Litecoin Core ≥ 0.21.2 node.
Packages carry `"coin": "ltc"` (absent means Bitcoin, so older packages still parse), and a tower
refuses any package for another coin or network. The transactions, templates, signatures and
rules are byte-for-byte the Bitcoin ones ([LITECOIN.md](LITECOIN.md)); what differs:

- **The watch wallet is a legacy watch-only wallet** (Litecoin Core 0.21 has no descriptor
  wallets). The tower creates it blank with private keys disabled and imports each swap's lock
  and cancel addresses with `importmulti`. As on Bitcoin, this works without `-txindex`.
- Payout addresses are written in Litecoin's encoding (`rltc1…`, `ltc1…`). A Bitcoin-encoded
  address for the same script is refused, so a package can't be mistaken for the other chain's.
- Litecoin Core 0.21 has no `getwalletinfo.lastprocessedblock`, so the tower takes the wallet as
  caught up unless it reports a rescan in progress (as with Bitcoin Core before 26).

ferryd `--chain ltc` arms a tower exactly as on Bitcoin, with the same `--watchtower-own` rule
for B and the same refusal to send the redeem adaptor once the ZEC lock note is spent.

## USDC on EVM (FerryLock)

`ferry-watchtower --counter evm --evm-rpc <url> --evm-key-file <file>` guards swaps made with
`ferryd --counter evm` ([EVM.md](EVM.md)). FerryLock checks absolute block-time windows instead of
presigned transactions: refund in [t1, t2), punish from t2, and **anyone** may send either call.
The contract pays the swap's own `refunder` (B) or `claimer` (Z), never the caller.

| Owner | Package | The tower calls |
|---|---|---|
| **Z** | swap id, terms, contract, chain id. **No secret.** | `punish(id)` once the latest block's time is ≥ t2 |
| **B** | the same plus **B's share `b`** | `refund(id, b)` while the latest block's time is in [t1, t2 − Δ) |

**Why B hands `b` only to its own tower.** `refund` needs `b`, and publishing `b` is what lets Z
reclaim its ZEC. So the tower holds the secret itself, not a signed transaction that only becomes
valid later. If the tower passed `b` to Z (or simply sent a refund that reverts) before t1, Z would
hold both halves of the ZEC key while the tokens can still be claimed: Z could take its ZEC back
and, once B has sent Ready, claim the USDC as well. That is the same trust B places in a Bitcoin
tower that holds its completed refund, only more direct. So, as on Bitcoin:

- ferryd arms an EVM tower for B only with `--watchtower-own`. Without it B refuses, says why,
  and logs `watchtower_refused`.
- B never signs Ready once the ZEC lock note is spent (sim test
  `no_ready_once_the_lock_note_is_spent`). A leak before B has committed to anything lets Z pull
  its ZEC out, but not also take the tokens.

Z's package holds nothing secret: Z can hand it to any tower, which is trusted only to stay up.

**Rules** (`evm::engine::decide`, unit-tested; times are the latest block's timestamp, never the
local clock, and the next block is never earlier):

| Call | Sent when | Never |
|---|---|---|
| `refund` (B) | the swap is `Locked`, latest block time ≥ t1 and < t2 − Δ, and the node's latest block is no older than `--evm-max-lag-secs` (120) by the local clock | before t1 (a reverted refund still publishes `b` while Z can claim); at or after t2 − Δ (it could land after t2, when Z can punish) |
| `punish` (Z) | the swap is `Locked` and latest block time ≥ t2 | before t2 |

- **Stop** once the contract shows the swap `Claimed`, `Refunded` or `Punished`, whoever did it.
  Terms on chain that differ from the package end it as `lock_mismatch`.
- **Simulate first.** Every call goes through `eth_call` and `eth_estimateGas` and is sent only if
  both pass. Right before sending, the tower reads the latest block again and re-checks the window.
- **Hold** while its own call is pending. If the node drops it or it reverts, the tower may send
  again while the rule still allows it.
- **Gas** comes from the tower's own key (`--evm-key-file`): created at random (mode 0600) if the
  file is missing, refused if other users can read it, never printed. Its address is in the log
  and in `GET /health`; fund it with a little ETH. Without gas the tower cannot act, which is the
  same as being offline.

**Validation on upload.** Offline: version, `counter: "evm"`, the tower's chain id, terms that
FerryLock accepts (`0 < amount`, `max_tip ≤ amount`, no zero addresses, `0 < t1 < t2`), a refund
window (`t1 + Δ < t2`, Δ ≥ 1 s), `b·G` equal to `b_addr` for B and no `b` for Z, and the payout is
the owner's: B's `payout_addresses` must include `refunder`, Z's `claimer`. Against the chain: the
code at `contract` is this build's FerryLock (and one of `--evm-contract`, if given), and the swap
exists with exactly these terms. A swap not on chain yet gets `503` (ferryd retries).

EVM package (`ferry_watchtower::EvmPackage`; ferryd builds it from the session's lock terms):

```json
{
  "version": 1, "counter": "evm", "role": "B", "chain_id": 84532,
  "contract": "0x…", "swap_id": "0x…",
  "terms": { "token": "0x…", "amount": "250000000", "z_addr": "0x…", "b_addr": "0x…",
             "claimer": "0x…", "refunder": "0x…", "t1": 1792479205, "t2": 1792479325,
             "max_tip": "0" },
  "refund_margin": 15, "b": "<32-byte hex, B only>",
  "payout_addresses": ["0x… (the refunder)"], "label": "optional, e.g. the swap id"
}
```

The status view (`GET /packages/{id}`) has the same `status`, `outcome`, `advice` and `note`, the
latest block time, the pending call, and a log of each call with the block time it was sent at. It
**never contains `b`**.

**What the tower learns** on EVM: everything in the lock (which is public anyway), and for B the
share `b`, which becomes public only on a refund. Nothing about the ZEC side.

## What a tower can do

| | Can it? |
|---|---|
| Take or redirect your BTC or LTC | **No.** It has no keys, and every transaction pays you or the swap's cancel output. |
| Take or redirect your USDC | **No.** FerryLock pays only the swap's own refunder or claimer, whoever calls. |
| Broadcast early | **No.** `tx_cancel` and `tx_punish` are timelocked by consensus, and `tx_refund` needs a confirmed `tx_cancel`. FerryLock refuses `punish` before t2 and `refund` outside [t1, t2). |
| Fail to act | **Yes.** If it is down, eclipsed or censored, or (EVM) its own account has no gas, you are back to the old rule: be online yourself. |
| Bump fees | **No** on Bitcoin and Litecoin: the transactions carry fixed presigned fees, as everywhere in Ferry. On EVM it pays the going gas price from its own account. |
| **Leak B's refund (or, on EVM, `b`) to Z early** | **Yes, and this is what B trusts it with.** On EVM it could even publish `b` itself with a refund that reverts. |

**Why B's package is sensitive.** The completed `tx_refund` carries Z's signature, decrypted with
`b`. Anyone who also holds Z's encrypted signature, which means Z, can subtract the two and get
`b`. On chain that is by design: the refund is how Z gets its ZEC back. But if a tower hands the
refund to Z **before `tx_cancel` is confirmed**, Z learns `b` while the lock can still be
redeemed. Z then holds both halves of the ZEC key and can sweep its ZEC back. If B has also sent
its redeem adaptor signature, Z can redeem the BTC too and take both sides.

So:

- **B must use a tower it trusts not to collude with its counterparty.** Never use a tower run
  by the maker you are swapping with. Your own always-on machine is the simplest choice.
- The tower never serves the transactions back. `GET /packages/{id}` shows only status and
  txids, with or without a token.
- Z's package contains no secret. A Z tower is trusted only to stay up.
- ferryd enforces this: B arms a tower only with `--watchtower-own`.
- B never sends the redeem adaptor signature once the ZEC lock note is spent. That covers a leak
  before B has committed to anything: Z can pull its ZEC out, but it can't also get the BTC.

## Privacy

For EVM swaps, see [USDC on EVM](#usdc-on-evm-ferrylock). On Bitcoin and Litecoin:

- **The tower learns the swap's Bitcoin side:** the lock outpoint and amount, both BTC keys,
  T1/T2, the cancel, refund or punish transactions, and your payout address. All of this
  becomes public on chain when the swap is called off. On the happy path it would otherwise
  stay a key-path payment that looks like any single-key wallet's, so the tower can link the
  lock and the redeem to a swap.
- **It learns nothing about ZEC:** no Zcash keys, viewing keys, addresses, amounts or notes. It
  cannot link the swap to any Zcash transaction.
- It sees your IP address when you upload. Reach it over Tor or a VPN if that matters.

## Tests

- `cargo test -p ferry-watchtower`: the rule engine (every rule and stop condition), package
  validation (wrong network or coin, missing or extra transactions, payout not listed or in the
  other coin's encoding, wrong outpoints, edited timelock, wrong amount, bad or missing
  signatures, extra witness items), persistence, and output-state derivation. For EVM: the rules
  (before t1, inside [t1, t2 − Δ), after t2 − Δ, after t2, already claimed / refunded / punished,
  pending call, stale node) and package validation (wrong chain, version or counter, `b` missing,
  not matching `b_addr` or present in a Z package, payout not the owner's, deadlines without a
  refund window, bad terms); the view never shows `b`.
- `tests/anvil.rs` (spawns anvil on 127.0.0.1:18545, tower API on 7707): registration is refused
  for a swap not on chain, different terms, another payee, a non-FerryLock contract and another
  chain; B's package refunds at t1 and nothing goes out before; with the tower back only after
  t2 − Δ, B's refund is held and Z's package punishes at t2; a claimed swap gets no call at all;
  a restarted tower serves its views, which never contain `b`.
- ferryd: B refuses an EVM tower without `--watchtower-own`, the EVM package passes the tower's
  validation, and nothing is uploaded before the lock is on chain.
- `crates/ferry-watchtower/scripts/regtest.sh start` starts a regtest bitcoind (container
  `ferry-wt-regtest`, RPC 127.0.0.1:18943, no `-txindex`). Then run
  `cargo test -p ferry-watchtower --test regtest -- --ignored --test-threads=1`. The owner
  uploads, broadcasts the lock and goes offline:
  - **B offline:** the tower cancels at T1, refunds after k cancel confirmations and before
    T2 − Δ (checked on chain and in the broadcast log), and the refund pays B's address. Z's
    package on the same tower stops at the refund and never punishes.
  - **Z offline (B gone too):** the tower cancels, is restarted from its data dir, then punishes
    at T2, paying Z's address.
  - **Redeem:** both packages hold while the redeem is in the mempool, stop once it confirms, and
    broadcast nothing even well past T1 and T2.

  `FERRY_CHAIN=ltc` runs the same three against litecoind (`infra/ltc/regtest.sh start`, or set
  `FERRY_WT_BTC_RPC`), through the legacy watch-only wallet.
- `infra/demo-watchtower.sh run` plays both stories end to end (below) with ferryd and mock ZEC;
  `CHAIN=ltc` and `CHAIN=evm` play them on Litecoin and on FerryLock, and `run-all` plays all three.
