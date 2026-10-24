# Ferry demo: voiceover script

For the video `web/film/ferry-demo.mp4` (about 82 s), produced by `cd web && pnpm film`.
Each line matches one cue in `web/film/captions.srt`, and the edit holds every segment to a fixed
length, so these timings stay the same on every re-film. Read at a steady pace of about
2.5 words per second. The lines are written to fit inside their windows.

The film follows one user through the swap app (`/`): a happy swap, then a look underneath at the
protocol view of the same swap (`/how-it-works`), then a second swap where the other side goes
silent and the user's ZEC comes back.

Audience: Zcash core developers. Tone: plain and technical. No hype words; let the mechanism make
the case.

> **Before publishing.** This cut uses the stand-in ZEC leg (`--zec mock`). The Bitcoin side is real
> regtest with the MuSig2 key-path redeem, but the Zcash observer lines still end in "(mock chain …)".
> Re-film with `ZEC_BACKEND=devtool` once ferry-zec is in the daemon, so the second claim is shown on
> real Ironwood transactions rather than only stated.

| # | Time | On screen | Voiceover |
|---|---|---|---|
| 1 | 0:00–0:04 | Title: Ferry on the dark half; "Goes in shielded. Comes out Bitcoin." on the paper half | Ferry. Shielded ZEC in, Bitcoin out. |
| 2 | 0:04–0:09 | The app at rest: 1.00 ZEC on the shielded side, the bitcoin amount still faint | This is your side of the swap. You hold shielded ZEC and want bitcoin. No one sits in between. |
| 3 | 0:09–0:15 | Swap is pressed; the bitcoin amount resolves as the other side locks it | The other side locks their bitcoin first, in a Taproot output. |
| 4 | 0:15–0:21 | Your 1.00 ZEC dissolves into ciphertext | Your ZEC goes in shielded, to an address only this swap can open. |
| 5 | 0:21–0:27 | "Claiming your BTC" | You claim the bitcoin with one signature, and that hands them their key to the ZEC. |
| 6 | 0:27–0:33 | "You received 0.00408 BTC" | Done. To anyone watching, an ordinary bitcoin payment. |
| 7 | 0:33–0:40 | The protocol view of the same swap: the arc from the redeem into the joint note | Underneath, the other side read z from your signature, and with z and b swept the shielded note. |
| 8 | 0:40–0:48 | "What each chain sees", the key-path redeem line outlined | What each chain saw: on Bitcoin, one-signature Taproot payments; on Zcash, ciphertext. Nothing links them. |
| 9 | 0:48–0:51 | Card: "And if the other side vanishes?" | And if the other side vanishes? |
| 10 | 0:51–0:57 | A second swap; both sides lock as before | A second swap: bitcoin locked, your ZEC sealed, as before. |
| 11 | 0:57–1:00 | One daemon is stalled | Then silence. The claim never comes. |
| 12 | 1:00–1:08 | "Undoing the swap"; the bitcoin amount fades back | The deadline passes and the swap is called off. Both ways back were signed in advance. |
| 13 | 1:08–1:15 | "Your 1.00 ZEC is back" | Your ZEC comes back to your shielded wallet. Nobody lost a coin. |
| 14 | 1:15–1:22 | End card with the three claims | No custodian. ZEC never leaves the shielded pool. And when it succeeds, the Bitcoin side looks like any other payment. |

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
