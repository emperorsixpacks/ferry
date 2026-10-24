# Deploying the Ferry testnet demo

This guide takes you from a fresh clone of the repository to the public demo running on one Linux
server. The demo uses test coins only. It runs:

- a pruned **Bitcoin signet** node (`bitcoind`)
- the two swap parties, each a `ferryd` daemon on **Zcash testnet**: **B** ("bram", the maker,
  holds BTC) and **Z** ("zoe", the taker, holds ZEC)
- the **web** UI
- **Caddy** for HTTPS

Everything is in `infra/deploy/` and runs with Docker Compose. You drive it from your own
machine over SSH with `infra/deploy/deploy.sh`.

```
            front            app                    chain
internet ──443──▶ caddy ──▶ web ──▶ ferryd-z :7101 ┐            ┌─▶ testnet.zec.rocks:443
                                 └─▶ ferryd-b :7102 ┴─ bitcoind ┘    (Zcash lightwalletd)
                                     ferryd-b :7112 (peer, for ferryd-z only)
```

Only Caddy publishes ports. Three private networks separate Caddy from the web server, the web
server from the daemons, and the daemons from bitcoind. Every container runs without Linux
capabilities (Caddy keeps only the right to bind 80/443), with `no-new-privileges` and a
read-only root filesystem.

Secrets stay off command lines and out of `docker inspect`:
- **bitcoind RPC password:** a file (`infra/deploy/secrets/btc_rpc_pass`) that the daemons read.
  bitcoind only gets its salted hash (`rpcauth`).
- **API tokens:** each daemon creates its token in its own small volume, which the web server
  mounts read-only. The web server adds the token to proxied requests itself, so it never reaches
  a browser.

## 1. Prerequisites

**Your machine** (macOS or Linux): `git`, `bash`, `ssh` with a key that logs in to the server,
`rsync`, and `python3` (`deploy.sh status` and `addresses` use it to format output).

**The server**:
- Ubuntu 22.04 or 24.04 on amd64, with **2 vCPU, 4 GB RAM and 30 GB disk**. The first image build
  compiles Rust (zcash-devtool) for 20–40 minutes; on a 4 GB machine, add 2–4 GB of swap first.
- Docker Engine and the compose plugin, from Docker's apt repository
  (https://docs.docker.com/engine/install/ubuntu/), then
  `sudo usermod -aG docker $USER` and log in again. Check with `docker compose version`.
- `rsync` (`sudo apt install rsync`).
- A DNS name whose A (and AAAA, if any) record points at the server. Caddy requests the HTTPS
  certificate for it on the first start.

No funds are needed to deploy. Wallets are created on the server, and you fund them afterwards
from faucets.

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
2. creates `~/ferry/infra/deploy/.env` from `infra/deploy/.env.example` and a random bitcoind
   RPC password in `~/ferry/infra/deploy/secrets/` (only `.env` gets its hash). Both stay on the
   server, private to your user, and later deploys never overwrite them.
3. stops and asks you to set `DOMAIN`

Edit the file on the server:

```sh
ssh <ssh-host>
nano ~/ferry/infra/deploy/.env    # DOMAIN=demo.example.org
```

The other settings (the maker's rate and size limits, the swap timelocks, the demo guard) have
working defaults and are explained in the file. The maker quotes the fixed `RATE` by default. Set
`PRICE_FEED=coingecko` (or `kraken`, `all`) to follow the live ZEC/BTC price plus `SPREAD_BPS`; it
pauses its offer if the feed fails for 5 minutes. The real price is about 3x the demo `RATE`, so
fund the maker with about 3x more signet BTC first. Then run the deploy again:

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

This prints B's **signet** address and Z's **Zcash testnet** unified address (`utest1…`).

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
on Z. Starts are capped at `DEMO_MAX_ZAT` (0.5 ZEC), one active swap at a time,
`DEMO_RATE_PER_HOUR` per IP and `DEMO_SWAPS_PER_HOUR` across all visitors.

## 7. Operations

```sh
infra/deploy/deploy.sh <ssh-host> logs              # everything; or: logs ferryd-z / ferryd-b / bitcoind / web / caddy
infra/deploy/deploy.sh <ssh-host> down              # stop; volumes (wallets, chain, certificates) are kept
```

**Update / redeploy**: `git pull` on your machine, then `infra/deploy/deploy.sh <ssh-host>`. It
re-syncs the code and rebuilds what changed. Containers restart, and the daemons resume any
swap from their swap files. Avoid redeploying while a swap is between its BTC lock and its end
if you can.

bitcoind gets 10 minutes to stop (`stop_grace_period`) so that it can flush its cache; if it is
killed mid-sync, it restarts from its last flush.

## 8. Firewall

Allow only SSH and HTTP(S):

```sh
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

Ports that Docker publishes bypass ufw, which is why the compose file publishes nothing but
Caddy's 80/443.

**Outside takers are not supported yet.** B's peer listener (7112) is reachable only by ferryd-z
on the private network. Publishing it would hand the internet an unauthenticated maker API, which
skips every guard of the public UI (swap size, rate limits) and lets anyone tie up the maker's one
swap slot. Opening the maker to other people's ferryd needs a rate-limited, authenticated proxy in
front of it first.

## 9. Backups

What has to survive lives in Docker volumes on the server:

| volume | holds | if lost |
|---|---|---|
| `ferry_ferryd-z`, `ferry_ferryd-b` | zcash-devtool wallets and their age identities, swap records | **ZEC funds and in-flight swaps** |
| `ferry_bitcoind` | the `zoe` and `bram` BTC wallets (`signet/wallets/`), the pruned chain | **BTC funds**; the chain resyncs |
| `ferry_token-z`, `ferry_token-b` | the daemons' API tokens | regenerated on restart |
| `ferry_caddy_data` | HTTPS certificates | re-issued automatically |

Back up the daemon volumes with the daemons stopped:

```sh
ssh <ssh-host> 'cd ~/ferry && C="docker compose -f infra/deploy/docker-compose.yml --env-file infra/deploy/.env" &&
  $C stop ferryd-z ferryd-b && mkdir -p ~/ferry-backups &&
  for v in ferry_ferryd-z ferry_ferryd-b; do
    docker run --rm -v $v:/data -v ~/ferry-backups:/backup debian:bookworm-slim tar -C /data -czf /backup/$v-$(date +%F).tgz .
  done && $C up -d'
```

And the BTC wallets, with bitcoind running:

```sh
ssh <ssh-host> 'cd ~/ferry && C="docker compose -f infra/deploy/docker-compose.yml --env-file infra/deploy/.env" &&
  for w in zoe bram; do
    $C exec -T bitcoind bitcoin-cli -signet -datadir=/home/bitcoin/.bitcoin -rpcport=38332 -rpcwallet=$w backupwallet /home/bitcoin/.bitcoin/$w.bak
    docker cp $($C ps -q bitcoind):/home/bitcoin/.bitcoin/$w.bak ~/ferry-backups/$w-$(date +%F).bak
  done'
```

Copy `~/ferry-backups` off the server (`scp -r <ssh-host>:ferry-backups .`). The files contain
private keys, so keep them private.

## 10. Rotating secrets

**API tokens:**

```sh
infra/deploy/deploy.sh <ssh-host> rotate-tokens
```

This deletes both daemons' token files and restarts ferryd and web. Each daemon creates a new
token, and the web server reads it from the token volume.

**bitcoind RPC password:**

```sh
ssh <ssh-host> 'cd ~/ferry/infra/deploy && rm secrets/btc_rpc_pass && sed -i "/^BTC_RPCAUTH=/d" .env'
infra/deploy/deploy.sh <ssh-host>
```

The deploy generates a new password and its `rpcauth` hash, and compose recreates bitcoind and
the daemons.

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
Anyone else can ignore this section.

## What runs

| service | image | notes |
|---|---|---|
| bitcoind | `bitcoin/bitcoin:28.1` | `-signet -prune=2000`; RPC on the private network only |
| ferryd-b | `infra/deploy/Dockerfile.ferryd` | maker "bram", offer `RATE:MIN_ZAT:MAX_ZAT`, live rate from `PRICE_FEED` + `SPREAD_BPS` |
| ferryd-z | same image | taker "zoe" |
| web | `infra/deploy/Dockerfile.web` | the UI and the guarded `/daemon/{z,b}` proxy (`web/server/prod.mjs`) |
| caddy | `caddy:2.8-alpine` | HTTPS for `$DOMAIN`, HTTP/3 |

The ferryd image contains `ferryd`, `zcash-devtool` (pinned revision plus Ferry's patch) and
`ferry-zec-signer`, and runs as an unprivileged user (uid 10001). The swap timelocks default to
values chosen for signet's ~10-minute blocks; `infra/testnet.sh help` explains them.
