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
- B never hands over what lets Z claim (the redeem signature; on EVM, Ready) once the locked ZEC has
  been spent by anyone else or the swap was called off, even if it made it earlier and Z had not
  picked it up yet.

**Selling or buying makes no difference.** Whoever proposes the swap (the taker) and whoever
answered an offer (the maker), B locks first and Z second, and every rule above holds the same:
selling ZEC is Z taking a B maker's offer, buying ZEC is B taking a Z maker's. What changes is who
holds the option. Once both have locked, B can still let the swap run out by never sending the
signature; that ties up Z's ZEC until the refund, and B pays the fees. A Z maker selling ZEC carries
this the way a B maker carries a taker who never locks. Ferry never moves funds while answering a
request: a lock goes out only after the swap is saved, so a request that gives up halfway can't
leave coins locked that the node doesn't track.

## What you must still do

- **Stay online until your deadline.** If B is offline past the second deadline, B loses its
  bitcoin. If Z is offline past the first deadline, it can no longer claim the bitcoin, but still
  gets its ZEC back. This is true of every swap of this kind.
  **Or hand the job to a watchtower** ([WATCHTOWER.md](WATCHTOWER.md)). You give it your signed
  call-off, refund or penalty transactions, and it broadcasts them on time while you are
  offline. It holds no keys and can't redirect your coins; at worst it fails to act. B must pick
  a tower that won't pass the refund to the other side early, so Ferry arms one for B only when B
  marks it as its own (`--watchtower-own`). Z can use any tower. It works the same on Bitcoin and
  Litecoin. For USDC, see below.
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
- **With firm prices, a size bucket.** Every listed partner your server asks for a price learns
  roughly how much (0.5 to 1 ZEC, say), which way, and when, with the server's address but nothing
  about you; only the one you swap with learns the exact amount
  ([ARCHITECTURE.md](ARCHITECTURE.md#firm-quotes)).

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

## USDC on Base

Ferry can also swap shielded ZEC for USDC on Base ([details](EVM.md)); it has run locally and on
Base Sepolia with real Zcash testnet notes ([log](evidence/evm-base-sepolia-live-2026-10-20.txt)). The same protections apply. It differs from the Bitcoin version in
four ways:

- **Every step on Base is visible as a swap**, not only the abort paths. The lock and the claim
  or refund are public calls to the Ferry contract, with the USDC amount and the deadlines. The
  go-ahead that lets Z claim is a signature B sends Z directly, so it leaves nothing on chain. The
  Zcash side stays fully shielded, and there is still no link between the two chains.
- **The halves of the key are revealed publicly** rather than only to the other side. This is
  safe: one half opens nothing, and nobody else can find the shared ZEC note.
- **You also trust USDC's issuer**, which can freeze transfers, and Base's sequencer to include
  transactions on time. Ferry leaves a margin for that before each deadline.
- **A watchtower works differently.** There is nothing to sign in advance: the tower calls the
  swap contract's refund or penalty itself and pays the fee from its own account. The contract
  pays only the swap's own two parties, whoever calls. The ZEC side's package holds no secret. The
  USDC side's package holds that side's half of the shared ZEC key, because the refund needs it,
  so the same rule applies, only more strongly: use only a tower you run yourself
  (`--watchtower-own`). A tower that leaked that half early could let the other side take its ZEC
  back, and if you had already given the go-ahead, the USDC too. Ferry never gives the go-ahead
  once the shared ZEC has been moved by someone else. A tower with no fee money left can't act,
  which is the same as being offline.

## Routes (coin A → shielded ZEC → coin C)

A route swaps, say, bitcoin for USDC by running two ordinary Ferry swaps one after the other with
shielded ZEC in between ([how it runs](PROTOCOL.md#routes)): swap 1 buys ZEC with your bitcoin and
pays it straight into your other Ferry's shielded wallet; after a random pause, swap 2 sells that
ZEC for USDC. Each swap keeps every protection above. A route adds two things to think about:
what links the two swaps, and where your money is if swap 2 can't finish.

### What the ZEC hides, and what still links the two swaps

**Hidden.** All four Zcash transactions (swap 1's lock, its sweep into your second wallet, swap 2's
lock and the other side's sweep) are fully shielded: no amount, address or memo appears on chain.
Swap 1's partner can't see where its sweep went [the outgoing viewing key is discarded], and no
key or hash is shared between the two swaps.

**Not hidden:**

- **Timing.** Swap 1 ends on chain A and swap 2 begins on chain C about 25 minutes apart on test
  networks (the sweep's 10 confirmations, then your wallet's), plus the pause. Without a pause that
  gap is a fingerprint.
- **The amount ratio.** Both amounts come from the same ZEC amount at public prices, so the amount
  in and the amount out sit in a ratio close to the two coins' price ratio. An observer can test
  candidate pairs to within a percent or two. On a busy chain like Bitcoin mainnet there are many
  candidates; on test networks, and on any EVM leg (where only Ferry contract calls qualify), there
  are few. Two EVM legs are close to trivially linkable.
- **Colluding partners.** Swap 1's partner knows the ZEC amount and when its note was spent; swap
  2's partner knows a slightly smaller amount and when your lock arrived. Both see your IP address.
  If they are the same operator, or share notes, they can link your two swaps almost certainly.
- **Your EVM account.** Every EVM swap uses the daemon's one account, and the ETH it needs for gas
  came from somewhere.
- **Your bitcoin inputs** keep their usual history.
- **The route record** on your machine links both swaps. It is stored privately (mode 0600), like
  swap records.
- **The public demo** runs every daemon on one server, so its operator sees both swaps.

**What helps, and is built in:**

- **A random privacy pause** before swap 2 (Standard: 5 to 30 minutes; Long: 1 to 6 hours), drawn
  once and kept across restarts. Skipping it is allowed and says that it makes the swaps easier to
  link.
- **A different partner for each swap.** The router refuses the same partner, by name or by host,
  on both swaps. It can't prove that two names aren't one operator; nobody can.
- **ZEC jitter** (`keep_bps`): keep a random sliver of the ZEC back, so the two ZEC amounts differ
  and the ratio test widens.
- **No same-asset routes.** USDC to USDC is refused: the amount in would match the amount out.
- **Fresh bitcoin addresses** for every swap, as always.

**Not covered:** Tor, and a separate EVM account per swap. A determined observer of a quiet chain
can still link the swaps by timing and amount, and colluding partners can link them directly.

### Where your money is if something goes wrong

| Where it goes wrong | What happens | You end with | Route |
|---|---|---|---|
| Before anything moves: your second wallet unreachable, swap 1's partner refuses, amount out of range, price past your limit | Nothing is locked | Everything you had | `failed` |
| Swap 1: the partner never locks ZEC, or locks the wrong amount | You call swap 1 off after its deadline and take the refund | Coin A, less network fees | `failed` (refunded) |
| Swap 1: you are offline after locking | Your own watchtower refunds before the second deadline. **Without one, the partner takes coin A** | Coin A, **or nothing** | `failed` (refunded or punished) |
| Swap 1: the partner claimed, you are offline | Your share of the key is public on chain, only you hold the other part, and the sweep has no deadline | ZEC, swept into your second wallet when you are back | resumes |
| Between the swaps: the router or your second Ferry is down | Nothing happens; nothing has a deadline | Shielded ZEC in your second wallet | resumes |
| Swap 2 can't start (partner offline, busy, paused, below your minimum price) | Retried, through your listed partners, for 2 hours | Shielded ZEC | `holding` (try again or keep the ZEC) |
| Swap 2: the partner never locks, or never sends the go-ahead, or you miss the claim | Swap 2 is called off and refunded; you reclaim your ZEC | Shielded ZEC, less two Zcash fees | `holding` |
| Swap 2: your lock is refused (the balance dropped) | Nothing is sent from your wallet | Shielded ZEC | `holding` |
| Swap 2: the partner locks, then vanishes | You (or a watchtower) take its coin C after the deadline; your ZEC stays locked as its penalty | Coin C | `done` |
| Swap 2: you are offline after the partner's refund | The ZEC waits in the shared note; only you can spend it, with no deadline | Shielded ZEC when you are back | `holding` |

**The worst case is "you hold shielded ZEC"** from the moment swap 1's partner has claimed your
coin A, and for every way swap 2 can fail: the price limits make sure a late swap 2 never fills
below the rate you accepted, and if it can't fill, you keep the ZEC. That is **not** true during
swap 1: there you are an ordinary ZEC buyer, and if you go offline past the second deadline with no
watchtower, you lose coin A, exactly as in a single swap.

**Watchtowers.** Run your swap-1 Ferry (the buyer) with its own watchtower (`--watchtower …
--watchtower-own`). Your swap-2 Ferry (the seller) can use any tower. Towers never touch the ZEC
side, which has no deadlines. The router changes nothing about either swap's tower.

## Paying out to another address (`payout_to`, NEAR Intents)

When you sell ZEC, you can have the coin you receive paid straight to another address instead of
your own wallet ([API.md](API.md#payout-address-payout_to)): typically a NEAR Intents deposit
address that turns it into another coin on another chain
([how the two fit](ARCHITECTURE.md#cross-chain-settlement-with-near-intents)).

**The swap's guarantees don't change.** The address is fixed when the swap is agreed, before
anything is locked, and nobody can change it afterwards: on Bitcoin and Litecoin it is in the
claim transaction the other side signs [tx_redeem, under B's adaptor signature], and on EVM it is
the payee in the contract's lock terms [`claimer`], which Ferry checks on chain before it locks
your ZEC. A partner can't redirect it: the only claim Ferry ever signs or sends pays that
address, and on EVM Ferry won't lock ZEC behind any other payee. A partner that ignores it (an
older Ferry) or tries another can only stop the swap, at negotiation or through the usual call-off
and refund; it never gets your ZEC. Only whoever holds your Ferry's API token can set it;
a partner never can. Ferry checks it before asking anyone: an address of the right coin and
network that only its owner can spend, paid above the dust floor. Keys, deadlines, timing rules
and the call-off path are the same, and if the swap is called off your ZEC comes back to your own
wallet. On Bitcoin and Litecoin the penalty [tx_punish] still pays your own wallet. **On EVM** the
contract has one payee for the ZEC seller, so the penalty (your partner vanished after locking)
goes to the payout address too, hours later than a normal claim.

**What you trust on the NEAR side.** Once the payout lands, Ferry's guarantees end and NEAR
Intents' begin: the deposit address is controlled by NEAR Intents, not by you, and the
conversion is not atomic with the swap. You trust NEAR Intents, its bridges and its solvers to
deliver the quoted coin, or to refund to the refund address you gave, while they hold your coin
during settlement. A deposit address has a deadline: a payout that arrives late (a slow swap, or
an EVM penalty) is refunded rather than converted, under NEAR's rules. Their leg is public: the
1Click service sees the quote (amounts, destination), the deposit and settlement are visible on
both chains and on NEAR, and the deposit address links your payout to its destination. Nothing
about this touches Zcash: the ZEC side stays shielded.

**Ferry never sends ZEC into NEAR Intents.** We checked the live 1Click API on 2026-10-20: its ZEC
deposit address is transparent. Depositing there would take the ZEC out of the shielded pool and
publish the amount and the link Ferry exists to hide. So Ferry does the private hop (shielded ZEC
for BTC, LTC, USDC or WETH) and NEAR Intents only ever touches the other coin.

**The public demo never lets a visitor choose `payout_to`**: its daemons hold the operator's
coins, so a visitor's address would be paid with them. Its server sets the field only to a
deposit address it created itself.

## How we checked

- `cargo test --workspace`: unit tests, a two-daemon simulation of every outcome above, and
  regtest tests for each Bitcoin path.
- `infra/e2e-real.sh`: a fresh local Bitcoin + Zebra + Zaino network, five stories run with real
  shielded notes (happy with stray notes arriving mid-swap, refund, punish, refused lock, and the
  privacy control), and a pool check on every ZEC transaction. It exits 0 only if every check passes.
- `infra/route-demo.sh test`: routes BTC → shielded ZEC → USDC on regtest Bitcoin and anvil with a
  stand-in Zcash chain: one to the end (the router restarted twice midway, and exactly one swap 2),
  one whose swap 2 pays a third address (`payout_to`), one whose swap 2 is refunded so the route
  holds the ZEC until "try again" finishes it, and one stopped during swap 1 that ends holding the
  ZEC. The waits between the swaps with real notes are covered by unit tests and
  `infra/e2e-real.sh`, not by this script.
- Payout addresses: simulation tests (the redeem pays it on the key path and the script path, the
  penalty doesn't, a partner that drops it or locks to another payee gets no ZEC),
  `infra/demo.sh test` (a regtest swap whose redeem pays a segwit address of a third wallet), and
  an anvil test whose claim lands at a third account.
