# ferryd HTTP API (v0)

Each party runs one `ferryd`. The demo UI talks to two of them (Z on :7101, B on :7102).
All responses are JSON. Amounts: `zat` (ZEC zatoshis) and `sat` (BTC satoshis), as integers.

## Listeners and authentication

`ferryd` serves two listeners:

| listener | flag (default) | routes | who calls it |
|---|---|---|---|
| control API | `--api-listen` (127.0.0.1:7101), loopback only | `/api/*` (this document) | the UI, through the Vite proxy |
| peer protocol | `--listen` (127.0.0.1:7111) | `/peer/*` | the counterparty's `ferryd`; a maker may expose it |

Every `/api/*` request needs `Authorization: Bearer <token>`. The token is `--api-token`, or a
random one generated at startup. Either way it is written to `<data-dir>/api-token` (mode 0600).
`infra/demo.sh up` exports both tokens in `.demo/env` as `FERRY_Z_TOKEN` / `FERRY_B_TOKEN`, and the
Vite proxy should inject them as the `Authorization` header. There is no CORS. A request that
carries an `Origin` header is refused (`403`) unless that origin was allowed with `--ui-origin`
(repeatable; demo.sh allows `http://localhost:5180` and `http://127.0.0.1:5180`). A missing or wrong
token gets `401`.

The `maker` URL in `POST /api/swaps` is the maker's **peer** listener (demo: `http://127.0.0.1:7112`,
exported as `FERRY_MAKER_URL`), not its control API.

Peer protocol (JSON `Envelope`s from ferry-core; the taker initiates every request):
`GET /peer/offer` (rate, role, coin, network, terms, and the live-rate fields below), `POST /peer/swaps` (`{envelope: Propose, taker_url}`
→ the `Accept` envelope), `POST /peer/swaps/:id/messages` (one taker envelope; a retry of the same
envelope is not applied twice) and `GET /peer/swaps/:id/messages?after=n` (the maker's envelopes
from index n). A stalled party answers `503`.

### Live maker rate and the offer's extra fields

A maker quotes the fixed `--maker-offer RATE[:MIN:MAX]` rate, or follows the market with
`--maker-price-feed kraken,coingecko` (or `all`) and `--maker-spread-bps N` (may be negative; default
0). `--maker-price-pair` picks the pair the feeds quote (default `ZEC/BTC`; `ZEC/LTC`, `ZEC/USD` and
`ZEC/USDC` are understood, crossed through USD where a source lists no direct market). Every ~60 s
ferryd asks each source (no API keys, 5 s timeout per call), takes the median of the ones that
answered with a fresh positive price, and sets rate = median × (1 + N/10000), in the quote's smallest
unit per ZEC. If no source has answered for 5 minutes the offer pauses (`making: false`,
`paused: true`) rather than quote a stale price. A proposal at the previous rate is still accepted for
2 minutes after a change (a taker's quote in flight). `/peer/offer` (and `offer` in `/api/status`)
then carry:

```json
{ "rate_source": "median(kraken,coingecko) +50bps",  // or "fixed"
  "rate_updated_at": 1792404387,                     // unix seconds of the price; absent when fixed
  "liquidity": { "zec_zat": 240000000 },             // the largest ZEC amount the maker's balance
                                                     // covers now, capped at max_zat
  "paused": false }
```

All four are optional for a taker: an older maker leaves them out.

## Maker directory (UI server, not ferryd)

The UI servers (`web/server/prod.mjs`, and the Vite dev server) list the makers the operator
allowlists in `FERRY_MAKERS` (JSON `[{"name","url","pair"}]` or `name|url|pair, …`; default: the one
maker at `FERRY_MAKER_URL`). `GET /api/makers` returns, per maker, what its `/peer/offer` says,
fetched server-side (2.5 s timeout, 16 KB cap, cached 10 s):

```json
{ "makers": [ { "index": 0, "name": "Kestrel", "pair": "ZEC/BTC", "online": true, "available": true,
  "paused": false, "role": "B", "rate_sat_per_zec": 412350, "min_zat": 5000000, "max_zat": 500000000,
  "fee_sat": 2000, "liquidity_zat": 240000000, "rate_source": "median(kraken,coingecko) +50bps",
  "rate_updated_at": 1792404387, "rate_age_s": 20 } ] }
```

The browser starts a swap with `POST /daemon/z/api/swaps {"maker": "Kestrel" | 0, "zec_zat": …}`;
the UI server replaces `maker` with that entry's allowlisted URL (leaving it out picks the first
maker). Any other value, a URL included, is refused with `400`, so a client can never make a daemon
fetch a URL of its choosing.

## GET /api/status

```json
{
  "role": "Z",                      // "Z" holds ZEC, "B" holds BTC
  "name": "zoe",
  "balances": { "zec_shielded_zat": 500000000, "btc_sat": 0 },
  "chains": {
    "btc": { "coin": "btc", "ticker": "BTC", "network": "regtest", "height": 412 },
    "zec": { "network": "regtest", "height": 233, "pool": "ironwood" }
  },
  "offer": { "pair": "ZEC/BTC", "rate_sat_per_zec": 410000, "min_zat": 10000000, "max_zat": 1000000000,
             "fee_sat": 2000, "t1_blocks": 12, "t2_blocks": 24, "btc_lock_confs": 2, "zec_confs": 3 }
  // fee_sat: the fixed fee of each presigned BTC transaction (the redeem pays one; the refund
  // path pays two: cancel + refund). t1/t2 in BTC blocks; confirmations Z/B wait for.
}
```

**Litecoin.** A daemon started with `--chain ltc` swaps ZEC against LTC (docs/LITECOIN.md). Then
`chains.btc` is `{ "coin": "ltc", "ticker": "LTC", … }`, `offer.pair` is `"ZEC/LTC"` and every
`btc_*`/`*_sat` field holds litoshis (1e-8 LTC): the field names stay the same for either coin.
Swap views carry `"coin": "ltc"`, addresses are Litecoin-encoded (`rltc1…`), and timeline labels
and observer lines name the coin ("0.5 LTC", "fee 2000 lit", "the Litecoin transaction").
A taker refuses a maker whose offer is for another coin, and a maker refuses a Propose for
another coin; the coin is part of `SwapParams` and so of the transcript.

**USDC on an EVM chain.** A daemon started with `--counter evm` swaps ZEC against an ERC-20 in
FerryLock (docs/EVM.md). The same paths answer, in the same shape:
- `chains.btc` is `{ "coin": "usdc", "ticker": "USDC", "decimals": 6, "network": "anvil" |
  "base-sepolia" | "base", "height", "time" }`, where `time` is the latest block's unix time.
- `btc_sat` fields hold token base units.
- `balances.eth_wei` is gas money.
- `offer` has `pair: "ZEC/USDC"`, `rate_sat_per_zec` in token units per ZEC, and `t1_secs`,
  `refund_secs` and `delta_secs` instead of block counts.
- A `counter` block names the chain id, contract, token and our account.

Swap views add `deadlines.t1_unix`, `t2_unix` and `now_unix` (block time) and a `counter` block
(swap id, claimer, refunder, the share commitments `z_addr`/`b_addr`, `ready_signed`). The
timeline reuses the Bitcoin kinds where the step is the same:
- `btc_lock_broadcast` / `btc_lock_seen`: the FerryLock lock.
- `redeem_adaptor_sent` / `redeem_adaptor_received`: B's Ready signature.
- `btc_redeem_broadcast`: the claim.
- `cancel_seen`: t1 passed without a claim.
- `refund_broadcast` / `punish_broadcast`: the refund and the punish.

It also adds `terms_agreed`, `claim_seen` and `refund_seen`. `GET /peer/offer` is an `EvmOffer`
(`counter: "evm"`, `token_symbol`…), and the peer messages are EVM envelopes.

## POST /api/swaps

Start a swap as taker against a maker.

```json
{ "maker": "http://127.0.0.1:7112", "zec_zat": 100000000 }
```
→ `201 { "id": "f3c1…" }`

## GET /api/swaps  → `[SwapView]`
## GET /api/swaps/:id → `SwapView`

```json
{
  "id": "f3c1…",
  "coin": "btc",                    // the coin swapped against ZEC: "btc" | "ltc"
  "role": "Z",
  "counterparty": "http://127.0.0.1:7102",
  "state": "ZecLocked",             // see state list below
  "outcome": null,                  // null | "swapped" | "refunded" | "punished"
  "amounts": { "zec_zat": 100000000, "btc_sat": 410000 },
  "deadlines": { "t1_blocks": 12, "t2_blocks": 24, "btc_lock_height": 405, "cancel_height": null },
  "keys": {
    "my_share_point_pallas": "hex", "my_share_point_secp": "hex",
    "peer_share_point_pallas": "hex", "peer_share_point_secp": "hex",
    "dleq_verified": true,
    "joint_ak": "hex", "sigma": 1
  },
  "addresses": { "btc_lock": "bcrt1p…", "zec_joint": "uregtest1…" },
  "secrets": { "mine_revealed": false, "peer_learned": false },
  "timeline": [
    { "at": "2026-10-16T13:05:01Z", "chain": "local|btc|zec|peer", "kind": "btc_lock_broadcast",  // see "Timeline kinds"
      "label": "Human-readable sentence", "txid": "hex|null", "height": 407 }
  ],
  "observer": {
    "btc": ["Taproot output 0.0041 BTC (2 script leaves, internal key unspendable)", "…"],
    "zec": ["Ironwood action (amount, sender, receiver encrypted)", "…"]
  },
  "watchtower": { "url": "http://…", "status": "pending|armed|refused", "package_id": "hex|null",
                  "note": "Human-readable sentence", "next_try_ms": 0 }   // null without --watchtower
}
```

`watchtower` is our package at a [watchtower](WATCHTOWER.md) (`ferryd --watchtower URL`). It is
`pending` until tx_cancel is co-signed (with `--counter evm`: until the FerryLock lock is on
chain) and the upload succeeds (failed uploads retry every 10 s), then `armed`, with a
`watchtower_armed` timeline entry. It is `refused` when the tower rejected the
package, or when B runs without `--watchtower-own`; `note` says why, and the timeline has a
`watchtower_refused` entry.

`observer` lists what a public chain observer can see for this swap, one line per transaction.
It is what the UI's "what each chain sees" panel renders. A line may start with a short transaction
name followed by `": "` (for example `"tx_lock: a P2TR output of 0.0041 BTC…"`); the UI shows that name
separately. Both parties return the same observer lists, since they describe public data.

### Swap ids are shared

The taker's `201 { "id" }` is the swap's session id, and the maker stores the same swap under the
**same id**. The UI shows one swap by looking up that id on both daemons (`GET /api/swaps` and the
`swap` events). If the ids differ, the two panels can't be paired.

### Field semantics the UI relies on

- `timeline` is in chronological order and append-only. `timeline[0].at` is treated as the swap's
  start time. The UI picks the swap with the latest start as the current one.
- A transaction entry has `txid` set and `height: null` while the transaction is in the mempool.
  When it confirms, **the same entry's `height` is filled in**; don't append a second entry. The UI
  draws `height == null` as "in mempool".
- `deadlines.btc_lock_height` is null until `tx_lock` confirms. `deadlines.cancel_height` is null
  until `tx_cancel` confirms. T1 = `btc_lock_height + t1_blocks` and T2 = `cancel_height + t2_blocks`.
  Before a cancel, the UI shows T2 at its earliest (`btc_lock_height + t1_blocks + t2_blocks`).
- `secrets.mine_revealed` becomes true when this party's share is visible on Bitcoin: Z's `z` once
  `tx_redeem` is broadcast, B's `b` once `tx_refund` is broadcast. `secrets.peer_learned` becomes
  true when this party has extracted the peer's share from a witness. This flag drives the UI's
  "magic moment".
- `outcome` is set once this party has nothing left to do. The UI treats the swap as finished when
  **both** parties have a non-null `outcome`.

## Timeline kinds

The UI draws the crossing from these `kind`s, so their names and the party that emits them are part
of the contract. "Tx" means the entry carries the `txid` and follows the `height` rule above.

| kind | emitted by | chain | tx | UI use |
|---|---|---|---|---|
| `btc_lock_broadcast` | B | btc | yes | step 1. BTC token moves to the lock output |
| `zec_lock_broadcast` | Z | zec | yes | step 2. ZEC token moves to the joint note |
| `btc_redeem_broadcast` | Z | btc | yes | step 3. BTC token moves to Z |
| `secret_extracted` | B (happy path) or Z (refund path) | btc | yes, the redeem or refund tx | highlighted entry (the magic moment). Set `secrets.peer_learned` together with it |
| `zec_sweep_broadcast` | B | zec | yes | step 4. ZEC token moves to B |
| `cancel_broadcast` | whichever party broadcast `tx_cancel` (Z or B) | btc | yes | switches the chart to the abort path. BTC moves to the cancel output |
| `refund_broadcast` | B | btc | yes | refund path. BTC returns to B |
| `zec_reclaim_broadcast` | Z | zec | yes | refund path, after Z extracts `b`. ZEC returns to Z |
| `punish_broadcast` | Z | btc | yes | punish path. BTC goes to Z; the ZEC stays in the joint note |
| `zec_lock_refused` | Z | local | no | Z's wallet refused to fund the ZEC lock shielded-only (e.g. too few Ironwood notes); nothing was sent. Z's state becomes `ZecLockRefused`, then the abort path (B cancels and refunds; Z ends `Refunded`) |
| `fault_injected` | the stalled party | local | no | shows a "Stalled" badge and disables both fault buttons |
| `fault_cleared` | the stalled party | local | no | ends the stall started by the last `fault_injected` |

The other kinds are only rendered as text (`label`, plus `txid`/`height` when present), so they are
free-form. The mock uses: `propose_sent`, `propose_received`, `dleq_verified`, `accept_sent`,
`lock_template_sent`, `cancel_sigs_sent`, `refund_adaptor_verified`, `cancel_sig_received`,
`btc_lock_seen`, `zec_note_seen`, `zec_confirmed`, `redeem_adaptor_sent`, `redeem_adaptor_received`,
`cancel_seen`, `punish_seen`, `swap_complete`, `refunded`, `reclaimed`, `punished`. ferryd also
emits `sweep_delayed` (local) when it schedules the random delay before a ZEC sweep or reclaim, and
`peer_message_ignored` / `peer_message_rejected` for a late or invalid peer message.

`label` is a full sentence written from the emitting party's point of view, for example
`"Broadcast tx_lock: 0.0041 BTC to the Taproot lock address"`. The UI shows the newest label from
either party as the one-line narration under the chart.

## GET /api/events (Server-Sent Events)

`event: swap` with a `SwapView` body on every state change; `event: status` with the status body
whenever a balance or height changes.

## Errors

Every non-2xx response has a JSON body `{ "error": "Human-readable sentence" }`. The UI shows
`error` verbatim under the controls, so it should say what is wrong. For `POST /api/swaps`:

- `400`: bad body, amount outside the offer's `min_zat`/`max_zat`, or insufficient funds
- `409`: a swap is already in progress

## POST /api/swaps/:id/fault (demo only)

Only exists when `ferryd` runs with `--demo-faults` (demo.sh passes it). Otherwise it is `404`.

`{ "fault": "stall" }` → `200 { "ok": true }` makes this party stop acting, to demonstrate the
cancel/refund/punish paths. While stalled, a party sends no messages and broadcasts nothing. Its
chain watcher keeps running, so its `state`, `timeline` and `outcome` still follow what happens
on-chain (for example B moves to `Punished` when Z's `tx_punish` confirms).

- **Z stall:** Z comes back online when it sees `tx_cancel` confirmed and emits `fault_cleared`.
  It can then extract `b` from B's refund and reclaim its ZEC (`zec_reclaim_broadcast` →
  `ZecReclaimed`). Story: Z stalls, B cancels after T1, B refunds, Z reclaims.
- **B stall:** B stays stalled. Story: B stalls, Z cancels after T1, there is no refund by T2, and
  Z punishes.

Errors (`{ "error" }`):

- `400`: unknown fault
- `404`: unknown swap id
- `409`: the fault no longer changes the outcome, or the party is already stalled. The mock
  accepts a Z stall in `CancelSigned`, `BtcLockSeen`, `ZecLocked` and `RedeemSigReceived` (before
  `tx_redeem` is broadcast). It accepts a B stall in `BtcLocked` and `ZecSeen` (before the redeem
  adaptor is sent). The UI enables the buttons in exactly these states.

## States

B: `Negotiated → LockBuilt → CancelSigned → BtcLocked → ZecSeen → RedeemSigSent → BtcRedeemed → ZecSwept`
   or `→ Cancelled → Refunded` / `→ Punished`

Z: `Negotiated → CancelSigned → BtcLockSeen → ZecLocked → RedeemSigReceived → BtcRedeemed`
   or `→ Cancelled → ZecReclaimed` / `→ Punished`, or, when its wallet refuses the ZEC lock,
   `ZecLocked → ZecLockRefused → Cancelled → Refunded`
