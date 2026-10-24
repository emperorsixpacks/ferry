#!/usr/bin/env bash
# One-command local Ferry demo: regtest bitcoind (Docker), two ferryd daemons and a block producer.
# Run `infra/demo.sh help` for usage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${FERRY_DEMO_DIR:-$ROOT/.demo}"

CONTAINER=ferry-bitcoind
IMAGE="${BITCOIND_IMAGE:-bitcoin/bitcoin:28.1}"
BTC_RPC_PORT="${BTC_RPC_PORT:-18643}"
BTC_RPC="http://127.0.0.1:$BTC_RPC_PORT"
Z_PORT="${Z_PORT:-7101}"           # control API (/api/*, loopback)
B_PORT="${B_PORT:-7102}"
Z_PEER_PORT="${Z_PEER_PORT:-7111}" # peer protocol (/peer/*)
B_PEER_PORT="${B_PEER_PORT:-7112}"
MAKER_URL="http://127.0.0.1:$B_PEER_PORT"
UI_ORIGINS="${UI_ORIGINS:-http://localhost:5180 http://127.0.0.1:5180}"
Z_NAME="${Z_NAME:-zoe}"
B_NAME="${B_NAME:-bram}"
BLOCK_SECS="${BLOCK_SECS:-5}"
FAST_BLOCK_SECS="${FAST_BLOCK_SECS:-1}"
RATE="${RATE:-410000}"
B_FUND_BTC="${B_FUND_BTC:-1}"
ZEC_BACKEND="${ZEC_BACKEND:-mock}"
ZEC_BALANCE_ZAT="${ZEC_BALANCE_ZAT:-500000000}"
ZEC_BLOCK_SECS="${ZEC_BLOCK_SECS:-3}"
T1="${T1:-12}"
T2="${T2:-24}"
DELTA="${DELTA:-3}"
BTC_LOCK_CONFS="${BTC_LOCK_CONFS:-2}"
ZEC_CONFS="${ZEC_CONFS:-3}"
POLL_MS="${POLL_MS:-500}"
FERRYD="${FERRYD:-$ROOT/target/debug/ferryd}"

usage() {
  cat <<EOF
Ferry local demo: shielded ZEC <-> BTC atomic swap between two daemons on one machine.

  infra/demo.sh up       start bitcoind (regtest, Docker container $CONTAINER), build ferryd,
                         start Z ($Z_NAME, :$Z_PORT) and B ($B_NAME, :$B_PORT, maker at $RATE sat/ZEC),
                         fund B's BTC wallet and start the block producer. Starts from a fresh chain.
  infra/demo.sh down     stop the daemons, the block producer and bitcoind (logs stay in $STATE/logs)
  infra/demo.sh status   chain height, daemon status and swaps at a glance
  infra/demo.sh logs [z|b|miner|bitcoind]   follow a log
  infra/demo.sh mine [n] mine n blocks now (default 1)
  infra/demo.sh help     this text

Each daemon has a loopback control API (Z :$Z_PORT, B :$B_PORT) that needs a bearer token, and a
peer listener (Z :$Z_PEER_PORT, B :$B_PEER_PORT; takers are given B's as the maker URL). The tokens are
in $STATE/{z,b}/api-token; \`up\` writes them to $STATE/env together with the UI's settings.

The UI (web/):
  cd web && source $STATE/env && pnpm dev:ui
  ($STATE/env exports FERRY_Z_URL, FERRY_B_URL, FERRY_MAKER_URL, FERRY_Z_TOKEN, FERRY_B_TOKEN)

The three stories:
  happy   Start a swap from Z's panel. B locks BTC, Z locks ZEC, B sends the redeem adaptor,
          Z redeems (revealing z), B extracts z from the witness and sweeps the ZEC.
  refund  Stall Z once its ZEC is locked. B cancels after T1 and refunds (revealing b);
          Z wakes when tx_cancel confirms, extracts b and reclaims its ZEC.
  punish  Stall B after it locks BTC. Z cancels after T1, B never refunds, Z punishes after T2.
  While a party is stalled the block producer mines every ${FAST_BLOCK_SECS}s instead of ${BLOCK_SECS}s.

The same swap through the API:
  source $STATE/env; AUTH="authorization: Bearer \$FERRY_Z_TOKEN"
  curl -XPOST localhost:$Z_PORT/api/swaps -H "\$AUTH" -H 'content-type: application/json' \\
       -d '{"maker":"$MAKER_URL","zec_zat":100000000}'
  curl -H "\$AUTH" localhost:$Z_PORT/api/swaps/<id>        curl -N -H "\$AUTH" localhost:$Z_PORT/api/events
  curl -XPOST -H "\$AUTH" localhost:$Z_PORT/api/swaps/<id>/fault -H 'content-type: application/json' -d '{"fault":"stall"}'

Environment (defaults in brackets):
  BLOCK_SECS [$BLOCK_SECS]  FAST_BLOCK_SECS [$FAST_BLOCK_SECS]  BTC_RPC_PORT [$BTC_RPC_PORT]
  Z_PORT [$Z_PORT]  B_PORT [$B_PORT]  Z_PEER_PORT [$Z_PEER_PORT]  B_PEER_PORT [$B_PEER_PORT]
  UI_ORIGINS [$UI_ORIGINS] (browser origins allowed on the API)  RATE [$RATE sat/ZEC]  B_FUND_BTC [$B_FUND_BTC]
  T1 [$T1]  T2 [$T2]  DELTA [$DELTA]  BTC_LOCK_CONFS [$BTC_LOCK_CONFS]  ZEC_CONFS [$ZEC_CONFS]  POLL_MS [$POLL_MS]
  ZEC_BACKEND [mock|devtool, $ZEC_BACKEND]   mock: a stand-in Zcash chain in $STATE/zec-mock.json
    ZEC_BALANCE_ZAT [$ZEC_BALANCE_ZAT] (Z's starting shielded balance)  ZEC_BLOCK_SECS [$ZEC_BLOCK_SECS]
    devtool: real Ironwood via ferry-zec; pass its flags with ZEC_ARGS_Z / ZEC_ARGS_B
  FERRYD_ARGS (extra flags for both daemons)   FERRY_DEMO_DIR [$STATE]
EOF
}

log() { printf '[demo] %s\n' "$*"; }
die() { printf '[demo] error: %s\n' "$*" >&2; exit 1; }

rpc() { # rpc <wallet|""> <method> [json params]
  local url="$BTC_RPC"
  [ -n "$1" ] && url="$BTC_RPC/wallet/$1"
  curl -sf --user ferry:ferry -H 'content-type: text/plain;' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"demo\",\"method\":\"$2\",\"params\":${3:-[]}}" "$url"
}

result() { python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r if not isinstance(r,(dict,list)) else json.dumps(r))'; }

# api <z|b> <path> [curl args...]: call a daemon's control API with its token.
api() {
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
    for _ in $(seq 1 20); do alive "$1" || break; sleep 0.2; done
    alive "$1" && kill -9 "$(cat "$STATE/$1.pid")" 2>/dev/null || true
  fi
  rm -f "$STATE/$1.pid"
}

start_bitcoind() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  log "starting bitcoind ($IMAGE) on 127.0.0.1:$BTC_RPC_PORT"
  docker run -d --name "$CONTAINER" -p "127.0.0.1:$BTC_RPC_PORT:18443" "$IMAGE" \
    -regtest -server -txindex -printtoconsole \
    -rpcuser=ferry -rpcpassword=ferry -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
    -fallbackfee=0.0002 >/dev/null
  for _ in $(seq 1 60); do
    rpc "" getblockcount >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  docker logs --tail 30 "$CONTAINER" >&2
  die "bitcoind did not come up"
}

start_ferryd() { # start_ferryd <key> <role> <name> <api port> <peer port> [extra args...]
  local key=$1 role=$2 name=$3 port=$4 peer_port=$5
  shift 5
  local zec_args=()
  case "$ZEC_BACKEND" in
    mock) zec_args=(--zec mock --zec-mock-file "$STATE/zec-mock.json" --zec-mock-block-secs "$ZEC_BLOCK_SECS") ;;
    devtool)
      local extra_var="ZEC_ARGS_$(echo "$key" | tr a-z A-Z)"
      # shellcheck disable=SC2206
      zec_args=(--zec devtool ${!extra_var:-}) ;;
    *) die "ZEC_BACKEND must be mock or devtool" ;;
  esac
  # shellcheck disable=SC2206
  local extra=(${FERRYD_ARGS:-})
  local origins=()
  for o in $UI_ORIGINS; do origins+=(--ui-origin "$o"); done
  "$FERRYD" --role "$role" --name "$name" --api-listen "127.0.0.1:$port" --listen "127.0.0.1:$peer_port" \
    --data-dir "$STATE/$key" --demo-faults ${origins[@]+"${origins[@]}"} \
    --btc-rpc "$BTC_RPC" --btc-wallet "$name" "${zec_args[@]}" \
    --t1 "$T1" --t2 "$T2" --delta "$DELTA" --btc-lock-confs "$BTC_LOCK_CONFS" --zec-confs "$ZEC_CONFS" \
    --poll-ms "$POLL_MS" "$@" ${extra[@]+"${extra[@]}"} >>"$STATE/logs/$key.log" 2>&1 &
  echo $! >"$STATE/$key.pid"
  for _ in $(seq 1 60); do
    api "$key" /api/status >/dev/null 2>&1 && return 0
    alive "$key" || break
    sleep 0.5
  done
  tail -n 20 "$STATE/logs/$key.log" >&2
  die "ferryd $key did not come up (log: $STATE/logs/$key.log)"
}

# Mines a block every BLOCK_SECS, or every FAST_BLOCK_SECS while either party has an active stall
# (its last fault_injected is newer than its last fault_cleared and the swap has no outcome yet).
producer() {
  local addr=$1
  local stalled_py='
import json, sys
for s in json.load(sys.stdin):
    kinds = [e["kind"] for e in s["timeline"]]
    inj = max((i for i, k in enumerate(kinds) if k == "fault_injected"), default=-1)
    clr = max((i for i, k in enumerate(kinds) if k == "fault_cleared"), default=-1)
    if s["outcome"] is None and inj > clr:
        print("stalled"); break'
  while true; do
    local wait=$BLOCK_SECS
    for key in z b; do
      if api "$key" /api/swaps 2>/dev/null | python3 -c "$stalled_py" 2>/dev/null | grep -q stalled; then
        wait=$FAST_BLOCK_SECS
      fi
    done
    sleep "$wait"
    if rpc "" generatetoaddress "[1, \"$addr\"]" >/dev/null; then
      echo "$(date '+%H:%M:%S') block $(rpc "" getblockcount | result) (next in ${wait}s)"
    else
      echo "$(date '+%H:%M:%S') mining failed"
    fi
  done
}

cmd_up() {
  if alive z || alive b || alive miner; then
    die "the demo is already running (infra/demo.sh status). Run infra/demo.sh down first"
  fi
  command -v docker >/dev/null || die "docker is required"
  command -v python3 >/dev/null || die "python3 is required"
  rm -rf "$STATE/z" "$STATE/b" "$STATE/zec-mock.json"
  mkdir -p "$STATE/logs"

  if [ -z "${FERRYD_SKIP_BUILD:-}" ]; then
    log "building ferryd"
    (cd "$ROOT" && cargo build -q -p ferryd) || die "cargo build failed"
  fi
  start_bitcoind

  rpc "" createwallet '["miner"]' >/dev/null
  local miner
  miner=$(rpc miner getnewaddress '["", "bech32m"]' | result)
  rpc "" generatetoaddress "[101, \"$miner\"]" >/dev/null
  log "mined 101 blocks to the miner wallet"

  log "starting B ($B_NAME, maker at $RATE sat/ZEC): API :$B_PORT, peer :$B_PEER_PORT"
  start_ferryd b b "$B_NAME" "$B_PORT" "$B_PEER_PORT" --maker-offer "$RATE"
  log "starting Z ($Z_NAME): API :$Z_PORT, peer :$Z_PEER_PORT"
  if [ "$ZEC_BACKEND" = mock ]; then
    start_ferryd z z "$Z_NAME" "$Z_PORT" "$Z_PEER_PORT" --zec-mock-balance "$ZEC_BALANCE_ZAT"
  else
    start_ferryd z z "$Z_NAME" "$Z_PORT" "$Z_PEER_PORT"
  fi
  umask 077
  cat >"$STATE/env" <<ENV
export FERRY_Z_URL=http://127.0.0.1:$Z_PORT
export FERRY_B_URL=http://127.0.0.1:$B_PORT
export FERRY_MAKER_URL=$MAKER_URL
export FERRY_Z_TOKEN=$(cat "$STATE/z/api-token")
export FERRY_B_TOKEN=$(cat "$STATE/b/api-token")
ENV

  local b_addr
  b_addr=$(rpc "$B_NAME" getnewaddress '["", "bech32m"]' | result)
  rpc miner sendtoaddress "[\"$b_addr\", $B_FUND_BTC]" >/dev/null
  rpc "" generatetoaddress "[1, \"$miner\"]" >/dev/null
  log "funded $B_NAME with $B_FUND_BTC BTC"

  producer "$miner" >>"$STATE/logs/miner.log" 2>&1 &
  echo $! >"$STATE/miner.pid"

  log "ready: Z http://127.0.0.1:$Z_PORT  B http://127.0.0.1:$B_PORT (maker $MAKER_URL)  bitcoind $BTC_RPC  (ZEC: $ZEC_BACKEND, a block every ${BLOCK_SECS}s)"
  log "API tokens and UI settings: $STATE/env"
  log "UI: cd web && source $STATE/env && pnpm dev:ui"
}

cmd_down() {
  stop_pid miner
  stop_pid z
  stop_pid b
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && log "removed $CONTAINER" || true
  log "stopped (logs in $STATE/logs)"
}

cmd_status() {
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "bitcoind  up, height $(rpc "" getblockcount | result)  ($BTC_RPC)"
  else
    echo "bitcoind  down"
  fi
  if alive miner; then echo "producer  up (pid $(cat "$STATE/miner.pid"))"; else echo "producer  down"; fi
  for key in z b; do
    local port=$Z_PORT
    [ "$key" = b ] && port=$B_PORT
    if alive "$key"; then
      api "$key" /api/status | python3 -c '
import json, sys
s = json.load(sys.stdin)
b, port = s["balances"], sys.argv[1]
print("ferryd %s  up, %s on :%s  btc %d sat  zec %d zat  zec height %d"
      % (s["role"], s["name"], port, b["btc_sat"], b["zec_shielded_zat"], s["chains"]["zec"]["height"]))' "$port" \
        || echo "ferryd $key  running but not answering on :$port"
      api "$key" /api/swaps | python3 -c '
import json, sys
for s in json.load(sys.stdin):
    print("  swap %s…  %-18s outcome %s" % (s["id"][:12], s["state"], s["outcome"]))' || true
    else
      echo "ferryd $(echo $key | tr a-z A-Z)  down"
    fi
  done
}

cmd_logs() {
  local which=${1:-z}
  if [ "$which" = bitcoind ]; then
    docker logs -f --tail 50 "$CONTAINER"
  else
    tail -n 50 -f "$STATE/logs/$which.log"
  fi
}

cmd_mine() {
  local miner
  miner=$(rpc miner getnewaddress '["", "bech32m"]' | result) || die "bitcoind is not up"
  rpc "" generatetoaddress "[${1:-1}, \"$miner\"]" >/dev/null
  echo "height $(rpc "" getblockcount | result)"
}

case "${1:-help}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-z}" ;;
  mine) cmd_mine "${2:-1}" ;;
  help | -h | --help) usage ;;
  *) usage; exit 2 ;;
esac
