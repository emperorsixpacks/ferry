# What could go wrong (threat model)

Plain language first; the protocol terms are in brackets for readers who want them. The full
construction is in [PROTOCOL.md](PROTOCOL.md). The same content is in the app at `/safety`.

## Who you have to trust

**Nobody holds your coins at any point.** There is no bridge, exchange, committee or Ferry server
in the middle. Your coins are always either in your wallet or locked where the rules, enforced by
the two blockchains, decide who gets them.

You trust:

- **The Zcash and Bitcoin networks** to confirm transactions and keep their usual rules.
- **The cryptography**: Zcash's shielded pool, Bitcoin's Schnorr signatures, and one extra proof
  that links a key on one chain to the same key on the other [cross-group DLEQ]. That proof
  comes from Serai's library and **has not been audited**.
- **Your own Ferry**, which runs on your machine with your keys, and **staying online** until the
  swap ends (see below).

The public demo is the exception: it runs both sides on one server with test coins, so you can
watch a swap without installing anything. In real use, each side runs its own Ferry.

## If someone disappears or cheats

Z has ZEC and wants bitcoin. B has bitcoin and wants ZEC. B always locks first.

| What happens | Z ends up with | B ends up with | Why |
|---|---|---|---|
| Everything goes to plan | the bitcoin | the ZEC | Claiming the bitcoin reveals Z's half of the key, and that opens the ZEC for B [adaptor signature] |
| Z never locks ZEC | its ZEC (never sent) | its bitcoin, after the deadline | B calls the swap off and takes the refund [tx_cancel after T1, then tx_refund] |
| Z locks the wrong amount | its ZEC back | its bitcoin back | B never sends the signature Z needs; the swap is called off, and B's refund reveals B's half, so Z can reclaim |
| Z's wallet lacks enough shielded ZEC | its ZEC (untouched) | its bitcoin (never locked) | Ferry won't top up from transparent or other pools, so it turns the swap down before either side locks anything. If the balance drops after the swap starts, it sends nothing and waits for the refund |
| Z locks ZEC, then vanishes | its ZEC back, whenever it returns | its bitcoin back | B refunds before the second deadline; the refund reveals B's half, so Z can reclaim the ZEC later |
| B locks bitcoin, then vanishes | the bitcoin | nothing | After the second deadline Z takes B's bitcoin [tx_punish]. Z's ZEC stays locked, so for Z it works out as a completed swap. Going quiet only hurts the one who went quiet |
| Someone tries to take both | — | — | Not possible: each way out reveals the half the other side needs, or happens only after a deadline |

**The timing rules that make this safe** (Ferry enforces them; you don't have to):

- Z does not claim the bitcoin close to the first deadline. A claim stuck in the queue while the
  swap is being called off could reveal Z's half while B can still get a refund.
- B does not refund close to the second deadline, for the same reason.
- B refunds only after the call-off is confirmed on Bitcoin.
- B waits for several Zcash confirmations of the lock before letting Z claim the bitcoin.

## What you must still do

- **Stay online until your deadline.** If B is offline past the second deadline, B loses its
  bitcoin. If Z is offline past the first deadline, it can no longer claim the bitcoin, but still
  gets its ZEC back. This is true of every swap of this kind.
  **Or hand the job to a watchtower** ([WATCHTOWER.md](WATCHTOWER.md)). You give it your signed
  call-off, refund or penalty transactions, and it broadcasts them on time while you are
  offline. It holds no keys and can't redirect your coins; at worst it fails to act. B must pick
  a tower that won't pass the refund to the other side early: never the other side's own tower.
- **Keep your machine safe.** Ferry holds your keys like any wallet does.

## What the other side learns

- The amounts and the deadlines, which you agreed on.
- That your ZEC arrived at the shared address and, later, that it left. Both sides can see this
  one single-use address [shared viewing key].
- **Not where the ZEC went.** The sweep leaves no record the other side can read [the outgoing
  viewing key is discarded]. The end-to-end test proves this: the other side downloads the sweep
  and recovers no recipient or amount. A control run with this protection turned off shows the same
  check does catch the leak.
- **Not your wallet.** They never see your balance, your other addresses or your history.
- **Your IP address**, because the two Ferry daemons talk directly. Use Tor or a VPN if that matters.

## What everyone else sees

- **On Zcash: only encrypted data.** Every ZEC transaction in a swap stays inside the shielded
  pool, with no transparent, Sapling or Orchard part, and Ferry enforces this. Before locking it
  refuses unless your shielded [Ironwood] balance alone covers the swap, and it refuses to sign any
  transaction with a non-shielded part. The end-to-end test checks every transaction as mined:
  0 transparent in, 0 out, 0 Sapling, 0 Orchard ([evidence](evidence/e2e-real-regtest-2026-10-19.txt)).
- **On Bitcoin: an ordinary payment** when the swap goes to plan. The lock and the claim look like a
  normal single-key wallet sending and spending [MuSig2 key path]. When a swap is called off, the
  refund or penalty does show the swap's shape [script-path spends].
- **No link between the two chains.** The ZEC amount is hidden, nothing on one chain refers to the
  other, and the ZEC sweep waits a random delay so it doesn't line up in time with the bitcoin claim.

## Known limits (disclosed)

- **Unaudited cross-chain proof.** The proof linking the two halves across curves is Serai's
  experimental `dleq` code. A bug there could break the fairness guarantee.
- **Fixed fees on prepared Bitcoin transactions.** The call-off, refund and penalty transactions are
  signed in advance with a fixed fee. If fees spike, they could confirm slowly. Mainnet needs a
  fee-bump plan [anchor output / CPFP].
- **Zcash reorganisations.** Zcash blocks are only probably final, so B waits for a set number of
  confirmations; a deeper reorganisation than that is a risk.
- **Not quantum-recoverable.** The shared shielded address uses a key built in a way that Zcash's
  quantum-recovery plan doesn't cover [ZIP 2005]. The address is single-use and short-lived, and
  today's FROST multisig setups use the same method.
- **Testnet only.** Ferry has run real swaps on test networks and in a full local test with real
  shielded notes. It has not been independently reviewed, and it has not run on mainnet.

## How we checked

- `cargo test --workspace`: unit tests, a two-daemon simulation of every outcome above, and
  regtest tests for each Bitcoin path.
- `infra/e2e-real.sh`: a fresh local Bitcoin + Zebra + Zaino network, five stories run with real
  shielded notes (happy with stray notes arriving mid-swap, refund, punish, refused lock, and the
  privacy control), and a pool check on every ZEC transaction. It exits 0 only if every check passes.
