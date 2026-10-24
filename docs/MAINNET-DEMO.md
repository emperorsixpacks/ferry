# Mainnet demo: Ferry + NEAR Intents

One small, owner-approved run on real networks: sell **0.01 ZEC** (at most 0.02) of shielded ZEC
on **Zcash mainnet** for Circle's USDC on **Base mainnet** through a Ferry atomic swap whose claim
pays straight into a **NEAR Intents** (1Click) deposit address; NEAR Intents then delivers the
asset you pick (for example SOL) to your own address. `infra/mainnet-demo.sh` does all of it.

Ferry is unaudited hackathon software. The amounts here are tiny on purpose, and every swap,
offer and start is capped at 0.02 ZEC in the script.

## What it proves

- A Ferry swap works on mainnet: real Ironwood notes on Zcash mainnet, real USDC in a FerryLock
  deployed on Base mainnet (code checked against the build), under ferryd's **Base mainnet policy**
  (1 h margins, 30 lock confirmations, 10 Zcash confirmations, a claim window of at least 4 h).
- `payout_to` on mainnet: the FerryLock claimer is the 1Click deposit address, so the USDC never
  touches the seller's own Base account.
- Ferry as the private hop, NEAR Intents as the reach: shielded ZEC becomes an asset on another
  chain (SOL on Solana) without ZEC ever going to NEAR Intents (its ZEC deposit addresses are
  transparent) and with nothing on Base linking to the Zcash side.

You run both parties: **Z** sells the ZEC, **B** is the maker that buys it with USDC. So at the end
the ZEC sits in B's Zcash wallet and B's USDC has become SOL at your address; what you spend is
fees and gas (below), plus the maker spread you pay yourself.

## Funding

`infra/mainnet-demo.sh keys` creates the wallets; `infra/mainnet-demo.sh status` prints every
address with what is still missing. For the default 0.01 ZEC sell, at a ZEC price of about $1,220
(1Click and Kraken, 2026-10-20):

| address (from `keys`) | network | send | why |
|---|---|---|---|
| Z's Zcash wallet (`u1…`) | **Zcash mainnet**, shielded | **0.0105 ZEC** (0.0205 for a 0.02 ZEC sell) | the ZEC it sells plus 0.0005 for the lock's fee. It must land in **Ironwood** notes (send from a wallet updated for NU6.3); spendable after 10 confirmations, about 13 min |
| B (`0x…`) | **Base mainnet** (chain 8453) | **14 USDC** (Circle's USDC, `0x8335…2913`; 27 for a 0.02 ZEC sell) | the USDC B locks for Z, which NEAR Intents turns into your asset. A 0.01 ZEC sell needs about 12.2 USDC; the rest covers price moves |
| B (`0x…`) | **Base mainnet** | **0.0005 ETH** | gas for approve + lock (and a refund if it comes to that) |
| Z (`0x…`) | **Base mainnet** | **0.0002 ETH** | gas for the claim |
| deployer (`0x…`) | **Base mainnet** | **0.001 ETH** | gas to deploy FerryLock, once |
| B's Zcash wallet | Zcash mainnet | nothing | receives the ZEC |

**Base mainnet is chain id 8453, an Ethereum L2. It is not Ethereum mainnet:** ETH or USDC sent on
Ethereum mainnet to these addresses does not arrive on Base. From an exchange, withdraw on the
"Base" network. Sources: ZEC from any exchange or wallet that sends shielded Ironwood notes; ETH
and USDC on Base from an exchange (Coinbase and most others withdraw to Base directly) or bridged.

The ETH is generous: at Base's fee on 2026-10-20 (0.006 gwei) the deployment costs about
0.000012 ETH with its L1 data fee, and a whole swap under 0.000003 ETH, so these amounts cover each
step even if gas goes up a hundredfold. `status` asks for them and checks the floors.

Optional: a 1Click partner JWT in `.mainnet-demo/near-jwt` (one line, `chmod 600`) removes the
0.25% fee 1Click adds without one.

## Commands

```sh
infra/mainnet-demo.sh fork test     # first: the whole flow on a fork of Base mainnet, nothing real
infra/mainnet-demo.sh near-check SOL@sol <your SOL address>   # read-only: 1Click's dry quote

infra/mainnet-demo.sh keys          # 1. the wallets; BACK UP .mainnet-demo/ (only copy of the keys)
                                    # 2. fund them (status says exactly what and where)
infra/mainnet-demo.sh status        # 3. balances, ZEC per pool, what is missing
infra/mainnet-demo.sh deploy        # 4. FerryLock on Base mainnet (type YES); code checked
infra/mainnet-demo.sh up            # 5. B (maker), Z, the UI server with FERRY_NEAR=1, all loopback
infra/mainnet-demo.sh sell SOL@sol <your SOL address>         # 6. quote, YES, then followed to the end
infra/mainnet-demo.sh down
```

To watch it in the app as well: `cd web && pnpm build` before `up`, then open
http://127.0.0.1:7470/app (the NEAR sell shows on Activity).

- **RPC.** `https://mainnet.base.org` is the default, but it refused `eth_getLogs` in our checks,
  and ferryd needs it. Put a provider's Base URL (Alchemy, QuickNode, Coinbase CDP, or
  `https://base-rpc.publicnode.com`) in `.mainnet-demo/base-rpc` (one line, `chmod 600`); `up`
  checks it and stops otherwise. ferryd reads it from a 0600 file and the script never prints more
  than its host.
- **Zcash.** zcash-devtool wallets against `zec.rocks:443` (mainnet lightwalletd); Ironwood
  (NU6.3) is active on mainnet (height 3,428,143; the tip was 3,524,450 on 2026-10-20).
- **Checks before anything moves.** Chain id 8453; USDC's `symbol()`, `decimals()` and `name()`
  read on chain; FerryLock's code equal to this build's (`deploy`, and ferryd at startup); B's rate
  from 1Click's ZEC price, which must agree with Kraken's within 3% (B buys `SPREAD_BPS`, 50, under
  it); every 1Click quote's ed25519 signature; the real quote's recipient, refund address and
  minimum before the Ferry swap starts. The UI server listens on 127.0.0.1 only and takes at most 0.02 ZEC per swap.
- **`sell`** shows both parts before anything starts: the Ferry leg (rate, USDC), 1Click's signed
  dry quote (USDC in, asset out and its minimum, the withdrawal fee, NEAR's cost in dollars, time),
  the deadline and where refunds go. After `YES` the UI server asks 1Click for the real quote,
  refuses it if it promises less than the minimum you saw, and starts the Ferry swap with
  `payout_to` = its deposit address. The script then prints each step of both daemons and of the
  NEAR job with links: basescan for the lock and the claim, blockchair for the Zcash transactions
  (shielded, so only their existence and fee show), the NEAR Intents explorer for the deposit.
  `follow` picks it up again if you stop watching; the swap goes on in the daemons regardless.

## Expected timeline and costs

Measured on the fork rehearsal (anvil makes Base's 2 s blocks; the mock Zcash chain a block every
3 s) and projected for mainnet:

| step | fork | mainnet |
|---|---|---|
| start → B's lock sent (proposal, accept, approve + lock) | 3-5 s | a few seconds |
| B's lock → Z's ZEC lock (30 Base confirmations) | 58-61 s | about 1 min (same 2 s blocks) |
| Z's ZEC lock → B's Ready (10 Zcash confirmations) | 28-32 s | about 12.5 min on average (75 s blocks; 8-20 min) |
| Ready → Z's claim | 1-2 s | a few seconds |
| claim → NEAR Intents delivers | 12-18 s (mock) | 34 s by 1Click's estimate for 0.01 ZEC worth of USDC (Base) → SOL; larger amounts were often estimated at about 1 h (below) |
| whole sell | 107-116 s | **about 15-20 min** |
| B's ZEC sweep (not on your path) | 10-15 s after the claim | 5-20 s delay, then a few Zcash blocks |

Before that, Z's ZEC needs 10 confirmations after you fund it (about 13 min) to be spendable.
If the swap is called off, it ends at t1, about 5 h 15 min after the start (B refunds, Z reclaims).

Costs of one 0.01 ZEC sell (prices of 2026-10-20: ZEC about $1,220, ETH about $2,400, Base gas
0.006 gwei):

| | amount | about |
|---|---|---|
| FerryLock deployment, once (1.79M gas + L1 data fee) | 0.000012 ETH | $0.03 |
| B's approve + lock (about 0.32M gas; the lock measured 264k on the fork) | 0.000002 ETH | $0.005 |
| Z's claim (94k gas measured) | 0.0000006 ETH | $0.002 |
| Zcash fees: Z's lock and B's sweep (ZIP-317, 2 actions each) | 0.0002 ZEC | $0.24 |
| NEAR Intents: 1Click's fee (0.25% without a JWT), its route, the SOL withdrawal fee (about 0.00009 SOL, $0.01) | 0.3-1.2% of 12.2 USDC | $0.04-0.14 |
| Maker spread (50 bps; B is you, so it comes back) | 0.06 USDC | $0 net |

So about **$0.30-0.45** out of pocket per sell, plus $0.03 once for the deployment. Real 1Click
dry quotes on 2026-10-20 (USDC on Base → SOL, FLEX_INPUT, 1% slippage, every signature checked;
four rounds over about an hour, ZEC at $1,200-1,225):

| ZEC | USDC in | SOL out | min SOL out (1%) | NEAR's cost | 1Click's time estimate |
|---|---|---|---|---|---|
| 0.01 | 12.02-12.19 | 0.1116-0.1130 | 0.1105-0.1119 | $0.04-0.14 (0.36-1.18%) | 34 s, 4 of 4 |
| 0.015 | 18.03-18.29 | 0.1675-0.1696 | 0.1658-0.1679 | $0.06-0.22 (0.33-1.18%) | about 1 h in 3 of 4, else 34 s |
| 0.02 | 24.04-24.38 | 0.2234-0.2261 | 0.2211-0.2238 | $0.07-0.28 (0.29-1.14%) | about 1 h in 2 of 4, else 34 s |

So **0.01 ZEC is the size to run**: it was always quoted at 34 s. 1Click took every amount down
to 0.2 USDC in dry quotes, so there is no minimum to worry about at this size. `infra/mainnet-demo.sh near-check SOL@sol <your address>` repeats this just before
the run (and `sell` shows the same numbers before you confirm).

## Risks, and what happens on each failure

- **Unaudited.** The cross-curve proof (Serai's experimental `dleq`), the joint-key and Ironwood
  code, FerryLock and the daemons have not been reviewed by anyone outside the project. Only tiny
  amounts: the script refuses anything above 0.02 ZEC per swap.
- **Hot keys.** The Base keys sit unencrypted in `.mainnet-demo/` (the deployer's in a keystore
  with its password next to it); the Zcash seeds are age-encrypted with an identity file next to
  them. Fine for a few dollars, nothing more. Back the folder up before funding it: it is the only
  copy. Leftover ZEC can be moved out with zcash-devtool (`wallet send`, or `display-mnemonic` into
  another wallet), leftover ETH and USDC with `cast send`.
- **You trust Circle, Base's sequencer and NEAR Intents.** Circle can freeze USDC (claim, refund
  and punish would revert, simulated first so no key share leaks, funds stuck until it unfreezes);
  Base's single sequencer must include transactions within the 1 h margins; once the USDC is in the
  deposit address, NEAR Intents and its solvers hold it until they deliver or refund.

What happens when something fails, in order of the flow:

| failure | what happens | your money |
|---|---|---|
| The real 1Click quote promises less than the minimum you confirmed | the UI server refuses it (`409 price_moved`); no Ferry swap starts | nothing moved |
| B never locks, or the proposal fails | the Ferry start fails or the swap is aborted after 30 min with nothing locked | nothing moved |
| B locks but Z never locks ZEC | at t1 (about 5 h 15 min) B refunds its USDC from FerryLock | B's USDC back, minus gas |
| Z locks ZEC but B never signs Ready, or Z never claims | at t1 B refunds and reveals its key share; Z takes its ZEC back from the joint note. The NEAR job ends `failed` (`ferry_refunded`): nothing reached NEAR Intents | ZEC back to Z (minus two small Zcash fees), USDC back to B |
| B vanishes after locking (no Ready, no refund) | from t2 (about 7 h 15 min) Z punishes: FerryLock pays the USDC to the claimer, which is the 1Click deposit address; Z's ZEC stays locked. The deposit is still within its 24 h deadline, so NEAR Intents converts it or refunds it | ZEC lost to the joint note (as on every Ferry pair, going quiet costs B, and here you are B) |
| Z's claim lands but NEAR Intents can't fill (price moved past 1% slippage, no route) | 1Click refunds the USDC to the quote's refund address: **Z's own Base account** (`refundTo`). The job ends `refunded` | USDC at Z's Base address; the Ferry swap itself completed |
| The deposit arrives after the quote's deadline | under NEAR's rules a late deposit is refunded, to Z's Base address | as above |
| The script or the terminal dies | nothing stops: ferryd and the UI server follow the swap and the NEAR job; `infra/mainnet-demo.sh follow` picks it up again | unaffected |

ZEC is never sent to NEAR Intents, and the Zcash side stays shielded whatever happens. The NEAR
leg is public: 1Click sees the quote, and the deposit address links the Base claim to the SOL
delivery.

## What to record for judges

`sell` keeps its whole output in `.mainnet-demo/evidence/sell-<time>.log` and the job with both
swap views in `.mainnet-demo/evidence/<job>.json` (addresses and links, never a key). From those:

- **FerryLock**: its basescan address and deployment tx, and that `deploy` found its code equal to
  this build's (`crates/ferry-evm/artifacts/FerryLock.json`, commit hash).
- **Base**: the lock tx (B's USDC into FerryLock, with t1/t2 and the claimer = the deposit address
  in its terms) and the claim tx (USDC to the deposit address), on basescan.
- **Zcash**: the txids of Z's lock and B's sweep. They are shielded v6 Ironwood transactions: an
  explorer shows they exist, with their fee and action count, and nothing else. That is the point.
- **NEAR Intents**: the deposit address on explorer.near-intents.org, 1Click's signed quote
  (signature, correlation id, amounts, deadline: in the job JSON) and the delivery tx on Solana.
- **The terminal**: a screen recording of `sell` from the quote to `Result: done`, and `status`
  before and after (B's USDC down, B's ZEC up, Z's ZEC down, Z's own Base USDC unchanged).
- **The rehearsal**: `docs/evidence/mainnet-demo-fork-2026-10-20.txt`, the same flow on a fork of
  Base mainnet before any real funds moved.
