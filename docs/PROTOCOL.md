# Ferry protocol (draft v0.1)

Trustless atomic swap between **shielded ZEC (Ironwood pool)** and **native BTC (Taproot)**.
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
tx_redeem : lock output → Z                        (B's sig is an adaptor sig under Z_s)
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
- Presigned transactions carry fixed fees; mainnet needs an anchor output / CPFP plan.
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
  keyless watchtower ([WATCHTOWER.md](WATCHTOWER.md)). B's completed tx_refund reveals `b` to Z,
  so B's tower must not collude with Z.
