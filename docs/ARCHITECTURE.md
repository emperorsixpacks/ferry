# Ferry architecture

```
ferry/
  Cargo.toml                 workspace
  crates/
    ferry-dleq/              cross-group DLEQ (Pallas SpendAuthG <-> secp256k1 G), Serai dleq 0.4.1
    ferry-btc/               Taproot lock/cancel scripts, tx templates, BIP340 adaptor sigs, bitcoind/litecoind
                             RPC, chain parameters (BTC or LTC: address encoding, dust, confirmations)
    ferry-zec/               joint Ironwood key (ak = ±(Z_p+B_p)), UFVK/UA, PCZT signer with raw ask,
                             wallet ops (drives zcash-devtool / zcash_client_* at devtool's pinned revs)
    ferry-evm/               EVM leg (USDC on Base / anvil): FerryLock client, event watcher, share
                             extraction, point addresses, the EIP-712 Ready digest (alloy); the
                             pure helpers build without the client for ferry-core
    ferry-core/              swap session: params, messages, state machine, timelock policy (no I/O)
    ferryd/                  daemon + CLI: runs one party (role Z or B), HTTP API for peer + UI,
                             chain watchers, persistence (one JSON file per swap)
    ferry-watchtower/        watchtower: broadcasts an offline party's presigned cancel/refund/punish
                             on time (bitcoind or litecoind polling), or calls FerryLock's
                             refund/punish for it (--counter evm); HTTP upload; docs/WATCHTOWER.md
    ferry-route/             routes (privacy hub): coin A -> shielded ZEC -> coin C, two swaps over the
                             user's own two ferryd APIs; no keys, no funds; HTTP API /api/routes
  contracts/                 Foundry: FerryLock (EVM counter-chain lock), MockUSDC, tests (docs/EVM.md)
  web/                       demo UI (two parties side by side + "what each chain sees")
  infra/                     docker: bitcoind regtest, litecoind regtest (infra/ltc), Zebra regtest (NU6.3 at 1), Zaino
  docs/                      PROTOCOL.md, ARCHITECTURE.md, THREAT-MODEL.md, LITECOIN.md, DEMO.md
  vendor/                    (gitignored) zcash-devtool, frost-tools checkouts
  spikes/                    day-0 go/no-go spikes, kept as evidence
```

## Roles

- **Z**: has shielded ZEC, wants BTC.
- **B**: has BTC, wants shielded ZEC.

Either role can be the maker. The maker runs `ferryd` with a public HTTP endpoint and an offer
(pair, rate, min/max). The taker's `ferryd` connects to it.

## Session messages (JSON, versioned)

| # | from | message | contents |
|---|---|---|---|
| 1 | taker→maker | `Propose` | session_id, role, amounts, T1, T2, fee rate, BTC key, Pallas+secp points, DLEQ proof, nonce, payout/refund addresses |
| 2 | maker→taker | `Accept` | same fields for the maker |
| 3 | B→Z | `LockTemplate` | unsigned lock txid/vout/amount (B's wallet funds it, not broadcast) |
| 4 | Z→B | `CancelSigs` | Z's sig on tx_cancel, Z's adaptor sig on tx_refund under B_s |
| 5 | B→Z | `CancelSig` | B's sig on tx_cancel |
| 6 | — | B broadcasts tx_lock | |
| 7 | — | Z sends ZEC to the joint address | |
| 8 | B→Z | `RedeemAdaptor` | B's adaptor sig on tx_redeem under Z_s (after N ZEC confirmations) |
| 9 | — | Z broadcasts tx_redeem; B extracts z and sweeps ZEC | |

Every message is checked against the session transcript hash; DLEQ proofs are bound to
`session_id/role`.

## State machines

```
B: Negotiated → LockBuilt → CancelSigned → BtcLocked → ZecSeen(n confs) → RedeemSigSent
     → BtcRedeemed(z extracted) → ZecSwept ✔
   timeouts: ≥T1 → Cancelled → Refunded(b revealed) ✔  |  T2 passes → Punished ✘

Z: Negotiated → CancelSigned → BtcLockSeen → ZecLocked → RedeemSigReceived → BtcRedeemed ✔
   timeouts: ≥T1 → Cancelled → (B refunds: b extracted) → ZecReclaimed ✔
                                 (no refund by T2) → Punished(BTC taken) ✔
```

## Demo environment

`infra/up.sh` starts bitcoind regtest, Zebra regtest (Ironwood active from block 1) and Zaino,
funds a ZEC wallet and a BTC wallet, and starts a block-producer loop. `ferryd` for each party runs
locally; the web UI talks to both daemons' HTTP APIs.

## EVM counter-chain

`ferryd --counter evm` runs the same roles against FerryLock (`crates/ferryd/src/evm/`, machines
in `ferry_core::evm`): B locks USDC, Z locks ZEC once every lock term checks out, B sends an
EIP-712 `Ready(id)` signature after N ZEC confirmations, Z claims (publishing z), B sweeps. From
t1 B refunds (publishing b) and Z reclaims; from t2 Z punishes. See [EVM.md](EVM.md);
`infra/evm-demo.sh` runs all three stories on anvil.

## Routes (privacy hub)

`ferry-route` (`crates/ferry-route`) chains swaps through the shielded pool, coin A → ZEC → coin
C, over the user's own two daemons: a B daemon on pair A buys the ZEC and sweeps it straight into
the wallet of a Z daemon on pair C, which sells it once the notes can be spent. By default both
legs are split into parts of standard sizes (the firm-quote buckets), each part one swap after its
own random pause, so neither outer chain sees the route's exact amounts
([standard amounts](PROTOCOL.md#standard-amounts)). It holds no keys and no funds; its only action
is `POST /api/swaps`, once per part, each with a route label so it starts at most once
(`crates/ferryd/src/route.rs` on the ferryd side). The route's state machine is a pure
`step(route, observation)`, persisted one JSON file per route. See
[PROTOCOL.md](PROTOCOL.md#routes); `infra/route-demo.sh` runs six routes on regtest Bitcoin and
anvil with one mock Zcash chain.

## Cross-chain settlement with NEAR Intents

Ferry does the private hop, shielded ZEC ⇄ BTC, LTC or an ERC-20 (USDC, WETH), as an atomic
swap. NEAR Intents gives reach: its 1Click API delivers 205 assets on 37 chains (checked against
the live API on 2026-10-20). The two meet only on the coin side:

- **Out.** A Z taker names a 1Click deposit address on its coin's chain as `payout_to`
  ([API.md](API.md#payout-address-payout_to)), and the swap's redeem (EVM: claim) pays it directly:
  shielded ZEC → BTC, say, then → any asset NEAR delivers. The address is fixed at negotiation
  (`Setup.redeem_address` in the tx_redeem template, or `claimer` in the FerryLock terms). A route
  can end the same way: leg 2 takes the route's `payout_to`.
- **In.** The coin side can be funded from NEAR Intents (it accepts BTC, LTC, USDC, WETH and ETH
  deposits on their chains and pays out to an address the user names, such as their B daemon's).
- **Never ZEC.** 1Click's ZEC deposit address is transparent, so Ferry never sends ZEC into NEAR
  Intents; the ZEC stays in the shielded pool from lock to sweep.

What the user trusts on the NEAR leg (custody during settlement, its bridges, a public trail) is
in [THREAT-MODEL.md](THREAT-MODEL.md#paying-out-to-another-address-payout_to-near-intents). The
web side (1Click proxy, quotes, progress) is the UI server's
([API.md](API.md#near-intents-ui-server-not-ferryd)); ferryd itself never calls NEAR.

## Firm quotes

**What it is.** You say what you want ("sell 0.7 ZEC for BTC"). The partners your Ferry server lists
answer with a firm price; the best one is taken; and the swap itself is the same atomic swap as
always. That is the difference from most intent systems: no solver, partner or server ever holds your
coins, and either side can still walk away with its own.

1. The app asks its own UI server for prices. The server rounds your amount **up** to a bucket (0.1,
   0.25, 0.5, 1, 2.5, 5, 10, 25, 50 or 100 ZEC) and asks each partner its operator allowlisted,
   directly and all at once.
2. Each partner answers with a price, the range it covers (the bucket, within its own limits and
   balance) and an expiry (45 seconds by default), signed with a key published in its offer.
3. The server checks every signature, drops prices that don't cover your exact amount, and shows the
   best: "1 ZEC = 0.0041235 BTC · firm for 28 s · from Kestrel". Without one, the app shows the
   partners' everyday (indicative) rates, as before.
4. **Swap** starts the swap for your exact amount and names that price. Your Ferry node checks the
   signature and terms again, then proposes. The partner must honour the price if the proposal names
   it, stays within its range and arrives in time; a price is good for one swap.

**Privacy.** Asking for a price says something, so the design keeps it small:
- Requests never go to a public order book or mempool, only from your server to the partners it
  lists, directly.
- Partners see a bucket ("between 0.5 and 1 ZEC"), not your amount. Buckets grow 2 to 2.5 times per
  step, so that is roughly an order of magnitude.
- A request carries nothing about you: no address, account, swap id, cookie or browser IP. It comes
  from the server, not your browser, and the server doesn't log amounts.

**What a partner still learns, and why that is acceptable.**
- The bucket, the direction (selling or buying ZEC), the pair, the time, and the server's IP address.
  If you run your own server, that address is yours; run the server over Tor or a VPN if it matters.
- The partner you swap with learns your exact amount when you propose. It must: it locks the coins
  on the other side. That was already true without firm quotes.
- The partners that didn't win learn only that someone using that server looked at roughly that size
  at that time. While the page is open prices refresh about every 25 seconds, and each bucket you
  try is one more data point; prices are shared per bucket on the server, so how many people ask
  doesn't change what a partner hears.
- Nothing changes on chain: the ZEC stays shielded and nothing links the two chains.

**Limits.**
- Firm, within limits: ferryd runs one swap at a time, so a partner gives no prices while it is busy,
  and if two of its open prices are taken at the same moment the second is refused as busy; the app
  then falls back. A partner that restarts forgets its open prices and refuses them (it never fills
  one at a different rate).
- Partners limit requests (20 a minute from one address, 240 in all; 6 open prices per address, 32
  in all), and so does the public demo's server (30 a minute per visitor, 600 in all).
- No firm prices above 100 ZEC, or from a partner whose live rate has paused; the everyday rate
  applies there.

Endpoints, the signed format and the error messages: [API.md](API.md#firm-quotes).
