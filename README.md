# Ferry

**Shielded ZEC ⇄ BTC. No bridge. No custodian. Nothing unshielded.**

Ferry is a trustless atomic swap between shielded Zcash and native Bitcoin. The ZEC moves from
one Ironwood note to another and never touches a transparent address. The BTC sits in an ordinary
Taproot output. Nobody holds both sides, and either party can walk away with its own coins.

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
```

## Layout

| | |
|---|---|
| `crates/ferry-dleq` | Pallas (SpendAuthG) ⇄ secp256k1 cross-group DLEQ proofs |
| `crates/ferry-btc` | Taproot lock/cancel scripts, presigned transactions, BIP340 adaptor signatures |
| `crates/ferry-core` | swap sessions, messages, joint Ironwood key, state machines (no I/O) |
| `crates/ferryd` | the party daemon: peer protocol, chain watchers, persistence, HTTP/SSE API |
| `web/` | the demo UI |
| `infra/` | one-command local environment |
| `spikes/` | day-0 go/no-go experiments, kept as evidence |

## Status

- BTC leg: lock, cancel, redeem, refund and punish on regtest, with secrets recovered from witnesses.
- Cross-group DLEQ: proof, verification and negative tests; keys cross-checked against Zcash's RedPallas.
- Ironwood joint key: a note sent to an `ak = ±(Z_p + B_p)` address swept on regtest with a
  RedPallas signature from the combined key.
- Two daemons swap end to end over HTTP (happy, refund, punish) against regtest Bitcoin.

## Known gaps

- The joint viewing key is built from an arbitrary `ak`, so it is not quantum-recoverable under
  ZIP 2005 (the same constructor FROST setups use today). The address is single-use and short-lived.
- The cross-group DLEQ is unaudited (Serai's `dleq`, experimental feature).
- Presigned Bitcoin transactions use fixed fees; mainnet needs an anchor/CPFP plan.
- Liveness: each party must be online until its deadline, as in every adaptor-signature swap.

## Credits

Gugger, *Bitcoin–Monero Cross-chain Atomic Swap* (2020) · COMIT's xmr-btc-swap · Serai's `dleq` ·
LLFourn's `schnorr_fun` · the Zcash Foundation's frost-tools (`zcash-sign`) and ECC's zcash-devtool.
