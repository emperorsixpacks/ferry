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
internet ──443──▶ caddy ──▶ web ──▶ ferryd-z :7101 ┐            ┌─▶ testnet.zec.rocks:443
                                 └─▶ ferryd-b :7102 ┴─ bitcoind ┘    (Zcash lightwalletd)
                                     ferryd-b :7112 (peer; host loopback unless published)
```

Only Caddy publishes ports to the internet. The daemons' APIs and bitcoind's RPC sit on a private
Docker network. The web server adds the API tokens itself, so they never reach a browser.

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

1. copies the repository to `~/ferry` on the server (rsync; `.git`, build outputs and local
   state are left out)
2. creates `~/ferry/infra/deploy/.env` from `infra/deploy/.env.example`, with a random bitcoind
   RPC password and random API tokens. The file stays on the server, mode 600, and later deploys
   never overwrite it.
3. stops and asks you to set `DOMAIN`

Edit the file on the server:

```sh
ssh <ssh-host>
nano ~/ferry/infra/deploy/.env    # DOMAIN=demo.example.org, ACME_EMAIL=you@example.org
```

The other settings (the maker's rate and size limits, the swap timelocks, the demo guard) have
working defaults and are explained in the file. Then run the deploy again:

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
Caddy's 80/443. B's peer port stays on the server's loopback.

**Optional: outside takers.** To let other people's ferryd take B's offer, set
`B_PEER_PUBLISH=0.0.0.0:7112` and `B_PUBLIC_PEER_URL=http://<DOMAIN>:7112` in `.env`, allow
7112/tcp in the firewall, and redeploy. The peer protocol is plain HTTP. The joint viewing key
stays private (it depends on an ECDH secret that the transcript doesn't reveal), but treat it as a
testnet-only setup.

## 9. Backups

What has to survive lives in Docker volumes on the server:

| volume | holds | if lost |
|---|---|---|
| `ferry_ferryd-z`, `ferry_ferryd-b` | zcash-devtool wallets and their age identities, swap records | **ZEC funds and in-flight swaps** |
| `ferry_bitcoind` | the `zoe` and `bram` BTC wallets (`signet/wallets/`), the pruned chain | **BTC funds**; the chain resyncs |
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
    $C exec -T bitcoind sh -c "bitcoin-cli -signet -rpcport=38332 -rpcuser=\$BTC_RPC_USER -rpcpassword=\$BTC_RPC_PASS -rpcwallet=$w backupwallet /home/bitcoin/.bitcoin/$w.bak"
    docker cp $($C ps -q bitcoind):/home/bitcoin/.bitcoin/$w.bak ~/ferry-backups/$w-$(date +%F).bak
  done'
```

Copy `~/ferry-backups` off the server (`scp -r <ssh-host>:ferry-backups .`). The files contain
private keys, so keep them private.

## 10. Rotating secrets

The API tokens (`FERRY_Z_TOKEN`, `FERRY_B_TOKEN`) and the bitcoind RPC password (`BTC_RPC_PASS`)
live only in `~/ferry/infra/deploy/.env` on the server. To rotate them, put in new random values
(`openssl rand -hex 32`) and redeploy (`infra/deploy/deploy.sh <ssh-host>`). Compose recreates
the services that use them; nothing else stores them.

## Moving existing wallets (owner only, optional)

By default the server creates fresh wallets. If the project owner already funded the wallets of a
local `infra/testnet.sh` setup, the owner can move them instead, from the machine that ran it:

```sh
infra/deploy/deploy.sh <ssh-host> migrate-wallets
```

It needs that machine's `.testnet/z` and `.testnet/b` directories, and its signet node running
(`infra/testnet.sh up`). It:
- stops the daemons on the server
- backs up the server's ferryd volumes to `~/ferry-backups/`
- copies the zcash-devtool wallets and age identities in
- imports the `zoe`/`bram` bitcoind wallets' descriptors, private keys included, over SSH

The funded addresses then keep working. Run it right after the first deploy, while the server's
node is still syncing, because a pruned node can only rescan blocks it still has. Anyone else can
ignore this section.

## What runs

| service | image | notes |
|---|---|---|
| bitcoind | `bitcoin/bitcoin:28.1` | `-signet -prune=2000`; RPC on the private network only |
| ferryd-b | `infra/deploy/Dockerfile.ferryd` | maker "bram", offer `RATE:MIN_ZAT:MAX_ZAT` |
| ferryd-z | same image | taker "zoe" |
| web | `infra/deploy/Dockerfile.web` | the UI and the guarded `/daemon/{z,b}` proxy (`web/server/prod.mjs`) |
| caddy | `caddy:2.8-alpine` | HTTPS for `$DOMAIN`, HTTP/3 |

The ferryd image contains `ferryd`, `zcash-devtool` (pinned revision plus Ferry's patch) and
`ferry-zec-signer`, and runs as an unprivileged user (uid 10001). The swap timelocks default to
values chosen for signet's ~10-minute blocks; `infra/testnet.sh help` explains them.
