# Deploying the Ferry testnet demo

To run Ferry for yourself on your own computer instead, see [RUN-A-NODE.md](RUN-A-NODE.md)
(`./infra/node/ferry up`).

This guide takes you from a fresh clone of the repository to the public demo running on one Linux
server. The demo uses test coins only. It always runs ZEC/BTC:

- a pruned **Bitcoin signet** node (`bitcoind`)
- the two swap parties, each a `ferryd` daemon on **Zcash testnet**: **B** ("bram", the maker,
  holds BTC) and **Z** ("zoe", the taker, holds ZEC)
- the **web** UI
- **Caddy** for HTTPS

and, if you turn them on, more pairs (section 7): **ZEC/LTC** on the Litecoin test network,
**ZEC/USDC** and **ZEC/WETH** on Base Sepolia. Each pair has its own maker B and taker Z, like
ZEC/BTC.

Everything is in `infra/deploy/` and runs with Docker Compose. You drive it from your own
machine over SSH with `infra/deploy/deploy.sh`.

```
            front            app                          chain
internet ──443──▶ caddy ──▶ web ──▶ ferryd-z :7101 ┐            ┌─▶ testnet.zec.rocks:443
                                 └─▶ ferryd-b :7102 ┴─ bitcoind ┘    (Zcash lightwalletd)
                                     ferryd-b :7112 (peer, for ferryd-z only)
           optional pairs, same shape:
                            web ──▶ ferryd-z-ltc ┐
                                    ferryd-b-ltc ┴─ litecoind (Litecoin testnet)
                            web ──▶ ferryd-z-usdc-base, ferryd-b-usdc-base ─┐
                            web ──▶ ferryd-z-weth-base, ferryd-b-weth-base ─┴─▶ Base Sepolia RPC
```

Only Caddy publishes ports. Three private networks separate Caddy from the web server, the web
server from the daemons, and the daemons from the nodes. Every container runs without Linux
capabilities (Caddy keeps only the right to bind 80/443), with `no-new-privileges` and a
read-only root filesystem.

Secrets stay off command lines and out of `docker inspect`:
- **node RPC passwords:** files (`infra/deploy/secrets/btc_rpc_pass`, `ltc_rpc_pass`) that the
  daemons read. The nodes only get their salted hashes (`rpcauth`).
- **Base Sepolia keys** (ZEC/USDC and ZEC/WETH only): created on the server, in
  `infra/deploy/secrets/`, never printed (section 7).
- **API tokens:** each daemon creates its token in its own small volume, which the web server
  mounts read-only. The web server adds the token to proxied requests itself, so it never reaches
  a browser.

## 1. Prerequisites

**Your machine** (macOS or Linux): `git`, `bash`, `ssh` with a key that logs in to the server,
`rsync`, and `python3` (`deploy.sh status` and `addresses` use it to format output).

**The server**:
- Ubuntu 22.04 or 24.04 on amd64, with **2 vCPU, 4 GB RAM and 30 GB disk** for ZEC/BTC alone. The
  first image build compiles Rust (zcash-devtool) for 20–40 minutes; on a 4 GB machine, add 2–4 GB
  of swap first. **With every pair on: 4 vCPU, 8 GB RAM and 50 GB disk** (the Litecoin node needs
  about 2 GB of memory while it syncs and 5–10 GB of disk; each pair adds two daemons).
- Docker Engine and the compose plugin (2.20 or newer), from Docker's apt repository
  (https://docs.docker.com/engine/install/ubuntu/), then
  `sudo usermod -aG docker $USER` and log in again. Check with `docker compose version`.
- `rsync` and `python3` (`sudo apt install rsync python3`; Ubuntu has python3 already).
- A DNS name whose A (and AAAA, if any) record points at the server. Caddy requests the HTTPS
  certificate for it on the first start.

No funds are needed to deploy. Wallets and keys are created on the server, and you fund them
afterwards from faucets.

## 2. Clone

```sh
git clone https://github.com/JemIIahh/ferry.git
cd ferry
```

Everything builds from this clone. The ferryd image clones zcash-devtool at a pinned revision and
applies `infra/patches/zcash-devtool-ferry.patch`, so there are no vendored sources or prebuilt
binaries to fetch.

## 3. First deploy

```sh
infra/deploy/deploy.sh <ssh-host>
```

`<ssh-host>` is whatever `ssh` accepts (`user@1.2.3.4`, or a `Host` alias from `~/.ssh/config`).
The first run:

1. copies the repository to `~/ferry` on the server with rsync. Everything git ignores stays on
   your machine (`--filter=':- .gitignore'`), and so do `.git`, build outputs, screenshots, spikes
   and the film.
2. creates `~/ferry/infra/deploy/.env` from `infra/deploy/.env.example`, and random bitcoind and
   litecoind RPC passwords in `~/ferry/infra/deploy/secrets/` (only `.env` gets their hashes).
   This is `infra/deploy/ctl secrets` on the server. Everything stays on the server, private to
   your user, and later deploys add what is missing but never overwrite it.
3. stops and asks you to set `DOMAIN`

Edit the file on the server:

```sh
ssh <ssh-host>
nano ~/ferry/infra/deploy/.env    # DOMAIN=demo.example.org
```

The other settings (the maker's rate and size limits, the swap timelocks, the demo guard, the
optional pairs) have working defaults and are explained in the file. The maker quotes the fixed
`RATE` by default. Set `PRICE_FEED=coingecko` (or `kraken`, `all`) to follow the live ZEC/BTC
price plus `SPREAD_BPS`; it pauses its offer if the feed fails for 5 minutes. The real price is
about 3x the demo `RATE`, so fund the maker with about 3x more signet BTC first. Then run the
deploy again:

```sh
infra/deploy/deploy.sh <ssh-host>
```

This builds both images (the long first build) and starts all five services.

## 4. Wait for the signet sync

The Bitcoin node syncs signet from scratch. **This takes hours**: about 3 h on a fast machine,
longer on a small VPS. Follow it with:

```sh
infra/deploy/deploy.sh <ssh-host> status
```

```
signet node  syncing: block 151234 of 326800 headers (23.10%)
ferryd Z  zoe: btc 0 sat  zec 0 zat  (zec test height 4508500)
ferryd B  bram: btc 0 sat  zec 0 zat  (zec test height 4508500)
```

The UI is up during the sync, but don't start swaps until the first line says `synced`: until
then ferryd can't see new Bitcoin transactions.

## 5. Fund the parties

```sh
infra/deploy/deploy.sh <ssh-host> addresses
```

This prints B's **signet** address and Z's **Zcash testnet** unified address (`utest1…`), then
the same for every enabled pair (section 7).

- Send signet sats to B, for example from https://signet.bc-2.jp. B needs the swap amount plus a
  little for fees; with the default rate (410 000 sat per ZEC), 0.5 ZEC needs about 205 000 sat.
- Send TAZ to Z from https://fauzec.com (1 TAZ a day). zcash-devtool only spends TAZ received
  from another wallet after **10 confirmations** (about 13 minutes), so fund Z first.

The balances show up in `status`, and in the UI once they confirm.

## 6. Smoke test

```sh
curl -fsS https://<DOMAIN>/healthz                  # {"ok":true}: Caddy, TLS and the web server
infra/deploy/deploy.sh <ssh-host> status            # both daemons answer; balances
```

Open `https://<DOMAIN>`: both parties' panels should be online with their balances. Once the node
is synced and both parties are funded, start a small swap (0.1 ZEC) from the UI. It takes about
an hour on signet (blocks every ~10 minutes). The default timelocks are T1 = 6 blocks and
T2 = 6 blocks after the cancel. If something stalls, the swap refunds by itself, which is the
protocol working.

The public UI is guarded by `web/server/prod.mjs`: visitors can only read status and start a swap
on a Z. Starts are capped at `DEMO_MAX_ZAT` (0.5 ZEC), one active swap at a time per pair,
`DEMO_RATE_PER_HOUR` per IP and `DEMO_SWAPS_PER_HOUR` across all visitors. These limits are shared
by every pair.

## 7. More pairs: ZEC/LTC, ZEC/USDC, ZEC/WETH (optional)

Each extra pair is a Docker Compose **profile**, off until you enable it:

| profile | pair | network | containers |
|---|---|---|---|
| `ltc` | ZEC/LTC | Litecoin public testnet (testnet4) | `litecoind` (pruned), `ferryd-b-ltc`, `ferryd-z-ltc` |
| `usdc-base` | ZEC/USDC | Base Sepolia (chain 84532), Circle's test USDC | `ferryd-b-usdc-base`, `ferryd-z-usdc-base` |
| `weth-base` | ZEC/WETH | Base Sepolia (chain 84532), WETH | `ferryd-b-weth-base`, `ferryd-z-weth-base` |

In every pair, B is the maker (it holds the LTC, USDC or WETH) and Z is the taker the public UI
drives (it holds TAZ). ZEC/BTC is unchanged and always runs.

The enabled pairs are `COMPOSE_PROFILES` in the server's `.env` (comma-separated). Change it with
`deploy.sh`, then deploy:

```sh
infra/deploy/deploy.sh <ssh-host> enable ltc        # or usdc-base, weth-base
infra/deploy/deploy.sh <ssh-host>                   # creates the pair's keys, builds, starts it
infra/deploy/deploy.sh <ssh-host> pairs             # which pairs are on
```

The deploy passes the enabled pairs on to the web server (through `infra/deploy/compose`): their
takers (`GET /api/pairs`) and their makers (`GET /api/makers`, with `chain: "base"` for USDC and
WETH), so the token picker offers them. A pair that is off isn't listed and shows as "not
available here"; nothing errors. If you set `FERRY_MAKERS` in `.env` yourself, list the enabled
pairs' makers in it too: `Demo maker (LTC)|http://ferryd-b-ltc:7112|ZEC/LTC`,
`Demo maker (USDC)|http://ferryd-b-usdc-base:7112|ZEC/USDC|base`,
`Demo maker (WETH)|http://ferryd-b-weth-base:7112|ZEC/WETH|base`.

Every pair's taker sells TAZ, so each enabled pair needs its own TAZ (fauzec.com gives 1 TAZ a
day): budget about 0.3 TAZ per Z for a few swaps at the default sizes.

`deploy.sh <ssh-host> addresses` prints, for each enabled pair, every address to fund, the
network, the amount (from the rates and sizes in `.env`) and the faucet. The defaults below are
what it asks for.

### 7.1 ZEC/LTC on the Litecoin testnet

1. **Enable and deploy:** `deploy.sh <ssh-host> enable ltc`, then `deploy.sh <ssh-host>`. This
   starts a pruned Litecoin Core 0.21.5.6 node (`-testnet -prune=2000`, data in the `litecoind`
   volume) and the two daemons (`--chain ltc --network testnet`).
2. **Wait for the sync.** The Litecoin testnet has about 4.9 million blocks (about 5 GB, pruned to
   2 GB on disk). Headers come first, then blocks: **expect several hours** (3–8 h on a small
   VPS). `deploy.sh <ssh-host> status` shows it:
   `ZEC/LTC  litecoin testnet node syncing: block 1203000 of 4928197 headers (24.10%)`. Don't
   start swaps until it says `synced`.
3. **Fund** (`deploy.sh <ssh-host> addresses`):
   - **B's Litecoin testnet address** (`tltc1q…`): at least **0.255 tLTC** (the largest swap,
     0.25 ZEC at the demo rate of 1 LTC per ZEC, plus fees); **about 1 tLTC** covers four. Litecoin
     testnet faucets come and go: search for "litecoin testnet faucet", or ask anyone holding
     tLTC. Send to the `tltc1` address only: Ferry refuses MWEB addresses (`tmweb1…`) and the
     wallet doesn't give out one. The node must be synced before it sees the coins.
   - **Z's Zcash testnet address** (`utest1…`): at least **0.2505 TAZ** (the largest swap plus
     fees), from https://fauzec.com.
4. **Limits.** A fixed demo rate (`LTC_RATE`, 1 LTC per ZEC, about 1/19 of the market in October
   2026) so faucet coins last; `LTC_PRICE_FEED=kraken|coingecko|all` follows ZEC/LTC instead.
   Swaps of 0.01 to 0.25 ZEC (`LTC_MIN_ZAT`, `LTC_MAX_ZAT`). Timelocks in Litecoin blocks of
   about 2.5 minutes: T1 = T2 = 24, Δ = 8, 2 lock and cancel confirmations (`LTC_T1` …), the same
   wall-clock windows as ZEC/BTC, and ferryd's Litecoin testnet policy minimum for Δ and the
   confirmations. A swap takes about 20–30 minutes. After a restart, litecoind takes several
   minutes to load its block index; until it answers, `ferryd-b-ltc` and `ferryd-z-ltc` restart
   on their own (their logs say `Loading block index…`).

### 7.2 ZEC/USDC on Base Sepolia

1. **Choose the RPC.** The daemons use `BASE_SEPOLIA_RPC` from `.env` (default
   https://sepolia.base.org). That public endpoint is shared and rate limited, and four daemons
   poll it every 4 seconds when both Base pairs are on, so use a provider's **Base Sepolia**
   endpoint, for example `BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/<key>` (Alchemy's
   free tier is enough). The URL ends up on the daemons' command lines (visible with
   `docker inspect` on the server), so use a key that serves only this.
2. **Enable and deploy:** `deploy.sh <ssh-host> enable usdc-base`, then `deploy.sh <ssh-host>`.
   The deploy creates two **fresh Base Sepolia accounts** on the server, for B and Z of this pair
   (`infra/deploy/secrets/usdc-base-{b,z}.*`: an encrypted keystore with its random password, the
   raw key ferryd reads, readable only by the daemons' uid, and the address). It runs `cast` from
   the pinned Foundry image `ghcr.io/foundry-rs/foundry:v1.5.1` with no network; no key is ever
   printed or put on a command line. The daemons use the FerryLock already deployed at
   `0x74b775EA7Bc7a2b2688b7A72Da5dee674BBd65Ef` and refuse to start unless its code is the
   FerryLock they were built with, and unless the token `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
   reports `USDC` and 6 decimals.
3. **Fund** (`deploy.sh <ssh-host> addresses`). Every faucet below must be set to **Base Sepolia**.
   **Not Ethereum Sepolia**: coins sent there never reach these accounts (this mistake has
   already happened once).
   - **B's account** (`0x…`): about **0.002 ETH** for gas, from the Coinbase CDP faucet
     (https://portal.cdp.coinbase.com/products/faucet, network Base Sepolia) or the Alchemy faucet
     (https://www.alchemy.com/faucets/base-sepolia). And at least **10 USDC** (the largest swap,
     0.25 ZEC at the demo rate of 40 USDC per ZEC); 40 USDC covers four. USDC comes from
     https://faucet.circle.com, network Base Sepolia.
   - **Z's account** (`0x…`): about **0.001 ETH** for gas (Z sends the claim), same faucets.
   - **Z's Zcash testnet address** (`utest1…`): at least **0.2505 TAZ**, from https://fauzec.com.
4. **Limits.** A fixed demo rate (`USDC_RATE`, 40 USDC per ZEC; `USDC_PRICE_FEED` follows
   ZEC/USDC instead), swaps of 0.01 to 0.25 ZEC. Deadlines as in `infra/evm-testnet.sh`: t1
   45 min after the proposal, refund window 30 min, Δ 5 min, 10 lock confirmations, logs read in
   200-block chunks (`EVM_*` in `.env`; docs/EVM.md, "Timing on a public chain"). A swap takes 5–10
   minutes. Circle can freeze test USDC, which would leave a lock in FerryLock until it lifts
   that (docs/EVM.md, "Trust in the token").

### 7.3 ZEC/WETH on Base Sepolia

Same as ZEC/USDC (same RPC, same FerryLock, its own two accounts in
`infra/deploy/secrets/weth-base-{b,z}.*`), with WETH at `0x4200000000000000000000000000000000000006`
(18 decimals):

1. **Enable and deploy:** `deploy.sh <ssh-host> enable weth-base`, then `deploy.sh <ssh-host>`.
2. **Fund** (`deploy.sh <ssh-host> addresses`; faucets on **Base Sepolia**, not Ethereum
   Sepolia):
   - **B's account**: about **0.014 ETH**: 0.002 for gas and 0.012 to wrap into WETH (four swaps of
     0.25 ZEC at the demo rate of 0.012 WETH per ZEC; one swap needs 0.003 WETH). ETH from the
     Coinbase CDP or Alchemy faucet as above.
   - **Z's account**: about **0.001 ETH** for gas.
   - **Z's Zcash testnet address**: at least **0.2505 TAZ**.
3. **Wrap B's ETH into WETH.** FerryLock holds ERC-20 tokens, not plain ETH, so B needs WETH:

   ```sh
   infra/deploy/deploy.sh <ssh-host> wrap-weth 0.012
   ```

   This calls WETH's `deposit()` from B's account with 0.012 ETH. It runs `cast` in the Foundry
   image with B's keystore (the key stays encrypted on disk), checks first that the RPC is chain
   84532 and the token says `WETH`, refuses if less than about 0.001 ETH would be left for gas, and
   prints B's ETH and WETH before and after. With a wallet of your own instead (for example
   Foundry on your machine), wrap there and send the WETH to B's address:

   ```sh
   cast send 0x4200000000000000000000000000000000000006 "deposit()" --value 0.012ether \
     --rpc-url https://sepolia.base.org --account <your keystore>
   cast send 0x4200000000000000000000000000000000000006 "transfer(address,uint256)" \
     <B's address> 12000000000000000 --rpc-url https://sepolia.base.org --account <your keystore>
   ```
4. **Limits.** A fixed demo rate (`WETH_RATE`, 0.012 WETH per ZEC; `WETH_PRICE_FEED` follows
   ZEC/ETH instead), swaps of 0.01 to 0.25 ZEC, the same deadlines as ZEC/USDC. ZEC/WETH has run
   on a local fork of Base Sepolia, not yet live.

### 7.4 Verify

```sh
curl -fsS https://<DOMAIN>/api/pairs     # {"pairs":["ltc","usdc-base","weth-base"]}: the enabled pairs
curl -fsS https://<DOMAIN>/api/makers | python3 -m json.tool
infra/deploy/deploy.sh <ssh-host> status
```

In `/api/makers`, each enabled pair's maker is listed with `"pair": "ZEC/LTC"` (or `ZEC/USDC`,
`ZEC/WETH` with `"chain": "base"`) and `"online": true`; `liquidity_zat` grows above 0 once B is
funded. `status` adds, per pair, the Litecoin node's sync, each daemon's balances (for Base: the
token, ETH for gas and ZEC) and its swaps. In the UI, the token picker then offers Litecoin, USDC
on Base and ETH on Base (WETH).

### 7.5 Turning a pair off

```sh
infra/deploy/deploy.sh <ssh-host> disable weth-base
infra/deploy/deploy.sh <ssh-host>
```

The deploy stops that pair's containers and the web server stops listing it. Its volumes, keys and
funds stay; enabling it again brings it back as it was. Let its swaps finish first (`status`).

## 8. Operations

```sh
infra/deploy/deploy.sh <ssh-host> logs              # everything; or: logs ferryd-z / ferryd-b / bitcoind / web / caddy
infra/deploy/deploy.sh <ssh-host> logs ferryd-b-ltc # a pair's daemon, or litecoind
infra/deploy/deploy.sh <ssh-host> down              # stop everything, every pair; volumes (wallets, chains, certificates) are kept
```

On the server itself, use `infra/deploy/compose` (from `~/ferry`) wherever you would type
`docker compose`: it is docker compose with this deployment's files and `.env`, and it tells the
web server which pairs are on. `infra/deploy/ctl help` lists the per-pair commands that
`deploy.sh` runs there (`pairs`, `enable`, `disable`, `secrets`, `addresses`, `status`,
`wrap-weth`, `rotate-tokens`).

**Update / redeploy**: `git pull` on your machine, then `infra/deploy/deploy.sh <ssh-host>`. It
re-syncs the code and rebuilds what changed. Containers restart, and the daemons resume any
swap from their swap files. Avoid redeploying while a swap is between its BTC lock and its end
if you can.

bitcoind and litecoind get 10 minutes to stop (`stop_grace_period`) so that they can flush their
caches; killed mid-sync, a node restarts from its last flush.

## 9. Firewall

Allow only SSH and HTTP(S):

```sh
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

Ports that Docker publishes bypass ufw, which is why the compose file publishes nothing but
Caddy's 80/443.

**Outside takers are not supported yet.** The makers' peer listeners (7112) are reachable only by
the takers on the private network. Publishing one would hand the internet an unauthenticated
maker API, which skips every guard of the public UI (swap size, rate limits) and lets anyone tie
up the maker's one swap slot. Opening a maker to other people's ferryd needs a rate-limited,
authenticated proxy in front of it first.

## 10. Backups

What has to survive lives in Docker volumes and in `infra/deploy/secrets/` on the server:

| where | holds | if lost |
|---|---|---|
| `ferry_ferryd-z`, `ferry_ferryd-b` and each pair's `ferry_ferryd-{z,b}-<pair>` | zcash-devtool wallets and their age identities, swap records | **ZEC funds and in-flight swaps** |
| `ferry_bitcoind` | the `zoe` and `bram` BTC wallets (`signet/wallets/`), the pruned chain | **BTC funds**; the chain resyncs |
| `ferry_litecoind` (ZEC/LTC) | the `zoe` and `bram` LTC wallets (`testnet4/wallets/`), the pruned chain | **LTC funds**; the chain resyncs |
| `infra/deploy/secrets/{usdc,weth}-base-{b,z}.*` (Base pairs) | the Base Sepolia keys (keystore, its password, raw key) | **USDC, WETH and ETH funds** |
| `ferry_token-*` | the daemons' API tokens | regenerated on restart |
| `ferry_caddy_data` | HTTPS certificates | re-issued automatically |

Back up the daemon volumes with the daemons stopped:

```sh
ssh <ssh-host> 'cd ~/ferry && C=infra/deploy/compose && mkdir -p ~/ferry-backups &&
  vols=$(docker volume ls -q | grep -E "^ferry_ferryd-") && svcs=$(echo "$vols" | sed "s/^ferry_//") &&
  $C stop $svcs && for v in $vols; do
    docker run --rm -v $v:/data -v ~/ferry-backups:/backup debian:bookworm-slim tar -C /data -czf /backup/$v-$(date +%F).tgz .
  done && $C up -d'
```

The BTC wallets, with bitcoind running:

```sh
ssh <ssh-host> 'cd ~/ferry && C=infra/deploy/compose &&
  for w in zoe bram; do
    $C exec -T bitcoind bitcoin-cli -signet -datadir=/home/bitcoin/.bitcoin -rpcport=38332 -rpcwallet=$w backupwallet /home/bitcoin/.bitcoin/$w.bak
    docker cp $($C ps -q bitcoind):/home/bitcoin/.bitcoin/$w.bak ~/ferry-backups/$w-$(date +%F).bak
  done'
```

The LTC wallets the same way, with `litecoind` and
`litecoin-cli -testnet -datadir=/home/litecoin/.litecoin -rpcport=19332`. The Base Sepolia keys:
copy `~/ferry/infra/deploy/secrets/` (as root or through a container: the raw keys belong to the
daemons' uid 10001).

Copy `~/ferry-backups` off the server (`scp -r <ssh-host>:ferry-backups .`). The files contain
private keys, so keep them private.

## 11. Rotating secrets

**API tokens:**

```sh
infra/deploy/deploy.sh <ssh-host> rotate-tokens
```

This deletes every daemon's token file (every enabled pair's too) and restarts the daemons and
the web server. Each daemon creates a new token, and the web server reads it from the token volume.

**Node RPC passwords** (bitcoind; for litecoind the same with `ltc_rpc_pass` and `LTC_RPCAUTH`):

```sh
ssh <ssh-host> 'cd ~/ferry/infra/deploy && rm secrets/btc_rpc_pass && sed -i "/^BTC_RPCAUTH=/d" .env'
infra/deploy/deploy.sh <ssh-host>
```

The deploy generates a new password and its `rpcauth` hash, and compose recreates the node and
the daemons.

**Base Sepolia keys** are wallets, not passwords: replacing one means moving its funds out first.
The deploy never replaces an existing key.

## Moving existing wallets (owner only, optional)

By default the server creates fresh wallets. If the project owner already funded the wallets of a
local `infra/testnet.sh` setup, the owner can move them instead, from the machine that ran it:

```sh
infra/deploy/deploy.sh <ssh-host> migrate-wallets
```

It needs that machine's `.testnet/z` and `.testnet/b` directories, and its signet node running
(`infra/testnet.sh up`). It refuses to run while that machine's own daemons are running, because two
live instances would act on the same keys and swap records. Stop them first: kill the pids in
`.testnet/z.pid` and `.testnet/b.pid`, and leave the signet node up. `--force` overrides the check.
It:
- stops the daemons on the server
- backs up the server's ferryd volumes to `~/ferry-backups/`
- copies the zcash-devtool wallets and age identities in
- imports the `zoe`/`bram` bitcoind wallets' descriptors, private keys included, over SSH

The funded addresses then keep working. Run it right after the first deploy, while the server's
node is still syncing, because a pruned node can only rescan blocks it still has. The backups in
`~/ferry-backups/` on the server hold wallet keys: keep a copy if you need one, then delete them.
It covers ZEC/BTC only. Anyone else can ignore this section.

## What runs

| service | image | notes |
|---|---|---|
| bitcoind | `bitcoin/bitcoin:28.1` | `-signet -prune=2000`; RPC on the private network only |
| ferryd-b | `infra/deploy/Dockerfile.ferryd` | maker "bram", offer `RATE:MIN_ZAT:MAX_ZAT`, live rate from `PRICE_FEED` + `SPREAD_BPS` |
| ferryd-z | same image | taker "zoe" |
| web | `infra/deploy/Dockerfile.web` | the UI and the guarded `/daemon/{z,b,<pair>}` proxy (`web/server/prod.mjs`) |
| caddy | `caddy:2.8-alpine` | HTTPS for `$DOMAIN`, HTTP/3 |
| litecoind (`ltc`) | `uphold/litecoin-core:0.21` (pinned digest, 0.21.5.6) | `-testnet -prune=2000`; RPC on the private network only |
| ferryd-{b,z}-ltc (`ltc`) | ferryd image | `--chain ltc --network testnet`; offer `LTC_RATE:LTC_MIN_ZAT:LTC_MAX_ZAT` |
| ferryd-{b,z}-usdc-base (`usdc-base`) | ferryd image | `--counter evm`, Base Sepolia, USDC; offer `USDC_RATE:USDC_MIN_ZAT:USDC_MAX_ZAT` |
| ferryd-{b,z}-weth-base (`weth-base`) | ferryd image | `--counter evm`, Base Sepolia, WETH; offer `WETH_RATE:WETH_MIN_ZAT:WETH_MAX_ZAT` |

The ferryd image contains `ferryd`, `zcash-devtool` (pinned revision plus Ferry's patch) and
`ferry-zec-signer`, and runs as an unprivileged user (uid 10001). The swap timelocks default to
values chosen for signet's ~10-minute blocks; `infra/testnet.sh help` explains them. The Base
pairs' keys and the WETH wrap use `cast` from `ghcr.io/foundry-rs/foundry:v1.5.1` (pinned digest),
pulled only when a Base pair is on.
