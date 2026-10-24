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
`GET /peer/offer` (rate, role, coin, network, terms, and the live-rate fields below), `POST /peer/quote`
(a signed firm quote for an amount bucket; see [Firm quotes](#firm-quotes)), `POST /peer/swaps`
(`{envelope: Propose, taker_url, quote_id?}` → the `Accept` envelope), `POST /peer/swaps/:id/messages`
(one taker envelope; a retry of the same envelope is not applied twice) and
`GET /peer/swaps/:id/messages?after=n` (the maker's envelopes from index n). A stalled party answers
`503`.

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

All four are optional for a taker: an older maker leaves them out. A maker (any daemon started with
`--maker-offer`) also publishes `"quote_key": "02…"`, the key it signs firm quotes with.

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

## Firm quotes

The user says what they want (pair, direction, amount); partners answer with firm prices; the best
one is taken; settlement is the same atomic swap, so nobody holds funds in between. The plain-language
account, with what a partner learns, is in [ARCHITECTURE.md](ARCHITECTURE.md#firm-quotes).

**Buckets.** A quote request never carries the amount, only the bucket it rounds UP into: 0.1, 0.25,
0.5, 1, 2.5, 5, 10, 25, 50 or 100 ZEC (`10000000` … `10000000000` zat). A quote for a bucket covers
the amounts from the bucket below it (0 for the first) up to the bucket, within the maker's
`min_zat`/`max_zat` and what its balance fills now. Above 100 ZEC there is no firm quote.

### POST /peer/quote (maker)

```json
{ "pair": "ZEC/BTC", "taker_role": "Z", "bucket_zat": 100000000 }
```
→ `200`
```json
{ "v": 1, "quote_id": "4ca9993e262d936bd8b8137e704a3c96", "pair": "ZEC/BTC",
  "market": "btc:regtest", "maker_role": "B", "taker_role": "Z",
  "rate_sat_per_zec": 412350, "min_zat": 50000000, "max_zat": 100000000,
  "issued_at": 1792488310, "expires_at": 1792488355,
  "maker_key": "02163f51…", "sig": "8a1cc8bb…" }
```

- `taker_role`: `Z` sells ZEC, `B` buys it. A maker quotes only the side opposite its own role, so this
  works the same for a B maker (today) and a Z maker.
- `market`: `btc:<network>`, `ltc:<network>`, or `evm:<chain id>:<token address>` (lowercase).
- `rate_sat_per_zec`: counter-coin base units per ZEC, as in the offer (WETH: wei, so it can pass
  2^53; read it as an exact integer).
- Lifetime: `--maker-quote-secs` (default 45, 5 to 300). The maker enforces it with its own clock;
  `expires_at - issued_at` tells a taker how long it has without comparing clocks.
- Signature: ECDSA over secp256k1 with the key in the offer's `quote_key` (compressed, hex); `sig` is
  the compact r‖s (hex) over SHA-256 of these lines joined with `\n`:
  `ferry-quote/1`, `v=1`, `quote_id=…`, `pair=…`, `market=…`, `maker_role=…`, `taker_role=…`,
  `rate_sat_per_zec=…`, `min_zat=…`, `max_zat=…`, `issued_at=…`, `expires_at=…`. String fields are
  plain tokens (`[A-Za-z0-9/:._-]`), so no two quotes share a text. The key is `<data-dir>/quote-key`
  (mode 0600), made on first start; it signs quotes only and holds no funds.
- Refusals (`{"error"}`): `400` not a bucket, another pair, the same side as the maker, outside the
  maker's range; `403` not making offers; `409` busy with another swap (ferryd runs one at a time, so
  it quotes none meanwhile), not enough liquidity for the bucket, too many open quotes (6 per
  requesting address, 32 in all); `429` more than 20 requests a minute from one address, or 240 in
  all. Behind a reverse proxy every request has the proxy's address, so the per-address limits act
  as one more overall limit.

### Proposing with a quote

The taker's `Propose` request names it: `POST /peer/swaps {envelope, taker_url, "quote_id": "4ca9…"}`.
The maker then holds the proposal to the quote instead of the offer's current rate: the quote must be
one it issued, for the proposer's side, not yet used, the ZEC amount within `min_zat`..`max_zat`,
the counter amount exactly `zec × rate / 10^8` rounded as for the offer, and the proposal must arrive
before the quote expires. Otherwise `400` with `the firm quote expired; get a new one`,
`the firm quote was already used for another swap`, `the amount is outside the firm quote's range`,
`the amount does not match the firm quote's rate`, `the firm quote is for the other side of the swap`
or `unknown firm quote (…)`. A quote is used once the swap is accepted (a proposal that fails for
another reason gives it back). A maker that restarts forgets its quotes and refuses them.

### POST /api/swaps with a quote (taker)

```json
{ "maker": "http://127.0.0.1:7112", "zec_zat": 70000000, "quote": { …the signed quote as returned… } }
```

Before proposing, the taker fetches the maker's offer and checks the quote: signed by the offer's
`quote_key`, for its pair, market and role and our side, and covering `zec_zat`; the swap is then
built at the quote's rate. Expiry is the maker's call. A refusal comes back as
`400 {"error": "The maker refused: the firm quote expired; get a new one"}`.

### POST /api/quotes (UI server, not ferryd)

```json
{ "pair": "btc", "direction": "sell", "zec_zat": 70000000 }
```
→ `200`
```json
{ "bucket_zat": 100000000,
  "quotes": [ { "maker": "Kestrel", "index": 1, "quote_id": "4ca9…", "rate_sat_per_zec": 412350,
                "min_zat": 50000000, "max_zat": 100000000, "expires_in_ms": 44977 } ] }
```

`pair` is the UI's pair id (`btc`, `ltc`, `usdc-base`, `weth-arbitrum`…), `direction` `sell` or `buy`
(ZEC). The server rounds the amount up to its bucket and asks every allowlisted maker for that pair
on the other side, in parallel (2 s timeout), with `POST <url>/peer/quote` and nothing else: no
cookie, user agent, browser address or swap id. It keeps the answers whose signature checks against
that maker's offer, whose pair, market and roles match, and that cover the exact amount, sorted best
first (selling: highest rate; buying: lowest). No URLs, keys or errors reach the browser, and the
amount is not logged. A quote is reused for other requests while it has 20 s left, and a refusal
for 10 s, so a maker hears from one server at most about once per bucket per 25 s. `prod.mjs`
limits requests to `DEMO_QUOTES_PER_MIN` (30) per client IP and `DEMO_QUOTES_PER_MIN_TOTAL` (600) in
all, refuses amounts above `DEMO_MAX_ZAT`, and clamps each quote's range to the demo limits.

A swap start may name one: `POST /daemon/z/api/swaps {"maker": "Kestrel", "zec_zat": 70000000,
"quote": "4ca9…"}`. The server looks the signed quote up (it only forwards quotes it got itself from
that maker), refuses one it doesn't hold or that has under 5 s left
(`That firm price has expired. Get a new one.`), and forwards
`{maker: <allowlisted URL>, zec_zat, quote: <signed quote>}` to the daemon. A quote is handed out for
one swap start only.

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

**USDC or WETH on an EVM chain.** A daemon started with `--counter evm` swaps ZEC against an
ERC-20 in FerryLock (docs/EVM.md). The same paths answer, in the same shape:
- `chains.btc` is `{ "coin": "usdc" | "weth", "ticker": "USDC" | "WETH", "decimals": 6 | 18,
  "network", "height", "time" }`, where `coin` is the configured token's symbol in lowercase,
  `time` is the latest block's unix time and `network` is one of `anvil`, `ethereum`,
  `optimism`, `base`, `arbitrum`, `sepolia`, `op-sepolia`, `base-sepolia`, `arbitrum-sepolia`,
  or `evm-<chain id>` for an unlisted chain (`--evm-testnet-policy`).
- `btc_sat` fields hold token base units (WETH: wei, so they pass 2^53 and lose precision as JS
  numbers; fine for display). Swap amounts are u64. `balances.btc_sat` saturates at
  18446744073709551615 (2^64 − 1; 100 WETH is 10^20 wei), and `balances.token_units` is the
  exact balance as a decimal string.
- `balances.eth_wei` is gas money.
- `offer` has `pair: "ZEC/USDC"` (or `"ZEC/WETH"`), `rate_sat_per_zec` in token units per ZEC,
  and `t1_secs`, `refund_secs` and `delta_secs` instead of block counts.
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

An optional `quote` (a firm quote from that maker) fixes the rate: see
[POST /api/swaps with a quote](#post-apiswaps-with-a-quote-taker).

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
