# ferry-route

Moves value between two non-ZEC assets by running two Ferry swaps one after the other, with
shielded ZEC in between: **coin A → shielded ZEC → coin C** (for example BTC → ZEC → USDC).

- **Leg 1** buys ZEC with coin A on your B daemon for pair A. Its sweep pays the ZEC straight into
  the shielded wallet of your Z daemon for pair C.
- Once that note can be spent (10 confirmations), and after a random **privacy pause**,
- **leg 2** sells the ZEC for coin C on that Z daemon.

`ferry-route` holds no keys and no funds. It only talks to your own two ferryd control APIs, and
the only things it ever does with money are two `POST /api/swaps` calls. The swaps themselves run
inside ferryd, with ferryd's own safety rules and watchtowers.

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
  atomically, so a crash leaves either the old version or the new one.

Useful flags (defaults in brackets):

| Flag | Meaning |
|---|---|
| `--delay-secs` [`300:1800`] | Privacy pause when a route names none. Off is `0:0`; Long is `3600:21600`. |
| `--zec-confs` [10] | Confirmations of the swept note before leg 2 may start. |
| `--leg2-window-secs` [7200], `--retry-secs` [60] | How long, and how often, to try starting leg 2. |
| `--allow-same-partner` [off] | Allow the same maker on both legs. |
| `--zec-fee-zat` [10000], `--zec-lock-reserve-zat` [50000] | Fee allowance and lock reserve, so leg 2 sells `zec_zat − 60 000`. |

## API

`POST /api/routes` returns `201` with the route:

```json
{"from": "btc", "to": "usdc-base", "zec_zat": 100000000,
 "maker1": {"url": "http://maker1:7112", "name": "Kestrel"},
 "maker2": [{"url": "http://maker2:7912", "name": "Heron"}, "http://maker3:7912"],
 "max_in": 412500, "min_out": 39200000,
 "delay_secs": [300, 1800], "keep_bps": 0}
```

- `maker1` is leg 1's maker. `maker2` lists leg 2's makers in the order to try them. Each entry is a
  URL or `{url, name}`; the UI server resolves them from its allowlist.
- `max_in`: the most units of coin A you pay for `zec_zat`.
- `min_out`: the least units of coin C you accept for the ZEC leg 2 sells (`zec_zat − 60 000`).
  It is kept as a rate, so if less ZEC is sold (jitter, fees) the minimum shrinks in proportion,
  rounded up.
- `delay_secs` is optional. `keep_bps` is optional (at most 200): it keeps a random 0 to `keep_bps`
  of the ZEC back in your wallet.
- The router fetches leg 1's `sweep_to` address from your Z daemon itself; a request can't set it.
- Errors are `{"error": "..."}`:
  - `400` for an unknown or unconfigured pair, a route where A and C are the same asset, the same
    partner on both legs, a daemon with the wrong role or pair, or a Z wallet with no address;
  - `409` when a route is already using one of the daemons;
  - `502` when a daemon can't be reached.
- If leg 1's maker refuses, the route comes back `failed`, and nothing moved.

The other endpoints:

- `GET /api/routes` and `GET /api/routes/:id` return routes.
- `GET /api/events` streams Server-Sent Events: `event: route`, carrying a route as data.
- `POST /api/routes/:id/continue {maker2?, min_out?, zec_zat?}` leaves `holding` and tries leg 2
  again. During the pause it skips the pause, which makes the legs easier to link.
- `POST /api/routes/:id/stop` cancels leg 2 before it starts. You keep the ZEC. If leg 1 is still
  running, it finishes first.
- `GET /api/status` lists the configured legs.

A route as the API shows it:

```json
{"id": "r9f3…", "from": "btc", "to": "usdc-base",
 "state": "leg1|settling|pausing|leg2|done|holding|failed", "phase": "leg2_starting",
 "outcome": null,   // or swapped | holding_zec | refunded | punished | not_started
 "amounts": {"in_max": 412500, "zec_zat": 100000000, "zec2_zat": 99940000, "out_min": 39200000, "keep_zat": 0},
 "privacy": {"delay_secs": [300, 1800], "not_before": 1792400000},
 "zec": {"sweep_txid": "…", "sweep_confs": 7, "needed_confs": 10, "spendable_zat": 0, "need_zat": 99990000, "held_zat": 99990000},
 "legs": [{"n": 1, "pair": "btc", "role": "B", "maker": "Kestrel", "label": "r9f3…/1", "swap_id": "…",
           "state": "ZecSwept", "outcome": "swapped", "watchtower": null, …}, {"n": 2, …}],
 "timeline": [{"at": "…", "kind": "leg1_started", "label": "Swap 1 of 2 started with Kestrel"}],
 "note": "Your ZEC is in your wallet \"user-z\": 7 of 10 confirmations before it can be spent.",
 "problem": null}
```

`note` always says, in one or two sentences, where your money is and what happens next.

## How it runs

```text
leg1_starting → leg1 → settling → pausing → leg2_starting → leg2 → done
      │           │                              │            └→ holding (refunded or called off)
      └→ failed   └→ failed (refunded | punished | called off)  └→ holding (no partner at your price
         (nothing moved)                                            within 2 h, or stopped)
```

- The state machine is a pure function, `route::step(route, observation)`. A driver feeds it one
  observation per tick and runs the command it returns. The only commands are "start leg 1" and
  "start leg 2".
- **Each leg starts at most once.** Before every start, the route is saved with the start marked
  in flight. Every swap carries a label (`<route id>/1`, `<route id>/2`) that ferryd stores. Before
  starting, the router looks for a swap with that label and follows it if it exists. If an answer
  was lost, it waits 2 minutes for the swap to appear before trying again under the same label.
- **Restarts are safe.** Every route that isn't finished resumes where it was. The pause's end
  time is saved when it is drawn, and is never drawn again.
- Leg 2 waits until leg 1 is swapped, the sweep has 10 confirmations, and your Z daemon reports
  enough spendable ZEC for the amount plus its lock reserve. It then waits out the pause.
- Leg 2 is retried every minute for up to 2 hours, moving through `maker2`. A refusal for any
  reason (the maker is busy or offline, the price is below `min_out`, the amount is out of range)
  just means another try.

## What can go wrong, and what you end with

| Where | You end with | Route |
|---|---|---|
| Leg 1's maker refuses, or the amount or price is off | Nothing moved | `failed` (`not_started`) |
| Leg 1 is called off and refunded | Coin A, minus network fees | `failed` (`refunded`) |
| Leg 1: you are offline past the refund deadline and have no watchtower | **Coin A lost** | `failed` (`punished`) |
| Leg 1 done; the router or the Z daemon is down | Shielded ZEC in your Z wallet. Nothing has a deadline | resumes |
| Leg 2 can't start within the window, or is stopped | Shielded ZEC in your Z wallet | `holding` |
| Leg 2 is refunded, or called off | Shielded ZEC (minus two fees if it was locked) | `holding` |
| Leg 2's partner locks, then vanishes | Coin C (you take it as the penalty) | `done` |

- Once leg 1's redeem is on chain, **the worst case is "you hold shielded ZEC"**. Every holding
  route says so plainly: "You hold about 0.9997 shielded ZEC in your wallet "user-z"."
- The price limits make sure a delayed leg 2 never fills at a worse rate than you accepted. If it
  can't, you keep the ZEC.
- During leg 1 you carry the normal risks of a buy-ZEC swap. Run the B daemon with its own
  watchtower (`--watchtower … --watchtower-own`).

## Privacy, plainly

- **Hidden:** the ZEC in the middle. All four Zcash transactions are fully shielded, so amounts and
  addresses never appear on chain, and leg 1's maker can't see where its sweep went.
- **Not hidden: timing.** Leg 1 ends on chain A, and leg 2 begins on chain C, about 25 minutes plus
  the pause apart. The random pause blurs that. Skipping it makes the link easy.
- **Not hidden: amounts.** Both amounts come from the same ZEC amount at public prices. On quiet
  chains, and on any EVM leg, an observer can often match them. `keep_bps` widens the match a
  little.
- **The makers.** Each maker sees its own leg's ZEC amount and your IP address. The router refuses
  the same maker (by name or host) on both legs, but it can't tell when two names are one
  operator. Colluding makers can link your legs.
- **Same asset.** Routes where A and C are the same asset (USDC to USDC) are refused. Amount in
  would equal amount out.
- **Your route records** link both legs. They are stored privately, like swap records.
- **Not covered:** Tor, and separate EVM accounts per swap.

## What ferryd provides

The contract is in `src/legs.rs`; ferryd implements it in `crates/ferryd/src/route.rs` (both
daemon types; [docs/API.md](../../docs/API.md#route-legs)):

- `POST /api/swaps` accepts these extra fields:
  - `route`: a label of at most 80 characters (`[a-z0-9/-]`), stored before the first save;
  - `sweep_to`: role B only, checked by the Zcash backend (our network, an Orchard receiver) and
    never sent to the maker;
  - `max_counter` for role B and `min_counter` for role Z, which refuse a maker rate past the limit.

  An error status means that no swap was created, with one exception the router relies on: a 409
  with `"code": "route_label_in_use"` says a swap with that label exists, or a start with it is
  still being handled. The router treats it like a lost answer and looks the swap up by label.
- `SwapView` shows `route` and `sweep_to`.
- `GET /api/status` lists `"route"` in `features`. Without it the router won't start a leg: an
  older ferryd silently ignores unknown fields.
- `GET /api/addresses` returns the wallet's own shielded address as `zec.address`.

`infra/route-demo.sh test` runs three routes end to end (BTC → ZEC → USDC on regtest Bitcoin and
anvil, one mock Zcash chain): one to `done` with two router restarts midway, one whose leg 2 is
refunded and then finished with `continue`, and one stopped during leg 1.
