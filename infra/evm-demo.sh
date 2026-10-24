#!/usr/bin/env bash
# Local Ferry demo against an EVM chain: shielded ZEC (mock Zcash) <-> USDC (MockUSDC) locked in
# FerryLock on anvil. Two ferryd daemons with --counter evm. Run `infra/evm-demo.sh help`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${FERRY_EVM_DEMO_DIR:-$ROOT/.demo-evm}"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
ANVIL="${ANVIL:-$(command -v anvil || echo "$FOUNDRY_BIN/anvil")}"
FORGE="${FORGE:-$(command -v forge || echo "$FOUNDRY_BIN/forge")}"
CAST="${CAST:-$(command -v cast || echo "$FOUNDRY_BIN/cast")}"
FERRYD="${FERRYD:-$ROOT/target/debug/ferryd}"

ANVIL_PORT="${ANVIL_PORT:-18545}"
RPC="http://127.0.0.1:$ANVIL_PORT"
Z_PORT="${Z_PORT:-7901}"           # control API (/api/*, loopback)
B_PORT="${B_PORT:-7902}"
Z_PEER_PORT="${Z_PEER_PORT:-7911}" # peer protocol (/peer/*)
B_PEER_PORT="${B_PEER_PORT:-7912}"
MAKER_URL="http://127.0.0.1:$B_PEER_PORT"
UI_ORIGINS="${UI_ORIGINS:-http://localhost:7990 http://127.0.0.1:7990}"
Z_NAME="${Z_NAME:-zoe}"
B_NAME="${B_NAME:-bram}"
# USDC base units (10^-6) per ZEC: 40 USDC/ZEC
RATE="${RATE:-40000000}"
B_FUND_USDC="${B_FUND_USDC:-1000000000}" # 1000 USDC
ZEC_BALANCE_ZAT="${ZEC_BALANCE_ZAT:-500000000}"
ZEC_BLOCK_SECS="${ZEC_BLOCK_SECS:-2}"
ZEC_CONFS="${ZEC_CONFS:-2}"
SWAP_ZAT="${SWAP_ZAT:-100000000}"
T1_SECS="${T1_SECS:-120}"
REFUND_SECS="${REFUND_SECS:-120}"
DELTA_SECS="${DELTA_SECS:-15}"
LOCK_CONFS="${LOCK_CONFS:-1}"
POLL_MS="${POLL_MS:-300}"

# anvil's default accounts (test mnemonic): 0 deploys, 1 is B (holds USDC), 2 is Z.
KEY_DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEY_B=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
KEY_Z=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

usage() {
  cat <<EOF
Ferry EVM demo: shielded ZEC (mock Zcash chain) <-> USDC (MockUSDC) in FerryLock on anvil.

  infra/evm-demo.sh up       anvil on 127.0.0.1:$ANVIL_PORT (1s blocks), deploy FerryLock + MockUSDC,
                             fund B with USDC, build ferryd, start Z ($Z_NAME :$Z_PORT) and B
                             ($B_NAME :$B_PORT, maker at $RATE USDC units/ZEC). Starts from scratch.
  infra/evm-demo.sh happy    one swap: B locks USDC, Z locks ZEC, B signs Ready, Z claims (revealing z),
                             B reads z and sweeps the ZEC
  infra/evm-demo.sh refund   Z stalls after locking ZEC; at t1 (anvil time is jumped there) B refunds,
                             revealing b; Z wakes and reclaims its ZEC
  infra/evm-demo.sh punish   B stalls after locking; Z locks ZEC, never gets Ready; at t2 Z punishes
  infra/evm-demo.sh test     up, happy, refund, punish, down; exits non-zero if any story fails
  infra/evm-demo.sh status | down | logs [z|b|anvil] | help

Ports: anvil $ANVIL_PORT, Z API $Z_PORT / peer $Z_PEER_PORT, B API $B_PORT / peer $B_PEER_PORT.
UI: cd web && source $STATE/env && PORT=7990 pnpm dev:ui   (screenshots: pnpm shoot:evm)
Environment: RATE [$RATE] SWAP_ZAT [$SWAP_ZAT] T1_SECS [$T1_SECS] REFUND_SECS [$REFUND_SECS]
  DELTA_SECS [$DELTA_SECS] ZEC_CONFS [$ZEC_CONFS] ZEC_BLOCK_SECS [$ZEC_BLOCK_SECS] FERRY_EVM_DEMO_DIR [$STATE]
EOF
}

log() { printf '[evm-demo] %s\n' "$*"; }
die() { printf '[evm-demo] error: %s\n' "$*" >&2; exit 1; }

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

api() { # api <z|b> <path> [curl args...]
  local key=$1 path=$2 port=$Z_PORT
  shift 2
  [ "$key" = b ] && port=$B_PORT
  curl -sf -H "authorization: Bearer $(cat "$STATE/$key/api-token")" "$@" "http://127.0.0.1:$port$path"
}

# swap_field <z|b> <python expr on s (the latest swap view)>. The expressions are this script's own
# constants, never outside input.
swap_field() {
  api "$1" /api/swaps | python3 -c '
import json, sys
swaps = json.load(sys.stdin)
s = max(swaps, key=lambda s: s["timeline"][0]["at"] if s["timeline"] else "") if swaps else None
print(eval(sys.argv[1]) if s else "")' "$2"
}

# wait_for <secs> <description> <shell condition> (conditions are this script's own constants)
wait_for() {
  local secs=$1 what=$2 cond=$3 i=0
  while ! eval "$cond" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ $i -gt $((secs * 4)) ]; then
      log "Z: $(swap_field z 's["state"]')  B: $(swap_field b 's["state"]')"
      die "timed out waiting for $what"
    fi
    sleep 0.25
  done
}

state_is() { [ "$(swap_field "$1" 's["state"]')" = "$2" ]; }
outcome_is() { [ "$(swap_field "$1" 's["outcome"]')" = "$2" ]; }

chain_time() { "$CAST" block latest --field timestamp --rpc-url "$RPC"; }

# warp <unix secs>: the next anvil block has this timestamp.
warp() {
  local now
  now=$(chain_time)
  if [ "$1" -gt "$now" ]; then
    "$CAST" rpc evm_setNextBlockTimestamp "$1" --rpc-url "$RPC" >/dev/null
    "$CAST" rpc evm_mine --rpc-url "$RPC" >/dev/null
    log "jumped anvil time forward $(($1 - now))s"
  fi
}

usdc_balance() { "$CAST" call "$(cat "$STATE/usdc")" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | awk '{print $1}'; }

deploy() { # deploy <contract path:name> -> address
  "$FORGE" create --root "$ROOT/contracts" "$1" --rpc-url "$RPC" --private-key "$KEY_DEPLOYER" --broadcast 2>&1 |
    awk '/Deployed to:/{print $3}'
}

start_ferryd() { # start_ferryd <key> <role> <name> <api port> <peer port> <key file> [extra...]
  local key=$1 role=$2 name=$3 port=$4 peer_port=$5 keyfile=$6
  shift 6
  local origins=()
  for o in $UI_ORIGINS; do origins+=(--ui-origin "$o"); done
  "$FERRYD" --counter evm --role "$role" --name "$name" --api-listen "127.0.0.1:$port" \
    --listen "127.0.0.1:$peer_port" --data-dir "$STATE/$key" --demo-faults --dev-policy \
    ${origins[@]+"${origins[@]}"} \
    --evm-rpc "$RPC" --evm-contract "$(cat "$STATE/lock")" --evm-token "$(cat "$STATE/usdc")" \
    --evm-key-file "$keyfile" --evm-t1-secs "$T1_SECS" --evm-refund-secs "$REFUND_SECS" \
    --evm-delta-secs "$DELTA_SECS" --evm-lock-confs "$LOCK_CONFS" --zec-confs "$ZEC_CONFS" \
    --zec mock --zec-mock-file "$STATE/zec-mock.json" --zec-mock-block-secs "$ZEC_BLOCK_SECS" \
    --sweep-delay-secs 1:3 --poll-ms "$POLL_MS" "$@" >>"$STATE/logs/$key.log" 2>&1 &
  echo $! >"$STATE/$key.pid"
  disown
  for _ in $(seq 1 60); do
    api "$key" /api/status >/dev/null 2>&1 && return 0
    alive "$key" || break
    sleep 0.5
  done
  tail -n 20 "$STATE/logs/$key.log" >&2
  die "ferryd $key did not come up (log: $STATE/logs/$key.log)"
}

cmd_up() {
  if alive z || alive b || alive anvil; then
    die "already running (infra/evm-demo.sh status). Run infra/evm-demo.sh down first"
  fi
  [ -x "$ANVIL" ] && [ -x "$FORGE" ] && [ -x "$CAST" ] || die "foundry is required (curl -L https://foundry.paradigm.xyz | bash; foundryup)"
  command -v python3 >/dev/null || die "python3 is required"
  rm -rf "$STATE/z" "$STATE/b" "$STATE/zec-mock.json"
  mkdir -p "$STATE/logs"
  if [ -z "${FERRYD_SKIP_BUILD:-}" ]; then
    log "building ferryd"
    (cd "$ROOT" && cargo build -q -p ferryd) || die "cargo build failed"
  fi

  log "starting anvil on $RPC (1s blocks)"
  "$ANVIL" --port "$ANVIL_PORT" --host 127.0.0.1 --block-time 1 --silent >>"$STATE/logs/anvil.log" 2>&1 &
  echo $! >"$STATE/anvil.pid"
  disown
  for _ in $(seq 1 40); do "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
  "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1 || die "anvil did not come up"

  local lock usdc
  lock=$(deploy src/FerryLock.sol:FerryLock)
  usdc=$(deploy src/MockUSDC.sol:MockUSDC)
  [ -n "$lock" ] && [ -n "$usdc" ] || die "deploying the contracts failed"
  echo "$lock" >"$STATE/lock"
  echo "$usdc" >"$STATE/usdc"
  log "FerryLock $lock  MockUSDC $usdc"

  umask 077
  echo "$KEY_B" >"$STATE/b.key"
  echo "$KEY_Z" >"$STATE/z.key"
  local b_addr
  b_addr=$("$CAST" wallet address "$KEY_B")
  "$CAST" send "$usdc" "mint(address,uint256)" "$b_addr" "$B_FUND_USDC" \
    --private-key "$KEY_DEPLOYER" --rpc-url "$RPC" >/dev/null
  log "minted $((B_FUND_USDC / 1000000)) USDC to B ($b_addr)"

  log "starting B ($B_NAME, maker at $RATE USDC units/ZEC): API :$B_PORT, peer :$B_PEER_PORT"
  start_ferryd b b "$B_NAME" "$B_PORT" "$B_PEER_PORT" "$STATE/b.key" --maker-offer "$RATE"
  log "starting Z ($Z_NAME): API :$Z_PORT, peer :$Z_PEER_PORT"
  start_ferryd z z "$Z_NAME" "$Z_PORT" "$Z_PEER_PORT" "$STATE/z.key" --zec-mock-balance "$ZEC_BALANCE_ZAT"
  cat >"$STATE/env" <<ENV
export FERRY_Z_URL=http://127.0.0.1:$Z_PORT
export FERRY_B_URL=http://127.0.0.1:$B_PORT
export FERRY_MAKER_URL=$MAKER_URL
export FERRY_Z_TOKEN=$(cat "$STATE/z/api-token")
export FERRY_B_TOKEN=$(cat "$STATE/b/api-token")
ENV
  log "ready. API tokens and UI settings: $STATE/env"
}

cmd_down() {
  stop_pid z
  stop_pid b
  stop_pid anvil
  log "stopped (logs in $STATE/logs)"
}

cmd_status() {
  if alive anvil; then
    echo "anvil   up, block $("$CAST" block-number --rpc-url "$RPC"), time $(chain_time)  ($RPC)"
  else
    echo "anvil   down"
  fi
  for key in z b; do
    if alive "$key"; then
      api "$key" /api/status | python3 -c '
import json, sys
s = json.load(sys.stdin)
b = s["balances"]
print("ferryd %s  %s  %s %.2f  zec %.2f" % (s["role"], s["name"], s["counter"]["symbol"],
      b["btc_sat"] / 10 ** s["counter"]["decimals"], b["zec_shielded_zat"] / 1e8))'
      api "$key" /api/swaps | python3 -c '
import json, sys
for s in json.load(sys.stdin):
    print("  swap %s…  %-16s outcome %s" % (s["id"][:12], s["state"], s["outcome"]))'
    else
      echo "ferryd $key  down"
    fi
  done
}

new_swap() {
  api z /api/swaps -X POST -H 'content-type: application/json' \
    -d "{\"maker\":\"$MAKER_URL\",\"zec_zat\":$SWAP_ZAT}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
}

fault() { # fault <z|b> <id>
  api "$1" "/api/swaps/$2/fault" -X POST -H 'content-type: application/json' -d '{"fault":"stall"}' >/dev/null
}

story_happy() {
  log "--- happy: Z swaps $((SWAP_ZAT / 100000000)) ZEC for USDC"
  local z_addr before id
  z_addr=$("$CAST" wallet address "$KEY_Z")
  before=$(usdc_balance "$z_addr")
  id=$(new_swap)
  log "swap $id"
  wait_for 120 "both sides to finish" 'outcome_is z swapped && outcome_is b swapped'
  local got=$(( $(usdc_balance "$z_addr") - before ))
  [ "$got" -eq $((SWAP_ZAT * RATE / 100000000)) ] || die "Z received $got USDC units"
  log "happy: Z received $((got / 1000000)) USDC, B swept the ZEC (B: $(swap_field b 's["state"]'))"
}

story_refund() {
  log "--- refund: Z stalls after locking ZEC; B refunds at t1; Z reclaims"
  local id
  id=$(new_swap)
  log "swap $id"
  wait_for 60 "Z to lock ZEC" 'state_is z ZecLocked'
  fault z "$id"
  log "Z is stalled (it will not claim)"
  wait_for 60 "B to sign Ready" 'state_is b ReadySent'
  warp "$(swap_field b 's["deadlines"]["t1_unix"]')"
  wait_for 60 "B's refund" 'outcome_is b refunded'
  wait_for 60 "Z to reclaim its ZEC" 'outcome_is z refunded'
  log "refund: B has its USDC back, Z reclaimed its ZEC (Z: $(swap_field z 's["state"]'))"
}

story_punish() {
  log "--- punish: B stalls after locking; Z punishes at t2"
  local id z_addr before
  z_addr=$("$CAST" wallet address "$KEY_Z")
  before=$(usdc_balance "$z_addr")
  id=$(new_swap)
  log "swap $id"
  wait_for 60 "B's lock" 'state_is b Locked'
  fault b "$id"
  log "B is stalled (it will neither sign Ready nor refund)"
  wait_for 60 "Z to lock ZEC" 'state_is z ZecLocked'
  warp "$(swap_field z 's["deadlines"]["t2_unix"]')"
  wait_for 60 "Z's punish" 'outcome_is z punished'
  local got=$(( $(usdc_balance "$z_addr") - before ))
  [ "$got" -eq $((SWAP_ZAT * RATE / 100000000)) ] || die "Z received $got USDC units"
  wait_for 30 "B to see the punish" 'outcome_is b punished'
  log "punish: Z took the $((got / 1000000)) USDC; its ZEC stays in the joint note (B's penalty)"
}

cmd_test() {
  trap cmd_down EXIT
  cmd_up
  story_happy
  story_refund
  story_punish
  log "all three stories passed"
}

case "${1:-help}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  happy) story_happy ;;
  refund) story_refund ;;
  punish) story_punish ;;
  test) cmd_test ;;
  logs) tail -n 50 -f "$STATE/logs/${2:-z}.log" ;;
  help | -h | --help) usage ;;
  *) usage; exit 2 ;;
esac
