#!/usr/bin/env bash
# Local privacy-hub demo: a route BTC -> shielded ZEC -> USDC, two Ferry swaps chained through one
# mock Zcash chain by ferry-route. Leg 1 runs on regtest BTC (infra/demo.sh), leg 2 on USDC in
# FerryLock on anvil (infra/evm-demo.sh). Run `infra/route-demo.sh help`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${FERRY_ROUTE_DEMO_DIR:-$ROOT/.demo-route}"
FERRYD="${FERRYD:-$ROOT/target/debug/ferryd}"
FERRY_ROUTE="${FERRY_ROUTE:-$ROOT/target/debug/ferry-route}"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
CAST="${CAST:-$(command -v cast || echo "$FOUNDRY_BIN/cast")}"

# Leg 1 (BTC): maker-z sells ZEC (a Z maker), user-b buys it (the user's L1, a B taker).
BITCOIND_CONTAINER="${BITCOIND_CONTAINER:-ferry-route-bitcoind}"
BTC_RPC_PORT="${BTC_RPC_PORT:-18653}"
L1_MAKER_PORT="${L1_MAKER_PORT:-7121}"       # maker-z's API
L1_USER_PORT="${L1_USER_PORT:-7122}"         # user-b's API
L1_MAKER_PEER_PORT="${L1_MAKER_PEER_PORT:-7131}"
L1_USER_PEER_PORT="${L1_USER_PEER_PORT:-7132}"
BTC_RATE="${BTC_RATE:-410000}"               # sat per ZEC
# Leg 2 (USDC on anvil): user-z sells ZEC (the user's L2, a Z taker), maker-b buys it (a B maker).
ANVIL_PORT="${ANVIL_PORT:-18555}"
L2_USER_PORT="${L2_USER_PORT:-7921}"         # user-z's API
L2_MAKER_PORT="${L2_MAKER_PORT:-7922}"       # maker-b's API
L2_USER_PEER_PORT="${L2_USER_PEER_PORT:-7931}"
L2_MAKER_PEER_PORT="${L2_MAKER_PEER_PORT:-7932}"
USDC_RATE="${USDC_RATE:-40000000}"           # USDC base units (10^-6) per ZEC
ROUTER_PORT="${ROUTER_PORT:-7140}"
# Both demos share one mock Zcash chain, so both use one block time.
ZEC_BLOCK_SECS="${ZEC_BLOCK_SECS:-2}"
MAKER_ZEC_ZAT="${MAKER_ZEC_ZAT:-500000000}"  # maker-z's shielded ZEC; user-z starts with none
ROUTE_ZAT="${ROUTE_ZAT:-100000000}"          # the ZEC each route buys (1 ZEC)
# Short demo timings (ferry-route flags): the sweep's confirmations before leg 2, the retry
# interval and the leg-2 window. The privacy pause is per route (each story names its own).
ROUTE_ZEC_CONFS="${ROUTE_ZEC_CONFS:-10}"
ROUTE_RETRY_SECS="${ROUTE_RETRY_SECS:-5}"
ROUTE_LEG2_WINDOW_SECS="${ROUTE_LEG2_WINDOW_SECS:-300}"
# What a route keeps back for fees on the way (ferry-route's --zec-fee-zat + --zec-lock-reserve-zat).
ROUTE_FEES_ZAT=60000

usage() {
  cat <<EOF
Ferry privacy-hub demo: BTC -> shielded ZEC -> USDC, two atomic swaps run by ferry-route.

  infra/route-demo.sh up     regtest bitcoind ($BITCOIND_CONTAINER, :$BTC_RPC_PORT) with maker-z (Z maker,
                             :$L1_MAKER_PORT) and user-b (your B daemon, :$L1_USER_PORT); anvil (:$ANVIL_PORT) with
                             user-z (your Z daemon, :$L2_USER_PORT, no ZEC) and maker-b (B maker, :$L2_MAKER_PORT);
                             one mock Zcash chain for all four; ferry-route on :$ROUTER_PORT
  infra/route-demo.sh test   up, then three routes, then down; exits non-zero if one fails:
                             happy   BTC -> ZEC -> USDC to done (the router restarts twice midway)
                             refund  leg 2 is refunded: the route holds shielded ZEC; continue
                                     finishes it
                             stop    stopped during leg 1: the route ends holding the ZEC
  infra/route-demo.sh happy | refund | stop    one story on a running demo
  infra/route-demo.sh status | down | help

The router's API: curl -H "authorization: Bearer \$(cat $STATE/router/api-token)" \\
  http://127.0.0.1:$ROUTER_PORT/api/routes
Environment (defaults in brackets): FERRY_ROUTE_DEMO_DIR [$STATE] BITCOIND_CONTAINER BTC_RPC_PORT
  ANVIL_PORT L1_MAKER_PORT L1_USER_PORT L1_MAKER_PEER_PORT L1_USER_PEER_PORT L2_USER_PORT
  L2_MAKER_PORT L2_USER_PEER_PORT L2_MAKER_PEER_PORT ROUTER_PORT (as above)
  ROUTE_ZAT [$ROUTE_ZAT] ROUTE_ZEC_CONFS [$ROUTE_ZEC_CONFS] ROUTE_RETRY_SECS [$ROUTE_RETRY_SECS]
  ROUTE_LEG2_WINDOW_SECS [$ROUTE_LEG2_WINDOW_SECS] ZEC_BLOCK_SECS [$ZEC_BLOCK_SECS]
  BTC_RATE [$BTC_RATE] USDC_RATE [$USDC_RATE] MAKER_ZEC_ZAT [$MAKER_ZEC_ZAT]
EOF
}

log() { printf '[route-demo] %s\n' "$*"; }
die() { printf '[route-demo] error: %s\n' "$*" >&2; exit 1; }

# The two chain demos, on this demo's ports, directories and shared mock chain.
btc_demo() {
  CHAIN=btc MAKER=z FERRY_DEMO_DIR="$STATE/btc" Z_NAME=maker-z B_NAME=user-b \
    BITCOIND_CONTAINER="$BITCOIND_CONTAINER" BTC_RPC_PORT="$BTC_RPC_PORT" \
    Z_PORT="$L1_MAKER_PORT" B_PORT="$L1_USER_PORT" Z_PEER_PORT="$L1_MAKER_PEER_PORT" \
    B_PEER_PORT="$L1_USER_PEER_PORT" RATE="$BTC_RATE" ZEC_BACKEND=mock \
    ZEC_MOCK_FILE="$STATE/zec-mock.json" ZEC_BLOCK_SECS="$ZEC_BLOCK_SECS" \
    ZEC_BALANCE_ZAT="$MAKER_ZEC_ZAT" FERRYD_SKIP_BUILD=1 FERRYD="$FERRYD" \
    FERRYD_ARGS="--sweep-delay-secs 1:3" "$ROOT/infra/demo.sh" "$@"
}

evm_demo() {
  TOKEN=usdc MAKER=b FERRY_EVM_DEMO_DIR="$STATE/evm" Z_NAME=user-z B_NAME=maker-b \
    ANVIL_PORT="$ANVIL_PORT" Z_PORT="$L2_USER_PORT" B_PORT="$L2_MAKER_PORT" \
    Z_PEER_PORT="$L2_USER_PEER_PORT" B_PEER_PORT="$L2_MAKER_PEER_PORT" RATE="$USDC_RATE" \
    ZEC_MOCK_FILE="$STATE/zec-mock.json" ZEC_BLOCK_SECS="$ZEC_BLOCK_SECS" ZEC_BALANCE_ZAT=0 \
    FERRYD_SKIP_BUILD=1 FERRYD="$FERRYD" "$ROOT/infra/evm-demo.sh" "$@"
}

alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

# Stop exactly the process we started (by its recorded PID).
stop_pid() {
  if alive "$1"; then
    kill "$(cat "$STATE/$1.pid")" 2>/dev/null || true
    for _ in $(seq 1 20); do alive "$1" || break; sleep 0.2; done
    alive "$1" && kill -9 "$(cat "$STATE/$1.pid")" 2>/dev/null || true
  fi
  rm -f "$STATE/$1.pid"
}

# d <daemon> <path> [curl args...]: a daemon's control API. Daemons: user-b, maker-z (BTC),
# user-z, maker-b (anvil), router.
d() {
  local who=$1 path=$2 port token
  shift 2
  case "$who" in
    user-b) port=$L1_USER_PORT token="$STATE/btc/b/api-token" ;;
    maker-z) port=$L1_MAKER_PORT token="$STATE/btc/z/api-token" ;;
    user-z) port=$L2_USER_PORT token="$STATE/evm/z/api-token" ;;
    maker-b) port=$L2_MAKER_PORT token="$STATE/evm/b/api-token" ;;
    router) port=$ROUTER_PORT token="$STATE/router/api-token" ;;
    *) die "no daemon $who" ;;
  esac
  curl -sf -H "authorization: Bearer $(cat "$token")" "$@" "http://127.0.0.1:$port$path"
}

# json <python expression on v> < JSON (the expressions are this script's own constants)
json() { python3 -c 'import json, sys; v = json.load(sys.stdin); r = eval(sys.argv[1]); print(r if not isinstance(r, (dict, list, bool)) and r is not None else json.dumps(r))' "$1"; }

route() { d router "/api/routes/$1"; }
route_field() { route "$1" | json "$2"; }
zec_balance() { d "$1" /api/status | json 'v["balances"]["zec_shielded_zat"]'; }
token_balance() { d "$1" /api/status | json 'v["balances"]["btc_sat"]'; }
# The swap carrying a route label on a daemon, as JSON ("null" if none).
labelled() { d "$1" /api/swaps | python3 -c 'import json, sys; m = [s for s in json.load(sys.stdin) if s.get("route") == sys.argv[1]]; print(json.dumps(m[-1]) if m else "null")' "$2"; }
labelled_count() { d "$1" /api/swaps | python3 -c 'import json, sys; print(len([s for s in json.load(sys.stdin) if s.get("route") == sys.argv[1]]))' "$2"; }

# wait_for <secs> <what> <shell condition> (conditions are this script's own constants)
wait_for() {
  local secs=$1 what=$2 cond=$3 i=0
  while ! eval "$cond" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ $i -gt $((secs * 4)) ]; then
      [ -n "${RID:-}" ] && log "route: $(route "$RID" | json '[v["state"], v["phase"], v["problem"], v["note"]]' 2>/dev/null || echo '?')"
      die "timed out waiting for $what"
    fi
    sleep 0.25
  done
}

state_is() { [ "$(route_field "$RID" 'v["state"]')" = "$1" ]; }

# units_for <zat> <rate>: what ferryd quotes, zat * rate / 10^8 rounded to the nearest unit.
units_for() { python3 -c 'import sys; print((int(sys.argv[1]) * int(sys.argv[2]) + 50000000) // 100000000)' "$1" "$2"; }
# pct <units> <percent>: units scaled by percent, rounded down
pct() { python3 -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]) // 100)' "$1" "$2"; }

start_router() {
  "$FERRY_ROUTE" --data-dir "$STATE/router" --api-listen "127.0.0.1:$ROUTER_PORT" \
    --leg "btc:b=http://127.0.0.1:$L1_USER_PORT" --leg-token-file "btc:b=$STATE/btc/b/api-token" \
    --leg "usdc-base:z=http://127.0.0.1:$L2_USER_PORT" --leg-token-file "usdc-base:z=$STATE/evm/z/api-token" \
    --zec-confs "$ROUTE_ZEC_CONFS" --retry-secs "$ROUTE_RETRY_SECS" \
    --leg2-window-secs "$ROUTE_LEG2_WINDOW_SECS" --start-grace-secs 30 --tick-secs 1 \
    >>"$STATE/logs/router.log" 2>&1 &
  echo $! >"$STATE/router.pid"
  disown
  for _ in $(seq 1 60); do
    [ -s "$STATE/router/api-token" ] && d router /api/status >/dev/null 2>&1 && return 0
    alive router || break
    sleep 0.25
  done
  tail -n 20 "$STATE/logs/router.log" >&2
  die "ferry-route did not come up (log: $STATE/logs/router.log)"
}

cmd_up() {
  if alive router || [ -f "$STATE/btc/z.pid" ] || [ -f "$STATE/evm/z.pid" ]; then
    die "already running (infra/route-demo.sh status). Run infra/route-demo.sh down first"
  fi
  command -v python3 >/dev/null || die "python3 is required"
  rm -rf "$STATE/router" "$STATE/zec-mock.json"
  mkdir -p "$STATE/logs"
  log "building ferryd and ferry-route"
  (cd "$ROOT" && cargo build -q -p ferryd -p ferry-route) || die "cargo build failed"
  log "leg 1 chain: regtest BTC (maker-z sells ZEC, user-b buys it)"
  btc_demo up
  log "leg 2 chain: USDC on anvil (user-z sells ZEC, maker-b buys it)"
  evm_demo up
  log "starting ferry-route on 127.0.0.1:$ROUTER_PORT"
  start_router
  log "ready: route BTC -> shielded ZEC -> USDC; user-z's ZEC: $(zec_balance user-z) zat"
}

cmd_down() {
  stop_pid router
  btc_demo down || true
  evm_demo down || true
  log "stopped (logs in $STATE/logs, $STATE/btc/logs, $STATE/evm/logs)"
}

cmd_status() {
  if alive router; then
    d router /api/routes | python3 -c '
import json, sys
for r in json.load(sys.stdin):
    print("route %s  %-8s %-14s %s" % (r["id"], r["state"], r["phase"], r["note"]))' || echo "router running but not answering"
  else
    echo "router down"
  fi
  btc_demo status || true
  evm_demo status || true
}

# POST /api/routes for ROUTE_ZAT with a 1% price margin each way; prints the route id.
new_route() { # new_route <delay min> <delay max>
  local max_in min_out out
  max_in=$(units_for "$ROUTE_ZAT" "$BTC_RATE")
  max_in=$((max_in + max_in / 100))
  min_out=$(pct "$(units_for $((ROUTE_ZAT - ROUTE_FEES_ZAT)) "$USDC_RATE")" 99)
  out=$(curl -s -H "authorization: Bearer $(cat "$STATE/router/api-token")" \
    -H 'content-type: application/json' -d "{
    \"from\": \"btc\", \"to\": \"usdc-base\", \"zec_zat\": $ROUTE_ZAT,
    \"maker1\": {\"url\": \"http://127.0.0.1:$L1_MAKER_PEER_PORT\", \"name\": \"maker-z\"},
    \"maker2\": [{\"url\": \"http://127.0.0.1:$L2_MAKER_PEER_PORT\", \"name\": \"maker-b\"}],
    \"max_in\": $max_in, \"min_out\": $min_out, \"delay_secs\": [$1, $2]}" \
    "http://127.0.0.1:$ROUTER_PORT/api/routes")
  echo "$out" | json 'v["id"]' 2>/dev/null || die "the route was refused: $out"
}

# Each leg's chain transactions, from its daemon's timeline.
show_txs() { # show_txs <route id>
  local n who swap
  for n in 1 2; do
    who=user-b
    [ "$n" = 2 ] && who=user-z
    for label in $(route "$1" | python3 -c '
import json, sys
r = json.load(sys.stdin)
l = r["legs"][int(sys.argv[1]) - 1]
# every label this leg had: earlier swaps were followed under <id>/2, <id>/2-2, ...
labels = [r["id"] + "/1"] if sys.argv[1] == "1" else [r["id"] + "/2"] + [r["id"] + "/2-%d" % g for g in range(2, 2 + len(l["earlier_swaps"]))]
print(" ".join(labels))' "$n"); do
      swap=$(labelled "$who" "$label")
      [ "$swap" = null ] && continue
      echo "$swap" | python3 -c '
import json, sys
s = json.load(sys.stdin)
print("  leg %s (%s on %s, %s, outcome %s):" % (sys.argv[1], s["role"], sys.argv[2], s["route"], s["outcome"]))
for e in s["timeline"]:
    if e.get("txid"):
        print("    %-4s %-22s %s%s" % (e["chain"], e["kind"], e["txid"], "" if e.get("height") is None else "  (height %d)" % e["height"]))' "$n" "$who"
    done
  done
}

finish() { # finish <route id> <started epoch>
  show_txs "$1"
  log "\"$(route_field "$1" 'v["note"]')\"  ($(($(date +%s) - $2))s)"
}

# ---------------------------------------------------------------- the stories

story_happy() {
  log "--- happy: BTC -> shielded ZEC -> USDC, with a 10-15s privacy pause; the router restarts in settling and in pausing"
  local t0 z0 u0 sweep_to label
  t0=$(date +%s)
  z0=$(zec_balance user-z)
  u0=$(token_balance user-z)
  RID=$(new_route 10 15)
  log "route $RID"
  wait_for 120 "leg 1 to start" '[ "$(labelled user-b "$RID/1")" != null ]'
  sweep_to=$(labelled user-b "$RID/1" | json 'v["sweep_to"]')
  [ "$sweep_to" = "$(d user-z /api/addresses | json 'v["zec"]["address"]')" ] ||
    die "leg 1 sweeps to $sweep_to, not user-z's wallet"
  log "leg 1 sweeps to user-z's shielded address ($sweep_to)"
  wait_for 300 "leg 1 to finish (settling)" 'state_is settling || state_is pausing || state_is failed || state_is holding'
  state_is settling || die "after leg 1 the route is $(route_field "$RID" 'v["state"]'): $(route_field "$RID" 'v["note"]')"
  stop_pid router
  start_router
  log "restarted ferry-route while settling"
  wait_for 120 "the ZEC to be spendable (pausing)" 'state_is pausing || state_is leg2'
  if state_is pausing; then
    stop_pid router
    start_router
    log "restarted ferry-route while pausing"
  fi
  wait_for 300 "the route to finish" 'state_is done || state_is holding || state_is failed'
  state_is done || die "the route ended $(route_field "$RID" 'v["state"]'): $(route_field "$RID" 'v["note"]')"
  [ "$(labelled_count user-z "$RID/2")" = 1 ] || die "leg 2 ran $(labelled_count user-z "$RID/2") times"
  local zec2 got out_min z1
  zec2=$(route_field "$RID" 'v["amounts"]["zec2_zat"]')
  out_min=$(route_field "$RID" 'v["amounts"]["out_min"]')
  z1=$((z0 + ROUTE_ZAT - zec2))
  wait_for 30 "user-z to hold $z1 zat ($z0 + $ROUTE_ZAT from leg 1 - $zec2 sold in leg 2)" \
    '[ "$(zec_balance user-z)" = "$z1" ]'
  wait_for 30 "user-z's USDC" '[ "$(token_balance user-z)" -gt "$u0" ]'
  got=$(($(token_balance user-z) - u0))
  [ "$got" -ge "$out_min" ] || die "user-z received $got USDC units, below out_min $out_min"
  log "happy: user-z's wallet received $ROUTE_ZAT zat from leg 1 and sold $zec2 of it for $got USDC units (out_min $out_min); exactly one leg 2"
  finish "$RID" "$t0"
}

story_refund() {
  log "--- refund: user-z stalls after locking ZEC in leg 2; maker-b refunds at t1; the route holds the ZEC; continue finishes it"
  local t0 swap id t1 held
  t0=$(date +%s)
  RID=$(new_route 0 0)
  log "route $RID"
  wait_for 300 "leg 2's swap" '[ "$(labelled user-z "$RID/2")" != null ]'
  id=$(labelled user-z "$RID/2" | json 'v["id"]')
  wait_for 60 "user-z to lock ZEC" '[ "$(labelled user-z "$RID/2" | json "v[\"state\"]")" = ZecLocked ]'
  d user-z "/api/swaps/$id/fault" -X POST -H 'content-type: application/json' -d '{"fault":"stall"}' >/dev/null ||
    die "could not stall user-z"
  log "user-z is stalled (it will not claim)"
  wait_for 60 "maker-b to sign Ready" '[ "$(d maker-b /api/swaps/$id | json "v[\"state\"]")" = ReadySent ]'
  t1=$(d maker-b "/api/swaps/$id" | json 'v["deadlines"]["t1_unix"]')
  "$CAST" rpc evm_setNextBlockTimestamp "$t1" --rpc-url "http://127.0.0.1:$ANVIL_PORT" >/dev/null
  "$CAST" rpc evm_mine --rpc-url "http://127.0.0.1:$ANVIL_PORT" >/dev/null
  log "jumped anvil to t1 ($t1)"
  wait_for 120 "the route to hold the ZEC" 'state_is holding'
  [ "$(labelled user-z "$RID/2" | json 'v["outcome"]')" = refunded ] || die "leg 2 did not end refunded"
  held=$(route_field "$RID" 'v["zec"]["held_zat"]')
  log "holding: \"$(route_field "$RID" 'v["note"]')\""
  d router "/api/routes/$RID/continue" -X POST -H 'content-type: application/json' -d '{}' >/dev/null ||
    die "continue was refused"
  log "continue: leg 2 again, as $RID/2-2"
  wait_for 300 "the route to finish" 'state_is done || state_is failed || state_is holding'
  state_is done || die "after continue the route is $(route_field "$RID" 'v["state"]'): $(route_field "$RID" 'v["note"]')"
  [ "$(labelled user-z "$RID/2-2" | json 'v["outcome"]')" = swapped ] || die "the second leg-2 swap did not swap"
  log "refund: leg 2 refunded (user-z reclaimed its ZEC, held ~$held zat), then continue sold it"
  finish "$RID" "$t0"
}

story_stop() {
  log "--- stop: the route is stopped while leg 1 runs; leg 1 finishes and the ZEC stays in user-z's wallet"
  local t0 z0
  t0=$(date +%s)
  z0=$(zec_balance user-z)
  RID=$(new_route 0 0)
  log "route $RID"
  [ "$(route_field "$RID" 'v["state"]')" = leg1 ] || die "the route is not in leg 1"
  d router "/api/routes/$RID/stop" -X POST >/dev/null || die "stop was refused"
  [ "$(route_field "$RID" 'v["stop_requested"]')" = true ] || die "the stop was not recorded"
  log "stop requested during leg 1"
  wait_for 300 "leg 1 to finish and the route to hold" 'state_is holding || state_is failed'
  state_is holding || die "the route ended $(route_field "$RID" 'v["state"]')"
  # The route holds once leg 1 is redeemed (the ZEC is the user's); the sweep follows.
  wait_for 60 "leg 1's sweep" '[ "$(labelled user-b "$RID/1" | json "v[\"outcome\"]")" = swapped ]'
  [ "$(labelled user-z "$RID/2")" = null ] || die "a leg-2 swap exists after stop"
  wait_for 60 "the ZEC in user-z's wallet" '[ "$(zec_balance user-z)" = "$((z0 + ROUTE_ZAT))" ]'
  log "stop: no leg 2; user-z holds the $ROUTE_ZAT zat leg 1 bought"
  finish "$RID" "$t0"
}

cmd_test() {
  trap cmd_down EXIT
  cmd_up
  local t0
  t0=$(date +%s)
  story_happy
  story_refund
  story_stop
  log "all three routes passed ($(($(date +%s) - t0))s)"
}

case "${1:-help}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  happy) story_happy ;;
  refund) story_refund ;;
  stop) story_stop ;;
  test) cmd_test ;;
  help | -h | --help) usage ;;
  *) usage; exit 2 ;;
esac
