# ferry-route

Moves value between two non-ZEC assets by running Ferry swaps with shielded ZEC in between:
**coin A → shielded ZEC → coin C** (for example BTC → ZEC → USDC).

- **Leg 1** buys ZEC with coin A on your B daemon for pair A. Its sweeps pay the ZEC straight into
  the shielded wallet of your Z daemon for pair C.
- **Leg 2** sells the ZEC for coin C on that Z daemon, once it can be spent (10 confirmations).
- **Standard amounts** (on by default): each leg is split into **parts** of fixed sizes, 0.1,
  0.25, 0.5, 1, 2.5, 5, 10, 25, 50 or 100 ZEC (ferryd's firm-quote buckets). Each part is its own
  swap and starts after its own random **privacy pause**, so both outer chains see swaps of sizes
  everyone else uses too, not one pair of amounts in a telling ratio. The design and its reasons
  are in [docs/PROTOCOL.md](../../docs/PROTOCOL.md#standard-amounts).

`ferry-route` holds no keys and no funds. It only talks to your own two ferryd control APIs, and
the only thing it ever does with money is `POST /api/swaps`, once per part. The swaps themselves
run inside ferryd, with ferryd's own safety rules and watchtowers.

## Run

```sh
ferry-route --data-dir ~/.ferry-route \
  --leg btc:b=http://127.0.0.1:7102       --leg-token-file btc:b=/path/to/b/api-token \
  --leg usdc-base:z=http://127.0.0.1:7901 --leg-token-file usdc-base:z=/path/to/z/api-token
```

- The API listens on `127.0.0.1:7140` (`--api-listen`). It must be a loopback address unless you
  pass `--api-allow-remote`.
- Every request needs `Authorization: Bearer <token>`. The token is in `<data-dir>/api-token`
  (created at first start, mode 0600). A request with an `Origin` header is refused unless that
  origin was allowed with `--ui-origin`.
- At startup, and again before each swap it starts, the router checks that every daemon has the
  role and pair it was configured for, and that it supports routes.
- Each route is one JSON file in `<data-dir>/routes` (directory 0700, files 0600). It is written
  atomically, so a crash leaves either the old version or the new one. A file written by a
  ferry-route from before parts is left where it is and not resumed (its swaps finish in ferryd on
  their own; its ZEC waits in the leg-2 wallet).

Useful flags (defaults in brackets):

| Flag | Meaning |
|---|---|
| `--standard-amounts` [`on`] | Split routes into standard parts. `off` runs each leg as one swap (for testing); a request may ask either way. |
| `--denominations` [`0.1,0.25,0.5,1,2.5,5,10,25,50,100`] | The standard sizes, in ZEC. |
| `--max-parts` [8] | Most parts a leg; a larger amount is rounded down to what 8 parts carry. |
| `--delay-secs` [`300:1800`] | Each part's privacy pause when a route names none. Off is `0:0`; Long is `3600:21600`. |
| `--zec-confs` [10] | Confirmations of a sweep before leg 2 may sell its ZEC. |
| `--leg2-window-secs` [7200], `--retry-secs` [60] | How long, and how often, to try starting a leg-2 part. |
| `--allow-same-partner` [off] | Allow the same maker on both legs. |
| `--zec-fee-zat` [10000], `--zec-lock-reserve-zat` [50000] | One Zcash fee, and the reserve each lock needs at its start. |

## API

`POST /api/routes` returns `201` with the route:

```json
{"from": "btc", "to": "usdc-base", "zec_zat": 85000000,
 "maker1": {"url": "http://maker1:7112", "name": "Kestrel"},
 "maker2": [{"url": "http://maker2:7912", "name": "Heron"}, "http://maker3:7912"],
 "max_in": 352000, "min_out": 33400000,
 "delay_secs": [300, 1800], "standard_amounts": true,
 "payout_to": "0x90F79bf6EB2c4f870365E785982E1f101E93b906"}
```

- `maker1` is leg 1's maker, or a list of them: part n starts with the n-th (wrapping), and a
  refusal moves on to the next. `maker2` lists leg 2's makers the same way. Each entry is a URL or
  `{url, name}`; the UI server resolves them from its allowlist.
- `zec_zat`: what leg 1 buys. With standard amounts it is rounded **down** to the largest sum of
  standard sizes (at most `--max-parts` of them): 0.37 ZEC buys 0.35 (0.25 + 0.1), and the rest of
  your coin A stays in your wallet. Less than 0.1 ZEC is refused.
- `max_in`: the most units of coin A you pay for `zec_zat`. `min_out`: the least units of coin C
  you accept for `zec_zat − 60 000`. Both are kept as **rates**: each part's limit is its share,
  `max_in` rounded down and `min_out` rounded up, so no part pays more or takes less than your rate.
- `delay_secs` is optional: each part's pause, drawn on its own.
- `standard_amounts` is optional (default: the router's `--standard-amounts`). With it off, each
  leg is one swap and leg 2 sells `zec_zat − 60 000`; `keep_bps` (at most 200) then keeps a random
  0 to `keep_bps` of the ZEC back. `keep_bps` with standard amounts is refused.
- The router fetches leg 1's `sweep_to` address from your Z daemon itself; a request can't set it.
- `payout_to` is optional: where leg 2's redeem (EVM: claim) pays coin C instead of your leg-2
  wallet, for a route that ends on NEAR Intents (a 1Click deposit address on coin C's chain). Leg 2
  is then **one** swap of everything but the fees, since a deposit address takes one deposit. The
  router checks only that it looks like an address (1 to 100 ASCII letters and digits) and that
  leg 2's daemon lists `"payout"` in its `/api/status` `features` (at creation and again before
  leg 2 starts); ferryd checks it for its chain and network before it contacts a maker. Leg 1
  never gets it. If leg 2 is refunded, the ZEC still comes back to your leg-2 wallet.
- Errors are `{"error": "..."}`:
  - `400` for an unknown or unconfigured pair, a route where A and C are the same asset, the same
    partner on both legs, too small an amount, a daemon with the wrong role or pair, or a Z wallet
    with no address;
  - `409` when a route is already using one of the daemons;
  - `502` when a daemon can't be reached.
- If the first part's makers all refuse, the route comes back `failed`, and nothing moved.

**How leg 2 is split.** Every sweep, lock and reclaim costs a Zcash fee (about 0.0001 ZEC), and the
last lock needs 0.0005 spare at its start, so a little less ZEC arrives than leg 1 bought. When
your leg-2 wallet already holds a little spare ZEC (about 0.0001 per part plus 0.0004; ZEC that
another route holds for you doesn't count), it pays those fees and leg 2 sells exactly the sizes
leg 1 bought. Otherwise leg 2 sells the most standard ZEC that fits after the fees, and the rest
stays in your wallet as shielded ZEC (`amounts.left_zat`): 1 ZEC from a fresh wallet sells as
0.5 + 0.25 + 0.1 + 0.1 and keeps about 0.05, which then pays the next route's fees.

`POST /api/routes/plan` takes the same body and answers how it would be split, starting nothing:

```json
{"standard_amounts": true,
 "amounts": {"in_max": 351998, "zec_zat": 85000000, "zec2_zat": 85000000, "out_min": 33423595,
             "keep_zat": 0, "asked_zat": 85000000, "left_zat": 0},
 "privacy": {"delay_secs": [300, 1800], "not_before": null, "denominations_zat": [10000000, …]},
 "parts": [{"leg": 1, "n": 1, "idx": 1, "of": 3, "label": "", "zec_zat": 25000000,
            "status": "planned", "limit": 103529, …}, …],
 "note": "Route created: BTC → shielded ZEC → USDC in standard amounts: buying 0.85 ZEC in 3 parts (0.5, 0.25 and 0.1 ZEC) and selling 0.85 ZEC in 3 parts (…)"}
```

The other endpoints:

- `GET /api/routes` and `GET /api/routes/:id` return routes.
- `GET /api/events` streams Server-Sent Events: `event: route`, carrying a route as data.
- `POST /api/routes/:id/continue {maker2?, min_out?, zec_zat?}` leaves `holding`: what the route
  bought and hasn't sold is planned again as new parts (`zec_zat`, rounded down to standard sizes,
  sells less), and parts of leg 1 that were held start again. During a pause it skips the waiting
  parts' pauses, which makes the swaps easier to link.
- `POST /api/routes/:id/stop`: parts not yet started won't start. Parts under way finish, and you
  keep what they bring. Refused when nothing is left to stop.
- `GET /api/status` lists the configured legs, `standard_amounts`, `denominations_zat` and
  `max_parts`.

A route as the API shows it (everything before standard amounts is still there; new fields marked):

```json
{"id": "r9f3…", "from": "btc", "to": "usdc-base",
 "state": "leg1|settling|pausing|leg2|done|holding|failed", "phase": "leg2_starting",
 "outcome": null,   // or swapped | holding_zec | refunded | punished | not_started
 "standard_amounts": true,                                   // new
 "amounts": {"in_max": 351998, "zec_zat": 85000000, "zec2_zat": 85000000, "out_min": 33423595,
             "keep_zat": 0, "asked_zat": 85000000, "left_zat": 0},        // asked_zat, left_zat new
 "privacy": {"delay_secs": [300, 1800], "not_before": 1792400000,
             "denominations_zat": [10000000, 25000000, …]},               // denominations_zat new
 "zec": {"sweep_txid": "…", "sweep_confs": 7, "needed_confs": 10, "spendable_zat": 0,
         "need_zat": 25050000, "held_zat": 74980000},
 "legs": [{"n": 1, "pair": "btc", "role": "B", "maker": "Kestrel", "label": "r9f3…/1/2",
           "swap_id": "…", "state": "ZecSwept", "outcome": "swapped", "zec_zat": 75000000,
           "counter_units": 310500, "earlier_swaps": ["…"], "parts": 3, "parts_done": 2, …},
          {"n": 2, …}],                                      // parts, parts_done new
 "parts": [                                                  // new: every part of both legs
   {"leg": 1, "n": 1, "idx": 1, "of": 3, "label": "r9f3…/1/1", "zec_zat": 50000000,
    "standard": true, "status": "swapped", "not_before": null, "started_at": 1792399000,
    "ended_at": 1792399600, "maker": "Kestrel", "swap_id": "…", "state": "ZecSwept",
    "outcome": "swapped", "counter_units": 207000, "limit": 207058, "sweep_confs": 10,
    "spendable": true, "note": null},
   {"leg": 2, "n": 1, "idx": 1, "of": 3, "label": "r9f3…/2/1", "zec_zat": 25000000,
    "status": "waiting", "not_before": 1792400000, "sweep_confs": null, "spendable": null, …}],
 "payout_to": null,   // or the address leg 2 pays coin C to
 "timeline": [{"at": "…", "kind": "leg1_started", "label": "Swap 1, part 2 of 3 started with Kestrel: 0.25 ZEC",
               "leg": 1, "part": 2}],                         // leg, part new (when about a part)
 "note": "Swap 1: 2 of 3 parts bought. Swap 2: 0 of 3 parts sold. …",
 "problem": null}
```

- `legs[i]` describes the leg's current part (the one its daemon runs, else the latest with a
  swap); `zec_zat` and `counter_units` add up every part with a swap (leg 1: paid; leg 2:
  received); `earlier_swaps` lists the leg's other swaps.
- `parts[].status`: `planned` (not scheduled yet), `waiting` (its pause runs until `not_before`),
  `starting`, `running`, `swapped`, `refunded`, `punished`, `not_started`. `idx`/`of` read "part 2
  of 3" within the leg's plan; `n` is unique within the leg and ends the label. `limit` is the
  part's `max_counter` (leg 1) or `min_counter` (leg 2). A part never shows its partner's URL.
- `state` names the later leg when parts of both run at once.
- `note` always says, in one or two sentences, where your money is and what happens next. A route
  of one part each way reads as before ("Swap 2 of 2: selling …").

## How it runs

```text
a part:   planned → waiting (its pause) → starting → running → swapped
                                              │          └→ refunded | punished | not_started
                                              └→ not_started (refused, called off, stopped)
a route:  leg1_starting | leg1 | settling | pausing | leg2_starting | leg2 → done | holding | failed
```

- The state machine is a pure function, `route::step(route, observation)`. A driver feeds it the
  observations of each tick (each running part's swap, the Zcash tip and the leg-2 wallet's
  spendable balance, a lookup for each part being started) and runs the command it returns. The
  only command is "start this part".
- Each daemon runs one swap at a time, so one part of each leg runs at once. A leg-1 part starts
  after the previous one is out (its sweep broadcast) and its own pause. A leg-2 part starts after
  its own pause once leg 1's spendable ZEC covers it and the wallet can spend its amount plus the
  lock reserve: leg 2 sells while leg 1 is still buying, never more than leg 1 delivered.
- **Each part starts at most once.** Before every start, the route is saved with the start marked
  in flight. Every swap carries its part's label (`<route id>/<leg>/<n>`, e.g. `r9f3…/1/3`) that
  ferryd stores. Before starting, the router looks for a swap with that label and follows it if
  it exists. If an answer was lost, it waits 2 minutes for the swap to appear before trying again
  under the same label.
- **Restarts are safe.** Every route that isn't finished resumes where it was: parts done stay
  done, pauses already drawn are kept (never drawn again), starts in flight are looked up.
- A leg-2 part is retried every minute for up to 2 hours, moving through `maker2`. A refusal for
  any reason (the maker is busy or offline, the price is below the part's minimum, the amount is
  out of range) just means another try.

## What can go wrong, and what you end with

| Where | You end with | Route |
|---|---|---|
| The first part of leg 1 is refused by every listed maker | Nothing moved | `failed` (`not_started`) |
| A leg-1 part is refused, called off, refunded or punished | That part's coin A back (punished: lost). No later leg-1 part starts; what was bought is still sold | `failed` if nothing was bought, else goes on |
| A leg-1 part is through; the router or the Z daemon is down | Shielded ZEC in your Z wallet. Nothing has a deadline | resumes |
| A leg-2 part can't start within the window, or the wallet can't fund it | Shielded ZEC (coin C for parts sold). No new part of either leg starts | `holding` |
| A leg-2 part is refunded or called off | That part's ZEC back (minus two fees if it was locked); the other parts go on | `holding` at the end |
| A leg-2 part's partner locks, then vanishes | Coin C (you take it as the penalty) | goes on |
| You stop | What the parts under way bring; nothing new starts | `holding` (`failed` if nothing was bought) |

- Once a leg-1 part's redeem is on chain, **the worst case for that part is "you hold shielded
  ZEC"**. Every holding route says so plainly: "Swap 2, part 2 of 3 was called off and refunded.
  You received 25.6 USDC for 0.6 ZEC so far, and hold about 0.2493 shielded ZEC in your wallet
  "user-z"."
- The price limits make sure a delayed part never fills at a worse rate than you accepted. If it
  can't, you keep the ZEC.
- During each leg-1 part you carry the normal risks of a buy-ZEC swap. Run the B daemon with its
  own watchtower (`--watchtower … --watchtower-own`).

## Privacy, plainly

- **Hidden:** the ZEC in the middle. Every Zcash transaction is fully shielded, so amounts and
  addresses never appear on chain, and a maker can't see where its sweep went.
- **Hidden by standard amounts:** the exact amounts. Each side is a few swaps of standard sizes,
  each matching every other swap of that size, instead of two amounts in the coins' price ratio.
- **Not hidden: the parts.** How many there are and their sizes, and the window they fall in (a
  three-part route runs over a couple of hours with the Standard pause). On test networks and quiet
  markets few others swap those sizes at the same time.
- **Not hidden: your parts belong together.** All EVM swaps use your daemon's one account, so an
  observer can add up your parts on an EVM chain; bitcoin parts can be tied by change and inputs.
  Standard amounts help most where your parts can't be grouped.
- **The makers.** Each maker sees its parts' sizes and times and your IP address. One maker taking
  every part of a leg sees its total; list several. The router refuses the same maker (by name or
  host) on both legs, but it can't tell when two names are one operator. Colluding makers can link
  your legs.
- **Same asset.** Routes where A and C are the same asset (USDC to USDC) are refused.
- **Your route records** link everything. They are stored privately, like swap records.
- **Not covered:** Tor, separate EVM accounts per swap, coin control.

The full account is in [docs/THREAT-MODEL.md](../../docs/THREAT-MODEL.md#routes-coin-a--shielded-zec--coin-c).

## What ferryd provides

The contract is in `src/legs.rs`; ferryd implements it in `crates/ferryd/src/route.rs` (both
daemon types; [docs/API.md](../../docs/API.md#route-legs)). Standard amounts needed nothing new
from ferryd: each part is an ordinary route leg with its own label.

- `POST /api/swaps` accepts these extra fields:
  - `route`: a label of at most 80 characters (`[a-z0-9/-]`), stored before the first save;
  - `sweep_to`: role B only, checked by the Zcash backend (our network, an Orchard receiver) and
    never sent to the maker;
  - `max_counter` for role B and `min_counter` for role Z, which refuse a maker rate past the limit;
  - `payout_to`: role Z only, the address Z's redeem or claim pays instead of its own wallet.

  An error status means that no swap was created, with one exception the router relies on: a 409
  with `"code": "route_label_in_use"` says a swap with that label exists, or a start with it is
  still being handled. The router treats it like a lost answer and looks the swap up by label.
- `SwapView` shows `route`, `sweep_to` and `payout_to`.
- `GET /api/status` lists `"route"` in `features`. Without it the router won't start a part: an
  older ferryd silently ignores unknown fields. It also lists `"payout"` when it takes `payout_to`;
  the router sends `payout_to` only to such a daemon.
- `GET /api/addresses` returns the wallet's own shielded address as `zec.address`.

`infra/route-demo.sh test` runs six routes end to end (BTC → ZEC → USDC on regtest Bitcoin and
anvil, one mock Zcash chain). Four ask for one swap each way: one to `done` with two router
restarts midway, one whose leg 2 pays a third address (`payout_to`, standing in for a 1Click
deposit address), one whose leg 2 is refunded and then finished with `continue`, and one stopped
during leg 1. Two run in standard amounts: 0.85 ZEC bought and sold as 0.5 + 0.25 + 0.1 with a
router restart midway, and one where a leg-2 part is refunded, the other parts go through, the
route ends holding that part's ZEC, and `continue` sells it.
