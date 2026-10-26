# What is real and what is a mock

For judges. Every claim here points to code in this repository or to a public block explorer.
Checked against the code on 2026-10-23.

Two words used throughout: **Z** holds the ZEC, **B** holds the other coin (BTC, LTC, USDC or
WETH). B always locks first.

## In short

- **Real:** the protocol and all of its code. Eighteen live swaps on public test networks (Zcash
  testnet, Base Sepolia, Bitcoin signet and Litecoin testnet), all with real shielded notes: the
  first ZEC ⇄ USDC swap on 2026-10-20, twelve through the public swap card of the server deploy on
  2026-10-21 (ZEC → USDC twice, USDC → ZEC twice, ZEC → WETH eight times, up to three at once),
  the first WETH → ZEC buy on 2026-10-22, on 2026-10-23 the first swaps each way on Bitcoin
  signet (ZEC → BTC, then BTC → ZEC) and the first on Litecoin testnet (LTC → ZEC), and on
  2026-10-26 the first on a one-command node (ZEC → USDC), followed by Send to my wallet. A full local
  run with real shielded ZEC on Bitcoin regtest, covering the swap, the refund and the penalty.
- **Test coins only.** No swap has run on mainnet. The node's mainnet mode is capped at 0.02 ZEC
  per swap.
- **One partner per pair, run by us.** On the public demo we run both sides on one server. No
  outside partner is listed yet.
- **Not run yet:** a ZEC → LTC sell on Litecoin testnet, a live refund or penalty, anything on
  mainnet, and NEAR Intents with real funds.
- **Mocks** are used for local development and in tests. Each is listed
  [below](#what-is-mocked-in-development).

The costs of the design (a partner must be online, free options, waiting, fees, deadlines, an
unaudited proof) are in [THREAT-MODEL.md, "Known limits"](THREAT-MODEL.md#known-limits).

## What has run, and where

We ran both sides of every swap below. Live swaps can be checked on public block explorers (the
Zcash side is shielded, so only its transaction ids are public); local runs, by running them again.

| What ran | Where | Zcash side | Check it |
|---|---|---|---|
| ZEC ⇄ USDC, one swap that completed (0.05 test ZEC for 2 test USDC) | **Public test networks:** Base Sepolia and Zcash testnet, run from our machine with `infra/evm-testnet.sh` | **Real** shielded notes | On Base Sepolia: [FerryLock](https://sepolia.basescan.org/address/0x74b775EA7Bc7a2b2688b7A72Da5dee674BBd65Ef), [lock](https://sepolia.basescan.org/tx/0xeac4a050a97702fbca0fb1cf8ad8d4f965549e0612c62e0d85d233182fa926bb), [claim](https://sepolia.basescan.org/tx/0xde25c161c7e9b978de9aed580d12b0530813a460dd543124fbfc345978996aad) |
| Twelve swaps that completed: ZEC → USDC twice, USDC → ZEC twice, ZEC → WETH eight times (two and three at once); a start refused while the partner was busy (409) and the demo's per-address limit (429) | **Public test networks:** Base Sepolia and Zcash testnet, through the public swap card of the server deploy (`infra/deploy/deploy.sh local`, run on our machine) | **Real** shielded notes | Every lock and claim is a call to [FerryLock on Base Sepolia](https://sepolia.basescan.org/address/0x74b775EA7Bc7a2b2688b7A72Da5dee674BBd65Ef) |
| WETH → ZEC, one buy that completed (0.00012 test WETH for 0.01 test ZEC), start to ZEC in the buyer's own shielded notes in 7.5 minutes | **Public test networks:** Base Sepolia and Zcash testnet, through the same public swap card | **Real** shielded notes | On Base Sepolia: [lock](https://sepolia.basescan.org/tx/0x8d2ba7ed272476ab8585f85dd7fda874bdfaee2c9befa801913ca85ff5f2c365), [claim](https://sepolia.basescan.org/tx/0xdb0b11bd8b7178862bbb015514ff2aebe9ac1b437862474fd8ddade5668029a3) |
| ZEC → BTC, one swap that completed (0.10 test ZEC for 0.00041 signet BTC, 0.000395 after the redeem's fixed fee), start to BTC in the seller's wallet in 14.5 minutes | **Public test networks:** Bitcoin signet (our own Bitcoin Core node) and Zcash testnet, through the same public swap card | **Real** shielded notes | On signet: [lock](https://mempool.space/signet/tx/f3021217123129e1c55032e1cf5a74557f4aa5b40bd154c6235b5e01405c39f4), [redeem](https://mempool.space/signet/tx/472b3d9389133612e644438d5ebfb6326ed747e843034c2dd2c70f4fcd1ef12b) |
| BTC → ZEC, one buy that completed (0.00041 signet BTC for 0.10 test ZEC), start to ZEC in the buyer's own shielded notes in under 11 minutes | **Public test networks:** Bitcoin signet (our own Bitcoin Core node) and Zcash testnet, through the same public swap card | **Real** shielded notes | On signet: [lock](https://mempool.space/signet/tx/5dcfc7974129091ccd70fac74836c32f6438798a3f17734e38e4756c97907bcf), [redeem](https://mempool.space/signet/tx/a9a288f6113e6050295e15b2033d7fc3f14863f31e782756fbb10da864e969cf) |
| LTC → ZEC, one buy that completed (0.01 test LTC for 0.01 test ZEC), start to ZEC in the buyer's own shielded notes in under 25 minutes | **Public test networks:** Litecoin testnet (our own Litecoin Core node) and Zcash testnet, through the same public swap card | **Real** shielded notes | On Litecoin testnet: [lock](https://litecoinspace.org/testnet/tx/e64f6b248c7cdfd8cf7c655be36cef2c324711d8ac21a0eddafd99d764b13cad), [redeem](https://litecoinspace.org/testnet/tx/c7e52a8e36fc4b3549034c9256d35bf5210a74d19065d6b15b7fbda3b22403c8) |
| ZEC → USDC, one swap that completed (0.10 test ZEC for 4 test USDC), Sell to done in 2.5 minutes; then Send to my wallet twice (2 and 1 test USDC) | **Public test networks:** Base Sepolia and Zcash testnet, on a fresh one-command node (`./infra/node/ferry up`, run on our machine), trading between its own two wallets | **Real** shielded notes | On Base Sepolia: [lock](https://sepolia.basescan.org/tx/0x9dc4ec158bf4e4054d040a3b951574b60608c2dc9ba537659d5dbeaae9d44be3), [claim](https://sepolia.basescan.org/tx/0xdae866e91d2e919c45eca953b24fee57e6d7feaeec0a15232010bab5a20969a8), sends [2 USDC](https://sepolia.basescan.org/tx/0x860961404838b1daa902aba6cc9062344e77f31a33c73483f9a3ea0b4c030b27) and [1 USDC](https://sepolia.basescan.org/tx/0xaabbab24627be7ad39c5ef0361d07b418ab256b1090b2b31e75f02edfff11ecc) |
| ZEC ⇄ BTC: a swap, a refund, a penalty, a swap refused for too little shielded ZEC, and a privacy check with a control run | **Local:** Bitcoin regtest and Zcash regtest (Zebra + Zaino) | **Real** shielded notes; every ZEC transaction checked: 0 transparent, 0 Sapling, 0 Orchard parts | Run `infra/e2e-real.sh` (about 10 minutes). The 2026-10-19 run's ZEC transactions are listed in the [README](../README.md#nothing-unshielded-enforced-and-tested) |
| ZEC ⇄ USDC: a swap, a refund, a penalty | **A fork of Base Sepolia** (see below), with Circle's test USDC contract | Stand-in chain | Run `infra/evm-testnet.sh fork test` |
| ZEC ⇄ LTC; ZEC ⇄ USDC on anvil; the watchtower; private routes (coin → shielded ZEC → coin) | **Local:** Litecoin or Bitcoin regtest and anvil (a local test chain) | Stand-in chain | Run `CHAIN=ltc infra/regtest.sh test`, the daemon tests (`crates/ferryd/tests/`), the watchtower tests (`crates/ferry-watchtower/tests/`), the `ferry-route` tests and FerryLock's Foundry tests (`contracts/test/`) |

- **A fork** is a private copy of a real chain on our machine. The contracts and balances are the
  real ones, but nothing done there reaches the real network.
- **The stand-in Zcash chain** is ferryd's mock Zcash backend (`--zec mock`,
  `crates/ferryd/src/mock_zec.rs`): a file both daemons share. A sweep still has to use the
  right joint key, but there are no real notes, no encryption and no real blocks.
- **Timing of the first live swap:** the ZEC seller had its USDC about 2 minutes after the start, and the
  buyer's ZEC arrived at about 7 minutes. Test networks ask for 3 Zcash confirmations; mainnet asks
  for 10 (about 12.5 minutes).

## Not run yet

- **No ZEC → LTC sell on Litecoin testnet.** One LTC → ZEC buy has completed there (2026-10-23).
  A sell makes the same transactions (B locks, Z redeems); only who starts the swap changes.
- **Refund and penalty live.** They ran on regtest (Bitcoin, Litecoin) and on the Base Sepolia
  fork, not on a public test network.
- **Ethereum, Arbitrum and Optimism.** ferryd has safety settings for them
  (`crates/ferry-core/src/evm/params.rs`), but no swap has run on them or on their test networks.
  The node installer and the public demo offer Base only.
- **Nothing on mainnet** (next sections).
- **NEAR Intents with real funds.**
- **No partner run by anyone outside the team** (`infra/node/makers.txt` lists none).

## The public demo

Set up by `infra/deploy` ([DEPLOY.md](DEPLOY.md)). <!-- add the demo URL here once it is live -->

- **Test coins only:** Bitcoin signet and Zcash testnet, and, if the operator turns them on,
  Litecoin testnet and Base Sepolia.
- **We run both sides, on one server.** Each pair has two Ferry daemons: B, the partner, and Z,
  the side a visitor's clicks drive. Both hold our test coins. So the demo shows a swap working; it
  is not two strangers trading. The operator sees every swap.
- **One partner per pair, ours, at a fixed demo rate,** not a market price (`PRICE_FEED=off` in
  `infra/deploy/.env.example`).
- **Limits:** 0.5 ZEC per swap, 3 swap starts per IP address per hour, 12 per hour in all
  (`web/server/prod.mjs`, `infra/deploy/docker-compose.yml`). Several swaps can run on a pair at
  once: each daemon takes up to 4 (ferryd's test-network default) as far as its test coins go, and
  answers "busy" past that. Up to three at once have run through the server deploy on Base
  Sepolia, with real shielded notes; four at once has not run.
- **Closed to outside nodes:** the partner's peer port is private, so another person's Ferry can't
  swap with it yet ([DEPLOY.md](DEPLOY.md#9-firewall)).
- **NEAR Intents: prices only.** The swap card can show real, read-only quotes from NEAR's 1Click
  API, but the demo never runs a NEAR swap.
- **Wallet page: balances only.** Add funds and Send to my wallet are refused there (HTTP 403),
  because the coins are the operator's.

## Your own node

`./infra/node/ferry up` runs Ferry on your computer, on test networks by default
([RUN-A-NODE.md](RUN-A-NODE.md)).

- **Until outside partners are listed, your node swaps between its own two wallets** (one Z and
  one B per pair). It runs the whole swap on real test networks, but you are on both sides.
- **The Wallet page works here only.** Add funds (the address, a QR code, and Pay with MetaMask for
  USDC, WETH or ETH) and Send to my wallet need `FERRY_OWN_NODE=1` and a page opened on
  127.0.0.1 (`web/server/prod.mjs`, `web/server/own.mjs`). On 2026-10-26 a fresh node was funded
  at the addresses its Add funds sheet shows, ran a swap, and sent test USDC out twice through Send
  to my wallet ([above](#what-has-run-and-where)). Pay with MetaMask has been tested against the mock
  daemons only (`web/mock/`).
- **The watchtower is not started for you.** You run it yourself ([WATCHTOWER.md](WATCHTOWER.md)).

## Mainnet

- **No swap has run on mainnet,** and there is no Ferry contract on Base mainnet yet.
- **The 0.02 ZEC cap.** `./infra/node/ferry --mainnet` asks you to type `MAINNET`, runs only
  Zcash and Base (USDC and WETH), and caps every swap at 0.02 ZEC (`infra/node/ferry`). The cap is
  set by that script (the app's limit and the node's own partners' offers). It is not built into
  ferryd: a ferryd started by hand has no cap.
- **Why the cap:** the cross-chain proof is unaudited
  ([Known limits](THREAT-MODEL.md#the-cross-chain-proof-is-unaudited)).
- **Bitcoin and Litecoin are not offered on mainnet**: their prepared transactions use fixed fees.
  A fee bump (off by default) has run on regtest only and has had no outside review
  ([Known limits](THREAT-MODEL.md#fixed-fees-on-prepared-bitcoin-transactions-so-bitcoin-and-litecoin-stay-on-test-networks)).

## NEAR Intents

- **What it adds.** When you sell ZEC, the Ferry swap can pay the coin it gets (USDC, say)
  straight into a NEAR Intents deposit address, and NEAR Intents turns it into another asset on
  another chain ([THREAT-MODEL.md](THREAT-MODEL.md#paying-out-to-another-address-payout_to-near-intents)).
- **Ferry never sends ZEC to NEAR Intents.** Its ZEC deposit addresses are transparent
  ([below](#why-not-near-maya-or-thorchain-for-the-zec-side)).
- **Mainnet only**, because NEAR's 1Click API has no test network. Off on the public demo (prices
  only). Off on a mainnet node unless you add `--near`.
- **What has run:** the whole flow against a mock of 1Click (`web/mock/oneclick.mjs`), on local
  test chains. The real 1Click has been used read-only: its token list and its signed price
  quotes. Never with real funds.
- **Its leg is public**, on both chains and on NEAR.

## What is mocked in development

| Mock | Stands in for | Used by | What is real |
|---|---|---|---|
| `web/mock/server.mjs` | Two Ferry daemons and their chains (a simulated Bitcoin and a simulated Zcash) | `cd web && pnpm dev` | The app itself; the same API as ferryd ([API.md](API.md)). No cryptography and no real chain |
| `web/mock/makers.mjs` | A list of partners (Kestrel, Heron OTC, Sandpiper, Egret and others) | `pnpm dev` | Nothing: these partners do not exist |
| `web/mock/router.mjs` | `ferry-route` (private routes) | `pnpm dev` | Nothing |
| `web/mock/oneclick.mjs` | NEAR Intents' 1Click API | `pnpm dev` | Real asset ids; fixed prices; its own signing key |
| `web/mock/wallet.mjs` | The node's wallet (Add funds, Send to my wallet) | `pnpm dev` | Nothing |
| ferryd `--zec mock` (`crates/ferryd/src/mock_zec.rs`), the stand-in Zcash chain | Zcash | The default in `infra/regtest.sh`; the daemon tests (`crates/ferryd/tests/`) and the fork rehearsal (`infra/evm-testnet.sh fork`). It is also ferryd's default when `--zec` is not given | The real ferryd and real Bitcoin, Litecoin or anvil chains. `ZEC_BACKEND=devtool` runs real shielded notes instead (`infra/e2e-real.sh` does) |
| `MockUSDC`, `MockWETH` (`contracts/src/`) | USDC and WETH | The anvil tests (`crates/ferry-evm/tests/`, `crates/ferryd/tests/evm_daemons.rs`) and FerryLock's Foundry tests | The real FerryLock contract and ferryd |
| anvil fork | Base Sepolia | `infra/evm-testnet.sh fork` | Real contracts and state copied from the chain; nothing reaches the real network |

## Why not NEAR, Maya or THORChain for the ZEC side?

The track asks for swaps that reach other chains "without unshielding on the way through". We
checked the routes people use today, on 2026-10-21. Each of them takes ZEC out of the shielded
pool, or puts someone in the middle who sees both sides. These are facts about how each one works
today, not a judgement of the projects.

- **NEAR Intents.** NEAR's docs list Zcash as "Partially supported - Transparent addresses only"
  ([chain support](https://docs.near-intents.org/resources/chain-support)), and its ZEC treasury is
  a transparent address, `t1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML`
  ([treasury addresses](https://docs.near-intents.org/security-compliance/treasury-addresses)).
  On 2026-10-20 the ZEC deposit address the live 1Click API gave us was transparent too.
- **Zodl's swap** sends ZEC to the deposit address in NEAR's quote
  ([RequestSwapQuoteUseCase.kt](https://github.com/zodl-inc/zodl-android/blob/main/ui-lib/src/main/java/co/electriccoin/zcash/ui/common/usecase/RequestSwapQuoteUseCase.kt)),
  and its code treats that address as transparent or TEX
  ([NearSwapDataSource.kt](https://github.com/zodl-inc/zodl-android/blob/main/ui-lib/src/main/java/co/electriccoin/zcash/ui/common/datasource/NearSwapDataSource.kt)).
  Paying a TEX address from shielded funds still unshields: the wallet "MUST create two
  transactions: one that unshields the funds to an ephemeral transparent address, and one that
  spends from that ephemeral address to the destination TEX Address"
  ([ZIP 320](https://zips.z.cash/zip-0320)).
- **Maya Protocol** accepts shielded senders, but the value goes to a transparent `t1…` vault
  address and only a zero-value shielded note carries the memo
  ([SwapKit's Zcash guide](https://docs.swapkit.dev/spotlights/chain-specific-guides/zcash-shielded-and-unified-addresses)).
  Its shielded payouts "use all-zero OVK, so both amount and memo from Sapling/Orchard notes are
  public (recoverable)" ([Maya merge request !625](https://gitlab.com/api/v4/projects/mayachain%2Fmayanode/merge_requests/625)).
- **THORChain.** Its Zcash client "Supports transparent and TEX addresses" and "Shielded payments
  are not supported"
  ([README](https://gitlab.com/thorchain/thornode/-/raw/develop/bifrost/pkg/chainclients/utxo/zcash/README.md)).
  All six of its ZEC vault addresses start with `tex1`
  ([vaults](https://gateway.liquify.com/chain/thorchain_api/thorchain/vaults/asgard)). When we
  checked on 2026-10-21, ZEC trading was halted (`HALTZECTRADING` = 1,
  [mimir](https://gateway.liquify.com/chain/thorchain_api/thorchain/mimir)).
- **Bridges run by a group of signers** (THORChain's and Maya's vaults, NEAR's bridge) hold the
  ZEC at transparent addresses, as above.
- **Exchanges and swap services** hold your coins during the trade and see both sides of it. Most
  large exchanges take ZEC at transparent addresses only; ZecHub's list shows BitcoinVN with
  shielded deposits and withdrawals and Gemini with shielded withdrawals
  ([ZecHub](https://zechub.wiki/using-zcash/custodial-exchanges)).

**What Ferry does instead.** The ZEC moves from one shielded note to another and never touches a
transparent address (`infra/e2e-real.sh` checks every ZEC transaction for this). Nobody holds
both coins. On Zcash, only the
partner can see the trade. The other chain is public as usual: on Base every step is visibly a
Ferry swap.
NEAR Intents stays useful for reach: Ferry uses it only for the other coin. What Ferry gives up in
return is in [Known limits](THREAT-MODEL.md#known-limits).

## Known limits

In [THREAT-MODEL.md](THREAT-MODEL.md#known-limits), each with what Ferry does about it and what is
still open:

- a partner must be online with the other coin;
- the second side to lock holds a free option, and no chain can fine whoever walks away;
- swaps take minutes;
- fees are paid on both chains;
- B must refund within its window, or run its own watchtower;
- if B vanishes after Z locks, Z is paid in B's coin and the ZEC stays locked in the joint address;
- the cross-chain proof is Serai's experimental code, outside Serai's audit, so mainnet is capped;
- prepared Bitcoin transactions use fixed fees, so Bitcoin and Litecoin stay on test networks.
