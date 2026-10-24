#!/usr/bin/env bash
# Local Ferry demo against an EVM chain: shielded ZEC (mock Zcash) <-> USDC (MockUSDC) or WETH
# (MockWETH) locked in FerryLock on anvil. Two ferryd daemons with --counter evm.
# Run `infra/evm-demo.sh help`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${FERRY_EVM_DEMO_DIR:-$ROOT/.demo-evm}"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
ANVIL="${ANVIL:-$(command -v anvil || echo "$FOUNDRY_BIN/anvil")}"
FORGE="${FORGE:-$(command -v forge || echo "$FOUNDRY_BIN/forge")}"
CAST="${CAST:-$(command -v cast || echo "$FOUNDRY_BIN/cast")}"
FERRYD="${FERRYD:-$ROOT/target/debug/ferryd}"

log() { printf '[evm-demo] %s\n' "$*"; }
die() { printf '[evm-demo] error: %s\n' "$*" >&2; exit 1; }

# The token: `up` and `test` take TOKEN (default usdc); the other commands use the one the
# running demo was started with.
if [ "${1:-help}" = up ] || [ "${1:-help}" = test ]; then
  TOKEN="${TOKEN:-usdc}"
else
  TOKEN="${TOKEN:-$(cat "$STATE/token-kind" 2>/dev/null || echo usdc)}"
fi
case "$TOKEN" in
  usdc) SYMBOL=USDC DECIMALS=6 MOCK=MockUSDC DEFAULT_RATE=40000000 ;;            # 40 USDC/ZEC
  weth) SYMBOL=WETH DECIMALS=18 MOCK=MockWETH DEFAULT_RATE=12000000000000000 ;;  # 0.012 WETH/ZEC
  *) die "TOKEN must be usdc or weth, not '$TOKEN'" ;;
esac

ANVIL_PORT="${ANVIL_PORT:-18545}"
RPC="http://127.0.0.1:$ANVIL_PORT"
Z_PORT="${Z_PORT:-7901}"           # control API (/api/*, loopback)
B_PORT="${B_PORT:-7902}"
Z_PEER_PORT="${Z_PEER_PORT:-7911}" # peer protocol (/peer/*)
B_PEER_PORT="${B_PEER_PORT:-7912}"
# Who makes offers: MAKER=b (default), B makes and Z takes (selling ZEC); MAKER=z, Z makes (sells
# its shielded ZEC) and B takes (buys ZEC with the token). Like TOKEN, `up` and `test` take it.
if [ "${1:-help}" = up ] || [ "${1:-help}" = test ]; then
  MAKER="${MAKER:-b}"
else
  MAKER="${MAKER:-$(cat "$STATE/maker" 2>/dev/null || echo b)}"
fi
case "$MAKER" in
  b) TAKER=z MAKER_URL="http://127.0.0.1:$B_PEER_PORT" ;;
  z) TAKER=b MAKER_URL="http://127.0.0.1:$Z_PEER_PORT" ;;
  *) die "MAKER must be b or z, not '$MAKER'" ;;
esac
UI_ORIGINS="${UI_ORIGINS:-http://localhost:7990 http://127.0.0.1:7990}"
# Not infra/demo.sh's zoe/bram: the name is the wallet on a mock Zcash chain the two can share.
Z_NAME="${Z_NAME:-zoe-evm}"
B_NAME="${B_NAME:-bram-evm}"
# Token base units per ZEC (USDC: 10^-6, WETH: 10^-18 = wei).
RATE="${RATE:-$DEFAULT_RATE}"
B_FUND_USDC="${B_FUND_USDC:-1000000000}" # USDC: 1000 USDC minted to B
B_WRAP_ETH="${B_WRAP_ETH:-100}"          # WETH: B wraps 100 of its ETH (1e20 wei, above u64)
ZEC_BALANCE_ZAT="${ZEC_BALANCE_ZAT:-500000000}"
ZEC_BLOCK_SECS="${ZEC_BLOCK_SECS:-2}" # infra/demo.sh's too: a shared mock chain needs one block time
ZEC_CONFS="${ZEC_CONFS:-2}"
# ZEC_MOCK_FILE: a mock Zcash chain shared with another demo (infra/route-demo.sh). A file given
# here belongs to the caller, so `up` never deletes it; the default one is this demo's own.
if [ -n "${ZEC_MOCK_FILE:-}" ]; then
  ZEC_MOCK_OWNED=
else
  ZEC_MOCK_FILE="$STATE/zec-mock.json"
  ZEC_MOCK_OWNED=1
fi
SWAP_ZAT="${SWAP_ZAT:-100000000}"
T1_SECS="${T1_SECS:-120}"
REFUND_SECS="${REFUND_SECS:-120}"
DELTA_SECS="${DELTA_SECS:-15}"
LOCK_CONFS="${LOCK_CONFS:-1}"
POLL_MS="${POLL_MS:-300}"

# anvil's default accounts (test mnemonic): 0 deploys, 1 is B (holds the token), 2 is Z.
KEY_DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEY_B=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
KEY_Z=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

usage() {
  cat <<EOF
Ferry EVM demo: shielded ZEC (mock Zcash chain) <-> USDC (MockUSDC) or WETH (MockWETH) in
FerryLock on anvil. TOKEN=usdc (default) or TOKEN=weth picks the token at up/test.

  infra/evm-demo.sh up       anvil on 127.0.0.1:$ANVIL_PORT (1s blocks), deploy FerryLock + the token
                             mock, fund B (USDC: minted; WETH: B wraps $B_WRAP_ETH ETH), build ferryd,
                             start Z ($Z_NAME :$Z_PORT) and B ($B_NAME :$B_PORT), the maker (MAKER=b:
                             B, MAKER=z: Z) at RATE token units/ZEC: USDC 40000000 = 40/ZEC, WETH
                             12000000000000000 = 0.012/ZEC. Starts from scratch.
  infra/evm-demo.sh happy    one swap, proposed by the taker ($TAKER now): B locks the token, Z locks
                             ZEC, B signs Ready, Z claims (revealing z), B reads z and sweeps the ZEC
  infra/evm-demo.sh refund   Z stalls after locking ZEC; at t1 (anvil time is jumped there) B refunds,
                             revealing b; Z wakes and reclaims its ZEC
  infra/evm-demo.sh punish   B stalls after locking; Z locks ZEC, never gets Ready; at t2 Z punishes
  infra/evm-demo.sh test     up, a check that ferryd refuses a mislabeled token, happy, refund,
                             punish, down; exits non-zero if any of them fails
  infra/evm-demo.sh status | down | logs [z|b|anvil] | help

Ports: anvil $ANVIL_PORT, Z API $Z_PORT / peer $Z_PEER_PORT, B API $B_PORT / peer $B_PEER_PORT.
UI: cd web && source $STATE/env && PORT=7990 pnpm dev:ui   (screenshots: pnpm shoot:evm)
Buying ZEC: MAKER=z infra/evm-demo.sh test runs the same stories with B taking from a Z maker.
Environment: TOKEN [$TOKEN] MAKER [$MAKER] RATE [$RATE] SWAP_ZAT [$SWAP_ZAT] T1_SECS [$T1_SECS]
  REFUND_SECS [$REFUND_SECS] DELTA_SECS [$DELTA_SECS] ZEC_CONFS [$ZEC_CONFS]
  ZEC_BLOCK_SECS [$ZEC_BLOCK_SECS] FERRY_EVM_DEMO_DIR [$STATE] Z_NAME [$Z_NAME] B_NAME [$B_NAME]
  ZEC_BALANCE_ZAT [$ZEC_BALANCE_ZAT] (Z's starting shielded balance)
  ZEC_MOCK_FILE [$ZEC_MOCK_FILE] (a file you name is shared, e.g. with infra/demo.sh, and never
    deleted by this script)  FERRYD_ARGS (extra flags for both daemons)
  ANVIL_PORT Z_PORT B_PORT Z_PEER_PORT B_PEER_PORT (as above)
EOF
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

# Token amounts can pass 2^63 (WETH is in wei), so they never go through shell arithmetic.
token_balance() { "$CAST" call "$(cat "$STATE/token")" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | awk '{print $1}'; }
minus() { python3 -c 'import sys; print(int(sys.argv[1]) - int(sys.argv[2]))' "$1" "$2"; }
# units_for <zat> <rate>: what ferryd quotes, zat * rate / 10^8 rounded to the nearest unit.
units_for() { python3 -c 'import sys; print((int(sys.argv[1]) * int(sys.argv[2]) + 50000000) // 100000000)' "$1" "$2"; }
# show <base units>: e.g. "0.012 WETH"
show() {
  python3 -c '
import sys
from decimal import Decimal
u, d, s = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
print("%s %s" % (format((Decimal(u) / Decimal(10) ** d).normalize(), "f"), s))' "$1" "$DECIMALS" "$SYMBOL"
}
maker_rate() { api "$MAKER" /api/status | python3 -c 'import json, sys; print(json.load(sys.stdin)["offer"]["rate_sat_per_zec"])'; }

deploy() { # deploy <contract path:name> -> address
  "$FORGE" create --root "$ROOT/contracts" "$1" --rpc-url "$RPC" --private-key "$KEY_DEPLOYER" --broadcast 2>&1 |
    awk '/Deployed to:/{print $3}'
}

start_ferryd() { # start_ferryd <key> <role> <name> <api port> <peer port> <key file> [extra...]
  local key=$1 role=$2 name=$3 port=$4 peer_port=$5 keyfile=$6
  shift 6
  local origins=()
  for o in $UI_ORIGINS; do origins+=(--ui-origin "$o"); done
  # shellcheck disable=SC2206
  local extra=(${FERRYD_ARGS:-})
  "$FERRYD" --counter evm --role "$role" --name "$name" --api-listen "127.0.0.1:$port" \
    --listen "127.0.0.1:$peer_port" --data-dir "$STATE/$key" --demo-faults --dev-policy \
    ${origins[@]+"${origins[@]}"} \
    --evm-rpc "$RPC" --evm-contract "$(cat "$STATE/lock")" --evm-token "$(cat "$STATE/token")" \
    --evm-token-symbol "$SYMBOL" --evm-token-decimals "$DECIMALS" \
    --evm-key-file "$keyfile" --evm-t1-secs "$T1_SECS" --evm-refund-secs "$REFUND_SECS" \
    --evm-delta-secs "$DELTA_SECS" --evm-lock-confs "$LOCK_CONFS" --zec-confs "$ZEC_CONFS" \
    --zec mock --zec-mock-file "$ZEC_MOCK_FILE" --zec-mock-block-secs "$ZEC_BLOCK_SECS" \
    --sweep-delay-secs 1:3 --poll-ms "$POLL_MS" "$@" ${extra[@]+"${extra[@]}"} >>"$STATE/logs/$key.log" 2>&1 &
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
  rm -rf "$STATE/z" "$STATE/b" "$STATE/guard" "$STATE/guard-zec.json"
  # A shared chain (ZEC_MOCK_FILE given) is its owner's to reset.
  if [ -n "$ZEC_MOCK_OWNED" ]; then rm -f "$ZEC_MOCK_FILE"; fi
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

  local lock token
  lock=$(deploy src/FerryLock.sol:FerryLock)
  token=$(deploy "src/$MOCK.sol:$MOCK")
  [ -n "$lock" ] && [ -n "$token" ] || die "deploying the contracts failed"
  echo "$lock" >"$STATE/lock"
  echo "$token" >"$STATE/token"
  echo "$TOKEN" >"$STATE/token-kind"
  log "FerryLock $lock  $MOCK $token"

  umask 077
  echo "$KEY_B" >"$STATE/b.key"
  echo "$KEY_Z" >"$STATE/z.key"
  local b_addr
  b_addr=$("$CAST" wallet address "$KEY_B")
  case "$TOKEN" in
    usdc)
      "$CAST" send "$token" "mint(address,uint256)" "$b_addr" "$B_FUND_USDC" \
        --private-key "$KEY_DEPLOYER" --rpc-url "$RPC" >/dev/null
      log "minted $(show "$B_FUND_USDC") to B ($b_addr)"
      ;;
    weth)
      # As a user would: wrap ETH into WETH (WETH9's deposit), then swap the WETH.
      "$CAST" send "$token" "deposit()" --value "${B_WRAP_ETH}ether" \
        --private-key "$KEY_B" --rpc-url "$RPC" >/dev/null
      log "B ($b_addr) wrapped $B_WRAP_ETH ETH: $(show "$(token_balance "$b_addr")")"
      ;;
  esac

  # the maker's offer: B pays RATE per ZEC it buys (MAKER=b), or Z asks RATE per ZEC it sells (z)
  local b_offer=() z_offer=()
  if [ "$MAKER" = b ]; then b_offer=(--maker-offer "$RATE"); else z_offer=(--maker-offer "$RATE"); fi
  echo "$MAKER" >"$STATE/maker"
  log "starting B ($B_NAME, $([ "$MAKER" = b ] && echo "maker at $(show "$RATE")/ZEC: buys ZEC" || echo "taker: buys ZEC")): API :$B_PORT, peer :$B_PEER_PORT"
  start_ferryd b b "$B_NAME" "$B_PORT" "$B_PEER_PORT" "$STATE/b.key" ${b_offer[@]+"${b_offer[@]}"}
  log "starting Z ($Z_NAME, $([ "$MAKER" = z ] && echo "maker at $(show "$RATE")/ZEC: sells ZEC" || echo "taker: sells ZEC")): API :$Z_PORT, peer :$Z_PEER_PORT"
  start_ferryd z z "$Z_NAME" "$Z_PORT" "$Z_PEER_PORT" "$STATE/z.key" --zec-mock-balance "$ZEC_BALANCE_ZAT" ${z_offer[@]+"${z_offer[@]}"}
  # The UI: the maker's daemon takes no swaps from the page, so it opens on the other side.
  cat >"$STATE/env" <<ENV
export FERRY_Z_URL=http://127.0.0.1:$Z_PORT
export FERRY_B_URL=http://127.0.0.1:$B_PORT
export FERRY_MAKER_URL=$MAKER_URL
export FERRY_Z_TOKEN=$(cat "$STATE/z/api-token")
export FERRY_B_TOKEN=$(cat "$STATE/b/api-token")
export FERRY_LOCAL=$TAKER
export FERRY_Z_SELLS=$([ "$MAKER" = z ] && echo 0 || echo 1)
export FERRY_B_BUYS=$([ "$MAKER" = b ] && echo 0 || echo 1)
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
from decimal import Decimal
s = json.load(sys.stdin)
b, c = s["balances"], s["counter"]
units = int(b.get("token_units", b["btc_sat"]))
amount = format((Decimal(units) / Decimal(10) ** c["decimals"]).normalize(), "f")
print("ferryd %s  %s  %s %s  zec %.2f" % (s["role"], s["name"], c["symbol"], amount,
      b["zec_shielded_zat"] / 1e8))'
      api "$key" /api/swaps | python3 -c '
import json, sys
for s in json.load(sys.stdin):
    print("  swap %s…  %-16s outcome %s" % (s["id"][:12], s["state"], s["outcome"]))'
    else
      echo "ferryd $key  down"
    fi
  done
}

# ferryd must refuse to start when the token's own symbol() or decimals() differ from its flags.
# Run while Z is up and on Z's ports: if the check were missing, this would die on the bind
# instead, without the message, and fail all the same.
check_token_guard() {
  local wrong_symbol wrong_decimals expect
  if [ "$TOKEN" = usdc ]; then wrong_symbol=WETH wrong_decimals=18; else wrong_symbol=USDC wrong_decimals=6; fi
  for flags in "$SYMBOL $wrong_decimals" "$wrong_symbol $DECIMALS"; do
    set -- $flags
    expect="decimals() is $DECIMALS"
    [ "$1" = "$SYMBOL" ] || expect="symbol() is \"$SYMBOL\""
    "$FERRYD" --counter evm --role z --name guard --api-listen "127.0.0.1:$Z_PORT" \
      --listen "127.0.0.1:$Z_PEER_PORT" --data-dir "$STATE/guard" --dev-policy \
      --evm-rpc "$RPC" --evm-contract "$(cat "$STATE/lock")" --evm-token "$(cat "$STATE/token")" \
      --evm-token-symbol "$1" --evm-token-decimals "$2" --evm-key-file "$STATE/z.key" \
      --zec mock --zec-mock-file "$STATE/guard-zec.json" >"$STATE/logs/guard.log" 2>&1 &
    local pid=$! i
    for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      die "ferryd kept running with --evm-token-symbol $1 --evm-token-decimals $2 for a $SYMBOL token"
    fi
    if wait "$pid"; then die "ferryd exited 0 with a mislabeled token"; fi
    grep -qF "$expect" "$STATE/logs/guard.log" ||
      die "ferryd did not refuse the mislabeled token as expected (log: $STATE/logs/guard.log)"
    log "ferryd refuses $SYMBOL labelled $1 with $2 decimals: $(grep -o 'the token.s [a-z]*() is [^,]*' "$STATE/logs/guard.log" | head -1)"
  done
}

# The taker's POST /api/swaps: one call, whichever role takes.
new_swap() {
  api "$TAKER" /api/swaps -X POST -H 'content-type: application/json' \
    -d "{\"maker\":\"$MAKER_URL\",\"zec_zat\":$SWAP_ZAT}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
}

fault() { # fault <z|b> <id>
  api "$1" "/api/swaps/$2/fault" -X POST -H 'content-type: application/json' -d '{"fault":"stall"}' >/dev/null
}

story_happy() {
  log "--- happy: $([ "$TAKER" = z ] && echo "Z sells" || echo "B buys") $(python3 -c "print($SWAP_ZAT / 1e8)") ZEC for $SYMBOL (maker: $MAKER)"
  local z_addr before id want got
  z_addr=$("$CAST" wallet address "$KEY_Z")
  before=$(token_balance "$z_addr")
  want=$(units_for "$SWAP_ZAT" "$(maker_rate)")
  id=$(new_swap)
  log "swap $id"
  [ "$(swap_field z 's["amounts"]["btc_sat"]')" = "$want" ] || die "Z's swap is for $(swap_field z 's["amounts"]["btc_sat"]') units, expected $want"
  wait_for 120 "both sides to finish" 'outcome_is z swapped && outcome_is b swapped'
  got=$(minus "$(token_balance "$z_addr")" "$before")
  [ "$got" = "$want" ] || die "Z received $got $SYMBOL units, expected $want"
  log "happy: Z received $(show "$got"), B swept the ZEC (B: $(swap_field b 's["state"]'))"
}

story_refund() {
  log "--- refund: Z stalls after locking ZEC; B refunds at t1; Z reclaims"
  local id b_addr before
  b_addr=$("$CAST" wallet address "$KEY_B")
  before=$(token_balance "$b_addr")
  id=$(new_swap)
  log "swap $id"
  wait_for 60 "Z to lock ZEC" 'state_is z ZecLocked'
  fault z "$id"
  log "Z is stalled (it will not claim)"
  wait_for 60 "B to sign Ready" 'state_is b ReadySent'
  warp "$(swap_field b 's["deadlines"]["t1_unix"]')"
  wait_for 60 "B's refund" 'outcome_is b refunded'
  wait_for 60 "Z to reclaim its ZEC" 'outcome_is z refunded'
  [ "$(token_balance "$b_addr")" = "$before" ] || die "B's $SYMBOL balance did not come back to $before"
  log "refund: B's balance is back to $(show "$before"), Z reclaimed its ZEC (Z: $(swap_field z 's["state"]'))"
}

story_punish() {
  log "--- punish: B stalls after locking; Z punishes at t2"
  local id z_addr before want got
  z_addr=$("$CAST" wallet address "$KEY_Z")
  before=$(token_balance "$z_addr")
  want=$(units_for "$SWAP_ZAT" "$(maker_rate)")
  id=$(new_swap)
  log "swap $id"
  wait_for 60 "B's lock" 'state_is b Locked'
  fault b "$id"
  log "B is stalled (it will neither sign Ready nor refund)"
  wait_for 60 "Z to lock ZEC" 'state_is z ZecLocked'
  warp "$(swap_field z 's["deadlines"]["t2_unix"]')"
  wait_for 60 "Z's punish" 'outcome_is z punished'
  got=$(minus "$(token_balance "$z_addr")" "$before")
  [ "$got" = "$want" ] || die "Z received $got $SYMBOL units, expected $want"
  wait_for 30 "B to see the punish" 'outcome_is b punished'
  log "punish: Z took the $(show "$got"); its ZEC stays in the joint note (B's penalty)"
}

cmd_test() {
  trap cmd_down EXIT
  cmd_up
  check_token_guard
  story_happy
  story_refund
  story_punish
  log "all three stories passed ($SYMBOL, MAKER=$MAKER: $TAKER took from $MAKER)"
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
