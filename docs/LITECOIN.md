# Litecoin as the counter-chain (ZEC ↔ LTC)

Ferry's BTC leg runs unchanged on Litecoin. Litecoin Core ≥ 0.21.2 activated Taproot (with
MWEB). Its transaction format, BIP340 Schnorr, BIP341/342 sighash and Tapscript rules match
Bitcoin's. So the lock, MuSig2 key-path redeem with adaptor signature, and the
cancel/refund/punish script leaves are byte-for-byte the same transactions. rust-bitcoin's
`Transaction`, `ScriptBuf` and `Address` types work for both chains.

## Go/no-go spike (2026-10-19): GO

Node: `uphold/litecoin-core:0.21` pinned by digest (Litecoin Core v0.21.5.6), regtest, via
`infra/ltc/regtest.sh start` (container `ferry-ltc-regtest`, RPC `127.0.0.1:19443`,
`ferry`/`ferry`). Taproot is `active` from block 0 on regtest. The script activates MWEB as on
mainnet (see below).

The existing full-swap regtest tests (`crates/ferry-core/tests/regtest.rs`, real node plus mock
ZEC leg) run against litecoind with `FERRY_CHAIN=ltc`:

```
infra/ltc/regtest.sh start
FERRY_CHAIN=ltc cargo test -p ferry-core --test regtest -- --ignored --test-threads=1 --nocapture
FERRY_CHAIN=ltc cargo test -p ferry-btc --test regtest_rpc -- --ignored --nocapture
```

All 4 swap tests and the RPC/watch-wallet test pass. Each run was done once before MWEB
activation and once after it (height 432+). The run below is with MWEB active (`litecoind
getrawtransaction`):

| path | tx | txid | witness |
|---|---|---|---|
| happy, key path | lock → `rltc1pgmw8…` | `f5d6e5b7aa2d31877adfbe0d0899b903818574304bdb1afe7653fc18d46815aa` | |
| | redeem (MuSig2 adaptor) | `9d84e705570fd90f196c56b5b62e54d50730f0aa1ca0b817fe26edd82f4229b4` | 1 item, 64 B |
| happy, script path | redeem leaf | `1c0ef21b5a637317847df58105ab02b784146d4c9812d1062672907a548d7fd5` | sig, sig, leaf, control |
| refund | cancel (CSV 12) | `8c6a64f067b7b9aafa19af62edd17f37cf8d67607951999c95c2c29ce1d1466c` | sig, sig, leaf, control |
| | refund | `ab9382de60ab323130ab8f361b1e502da8628a1817d8cd325a6a612ac096c136` | sig, sig, leaf, control |
| punish | cancel (CSV 12) | `e1129ab138c2cd16302119ae4929370c0bc99e10a27b20785f5e7fc36612282b` | sig, sig, leaf, control |
| | punish (CSV 12) | `49c22e8950d606a170964950f8f431dcbd00f55df189d39753db7be84a81c506` | sig, leaf, control |

Secret extraction works the same way. On the happy path B recovers `z` from the key-path
redeem signature and the mock ZEC leg accepts the sweep only if `ask·SpendAuthG == ak`. On the
refund path Z recovers `b` from the refund witness and reclaims. The punish path pays Z after
T2 and nobody sweeps.

## What differs from Bitcoin (measured, not assumed)

| | Bitcoin | Litecoin (Core 0.21.5.6) |
|---|---|---|
| segwit hrp | `bc` / `tb` / `bcrt` | `ltc` / `tltc` / `rltc` |
| base58 P2PKH / P2SH | `0x00`/`0x05`, test `0x6f`/`0xc4` | `0x30` (L) / `0x32` (M, legacy `0x05` accepted), test `0x6f` (m/n) / `0x3a` (Q) |
| Taproot payouts from the wallet | `getnewaddress "" bech32m` | **no `bech32m` type**. The wallet pays to and validates `rltc1p…` but cannot make one, so Ferry asks for `bech32` (P2WPKH) |
| watch-only wallet | descriptor wallet + `importdescriptors` | **"Descriptor wallets not supported"**. Ferry uses a legacy blank watch-only wallet + `importmulti` |
| dust (`testmempoolaccept`) | P2TR 330, P2WPKH 294, P2PKH 546 | **10×**: P2TR 3300, P2WPKH 2940, P2PKH 5460 (`-dustrelayfee` 30 lit/vB) |
| min relay fee | 1 sat/vB | 1 lit/vB |
| fee bump (`ferryd --bump on`) | `submitpackage` (Core 28), replacement on by default | **no `submitpackage`** (only a one-transaction `testmempoolaccept`); **`-mempoolreplacement` is 0 by default**: a valid replacement is refused as `txn-mempool-conflict` (measured), so a child can be sent once but not replaced unless litecoind runs with `-mempoolreplacement=1` |
| block time | 600 s | 150 s |
| unit | sat | litoshi (`lit`) |
| MWEB | n/a | MWEB addresses (`ltcmweb1…`, `tmweb1…`) have no scriptPubKey and are rejected as payout addresses |

**MWEB activation on regtest.** MWEB locks in by BIP9 signalling at block 431. After that
every block needs a HogEx transaction. The first HogEx needs a peg-in, so `generatetoaddress`
fails with `bad-txns-vin-empty` until something is sent to an MWEB address.
`infra/ltc/regtest.sh start` mines the 431 blocks, pegs in 1 LTC and mines one more block. Set
`FERRY_LTC_NO_MWEB=1` to skip this. Ferry's transactions are ordinary canonical-chain
transactions and are not affected by MWEB.

## Code

`ferry_btc::chain` holds the `Coin` (`btc` | `ltc`) and the `Chain` (coin + rust-bitcoin
`Network` tier). It provides the following:

- `encode_address` / `parse_address`: text ↔ `Address` with the right hrp and base58 versions.
  Inside Ferry, a Litecoin address is a rust-bitcoin `Address` of the same tier (mainnet =
  `Network::Bitcoin`), so all network checks keep working.
- `dust_limit()`, `default_confirmations()`, `block_time_secs()`, `ticker()`, `base_unit()`,
  `wallet_address_type()`.

`BitcoinRpc::with_coin(Coin::Ltc)` makes the RPC client write and read node addresses in
Litecoin form, request `bech32` wallet addresses and use the legacy watch-only wallet. Every
other RPC call is identical on litecoind.

## ferryd, demo and UI

- **Parameters.** `SwapParams` carries `coin` (serde default `btc`, omitted from the JSON for
  BTC, so BTC swaps hash into the transcript exactly as before). An LTC `Propose` therefore
  binds the coin into the transcript. A peer that predates the field drops it and gets a
  transcript mismatch, so it fails safe. `SwapParams::validate` rejects LTC on signet and
  amounts below the coin's P2PKH dust (BTC 546, LTC 5460).
- **Transactions.** `SwapTxs::new(coin, …)` checks every output against that coin's dust for
  its own script type (`Coin::dust`, i.e. Core's `GetDustThreshold` at 3 or 30 sat/vB).
- **Policy.** `Policy::for_chain` keeps BTC's minimums in wall-clock terms on the faster chain:
  Δ ×4 and lock/cancel confirmations ≥ the chain default (LTC mainnet 8, testnet 2). `--dev-policy`
  on regtest is unchanged.
- **ferryd.** `--chain ltc` (default `btc`) points the `--btc-*` options at litecoind. The
  offer and status report `ZEC/LTC`, and a taker and maker on different coins refuse each other
  (`the counterparty swaps ZEC/LTC, we swap ZEC/BTC`). The daemon's narration still says
  "BTC"; the view layer swaps whole words (`BTC`, `Bitcoin`, `sat`) for the coin's when it serves
  timeline labels and observer lines.
- **Local stack.** `CHAIN=ltc infra/regtest.sh up` runs the whole stack against litecoind regtest: container `ferry-litecoind`, RPC `127.0.0.1:19643`, MWEB activated first.
- **UI.** `web/src/format.ts` `coin()` holds the daemon's coin (set from `/api/status`); every
  BTC/Bitcoin/sat label in the app and the inspector reads from it.
- **Watchtower.** `ferry-watchtower --chain ltc` follows litecoind. Packages carry `"coin": "ltc"`
  and their payout addresses in Litecoin's encoding, and a tower refuses a package for the other
  coin. Since Litecoin Core 0.21 has no descriptor wallets, the tower watches the swap through a
  blank legacy watch-only wallet (`importmulti`), which also works without `-txindex`.
  `ferryd --chain ltc --watchtower …` arms it with the Bitcoin rules unchanged: B only with
  `--watchtower-own`, and no redeem adaptor once the ZEC lock note is spent.
  `FERRY_CHAIN=ltc cargo test -p ferry-watchtower --test regtest -- --ignored --test-threads=1`
  runs the tower's regtest tests (refund, punish, redeem) against litecoind regtest with MWEB and
  no `-txindex`. Details in [WATCHTOWER.md](WATCHTOWER.md#litecoin).

Wire note: the payout addresses inside `Setup` messages stay in rust-bitcoin's text form
(`bcrt1…`) for either coin. They are typed scriptPubKeys between two Ferry daemons. Litecoin
encoding is used only toward the node, the API and the UI.
