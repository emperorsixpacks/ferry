# Ferry

**Shielded ZEC ⇄ BTC, LTC or USDC. No bridge. No custodian. Nothing unshielded.**

Ferry is a trustless atomic swap between shielded Zcash and native Bitcoin. The ZEC moves from
one Ironwood note to another and never touches a transparent address. The BTC sits in an ordinary
Taproot output. Nobody holds both sides, and either party can walk away with its own coins.

The same construction also swaps shielded ZEC for **Litecoin** (same Taproot scripts, see
[docs/LITECOIN.md](docs/LITECOIN.md)) and for **USDC or WETH on an EVM chain** through a small
`FerryLock` contract ([docs/EVM.md](docs/EVM.md); WETH is wrapped ETH, at most about 18.4 WETH per
swap). A keyless **watchtower** can act at the deadlines for a party that goes offline, on all
three, and the app lists several **makers** with live market rates.

Built for the [Zecathon](https://thezecathon.com) **Cross-chain** track: *swaps, bridges and intents
that reach other chains without unshielding on the way through.*

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

## What each chain sees

| | Bitcoin observer | Zcash observer |
|---|---|---|
| Lock | a Taproot output | an Ironwood bundle: amount, sender, receiver, memo encrypted |
| Settle | a script-path spend with two Schnorr signatures | an Ironwood spend: a nullifier and a fresh randomized key |
| Link between them | none: no shared hash, no shared key, no shared amount | |

Unlike an HTLC swap, there is no hash that appears on both chains. The scalar revealed on Bitcoin
derives `ak`, but finding the Zcash note needs `nk` and `rivk`, which only the two parties hold, and
every Ironwood spend shows only `rk = ak + α·G` with a fresh `α`.

## Run it

```bash
infra/demo.sh up                # bitcoind regtest + two ferryd daemons + block producer
cd web && pnpm install && source ../.demo/env && pnpm dev:ui   # the crossing, live, at http://localhost:5180
infra/demo.sh help              # the three demo stories (swap, refund, punish) and curl examples
infra/demo.sh down
infra/demo-watchtower.sh run    # a party is killed mid-swap; its watchtower refunds or punishes
CHAIN=ltc infra/demo-watchtower.sh run   # the same on Litecoin (CHAIN=evm: USDC in FerryLock on anvil)
infra/demo-ltc.sh up            # the same demo against litecoind regtest (ZEC/LTC)
infra/evm-demo.sh test          # ZEC/USDC on anvil: happy, refund and punish
infra/evm-testnet.sh fork test  # ZEC/USDC rehearsal on a Base Sepolia fork; without `fork`, the
                                # real Base Sepolia + Zcash testnet run (docs/EVM.md)
```

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
| `web/` | the demo UI |
| `infra/` | one-command local environment |
| `spikes/` | day-0 go/no-go experiments, kept as evidence |

## Status

- BTC leg: lock, cancel, redeem, refund and punish on regtest, with secrets recovered from witnesses.
- Cross-group DLEQ: proof, verification and negative tests; keys cross-checked against Zcash's RedPallas.
- Ironwood joint key: a note sent to an `ak = ±(Z_p + B_p)` address swept on regtest with a
  RedPallas signature from the combined key.
- Two daemons swap end to end over HTTP (happy, refund, punish) against regtest Bitcoin, and
  against regtest Litecoin (`--chain ltc`).
- ZEC ⇄ USDC: FerryLock has 34 Foundry tests (5 fuzz, including the scalar check against an
  independent secp256k1 implementation); two daemons with `--counter evm` run happy, refund and
  punish against anvil. B's go-ahead is an off-chain EIP-712 signature, so nothing on chain dates
  the ZEC lock.
- Watchtower: with the owner offline, it broadcasts cancel then refund (B) or cancel then punish (Z)
  on Bitcoin and Litecoin regtest; it holds no keys, and every package is validated against the
  swap's own templates. On EVM it calls FerryLock's refund (B) or punish (Z) on anvil, inside the
  same windows, from its own gas account; Z's package is keyless and B's holds B's key share, so
  B arms only its own tower.
- Makers: ferryd can quote the median of Kraken/CoinGecko plus a spread and pauses when the feed is
  stale; the app lists the operator's allowlisted makers with rate, age, range and liquidity.
- **Real shielded ZEC, end to end.** `infra/e2e-real.sh` starts a fresh regtest Bitcoin + Zebra +
  Zaino stack and runs all three stories with real Ironwood notes. In the happy story, a stranger also
  sends small notes to the joint address while B waits to sweep. A fourth story checks that a wallet
  with too little shielded ZEC (only transparent coins on top) is turned away before anything is locked. It also checks the balances, and
  that the counterparty, who holds the joint viewing key, can't see where a sweep went. A control run
  without that protection shows the same check does catch the leak. It exits 0 only if every check passes. Every ZEC transaction it made, as mined
  ([full log](docs/evidence/e2e-real-regtest-2026-10-19.txt)):

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

Plain-language versions of these, with what happens in every abort case, are in
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

- The joint viewing key is built from an arbitrary `ak`, so it is not quantum-recoverable under
  ZIP 2005 (the same constructor FROST setups use today). The address is single-use and short-lived.
- The cross-group DLEQ is unaudited (Serai's `dleq`, experimental feature).
- Presigned Bitcoin transactions use fixed fees; mainnet needs an anchor/CPFP plan.
- Liveness: each party must be online until its deadline, as in every adaptor-signature swap, or
  delegate its deadline actions to a [watchtower](docs/WATCHTOWER.md). The tower must stay up
  (and, on EVM, funded for gas); B's must be its own.

## Credits

Gugger, *Bitcoin–Monero Cross-chain Atomic Swap* (2020) · COMIT's xmr-btc-swap · Serai's `dleq` ·
LLFourn's `schnorr_fun` · the Zcash Foundation's frost-tools (`zcash-sign`) and ECC's zcash-devtool.
