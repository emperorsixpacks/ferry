#!/usr/bin/env bash
# Watchtower demo: a party is killed mid-swap and its watchtower finishes the swap on its own.
# Self-contained: its own regtest bitcoind (Docker), ferry-watchtower, two ferryd daemons (mock
# ZEC) and its own ports, so it can run next to infra/demo.sh. Run `infra/demo-watchtower.sh help`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${FERRY_WT_DEMO_DIR:-$ROOT/.demo/watchtower}"
CONTAINER="${BITCOIND_CONTAINER:-ferry-wt-regtest}"
IMAGE="${BITCOIND_IMAGE:-bitcoin/bitcoin:28.1}"
BTC_RPC_PORT="${BTC_RPC_PORT:-18943}"
BTC_RPC="http://127.0.0.1:$BTC_RPC_PORT"
Z_PORT="${Z_PORT:-7711}"
B_PORT="${B_PORT:-7712}"
Z_PEER_PORT="${Z_PEER_PORT:-7721}"
B_PEER_PORT="${B_PEER_PORT:-7722}"
TOWER_PORT="${TOWER_PORT:-7731}"
TOWER="http://127.0.0.1:$TOWER_PORT"
MAKER_URL="http://127.0.0.1:$B_PEER_PORT"
T1="${T1:-8}"
T2="${T2:-12}"
DELTA="${DELTA:-2}"
BLOCK_MS="${BLOCK_MS:-700}"
UI_PORT="${UI_PORT:-7741}"
FERRYD="$ROOT/target/debug/ferryd"
WATCHTOWER="$ROOT/target/debug/ferry-watchtower"

usage() {
  cat <<EOF
Ferry watchtower demo (regtest bitcoind in Docker container $CONTAINER, mock ZEC).

  infra/demo-watchtower.sh run    build, start everything from a fresh chain and play both stories
  infra/demo-watchtower.sh up     only start everything (B arms its own tower) and write $STATE/env
                                  for the UI: cd web && source $STATE/env && pnpm shoot:watchtower
  infra/demo-watchtower.sh down   stop the daemons, the tower and bitcoind (logs stay in $STATE/logs)

Story 1 (refund): B arms its own tower (--watchtower-own), locks BTC and is killed. Z locks ZEC
  and waits for the redeem signature that never comes. After T1 the swap is called off and B's
  tower refunds B before T2 - delta, which reveals B's share: Z reclaims its ZEC. B comes back
  to a finished, refunded swap.
Story 2 (punish): B runs without --watchtower-own, so it refuses to arm the tower (and says why).
  B locks BTC and is killed; Z locks ZEC and is killed too. Z's tower calls the swap off at T1
  and takes the BTC for Z at T2. Z comes back to a finished swap.

Ports: Z API :$Z_PORT, B API :$B_PORT, peers :$Z_PEER_PORT/:$B_PEER_PORT, tower :$TOWER_PORT, bitcoind :$BTC_RPC_PORT.
Environment: T1 [$T1] T2 [$T2] DELTA [$DELTA] BLOCK_MS [$BLOCK_MS] FERRY_WT_DEMO_DIR [$STATE]
EOF
}

log() { printf '[wt-demo] %s\n' "$*"; }
die() { printf '[wt-demo] error: %s\n' "$*" >&2; exit 1; }

rpc() { # rpc <wallet|""> <method> [json params]
  local url="$BTC_RPC"
  [ -n "$1" ] && url="$BTC_RPC/wallet/$1"
  curl -sf --user ferry:ferry -H 'content-type: text/plain;' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"wt\",\"method\":\"$2\",\"params\":${3:-[]}}" "$url"
}
result() { python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r if not isinstance(r,(dict,list)) else json.dumps(r))'; }
# field <python expression on j>: read JSON from stdin.
field() { python3 -c "import json,sys; j=json.load(sys.stdin); print($1)"; }

api() { # api <z|b> <path> [curl args...]
  local key=$1 path=$2 port=$Z_PORT
  shift 2
  [ "$key" = b ] && port=$B_PORT
  curl -sf -H "authorization: Bearer $(cat "$STATE/$key/api-token")" "$@" "http://127.0.0.1:$port$path"
}
tower() { curl -sf -H "authorization: Bearer $(cat "$STATE/tower/token")" "$TOWER$1"; }

alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
# Only ever the exact pid this script started.
stop_pid() {
  if alive "$1"; then
    kill "$(cat "$STATE/$1.pid")" 2>/dev/null || true
    for _ in $(seq 1 25); do alive "$1" || break; sleep 0.2; done
    alive "$1" && kill -9 "$(cat "$STATE/$1.pid")" 2>/dev/null || true
  fi
  rm -f "$STATE/$1.pid"
}

wait_http() { # wait_http <key> <cmd...>
  local key=$1
  shift
  for _ in $(seq 1 60); do
    "$@" >/dev/null 2>&1 && return 0
    alive "$key" || break
    sleep 0.5
  done
  tail -n 20 "$STATE/logs/$key.log" >&2
  die "$key did not come up"
}

start_ferryd() { # start_ferryd <key> <role> <api port> <peer port> [extra args...]
  local key=$1 role=$2 port=$3 peer=$4
  shift 4
  "$FERRYD" --role "$role" --name "wt-$key" --api-listen "127.0.0.1:$port" --listen "127.0.0.1:$peer" \
    --data-dir "$STATE/$key" --dev-policy --btc-rpc "$BTC_RPC" --btc-wallet "wt-$key" \
    --zec mock --zec-mock-file "$STATE/zec-mock.json" --zec-mock-block-secs 1 \
    --t1 "$T1" --t2 "$T2" --delta "$DELTA" --btc-lock-confs 1 --zec-confs 2 --cancel-confs 1 \
    --poll-ms 300 --sweep-delay-secs 0:1 --ui-origin "http://localhost:$UI_PORT" --ui-origin "http://127.0.0.1:$UI_PORT" "$@" >>"$STATE/logs/$key.log" 2>&1 &
  echo $! >"$STATE/$key.pid"
  disown
  wait_http "$key" api "$key" /api/status
}

start_tower() {
  "$WATCHTOWER" --listen "127.0.0.1:$TOWER_PORT" --data-dir "$STATE/tower" --token-file "$STATE/tower/token" \
    --btc-rpc "$BTC_RPC" --network regtest --poll-ms 300 >>"$STATE/logs/tower.log" 2>&1 &
  echo $! >"$STATE/tower.pid"
  disown
  wait_http tower curl -sf "$TOWER/health"
}

TOWER_ARGS=()
tower_args() { TOWER_ARGS=(--watchtower "$TOWER" --watchtower-token-file "$STATE/tower/token" "$@"); }

mine() { rpc "" generatetoaddress "[${1:-1}, \"$MINER\"]" >/dev/null; }

# until_ok <max blocks> <description> <cmd...>: mine a block every BLOCK_MS until cmd succeeds.
until_ok() {
  local max=$1 what=$2
  shift 2
  for _ in $(seq 1 "$max"); do
    "$@" 2>/dev/null && return 0
    mine 1
    sleep "$(python3 -c "print($BLOCK_MS/1000)")"
  done
  "$@" 2>/dev/null && return 0
  die "timed out waiting for: $what"
}

swap_field() { api "$1" "/api/swaps/$2" | field "$3"; }
state_is() { [ "$(swap_field "$1" "$2" "j['state']")" = "$3" ]; }
tower_armed() { [ "$(swap_field "$1" "$2" "(j.get('watchtower') or {}).get('status')")" = armed ]; }
both_armed() { tower_armed b "$1" && tower_armed z "$1"; }
tower_package() { swap_field "$1" "$2" "(j.get('watchtower') or {}).get('package_id')"; }
tower_sees_lock() { [ "$(tower "/packages/$1" | field "j['lock_confs']")" != None ]; }
tower_outcome() { [ "$(tower "/packages/$1" | field "j['outcome']")" = "$2" ]; }

show_package() { # show_package <id>: the tower's view, one line per broadcast
  tower "/packages/$1" | python3 -c '
import json,sys
j=json.load(sys.stdin)
print("  tower package %s… (%s): status=%s outcome=%s" % (j["id"][:8], j["role"], j["status"], j["outcome"]))
for b in j["broadcasts"]:
    print("    broadcast %-6s %s…  at lock_confs=%s cancel_confs=%s error=%s" % (b["spend"], b["txid"][:16], b["lock_confs"], b["cancel_confs"], b["error"]))
print("    advice: %s" % j["advice"])'
}

new_swap() {
  api z /api/swaps -XPOST -H 'content-type: application/json' \
    -d "{\"maker\":\"$MAKER_URL\",\"zec_zat\":100000000}" | field "j['id']"
}

down() {
  for k in z b tower; do stop_pid "$k"; done
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  log "stopped"
}

setup() {
  command -v docker >/dev/null || die "docker is required"
  log "building ferryd and ferry-watchtower"
  (cd "$ROOT" && cargo build -q -p ferryd -p ferry-watchtower)
  for k in z b tower; do stop_pid "$k"; done
  rm -rf "$STATE/z" "$STATE/b" "$STATE/tower" "$STATE/zec-mock.json"
  mkdir -p "$STATE/logs" "$STATE/tower"

  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  log "starting bitcoind on 127.0.0.1:$BTC_RPC_PORT (container $CONTAINER)"
  docker run -d --name "$CONTAINER" -p "127.0.0.1:$BTC_RPC_PORT:18443" "$IMAGE" \
    -regtest -server -printtoconsole -rpcuser=ferry -rpcpassword=ferry \
    -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 -fallbackfee=0.0002 >/dev/null
  for _ in $(seq 1 60); do rpc "" getblockcount >/dev/null 2>&1 && break; sleep 0.5; done
  rpc "" createwallet '["miner"]' >/dev/null
  MINER=$(rpc miner getnewaddress '["", "bech32m"]' | result)
  mine 101

  log "starting the watchtower on $TOWER (keyless; token in $STATE/tower/token)"
  start_tower
  tower_args --watchtower-own
  log "starting B (maker, arms its OWN tower) and Z (arms the tower)"
  start_ferryd b b "$B_PORT" "$B_PEER_PORT" --maker-offer 410000 "${TOWER_ARGS[@]}"
  tower_args
  start_ferryd z z "$Z_PORT" "$Z_PEER_PORT" --zec-mock-balance 500000000 "${TOWER_ARGS[@]}"
  local b_addr
  b_addr=$(api b /api/addresses | field "j['btc']['address']")
  rpc miner sendtoaddress "[\"$b_addr\", 1]" >/dev/null
  mine 1
  umask 077
  cat >"$STATE/env" <<ENV
export FERRY_Z_URL=http://127.0.0.1:$Z_PORT
export FERRY_B_URL=http://127.0.0.1:$B_PORT
export FERRY_MAKER_URL=$MAKER_URL
export FERRY_Z_TOKEN=$(cat "$STATE/z/api-token")
export FERRY_B_TOKEN=$(cat "$STATE/b/api-token")
export FERRY_BTC_RPC=$BTC_RPC
export PORT=$UI_PORT
ENV
  umask 022
}

up() {
  setup
  log "up: Z :$Z_PORT, B :$B_PORT (its own tower), tower $TOWER; UI settings in $STATE/env (no block producer: mine with the script's rpc or the shoot script)"
}

run() {
  setup

  # ------------------------------------------------------------ story 1: B killed, tower refunds
  log "story 1: B locks BTC, then B is killed; its tower must refund it"
  local id bpkg zpkg
  id=$(new_swap)
  until_ok 20 "both towers armed" both_armed "$id"
  bpkg=$(tower_package b "$id")
  zpkg=$(tower_package z "$id")
  until_ok 10 "the tower sees the lock" tower_sees_lock "$bpkg"
  log "  B armed tower package ${bpkg:0:8}… and broadcast its lock; killing B (pid $(cat "$STATE/b.pid"))"
  stop_pid b
  until_ok $((T1 + T2 + 10)) "B's tower refunds" tower_outcome "$bpkg" refunded
  until_ok 10 "Z reclaims its ZEC" state_is z "$id" ZecReclaimed
  show_package "$bpkg"
  show_package "$zpkg"
  [ "$(tower "/packages/$bpkg" | field "[b['spend'] for b in j['broadcasts'] if not b['error']].count('Refund')")" = 1 ] ||
    die "the refund was not broadcast by the tower"
  log "  restarting B: it finds its swap finished"
  tower_args --watchtower-own
  start_ferryd b b "$B_PORT" "$B_PEER_PORT" --maker-offer 410000 "${TOWER_ARGS[@]}"
  until_ok 10 "B sees Refunded" state_is b "$id" Refunded
  log "story 1 done: B $(swap_field b "$id" "j['state']"), Z $(swap_field z "$id" "j['state']")"

  # ------------------------------------------------------------ story 2: both killed, tower punishes
  log "story 2: B runs without --watchtower-own, so it refuses to arm; both parties are killed"
  stop_pid b
  tower_args
  start_ferryd b b "$B_PORT" "$B_PEER_PORT" --maker-offer 410000 "${TOWER_ARGS[@]}"
  id=$(new_swap)
  until_ok 20 "Z's tower armed" tower_armed z "$id"
  zpkg=$(tower_package z "$id")
  [ "$(swap_field b "$id" "(j.get('watchtower') or {}).get('status')")" = refused ] ||
    die "B should have refused to arm a tower it was not told is its own"
  log "  B: $(swap_field b "$id" "j['watchtower']['note']")"
  until_ok 10 "the tower sees the lock" tower_sees_lock "$zpkg"
  log "  killing B (pid $(cat "$STATE/b.pid"))"
  stop_pid b
  until_ok 20 "Z locks ZEC" state_is z "$id" ZecLocked
  log "  Z locked ZEC; killing Z (pid $(cat "$STATE/z.pid"))"
  stop_pid z
  until_ok $((T1 + T2 + 10)) "Z's tower punishes" tower_outcome "$zpkg" punished
  show_package "$zpkg"
  log "  restarting Z: it finds the BTC taken for it"
  tower_args
  start_ferryd z z "$Z_PORT" "$Z_PEER_PORT" "${TOWER_ARGS[@]}"
  until_ok 10 "Z sees Punished" state_is z "$id" Punished
  log "story 2 done: Z $(swap_field z "$id" "j['state']") (BTC taken by its tower while it was offline)"
  log "all stories passed; logs in $STATE/logs. Stop with: infra/demo-watchtower.sh down"
}

case "${1:-help}" in
  run) run ;;
  up) up ;;
  down) down ;;
  *) usage ;;
esac
