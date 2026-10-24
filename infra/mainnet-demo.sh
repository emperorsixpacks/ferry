#!/usr/bin/env bash
# One small, owner-approved MAINNET demo of Ferry + NEAR Intents: sell a little shielded ZEC on
# Zcash mainnet for Circle's USDC on Base mainnet through a Ferry swap whose claim pays straight
# into a NEAR Intents (1Click) deposit address; 1Click then delivers the asset you pick (SOL, ...)
# to your address. Run `infra/mainnet-demo.sh help`. `fork test` rehearses all of it with no real
# funds: an anvil fork of Base mainnet, mock ZEC and a mock 1Click.
set -euo pipefail
# Keys, wallets, tokens and logs: everything this script creates is private to the user.
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_STATE="$ROOT/.mainnet-demo"
FORK_STATE="$ROOT/.mainnet-demo-fork"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
ANVIL="${ANVIL:-$(command -v anvil || echo "$FOUNDRY_BIN/anvil")}"
FORGE="${FORGE:-$(command -v forge || echo "$FOUNDRY_BIN/forge")}"
CAST="${CAST:-$(command -v cast || echo "$FOUNDRY_BIN/cast")}"
NODE="${NODE:-$(command -v node || true)}"
FERRYD="${FERRYD:-$ROOT/target/debug/ferryd}"
ARTIFACT="$ROOT/crates/ferry-evm/artifacts/FerryLock.json"

# The hard cap: no swap, offer or UI start above 0.02 ZEC, whatever the environment says.
CAP_ZAT=2000000

FORK_PORT="${FORK_PORT:-18576}"
FORK_URL="${FORK_URL:-https://mainnet.base.org}"
# Read-only Transfer logs to find a USDC holder for the fork (mainnet.base.org refuses eth_getLogs).
FORK_LOGS_RPC="${FORK_LOGS_RPC:-https://base-rpc.publicnode.com}"
if [ "${1:-}" = fork ]; then
  STATE="${FERRY_MAINNET_DEMO_DIR:-$FORK_STATE}"
  EVM_RPC="${EVM_RPC:-http://127.0.0.1:$FORK_PORT}"
  ZEC_BACKEND="${ZEC_BACKEND:-mock}"
  FAULTS="${FAULTS:-1}"
  Z_PORT="${Z_PORT:-7481}" B_PORT="${B_PORT:-7482}" Z_PEER_PORT="${Z_PEER_PORT:-7491}" B_PEER_PORT="${B_PEER_PORT:-7492}"
  UI_PORT="${UI_PORT:-7475}" NEAR_PORT="${NEAR_PORT:-7476}"
else
  STATE="${FERRY_MAINNET_DEMO_DIR:-$DEFAULT_STATE}"
fi

# The Base RPC: EVM_RPC, else one line in $STATE/base-rpc (a provider URL, mode 0600), else the
# public endpoint. It goes to ferryd in a 0600 file and to cast in ETH_RPC_URL, never on a command
# line, and is printed only as scheme://host.
if [ -z "${EVM_RPC:-}" ] && [ -s "$STATE/base-rpc" ]; then
  EVM_RPC="$(head -n 1 "$STATE/base-rpc" | tr -d '[:space:]')"
fi
EVM_RPC="${EVM_RPC:-https://mainnet.base.org}"
export ETH_RPC_URL="$EVM_RPC"
CHAIN_ID=8453
# Circle's USDC on Base mainnet.
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
EXPLORER="${EXPLORER:-https://basescan.org}"
ZEC_EXPLORER="${ZEC_EXPLORER:-https://blockchair.com/zcash/transaction}"
NEAR_EXPLORER="https://explorer.near-intents.org/transactions"
ONE_CLICK="https://1click.chaindefuser.com"

Z_PORT="${Z_PORT:-7451}"           # control API (/api/*, loopback)
B_PORT="${B_PORT:-7452}"
Z_PEER_PORT="${Z_PEER_PORT:-7461}" # peer protocol (/peer/*), loopback only
B_PEER_PORT="${B_PEER_PORT:-7462}"
UI_PORT="${UI_PORT:-7470}"         # the UI server (web/server/prod.mjs), loopback only
NEAR_PORT="${NEAR_PORT:-7476}"     # the mock 1Click (fork only)
MAKER_URL="http://127.0.0.1:$B_PEER_PORT"
Z_NAME="${Z_NAME:-zoe}"
B_NAME="${B_NAME:-bram}"

# Amounts in zatoshi. One sell of SWAP_ZAT; B's offer takes MIN_ZAT..MAX_ZAT.
SWAP_ZAT="${SWAP_ZAT:-1000000}"
MIN_ZAT="${MIN_ZAT:-500000}"
MAX_ZAT="${MAX_ZAT:-$CAP_ZAT}"
# B (the maker, the owner's own) buys ZEC this far under the market (basis points).
SPREAD_BPS="${SPREAD_BPS:-50}"
# RATE (USDC base units per ZEC) is set from the market at `up` unless given.
RATE="${RATE:-}"

# Base mainnet policy (ferryd's EvmPolicy for chain 8453; it refuses anything less): 1 h margins,
# 30 lock confirmations, 10 Zcash confirmations, at least 4 h from the proposal to t1 - Δ, and a
# refund window t2 - t1 - Δ of at least 1 h. T1 = 4 h + Δ + 15 min of slack.
T1_SECS="${T1_SECS:-18900}"
REFUND_SECS="${REFUND_SECS:-7200}"
DELTA_SECS="${DELTA_SECS:-3600}"
LOCK_CONFS="${LOCK_CONFS:-30}"
ZEC_CONFS="${ZEC_CONFS:-10}"
POLL_MS="${POLL_MS:-4000}"
LOG_CHUNK="${LOG_CHUNK:-200}"
RPC_TRIES="${RPC_TRIES:-6}"
export ETH_RPC_TIMEOUT="${ETH_RPC_TIMEOUT:-30}"

# ETH (gas) to fund each Base account with, and the floor below which status asks for more. At
# Base's usual fees (0.005-0.01 gwei plus a small L1 data fee) deploying FerryLock costs about
# 0.00002 ETH, B's approve + lock about 0.000003 ETH and Z's claim under 0.000001 ETH; these
# amounts cover each step even at 100x those fees.
DEPLOYER_ETH="${DEPLOYER_ETH:-0.001}"
DEPLOYER_MIN_ETH="${DEPLOYER_MIN_ETH:-0.0003}"
B_ETH="${B_ETH:-0.0005}"
B_MIN_ETH="${B_MIN_ETH:-0.0002}"
Z_ETH="${Z_ETH:-0.0002}"
Z_MIN_ETH="${Z_MIN_ETH:-0.00005}"
# What ferry-zec keeps aside for the lock's fee (SEND_FEE_RESERVE).
ZEC_FEE_RESERVE_ZAT=50000

ZEC_BACKEND="${ZEC_BACKEND:-devtool}"
ZEC_NETWORK=main
ZEC_SERVER="${ZEC_SERVER:-zec.rocks:443}"
ZEC_NODE_RPC="${ZEC_NODE_RPC:-}"
ZEC_DEVTOOL="${ZEC_DEVTOOL:-$ROOT/vendor/zcash-devtool/target/release/zcash-devtool}"
ZEC_SIGNER="${ZEC_SIGNER:-$ROOT/tools/ferry-zec-signer/target/release/ferry-zec-signer}"
ZEC_MOCK_BLOCK_SECS="${ZEC_MOCK_BLOCK_SECS:-3}"
ZEC_MOCK_BALANCE="${ZEC_MOCK_BALANCE:-10000000}"
FAULTS="${FAULTS:-}"
# How long a 1Click sell quote stays open: it must outlive the Ferry swap (claim by t1 - Δ).
NEAR_SELL_DEADLINE_SECS="${NEAR_SELL_DEADLINE_SECS:-86400}"

usage() {
  cat <<EOF
Ferry + NEAR Intents on MAINNET, one small demo: shielded ZEC (Zcash mainnet) -> USDC on Base
mainnet (a Ferry atomic swap whose claim pays a NEAR Intents deposit address) -> the asset you pick,
delivered by NEAR Intents (1Click) to your address. Unaudited software: tiny amounts only. Every
swap is capped at $(cast_zec $CAP_ZAT) ZEC.

In this order:
  1. infra/mainnet-demo.sh keys     create the wallets, once: Zcash MAINNET wallets for Z (sells the
                                    ZEC) and B (the maker, receives it), and Base MAINNET accounts
                                    for Z (claim gas), B (holds the USDC) and a deployer. Kept in
                                    $STATE (0700/0600); prints addresses only, never
                                    a key; never overwrites one. BACK UP THAT FOLDER.
  2. the owner funds the addresses   \`status\` lists exactly what, how much and on which network
  3. infra/mainnet-demo.sh status   balances (ZEC per pool, Base ETH and USDC), what is still
                                    missing, FerryLock, the daemons, the RPC
  4. infra/mainnet-demo.sh deploy   deploy FerryLock on Base mainnet from the deployer (asks you to
                                    type YES), then check the code on chain is this build's
  5. infra/mainnet-demo.sh up       start B (maker at the market rate less SPREAD_BPS, at most
                                    $(cast_zec "$MAX_ZAT") ZEC), Z, and the UI server with FERRY_NEAR=1, all on 127.0.0.1
  6. infra/mainnet-demo.sh sell <asset> <recipient> [zec]
                                    shows the composed quote (Ferry leg and NEAR Intents' signed dry
                                    quote: amounts, fees, deadline), asks YES, then starts it and
                                    follows both parts to the end with every transaction's link
                                    asset: SOL@sol, USDC@sol, a 1Click asset id ...; zec defaults to
                                    $(cast_zec "$SWAP_ZAT")
  Then: infra/mainnet-demo.sh down

Also:
  infra/mainnet-demo.sh near-check [asset] [recipient]
                                    read-only: 1Click's token list and DRY quotes for USDC (Base)
                                    -> asset at the demo's sizes, with its minimum, fees and time
  infra/mainnet-demo.sh follow [job]  follow a NEAR sell again (the newest if no id)
  infra/mainnet-demo.sh logs [z|b|ui|near|anvil]
  infra/mainnet-demo.sh fork up|fund|test|down
                                    rehearsal on an anvil fork of Base mainnet (127.0.0.1:$FORK_PORT,
                                    chain id 8453, so ferryd applies the real Base mainnet policy)
                                    with the real USDC contract, mock ZEC (--zec-network main) and
                                    the mock 1Click (web/mock/oneclick.mjs), state in
                                    $FORK_STATE. \`fork test\` runs keys, fund, a real
                                    read-only 1Click check, deploy, up, a NEAR sell to the end, a
                                    NEAR refund and a Ferry refund (time jumped to t1), then stops
                                    everything. Nothing touches a real network but read-only calls.

Networks: Zcash MAINNET, and BASE MAINNET (chain id 8453), an Ethereum L2. Base mainnet is NOT
Ethereum mainnet: ETH or USDC sent on Ethereum mainnet does not arrive on Base.

Checks: deploy, up and sell stop unless the RPC says chain id $CHAIN_ID and $USDC
answers symbol "USDC", 6 decimals, name "USD Coin" (read-only). ferryd refuses to start unless the
code at FerryLock is this build's and the token's symbol() and decimals() match. up also checks the
RPC answers eth_getLogs (ferryd needs it; https://mainnet.base.org often refuses it).

Deadlines (Base mainnet policy, seconds of Base block time):
  T1_SECS=$T1_SECS from the proposal to t1 (claim window of at least 4 h before t1 - Δ)
  DELTA_SECS=$DELTA_SECS both margins; REFUND_SECS=$REFUND_SECS t1 to t2 (refund window of 1 h)
  LOCK_CONFS=$LOCK_CONFS Base blocks (about 1 min); ZEC_CONFS=$ZEC_CONFS Zcash blocks (about 12.5 min)
  The happy path takes about 15-25 min. If something stops, B refunds at t1 (about 5 h 15 min
  after the start) and Z takes its ZEC back; if B vanishes, Z punishes at t2 (about 7 h 15 min).

Environment (defaults in brackets):
  EVM_RPC [https://mainnet.base.org, or the URL in $STATE/base-rpc]
  ZEC_SERVER [$ZEC_SERVER]  ZEC_NODE_RPC (optional Zebra JSON-RPC)  ZEC_DEVTOOL [$ZEC_DEVTOOL]
  ZEC_SIGNER [$ZEC_SIGNER] (built on first \`up\` if missing)
  SWAP_ZAT [$SWAP_ZAT]  MIN_ZAT [$MIN_ZAT]  MAX_ZAT [$MAX_ZAT, at most $CAP_ZAT]  SPREAD_BPS [$SPREAD_BPS]  RATE [market]
  T1_SECS REFUND_SECS DELTA_SECS LOCK_CONFS ZEC_CONFS POLL_MS [$POLL_MS] LOG_CHUNK [$LOG_CHUNK]
  Z_PORT [$Z_PORT] B_PORT [$B_PORT] Z_PEER_PORT [$Z_PEER_PORT] B_PEER_PORT [$B_PEER_PORT] UI_PORT [$UI_PORT]
  FERRY_MAINNET_DEMO_DIR [$STATE]
  A 1Click partner JWT (lower fees) goes in $STATE/near-jwt (one line, mode 0600).

The UI: cd web && pnpm build, then open http://127.0.0.1:$UI_PORT/app once \`up\` runs.
docs/MAINNET-DEMO.md has the funding list, the risks and what to record.
EOF
}

log() { printf '[mainnet-demo] %s\n' "$*"; }
warn() { printf '[mainnet-demo] WARNING: %s\n' "$*" >&2; }
die() { printf '[mainnet-demo] error: %s\n' "$*" >&2; exit 1; }

cast_zec() { python3 -c 'import sys; print(("%.8f" % (int(sys.argv[1]) / 1e8)).rstrip("0").rstrip("."))' "$1"; }
# fmt_eth <wei>: ETH with at most 7 decimals
fmt_eth() { python3 -c 'import sys; print(("%.7f" % (int(sys.argv[1]) / 1e18)).rstrip("0").rstrip("."))' "$1"; }
fmt_usdc() { python3 -c 'import sys; print(("%.6f" % (int(sys.argv[1]) / 1e6)).rstrip("0").rstrip("."))' "$1"; }
# ge <a> <b>: a >= b, for integers of any size
ge() { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)' "$1" "$2"; }
# zat_of <decimal ZEC>: zatoshi
zat_of() {
  python3 -c '
import sys
from decimal import Decimal, InvalidOperation
try:
    z = Decimal(sys.argv[1]) * 100000000
except InvalidOperation:
    sys.exit(1)
if z != z.to_integral_value() or z <= 0:
    sys.exit(1)
print(int(z))' "$1"
}
# The RPC as scheme://host[:port], with "/..." if a path or query (often an API key) was dropped.
redacted() {
  python3 -c '
import sys
from urllib.parse import urlsplit
u = urlsplit(sys.argv[1])
host = u.hostname or "?"
port = ":%d" % u.port if u.port else ""
hidden = (u.path not in ("", "/")) or u.query or u.username
print("%s://%s%s%s" % (u.scheme, host, port, "/..." if hidden else ""))' "$1"
}

# no more than the cap: check_cap <name> <zat>
check_cap() {
  [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -gt 0 ] || die "$1 must be a positive number of zatoshi (got $2)"
  [ "$2" -le "$CAP_ZAT" ] || die "$1 is $(cast_zec "$2") ZEC; this demo never goes above $(cast_zec $CAP_ZAT) ZEC per swap"
}

# alive <z|b|ui|near|anvil>: the process in <name>.pid is running and is still the one this script
# started (its command line names our state directory or fork port), not a reused PID.
alive() {
  local pid mark
  pid=$(cat "$STATE/$1.pid" 2>/dev/null) || return 1
  case $1 in
    anvil) mark="--port $FORK_PORT" ;;
    ui) mark="prod.mjs --ferry-mainnet-demo=$STATE" ;;
    near) mark="oneclick.mjs --ferry-mainnet-demo=$STATE" ;;
    *) mark="--data-dir $STATE/$1" ;;
  esac
  ps -ww -p "$pid" -o command= 2>/dev/null | grep -qF -- "$mark"
}

# Stop exactly the process this script started (by its recorded PID).
stop_pid() {
  if alive "$1"; then
    kill "$(cat "$STATE/$1.pid")" 2>/dev/null || true
    for _ in $(seq 1 25); do alive "$1" || break; sleep 0.2; done
    alive "$1" && kill -9 "$(cat "$STATE/$1.pid")" 2>/dev/null || true
  fi
  rm -f "$STATE/$1.pid"
}

need_foundry() {
  [ -x "$CAST" ] || die "cast (Foundry) is required: curl -L https://foundry.paradigm.xyz | bash; foundryup"
  command -v python3 >/dev/null || die "python3 is required"
}
need_node() { [ -n "$NODE" ] && [ -x "$NODE" ] || die "node (22+) is required for the UI server and the 1Click checks"; }

# retry <cmd...>: a read-only RPC call, retried with a doubling backoff (public RPCs throttle).
retry() {
  local i delay=1
  for i in $(seq 1 "$RPC_TRIES"); do
    if [ "$i" -lt "$RPC_TRIES" ]; then
      "$@" 2>/dev/null && return 0
      sleep "$delay"
      delay=$((delay * 2))
    else
      "$@" && return 0
    fi
  done
  return 1
}

ccall() { retry "$CAST" call "$@"; }
eth_wei() { retry "$CAST" balance "$1"; }
usdc_units() { ccall "$USDC" "balanceOf(address)(uint256)" "$1" | awk '{print $1}'; }
chain_time() { retry "$CAST" block latest --field timestamp; }

is_anvil() { "$CAST" rpc web3_clientVersion 2>/dev/null | grep -qi anvil; }

# The RPC must be Base mainnet (or a fork of it) and the token Circle's USDC. Sets FORK.
check_chain() {
  local id sym dec name
  id=$(retry "$CAST" chain-id) || die "cannot reach the Base RPC $(redacted "$EVM_RPC")"
  [ "$id" = "$CHAIN_ID" ] || die "$(redacted "$EVM_RPC") reports chain id $id, not $CHAIN_ID (Base mainnet)"
  sym=$(ccall "$USDC" "symbol()(string)") || die "eth_call symbol() on $USDC failed"
  dec=$(ccall "$USDC" "decimals()(uint8)") || die "eth_call decimals() on $USDC failed"
  name=$(ccall "$USDC" "name()(string)") || die "eth_call name() on $USDC failed"
  [ "$sym" = '"USDC"' ] && [ "$dec" = 6 ] && [ "$name" = '"USD Coin"' ] ||
    die "$USDC reports symbol $sym, name $name, $dec decimals; expected \"USDC\", \"USD Coin\", 6: not Circle's USDC"
  if is_anvil; then
    # A fork deployment in the real state directory would look like a real one later.
    [ "$STATE" != "$DEFAULT_STATE" ] ||
      die "$(redacted "$EVM_RPC") is an anvil fork: use the fork subcommands or set FERRY_MAINNET_DEMO_DIR"
    FORK=1
  else
    # Fork keys are rehearsal keys: never let them near the real chain.
    [ "$STATE" != "$FORK_STATE" ] || die "the fork's state directory may not be used against a real RPC"
    FORK=
    [ -z "$FAULTS" ] || die "FAULTS is for the fork rehearsal only"
    [ "$ZEC_BACKEND" = devtool ] || die "ZEC_BACKEND=mock is for the fork rehearsal only"
  fi
}

# ferryd reads FerryLock's events with eth_getLogs; some public RPCs refuse it.
check_logs_rpc() {
  local head
  head=$(retry "$CAST" block-number) || die "cannot read the block number"
  if ! retry "$CAST" logs --address "$USDC" --from-block "$head" --to-block "$head" \
    'Approval(address indexed,address indexed,uint256)' >/dev/null; then
    die "$(redacted "$EVM_RPC") refuses eth_getLogs, which ferryd needs to follow FerryLock. Put a provider's Base mainnet URL (Alchemy, QuickNode, Coinbase CDP; or https://base-rpc.publicnode.com) in $STATE/base-rpc (one line, chmod 600), or set EVM_RPC"
  fi
}

addr_of() { cat "$STATE/$1.addr" 2>/dev/null || die "no $1 account in $STATE: run infra/mainnet-demo.sh keys"; }
who_name() { case $1 in b) echo B ;; z) echo Z ;; *) echo "$1" ;; esac; }
tx_link() { echo "$EXPLORER/tx/$1"; }
addr_link() { echo "$EXPLORER/address/$1"; }

# confirm <what>: the owner types YES. Nothing real is spent on a fork, so it doesn't ask there.
confirm() {
  if [ -n "$FORK" ]; then
    log "fork: no confirmation asked (nothing real is spent)"
    return 0
  fi
  [ -t 0 ] || die "this step spends real funds: run it at a terminal, where you can type YES"
  printf '\n%s\nType YES to go on (anything else stops here): ' "$1"
  local ans
  read -r ans
  [ "$ans" = YES ] || die "not confirmed; nothing was sent"
}

# ------------------------------------------------------------------ market (read-only)

# {"zec": USD, "eth": USD, "usdc": USD, "kraken_zec": USD} from 1Click's token list and Kraken
market_json() {
  python3 - "$ONE_CLICK" <<'PY'
import json, sys, urllib.request
def get(u):
    r = urllib.request.Request(u, headers={"accept": "application/json", "user-agent": "ferry-mainnet-demo"})
    with urllib.request.urlopen(r, timeout=20) as f:
        return json.load(f)
out = {}
want = {"nep141:zec.omft.near": "zec", "nep141:base.omft.near": "eth",
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": "usdc"}
try:
    for t in get(sys.argv[1] + "/v0/tokens"):
        k = want.get(t.get("assetId"))
        if k and isinstance(t.get("price"), (int, float)):
            out[k] = t["price"]
except Exception as e:
    out["error_1click"] = str(e)[:80]
try:
    k = get("https://api.kraken.com/0/public/Ticker?pair=ZECUSD")
    out["kraken_zec"] = float(next(iter(k["result"].values()))["c"][0])
except Exception as e:
    out["error_kraken"] = str(e)[:80]
print(json.dumps(out))
PY
}

# market_rate <market json>: USDC base units per ZEC, SPREAD_BPS under the market; dies when the
# sources disagree by more than 3% or none answers.
market_rate() {
  python3 - "$1" "$SPREAD_BPS" <<'PY'
import json, sys
m = json.loads(sys.argv[1])
spread = int(sys.argv[2])
a, k, usdc = m.get("zec"), m.get("kraken_zec"), m.get("usdc") or 1.0
if a is None and k is None:
    sys.exit("no ZEC price from 1Click or Kraken")
if a is not None and k is not None and abs(a - k) / k > 0.03:
    sys.exit("the ZEC price from 1Click ($%.2f) and Kraken ($%.2f) differ by more than 3%%" % (a, k))
p = a if a is not None else k
if not 1 <= p <= 100000:
    sys.exit("a ZEC price of $%s looks wrong" % p)
print(int(p / usdc * 1e6 * (10000 - spread) / 10000))
PY
}

# ------------------------------------------------------------------ keys

new_hex_key() { # new_hex_key <name>: a fresh secp256k1 key in <name>.key (hex, 0600)
  [ -s "$STATE/$1.key" ] && return 0
  "$CAST" wallet new --json | python3 -c '
import json, os, sys
w = json.load(sys.stdin)[0]
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, (w["private_key"] + "\n").encode())
os.close(fd)
with open(sys.argv[2], "w") as f:
    f.write(w["address"] + "\n")' "$STATE/$1.key" "$STATE/$1.addr"
  log "created the $(who_name "$1") account $(cat "$STATE/$1.addr")"
}

# The deployer is an encrypted keystore with a random password in a file next to it, so cast takes
# the key without it ever appearing on a command line.
new_deployer() {
  [ -s "$STATE/deployer.json" ] && return 0
  [ -s "$STATE/deployer.pass" ] || openssl rand -hex 32 >"$STATE/deployer.pass"
  local out
  out=$(CAST_PASSWORD="$(cat "$STATE/deployer.pass")" "$CAST" wallet new "$STATE" deployer.json) ||
    die "creating the deployer keystore failed"
  echo "$out" | awk '/^Address:/{print $2}' >"$STATE/deployer.addr"
  [ -s "$STATE/deployer.addr" ] || die "no address in cast's keystore output"
  log "created the deployer account $(cat "$STATE/deployer.addr")"
}

zec_wallet_dir() { echo "$STATE/$1/zec-wallet"; }

# A Zcash mainnet wallet laid out the way ferryd opens it (<data-dir>/zec-wallet, its mnemonic
# encrypted to <data-dir>/zec-identity.age). The birthday is the current tip, so fund it only after
# it exists.
new_zec_wallet() {
  local dir
  dir=$(zec_wallet_dir "$1")
  [ -f "$dir/keys.toml" ] && return 0
  mkdir -p "$dir" "$STATE/logs"
  # stdin from /dev/null: devtool then generates the mnemonic instead of reading one.
  if ! "$ZEC_DEVTOOL" wallet -w "$dir" init --name ferry -i "$STATE/$1/zec-identity.age" \
    -n "$ZEC_NETWORK" -s "$ZEC_SERVER" </dev/null >>"$STATE/logs/zec-init-$1.log" 2>&1; then
    tail -n 5 "$STATE/logs/zec-init-$1.log" | grep -vi 'mnemonic\|phrase\|seed' >&2 || true
    die "creating the Zcash mainnet wallet for $1 failed (log: $STATE/logs/zec-init-$1.log)"
  fi
  log "created the Zcash mainnet wallet for $(who_name "$1")"
}

zec_address() {
  local dir
  dir=$(zec_wallet_dir "$1")
  [ -f "$dir/keys.toml" ] || return 1
  "$ZEC_DEVTOOL" wallet -w "$dir" list-addresses 2>/dev/null | awk '/Default Address:/{print $3; exit}'
}

cmd_keys() {
  need_foundry
  command -v openssl >/dev/null || die "openssl is required"
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  new_hex_key b
  new_hex_key z
  new_deployer
  if [ "$ZEC_BACKEND" = devtool ]; then
    [ -x "$ZEC_DEVTOOL" ] || die "zcash-devtool not found at $ZEC_DEVTOOL (build vendor/zcash-devtool with Ferry's patch, or set ZEC_DEVTOOL)"
    mkdir -p "$STATE/z" "$STATE/b"
    new_zec_wallet z
    new_zec_wallet b
  fi
  find "$STATE" -maxdepth 1 -type f -exec chmod 600 {} +
  echo
  echo "BASE MAINNET accounts (chain id 8453; keys in $STATE, never printed):"
  echo "  deployer  $(addr_of deployer)   deploys FerryLock once (pays its gas)"
  echo "  B         $(addr_of b)   the maker: holds the USDC, locks it, refunds"
  echo "  Z         $(addr_of z)   the seller: sends the claim (pays its gas); NEAR refunds land here"
  if [ "$ZEC_BACKEND" = devtool ]; then
    echo "ZCASH MAINNET wallets (zcash-devtool, seeds encrypted in $STATE/{z,b}):"
    echo "  Z         $(zec_address z || echo '?')"
    echo "            holds the shielded ZEC it sells"
    echo "  B         $(zec_address b || echo '?')"
    echo "            receives the ZEC (the maker's side)"
  else
    echo "Zcash: mock (fork rehearsal), no wallets"
  fi
  if [ "$STATE" = "$FORK_STATE" ]; then
    echo "(rehearsal keys for the fork: never fund them)"
    return 0
  fi
  echo
  echo "BACK UP $STATE NOW (an encrypted copy, offline): it holds the only copy of these keys."
  echo "Next: infra/mainnet-demo.sh status  (exactly what to fund, how much, and on which network)"
}

# ------------------------------------------------------------------ FerryLock

artifact_field() { # artifact_field bytecode|deployedBytecode
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["object"].lower())' "$ARTIFACT" "$1"
}

lock_code_matches() {
  local code
  code=$(retry "$CAST" code "$1") || return 1
  [ "$(echo "$code" | tr 'A-F' 'a-f')" = "$(artifact_field deployedBytecode)" ]
}

# The recorded FerryLock, if the code there is this build's.
recorded_lock() {
  local lock
  lock=$(cat "$STATE/ferrylock" 2>/dev/null) || return 1
  lock_code_matches "$lock" && echo "$lock"
}

# The committed artifact (what ferryd compiles in and checks the deployment against) must be what
# the contracts build to now.
check_artifact() {
  if [ ! -x "$FORGE" ]; then
    log "forge not found: deploying the committed artifact without rebuilding it"
    return 0
  fi
  local built
  built=$("$FORGE" inspect --root "$ROOT/contracts" FerryLock deployedBytecode 2>/dev/null | tr 'A-F' 'a-f' | tr -d '[:space:]') ||
    die "forge inspect FerryLock failed"
  [ "$built" = "$(artifact_field deployedBytecode)" ] ||
    die "contracts/ builds to other code than crates/ferry-evm/artifacts/FerryLock.json (run contracts/export-artifacts.sh and rebuild ferryd)"
  log "FerryLock builds to the committed artifact ($(($(echo -n "$built" | wc -c) / 2 - 1)) bytes of runtime code)"
}

wait_receipt() { # wait_receipt <hash> -> receipt JSON once mined
  local i
  for i in $(seq 1 150); do
    if "$CAST" receipt --async "$1" --json 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

# What a deployment costs now: "<gas> <gas price wei> <L1 fee wei> <total wei>" (read-only).
deploy_cost() {
  local deployer=$1 code gas price l1 size
  code="0x$(artifact_field bytecode | sed 's/^0x//')"
  gas=$(retry "$CAST" estimate --from "$deployer" --create "$code") || gas=1900000
  price=$(retry "$CAST" gas-price) || price=0
  size=$(((${#code} - 2) / 2 + 120))
  # OP Stack GasPriceOracle: an upper bound of the L1 data fee for a transaction this size
  l1=$(ccall 0x420000000000000000000000000000000000000F "getL1FeeUpperBound(uint256)(uint256)" "$size" | awk '{print $1}') || l1=0
  echo "$gas $price $l1 $(python3 -c 'import sys; g, p, l = map(int, sys.argv[1:]); print(g * p * 12 // 10 + l)' "$gas" "$price" "$l1")"
}

cmd_deploy() {
  need_foundry
  check_chain
  local deployer lock tx receipt
  deployer=$(addr_of deployer)
  if lock=$(recorded_lock); then
    log "FerryLock is already deployed at $lock (the code there is this build's)"
    return 0
  fi
  [ -s "$STATE/ferrylock" ] && log "the recorded FerryLock $(cat "$STATE/ferrylock") has no FerryLock code on this RPC: deploying again"
  check_artifact
  if [ -s "$STATE/deploy.tx" ]; then
    tx=$(cat "$STATE/deploy.tx")
    log "waiting for the earlier deployment $tx"
  else
    local wei cost gas price l1 total eth_usd
    wei=$(eth_wei "$deployer") || die "cannot read the deployer's balance"
    [ "$wei" != 0 ] || die "the deployer $deployer has no ETH on BASE MAINNET (chain 8453); send it $DEPLOYER_ETH ETH on Base (infra/mainnet-demo.sh status)"
    read -r gas price l1 total <<<"$(deploy_cost "$deployer")"
    eth_usd=$(market_json | python3 -c 'import json, sys; print(json.load(sys.stdin).get("eth", 0))' 2>/dev/null || echo 0)
    log "deploying FerryLock from $deployer (balance $(fmt_eth "$wei") ETH)"
    log "  cost now: about $gas gas x $(python3 -c 'import sys; print(int(sys.argv[1]) / 1e9)' "$price") gwei + an L1 data fee of at most $(fmt_eth "$l1") ETH = at most $(fmt_eth "$total") ETH ($(python3 -c 'import sys; print("$%.4f" % (int(sys.argv[1]) / 1e18 * float(sys.argv[2])))' "$total" "$eth_usd"))"
    ge "$wei" "$total" || die "the deployer has $(fmt_eth "$wei") ETH; the deployment needs about $(fmt_eth "$total") ETH now"
    confirm "This deploys FerryLock on BASE MAINNET (chain 8453) from $deployer and spends real ETH (at most $(fmt_eth "$total") ETH)."
    tx=$("$CAST" send --async --keystore "$STATE/deployer.json" --password-file "$STATE/deployer.pass" \
      --create "0x$(artifact_field bytecode | sed 's/^0x//')") ||
      die "sending the deployment failed"
    echo "$tx" >"$STATE/deploy.tx"
    log "sent $tx"
  fi
  receipt=$(wait_receipt "$tx") || die "no receipt for $tx after 5 minutes; run deploy again to keep waiting"
  lock=$(echo "$receipt" | python3 -c '
import json, sys
r = json.load(sys.stdin)
if int(r["status"], 16) != 1:
    sys.exit("the deployment reverted")
print(r["contractAddress"])') || { rm -f "$STATE/deploy.tx"; die "the deployment $tx failed"; }
  lock=$("$CAST" to-check-sum-address "$lock")
  lock_code_matches "$lock" || die "the code at $lock is not this build's FerryLock"
  echo "$lock" >"$STATE/ferrylock"
  rm -f "$STATE/deploy.tx"
  local used
  used=$(echo "$receipt" | python3 -c '
import json, sys
r = json.load(sys.stdin)
g = int(r["gasUsed"], 16)
p = int(r.get("effectiveGasPrice", "0x0"), 16)
l1 = int(r.get("l1Fee", "0x0") or "0x0", 16)
print("%d gas, %.7f ETH with the L1 fee" % (g, (g * p + l1) / 1e18))')
  log "FerryLock deployed at $lock; its code matches this build ($used)"
  echo "  contract  $(addr_link "$lock")"
  echo "  tx        $(tx_link "$tx")"
  [ -z "$FORK" ] || echo "  (an anvil fork: these links exist only locally)"
}

# ------------------------------------------------------------------ status

# zec_balances <z|b> -> "total ironwood orchard sapling transparent tip" in zat, or nothing
zec_balances() {
  local key=$1 dir
  if alive "$key"; then
    api "$key" /api/status | python3 -c '
import json, sys
s = json.load(sys.stdin)
b = s["balances"]["zec_shielded_zat"]
print(b, b, 0, 0, 0, s["chains"]["zec"]["height"])' 2>/dev/null
    return 0
  fi
  [ "$ZEC_BACKEND" = devtool ] || return 0
  dir=$(zec_wallet_dir "$key")
  [ -f "$dir/keys.toml" ] && [ -x "$ZEC_DEVTOOL" ] || return 0
  "$ZEC_DEVTOOL" wallet -w "$dir" sync -s "$ZEC_SERVER" >/dev/null 2>&1 || return 0
  "$ZEC_DEVTOOL" wallet -w "$dir" balance --json 2>/dev/null | python3 -c '
import json, sys
b = json.loads(sys.stdin.read().strip().splitlines()[-1])
print(b["total"], b["ironwood_spendable"], b["orchard_spendable"], b["sapling_spendable"],
      b["transparent_spendable"], b["chain_tip_height"])' 2>/dev/null || true
}

cmd_status() {
  need_foundry
  local id head now
  id=$(retry "$CAST" chain-id 2>/dev/null) || { echo "Base RPC $(redacted "$EVM_RPC"): unreachable"; id=; }
  if [ -n "$id" ]; then
    head=$(retry "$CAST" block-number)
    now=$(chain_time)
    if [ "$id" = "$CHAIN_ID" ]; then
      echo "BASE MAINNET (chain $id) via $(redacted "$EVM_RPC")$(is_anvil && echo ' (an anvil FORK: nothing here is real)'): block $head, time $now"
    else
      echo "WARNING: $(redacted "$EVM_RPC") is chain $id, not Base mainnet ($CHAIN_ID)"
    fi
    if ! is_anvil && [ "$id" = "$CHAIN_ID" ]; then
      if RPC_TRIES=3 retry "$CAST" logs --address "$USDC" --from-block "$head" --to-block "$head" 'Approval(address indexed,address indexed,uint256)' >/dev/null 2>&1; then
        echo "  eth_getLogs answers (ferryd needs it)"
      else
        echo "  WARNING: this RPC refuses eth_getLogs; ferryd needs it. Put a provider URL in $STATE/base-rpc (chmod 600) or set EVM_RPC"
      fi
    fi
  fi
  if [ ! -s "$STATE/b.addr" ]; then
    echo "No accounts yet: run infra/mainnet-demo.sh keys"
    return 0
  fi
  local lock=""
  if [ -n "$id" ] && lock=$(recorded_lock); then
    echo "FerryLock   $lock (code matches this build)  $(addr_link "$lock")"
  elif [ -s "$STATE/ferrylock" ]; then
    echo "FerryLock   recorded at $(cat "$STATE/ferrylock") but there is no FerryLock code there on this RPC"
    lock=""
  else
    echo "FerryLock   not deployed yet (infra/mainnet-demo.sh deploy, after funding the deployer)"
  fi
  # the rate: the one B runs at, else what `up` would set now
  local m rate price
  m=$(market_json 2>/dev/null || echo '{}')
  price=$(echo "$m" | python3 -c 'import json, sys; m = json.load(sys.stdin); print("%.2f" % m["zec"] if "zec" in m else "?")')
  if [ -n "$RATE" ]; then rate=$RATE; elif alive b && [ -s "$STATE/rate" ]; then rate=$(cat "$STATE/rate"); else rate=$(market_rate "$m" 2>/dev/null || echo ""); fi
  echo "ZEC         \$$price (1Click); B buys at $([ -n "$rate" ] && fmt_usdc "$rate" || echo '?') USDC per ZEC ($SPREAD_BPS bps under)"
  local need_usdc="" need_zat=$((SWAP_ZAT + ZEC_FEE_RESERVE_ZAT))
  [ -n "$rate" ] && need_usdc=$(python3 -c 'import sys; print(-(-int(sys.argv[1]) * int(sys.argv[2]) // 100000000))' "$SWAP_ZAT" "$rate")
  local todo=()
  printf '%-9s %-44s %14s %12s\n' "" "BASE MAINNET account (chain 8453)" "ETH" "USDC"
  local who addr wei usdc min fund why
  for who in deployer b z; do
    addr=$(addr_of "$who")
    wei=?
    usdc=?
    if [ -n "$id" ]; then
      wei=$(eth_wei "$addr" || echo ?)
      usdc=$(usdc_units "$addr" || echo ?)
    fi
    printf '%-9s %-44s %14s %12s\n' "$(who_name "$who")" "$addr" \
      "$([ "$wei" = ? ] && echo ? || fmt_eth "$wei")" "$([ "$usdc" = ? ] && echo ? || fmt_usdc "$usdc")"
    case $who in
      deployer) min=$DEPLOYER_MIN_ETH fund=$DEPLOYER_ETH why="gas to deploy FerryLock once" ;;
      b) min=$B_MIN_ETH fund=$B_ETH why="gas for B's approve + lock (and a refund if it comes to that)" ;;
      z) min=$Z_MIN_ETH fund=$Z_ETH why="gas for Z's claim" ;;
    esac
    if [ "$who" = deployer ] && [ -n "$lock" ]; then
      :
    elif [ "$wei" = ? ] || ! ge "$wei" "$("$CAST" to-wei "$min")"; then
      todo+=("$(who_name "$who") $addr: $fund ETH on BASE MAINNET (chain 8453); $why. It has less than $min ETH")
    fi
    if [ "$who" = b ] && { [ "$usdc" = ? ] || [ -z "$need_usdc" ] || [ "$usdc" -lt "$need_usdc" ]; }; then
      local send
      send=$([ -n "$need_usdc" ] && python3 -c 'import sys, math; print(math.ceil(int(sys.argv[1]) * 1.1 / 1e6))' "$need_usdc" || echo '?')
      todo+=("B $addr: $send USDC on BASE MAINNET (Circle's USDC, $USDC); the USDC B locks for Z, which NEAR Intents turns into your asset. A $(cast_zec "$SWAP_ZAT") ZEC sell needs $([ -n "$need_usdc" ] && fmt_usdc "$need_usdc" || echo '?') USDC; send about 10% more in case the price moves")
    fi
  done
  if [ "$ZEC_BACKEND" = devtool ]; then
    echo "ZCASH MAINNET wallets via $ZEC_SERVER$(alive z || alive b || echo ' (syncing them now; this can take a minute)'):"
    local bal total iw orch sap tr tip zaddr
    for who in z b; do
      zaddr=$(zec_address "$who" || echo "(no wallet: run keys)")
      bal=$(zec_balances "$who")
      if [ -n "$bal" ]; then
        read -r total iw orch sap tr tip <<<"$bal"
        printf '  %s  %s ZEC in all, %s spendable in Ironwood (Orchard %s, Sapling %s, transparent %s), tip %s\n      %s\n' \
          "$(who_name "$who")" "$(cast_zec "$total")" "$(cast_zec "$iw")" "$(cast_zec "$orch")" "$(cast_zec "$sap")" \
          "$(cast_zec "$tr")" "$tip" "$zaddr"
      else
        total=0 iw=0 orch=0 sap=0 tr=0
        printf '  %s  balance unknown\n      %s\n' "$(who_name "$who")" "$zaddr"
      fi
      if [ "$who" = z ] && [ "$iw" -lt "$need_zat" ]; then
        if [ "$((orch + sap + tr))" -gt 0 ]; then
          todo+=("Z: its ZEC is in Orchard, Sapling or transparent, not Ironwood: Ferry locks Ironwood notes only. Send it again from a wallet that sends Ironwood (NU6.3) notes")
        elif [ -n "$bal" ] && [ "$total" -ge "$need_zat" ]; then
          todo+=("Z: its ZEC is not spendable yet (zcash-devtool waits for 10 confirmations, about 13 minutes)")
        else
          todo+=("Z $zaddr: $(cast_zec "$need_zat") ZEC on ZCASH MAINNET, shielded; the $(cast_zec "$SWAP_ZAT") ZEC it sells plus $(cast_zec $ZEC_FEE_RESERVE_ZAT) for the lock's fee. Spendable after 10 confirmations (about 13 min)")
        fi
      fi
    done
  else
    echo "Zcash: mock backend (fork rehearsal)"
  fi
  local key
  for key in z b; do
    if alive "$key"; then
      api "$key" /api/swaps | python3 -c '
import json, sys
role = sys.argv[1]
for s in json.load(sys.stdin):
    print("  %s swap %s...  %-16s outcome %s" % (role, s["id"][:12], s["state"], s["outcome"]))' "$(who_name "$key")"
      echo "ferryd $(who_name "$key") up (pid $(cat "$STATE/$key.pid"))"
    else
      echo "ferryd $(who_name "$key") down"
    fi
  done
  if alive ui; then echo "UI server up: http://127.0.0.1:$UI_PORT (NEAR Intents swaps on, loopback only)"; else echo "UI server down"; fi
  echo
  if [ ${#todo[@]} -eq 0 ]; then
    if [ -n "$lock" ] && alive z && alive b && alive ui; then
      echo "Funded, deployed and running. Next: infra/mainnet-demo.sh sell <asset> <recipient>"
    elif [ -n "$lock" ]; then
      echo "Funded and deployed. Next: infra/mainnet-demo.sh up"
    else
      echo "Funded. Next: infra/mainnet-demo.sh deploy"
    fi
  else
    echo "Still to fund (real money: only these addresses, only these networks):"
    local t
    for t in "${todo[@]}"; do echo "  - $t"; done
    echo "BASE MAINNET is chain id 8453, an Ethereum L2. It is NOT Ethereum mainnet: ETH or USDC sent on"
    echo "Ethereum mainnet to these addresses does not arrive. From an exchange, withdraw on the \"Base\" network."
  fi
}

# ------------------------------------------------------------------ daemons

api() { # api <z|b> <path> [curl args...]
  local key=$1 path=$2 port=$Z_PORT token
  shift 2
  [ "$key" = b ] && port=$B_PORT
  token=$(cat "$STATE/$key/api-token" 2>/dev/null) || return 1
  curl -sf -m 30 -H "authorization: Bearer $token" "$@" "http://127.0.0.1:$port$path"
}

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

start_ferryd() { # start_ferryd <key> <role> <name> <api port> <peer port> [extra args...]
  local key=$1 role=$2 name=$3 port=$4 peer_port=$5 lock
  shift 5
  lock=$(cat "$STATE/ferrylock")
  local zec_args=()
  case "$ZEC_BACKEND" in
    mock) zec_args=(--zec mock --zec-network "$ZEC_NETWORK" --zec-mock-file "$STATE/zec-mock.json"
      --zec-mock-block-secs "$ZEC_MOCK_BLOCK_SECS") ;;
    devtool)
      zec_args=(--zec devtool --zec-network "$ZEC_NETWORK" --zec-server "$ZEC_SERVER"
        --zec-devtool "$ZEC_DEVTOOL" --zec-signer "$ZEC_SIGNER")
      [ -n "$ZEC_NODE_RPC" ] && zec_args+=(--zec-node-rpc "$ZEC_NODE_RPC") ;;
    *) die "ZEC_BACKEND must be devtool or mock" ;;
  esac
  local extra=()
  [ -n "$FAULTS" ] && extra+=(--demo-faults)
  # shellcheck disable=SC2206
  extra+=(${FERRYD_ARGS:-})
  "$FERRYD" --counter evm --role "$role" --name "$name" --api-listen "127.0.0.1:$port" \
    --listen "127.0.0.1:$peer_port" --data-dir "$STATE/$key" "${zec_args[@]}" \
    --evm-rpc-file "$STATE/evm-rpc" --evm-contract "$lock" --evm-token "$USDC" --evm-key-file "$STATE/$key.key" \
    --evm-token-symbol USDC --evm-token-decimals 6 \
    --evm-t1-secs "$T1_SECS" --evm-refund-secs "$REFUND_SECS" --evm-delta-secs "$DELTA_SECS" \
    --evm-lock-confs "$LOCK_CONFS" --evm-log-chunk "$LOG_CHUNK" --zec-confs "$ZEC_CONFS" \
    --poll-ms "$POLL_MS" "$@" ${extra[@]+"${extra[@]}"} >>"$STATE/logs/$key.log" 2>&1 &
  echo $! >"$STATE/$key.pid"
  disown
  for _ in $(seq 1 240); do
    api "$key" /api/status >/dev/null 2>&1 && return 0
    alive "$key" || break
    sleep 0.5
  done
  tail -n 20 "$STATE/logs/$key.log" >&2
  die "ferryd $key did not come up (log: $STATE/logs/$key.log)"
}

mock_pubkey() {
  "$NODE" --input-type=module -e "import { MOCK_ONE_CLICK_PUBKEY } from '$ROOT/web/mock/oneclick.mjs'; console.log(MOCK_ONE_CLICK_PUBKEY)"
}

# The UI server (web/server/prod.mjs) with NEAR Intents swaps on, on loopback only, in a clean
# environment: nothing from the caller's shell reaches it but what is set here.
start_ui() {
  local near_env=(FERRY_NEAR_URL="$ONE_CLICK" FERRY_NEAR_TESTNET=0 DEMO_RATE_PER_HOUR=3 DEMO_SWAPS_PER_HOUR=3)
  if [ -n "$FORK" ]; then
    near_env=(FERRY_NEAR_URL="http://127.0.0.1:$NEAR_PORT" FERRY_NEAR_PUBKEY="$(mock_pubkey)" DEMO_RATE_PER_HOUR=30 DEMO_SWAPS_PER_HOUR=30)
  fi
  [ -s "$STATE/near-jwt" ] && near_env+=(FERRY_NEAR_JWT_FILE="$STATE/near-jwt")
  [ -f "$ROOT/web/dist/index.html" ] || warn "web/dist is not built: the API works, but for the UI run (cd web && pnpm build) and \`down\`/\`up\`"
  env -i PATH="$PATH" HOME="$HOME" PORT="$UI_PORT" HOST=127.0.0.1 DIST="$ROOT/web/dist" \
    FERRY_Z_URL="http://127.0.0.1:$Z_PORT" FERRY_B_URL="http://127.0.0.1:$B_PORT" \
    FERRY_Z_TOKEN_FILE="$STATE/z/api-token" FERRY_B_TOKEN_FILE="$STATE/b/api-token" \
    FERRY_MAKER_URL="$MAKER_URL" \
    FERRY_MAKERS="[{\"name\":\"$B_NAME\",\"url\":\"$MAKER_URL\",\"pair\":\"ZEC/USDC\",\"chain\":\"base\"}]" \
    FERRY_Z_SELLS=1 FERRY_B_BUYS=0 FERRY_NEAR=1 FERRY_NEAR_STATE="$STATE/near-jobs.json" \
    FERRY_NEAR_SELL_DEADLINE_SECS="$NEAR_SELL_DEADLINE_SECS" \
    DEMO_MAX_ZAT="$MAX_ZAT" DEMO_MIN_ZAT="$MIN_ZAT" DEMO_FAULTS=0 \
    "${near_env[@]}" \
    "$NODE" "$ROOT/web/server/prod.mjs" "--ferry-mainnet-demo=$STATE" >>"$STATE/logs/ui.log" 2>&1 &
  echo $! >"$STATE/ui.pid"
  disown
  for _ in $(seq 1 60); do
    curl -sf -m 5 "http://127.0.0.1:$UI_PORT/healthz" >/dev/null 2>&1 && return 0
    alive ui || break
    sleep 0.5
  done
  tail -n 20 "$STATE/logs/ui.log" >&2
  die "the UI server did not come up (log: $STATE/logs/ui.log)"
}

start_near_mock() {
  env -i PATH="$PATH" HOME="$HOME" MOCK_NEAR_PORT="$NEAR_PORT" MOCK_NEAR_SPEED=1 \
    "$NODE" "$ROOT/web/mock/oneclick.mjs" "--ferry-mainnet-demo=$STATE" >>"$STATE/logs/near.log" 2>&1 &
  echo $! >"$STATE/near.pid"
  disown
  for _ in $(seq 1 40); do
    curl -sf -m 5 "http://127.0.0.1:$NEAR_PORT/v0/tokens" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  die "the mock 1Click did not come up (log: $STATE/logs/near.log)"
}

cmd_up() {
  if alive z || alive b || alive ui; then
    die "already running (infra/mainnet-demo.sh status); run infra/mainnet-demo.sh down first"
  fi
  need_foundry
  need_node
  check_cap MAX_ZAT "$MAX_ZAT"
  check_cap MIN_ZAT "$MIN_ZAT"
  [ "$MIN_ZAT" -le "$MAX_ZAT" ] || die "MIN_ZAT is above MAX_ZAT"
  check_chain
  [ -n "$FORK" ] || check_logs_rpc
  [ -s "$STATE/b.key" ] && [ -s "$STATE/z.key" ] || die "no keys: run infra/mainnet-demo.sh keys"
  recorded_lock >/dev/null || die "FerryLock is not deployed on this RPC: run infra/mainnet-demo.sh deploy"
  local p
  for p in "$Z_PORT" "$B_PORT" "$Z_PEER_PORT" "$B_PEER_PORT" "$UI_PORT"; do
    port_free "$p" || die "port $p is in use (set Z_PORT, B_PORT, Z_PEER_PORT, B_PEER_PORT, UI_PORT)"
  done
  mkdir -p "$STATE/logs" "$STATE/z" "$STATE/b"
  # ferryd reads the RPC from a file only we can read (--evm-rpc-file), so an API key in it stays
  # out of `ps`
  printf '%s\n' "$EVM_RPC" >"$STATE/evm-rpc"
  chmod 600 "$STATE/evm-rpc"
  if [ -z "${FERRYD_SKIP_BUILD:-}" ]; then
    log "building ferryd"
    (cd "$ROOT" && cargo build -q -p ferryd) || die "cargo build failed"
  fi
  if [ "$ZEC_BACKEND" = devtool ]; then
    [ -x "$ZEC_DEVTOOL" ] || die "zcash-devtool not found at $ZEC_DEVTOOL (set ZEC_DEVTOOL)"
    [ -f "$(zec_wallet_dir z)/keys.toml" ] && [ -f "$(zec_wallet_dir b)/keys.toml" ] ||
      die "no Zcash wallets: run infra/mainnet-demo.sh keys"
    if [ ! -x "$ZEC_SIGNER" ]; then
      log "building ferry-zec-signer"
      (cd "$ROOT/tools/ferry-zec-signer" && cargo build -q --release) || die "building ferry-zec-signer failed"
    fi
  fi
  # B's rate: given, or the market's less SPREAD_BPS (both sources read-only)
  local m market
  m=$(market_json)
  market=$(market_rate "$m") || die "can't set a rate from the market (set RATE=<USDC units per ZEC>)"
  if [ -z "$RATE" ]; then
    RATE=$market
  elif ! python3 -c 'import sys; r, m = int(sys.argv[1]), int(sys.argv[2]); sys.exit(0 if abs(r - m) * 10 <= m else 1)' "$RATE" "$market"; then
    die "RATE=$RATE is more than 10% away from the market ($market): check it"
  fi
  echo "$RATE" >"$STATE/rate"
  local mock_z=()
  [ "$ZEC_BACKEND" = mock ] && mock_z=(--zec-mock-balance "$ZEC_MOCK_BALANCE")
  log "starting B ($B_NAME, maker at $(fmt_usdc "$RATE") USDC per ZEC, $(cast_zec "$MIN_ZAT")-$(cast_zec "$MAX_ZAT") ZEC): API :$B_PORT, peer 127.0.0.1:$B_PEER_PORT"
  start_ferryd b b "$B_NAME" "$B_PORT" "$B_PEER_PORT" --maker-offer "$RATE:$MIN_ZAT:$MAX_ZAT"
  log "starting Z ($Z_NAME): API :$Z_PORT, peer 127.0.0.1:$Z_PEER_PORT"
  start_ferryd z z "$Z_NAME" "$Z_PORT" "$Z_PEER_PORT" ${mock_z[@]+"${mock_z[@]}"}
  if [ -n "$FORK" ]; then
    log "fork: starting the mock 1Click on 127.0.0.1:$NEAR_PORT"
    start_near_mock
  fi
  log "starting the UI server on http://127.0.0.1:$UI_PORT (NEAR Intents swaps on: FERRY_NEAR=1, $([ -n "$FORK" ] && echo "the mock 1Click" || echo "$ONE_CLICK"))"
  start_ui
  local info
  info=$(curl -sf -m 30 "http://127.0.0.1:$UI_PORT/api/near/tokens") || die "the UI server doesn't answer /api/near/tokens"
  echo "$info" | python3 -c '
import json, sys
i = json.load(sys.stdin)
if not i.get("available"):
    sys.exit("NEAR Intents (1Click) is not reachable from the UI server")
if not i["execution"]["sell"]:
    sys.exit("the UI server would not run NEAR sells here (reason: %s)" % i.get("reason"))
print("[mainnet-demo] NEAR Intents: %d tokens listed; sells run here" % len(i["tokens"]))' || die "the NEAR Intents check failed"
  cat >"$STATE/env" <<ENV
export FERRY_Z_URL=http://127.0.0.1:$Z_PORT
export FERRY_B_URL=http://127.0.0.1:$B_PORT
export FERRY_MAKER_URL=$MAKER_URL
export FERRY_UI_URL=http://127.0.0.1:$UI_PORT
ENV
  log "ready: Z :$Z_PORT, B :$B_PORT (maker $MAKER_URL), UI http://127.0.0.1:$UI_PORT, FerryLock $(cat "$STATE/ferrylock"), Base via $(redacted "$EVM_RPC"), ZEC: $ZEC_BACKEND/$ZEC_NETWORK$([ "$ZEC_BACKEND" = devtool ] && echo " via $ZEC_SERVER")"
}

cmd_down() {
  stop_pid ui
  stop_pid near
  stop_pid z
  stop_pid b
  log "stopped the daemons and the UI server (logs in $STATE/logs)"
}

# ------------------------------------------------------------------ sell

# resolve_asset <SYMBOL|SYMBOL@chain|asset id> -> the token JSON from the UI server's list
resolve_asset() {
  curl -sf -m 30 "http://127.0.0.1:$UI_PORT/api/near/tokens" | python3 -c '
import json, sys
want = sys.argv[1]
toks = json.load(sys.stdin)["tokens"]
hit = [t for t in toks if t["assetId"] == want]
if not hit:
    sym, _, chain = want.partition("@")
    hit = [t for t in toks if t["symbol"].lower() == sym.lower() and (not chain or t["blockchain"] == chain.lower())]
if not hit:
    sys.exit("NEAR Intents lists no %s" % want)
if len(hit) > 1:
    sys.exit("%s is on several chains: say which, e.g. %s" % (want, ", ".join("%s@%s" % (t["symbol"], t["blockchain"]) for t in hit[:8])))
print(json.dumps(hit[0]))' "$1"
}

cmd_sell() {
  local asset_arg=${1:-} recipient=${2:-} zec=${3:-}
  [ -n "$asset_arg" ] && [ -n "$recipient" ] ||
    die "usage: infra/mainnet-demo.sh sell <asset> <recipient-address> [zec], e.g. sell SOL@sol <your Solana address> 0.01"
  if [ -n "$zec" ]; then SWAP_ZAT=$(zat_of "$zec") || die "$zec is not an amount of ZEC"; fi
  check_cap SWAP_ZAT "$SWAP_ZAT"
  need_foundry
  need_node
  alive z && alive b && alive ui || die "not running: infra/mainnet-demo.sh up"
  check_chain
  mkdir -p "$STATE/evidence"
  local tag
  tag=$(date -u +%Y%m%dT%H%M%SZ)
  # everything from here on is kept, for the record (addresses and links; never a key)
  exec > >(tee -a "$STATE/evidence/sell-$tag.log") 2>&1

  local zs bs token
  zs=$(api z /api/status) || die "Z's API did not answer"
  bs=$(api b /api/status) || die "B's API did not answer"
  token=$(resolve_asset "$asset_arg") || die "pick an asset NEAR Intents lists (SOL@sol, USDC@sol, ...; infra/mainnet-demo.sh near-check)"
  # preflight: funds, gas, the offer's range (the UI server also waits for an idle pair)
  python3 - "$zs" "$bs" "$SWAP_ZAT" "$ZEC_FEE_RESERVE_ZAT" "$("$CAST" to-wei "$Z_MIN_ETH")" "$("$CAST" to-wei "$B_MIN_ETH")" <<'PY' || die "not ready to sell (above)"
import json, sys
z, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
zat, reserve, zmin, bmin = map(int, sys.argv[3:7])
bad = []
if z["balances"]["zec_shielded_zat"] < zat + reserve:
    bad.append("Z has %.8f ZEC spendable in Ironwood; the sell needs %.8f (the amount plus fees)" % (z["balances"]["zec_shielded_zat"] / 1e8, (zat + reserve) / 1e8))
rate = b["offer"]["rate_sat_per_zec"]
need = -(-zat * rate // 100000000)
if int(b["balances"]["token_units"]) < need:
    bad.append("B has %s USDC; this sell needs %.6f" % (int(b["balances"]["token_units"]) / 1e6, need / 1e6))
if int(z["balances"]["eth_wei"]) < zmin:
    bad.append("Z has too little ETH on Base for the claim's gas")
if int(b["balances"]["eth_wei"]) < bmin:
    bad.append("B has too little ETH on Base for the lock's gas")
if not (b["offer"]["min_zat"] <= zat <= b["offer"]["max_zat"]):
    bad.append("B's offer takes %.8f-%.8f ZEC" % (b["offer"]["min_zat"] / 1e8, b["offer"]["max_zat"] / 1e8))
if "payout" not in z.get("features", []):
    bad.append("Z's ferryd has no payout feature")
for m in bad:
    print("[mainnet-demo]   " + m, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
  local asset sym
  asset=$(echo "$token" | python3 -c 'import json, sys; print(json.load(sys.stdin)["assetId"])')
  sym=$(echo "$token" | python3 -c 'import json, sys; t = json.load(sys.stdin); print(t["symbol"] + " on " + t["blockchain"])')
  log "selling $(cast_zec "$SWAP_ZAT") shielded ZEC for $sym ($asset), delivered to $recipient"
  local q code
  q=$(curl -s -m 60 -w '\n%{http_code}' -H 'content-type: application/json' \
    -d "{\"direction\":\"sell\",\"zec_zat\":$SWAP_ZAT,\"asset\":\"$asset\",\"address\":$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$recipient"),\"exact\":true}" \
    "http://127.0.0.1:$UI_PORT/api/near/quote") || die "the UI server did not answer"
  code=$(echo "$q" | tail -n 1)
  q=$(echo "$q" | sed '$d')
  [ "$code" = 200 ] || die "no quote (HTTP $code): $q"
  local min_out via
  read -r min_out via < <(python3 - "$q" "$token" "$NEAR_SELL_DEADLINE_SECS" "$([ -n "$FORK" ] && echo 'the mock 1Click (fork)' || echo "NEAR Intents' 1Click")" <<'PY'
import json, sys, time
q, t, ttl, who = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
f, n = q["ferry"], q["near"]
def amt(v, d, s):
    x = ("%.*f" % (d, int(v) / 10 ** d)).rstrip("0").rstrip(".")
    return "%s %s" % (x, s)
usdc_in = int(n["amount_in"])
out, mn = int(n["amount_out"]), int(n["min_amount_out"])
p = t.get("price")
print("", file=sys.stderr)
print("  Part 1, Ferry (atomic swap, %s with %s)" % (q["via"], q["maker"]), file=sys.stderr)
print("    you sell      %s ZEC, shielded, from Z's Ironwood notes (Zcash mainnet)" % (q["zec_zat"] / 1e8), file=sys.stderr)
print("    rate          %s USDC per ZEC" % (f["rate_sat_per_zec"] / 1e6), file=sys.stderr)
print("    B locks       %s in FerryLock on Base mainnet; Z's claim pays it to NEAR Intents' deposit address" % amt(f["counter"], 6, "USDC"), file=sys.stderr)
print("    fees          the ZEC lock's network fee (about 0.0001 ZEC, ZIP-317) and Base gas for the claim (under $0.01)", file=sys.stderr)
print("  Part 2, NEAR Intents (%s; quote signed by 1Click%s)" % (who, ", signature checked" if n.get("verified") else ""), file=sys.stderr)
print("    in            %s" % amt(usdc_in, 6, "USDC"), file=sys.stderr)
print("    out           %s (at least %s with 1%% slippage)" % (amt(out, t["decimals"], t["symbol"]), amt(mn, t["decimals"], t["symbol"])), file=sys.stderr)
if n.get("withdraw_fee"):
    print("    withdrawal    %s, already taken from the amount out" % amt(n["withdraw_fee"], t["decimals"], t["symbol"]), file=sys.stderr)
if p:
    fee = usdc_in / 1e6 - out / 10 ** t["decimals"] * p
    print("    NEAR's cost   about $%.4f (%.2f%%: 1Click's fee, the swap and the withdrawal, at 1Click's prices)" % (fee, 100 * fee / (usdc_in / 1e6)), file=sys.stderr)
print("    time          about %d s for NEAR Intents, %d s in all (Ferry's part on mainnet is 15-25 min)" % (n["time_s"], q["time_s"]), file=sys.stderr)
print("    deadline      the real quote asked for at the start stays open until %s (%d h)" % (time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(time.time() + ttl)), ttl // 3600), file=sys.stderr)
print("    refunds       if NEAR Intents can't fill it, the USDC goes back to Z's own Base address", file=sys.stderr)
print("", file=sys.stderr)
print(mn, q["via"])
PY
)
  [ -n "$min_out" ] || die "could not read the quote"
  confirm "This sells $(cast_zec "$SWAP_ZAT") real ZEC and locks real USDC: Z's claim pays NEAR Intents, which pays $sym to $recipient. You agree to at least the minimum shown above; the start is refused if NEAR Intents' real quote promises less."
  local r job
  r=$(curl -s -m 120 -w '\n%{http_code}' -H 'content-type: application/json' \
    -d "{\"direction\":\"sell\",\"zec_zat\":$SWAP_ZAT,\"asset\":\"$asset\",\"address\":$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$recipient"),\"via\":\"$via\",\"min_out\":\"$min_out\"}" \
    "http://127.0.0.1:$UI_PORT/api/near/swap") || die "the UI server did not answer"
  code=$(echo "$r" | tail -n 1)
  r=$(echo "$r" | sed '$d')
  [ "$code" = 201 ] || die "the sell did not start (HTTP $code): $r"
  job=$(python3 - "$r" "$recipient" "$(addr_of z)" <<'PY'
import json, sys
j = json.loads(sys.argv[1])
sys.argv = sys.argv[1:]
n = j["near"]
t = j["asset"]
def amt(v, d, s):
    return "%s %s" % (("%.*f" % (d, int(v) / 10 ** d)).rstrip("0").rstrip("."), s)
print("", file=sys.stderr)
print("  Started NEAR sell %s (Ferry swap %s)" % (j["id"], j["ferry"]["swap_id"]), file=sys.stderr)
print("  NEAR Intents' real quote (signed; %s):" % ("signature checked" if n["verified"] else "signature NOT checked"), file=sys.stderr)
print("    deposit address  %s  (Z's claim pays the USDC here)" % n["deposit_address"], file=sys.stderr)
print("    in               %s (it starts from %s)" % (amt(n["amount_in"], 6, "USDC"), amt(n["min_amount_in"], 6, "USDC")), file=sys.stderr)
print("    out              %s, at least %s, to %s" % (amt(n["amount_out"], t["decimals"], t["symbol"]) if n.get("amount_out") else "?", amt(n["min_amount_out"], t["decimals"], t["symbol"]), j["address"]), file=sys.stderr)
print("    deadline         %s" % n["deadline"], file=sys.stderr)
print("    refunds to       %s (Z's own Base address)" % j["own_address"], file=sys.stderr)
print("    correlation id   %s" % n.get("correlation_id"), file=sys.stderr)
if j["address"] != sys.argv[1]:
    sys.exit("the job names another recipient")
if j["own_address"].lower() != sys.argv[2].lower():
    sys.exit("NEAR refunds would not go to Z's own address")
print(j["id"])
PY
) || die "the started job does not match what was asked: stop and look (infra/mainnet-demo.sh follow)"
  follow_job "$job"
}

# follow_job <job id>: both parts to the end, every transaction with its link; MODE (fork only)
# drives the failure rehearsals; EXPECT is the job state that counts as success.
follow_job() {
  local job=$1
  mkdir -p "$STATE/evidence"
  JOB="$job" UI_URL="http://127.0.0.1:$UI_PORT" Z_URL="http://127.0.0.1:$Z_PORT" B_URL="http://127.0.0.1:$B_PORT" \
    Z_TOKEN_FILE="$STATE/z/api-token" B_TOKEN_FILE="$STATE/b/api-token" RPC_URL="$EVM_RPC" USDC="$USDC" \
    EXPLORER="$EXPLORER" ZEC_EXPLORER="$ZEC_EXPLORER" NEAR_EXPLORER="$NEAR_EXPLORER" FORK="${FORK:-}" \
    NEAR_MOCK_URL="http://127.0.0.1:$NEAR_PORT" MODE="${MODE:-happy}" EXPECT="${EXPECT:-done}" \
    LOCK_CONFS="$LOCK_CONFS" ZEC_CONFS="$ZEC_CONFS" EVIDENCE="$STATE/evidence" FOLLOW_SECS="${FOLLOW_SECS:-28800}" B_GRACE_SECS="${B_GRACE_SECS:-1200}" \
    python3 - <<'PY'
import json, os, sys, time, urllib.request, urllib.error
from datetime import datetime

E = os.environ
JOB, UI, Z, B = E["JOB"], E["UI_URL"], E["Z_URL"], E["B_URL"]
ZT, BT = open(E["Z_TOKEN_FILE"]).read().strip(), open(E["B_TOKEN_FILE"]).read().strip()
FORK, MODE, EXPECT = E.get("FORK") == "1", E["MODE"], E["EXPECT"]
BASE, ZECX, NEARX = E["EXPLORER"], E["ZEC_EXPLORER"], E["NEAR_EXPLORER"]
ONLY = " (fork only)" if FORK else ""

def call(url, token=None, method="GET", body=None):
    h = {"accept": "application/json"}
    if token:
        h["authorization"] = "Bearer " + token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None

def rpc(method, params):
    r = call(E["RPC_URL"], method="POST", body={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    return None if r is None else r.get("result")

def usdc_of(addr):
    data = "0x70a08231" + addr.lower().replace("0x", "").rjust(64, "0")
    r = rpc("eth_call", [{"to": E["USDC"], "data": data}, "latest"])
    return int(r, 16) if r else None

def hhmm(at):
    return datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")

def ts(at):
    return datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp()

def link(chain, tx):
    if chain == "btc":
        return "Base tx   %s/tx/%s%s" % (BASE, tx, ONLY)
    if chain == "zec":
        return "Zcash tx  %s/%s%s  (shielded: the explorer shows the transaction and its fee, not who or how much)" % (ZECX, tx, ONLY)
    return "tx %s" % tx

shown, seen_tx = set(), set()
told = stalled = warped = False
start = time.time()
grace_from = None
job = z = b = None
while True:
    job = call(UI + "/api/near/status/" + JOB) or job
    if job is None:
        sys.exit("the UI server doesn't know job %s" % JOB)
    sid = job["ferry"].get("swap_id")
    if sid:
        z = call(Z + "/api/swaps/" + sid, ZT) or z
        b = call(B + "/api/swaps/" + sid, BT) or b
    entries = [(e["at"], "NEAR", i, e) for i, e in enumerate(job["timeline"])]
    for who, s in (("Z", z), ("B", b)):
        if s:
            entries += [(e["at"], who, i, e) for i, e in enumerate(s["timeline"])]
    for at, who, i, e in sorted(entries, key=lambda x: x[0]):
        if (who, i) in shown:
            continue
        shown.add((who, i))
        print("  %s %-4s %s" % (hhmm(at), who, e["label"]), flush=True)
        tx = e.get("txid")
        if tx and tx not in seen_tx:
            seen_tx.add(tx)
            print("                 " + link(e.get("chain"), tx), flush=True)
    d = (job["near"].get("details") or {})
    for kind, txs in (("origin", d.get("origin_txs") or []), ("destination", d.get("destination_txs") or [])):
        for t in txs:
            key = (kind, t["hash"])
            if key not in seen_tx:
                seen_tx.add(key)
                print("                 NEAR Intents %s tx %s%s" % (kind, t["url"] or t["hash"], ONLY), flush=True)
    # the fork's stand-in for 1Click watching its deposit address: once the real claim has paid it
    # on the fork, tell the mock
    if FORK and not told and job["state"] == "near":
        got = usdc_of(job["near"]["deposit_address"])
        if got:
            r = call(E["NEAR_MOCK_URL"] + "/_mock/deposit", method="POST", body={"depositAddress": job["near"]["deposit_address"], "amount": str(got)})
            print("  fork: the claim paid %.6f USDC into the deposit address on the fork; told the mock 1Click%s" % (got / 1e6, "" if r else " (it refused)"), flush=True)
            told = True
    if FORK and MODE == "ferry-refund":
        if not stalled and z and z["state"] == "ZecLocked":
            call(Z + "/api/swaps/%s/fault" % sid, ZT, "POST", {"fault": "stall"})
            stalled = True
            print("  fork: Z stops here and will not claim; B refunds at t1, then Z takes its ZEC back", flush=True)
        if stalled and not warped and b and b["state"] == "ReadySent":
            t1 = z["deadlines"]["t1_unix"]
            rpc("evm_setNextBlockTimestamp", [t1])
            rpc("evm_mine", [])
            warped = True
            print("  fork: jumped the fork's clock to t1 (%s h after the start)" % round((t1 - z["deadlines"]["now_unix"]) / 3600, 2), flush=True)
    terminal = job["state"] in ("done", "refunded", "failed", "expired", "holding")
    b_done = b is None or b.get("outcome") is not None
    if terminal and not b_done:
        grace_from = grace_from or time.time()
    if terminal and (b_done or time.time() - grace_from > int(E["B_GRACE_SECS"])):
        break
    if time.time() - start > int(E["FOLLOW_SECS"]):
        print("  stopped following after %d s; the swap goes on in the daemons and the UI server (infra/mainnet-demo.sh follow %s)" % (int(E["FOLLOW_SECS"]), JOB))
        sys.exit(2)
    time.sleep(2)

# ---------------------------------------------------------------- summary
n, t = job["near"], job["asset"]
d = n.get("details") or {}
def amt(v, dec, s):
    return "%s %s" % (("%.*f" % (dec, int(v) / 10 ** dec)).rstrip("0").rstrip("."), s)
deposit = n["deposit_address"]
at_deposit = usdc_of(deposit)
print()
print("Result: %s (%s)" % (job["state"], job.get("outcome")))
print("  Ferry swap     %s: Z %s, B %s" % (job["ferry"]["swap_id"], z and z.get("outcome"), b and b.get("outcome")))
if z:
    swapped = z.get("outcome") == "swapped"
    print("  ZEC            %s ZEC from Z's Ironwood notes, %s (Zcash mainnet%s)" % (z["amounts"]["zec_zat"] / 1e8,
          "sold" if swapped else "back in Z's wallet" if z.get("outcome") == "refunded" else str(z.get("outcome")), ", mock" if FORK else ""))
    print("  USDC           %s locked by B; %s %s (payout_to)" % (amt(z["amounts"]["btc_sat"], 6, "USDC"),
          "claimed to" if swapped else "the claimer was", z.get("payout_to")))
if at_deposit is not None:
    print("  deposit addr   %s holds %s now on Base%s" % (deposit, amt(at_deposit, 6, "USDC"), ONLY))
if d.get("amount_out"):
    print("  delivered      %s to %s" % (amt(d["amount_out"], t["decimals"], t["symbol"]), job["address"]))
if d.get("refunded"):
    print("  refunded       %s to %s (%s)%s" % (amt(d["refunded"], 6, "USDC"), job["own_address"], d.get("refund_reason"),
                                              "; the mock only records it, on mainnet 1Click sends it there" if FORK else ""))
print("  NEAR Intents   %s/%s%s" % (NEARX, deposit, ONLY))
names = {"btc_lock_broadcast": "lock", "btc_redeem_broadcast": "claim", "refund_broadcast": "refund", "punish_broadcast": "punish",
         "zec_lock_broadcast": "ZEC lock", "zec_sweep_broadcast": "ZEC sweep (B)", "zec_reclaim_broadcast": "ZEC reclaim (Z)"}
done_tx = []
for s in (z, b):
    for e in (s or {}).get("timeline", []):
        if e.get("txid") and e["kind"] in names and e["txid"] not in done_tx:
            done_tx.append(e["txid"])
            print("  %-14s %s" % (names[e["kind"]], link(e["chain"], e["txid"])))
for kind in ("origin_txs", "destination_txs"):
    for x in d.get(kind) or []:
        print("  %-14s %s" % ("NEAR " + kind.split("_")[0], (x["url"] or x["hash"]) + ONLY))
# measured steps
def first(s, kind):
    for e in (s or {}).get("timeline", []):
        if e["kind"] == kind:
            return ts(e["at"])
    return None
def jfirst(kind):
    for e in job["timeline"]:
        if e["kind"] == kind:
            return ts(e["at"])
    return None
steps = [
    ("start -> B's lock sent", jfirst("ferry_started") or first(z, "propose_sent"), first(b, "btc_lock_broadcast")),
    ("B's lock -> Z's ZEC lock (%s Base confirmations)" % E["LOCK_CONFS"], first(b, "btc_lock_broadcast"), first(z, "zec_lock_broadcast")),
    ("Z's ZEC lock -> B's Ready (%s Zcash confirmations)" % E["ZEC_CONFS"], first(z, "zec_lock_broadcast"), first(b, "redeem_adaptor_sent")),
    ("Ready -> Z's claim", first(z, "redeem_adaptor_received"), first(z, "btc_redeem_broadcast")),
    ("claim -> NEAR Intents done", first(z, "btc_redeem_broadcast"), jfirst("near_success") or jfirst("near_refunded")),
    ("start -> all done (job)", jfirst("near_quote"), jfirst("near_success") or jfirst("near_refunded")),
]
print("Measured:")
for name, a, c in steps:
    if a and c:
        print("  %-55s %6.0f s" % (name, c - a))
os.makedirs(E["EVIDENCE"], exist_ok=True)
path = os.path.join(E["EVIDENCE"], "%s.json" % JOB)
with open(path, "w") as f:
    json.dump({"job": job, "z_swap": z, "b_swap": b, "deposit_usdc_now": at_deposit, "fork": FORK}, f, indent=1)
print("Evidence: %s" % path)
sys.exit(0 if job["state"] == EXPECT else 1)
PY
}

cmd_follow() {
  alive ui || die "the UI server is not running (infra/mainnet-demo.sh up)"
  need_foundry
  FORK=
  is_anvil && FORK=1
  local job=${1:-}
  if [ -z "$job" ]; then
    job=$(curl -sf -m 30 "http://127.0.0.1:$UI_PORT/api/near/jobs" | python3 -c 'import json, sys; j = json.load(sys.stdin); print(j[0]["id"] if j else "")')
    [ -n "$job" ] || die "no NEAR sell yet"
  fi
  follow_job "$job"
}

# ------------------------------------------------------------------ 1Click, read-only

# near-check [asset] [recipient]: 1Click's token list and DRY quotes (nothing is created) for
# USDC on Base -> asset at the demo's sizes, and the smallest amount it takes.
cmd_near_check() {
  need_node
  local asset=${1:-SOL@sol} recipient=${2:-} m rate refund=""
  m=$(market_json)
  rate=${RATE:-$(market_rate "$m")} || die "no market price"
  [ -s "$STATE/z.addr" ] && refund=$(cat "$STATE/z.addr")
  mkdir -p "$STATE"
  ASSET="$asset" RECIPIENT="$recipient" REFUND="$refund" RATE_UNITS="$rate" MARKET="$m" \
    ZATS="${NEAR_CHECK_ZATS:-1000000,1500000,2000000}" JWT_FILE="$STATE/near-jwt" OUT="$STATE/near-check.json" \
    "$NODE" --input-type=module - <<JS
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ONE_CLICK_URL, FERRY_ASSETS, dryAddress, oneClick, verifyQuote } from "$ROOT/web/server/near.mjs";
const E = process.env;
const jwt = existsSync(E.JWT_FILE) ? readFileSync(E.JWT_FILE, "utf8").trim() : null;
const link = oneClick({ url: ONE_CLICK_URL, jwt, timeoutMs: 20000 });
const tokens = await link.tokens();
if (!tokens) { console.error("1Click can't be reached"); process.exit(2); }
const usdc = tokens.find((t) => t.assetId === FERRY_ASSETS["usdc-base"].assetId);
if (!usdc || usdc.decimals !== 6) { console.error("1Click doesn't list USDC on Base with 6 decimals"); process.exit(2); }
const [sym, chain] = E.ASSET.split("@");
const hits = tokens.filter((t) => t.assetId === E.ASSET || (t.symbol.toLowerCase() === sym.toLowerCase() && (!chain || t.blockchain === chain.toLowerCase())));
if (hits.length !== 1) { console.error(hits.length ? "several chains: " + hits.map((t) => t.symbol + "@" + t.blockchain).join(", ") : "1Click lists no " + E.ASSET); process.exit(2); }
const to = hits[0];
const market = JSON.parse(E.MARKET);
const rate = BigInt(E.RATE_UNITS);
const [recipient, recipientType] = E.RECIPIENT ? [E.RECIPIENT, "DESTINATION_CHAIN"] : dryAddress(to.blockchain, "DESTINATION_CHAIN");
const [refundTo, refundType] = E.REFUND ? [E.REFUND, "ORIGIN_CHAIN"] : dryAddress("base", "ORIGIN_CHAIN");
console.log("1Click (" + ONE_CLICK_URL + "): " + tokens.length + " tokens" + (jwt ? ", with a partner JWT" : ", no JWT (1Click adds 0.25%)"));
console.log("  USDC on Base  " + usdc.assetId + "  \$" + usdc.price);
console.log("  target        " + to.symbol + " on " + to.blockchain + "  " + to.assetId + "  \$" + to.price);
console.log("  ZEC           \$" + (market.zec ?? "?") + " (1Click), \$" + (market.kraken_zec ?? "?") + " (Kraken); B's rate " + Number(rate) / 1e6 + " USDC per ZEC");
console.log("  recipient     " + (E.RECIPIENT ? recipient : recipient + " (a placeholder nobody holds)") + "; refunds to " + (E.REFUND ? refundTo + " (Z)" : refundTo + " (placeholder)"));
const fmt = (v, d) => (Number(v) / 10 ** d).toFixed(Math.min(d, 8)).replace(/\.?0+$/, "");
async function dry(units) {
  const body = { dry: true, swapType: "FLEX_INPUT", slippageTolerance: 100, originAsset: usdc.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: to.assetId, amount: units.toString(), refundTo, refundType, recipient, recipientType, deadline: new Date(Date.now() + 3600_000).toISOString() };
  const r = await link.quote(body);
  if (r.status !== 200 && r.status !== 201) return { error: String(r.body?.message ?? r.body?.error ?? "HTTP " + r.status).slice(0, 160) };
  return { q: r.body.quote, ok: verifyQuote(r.body), raw: r.body };
}
const rows = [];
console.log("");
console.log("DRY quotes (nothing is created), FLEX_INPUT USDC(base) -> " + to.symbol + ", 1% slippage:");
console.log("  ZEC     USDC in     " + to.symbol.padEnd(10) + " out       min out     withdraw fee   NEAR cost       time  signature");
for (const zat of E.ZATS.split(",").map(BigInt)) {
  const units = (zat * rate) / 100000000n;
  const r = await dry(units);
  if (r.error) { console.log("  " + fmt(zat, 8).padEnd(7) + " " + fmt(units, 6).padEnd(11) + " refused: " + r.error); rows.push({ zat: zat.toString(), usdc: units.toString(), error: r.error }); continue; }
  const q = r.q;
  const outUsd = (Number(q.amountOut) / 10 ** to.decimals) * (to.price ?? 0);
  const cost = Number(units) / 1e6 * (usdc.price ?? 1) - outUsd;
  console.log("  " + fmt(zat, 8).padEnd(7) + " " + fmt(units, 6).padEnd(11) + " " + fmt(q.amountOut, to.decimals).padEnd(15) + " " + fmt(q.minAmountOut, to.decimals).padEnd(11) + " " + (q.withdrawFee ? fmt(q.withdrawFee, to.decimals) : "-").padEnd(14) + " \$" + cost.toFixed(4) + " (" + (100 * cost / (Number(units) / 1e6)).toFixed(2) + "%)  " + String(q.timeEstimate) + " s   " + (r.ok ? "ok" : "BAD"));
  rows.push({ zat: zat.toString(), usdc: units.toString(), amountOut: q.amountOut, minAmountOut: q.minAmountOut, minAmountIn: q.minAmountIn, withdrawFee: q.withdrawFee ?? null, timeEstimate: q.timeEstimate, costUsd: cost, signature: r.ok, correlationId: r.raw.correlationId });
}
console.log("");
console.log("The smallest amount it takes (dry):");
const floor = [];
for (const usd of [0.2, 0.5, 1, 2, 5]) {
  const units = BigInt(Math.round(usd * 1e6));
  const r = await dry(units);
  console.log("  " + String(usd).padEnd(4) + " USDC  " + (r.error ? "refused: " + r.error : "ok, " + fmt(r.q.amountOut, to.decimals) + " " + to.symbol + " out"));
  floor.push({ usdc: units.toString(), ok: !r.error, error: r.error ?? null });
}
writeFileSync(E.OUT, JSON.stringify({ at: new Date().toISOString(), target: to, usdc, market, rate: rate.toString(), recipient, refundTo, rows, floor }, null, 1), { mode: 0o600 });
console.log("");
console.log("Saved: " + E.OUT);
if (rows.some((r) => r.error || !r.signature)) process.exit(1);
JS
}

# ------------------------------------------------------------------ fork rehearsal

fork_up() {
  alive anvil && { log "the fork is already running"; return 0; }
  [ -x "$ANVIL" ] || die "anvil (Foundry) is required"
  port_free "$FORK_PORT" || die "port $FORK_PORT is in use"
  mkdir -p "$STATE/logs"
  chmod 700 "$STATE"
  # Base's own fees on the fork (anvil would ask a 1 gwei tip, about 200x Base's), so the amounts
  # `status` asks the owner for are what the rehearsal spends
  local base_fee
  base_fee=$(ETH_RPC_URL="$FORK_URL" retry "$CAST" base-fee 2>/dev/null) || base_fee=5000000
  log "starting anvil on 127.0.0.1:$FORK_PORT, forking $(redacted "$FORK_URL") (Base mainnet, chain 8453, 2 s blocks, base fee $base_fee wei as on Base now)"
  "$ANVIL" --fork-url "$FORK_URL" --port "$FORK_PORT" --host 127.0.0.1 --chain-id 8453 --block-time 2 \
    --base-fee "$base_fee" --disable-min-priority-fee \
    --retries 10 --fork-retry-backoff 1000 --timeout 30000 --silent >>"$STATE/logs/anvil.log" 2>&1 &
  echo $! >"$STATE/anvil.pid"
  disown
  for _ in $(seq 1 90); do
    "$CAST" chain-id >/dev/null 2>&1 && break
    alive anvil || break
    sleep 0.5
  done
  "$CAST" chain-id >/dev/null 2>&1 || die "anvil did not come up (log: $STATE/logs/anvil.log)"
  log "fork up at block $("$CAST" block-number), chain id $("$CAST" chain-id)"
}

# A real holder of USDC with at least <units>, from recent Transfer logs read (read-only) on
# FORK_LOGS_RPC, its balance checked on the fork.
usdc_holder() {
  local need=$1 head from i cands a
  head=$(ETH_RPC_URL="$FORK_LOGS_RPC" retry "$CAST" block-number) || return 1
  for i in $(seq 0 10); do
    from=$((head - 20 - i * 20))
    cands=$(ETH_RPC_URL="$FORK_LOGS_RPC" "$CAST" logs --address "$USDC" --from-block "$from" --to-block "$((from + 19))" \
      'Transfer(address indexed,address indexed,uint256)' --json 2>/dev/null | python3 -c '
import json, sys
seen = []
for l in json.load(sys.stdin):
    a = "0x" + l["topics"][2][-40:]
    if a not in seen and int(a, 16) != 0:
        seen.append(a)
print("\n".join(seen[:25]))') || continue
    for a in $cands; do
      [ "$("$CAST" code "$a" 2>/dev/null)" = 0x ] || continue
      if ge "$(usdc_units "$a" || echo 0)" "$need"; then echo "$a"; return 0; fi
    done
  done
  return 1
}

fork_fund() {
  check_chain
  [ -n "$FORK" ] || die "fork fund only runs against an anvil fork"
  local who addr eth
  for who in deployer b z; do
    addr=$(addr_of "$who")
    case $who in
      deployer) eth=$DEPLOYER_ETH ;;
      b) eth=$B_ETH ;;
      z) eth=$Z_ETH ;;
    esac
    "$CAST" rpc anvil_setBalance "$addr" "$("$CAST" to-hex "$("$CAST" to-wei "$eth")")" >/dev/null
    log "fork: $(who_name "$who") $addr has $eth ETH (what status asks the owner for)"
  done
  local b need holder try
  b=$(addr_of b)
  need=${FORK_USDC_UNITS:-50000000}
  if ge "$(usdc_units "$b")" "$need"; then
    log "fork: B already holds $(fmt_usdc "$(usdc_units "$b")") USDC"
    return 0
  fi
  holder=$(usdc_holder "$need") || die "found no account holding $(fmt_usdc "$need") USDC in recent Transfer logs"
  "$CAST" rpc anvil_impersonateAccount "$holder" >/dev/null
  "$CAST" rpc anvil_setBalance "$holder" 0xde0b6b3a7640000 >/dev/null
  for try in 1 2 3; do
    "$CAST" send "$USDC" "transfer(address,uint256)" "$b" "$need" --from "$holder" --unlocked >/dev/null && break
    [ "$try" -lt 3 ] || die "the USDC transfer from $holder failed"
    sleep 3
    ge "$(usdc_units "$b")" "$need" && break
  done
  "$CAST" rpc anvil_stopImpersonatingAccount "$holder" >/dev/null
  log "fork: moved $(fmt_usdc "$need") of Circle's real USDC from holder $holder to B (impersonated, on the fork only); B holds $(fmt_usdc "$(usdc_units "$b")") USDC"
}

fork_down() {
  stop_pid anvil
  log "stopped the fork"
}

# Wait until neither daemon has a swap in progress (a NEAR start needs the pair idle).
wait_idle() {
  local i
  for i in $(seq 1 300); do
    if api z /api/swaps | python3 -c 'import json, sys; sys.exit(1 if any(not s["outcome"] for s in json.load(sys.stdin)) else 0)' &&
      api b /api/swaps | python3 -c 'import json, sys; sys.exit(1 if any(not s["outcome"] for s in json.load(sys.stdin)) else 0)'; then
      return 0
    fi
    sleep 2
  done
  die "the daemons are still busy after 10 minutes"
}

fork_test() {
  [ "$STATE" != "$DEFAULT_STATE" ] || die "the fork rehearsal does not run in the real state directory"
  trap 'cmd_down; fork_down' EXIT
  # A fresh fork knows nothing of earlier rehearsals: keep the keys, drop their swaps and jobs.
  rm -rf "$STATE/z/evm-swaps" "$STATE/b/evm-swaps" "$STATE/zec-mock.json" "$STATE/ferrylock" "$STATE/deploy.tx" \
    "$STATE/near-jobs.json" "$STATE/rate"
  fork_up
  cmd_keys
  fork_fund
  echo
  cmd_status
  echo
  log "the REAL 1Click, read-only: its token list and dry quotes for the demo's sizes"
  cmd_near_check "${FORK_ASSET:-SOL@sol}" || warn "the real 1Click check did not pass (above)"
  echo
  cmd_deploy
  cmd_up
  local recipient z b z0 b0 usdc job_state
  recipient=$("$NODE" --input-type=module -e "import { dryAddress } from '$ROOT/web/server/near.mjs'; console.log(dryAddress('sol', 'DESTINATION_CHAIN')[0])")
  z=$(addr_of z)
  b=$(addr_of b)
  z0=$(usdc_units "$z")
  b0=$(usdc_units "$b")
  echo
  log "1/3 a NEAR sell to the end: shielded ZEC -> USDC (Ferry, Base mainnet policy) -> the mock 1Click's deposit address -> SOL"
  (MODE=happy EXPECT=done cmd_sell "${FORK_ASSET:-SOL@sol}" "$recipient")
  local z1 b1
  z1=$(usdc_units "$z")
  b1=$(usdc_units "$b")
  [ "$z1" = "$z0" ] || die "Z's own USDC moved ($z0 -> $z1): the claim should have paid the deposit address"
  usdc=$(python3 -c 'import sys; print(-(-int(sys.argv[1]) * int(sys.argv[2]) // 100000000))' "$SWAP_ZAT" "$(cat "$STATE/rate")")
  [ $((b0 - b1)) -ge $((usdc - 1)) ] && [ $((b0 - b1)) -le "$usdc" ] || die "B's USDC went $b0 -> $b1, expected about $usdc less"
  log "checked: B paid $(fmt_usdc $((b0 - b1))) USDC, Z's own account did not move; the claim paid NEAR Intents' deposit address"
  wait_idle
  echo
  log "2/3 a NEAR refund: the mock 1Click refunds instead of swapping (as 1Click does when it can't fill)"
  curl -sf -m 10 -H 'content-type: application/json' -d '{"next":"refund"}' "http://127.0.0.1:$NEAR_PORT/_mock/fault" >/dev/null ||
    die "the mock 1Click refused the fault"
  (MODE=near-refund EXPECT=refunded cmd_sell "${FORK_ASSET:-SOL@sol}" "$recipient")
  wait_idle
  echo
  log "3/3 a Ferry refund: Z stops after locking its ZEC, the fork's clock jumps to t1, B refunds, Z takes its ZEC back; nothing reaches NEAR Intents"
  local b2 b3
  b2=$(usdc_units "$b")
  (MODE=ferry-refund EXPECT=failed B_GRACE_SECS=180 cmd_sell "${FORK_ASSET:-SOL@sol}" "$recipient")
  wait_idle
  b3=$(usdc_units "$b")
  [ "$b3" = "$b2" ] || die "B's USDC moved on a refunded swap ($b2 -> $b3)"
  log "checked: the refund gave B its USDC back"
  echo
  cmd_status
  log "fork rehearsal passed: deploy, a NEAR sell to the end, a NEAR refund and a Ferry refund, under the Base mainnet policy on a fork of Base mainnet with Circle's real USDC contract"
}

cmd_fork() {
  case "${1:-}" in
    up) fork_up ;;
    fund) need_foundry; fork_fund ;;
    test) need_foundry; need_node; fork_test ;;
    down) cmd_down; fork_down ;;
    *) die "usage: infra/mainnet-demo.sh fork up|fund|test|down" ;;
  esac
}

FORK=
case "${1:-help}" in
  keys) cmd_keys ;;
  status) cmd_status ;;
  deploy) cmd_deploy ;;
  up) cmd_up ;;
  down) cmd_down ;;
  sell) shift; cmd_sell "$@" ;;
  follow) cmd_follow "${2:-}" ;;
  near-check) shift; cmd_near_check "$@" ;;
  fork) cmd_fork "${2:-}" ;;
  logs) tail -n 50 -f "$STATE/logs/${2:-z}.log" ;;
  help | -h | --help) usage ;;
  *) usage; exit 2 ;;
esac
