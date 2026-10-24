# Ferry demo: voiceover script

For the video `web/film/ferry-demo.mp4` (about 88 s), produced by `cd web && pnpm film`.
Each line matches one cue in `web/film/captions.srt`, and the edit holds every segment to a fixed
length, so these timings stay the same on every re-film. Read at a steady pace of about
2.5 words per second. The lines are written to fit inside their windows.

Audience: Zcash core developers. Tone: plain and technical. No hype words; let the mechanism make
the case.

> **Before publishing.** This cut uses the stand-in ZEC leg (`--zec mock`). The Bitcoin side is real
> regtest with the MuSig2 key-path redeem, but the Zcash observer lines still end in "(mock chain …)".
> Re-film with `ZEC_BACKEND=devtool` once ferry-zec is in the daemon, so the second claim is shown on
> real Ironwood transactions rather than only stated. The joint-key spike (commit e72d1d5) already
> sweeps a real Ironwood note with ask = ±(z + b) on regtest.

| # | Time | On screen | Voiceover |
|---|---|---|---|
| 1 | 0:00–0:04 | Title card: Ferry, the thesis line, Zcash to Bitcoin route | Ferry. Atomic swaps between shielded ZEC and Bitcoin. |
| 2 | 0:04–0:09 | The UI at rest. Z on the left with 5 ZEC, B on the right with BTC | Two parties. Z holds shielded ZEC, B holds bitcoin. Nobody in between. |
| 3 | 0:09–0:15 | Start swap. Keys and DLEQ proofs are exchanged; the BTC token moves to the Taproot lock | B locks BTC first: a Taproot output that needs both keys, with a timelocked way back. |
| 4 | 0:15–0:21 | The ZEC token moves to the joint Ironwood note | Z locks ZEC, Ironwood to Ironwood, to an address whose spend key is split: z plus b. |
| 5 | 0:21–0:27 | The lock note confirms; the redeem adaptor arrives in Z's timeline | B signs the redeem as an adaptor signature. Only Z's secret, z, can complete it. |
| 6 | 0:27–0:32 | The BTC token crosses to Z's shore | Z completes it and claims the BTC. One key-path signature. |
| 7 | 0:32–0:37 | **The magic moment.** A magenta arc runs from the redeem into the joint note: "B read z from Z's redeem signature" | That signature is the key. B subtracts its adaptor and recovers z. |
| 8 | 0:37–0:43 | Random delay, then the ZEC token crosses to B's shore. Both panels show Swapped | After a random delay, B sweeps the note into its own shielded wallet. Done. |
| 9 | 0:43–0:53 | Scroll to "What each chain sees". The key-path tx_redeem line is outlined | What did the chains see? Bitcoin: a Taproot output and a single-signature spend, like any payment. Zcash: encrypted actions. Nothing links them. |
| 10 | 0:53–0:57 | Card: "What if Z disappears halfway?" | Now, what if Z vanishes? |
| 11 | 0:57–1:03 | Second swap; both sides lock as before | Same start: B locks bitcoin, Z locks shielded ZEC. |
| 12 | 1:03–1:06 | "Make Z stall" is pressed; Z shows Stalled | Then Z goes silent. |
| 13 | 1:06–1:14 | Blocks run to T1; the cancel and refund tracks appear; BTC returns to B | After timelock T1, B cancels and takes its bitcoin back. The refund signature reveals b. |
| 14 | 1:14–1:21 | Arc "b read from B's refund signature"; ZEC returns to Z. Both panels show Refunded | Z reads b from the refund and sweeps its ZEC home. Nobody loses a coin. |
| 15 | 1:21–1:28 | End card with the three claims | No custodian. ZEC never leaves the shielded pool. And when it succeeds, the Bitcoin side looks like any other payment. |

## What each claim rests on

These are notes for questions after the demo; they are not part of the voiceover.

- **No custodian.** Each party's funds can only move with both parties' signatures, or back to their
  owner after a relative timelock (T1 for cancel, T2 for punish). No third key exists anywhere. The
  construction is Gugger's XMR↔BTC protocol, with Ironwood in Monero's place.
- **ZEC never leaves the shielded pool.** Z funds the lock from Ironwood notes only. PROTOCOL.md has
  the tool enforce this; that check arrives with ferry-zec, and today's mock leg only models it. The lock, the sweep and the reclaim are all Ironwood-to-Ironwood with valueBalance 0.
  The joint address is single-use. Its nk and rivk come from both parties' nonces and are never
  published, so finding the note needs the viewing key, which only the two parties hold.
- **The Bitcoin side looks like a payment.** The lock output's internal key is the MuSig2 aggregate
  of both parties' keys, with the script leaves hidden in the tap tree. The happy-path redeem is a
  key-path spend: one 64-byte Schnorr signature and no script. z is recovered from that signature
  (s − s′) because B's MuSig2 partial signature was an adaptor under Z_s.
- **Stated limits.** The abort paths (cancel, refund, punish) are script-path spends, so a failed
  swap is recognisable on Bitcoin. The joint viewing key is built from an arbitrary ak, so it is not
  quantum-recoverable under ZIP 2005. The cross-group DLEQ proof is unaudited. Each party must be
  online between its deadlines. See docs/PROTOCOL.md, "Known gaps".
