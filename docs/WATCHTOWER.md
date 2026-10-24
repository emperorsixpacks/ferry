# Watchtower

Without help, a Ferry party has to stay online until its deadline. B has to be there to cancel
and refund before T2 − Δ, and Z has to be there to punish if B disappears. The watchtower takes
that job. You give it your **fully signed** deadline-critical Bitcoin transactions, and it
broadcasts each one when the timing rules allow, while you are offline.

It holds **no keys** and every transaction it gets pays only you (or the swap's own cancel
output), so it cannot redirect your coins. Acting on its own, the worst it can do is fail to
act. That is the old risk of being offline yourself. One caveat for B: B's package must stay
private until it is due (see [What a tower can do](#what-a-tower-can-do)).

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

- its network is the tower's, and the terms leave a refund window (`t2 > Δ + k`, `k ≥ 1`, `Δ ≥ 1`);
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
GET  /health                                → {ok, network}            (no auth)
```

With `--token-file`, `/packages*` need `Authorization: Bearer <token>`.

Package (`ferry_watchtower::Package`; `Package::new` builds one from a `SwapTxs`):

```json
{
  "version": 1, "role": "B", "network": "regtest",
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

## Running it

```
ferry-watchtower --data-dir ~/.ferry-watchtower --network signet \
  --btc-rpc http://127.0.0.1:38332 --btc-rpc-user ferry --btc-rpc-pass-file rpcpass \
  --token-file ~/.ferry-watchtower/token --listen 127.0.0.1:7700
```

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

## What a tower can do

| | Can it? |
|---|---|
| Take or redirect your BTC | **No.** It has no keys, and every transaction pays you or the swap's cancel output. |
| Broadcast early | **No.** `tx_cancel` and `tx_punish` are timelocked by consensus, and `tx_refund` needs a confirmed `tx_cancel`. |
| Fail to act | **Yes.** If it is down, eclipsed or censored, you are back to the old rule: be online yourself. |
| Bump fees | **No.** The transactions carry fixed presigned fees, as everywhere in Ferry. If fees spike, they confirm slowly. |
| **Leak B's refund to Z early** | **Yes, and this is what B trusts it with.** |

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
- A further safeguard belongs in ferryd: B should not send the redeem adaptor signature if the
  ZEC lock note is already spent (today B only checks its value and confirmations). This closes
  the case where Z learns `b` early and pulls its ZEC out before B has committed to anything.

## Privacy

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
  validation (wrong network, missing or extra transactions, payout not listed, wrong outpoints,
  edited timelock, wrong amount, bad or missing signatures, extra witness items), persistence,
  and output-state derivation.
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
