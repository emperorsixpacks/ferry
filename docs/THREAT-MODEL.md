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

## Known limits

Most of these are the price of having no middleman. Each says what Ferry does about it and what
is still open. What has actually run, and where, is in [WHAT-IS-REAL.md](WHAT-IS-REAL.md); the
README's [Known gaps](../README.md#known-gaps) lists them in one line each.

Z holds the ZEC. B holds the other coin (BTC, LTC, USDC or WETH). B always locks first. When you
sell ZEC you are Z; when you buy ZEC you are B.

### A partner must be online

Every trustless swap needs someone who holds the other coin and is there to answer, lock and sign.

- **What Ferry does.** Any Ferry daemon can be a partner [maker, `--maker-offer`]. The app asks
  every listed partner for a signed price and takes the best one. If no partner is online, nothing
  is locked and nothing is at risk.
- **What is still open.** Today the only partners are ours: one per pair on the public demo. No
  outside partner is listed for nodes (`infra/node/makers.txt` is empty), so a node swaps between
  its own two wallets. Outside nodes can't reach the demo's partner yet
  ([DEPLOY.md](DEPLOY.md#9-firewall)). Each partner runs several swaps at once (4 on test
  networks and 2 on mainnet by default, as far as its free funds go), so one taker who walks away
  no longer keeps it busy. That swap still holds one of its slots, and its coins until the first
  deadline; if the taker never locked anything, not even the slot once 30 minutes have passed
  ([Several swaps at once](#several-swaps-at-once)). When every slot is taken, the app says the
  partner is busy.

### Either side can walk away, and no chain can fine them

- **The free option.** Z locks second, so after B has locked, Z can watch the price and decide
  not to lock. After Z has locked, B can hold back the go-ahead [redeem adaptor signature, or
  Ready on EVM] and let the swap run out. Research calls an atomic swap "an American Call Option
  without the premium" ([Han, Lin and Yu, 2019](https://eprint.iacr.org/2019/896)).
- **Why nobody can be fined.** Both cases end the same way on the other chain: B's refund after
  the first deadline. The ZEC lock is a shielded note with no scripts, so no contract on Bitcoin or
  Base can see whether Z ever locked. A refund looks the same whether Z never locked or B held back.
  So no contract can tell who walked away, and a deposit would not help: whichever side could
  claim it could also cause the refund. Ferry does not pretend to fine anyone. This is the cost of
  keeping the ZEC side fully shielded.
- **What Ferry does.** Deadlines limit the option. Ferry's own daemon locks as soon as it can, but
  a Z that wanted to wait would still have to lock in time to claim before the first deadline: on
  Base mainnet, about 4 hours after the start at most. Walking away costs the walker only
  fees, and costs the other side time: B's coin waits until the first deadline (5 h 15 min after
  the start on Base mainnet), and Z's ZEC waits until B refunds. A partner can charge for the
  option in its price [`--maker-spread-bps`]; the node's own mainnet partners charge none today.
  <!-- update after many-swaps / safer-settings merge -->
- **What is still open.** Either side can stall at almost no cost to itself. Ferry has no
  deposits, bonds or reputation system.

### Swaps take minutes

Each side waits until the other's lock is confirmed deeply enough.

- **Measured.** The live Base Sepolia swap: the ZEC seller had its USDC about 2 minutes after the
  start, and the buyer's ZEC arrived at about 7 minutes. Test networks ask for 3 Zcash
  confirmations ([log](evidence/evm-base-sepolia-live-2026-10-20.txt)).
- **Expected.** Base mainnet: about 15-20 minutes, mostly the 10 Zcash confirmations (75-second
  blocks) ([MAINNET-DEMO.md](MAINNET-DEMO.md#expected-timeline-and-costs)). Bitcoin signet: about
  half an hour ([RUN-A-NODE.md](RUN-A-NODE.md)). <!-- update after many-swaps / safer-settings merge -->
- **What is still open.** Minutes, not seconds. Zcash's planned NU7 upgrade would cut blocks to
  25 seconds ([ZIP 218](https://zips.z.cash/zip-0218), a draft), which would shorten the wait.

### Fees on both chains

A swap is at least two transactions on each chain: a lock and a claim on the other chain, a lock
and a sweep on Zcash.

- **Zcash:** 5,000 zatoshi per shielded action, at least two per transaction
  ([ZIP 317](https://zips.z.cash/zip-0317)): 0.0001 ZEC for a sweep, more for a lock that spends
  several notes (0.00025 ZEC for a five-action lock in our regtest run).
- **Base mainnet:** about $0.25 per swap in all at 2026-10-20 prices, mostly the two Zcash fees
  ([MAINNET-DEMO.md](MAINNET-DEMO.md#expected-timeline-and-costs)).
- **Bitcoin and Litecoin:** each prepared transaction pays one fixed fee (2,000 sat by default,
  1,500 on the signet demo). A called-off swap costs B two of them (call-off and refund). A fee may
  be at most 5% of the amount, so at 2,000 sat the smallest Bitcoin swap is 40,000 sat.
- **What is still open.** A called-off swap still pays fees, and very small swaps don't pay off.

### B must refund in time, or use its own watchtower

- **The rule.** If a swap is called off, B must send its refund inside a window: after the first
  deadline, and before the second deadline minus a safety margin. On Base mainnet that window is
  1 hour, opening 5 h 15 min after the start. Test networks use shorter windows. If B misses it,
  Z takes B's coin (next section). <!-- update after many-swaps / safer-settings merge -->
- **Z has no such deadline.** An offline Z loses only the trade: its ZEC comes back whenever B
  refunds, and reclaiming it has no deadline.
- **What Ferry does.** Your node refunds by itself while it runs. A
  [watchtower](WATCHTOWER.md) can do it while you are offline. B's must be its own
  (`--watchtower-own`): B's refund reveals B's half of the key, so a tower that leaked it early
  could let Z take both sides.
- **What is still open.** Neither the node installer nor the public demo starts a watchtower. You
  run one yourself; it must stay up and, on Base, have money for gas.

### If B vanishes after Z locks, the ZEC stays locked

This is a known critique of this design, so here it is exactly:

- B locks its coin, Z locks its ZEC, and then B goes silent: no go-ahead and no refund.
- After the second deadline, Z takes B's coin [tx_punish on Bitcoin and Litecoin, `punish` on
  FerryLock]. On Bitcoin that is B's locked amount minus two fixed fees; on Base it is the whole
  locked amount, paid to Z's payout address. So Z is paid in B's coin, as if the swap had
  completed, only hours later.
- Z's ZEC stays in the joint address. Spending it needs both halves of the key. Z holds one and B
  the other, and neither was revealed, because Z never claimed and B never refunded. Nobody can
  spend it unless one side later hands its half to the other, and Ferry has no step for that
  today. B has lost its coin and gets no ZEC.
- If Z had not locked its ZEC (its wallet refused the lock, say), Z takes B's coin the same way and
  no ZEC is stuck.
- **What Ferry does.** The refund window and the watchtower above exist so that B never gets here.
  Not built: after a final punish, Z could hand its half to B so that B can sweep the ZEC.

### The cross-chain proof is unaudited

- One proof shows that each party's half of the key is the same number on Zcash's curve and on
  Bitcoin's [cross-group DLEQ, Pallas and secp256k1]. Ferry uses Serai's `dleq` crate, version
  0.4.1, with its `experimental` feature (`crates/ferry-dleq/Cargo.toml`).
- Serai's README says the library, "except for the `experimental` feature, was audited by Cypher
  Stack in March 2023", that "Any subsequent changes have not undergone auditing", and, of the
  cross-group proofs: "neither the original postulation (which had flaws) nor any construction
  here has been proven nor audited. Accordingly, they are solely experimental, and none are
  recommended." ([README](https://github.com/serai-dex/serai/blob/develop/crypto/dleq/README.md))
- A bug there could break the fairness guarantee: one side might be able to take both coins.
- **What Ferry does.** It binds each proof to its swap, checks the keys against Zcash's own
  signature scheme [RedPallas], derives its extra generators by hash-to-curve, and tests tampered,
  spliced and wrong-context proofs (`crates/ferry-dleq`). Nobody outside the project has reviewed
  Ferry.
- **This is why mainnet is capped**: 0.02 ZEC per swap in the node's mainnet mode
  (`./infra/node/ferry --mainnet`) and in the mainnet demo script.

### Fixed fees on prepared Bitcoin transactions, so Bitcoin and Litecoin stay on test networks

- The call-off, refund and penalty transactions are signed in advance, each with one fixed fee
  (`crates/ferry-btc/src/tx.rs`). Nothing can raise that fee in the transaction itself: there is no
  anchor output, and no presigned transaction, signature or message changed. If fees spike, they
  could confirm slowly, and a claim or refund still unconfirmed at its deadline could reveal a
  party's half of the key while the other side can still take its own coins back.
- **What Ferry does.** Bitcoin and Litecoin run on test networks only: the node's mainnet mode
  offers only Base (USDC and WETH). **They stay off mainnet until the review below is done.** A fee
  bump is built but **off by default** (`--bump on`, env `FERRY_BUMP`). The party that needs a spend
  confirmed already owns an output of it (the claim pays Z's wallet address, the refund B's, the
  penalty Z's), so its ferryd spends that output in an ordinary child that pays a higher fee out of
  its own payout (child-pays-for-parent, CPFP), and replaces that child with a better one as the
  deadline nears. It needs no anchor and no coins besides the payout, and nobody else can attach
  anything to those transactions, because nobody else can spend the output. The child's fee is
  capped: 10% of the payout while more than two blocks are left, the payout less dust after that
  (a penalty has no deadline and always stays at the 10%). The cap is applied twice: where the
  bump is planned, and again where the child is built, from the spend and the blocks left rather
  than from the plan. The call-off is not
  bumped, on purpose: it only delays the swap, and a call-off that could be bumped would let B
  outbid Z's claim in the race at the first deadline. `--bump off`, or a file named `bump-off` in
  the data directory, stops all bumping at once. And ferryd **refuses to start** with `--bump on`
  (or `FERRY_BUMP=on`) on a Bitcoin or Litecoin mainnet, and never bumps there, until the review
  below is done.
- **What was checked.** On regtest Bitcoin Core 28.1
  ([evidence](evidence/btc-fee-bump-regtest-2026-10-22.txt)): a claim, a refund and a penalty that a
  rising mempool floor kept out were put back with a child as a package and confirmed; a child was
  replaced twice as the deadline neared, with a restart in between; the call-off could not displace
  a bumped claim at the first deadline, also after the pair was evicted and put back; a reorg
  returned the pair to the mempool together. On Litecoin Core 0.21.5.6 only the building blocks
  ran: it has no package submission and does not replace transactions unless started with
  `-mempoolreplacement=1`, so there a swap is bumped once at most.
- **What is still open.**
  - Nobody outside the project has reviewed the bump: its funds-moving code, and the argument that
    the fixed-fee call-off cannot beat a bumped claim.
  - A presigned fee below the node's static minimum relay fee cannot be lifted by a child (checked:
    "min relay fee not met"); only one that fell below the mempool's rising floor can. The fee
    chosen when the swap starts still has to be at a sensible rate.
  - Small swaps. At 30,000 sat (about the 0.02 ZEC cap) a child may pay about 2,800 sat while more
    than two blocks are left, which lifts a 2,000-sat claim to about 22 sat/vB, and nearly the
    whole payout after that, about 130 sat/vB. A bumped claim at 50 sat/vB costs about a third of
    that swap.
  - A claim that pays a third-party address (`payout_to`) is not bumped: it has no output of Z's
    own. Forwarding the payout from a child is not built.
  - The bump stops as soon as the other side's competing spend is seen, even unconfirmed: Z's
    state moves to called-off when B's call-off is in the mempool, and B's to penalised when Z's
    penalty is. A claim or refund put back as a package could still have replaced it; the state
    machines (`ferry-core`) were not changed to allow that.
  - The watchtower does not bump (it holds no keys and cannot spend B's output), so a B that is
    offline relies on its refund's presigned fee.
  - Whether Bitcoin nodes and miners relay and mine packages the way Core 28 does is not measured
    on mainnet. The first bump on a real network should be a small canary swap.

### Other limits

- **Zcash reorganisations.** Zcash blocks are only probably final, so B waits for a set number of
  confirmations; a deeper reorganisation than that is a risk.
- **Not quantum-recoverable.** The shared shielded address uses a key built in a way that Zcash's
  quantum-recovery plan doesn't cover [ZIP 2005]. The address is single-use and short-lived, and
  today's FROST multisig setups use the same method.
- **Test networks so far.** Fifteen live swaps on public test networks (ZEC ⇄ USDC and ZEC ⇄ WETH
  on Base Sepolia, 2026-10-20 to 2026-10-22; ZEC → BTC on Bitcoin signet, 2026-10-23) and a full
  local test with real shielded notes. Nothing has run on mainnet, and
  nobody outside the project has reviewed Ferry ([WHAT-IS-REAL.md](WHAT-IS-REAL.md)).

## USDC on Base

Ferry can also swap shielded ZEC for USDC on Base ([details](EVM.md)); it has run locally and on
Base Sepolia with real Zcash testnet notes ([log](evidence/evm-base-sepolia-live-2026-10-20.txt)). The same protections apply. It differs from the Bitcoin version in
these ways:

- **Every step on Base is visible as a swap**, not only the abort paths. The lock and the claim
  or refund are public calls to the Ferry contract, with the USDC amount and the deadlines. The
  go-ahead that lets Z claim is a signature B sends Z directly, so it leaves nothing on chain. The
  Zcash side stays fully shielded, and there is still no link between the two chains.
- **The halves of the key are revealed publicly** rather than only to the other side. This is
  safe: one half opens nothing, and nobody else can find the shared ZEC note.
- **You also trust USDC's issuer**, which can freeze transfers, and Base's sequencer to include
  transactions on time. Ferry leaves a margin for that before each deadline: 2 hours on Base
  mainnet, as long as Base's longest stop so far.
- **The deadlines on Base mainnet**, from the start: Z's last claim at 2 h 15 min, B's refund from
  4 h 15 min, and B has 24 hours for it (until 28 h 15 min); after that, at 30 h 15 min, Z may
  take B's USDC. So if you are buying ZEC and the swap is called off, your node (or your own
  watchtower) must run at some point in that day
  ([details](EVM.md#timing-rules-the-daemon-enforces-these-not-the-chain)).
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

A route swaps, say, bitcoin for USDC by running ordinary Ferry swaps with shielded ZEC in between
([how it runs](PROTOCOL.md#routes)): swap 1 buys ZEC with your bitcoin and pays it straight into
your other Ferry's shielded wallet; once it can be spent, swap 2 sells that ZEC for USDC. By
default each swap is split into **parts of standard sizes** (0.1, 0.25, 0.5, 1, 2.5 ZEC and so
on), each part its own swap after its own random pause. Each swap keeps every protection above. A
route adds two things to think about: what links the two sides, and where your money is if swap 2
can't finish.

### What the ZEC hides, and what still links the two swaps

**Hidden.** All the Zcash transactions (every part's lock, its sweep into your second wallet, the
other side's sweeps) are fully shielded: no amount, address or memo appears on chain. A partner
can't see where its sweep went [the outgoing viewing key is discarded], and no key or hash is
shared between swaps.

**Hidden by standard amounts: the exact amounts.** Without them, both outer amounts come from one
ZEC amount at public prices, so "0.0041 BTC in, then about 40 USDC out a while later" sits in a
ratio close to the two coins' price ratio, and an observer can test candidate pairs to within a
percent or two. With them, each side is a few swaps of fixed sizes: a 0.5 ZEC part buys the same
amount of bitcoin as every other 0.5 ZEC swap at that hour, and sells for the same USDC. Matching by
amount now picks out a size class, not a swap. Leg 2 sells the same sizes leg 1 bought when your
second wallet holds a little spare ZEC (about 0.0001 ZEC per part plus 0.0004) to pay the Zcash
fees; otherwise it sells the most standard ZEC that fits after the fees, and the rest (under 0.05
ZEC for most routes) stays shielded in your wallet, where it pays the next route's fees. A request
between standard amounts is rounded down; the rest of your coin A stays in your wallet.

**Not hidden:**

- **How many parts, and which sizes.** A route of 0.5 + 0.25 + 0.1 bought and the same sold, in a
  few hours, is a pattern. It hides only among other swaps of those sizes at that time: on test
  networks and quiet markets there are few, and timing alone may link them.
- **When.** Parts of one route fall within a window: with the Standard pause (5 to 30 minutes per
  part) a three-part BTC → USDC route spans about one and a half to three hours on test networks.
  Each part's pause is drawn on its own and the legs interleave, so there is no clean burst of buys
  followed by a burst of sells, but the window is there.
- **Your own parts, linked to each other.** Standard sizes help only while an observer can't tell
  that several parts are yours. **On an EVM chain every swap uses your daemon's one account**, so
  your parts there are plainly yours: an observer adds them up and has the total, and the amount
  ratio is back for that side. On Bitcoin and Litecoin each lock is funded from your wallet, and
  change outputs or inputs spent together can tie your parts to each other; coin C paid to fresh
  addresses stays apart until you spend it together. Two EVM sides are still close to trivially
  linkable.
- **Partners.** A partner sees the size and time of each part it takes, and your IP address. One
  partner taking every part of a leg sees that leg's total. Partners that are one operator, or share
  notes, can match sizes and times across the legs almost certainly. List several partners: part n
  starts with the n-th.
- **A route that pays out to an address** (`payout_to`, NEAR Intents) sells in one swap of the
  whole amount: a deposit address takes one deposit, and NEAR's side is public anyway.
- **Your bitcoin inputs** keep their usual history, and the ETH an EVM account needs for gas came
  from somewhere.
- **The route record** on your machine links everything. It is stored privately (mode 0600), like
  swap records.
- **The public demo** runs every daemon on one server, so its operator sees every swap.

**What helps, and is built in:**

- **Standard amounts**, on by default (above).
- **A random pause before every part** (Standard: 5 to 30 minutes; Long: 1 to 6 hours), drawn once
  and kept across restarts. Skipping it is allowed and says that it makes the swaps easier to link.
- **A different partner for each side.** The router refuses the same partner, by name or by host,
  on both sides. It can't prove that two names aren't one operator; nobody can.
- **No same-asset routes.** USDC to USDC is refused: the amount in would match the amount out.
- **Fresh bitcoin addresses** for every swap, as always.
- **ZEC jitter** (`keep_bps`) for routes with standard amounts off (a testing switch): a random
  sliver of the ZEC kept back, so the two ZEC amounts differ.

**Not covered:** Tor, a separate EVM account per swap, and coin control that keeps your bitcoin
parts apart. A determined observer of a quiet chain can still link the sides by timing and by your
parts' shared account or inputs, and colluding partners can link them directly.

### Where your money is if something goes wrong

Each part is a whole swap, so each row applies to each part.

| Where it goes wrong | What happens | You end with | Route |
|---|---|---|---|
| Before anything moves: your second wallet unreachable, the first part's partners refuse, amount out of range, price past your limit | Nothing is locked | Everything you had | `failed` |
| A swap-1 part: the partner never locks ZEC, or locks the wrong amount | You call it off after its deadline and take the refund; no later swap-1 part starts | That part's coin A, less network fees; the ZEC earlier parts bought is still sold | `failed` (refunded) if nothing was bought, else as below |
| A swap-1 part: you are offline after locking | Your own watchtower refunds before the second deadline. **Without one, the partner takes that part's coin A** | Coin A, **or not that part's** | as above (punished) |
| A swap-1 part: the partner claimed, you are offline | Your share of the key is public on chain, only you hold the other part, and the sweep has no deadline | ZEC, swept into your second wallet when you are back | resumes |
| Between parts: the router or your second Ferry is down | Nothing happens; nothing has a deadline | Shielded ZEC in your second wallet | resumes |
| A swap-2 part can't start (partner offline, busy, paused, below your minimum price) | Retried, through your listed partners, for 2 hours; then no new part of either swap starts | Shielded ZEC (and coin C for parts already sold) | `holding` (try again or keep the ZEC) |
| A swap-2 part: the partner never locks, or never sends the go-ahead, or you miss the claim | That part is called off and refunded; you reclaim its ZEC; the other parts go on | That part's ZEC, less two Zcash fees, and coin C for the others | `holding` |
| A swap-2 part: your lock is refused (the balance dropped) | Nothing is sent from your wallet | Shielded ZEC | `holding` |
| A swap-2 part: the partner locks, then vanishes | You (or a watchtower) take its coin C after the deadline; that part's ZEC stays locked as its penalty | Coin C | `done` |
| A swap-2 part: you are offline after the partner's refund | The ZEC waits in the shared note; only you can spend it, with no deadline | Shielded ZEC when you are back | `holding` |
| You stop the route | Parts not yet started never start; parts under way finish | What they bought, as shielded ZEC, and coin C for what they sold | `holding` (or `failed` if nothing was bought) |

**The worst case is "you hold shielded ZEC"** for every part from the moment its swap-1 partner has
claimed its coin A, and for every way a swap-2 part can fail: the price limits make sure a late
part never fills below the rate you accepted, and if it can't fill, you keep the ZEC. That is
**not** true while a swap-1 part runs: there you are an ordinary ZEC buyer, and if you go offline
past its second deadline with no watchtower, you lose that part's coin A, exactly as in a single
swap. `continue` sells ZEC a route holds as new parts.

**Watchtowers.** Run your swap-1 Ferry (the buyer) with its own watchtower (`--watchtower …
--watchtower-own`). Your swap-2 Ferry (the seller) can use any tower. Towers never touch the ZEC
side, which has no deadlines. The router changes nothing about any swap's tower.

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

## Taking coins out of your Ferry ("Send to my wallet")

`POST /api/withdraw` ([API.md](API.md#withdraw-send-to-my-wallet)) sends coins from your Ferry's
wallets to an address you give. It is an owner action on your own node's control API: loopback
only by default, and only whoever holds the API token can call it, the same token that already
controls everything the node holds. Nothing about a swap partner changes: no partner can reach it
or set where it pays. **The public demo must never expose it**: its daemons hold the operator's
coins, so its server must not forward the call (the web server gates it, as it does `payout_to`).
Ferry never spends what a running swap still needs (its lock, the fee reserve, the gas of its
remaining claim, refund or penalty) and records each withdrawal before broadcasting it, so a
crash neither loses nor repeats one. **ZEC leaves shielded only**: Ferry refuses a transparent
destination, funds the payment from Ironwood notes and pays an Ironwood note, and refuses to sign
anything else; it is sent from your own account, whose outgoing viewing key only you hold, so the
joint-address concern behind sweeping with `--discard-ovk` does not arise. The deposit address
Ferry shows (`GET /api/addresses`) has a shielded receiver only, so whatever a wallet sends there
arrives shielded. On Bitcoin, Litecoin and EVM chains a withdrawal is an ordinary public payment
from the node's wallet to your address.

## Several swaps at once

A Ferry node runs several swaps at the same time, as maker and taker together, up to a cap
(`--max-swaps`: 4 on test networks, 2 on mainnet by default) and only as far as its free funds go
([API.md](API.md#several-swaps-at-once)). One person's slow swap no longer stops everyone else.

**Each swap keeps what it still needs.** Until its lock is out, a swap holds the lock amount and
its fees; on Base it also holds the gas of the calls it may still have to make. A new swap, a
withdrawal and the amount a maker says it can take ("Takes up to … right now") only count what is
left. The holds are worked out from the saved swaps every time, so they are right after a restart
too. A new swap that the free funds can't cover is turned down as busy before anyone locks
anything; it is never half started.

**No two swaps spend the same coins:**

- **Zcash.** Ferry builds, signs and sends one lock at a time from its wallet, and the wallet
  records which notes a lock spends before it is broadcast. Change only becomes spendable after it
  confirms, and Ferry re-reads the balance right after each send. A wallet spends whole notes, so
  when several locks are still to be sent, Ferry counts that each may take up to one note more
  than it needs, and that every note spent adds 5,000 zatoshi to its fee (ZIP-317), and turns a
  new swap down if the notes can't cover every lock at once. A test simulates the wallet picking
  notes in any order and checks every admitted set of locks gets funded. A node whose ZEC sits in
  one big note therefore takes one swap at a time until the change of its last lock confirms;
  splitting the ZEC into a few notes lets it take more.
- **Bitcoin and Litecoin.** Locks are funded one at a time, and the wallet locks the coins a
  funded lock picked until that lock is broadcast, so nothing else it funds (another swap, a
  withdrawal) can pick them. The node forgets these locks when it restarts, so Ferry locks them
  again before it funds anything. Ferry takes the wallet to be its own (each daemon has its own
  wallet in `infra/deploy` and `infra/node`): when it starts, and before it funds a lock, every
  locked coin no unbroadcast lock needs goes back, so a swap called off before its lock went out,
  or a funding cut short by a crash, leaves no coin stuck.
- **Base.** The node's account sends one transaction at a time, so its nonces follow each other,
  and a lock's approval and the lock itself go out together, so two swaps can't use each other's
  approval.
- **Withdrawals** keep working while swaps run, from the free funds only, and are still recorded
  before they are broadcast.

**One swap's slow work doesn't hold up another's deadline.** The daemon goes over its swaps in
rounds. Each round first does every swap's deadline steps (call off, refund, punish, redeem,
claim), then every swap's look at the Zcash chain, and only then the slow work (funding a lock, building and proving a ZEC lock or sweep, an
EVM lock waiting for its receipts), one swap at a time, doing the deadline steps again every 20
seconds in between. A Zcash call that takes a minute or more (a stuck wallet server) puts the
round's other Zcash work off to the next round, so a hung server costs one wait per round rather
than one per swap. A redeem or refund that comes due while other work runs is checked against its
window again just before it is first sent, so one that is now too late is never sent.

**Swaps that are abandoned.** Anyone can propose a swap and walk away, and with a cap that could
fill every slot. Ferry keeps its limit of 6 proposals a minute, still calls off a swap where
nothing is locked after the negotiation timeout (30 minutes by default), and adds one rule: a swap
whose partner has locked nothing by that timeout no longer counts against the cap. It keeps its
funds held until its own deadline and refund, but it no longer keeps a real user out. At most
twice the cap are kept in all. Nothing about who proposed is recorded or compared: there is no
identity to go on, and adding one would cost privacy.

**What remains possible (known limits):**

- Someone who keeps proposing at the rate limit can keep a node full, or its free funds tied up,
  and new swaps are turned down as busy until the timeouts and refunds run their course. Swaps
  already in progress are never affected. The proposal limit is shared by everyone, so it can
  be used the same way.
- A taker who signs and then never locks its ZEC still makes a bitcoin (or USDC) maker lock first:
  the maker's coins stay locked until its refund deadline, and it pays the lock, call-off and
  refund fees. This is the protocol's "B locks first" rule and was true before; with several slots
  one such taker no longer blocks the node, but several can tie up more of its funds (at most what
  is free, and at most twice the cap).
- A maker's offer says how many more swaps it takes right now, so anyone who watches it learns
  when its swaps start and end. Its "takes up to" amount already changed with every swap, so this
  adds little, but it is a timing signal.
- On the public demo, ZEC a private swap has bought waits in the node's wallet between its two
  swaps, and the node counts it as free; the demo server turns down direct sales on that pair until
  the private swap is done, and buys there too when that node is also a listed partner.
- **Z's watch for a late ZEC lock is bounded.** After a refund that followed a ZEC send which may
  have gone out, Z watches the joint address so a lock that lands anyway is reclaimed. It stops
  once its wallet shows the lock can never land (a lock expires 40 blocks, about 50 minutes, after
  it is built if it isn't mined), or after a week without news. A wallet server down for longer
  than that could leave such a note unwatched; the swap record keeps what is needed to reclaim it.
- **On Base, one stuck transaction holds up the others.** The node's account sends its
  transactions in nonce order. If one (say a lock) sits unmined, for example because its fee was
  too low when gas prices jumped, every later transaction of that account, refunds and claims
  included, waits behind it; Ferry does not yet replace a stuck transaction with a higher fee.
  The deadline windows (hours on Base mainnet) leave room for the operator to step in, and a
  watchtower, which sends from its own account, is not held up.

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
