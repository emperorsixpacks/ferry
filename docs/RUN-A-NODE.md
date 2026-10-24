# Run your own Ferry node

One command starts Ferry on your own computer: the app, and the small programs that hold your
swap wallets and carry out your swaps. This page explains what that is and why Ferry needs it,
then walks through installing, funding, swapping, getting your coins out, backing up, updating
and stopping.

```sh
git clone https://github.com/JemIIahh/ferry.git && cd ferry && ./infra/node/ferry up
```

It runs on **test networks** unless you say otherwise: Zcash testnet, Base Sepolia, and if you
want, Bitcoin signet and Litecoin testnet. Test coins have no value and come free from faucets,
so you can try everything without risking anything.

## What a Ferry node is

A Ferry swap trades shielded ZEC for BTC, LTC, USDC or WETH directly with another person, with no
exchange or bridge in the middle. Each side of a swap is a program called **ferryd** (the Ferry
daemon). Your node is:

- **your ferryd daemons**, two per pair: one **sells** ZEC (it holds the ZEC you sell and receives
  the coin you get for it), one **buys** ZEC (it holds the coin you pay with and receives the ZEC).
  Each has its own wallets: a shielded Zcash wallet, and an account on the other chain;
- **the Ferry app**, at http://127.0.0.1:7865, which talks only to your own daemons;
- for the Bitcoin and Litecoin pairs, **a pruned Bitcoin or Litecoin node**, so your daemons can
  follow that chain without trusting anyone else's.

All of it runs in Docker on your computer. Nothing is reachable from outside it: the app listens on
127.0.0.1 only, and the daemons only on a private Docker network.

### Why there is no "connect wallet" button

Most apps let you connect MetaMask or a phone wallet and sign each step. Ferry can't, for two
reasons.

1. **A swap needs keys a normal wallet can't make.** The ZEC in a Ferry swap is locked to a Zcash
   key that is split between the two people: each holds half, and neither can spend it alone. The
   other chain's lock is built so that claiming it reveals one half, which completes the key for
   the other side. That takes key halves on two different curves, a proof that they match, and
   "adaptor" signatures. No Zcash, Bitcoin or Ethereum wallet produces any of these.
2. **Someone has to be online at the deadlines.** Every swap has two deadlines. If the other side
   disappears, your side must call the swap off and take its coins back (or, for some cases, take
   the other side's) before a deadline passes. A browser tab you closed can't do that. Your node
   keeps running and does it for you.

So the keys live in your node. You use it like a wallet: send coins in, swap, and send what you
got to your usual wallet (or have a swap pay straight into it).

## What you need

- **Docker**: [Docker Desktop](https://docs.docker.com/get-docker/) on macOS or Windows (use WSL2
  on Windows), or Docker Engine with the Compose plugin on Linux. Compose 2.20 or newer.
- **git**, **curl** and **openssl** (already there on macOS and most Linux systems).
- **Disk**: about 20 GB free for Docker the first time (Ferry is built from source; afterwards the
  images take about 1 GB), plus about 5 GB for each Bitcoin or Litecoin node.
- **Time**: the first `up` builds Ferry, which takes 15 to 40 minutes. Later starts take seconds.

## Install and start

```sh
git clone https://github.com/JemIIahh/ferry.git
cd ferry
./infra/node/ferry up
```

The first time, it asks two things and remembers the answers:

1. **Which pairs.** ZEC ⇄ USDC on Base Sepolia is on by default: it needs no chain node and works
   a minute after start. ZEC ⇄ WETH on Base Sepolia is the same kind. ZEC ⇄ BTC on Bitcoin signet
   and ZEC ⇄ LTC on Litecoin testnet each run a pruned node that **syncs for an hour or more** in
   the background (the app shows them once they are ready).
2. **Which Base Sepolia RPC** (for USDC and WETH): press Enter for the public
   `https://sepolia.base.org`, which is shared and rate limited but fine to start, or paste your own
   from Alchemy, Infura, QuickNode or Coinbase. It's stored in a private file and never printed in
   full.

`./infra/node/ferry up --yes` skips the questions and takes the defaults (or your saved answers).
Then it:

- checks Docker, the port and the disk space, and says plainly what's wrong if something is;
- creates your wallets (keys are generated on your computer and written only to `.ferry-node/` in
  the checkout, readable only by you; they are never printed);
- builds Ferry the first time;
- starts everything, waits until each daemon answers, and opens **http://127.0.0.1:7865**.

You'll see something like:

```
  ok  Base Sepolia RPC https://sepolia.base.org answers (chain 84532)
==> Ferry node on test networks (/home/you/ferry/.ferry-node)
  ZEC <-> USDC on Base Sepolia
==> Building the Ferry daemon (ferryd) (15-40 minutes the first time; the log is ...)
  still building, 6 min so far: ...
  ok  the Ferry daemon (ferryd) built in 21 min
==> Building the web app (about a minute; the log is ...)
==> Makers
  No public makers are listed yet: the app trades between your own two wallets of each pair ...
==> Starting
   Container ferry-node-ferryd-z-usdc-base-1  Started
   ...
==> Waiting for your node to come up (the first start creates your Zcash wallets: a minute or two)
  ok  web app on http://127.0.0.1:7865
  ok  ZEC <-> USDC on Base Sepolia: both daemons answer

Your Ferry node is running: http://127.0.0.1:7865

  Fund your wallets:  ./infra/node/ferry addresses
  Back them up:       ./infra/node/ferry backup   (your keys exist only in /home/you/ferry/.ferry-node)
  See how it's doing: ./infra/node/ferry status
  Stop it:            ./infra/node/ferry down
```

Running `up` again is safe: it changes nothing that is already right, and restarts only what
your new answers affect.

Use exactly `http://127.0.0.1:7865` in the browser: the app accepts actions only from that address.

To change the pairs or the RPC later: `./infra/node/ferry setup`, then `./infra/node/ferry up`.
Turning a pair off stops its daemons; its wallets stay on disk.

## Fund your wallets

```sh
./infra/node/ferry addresses
```

prints, for each pair, every address to fund, on which network, how much, and where to get test
coins. For ZEC ⇄ USDC on Base Sepolia:

| to | send | network | free test coins |
|---|---|---|---|
| your **sell** wallet's Zcash address (`utest1...`) | TAZ (testnet ZEC), e.g. 0.3 | **Zcash testnet** | [fauzec.com](https://fauzec.com) |
| your **sell** wallet's Base account (`0x...`) | about 0.001 ETH, for the claim's gas | **Base Sepolia** | Coinbase CDP or Alchemy faucet |
| your **buy** wallet's Base account (`0x...`) | USDC (e.g. 10) and about 0.002 ETH for gas | **Base Sepolia** | [faucet.circle.com](https://faucet.circle.com) for USDC |

- **Base Sepolia is not Ethereum Sepolia.** On a faucet, pick *Base Sepolia*; coins sent on
  Ethereum Sepolia don't arrive.
- **TAZ becomes spendable after 10 confirmations**, about 13 minutes. Send it to the shielded
  (`utest1...`) address the command prints.
- **Bitcoin signet** coins: [signetfaucet.com](https://signetfaucet.com). It's the default signet,
  not testnet3, testnet4 or Mutinynet.
- The ZEC you buy arrives in the buy wallet's own Zcash address; the coin you get for ZEC arrives in
  the sell wallet's account. Both are shown by `addresses` and in the app.

## Swap

Open http://127.0.0.1:7865. The swap card goes both ways: **Sell** gives shielded ZEC for the coin,
**Buy** pays with the coin for shielded ZEC. You always type the ZEC amount. The app shows each
step as it happens, and your node carries the swap to its end even if you close the browser.

**Who you trade with.** A swap needs a partner on the other side, called a maker. Public makers
(other people's nodes that quote prices) are listed in `infra/node/makers.txt`, and **none are
listed yet**. Until they are, your node trades between its own two wallets of each pair: selling
ZEC moves it from your sell wallet to your buy wallet, which pays you in USDC; buying moves it back.
That exercises the whole path (both chains, both locks, the claim), so it's the way to see a swap
happen on real test networks. Trading with other people's nodes comes once public makers are
listed: `./infra/node/ferry update` fetches the list, and `up` checks which makers answer each
time. To add a maker you know, put a line `name|https://its-peer-url|ZEC/USDC|base` in
`.ferry-node/makers.txt` and run `up` again. `./infra/node/ferry makers` shows what's listed.

Your node keeps running the swap whether or not the app is open. **Keep the computer on and
online until a swap finishes**: about 5 to 15 minutes on Base Sepolia (mostly the Zcash
confirmations), about half an hour on Bitcoin signet (10-minute blocks). If it was off past a
deadline, start the node again: it picks up where it was and refunds what it can.

## Get your coins out: receive to your own wallet, withdraw

Your node's wallets are hot wallets for swapping, not a place to keep savings.

- **Receive to your own wallet.** On the swap card you can enter an address of your own (a
  shielded Zcash address when buying ZEC, a Base or Bitcoin address when selling), and the swap pays
  there instead of into your node.
- **Withdraw.** The app's **Wallet** page shows each wallet's balance and sends any of it to an
  address you type.

## Back up

Your keys exist only in `.ferry-node/`. If that folder is lost, so are the coins in your node.

```sh
./infra/node/ferry backup                 # writes ~/ferry-node-backup-testnet-<date>.tar.gz.enc
./infra/node/ferry backup /path/to/file   # or where you say
```

It asks for a passphrase (12 characters or more) and writes one encrypted file (AES-256, key from
the passphrase with PBKDF2) holding every key and wallet of your node and your settings. The chain
data isn't in it: that syncs again. Keep the passphrase apart from the file; without it nobody can
open the backup, including you. Take a new backup after you add a pair, since a new pair gets new
wallets.

To restore on any computer with this checkout (into a node that has no wallets yet):

```sh
./infra/node/ferry restore ~/ferry-node-backup-testnet-20261021-101500.tar.gz.enc
./infra/node/ferry up
```

or by hand: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in FILE | tar -xzf -`.

## Check on it

```sh
./infra/node/ferry status        # what runs, chain sync, balances, swaps in progress
./infra/node/ferry logs          # follow all logs (Ctrl-C stops following, not the node)
./infra/node/ferry logs btc      # one pair; or a service, e.g. logs web
```

`status` shows the Bitcoin or Litecoin node's sync as a percentage, each wallet's balances, and the
swaps in progress, and explains in plain words when a daemon keeps failing (a rate-limited RPC, an
unreachable Zcash server, a wrong network).

## Update

```sh
./infra/node/ferry update
```

pulls the latest Ferry (`git pull`), rebuilds what changed (a few minutes) and restarts your node.
Your wallets and settings are kept. `up` also rebuilds by itself when the checkout has moved on
since the last build.

## Stop

```sh
./infra/node/ferry down
```

stops everything. Wallets, keys and settings stay in `.ferry-node/`, and the chain data stays in
Docker volumes, so `up` starts again in seconds. Don't stop it while a swap is running unless you
have to: it resumes on the next `up`, but a deadline can pass while it's off.

To remove the node entirely, first send your coins out, take a last backup, then: `ferry down`,
`docker volume rm ferry-node_bitcoind ferry-node_litecoind` (if you ran those pairs), and delete
`.ferry-node/`.

## Mainnet (real money)

```sh
./infra/node/ferry --mainnet up
```

runs Zcash mainnet and Base mainnet (USDC and WETH), in its own folder (`.ferry-node-mainnet/`),
its own containers and on port 7866, so it never mixes with your test node. It asks you to type
`MAINNET` once, caps every swap at **0.02 ZEC**, uses ferryd's mainnet safety margins (a swap can
take about 5 hours to call off), and needs:

- a **Base mainnet RPC** that allows `eth_getLogs` (the default is `https://base-rpc.publicnode.com`;
  `mainnet.base.org` refuses it);
- the **FerryLock** contract address both sides use. Ferry has no published mainnet deployment yet:
  deploy one with `infra/mainnet-demo.sh deploy` or use your counterparty's.

Ferry is unaudited hackathon software. Use amounts you can afford to lose, and back up first. Every
command takes `--mainnet` the same way (`./infra/node/ferry --mainnet status`).

## When something goes wrong

| it says | what to do |
|---|---|
| Docker is not installed / not running | install or start Docker Desktop (Linux: `sudo systemctl start docker`) |
| Port 7865 is already in use | stop the other program, or `./infra/node/ferry up --port 7875` |
| Not enough disk space for Docker | `docker system prune`, or give Docker Desktop a bigger disk (Settings, Resources) |
| the RPC is rate limiting your node | `./infra/node/ferry setup` and paste your own Base Sepolia RPC URL |
| can't reach the Zcash server | check the internet connection; it retries by itself |
| Bitcoin signet node: SYNCING | wait; `status` shows the progress. ZEC ⇄ BTC works once it's done |
| a swap shows an error in the app | `./infra/node/ferry logs <pair>`; your node retries, and if the swap is called off, the deadlines return your coins |

## How it's put together

`infra/node/ferry` writes two files next to your wallets (`compose.env` for Docker Compose,
`web.env` for the app) and runs `infra/node/docker-compose.yml` as the Docker project
`ferry-node`. It uses the same images as the public demo (`infra/deploy/Dockerfile.ferryd` and
`Dockerfile.web`). In `.ferry-node/`:

| | |
|---|---|
| `config` | your answers (pairs, port) |
| `daemons/ferryd-<z or b>-<pair>/` | each daemon's data: its Zcash wallet and the key that unlocks it, its EVM key (`evm.key`), its swaps |
| `btc-wallets/`, `ltc-wallets/` | the Bitcoin and Litecoin wallets the daemons keep in their node |
| `tokens/` | each daemon's API token, which only the app server reads |
| `secrets/` | the RPC URL and the chain nodes' RPC passwords |

Every container runs as your own user with no extra privileges, so these files stay yours (folders
0700, files 0600). Anything that can act as your user account can read them, as with any hot
wallet. The app gets each daemon's token from `tokens/`; the browser never sees a token or a key.
