# What is real and what is a mock

For judges. Every claim here points to a file in this repository or to a public source. Checked
against the code on 2026-10-21.

Two words used throughout: **Z** holds the ZEC, **B** holds the other coin (BTC, LTC, USDC or
WETH). B always locks first.

## In short

- **Real:** the protocol and all of its code. One live swap on public test networks: ZEC ⇄ USDC on
  Base Sepolia and Zcash testnet, on 2026-10-20. A full local run with real shielded ZEC on
  Bitcoin regtest, covering the swap, the refund and the penalty.
- **Test coins only.** No swap has run on mainnet. The node's mainnet mode is capped at 0.02 ZEC
  per swap, and the mainnet demo is on hold.
- **One partner per pair, run by us.** On the public demo we run both sides on one server. No
  outside partner is listed yet.
- **Not run yet:** a public Bitcoin signet swap, a Litecoin testnet swap, WETH on a public network,
  anything on mainnet, and NEAR Intents with real funds.
- **Mocks** are used for local development and some demo scripts. Each is listed
  [below](#what-is-mocked-in-local-demos).

The costs of the design (a partner must be online, free options, waiting, fees, deadlines, an
unaudited proof) are in [THREAT-MODEL.md, "Known limits"](THREAT-MODEL.md#known-limits).

## What has run, and where

We ran both sides of every swap below.

| What ran | Where | Zcash side | Evidence |
|---|---|---|---|
| ZEC ⇄ USDC, one swap that completed (0.05 test ZEC for 2 test USDC) | **Public test networks:** Base Sepolia and Zcash testnet, run from our machine with `infra/evm-testnet.sh` | **Real** shielded notes | [log](evidence/evm-base-sepolia-live-2026-10-20.txt); on Base Sepolia: [FerryLock](https://sepolia.basescan.org/address/0x74b775EA7Bc7a2b2688b7A72Da5dee674BBd65Ef), [lock](https://sepolia.basescan.org/tx/0xeac4a050a97702fbca0fb1cf8ad8d4f965549e0612c62e0d85d233182fa926bb), [claim](https://sepolia.basescan.org/tx/0xde25c161c7e9b978de9aed580d12b0530813a460dd543124fbfc345978996aad) |
| ZEC ⇄ BTC: a swap, a refund, a penalty, a swap refused for too little shielded ZEC, and a privacy check with a control run | **Local:** Bitcoin regtest and Zcash regtest (Zebra + Zaino), `infra/e2e-real.sh` | **Real** shielded notes; every ZEC transaction checked: 0 transparent, 0 Sapling, 0 Orchard parts | [log](evidence/e2e-real-regtest-2026-10-19.txt) |
| ZEC ⇄ USDC: a swap, a refund, a penalty | **A fork of Base Sepolia** (see below), with Circle's test USDC contract | Stand-in chain | [log](evidence/evm-base-sepolia-fork-2026-10-20.txt) |
| The mainnet demo: sell ZEC, its USDC paid into NEAR Intents, which delivers SOL; plus a NEAR refund and a Ferry refund | **A fork of Base mainnet**, with Circle's USDC contract, under Ferry's Base mainnet rules | Stand-in chain; NEAR Intents mocked for deposits, real for read-only price quotes | [log](evidence/mainnet-demo-fork-2026-10-20.txt) |
| ZEC ⇄ LTC, ZEC ⇄ WETH, the watchtower, private routes (coin → shielded ZEC → coin) | **Local:** Litecoin or Bitcoin regtest and anvil (a local test chain) | Stand-in chain | `infra/demo-ltc.sh`, `infra/evm-demo.sh` (`TOKEN=weth`), `infra/demo-watchtower.sh`, `infra/route-demo.sh`; no saved log |

- **A fork** is a private copy of a real chain on our machine. The contracts and balances are the
  real ones, but nothing done there reaches the real network.
- **The stand-in Zcash chain** is ferryd's mock Zcash backend (`--zec mock`,
  `crates/ferryd/src/mock_zec.rs`): a file both daemons share. A sweep still has to use the
  right joint key, but there are no real notes, no encryption and no real blocks.
- **Timing of the live swap:** the ZEC seller had its USDC about 2 minutes after the start, and the
  buyer's ZEC arrived at about 7 minutes. Test networks ask for 3 Zcash confirmations; mainnet asks
  for 10 (about 12.5 minutes).

## Not run yet

- **No public Bitcoin signet swap has completed.** Our signet partner is still waiting for enough
  signet coins. Bitcoin has run only on regtest.
  <!-- update this line if the public signet swap runs before release -->
- **No Litecoin testnet swap.** Litecoin has run only on regtest, with the stand-in Zcash chain.
- **No WETH swap on a public network.** WETH has run on anvil only.
- **Refund and penalty on Base Sepolia** ran on the fork, not live.
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
  answers "busy" past that. Two at once, and a third refused as busy, have run on regtest Bitcoin
  with the stand-in Zcash chain (`crates/ferryd/tests/two_daemons.rs`), not yet on the demo's
  public test networks or with real shielded notes.
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
  127.0.0.1 (`web/server/prod.mjs`, `web/server/own.mjs`). They have been tested against the mock
  daemons and a stand-in browser wallet (`web/scripts/shoot-wallet.mjs`). We have no recorded run
  that moved real test coins through them yet.
- **The watchtower is not started for you.** You run it yourself ([WATCHTOWER.md](WATCHTOWER.md)).

## Mainnet

- **No swap has run on mainnet.**
- **The mainnet demo is prepared and on hold.** The plan is one small sell (0.01 ZEC, at most
  0.02) through NEAR Intents ([MAINNET-DEMO.md](MAINNET-DEMO.md)). It has been rehearsed on a fork
  of Base mainnet ([log](evidence/mainnet-demo-fork-2026-10-20.txt)). There is no Ferry contract
  on Base mainnet yet. <!-- update if the mainnet demo runs before release -->
- **The 0.02 ZEC cap.** `./infra/node/ferry --mainnet` asks you to type `MAINNET`, runs only
  Zcash and Base (USDC and WETH), and caps every swap at 0.02 ZEC (`infra/node/ferry`). The cap is
  set by that script and by `infra/mainnet-demo.sh` (the app's limit and the node's own partners'
  offers). It is not built into ferryd: a ferryd started by hand has no cap.
- **Why the cap:** the cross-chain proof is unaudited
  ([Known limits](THREAT-MODEL.md#the-cross-chain-proof-is-unaudited)).
- **Bitcoin and Litecoin are not offered on mainnet**: their prepared transactions use fixed fees
  ([Known limits](THREAT-MODEL.md#fixed-fees-on-prepared-bitcoin-transactions-so-bitcoin-and-litecoin-stay-on-test-networks)).

## NEAR Intents

- **What it adds.** When you sell ZEC, the Ferry swap can pay the coin it gets (USDC, say)
  straight into a NEAR Intents deposit address, and NEAR Intents turns it into another asset on
  another chain ([THREAT-MODEL.md](THREAT-MODEL.md#paying-out-to-another-address-payout_to-near-intents)).
- **Ferry never sends ZEC to NEAR Intents.** Its ZEC deposit addresses are transparent
  ([below](#why-not-near-maya-or-thorchain-for-the-zec-side)).
- **Mainnet only**, because NEAR's 1Click API has no test network. Off on the public demo (prices
  only). Off on a mainnet node unless you add `--near`.
- **What has run:** the whole flow against a mock of 1Click (`web/mock/oneclick.mjs`), on anvil
  and on the fork of Base mainnet. The real 1Click has been used read-only: its token list and
  its signed price quotes. Never with real funds.
- **Its leg is public**, on both chains and on NEAR.

## What is mocked in local demos

| Mock | Stands in for | Used by | What is real |
|---|---|---|---|
| `web/mock/server.mjs` | Two Ferry daemons and their chains (a simulated Bitcoin and a simulated Zcash) | `cd web && pnpm dev`, the screenshot scripts (`web/scripts/shoot-*.mjs`), `pnpm film --mock` | The app itself; the same API as ferryd ([API.md](API.md)). No cryptography and no real chain |
| `web/mock/makers.mjs` | A list of partners (Kestrel, Heron OTC, Sandpiper, Egret and others) | `pnpm dev`, screenshots | Nothing: these partners do not exist. Screenshots under `web/screenshots/` show them |
| `web/mock/router.mjs` | `ferry-route` (private routes) | `pnpm dev` | Nothing |
| `web/mock/oneclick.mjs` | NEAR Intents' 1Click API | `pnpm dev`, the mainnet fork rehearsal | Real asset ids; fixed prices; its own signing key |
| `web/mock/wallet.mjs` | The node's wallet (Add funds, Send to my wallet) | `pnpm dev`, `shoot-wallet.mjs` | Nothing |
| ferryd `--zec mock` (`crates/ferryd/src/mock_zec.rs`), the stand-in Zcash chain | Zcash | The default in `infra/demo.sh` and `infra/demo-ltc.sh`; always in `infra/evm-demo.sh`, `infra/route-demo.sh`, `infra/demo-watchtower.sh` and the two fork rehearsals. It is also ferryd's default when `--zec` is not given | The real ferryd and real Bitcoin, Litecoin or anvil chains. `ZEC_BACKEND=devtool` runs real shielded notes instead (`infra/e2e-real.sh` does) |
| `MockUSDC`, `MockWETH` (`contracts/src/`) | USDC and WETH | `infra/evm-demo.sh` on anvil | The real FerryLock contract and ferryd |
| anvil forks | Base Sepolia, Base mainnet | `infra/evm-testnet.sh fork`, `infra/mainnet-demo.sh fork` | Real contracts and state copied from the chain; nothing reaches the real network |

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
transparent address (the regtest run checks every ZEC transaction for this:
[log](evidence/e2e-real-regtest-2026-10-19.txt)). Nobody holds both coins. On Zcash, only the
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

## For the submission form

Paste-ready (plain text):

<!-- update after many-swaps / safer-settings merge, the signet swap or the mainnet demo -->

```text
What is real
- The protocol and all of its code: shielded ZEC is locked to a key split between the two
  parties, and claiming the other coin reveals the missing half. Nobody holds both coins, and
  the ZEC never leaves the shielded pool.
- One live swap on public test networks, on 2026-10-20: 0.05 test ZEC (Zcash testnet) for 2 test
  USDC on Base Sepolia. Lock: https://sepolia.basescan.org/tx/0xeac4a050a97702fbca0fb1cf8ad8d4f965549e0612c62e0d85d233182fa926bb
  Claim: https://sepolia.basescan.org/tx/0xde25c161c7e9b978de9aed580d12b0530813a460dd543124fbfc345978996aad
- A full local run with real shielded ZEC on Bitcoin regtest: a swap, a refund, a penalty and a
  privacy check. Every ZEC transaction had 0 transparent, 0 Sapling and 0 Orchard parts.

What is a mock or not done yet
- Test coins only. No swap has run on mainnet. The node's mainnet mode caps each swap at
  0.02 ZEC, because the cross-chain proof (Serai's experimental DLEQ) is unaudited. Our small
  mainnet demo is rehearsed on a fork of Base mainnet and on hold.
- One partner per pair, run by us. On the public demo we run both sides on one server.
- No public Bitcoin signet or Litecoin testnet swap has completed yet: Bitcoin and Litecoin have
  run on regtest only. Refund and penalty on Base Sepolia ran on a fork, not live.
- NEAR Intents is mainnet-only and off on the demo (prices only). It has run against a mock of
  NEAR's API, never with real funds. Ferry never sends ZEC to NEAR Intents.
- The Wallet page's Add funds and Send to my wallet work only on your own node.
- Several swaps at once (up to 4 per node on test networks, 2 on mainnet): run on regtest Bitcoin
  with the stand-in Zcash chain, not yet on a public test network or with real shielded notes.
- Local development (pnpm dev), the screenshots and several demo scripts use mock daemons, made-up
  partners or a stand-in Zcash chain.

Details and evidence: docs/WHAT-IS-REAL.md. Known limits: docs/THREAT-MODEL.md.
```
