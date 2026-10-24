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

All four are optional for a taker: an older maker leaves them out. A Bitcoin or Litecoin daemon's
offer also lists `"features": ["payout"]`: it takes a Propose whose Z names a payout address (see
[Payout address](#payout-address-payout_to)); an older maker leaves the list out, and a Z taker
with a `payout_to` won't propose to it. A maker (any daemon started with
`--maker-offer`) also publishes `"quote_key": "02…"`, the key it signs firm quotes with. In
`/api/status`, `offer.maker` says whether the daemon was started with `--maker-offer` (paused or
not); a Z maker's `liquidity` is its spendable shielded ZEC less the lock fee.

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
fetch a URL of its choosing. Buying ZEC is the same call on a B daemon (`/daemon/b`, or
`/daemon/b-<pair>`), naming a maker whose `role` is `Z`; `prod.mjs` puts it through the same guard
(the per-swap cap, both rate limits, the allowlist, firm quotes, and one live swap per pair across
both of its daemons).

`GET /api/pairs` says which of the user's daemons the server fronts:

```json
{ "pairs": ["ltc"],                  // other pairs with a Z (sell-side) daemon: /daemon/<pair>
  "buy": ["ltc", "usdc-base"],       // other pairs with a B (buy-side) daemon: /daemon/b-<pair>
  "main": { "sell": "auto", "buy": "auto" } }  // /daemon/z sells ZEC, /daemon/b buys it, whatever pair they run
```

configured with `FERRY_<PAIR>_URL` / `FERRY_<PAIR>_B_URL` (and `_TOKEN` / `_TOKEN_FILE`). For the
main daemons, `"auto"` (the default) means the page uses one unless its `/api/status` says it is a
maker (`offer.maker`, true for a daemon started with `--maker-offer`): the usual demo's B makes
offers, so the page doesn't offer buying through it. `FERRY_Z_SELLS` / `FERRY_B_BUYS` = `1` or `0`
decide it outright (`0` also keeps visitors from starting swaps there through `prod.mjs`). `pairs`
keeps its old meaning for older pages.

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
  works the same for a B maker and a Z maker.
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

## NEAR Intents (UI server, not ferryd)

The UI servers (`server/prod.mjs`, the Vite dev server; `web/server/near.mjs`) reach NEAR Intents'
1Click API for the browser, so a person can sell shielded ZEC for any 1Click asset or buy shielded
ZEC with one ([ARCHITECTURE.md](ARCHITECTURE.md#cross-chain-settlement-with-near-intents)). Only the
server talks to 1Click (`FERRY_NEAR_URL`, an optional partner `FERRY_NEAR_JWT` sent as a bearer
token), with timeouts and size caps; the browser never names a URL. Every quote 1Click returns is
checked against its ed25519 signature (`FERRY_NEAR_PUBKEY`, 1Click's key by default) before it is
shown or used, and a real quote must echo the assets, amount and addresses that were asked.

| Call | |
|---|---|
| `GET /api/near/tokens` | `{available, execution: {sell, buy}, reason, tokens, explorer}`: 1Click's tokens (cached 5 min) without native ZEC, each with `ferry`, the Ferry pair it is; `execution` says whether NEAR swaps run here each way; `reason` `"demo"` or `"mainnet"` when not |
| `POST /api/near/quote` | `{direction, zec_zat, asset, address?, exact?}` → the best route: the Ferry leg (`via` pair, `maker`, rate) × a dry 1Click quote (`near.amount_in/amount_out/min_amount_out`, `time_s`). Without `exact` the coin amount is rounded to 3 significant digits before it leaves the server (cached 30 s) and the dry quote uses NEAR Intents placeholders; with it, the exact amount and, if given, `address` checked by 1Click (`400 {"field": "address"}`) |
| `POST /api/near/swap` | sell `{direction: "sell", zec_zat, asset, address, via, min_out}` or buy `{direction: "buy", zec_zat, asset, address, via, max_in}` → `201` the job |
| `GET /api/near/jobs`, `GET /api/near/status/:id` | the jobs, newest first, or one |
| `POST /api/near/jobs/:id/retry` | a buy holding its coin (its Ferry swap couldn't run) tries again |

**Sell.** A real 1Click quote (`FLEX_INPUT`, the coin → `asset`, `recipient` the person's address,
`refundTo` their own Z daemon's address from `GET /api/addresses`), refused with `409 price_moved`
if its `minAmountOut` is under `min_out`; then `POST /api/swaps` on the user's Z daemon with
`payout_to` = the quote's deposit address and `min_counter` = its `minAmountIn` plus the redeem fee
(EVM: the claim's tip), at a firm price when the partner gives one, and only with a partner whose
offer lists `"payout"`. Only a daemon whose status lists `"payout"` is used (`501` otherwise). The
job follows the swap, then `GET /v0/status` until `SUCCESS` (`done`) or `REFUNDED`/`FAILED` (the
coin goes back to the person's own node: `refunded`).

**Buy.** A real 1Click quote (`EXACT_OUTPUT`: `asset` → the coin, its amount what the ZEC costs now
plus 1% and a UTXO lock's fee, `recipient` the user's own B daemon's address, `refundTo` the
person's address), refused with `409 price_moved` if its `amountIn` is over `max_in`. The job shows
the deposit address (and memo); on `SUCCESS` the server starts the Ferry buy on that B daemon once
its balance shows the coin, for at most what NEAR Intents delivered (`max_counter`); a short
delivery buys what it covers. A Ferry buy that fails leaves the coin in the node (`holding`).

Jobs are kept in `FERRY_NEAR_STATE` with 1Click's signed quote (the record for a dispute). States:
`deposit` (a buy waiting for it), `near`, `funding`, `ferry`, `holding`, `done`, `refunded`,
`failed` (a sell's Ferry swap was called off; nothing reached NEAR Intents), `expired`.

**Gating.** Swaps run only with `FERRY_NEAR=1`, which an operator sets on their own node: a NEAR swap
pays out to an address the person types, so on a public demo a visitor would choose where the
operator's coins go. Without it (the public demo) the tokens and quotes still answer, labelled not
runnable here, and `POST /api/near/swap` is `403`; the daemon proxy never forwards a browser's
`payout_to`. NEAR Intents is mainnet only: a daemon on a test network gets quotes, not swaps
(`reason: "mainnet"`), unless `FERRY_NEAR_TESTNET=1` and `FERRY_NEAR_URL` is a loopback mock
(`web/mock/oneclick.mjs`). A start takes the swap guards (the caps, both rate limits, one live swap
per pair, the router idle); quotes are limited to `DEMO_NEAR_QUOTES_PER_MIN` (40) per IP and
`DEMO_NEAR_QUOTES_PER_MIN_TOTAL` (400) in all; `FERRY_NEAR_QUOTES=0` turns it all off.

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
             "fee_sat": 2000, "t1_blocks": 12, "t2_blocks": 24, "btc_lock_confs": 2, "zec_confs": 3 },
  // fee_sat: the fixed fee of each presigned BTC transaction (the redeem pays one; the refund
  // path pays two: cancel + refund). t1/t2 in BTC blocks; confirmations Z/B wait for.
  "features": ["route", "payout"]
  // What this ferryd supports beyond the base API. "route": POST /api/swaps takes the route
  // fields (see "Route legs"). ferry-route starts a leg only on a daemon that lists it: an older
  // ferryd would silently ignore those fields. "payout": POST /api/swaps takes payout_to (see
  // "Payout address"); send it only to a daemon that lists this, since an older one would ignore
  // it and pay its own wallet.
}
```

## GET /api/addresses

Where to fund this party: `{"role", "name", "btc": {"coin", "network", "address"}, "zec":
{"address"}}`. `btc.address` is a fresh address of the daemon's wallet (EVM: its account, with
`token` and `symbol`). `zec.address` is the wallet's own shielded address (a unified address; the
mock chain's is `u<network>1mockwallet<hex name>`), or null if the backend has none. ferry-route
reads it from the user's Z daemon and gives it to leg 1 as `sweep_to`.

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

Either role can take, against a maker of the other role. On a Z daemon this sells `zec_zat` of
shielded ZEC to a B maker; on a B daemon it **buys** `zec_zat` from a Z maker (a Z daemon started
with `--maker-offer`, whose offer has `"role": "Z"`, quotes what it asks per ZEC, and has its
spendable shielded ZEC, less the lock fee, as `liquidity`). The amount is the ZEC either way; the
counter amount is the maker's rate (or a firm quote's) applied to it. The call returns once the
maker has accepted and the swap is saved; the swap's own transactions (a B taker's lock, for one)
go out from the daemon's loop right after, never from inside the request, so a caller that gives up
waiting cannot leave a lock behind that the daemon doesn't track. The ZEC a B taker receives is
swept to its own wallet's shielded address.

Refusals name whose funds are short: `B does not have enough BTC: 0.0042 BTC needed (the amount plus
about 0.0001 BTC for the lock's fee), 0.002 BTC in the wallet` is ours; anything prefixed `The maker
refused:` is the maker's (`… Z does not have enough shielded ZEC …`). Proposing to a maker of our own
role gets `400 the counterparty also has role B`.

An optional `quote` (a firm quote from that maker) fixes the rate: see
[POST /api/swaps with a quote](#post-apiswaps-with-a-quote-taker).

One start at a time: while a `POST /api/swaps` is being handled, another one gets `409 Another
swap is being started`, and a maker takes no proposal meanwhile.

### Payout address (`payout_to`)

A Z taker (selling ZEC) may name where the counter coin goes when it redeems (EVM: claims),
instead of its own wallet: for example a NEAR Intents 1Click deposit address on that coin's chain
([ARCHITECTURE.md](ARCHITECTURE.md#cross-chain-settlement-with-near-intents)).

```json
{ "maker": "http://127.0.0.1:7112", "zec_zat": 100000000,
  "payout_to": "bc1q…",          // role Z only; optional (default: our own wallet, as before)
  "min_counter": 412000 }        // optional, as for a route leg
```

- **Checked before the maker is contacted**, and never set by a peer. Refusals are
  `400 {"error": "payout_to: …"}`:
  - any daemon: 1 to 100 ASCII letters and digits; role B gets `payout_to is for role Z only`;
  - **Bitcoin/Litecoin**: an address of the daemon's coin and network (`bcrt1…`, `tb1…`, `bc1…`;
    `rltc1…`, `ltc1…`; base58 too), of a type only its owner can spend: P2TR, P2WPKH, P2WSH,
    P2PKH or P2SH. A pay-to-anchor output or an unknown witness version is refused. The maker's
    offer must list `features: ["payout"]` (`payout_to: this maker's ferryd can't pay a payout
    address …` otherwise);
  - **EVM**: `0x` and 40 hex digits, all lowercase, all uppercase, or mixed case with a valid
    EIP-55 checksum (a mistyped checksummed address is refused); not the zero address, the
    FerryLock contract or the token contract.
- **Bound at negotiation; nobody can change it afterwards.** Bitcoin/Litecoin: it is sent in Z's
  Propose (`Setup.redeem_address`, part of the transcript), both sides build tx_redeem to it, and
  B's redeem adaptor signature commits to that output. The redeem pays it `btc_sat − fee_sat` (the
  locked amount less the presigned redeem fee), above the output type's dust floor. EVM: it is Z's
  account in the setup, so FerryLock's terms carry it as `claimer`; Z checks the on-chain terms
  before locking ZEC, the claim pays `claimer` the amount (less a tip, 0 by default), and Z's own
  account still sends the claim and pays its gas.
- **What it does not change.** Z's ZEC always comes back to Z's own wallet on a refund. On
  Bitcoin/Litecoin tx_punish still pays Z's own address. On EVM FerryLock has one payee for Z,
  so a punish (B vanished after locking, from t2) pays `payout_to` too.
- The maker learns the address (it signs the redeem, or locks to the claimer), as it learns Z's
  own address without one.
- `SwapView.payout_to` shows it as the chain writes it (lowercase bech32, checksummed hex); the
  timeline starts with a `payout_to` entry, and `swap_complete` names the address.

**The public demo must never let a visitor choose `payout_to`.** On the demo the server's own
daemons hold the coins, so a visitor's `payout_to` would pay the operator's coins to the visitor.
The UI server drops it from browser requests and sets it only to a 1Click deposit address it
created itself, on a daemon whose status lists `"payout"`.

### Route legs

`ferry-route` (crates/ferry-route) starts each leg of a route (coin A → shielded ZEC → coin C)
with these extra fields, all optional:

```json
{ "maker": "http://maker1:7112", "zec_zat": 100000000,
  "route": "r9f3a0c2d4e5b6a71/1",    // a label: 1-80 chars of [a-z0-9/-], stored and shown as SwapView.route
  "sweep_to": "utest1…",             // role B only: where B's sweep pays the ZEC (default: our own wallet)
  "max_counter": 412500,             // role B only: refuse if the maker asks more counter units for zec_zat
  "min_counter": 39200000 }          // role Z only: refuse if the maker pays fewer
```

- **`route`** is stored in the swap record before its first save, so a router that lost the
  answer can find the swap by its label. One label, one swap: a label that a swap already carries
  (running or finished), or that a start still in progress carries, is refused with
  `409 {"error": "Route label in use: …", "code": "route_label_in_use"}`. A router reads that as
  "the swap may exist" and looks it up by label; every other error status means no swap was
  created.
- **`sweep_to`** is checked before the maker is contacted (`400 sweep_to: …`): it must be a
  unified address of our Zcash network with an Orchard receiver (Ironwood shares it), checked by
  `ferry-zec-signer address`; the mock chain takes only its own wallet addresses. It is never part
  of the peer protocol, so the maker never learns it, and the sweep is still built with
  `--discard-ovk`. B's sweep pays it; Z's reclaim always goes to Z's own wallet. The token that
  can set it is the token that controls the funds already; the demo UI server never forwards it.
- **`max_counter` / `min_counter`** bound the maker's rate (or firm quote) at the moment the swap
  starts: `400 The maker asks 0.00412501 BTC for 1.00 ZEC, above your limit of 0.004125 BTC
  (max_counter)` / `… pays …, below your minimum of … (min_counter)`. A limit of the wrong role is
  a `400`.

Leg 2 may also carry `payout_to` (above) when the route request named one, so a route can end on
NEAR Intents; ferry-route sends it only to a daemon that lists `"payout"`.

A leg's timeline starts with a `route_leg` entry (local) naming the label and, for B, the sweep
destination. The router's own API (`POST /api/routes`, `GET /api/routes/:id`, `continue`, `stop`,
`event: route`) is in [crates/ferry-route/README.md](../crates/ferry-route/README.md); how a
route runs and fails is in [PROTOCOL.md](PROTOCOL.md#routes) and
[THREAT-MODEL.md](THREAT-MODEL.md#routes-coin-a--shielded-zec--coin-c).

## GET /api/swaps  → `[SwapView]`
## GET /api/swaps/:id → `SwapView`

```json
{
  "id": "f3c1…",
  "coin": "btc",                    // the coin swapped against ZEC: "btc" | "ltc"
  "role": "Z",
  "taker": true,                    // we proposed it; false: we are its maker
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
                  "note": "Human-readable sentence", "next_try_ms": 0 },  // null without --watchtower
  "route": "r9f3a0c2d4e5b6a71/1",   // the route label it was started with; null for a direct swap
  "sweep_to": "utest1…",            // B taker: where its sweep pays; null: its own wallet
  "payout_to": null                 // Z taker: where its redeem (EVM: claim) pays; null: its own wallet
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
emits `route_leg` (local) first on a swap started as a route leg, `payout_to` (local) on a Z swap
started with a payout address,
`sweep_delayed` (local) when it schedules the random delay before a ZEC sweep or reclaim,
`peer_message_ignored` / `peer_message_rejected` for a late or invalid peer message, and
`redeem_adaptor_withheld` (B, local) when its redeem adaptor (EVM: Ready signature) had not reached Z
by the time the swap moved on (the lock note spent, or the call-off) and so never will: B hands it
over only while it waits for Z's redeem with the lock note unspent, whether it pushes it as taker
or Z reads it from its outbox as maker.

`label` is a full sentence written from the emitting party's point of view, for example
`"Broadcast tx_lock: 0.0041 BTC to the Taproot lock address"`. The UI shows the newest label from
either party as the one-line narration under the chart.

## GET /api/events (Server-Sent Events)

`event: swap` with a `SwapView` body on every state change; `event: status` with the status body
whenever a balance or height changes.

## Errors

Every non-2xx response has a JSON body `{ "error": "Human-readable sentence" }`. The UI shows
`error` verbatim under the controls, so it should say what is wrong. For `POST /api/swaps`:

- `400`: bad body, amount outside the offer's `min_zat`/`max_zat`, insufficient funds, a bad
  route field or `payout_to`, or the maker's price past `max_counter` / `min_counter`
- `409`: a swap is already in progress or being started; with `"code": "route_label_in_use"`,
  the route label is taken (by a swap, or by a start still in progress)
- `500 could not save the swap`: the record could not be written; no swap was created (nothing is
  left in memory or on disk to resume)

A body may carry a machine-readable `code` next to `error` where a caller must tell errors apart
(today only `route_label_in_use`).

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
