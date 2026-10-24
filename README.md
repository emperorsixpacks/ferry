# Ferry

**Shielded ZEC ⇄ BTC, LTC or USDC. No bridge. No custodian. Nothing unshielded.**

> **For judges:** start with [what is real and what is a mock](docs/WHAT-IS-REAL.md), with the
> public transactions of each live swap. Then [why not NEAR Intents, Maya or THORChain for the ZEC side](docs/WHAT-IS-REAL.md#why-not-near-maya-or-thorchain-for-the-zec-side)
> and the [known limits](docs/THREAT-MODEL.md#known-limits) of this design.

Ferry is a trustless atomic swap between shielded Zcash and native Bitcoin. The ZEC moves from
one Ironwood note to another and never touches a transparent address. The BTC sits in an ordinary
Taproot output. Nobody holds both sides, and either party can walk away with its own coins.

The same construction also swaps shielded ZEC for **Litecoin** (same Taproot scripts, see
[docs/LITECOIN.md](docs/LITECOIN.md)) and for **USDC or WETH on Base** through a small
`FerryLock` contract ([docs/EVM.md](docs/EVM.md); WETH is wrapped ETH, at most about 18.4 WETH per
swap). A **watchtower** can act at the deadlines for a party that goes offline, on all three. The
app asks each partner (**maker**) it lists for a signed price and takes the best. Today there is
one partner per pair, run by us: on the public demo it quotes a fixed demo rate, not a market
price (`PRICE_FEED=off`), and nodes list no outside partners yet
([infra/node/makers.txt](infra/node/makers.txt)).

Built for the [Zecathon](https://thezecathon.com) **Cross-chain** track: *swaps, bridges and intents
that reach other chains without unshielding on the way through.*

## Run your own node

Each person swaps through their own Ferry node: the app plus the daemons that hold the swap
wallets and act at the deadlines. One command starts it on your computer, in Docker, on test
networks:

```sh
git clone https://github.com/JemIIahh/ferry.git && cd ferry && ./infra/node/ferry up
```

It asks which pairs to run (ZEC ⇄ USDC on Base Sepolia by default, ready in a minute; Bitcoin
signet and Litecoin testnet sync in the background), creates your wallets locally, builds Ferry
(15-40 minutes the first time) and opens the app at http://127.0.0.1:7865. Then
`./infra/node/ferry addresses` says what to fund and where, and `status`, `logs`, `backup`,
`update` and `down` do what they say. There is no "connect wallet": a swap needs key shares and
signatures ordinary wallets can't produce, and someone must be online at the deadlines.
[docs/RUN-A-NODE.md](docs/RUN-A-NODE.md) explains it all in plain language, including mainnet
(`--mainnet`, small caps).

## Why

Every route between ZEC and other chains today passes through someone's custody, or through a
transparent address, or both. Intent networks accept transparent ZEC only. Vault-based swaps and
bridges hold the funds. A shielded wallet that wants bitcoin has to step out of the pool first.

Monero had the same problem: no scripts, so no HTLCs. Its answer was the adaptor-signature swap
(Gugger, 2020). Ferry brings that construction to Zcash's shielded pool.

## How it works

1. **Split a Zcash key across two people.** Each party picks a secret share. The ZEC is locked to an
   Ironwood address whose spend authorizing key is the sum of both shares (`ask = z + b`). Both
   parties can see the note; neither can spend it alone.
2. **Prove the same secret lives on both curves.** Each party publishes its share as a point on
   Pallas (Zcash's curve) and on secp256k1 (Bitcoin's), with a cross-group DLEQ proof that they
   share one discrete log.
3. **Let Bitcoin's script do the enforcing.** The BTC is locked in Taproot leaves. B gives Z a Schnorr
   *adaptor* signature for the redeem transaction, encrypted under Z's share. To claim the BTC, Z must
   complete it, and completing it publishes `z` in the Bitcoin witness.
4. **Read the key off the chain.** B subtracts the two signatures, recovers `z`, and now knows the full
   Ironwood spending key. B sweeps the ZEC to its own shielded address.

If anything stalls, timelocks take over: after T1 the BTC can be cancelled and refunded (which hands
Z the other share, so Z reclaims its ZEC), and after T2 a silent BTC holder is punished.
Full protocol, abort cases and timing rules: [docs/PROTOCOL.md](docs/PROTOCOL.md).
Who you trust, what can go wrong and what each side learns, in plain language:
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) (also in the app at `/safety`).

## Selling or buying ZEC

The swap card goes both ways. The arrow between **Sell** and **Buy** flips it: selling, you give
shielded ZEC and get the coin; buying, you pay with BTC, LTC, USDC or WETH and the ZEC arrives in
your shielded wallet. You always type the ZEC amount, which is exactly what moves.

Underneath nothing changes but who goes first. The coin's holder (B) always locks first and the
ZEC's holder (Z) second, whoever proposed the swap: selling ZEC is your Z node taking a B maker's
offer; buying ZEC is your B node taking a Z maker's offer (`ferryd --role z --maker-offer RATE`,
quoting what it asks per ZEC, its spendable shielded ZEC as liquidity). Starting a buy is one call
on your B node, `POST /api/swaps {"maker": <Z maker's peer URL>, "zec_zat": ...}`, and the same
safety rules hold either way round. When you buy, your coins are locked first: if the partner never
locks its ZEC, they come back after the deadline.

**Coin to coin through the shielded pool (routes).** `ferry-route` chains a buy and a sell: BTC →
shielded ZEC → USDC, say. Swap 1's ZEC is swept straight into your other node's shielded wallet,
and swap 2 sells it, never below the price you set. Both are split into parts of standard sizes
(0.1, 0.25, 0.5, 1 ZEC ...), each its own swap after its own random pause, so the outer chains see
amounts everyone uses rather than one pair in a telling ratio. If swap 2 can't finish, you keep the
shielded ZEC. The number of parts, timing, your parts sharing an EVM account or bitcoin inputs,
and colluding partners can still link the sides ([crates/ferry-route](crates/ferry-route/README.md),
[docs/PROTOCOL.md](docs/PROTOCOL.md#standard-amounts)).

## What each chain sees

| | Bitcoin observer | Zcash observer |
|---|---|---|
| Lock | a Taproot output | an Ironwood bundle: amount, sender, receiver, memo encrypted |
| Settle | a key-path spend with one Schnorr signature, like any single-key Taproot payment (a call-off's refund or penalty is a script-path spend) | an Ironwood spend: a nullifier and a fresh randomized key |
| Link between them | none: no shared hash, no shared key, no shared amount | |

Unlike an HTLC swap, there is no hash that appears on both chains. The scalar revealed on Bitcoin
derives `ak`, but finding the Zcash note needs `nk` and `rivk`, which only the two parties hold, and
every Ironwood spend shows only `rk = ak + α·G` with a fresh `α`.

## Development

The local regtest stack runs both daemons on one machine: a Bitcoin regtest node in Docker, the
stand-in Zcash chain (ferryd's `--zec mock`: a file both daemons share, no real notes, no
encryption) and a block producer. `ZEC_BACKEND=devtool` runs real shielded ZEC instead (Zebra +
Zaino regtest in Docker), `CHAIN=ltc` runs Litecoin instead of Bitcoin, and `MAKER=z` the buy side
(Z makes, B takes).

```bash
infra/regtest.sh up             # bitcoind regtest + stand-in Zcash + two ferryd + block producer
cd web && pnpm install && source ../.demo/env && pnpm dev:ui   # the app against it, at http://localhost:5180
infra/regtest.sh test           # swap, payout, refund and punish through the API, then down
infra/regtest.sh help           # every command, with curl examples
infra/regtest.sh down
cd web && pnpm dev              # the app against mock daemons, no chain needed
```

Tests:

```bash
cargo test                      # unit and simulation tests; the anvil tests run when anvil is installed
cargo test -- --ignored         # tests that need a node: each names it (infra/btc/regtest.sh start,
                                # infra/ltc/regtest.sh start with FERRY_CHAIN=ltc)
infra/e2e-real.sh               # real shielded ZEC on regtest: swap, refund, penalty, and every ZEC
                                # transaction checked for transparent, Sapling or Orchard parts (~10 min)
cd contracts && forge test      # FerryLock (Foundry)
cd web && pnpm test:server      # the web server
```

On public test networks, from your own machine: `infra/testnet.sh` (Bitcoin signet and Zcash
testnet) and `infra/evm-testnet.sh` (Base Sepolia and Zcash testnet; `fork test` rehearses on a
fork of Base Sepolia first, see [docs/EVM.md](docs/EVM.md)). Each has a `help` command.

## Deploying

The public testnet demo (Bitcoin signet + Zcash testnet, TLS via Caddy) runs on one Linux host
with Docker Compose. From a clone: `infra/deploy/deploy.sh <ssh-host>`. Requirements, funding,
backups and operations are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Layout

| | |
|---|---|
| `crates/ferry-dleq` | Pallas (SpendAuthG) ⇄ secp256k1 cross-group DLEQ proofs |
| `crates/ferry-btc` | Taproot lock/cancel scripts, presigned transactions, BIP340 adaptor signatures |
| `crates/ferry-core` | swap sessions, messages, joint Ironwood key, state machines (no I/O) |
| `crates/ferryd` | the party daemon: peer protocol, chain watchers, persistence, HTTP/SSE API |
| `crates/ferry-evm` | FerryLock client (lock, claim, refund, punish), event watching, share extraction |
| `contracts/` | `FerryLock.sol` (Foundry): the EVM lock, claim with `z`, refund with `b`, punish |
| `crates/ferry-watchtower` | watchtower: broadcasts an offline party's presigned cancel/refund/punish on time (Bitcoin, Litecoin), or calls FerryLock's refund/punish for it (EVM) ([docs](docs/WATCHTOWER.md)) |
| `crates/ferry-route` | routes: coin A → shielded ZEC → coin C as two swaps over your own two daemons ([docs](crates/ferry-route/README.md)) |
| `web/` | the app (swap card, wallet, safety and privacy pages) and its server |
| `infra/` | the server deploy, the node installer, the local regtest stack and the test-network scripts |
| `tools/` | `ferry-zec-signer` (signs Ironwood-only transactions) and `jointkey` (a split Ironwood key, for the end-to-end test) |

## Status

- BTC leg: lock, cancel, redeem, refund and punish on regtest, with secrets recovered from witnesses.
- Cross-group DLEQ: proof, verification and negative tests; keys cross-checked against Zcash's RedPallas.
- Ironwood joint key: a note sent to an `ak = ±(Z_p + B_p)` address swept on regtest with a
  RedPallas signature from the combined key.
- Two daemons swap end to end over HTTP (happy, refund, punish) against regtest Bitcoin, and
  against regtest Litecoin (`--chain ltc`), with the stand-in Zcash chain (`--zec mock`). With
  Bitcoin, the same three stories also run on real Zcash regtest notes (`infra/e2e-real.sh`,
  below). On public test networks, with real shielded notes and through the public swap card on
  2026-10-23: a ZEC → BTC sell ([redeem](https://mempool.space/signet/tx/472b3d9389133612e644438d5ebfb6326ed747e843034c2dd2c70f4fcd1ef12b))
  and a BTC → ZEC buy ([redeem](https://mempool.space/signet/tx/a9a288f6113e6050295e15b2033d7fc3f14863f31e782756fbb10da864e969cf))
  on Bitcoin signet, and an LTC → ZEC buy on Litecoin testnet
  ([redeem](https://litecoinspace.org/testnet/tx/c7e52a8e36fc4b3549034c9256d35bf5210a74d19065d6b15b7fbda3b22403c8)).
- ZEC ⇄ USDC: FerryLock has 34 Foundry tests (5 fuzz, including the scalar check against an
  independent secp256k1 implementation); two daemons with `--counter evm` run happy, refund and
  punish against anvil and on a fork of Base Sepolia, with the stand-in Zcash chain. Fourteen
  live swaps on public test networks (Base Sepolia and Zcash testnet), with real shielded notes:
  0.05 test ZEC for 2 test USDC on 2026-10-20 ([claim](https://sepolia.basescan.org/tx/0xde25c161c7e9b978de9aed580d12b0530813a460dd543124fbfc345978996aad)),
  then twelve through the public swap card of the server deploy on 2026-10-21: ZEC → USDC twice,
  USDC → ZEC twice, ZEC → WETH eight times, up to three at once (each a call to
  [FerryLock](https://sepolia.basescan.org/address/0x74b775EA7Bc7a2b2688b7A72Da5dee674BBd65Ef)), and
  the first WETH → ZEC buy on 2026-10-22
  ([claim](https://sepolia.basescan.org/tx/0xdb0b11bd8b7178862bbb015514ff2aebe9ac1b437862474fd8ddade5668029a3)). B's
  go-ahead is an off-chain EIP-712 signature, so nothing on chain dates the ZEC lock.
- Watchtower: with the owner offline, it broadcasts cancel then refund (B) or cancel then punish (Z)
  on Bitcoin and Litecoin regtest, with the stand-in Zcash chain; it holds no keys, and every
  package is validated against the swap's own templates. On EVM it calls FerryLock's refund (B) or
  punish (Z) on anvil, inside the same windows, from its own gas account; Z's package is keyless
  and B's holds B's key share, so B arms only its own tower.
- Makers: ferryd can quote the median of Kraken/CoinGecko plus a spread (at least 1% on mainnet)
  and pauses when the feed is stale or the two sources are more than 2% apart; the app lists the
  operator's allowlisted makers with rate, age, range and liquidity. The public demo has one maker
  per pair, ours, at a fixed rate (`PRICE_FEED=off`).
- Firm quotes, intent-style: you state the swap, partners answer with signed firm prices for 45 s,
  the best is taken, and an atomic swap settles it, so nobody holds funds in between. Only a rounded-up
  size bucket leaves your server, and only to its own partners
  ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#firm-quotes)).
- Several swaps at once: a node takes up to `--max-swaps` (4 on test networks, 2 on mainnet) as far
  as its free funds go, each swap holding its lock and fees until spent, and a full node answers
  "busy" ([docs/API.md](docs/API.md#several-swaps-at-once)).
- **Real shielded ZEC, end to end.** `infra/e2e-real.sh` starts a fresh regtest Bitcoin + Zebra +
  Zaino stack and runs all three stories with real Ironwood notes. In the happy story, a stranger also
  sends small notes to the joint address while B waits to sweep. A fourth story checks that a wallet
  with too little shielded ZEC (only transparent coins on top) is turned away before anything is locked. It also checks the balances, and
  that the counterparty, who holds the joint viewing key, can't see where a sweep went. A control run
  without that protection shows the same check does catch the leak. It exits 0 only if every check passes. Every ZEC transaction of its 2026-10-19 run, as mined:

  | swap | tx | txid | transparent in/out | Sapling | Orchard | Ironwood actions |
  |---|---|---|---|---|---|---|
  | happy | ZEC lock | `ad59673a…` | 0 / 0 | 0 | 0 | 5 |
  | happy | B's sweep | `4d4914e4…` | 0 / 0 | 0 | 0 | 2 |
  | refund | ZEC lock | `90579cad…` | 0 / 0 | 0 | 0 | 2 |
  | refund | Z's reclaim | `46ee4dfa…` | 0 / 0 | 0 | 0 | 2 |
  | punish | ZEC lock | `1662b575…` | 0 / 0 | 0 | 0 | 2 |

- **Nothing unshielded, enforced.** Before sending the lock, `ferry-zec` refuses unless the
  Ironwood balance alone covers it and the wallet's proposal touches only Ironwood. It refuses to
  sign a sweep or reclaim that has any transparent, Sapling or Orchard part. It re-checks the broadcast
  lock and logs any violation loudly.

## Known gaps

Each of these, with what Ferry does about it and what is still open, is in
[docs/THREAT-MODEL.md, "Known limits"](docs/THREAT-MODEL.md#known-limits). What has actually run,
and where, is in [docs/WHAT-IS-REAL.md](docs/WHAT-IS-REAL.md).

- A partner must be online with the other coin. Today the only partners are ours.
- The second side to lock holds a free option, and no chain can fine whoever walks away: the
  shielded ZEC lock is invisible to the other chain.
- Swaps take minutes (confirmations on both chains) and pay fees on both chains.
- Liveness: B (the side holding BTC, LTC or tokens) must refund within its window, or delegate it
  to its own [watchtower](docs/WATCHTOWER.md). The tower must stay up (and, on EVM, funded for gas).
  An offline Z loses only the trade.
- If B vanishes after Z locks, Z takes B's coin and the ZEC stays locked in the joint address:
  neither side holds the whole key.
- The cross-group DLEQ is Serai's `dleq` under its `experimental` feature, which Serai's 2023 audit
  excluded; its README says "none are recommended". So mainnet is capped at 0.02 ZEC per swap.
- Presigned Bitcoin transactions use fixed fees, so Bitcoin and Litecoin stay on test networks.
  A child-pays-for-parent fee bump is built (`ferryd --bump on`, off by default) but has had no
  outside review; Bitcoin and Litecoin stay off mainnet until it has.
- The joint viewing key is built from an arbitrary `ak`, so it is not quantum-recoverable under
  ZIP 2005 (the same constructor FROST setups use today). The address is single-use and short-lived.

## Credits

Gugger, *Bitcoin–Monero Cross-chain Atomic Swap* (2020) · COMIT's xmr-btc-swap · Serai's `dleq` ·
LLFourn's `schnorr_fun` · the Zcash Foundation's frost-tools (`zcash-sign`) and ECC's zcash-devtool.
