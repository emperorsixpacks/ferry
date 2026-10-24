# Ferry protocol (draft v0.1)

Trustless atomic swap between **shielded ZEC (Ironwood pool)** and **native BTC (Taproot)**.
The same BTC-side transactions run unchanged on Litecoin (Taproot since Core 0.21.2), so the
counter-chain can also be LTC; see [LITECOIN.md](LITECOIN.md). "BTC" below means either.
No bridge, no custodian, no committee, and the ZEC never touches a transparent address.

The construction follows Gugger's XMR↔BTC protocol (2020, arXiv 2101.12332), with Zcash's
Ironwood pool in Monero's role: the shielded chain has no scripts, so the ZEC is locked to a
shielded address whose spend authority is split between the two parties, and Bitcoin's script
layer enforces who learns the other half.

## Parties

| | holds | wants |
|---|---|---|
| **Z** | shielded ZEC | BTC |
| **B** | BTC | shielded ZEC |

## Keys

Each party picks a secret share below 2^254 (so it is a valid scalar on both curves):

- Z: `z`, publishes `Z_p = z·SpendAuthG` (Pallas) and `Z_s = z·G` (secp256k1)
- B: `b`, publishes `B_p = b·SpendAuthG` and `B_s = b·G`

plus an ordinary BTC signing key each (`kz`, `kb`).

Each party also sends a **cross-group DLEQ proof** that its Pallas and secp256k1 points share one
discrete log, bound to the swap's session id. The DLEQ is also a proof of knowledge, which rules out
the rogue-key attack (`B_p = X − Z_p`).

**Joint Ironwood key.** `P = Z_p + B_p`. Orchard/Ironwood require `ak` to have ỹ = 0, so with
`σ = ±1` chosen so that `σ·P` has ỹ = 0:

- `ak = σ·P`, `ask = σ·(z + b)` (nobody knows it until one share is revealed)
- `nk`, `rivk` derived from `H(session_id, Z_p, B_p, nonce_Z, nonce_B)`, so neither party picks them alone
- full viewing key `(ak, nk, rivk)` → single-use Ironwood unified address

Both parties hold the full viewing key, so both can watch the lock note. Neither can spend it alone.

## Bitcoin transactions

```
tx_lock   : B's coins → lock output
              leaf redeem : <kb> CHECKSIGVERIFY <kz> CHECKSIG
              leaf cancel : <T1> CSV DROP <kb> CHECKSIGVERIFY <kz> CHECKSIG
tx_cancel : lock output → cancel output            (presigned by both, valid after T1)
              leaf refund : <kz> CHECKSIGVERIFY <kb> CHECKSIG
              leaf punish : <T2> CSV DROP <kz> CHECKSIG
tx_redeem : lock output → Z, or Z's payout address (B's sig is an adaptor sig under Z_s)
tx_refund : cancel output → B                      (Z's sig is an adaptor sig under B_s)
tx_punish : cancel output → Z                      (Z alone, after T2)
```

Lock output internal key: the MuSig2 aggregate `KeyAgg(kb, kz)` (BIP327), so the happy path redeems
through the **key path** and tx_lock + tx_redeem look like any single-key Taproot payment and spend:
one 64-byte signature, no script revealed. tx_redeem is a MuSig2 *adaptor* signature under `Z_s`:
B sends a nonce with the lock template, Z answers with its nonce and partial signature (with the
cancel signatures), and B's partial signature (step 5) combines with Z's into an encrypted
signature that only `z` completes. The completed signature on chain gives B `z = s − ŝ` exactly as
in the script path. Each party uses one fresh nonce for this one message. The script leaves stay as
fallbacks (`--btc-keypath false` uses the 2-of-2 redeem leaf); the cancel output keeps a NUMS
internal key, so cancel/refund/punish are script-path spends.

**Payout address.** Z's setup carries its own address (tx_redeem and tx_punish pay it) and, when
Z's user named one (`payout_to`, [API.md](API.md#payout-address-payout_to)), a separate
`redeem_address` that tx_redeem pays instead. It is part of the Propose and so of the transcript,
both parties build tx_redeem from it, and B's adaptor signature commits to that output, so it is
fixed from negotiation on. tx_punish still pays Z's own address. The field is absent otherwise, so
swaps without one serialize and hash exactly as before; a maker that predates it fails the
transcript check at negotiation, and a Z taker proposes with one only to a maker whose offer lists
`features: ["payout"]`.

## Flow

1. **Setup.** Exchange points, DLEQ proofs, BTC keys, nonces, amounts and timelocks. Both derive the
   joint Ironwood address and the Taproot lock address.
2. **Pre-signing.** Both sign `tx_cancel`. Z gives B an adaptor signature on `tx_refund`, encrypted
   under `B_s`. B checks it.
3. **BTC lock.** B broadcasts `tx_lock`. Z waits for confirmations.
4. **ZEC lock.** Z sends the agreed shielded ZEC (from Ironwood notes only) to the joint address.
   B scans with the shared viewing key and waits for N confirmations.
5. **Redeem key.** B gives Z an adaptor signature on `tx_redeem`, encrypted under `Z_s`.
6. **BTC redeem.** Z decrypts it with `z`, adds its own signature and broadcasts `tx_redeem`.
7. **ZEC sweep.** B reads B's completed signature from the witness and recovers `z = s − s'`.
   B now knows `ask = σ(z + b)` and sweeps the joint note to its own shielded address (PCZT,
   RedPallas signature with `rsk = ask + α`).

## Abort cases

| Situation | Outcome |
|---|---|
| Z never locks ZEC | After T1 B broadcasts `tx_cancel`, then `tx_refund` (revealing `b`, which unlocks nothing) |
| Z locks the wrong amount | B never sends the redeem adaptor sig; cancel + refund. `b` is revealed, Z sweeps its ZEC back |
| B never sends the redeem adaptor sig | After T1: cancel. B refunds (revealing `b`) → Z sweeps its ZEC back |
| B goes silent after cancel | After T2 Z punishes (takes the BTC). Z's ZEC stays locked: B is penalised for not refunding |
| Z goes silent after receiving the redeem sig | B cancels after T1 and refunds before T2 |

**Timing rules (enforced by the daemon, not the chain):**
- Z never broadcasts `tx_redeem` after `T1 − Δ`. A redeem sitting in the mempool when the cancel
  confirms would leak `z` while B is still able to refund.
- B never broadcasts `tx_refund` after `T2 − Δ`, for the symmetric reason.
- B broadcasts `tx_refund` only after `tx_cancel` has k confirmations. A refund in the mempool
  behind an unconfirmed cancel would show `b` while a redeem could still replace the cancel
  (same rule as xmr-btc-swap).
- Presigned transactions carry fixed fees that nothing can raise. A ferryd started with `--bump on`
  (off by default) lets the party that needs a spend confirmed spend its own output of it in a
  child that pays more (CPFP): Z's redeem pays Z's wallet address, B's refund B's, Z's punish Z's.
  That is a local act: no presigned transaction, signature, message or `PROTOCOL_VERSION` changes,
  and an old peer cannot tell. The call-off is never bumped. Bitcoin and Litecoin stay off
  mainnet until the bump is reviewed ([THREAT-MODEL.md](THREAT-MODEL.md)).
- B waits for N Zcash confirmations on the lock note before step 5. Zcash has probabilistic
  finality until Crosslink, so N is a parameter.

## Privacy

- **Zcash side:** the ZEC moves Ironwood → Ironwood → Ironwood. No transparent address and no
  `valueBalance` exposure, provided Z funds the lock from shielded notes (the tool enforces it).
- **No cross-chain link:** `z` and `b` give `ak`, but finding the note needs `nk`/`rivk`, which never
  leave the two parties. Each spend publishes only `rk = ak + α·G` with fresh `α`.
- **What the counterparty learns:** it holds the viewing key for the single-use joint address, so it
  sees the lock note and the sweep's nullifier. It never sees either party's own wallet.
- **Bitcoin side:** public, as Bitcoin is. On the happy path tx_lock and tx_redeem are a key-path
  payment and spend, indistinguishable from a single-key wallet's. The abort paths (cancel, refund,
  punish) are script-path spends and do reveal the swap shape.
- **Timing:** sweeps use a random delay to avoid lining up with the BTC redeem.

## Known gaps (disclosed)

- The joint full viewing key is built from an arbitrary `ak`, so it is **not quantum-recoverable**
  under ZIP 2005. The address is single-use and short-lived. This is the same constructor FROST
  setups use today (frost-tools#591).
- The cross-group DLEQ proof is unaudited.
- Liveness: each party must be online between its deadlines (as in every adaptor-signature swap),
  or delegate its fully signed tx_cancel + tx_refund (B) or tx_cancel + tx_punish (Z) to a
  keyless watchtower ([WATCHTOWER.md](WATCHTOWER.md)), on Bitcoin or Litecoin. B's completed
  tx_refund reveals `b` to Z, so B's tower must not collude with Z. On EVM the tower calls
  FerryLock's `punish` (Z, keyless) or `refund` (B, with `b` itself), under the same rule.

## Other counter-chains

[EVM.md](EVM.md) describes the same construction with USDC on an EVM chain (Base) as the
counter-asset (`ferryd --counter evm`). The `FerryLock` contract replaces the Taproot scripts, B's
EIP-712 `Ready(id)` signature takes the place of the redeem adaptor signature, and the shares are
revealed in claim and refund calldata, which the contract checks with the ecrecover
scalar-multiplication trick.

## Routes

A route moves value between two non-ZEC assets, **coin A → shielded ZEC → coin C** (BTC → USDC,
say), as ordinary Ferry swaps joined in the shielded pool. The swap protocol is unchanged: every
swap is complete in itself, with its own maker, terms, deadlines and abort paths, and no key, hash
or secret is shared between swaps. `ferry-route`
([crates/ferry-route](../crates/ferry-route/README.md)) runs it over the user's own two daemons,
holding no keys and no funds:

- **L1**, the user's B daemon on pair A. Leg 1 buys X ZEC from Z makers with coin A.
- **L2**, the user's Z daemon on pair C. Leg 2 sells that ZEC to B makers for coin C.

By default each leg is split into **parts of standard sizes**, each part one swap (below). With
standard amounts off, each leg is one part; everything else is the same.

1. **Start leg 1.** The router reads L2's own shielded address (`GET /api/addresses`) and starts
   leg 1's first part on L1 with `sweep_to` set to it, the label `<route>/1/1` and `max_counter`,
   its most coin A for the part's ZEC ([API.md](API.md#route-legs)).
2. **Each leg-1 part** runs as any buy-ZEC swap, except that at step 7 B sweeps the joint note
   straight into L2's wallet: one Ironwood transaction, built like every sweep with the outgoing
   viewing key discarded, so the maker can't see where it went. `sweep_to` is fixed when the swap
   is created and never sent to the maker. Once the maker's redeem (EVM: claim) is on chain, that
   part's ZEC is the user's. The next leg-1 part starts after L1 is free and its own random gap.
3. **Settle.** A part's ZEC can be sold once its sweep has 10 confirmations (a note from outside
   the wallet is spendable only then).
4. **Each leg-2 part** starts on L2, after its own random gap, once leg 1's spendable ZEC covers it
   and L2 can spend its amount plus the lock fee reserve: label `<route>/2/<n>` and `min_counter`,
   the least coin C for its amount. It runs as any sell-ZEC swap. A refusal is retried, through the
   listed makers, for up to 2 hours; then the route holds. If the route request named a
   `payout_to`, leg 2 is one part and carries it, so coin C is paid there (a NEAR Intents deposit
   address, say) instead of L2's wallet.

L1 and L2 each run one swap at a time, so one part of each leg can run at once: leg 2 sells while
leg 1 is still buying. Leg 2 never sells more than leg 1 has delivered and made spendable.

**Each part starts at most once.** The router saves the start as in flight before it sends it.
ferryd stores the label in the swap record before its first save, refuses a label already in use
(by a swap, or by a start still being handled: `409 route_label_in_use`), and runs one start at a
time, so after a lost answer or a restart the router finds the swap by its label instead of
starting another. Every other error status means no swap was created, including a record that
could not be saved. A part that is tried again after it ended (after `continue`) is a new part
with a new label.

**Deadlines.** Each swap runs on its own maker's terms. No leg-2 part is negotiated before the ZEC
it sells can be spent (that would lock maker 2's coin before the user's ZEC exists), so no
timelock of one swap depends on another.

**Failure.** From the moment a leg-1 part's partner has claimed its coin A, every later failure
leaves the user holding shielded ZEC in L2's wallet, which has no deadline; before that, coin A
comes back. During each leg-1 part the user carries the ordinary B risk, so L1 needs its own
watchtower. What links the legs and the full failure table are in
[THREAT-MODEL.md](THREAT-MODEL.md#routes-coin-a--shielded-zec--coin-c).

### Standard amounts

Two swaps that each move one ZEC amount X, at public prices, sit in a ratio an observer can test:
"0.0041 BTC in, then about 40 USDC out a while later" links the legs even though no transaction
does. Standard amounts take the exact amounts away: each leg is a set of swaps of fixed sizes, and
an observer sees many swaps of each size, not one matching pair. It is the standard-denomination
idea of a mixer, applied to both sides of a route.

**The sizes.** The router splits into ferryd's firm-quote buckets, **0.1, 0.25, 0.5, 1, 2.5, 5,
10, 25, 50 and 100 ZEC** (`quote::BUCKETS_ZAT`; `--denominations` changes them):

- A maker already sees only a bucket in every quote request (the UI server sends nothing finer),
  and a part of exactly a bucket's size is what the quote was for: the swap's terms tell the
  maker nothing a quote request didn't.
- The UI quotes and suggests amounts by bucket, so plain single swaps gather on the same sizes:
  a route's parts hide among them, not only among other routes.
- Three sizes a decade (1, 2.5, 5) need at most three parts per decade, where powers of ten alone
  need up to nine: fewer swaps, fees and hours for one route, for ten pools instead of four. A
  route has at most `--max-parts` parts a leg (8).
- ferryd makers take 0.1 to 10 ZEC by default, so the common sizes fit any maker.

**Splitting.** Leg 1 buys the largest standard amount at most the request, in the fewest parts:
0.85 ZEC is 0.5 + 0.25 + 0.1, 1 ZEC is one part, 0.3 is three 0.1 parts. The split is exact, not
greedy (greedy would take 0.25 and be stuck with 0.05). The parts run in a random order.

**What doesn't divide.** Pick the most private option that still works for every request:

- **Leg 1 rounds down.** A request of 0.37 ZEC buys 0.35 (0.25 + 0.1): the rest of the user's
  coin A simply stays in their wallet, and the route says so. Refusing would turn away almost
  every request typed as coin A, and a last odd-sized part would be the one unique amount on chain
  A, which is exactly what this hides. Below 0.1 ZEC there is nothing to route.
- **Leg 2 sells standard sizes too.** Fees make that the hard side: every leg-1 sweep, every
  leg-2 lock and a reclaim cost a Zcash fee (about 0.0001 ZEC each), and the last lock needs a
  reserve (0.0005) at its start, so the ZEC that arrives is a little less than what was bought.
  Selling that remainder as a last odd part would put a unique amount on chain C, and its size
  ("1 ZEC less six fees") would even tell how many parts the route had. So:
  - When L2 already holds a little spare ZEC, about 0.0001 ZEC per part plus 0.0004, it pays the
    fees, and **leg 2 sells exactly the sizes leg 1 bought**. The spare pays only fees: leg 2
    never sells more than leg 1 bought, and ZEC that another route is holding for its user is not
    spare.
  - Without it (a fresh wallet), **leg 2 sells the most standard ZEC that fits after the fees,
    and the rest stays in the wallet as shielded ZEC**: 1 ZEC sells as 0.5 + 0.25 + 0.1 + 0.1 and
    keeps about 0.05. Nothing is lost or visible: the route reports it (`left_zat`), and it is
    the spare that lets the next route sell its full sizes.
  - A route that pays out to an address (`payout_to`, a NEAR Intents deposit address) sells in
    one part, everything but the fees: a deposit address takes one deposit before its deadline,
    and that leg is public on NEAR's side anyway.
- **Prices are rates.** `max_in` and `min_out` are kept as rates: each part's `max_counter` is
  `max_in × part ÷ request` rounded down, its `min_counter` is `min_out × part ÷ basis` rounded
  up, so no part pays more, or takes less, than the user's rate.

**Timing.** Each part waits its own random gap, drawn uniformly from the route's `delay_secs`
(default 5 to 30 minutes) when it could start (its daemon free and, for leg 2, its ZEC spendable),
saved once and never drawn again. Only leg 1's first part starts at once. Because a leg-2 part
starts as soon as enough of leg 1's ZEC can be spent, the legs interleave rather than run as a
burst of buys followed by a burst of sells. Where a request lists several partners for a leg,
part n starts with the n-th, so each partner sees only its parts.

**Failure, part by part.** The user ends with shielded ZEC or their own coin, never a stuck
route:

- A leg-1 part that is refused by every listed partner, called off, refunded or (offline past
  its deadline) punished stops the buying: no later leg-1 part starts, and leg 2 is planned again
  for what was bought. If nothing was bought, the route fails, as a single swap would.
- A leg-2 part that is called off or refunded leaves its ZEC in L2's wallet; the other parts go
  on, and the route ends `holding` that ZEC ("You received ... so far, and hold about ...").
  `continue` plans it again as new parts, under new labels.
- A leg-2 part no partner takes at the user's price within the window (2 hours), or a wallet
  that can't fund the next lock, holds the route: no new part of either leg starts, parts under
  way finish, and `continue` resumes both legs.
- `stop` keeps parts that haven't started from starting. Parts under way finish; the route ends
  holding what was bought and not sold, or failed if nothing was bought.
- A restart resumes every part where it was: gaps already drawn, starts in flight looked up by
  their labels.

**Off.** `--standard-amounts off` (or `"standard_amounts": false` in a request) runs each leg as
one swap, leg 2 selling X less a sweep-fee allowance and the lock reserve (X − 60 000 zat), with
optional ZEC jitter (`keep_bps`). It is for testing; its amounts can link the legs.
