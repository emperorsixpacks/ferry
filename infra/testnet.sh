#!/usr/bin/env bash
# Ferry on public test networks: Bitcoin signet (pruned bitcoind in Docker) and Zcash testnet.
# Run `infra/testnet.sh help` for usage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${FERRY_TESTNET_DIR:-$ROOT/.testnet}"

CONTAINER=ferry-signet
VOLUME=ferry-signet-data
IMAGE="${BITCOIND_IMAGE:-bitcoin/bitcoin:28.1}"
SIGNET_RPC_PORT="${SIGNET_RPC_PORT:-38332}"
BTC_RPC="http://127.0.0.1:$SIGNET_RPC_PORT"
PRUNE_MB="${PRUNE_MB:-2000}"
Z_PORT="${Z_PORT:-7301}"
B_PORT="${B_PORT:-7302}"
Z_PEER_PORT="${Z_PEER_PORT:-7311}"
B_PEER_PORT="${B_PEER_PORT:-7312}"
MAKER_URL="http://127.0.0.1:$B_PEER_PORT"
Z_NAME="${Z_NAME:-zoe}"
B_NAME="${B_NAME:-bram}"
RATE="${RATE:-410000}"
MIN_ZAT="${MIN_ZAT:-10000000}"
MAX_ZAT="${MAX_ZAT:-100000000}"
# Signet blocks come about every 10 minutes; Zcash testnet blocks every 75 seconds.
T1="${T1:-6}"
T2="${T2:-6}"
DELTA="${DELTA:-2}"
BTC_LOCK_CONFS="${BTC_LOCK_CONFS:-1}"
ZEC_CONFS="${ZEC_CONFS:-3}"
CANCEL_CONFS="${CANCEL_CONFS:-1}"
FEE_SAT="${FEE_SAT:-1500}"
POLL_MS="${POLL_MS:-5000}"
ZEC_BACKEND="${ZEC_BACKEND:-devtool}"
ZEC_NETWORK="${ZEC_NETWORK:-test}"
ZEC_SERVER="${ZEC_SERVER:-testnet.zec.rocks:443}" # lightwalletd/Zaino host:port (TLS for remote hosts)
ZEC_NODE_RPC="${ZEC_NODE_RPC:-}" # optional Zebra JSON-RPC; without it tip/confirmations come from the wallet scan
ZEC_DEVTOOL="${ZEC_DEVTOOL:-$ROOT/vendor/zcash-devtool/target/release/zcash-devtool}"
ZEC_SIGNER="${ZEC_SIGNER:-$ROOT/tools/ferry-zec-signer/target/release/ferry-zec-signer}"
UI_ORIGINS="${UI_ORIGINS:-http://localhost:5180 http://127.0.0.1:5180}"
FERRYD="${FERRYD:-$ROOT/target/debug/ferryd}"

usage() {
  cat <<EOF
Ferry on public test networks: Bitcoin signet + Zcash testnet (TAZ).

  infra/testnet.sh up         start (or resume) the pruned signet node ($CONTAINER, -prune=$PRUNE_MB,
                              data in Docker volume $VOLUME, RPC $BTC_RPC), build ferryd and start
                              Z ($Z_NAME, API :$Z_PORT) and B ($B_NAME, API :$B_PORT, maker at $MAKER_URL)
  infra/testnet.sh addresses  where to send test coins: B's signet BTC address, Z's Zcash testnet address
  infra/testnet.sh status     node sync progress, daemon balances and swaps
  infra/testnet.sh down [--purge]   stop the daemons and the node (--purge also deletes the synced chain)
  infra/testnet.sh logs [z|b|node]
  infra/testnet.sh help

First run: \`up\` starts the initial signet sync (a pruned node keeps about $PRUNE_MB MB of blocks).
The daemons start right away and \`addresses\` works during the sync, but don't start a swap
before \`status\` shows the node synced: until then ferryd cannot see new transactions.

Funding: send signet sats to B's address and TAZ to Z's address (any signet / Zcash testnet
faucet works). B needs the swap amount plus the lock's fee; Z needs the ZEC amount plus fees.
Z's received TAZ is spendable only after 10 confirmations (about 13 minutes; zcash-devtool's
default policy for notes from another wallet), so fund Z first.
Then start a swap from the UI or with:
  source $STATE/env
  curl -XPOST localhost:$Z_PORT/api/swaps -H "authorization: Bearer \$FERRY_Z_TOKEN" \\
       -H 'content-type: application/json' -d '{"maker":"$MAKER_URL","zec_zat":10000000}'
The UI: cd web && source $STATE/env && pnpm dev:ui

Timelocks (in signet blocks of about 10 minutes):
  T1=$T1, DELTA=$DELTA: Z must redeem while tx_lock has fewer than T1-DELTA confirmations. That
    leaves about 30 minutes after the lock's first confirmation for Z's ZEC lock to collect
    ZEC_CONFS=$ZEC_CONFS Zcash confirmations (about 4 minutes) and for the redeem, and DELTA blocks
    (about 20 minutes) for tx_redeem to confirm before tx_cancel becomes valid. The cancel path
    opens about an hour after the lock.
  T2=$T2: B refunds once tx_cancel has $CANCEL_CONFS confirmation and before T2-DELTA (a window of
    about 30 minutes); Z can punish an hour after the cancel. Signet mempools are nearly empty,
    so a ${FEE_SAT}-sat presigned fee (about 7-10 sat/vB) confirms in the next block.
  Every value is an environment variable; nothing is fixed to a network in ferryd itself.

Environment (defaults in brackets):
  SIGNET_RPC_PORT [$SIGNET_RPC_PORT]  PRUNE_MB [$PRUNE_MB]  Z_PORT [$Z_PORT]  B_PORT [$B_PORT]
  Z_PEER_PORT [$Z_PEER_PORT]  B_PEER_PORT [$B_PEER_PORT]  RATE [$RATE sat/ZEC]  MIN_ZAT [$MIN_ZAT]  MAX_ZAT [$MAX_ZAT]
  T1 [$T1]  T2 [$T2]  DELTA [$DELTA]  BTC_LOCK_CONFS [$BTC_LOCK_CONFS]  ZEC_CONFS [$ZEC_CONFS]
  CANCEL_CONFS [$CANCEL_CONFS]  FEE_SAT [$FEE_SAT]  POLL_MS [$POLL_MS]  UI_ORIGINS [$UI_ORIGINS]
  ZEC_BACKEND [devtool|mock, $ZEC_BACKEND]  ZEC_NETWORK [$ZEC_NETWORK]
    devtool: the Zcash side runs on testnet through ferry-zec (zcash-devtool wallets in
      $STATE/{z,b}/zec-wallet, created on first start with the chain tip as birthday).
      ZEC_SERVER (required): lightwalletd/Zaino host:port; TLS is used for non-local hosts.
      ZEC_NODE_RPC (optional): a Zebra JSON-RPC URL; without it the chain tip and confirmations
        come from the wallet's own scan and the observer panel has no ZEC lines.
      ZEC_DEVTOOL [$ZEC_DEVTOOL]
      ZEC_SIGNER [$ZEC_SIGNER] (built on first \`up\` if missing)
      Extra flags: ZEC_ARGS (both daemons), ZEC_ARGS_Z / ZEC_ARGS_B.
    mock: a stand-in Zcash chain, to rehearse the Bitcoin signet leg alone.
  FAULTS=1 enables the demo fault endpoint.   FERRYD_ARGS (extra flags for both daemons)
EOF
}

log() { printf '[testnet] %s\n' "$*"; }
die() { printf '[testnet] error: %s\n' "$*" >&2; exit 1; }

rpc() { # rpc <wallet|""> <method> [json params]
  local url="$BTC_RPC"
  [ -n "$1" ] && url="$BTC_RPC/wallet/$1"
  curl -sf --user ferry:ferry -H 'content-type: text/plain;' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"testnet\",\"method\":\"$2\",\"params\":${3:-[]}}" "$url"
}

api() { # api <z|b> <path> [curl args...]
  local key=$1 path=$2 port=$Z_PORT
  shift 2
  [ "$key" = b ] && port=$B_PORT
  local token
  token=$(cat "$STATE/$key/api-token" 2>/dev/null) || return 1
  curl -sf -H "authorization: Bearer $token" "$@" "http://127.0.0.1:$port$path"
}

alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

stop_pid() {
  if alive "$1"; then
    kill "$(cat "$STATE/$1.pid")" 2>/dev/null || true
    for _ in $(seq 1 25); do alive "$1" || break; sleep 0.2; done
    alive "$1" && kill -9 "$(cat "$STATE/$1.pid")" 2>/dev/null || true
  fi
  rm -f "$STATE/$1.pid"
}

node_running() { docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; }

start_node() {
  if node_running; then
    log "signet node already running"
  elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log "resuming signet node"
    docker start "$CONTAINER" >/dev/null
  else
    log "starting pruned signet node ($IMAGE, -prune=$PRUNE_MB) on 127.0.0.1:$SIGNET_RPC_PORT"
    docker volume create "$VOLUME" >/dev/null
    # A long stop timeout lets bitcoind flush its UTXO cache: killed mid-sync, it restarts from
    # its last flush (with -dbcache=1000 during the initial sync, that can be the genesis block).
    docker run -d --name "$CONTAINER" --stop-timeout 600 -p "127.0.0.1:$SIGNET_RPC_PORT:38332" \
      -v "$VOLUME:/home/bitcoin/.bitcoin" "$IMAGE" \
      -signet -prune="$PRUNE_MB" -server -printtoconsole \
      -rpcuser=ferry -rpcpassword=ferry -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 -rpcport=38332 \
      -fallbackfee=0.00002 -dbcache=1000 >/dev/null
  fi
  for _ in $(seq 1 60); do
    rpc "" getblockcount >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs --tail 30 "$CONTAINER" >&2
  die "the signet node did not answer RPC"
}

sync_line() {
  rpc "" getblockchaininfo | python3 -c '
import json, sys
r = json.load(sys.stdin)["result"]
state = "synced" if not r["initialblockdownload"] and r["blocks"] == r["headers"] else "syncing"
print("signet node  %s: block %d of %d headers (%.2f%%), pruned=%s"
      % (state, r["blocks"], r["headers"], 100 * r["verificationprogress"], r["pruned"]))'
}

start_ferryd() { # start_ferryd <key> <role> <name> <api port> <peer port> [extra args...]
  local key=$1 role=$2 name=$3 port=$4 peer_port=$5
  shift 5
  local zec_args=()
  case "$ZEC_BACKEND" in
    mock) zec_args=(--zec mock --zec-network "$ZEC_NETWORK" --zec-mock-file "$STATE/zec-mock.json" --zec-mock-block-secs 75) ;;
    devtool)
      local extra_var
      extra_var="ZEC_ARGS_$(echo "$key" | tr a-z A-Z)"
      # shellcheck disable=SC2206
      zec_args=(--zec devtool --zec-network "$ZEC_NETWORK" --zec-server "$ZEC_SERVER"
        --zec-devtool "$ZEC_DEVTOOL" --zec-signer "$ZEC_SIGNER")
      [ -n "$ZEC_NODE_RPC" ] && zec_args+=(--zec-node-rpc "$ZEC_NODE_RPC")
      # shellcheck disable=SC2206
      zec_args+=(${ZEC_ARGS:-} ${!extra_var:-}) ;;
    *) die "ZEC_BACKEND must be devtool or mock" ;;
  esac
  local origins=() extra=()
  for o in $UI_ORIGINS; do origins+=(--ui-origin "$o"); done
  [ -n "${FAULTS:-}" ] && extra+=(--demo-faults)
  # shellcheck disable=SC2206
  extra+=(${FERRYD_ARGS:-})
  "$FERRYD" --role "$role" --name "$name" --api-listen "127.0.0.1:$port" --listen "127.0.0.1:$peer_port" \
    --data-dir "$STATE/$key" --network signet \
    --btc-rpc "$BTC_RPC" --btc-wallet "$name" "${zec_args[@]}" ${origins[@]+"${origins[@]}"} \
    --t1 "$T1" --t2 "$T2" --delta "$DELTA" --btc-lock-confs "$BTC_LOCK_CONFS" --zec-confs "$ZEC_CONFS" \
    --cancel-confs "$CANCEL_CONFS" --fee-sat "$FEE_SAT" --poll-ms "$POLL_MS" \
    "$@" ${extra[@]+"${extra[@]}"} >>"$STATE/logs/$key.log" 2>&1 &
  echo $! >"$STATE/$key.pid"
  for _ in $(seq 1 120); do
    api "$key" /api/status >/dev/null 2>&1 && return 0
    alive "$key" || break
    sleep 0.5
  done
  tail -n 20 "$STATE/logs/$key.log" >&2
  die "ferryd $key did not come up (log: $STATE/logs/$key.log)"
}

cmd_up() {
  if alive z || alive b; then
    die "already running (infra/testnet.sh status); run infra/testnet.sh down first"
  fi
  command -v docker >/dev/null || die "docker is required"
  command -v python3 >/dev/null || die "python3 is required"
  mkdir -p "$STATE/logs"
  if [ -z "${FERRYD_SKIP_BUILD:-}" ]; then
    log "building ferryd"
    (cd "$ROOT" && cargo build -q -p ferryd) || die "cargo build failed"
  fi
  if [ "$ZEC_BACKEND" = devtool ]; then
    [ -n "$ZEC_SERVER" ] || die "ZEC_SERVER=<lightwalletd host:port> is required for the Zcash testnet (or ZEC_BACKEND=mock)"
    [ -x "$ZEC_DEVTOOL" ] || die "zcash-devtool not found at $ZEC_DEVTOOL (build vendor/zcash-devtool with --features regtest_support, or set ZEC_DEVTOOL)"
    if [ ! -x "$ZEC_SIGNER" ]; then
      log "building ferry-zec-signer"
      (cd "$ROOT/tools/ferry-zec-signer" && cargo build -q --release) || die "building ferry-zec-signer failed"
    fi
  fi
  start_node
  sync_line

  log "starting B ($B_NAME, maker at $RATE sat/ZEC): API :$B_PORT, peer :$B_PEER_PORT"
  start_ferryd b b "$B_NAME" "$B_PORT" "$B_PEER_PORT" --maker-offer "$RATE:$MIN_ZAT:$MAX_ZAT"
  log "starting Z ($Z_NAME): API :$Z_PORT, peer :$Z_PEER_PORT"
  start_ferryd z z "$Z_NAME" "$Z_PORT" "$Z_PEER_PORT"
  umask 077
  cat >"$STATE/env" <<ENV
export FERRY_Z_URL=http://127.0.0.1:$Z_PORT
export FERRY_B_URL=http://127.0.0.1:$B_PORT
export FERRY_MAKER_URL=$MAKER_URL
export FERRY_Z_TOKEN=$(cat "$STATE/z/api-token")
export FERRY_B_TOKEN=$(cat "$STATE/b/api-token")
ENV
  log "ready: Z http://127.0.0.1:$Z_PORT  B http://127.0.0.1:$B_PORT (maker $MAKER_URL)  signet $BTC_RPC  (ZEC: $ZEC_BACKEND/$ZEC_NETWORK)"
  log "fund the parties: infra/testnet.sh addresses"
}

cmd_addresses() {
  local any=
  for key in b z; do
    if ! alive "$key"; then
      echo "ferryd $key is not running (infra/testnet.sh up)"
      continue
    fi
    any=1
    api "$key" /api/addresses | python3 -c '
import json, sys
a = json.load(sys.stdin)
role, name = a["role"], a["name"]
btc, zec = a["btc"], a["zec"]["address"]
if role == "B":
    print("B (%s) holds the BTC. Send %s sats to:\n  %s" % (name, btc["network"], btc["address"]))
else:
    print("Z (%s) holds the ZEC. Send testnet ZEC (TAZ) to:" % name)
    print("  " + zec if zec else
          "  (not available yet: the Zcash backend does not report a receiving address."
          "\n   TODO(ferry-zec): implement ZecLeg::receive_address, e.g. Some(own_address()).)")
    print("  Z is paid in %s BTC at a fresh address of its own wallet: %s" % (btc["network"], btc["address"]))'
  done
  [ -n "$any" ] || exit 1
}

cmd_status() {
  if node_running; then sync_line; else echo "signet node  down"; fi
  for key in z b; do
    if alive "$key"; then
      api "$key" /api/status | python3 -c '
import json, sys
s = json.load(sys.stdin)
b = s["balances"]
print("ferryd %s  %s: btc %d sat  zec %d zat  (btc %s height %d, zec %s height %d)"
      % (s["role"], s["name"], b["btc_sat"], b["zec_shielded_zat"], s["chains"]["btc"]["network"],
         s["chains"]["btc"]["height"], s["chains"]["zec"]["network"], s["chains"]["zec"]["height"]))' \
        || echo "ferryd $key  running but not answering"
      api "$key" /api/swaps | python3 -c '
import json, sys
for s in json.load(sys.stdin):
    print("  swap %s…  %-18s outcome %s" % (s["id"][:12], s["state"], s["outcome"]))' || true
    else
      echo "ferryd $(echo "$key" | tr a-z A-Z)  down"
    fi
  done
}

cmd_down() {
  stop_pid z
  stop_pid b
  if node_running; then
    log "stopping $CONTAINER (bitcoind flushes its cache first; this can take a minute)"
    docker stop -t 600 "$CONTAINER" >/dev/null && log "stopped $CONTAINER (chain kept in volume $VOLUME)"
  fi
  if [ "${1:-}" = "--purge" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 && log "deleted volume $VOLUME" || true
  fi
}

cmd_logs() {
  case "${1:-z}" in
    node) docker logs -f --tail 50 "$CONTAINER" ;;
    *) tail -n 50 -f "$STATE/logs/${1:-z}.log" ;;
  esac
}

case "${1:-help}" in
  up) cmd_up ;;
  addresses) cmd_addresses ;;
  status) cmd_status ;;
  down) cmd_down "${2:-}" ;;
  logs) cmd_logs "${2:-z}" ;;
  help | -h | --help) usage ;;
  *) usage; exit 2 ;;
esac
