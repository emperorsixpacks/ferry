#!/usr/bin/env bash
# Watchtower demo: a party is killed mid-swap and its watchtower finishes the swap on its own.
# Self-contained: its own chain (regtest bitcoind or litecoind in Docker, or anvil), ferry-watchtower,
# two ferryd daemons (mock ZEC) and its own ports, so it can run next to infra/demo.sh.
# CHAIN=btc (default), ltc or evm picks the counter-chain. Run `infra/demo-watchtower.sh help`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN="${CHAIN:-btc}"
# Not for child processes: forge and cast read CHAIN as their own --chain.
export -n CHAIN
case "$CHAIN" in
  btc)
    TICKER=BTC
    STATE="${FERRY_WT_DEMO_DIR:-$ROOT/.demo/watchtower}"
    CONTAINER="${BITCOIND_CONTAINER:-ferry-wt-regtest}"
    IMAGE="${BITCOIND_IMAGE:-bitcoin/bitcoin:28.1}"
    BTC_RPC_PORT="${BTC_RPC_PORT:-18943}"
    NODE_RPC_PORT=18443 # inside the container
    ADDR_TYPE=bech32m ;;
  ltc)
    TICKER=LTC
    STATE="${FERRY_WT_DEMO_DIR:-$ROOT/.demo/watchtower-ltc}"
    CONTAINER="${BITCOIND_CONTAINER:-ferry-litecoind}"
    # Litecoin Core 0.21.5.6 (Taproot + MWEB), pinned like infra/ltc/regtest.sh.
    IMAGE="${BITCOIND_IMAGE:-uphold/litecoin-core:0.21@sha256:46ebcaa617f66f3f35be4d7c2fe46bb07f037fd9f4482c4e1d1b044997d30b1c}"
    BTC_RPC_PORT="${BTC_RPC_PORT:-19643}"
    NODE_RPC_PORT=19443
    # Litecoin Core's wallet has no bech32m type.
    ADDR_TYPE=bech32 ;;
  evm)
    TICKER=USDC
    STATE="${FERRY_WT_DEMO_DIR:-$ROOT/.demo/watchtower-evm}"
    ANVIL_PORT="${ANVIL_PORT:-18545}" ;;
  *) echo "CHAIN must be btc, ltc or evm" >&2; exit 2 ;;
esac
BTC_RPC="http://127.0.0.1:${BTC_RPC_PORT:-0}"
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

# EVM (CHAIN=evm): anvil with 1 s blocks; deadlines in seconds of block time, reached by jumping
# anvil's clock rather than waiting.
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
ANVIL="${ANVIL:-$(command -v anvil || echo "$FOUNDRY_BIN/anvil")}"
FORGE="${FORGE:-$(command -v forge || echo "$FOUNDRY_BIN/forge")}"
CAST="${CAST:-$(command -v cast || echo "$FOUNDRY_BIN/cast")}"
EVM_RPC="http://127.0.0.1:${ANVIL_PORT:-0}"
EVM_T1_SECS="${EVM_T1_SECS:-120}"
EVM_REFUND_SECS="${EVM_REFUND_SECS:-120}"
EVM_DELTA_SECS="${EVM_DELTA_SECS:-15}"
EVM_RATE="${EVM_RATE:-40000000}" # USDC base units per ZEC
# anvil's default accounts (test mnemonic): 0 deploys and funds the tower, 1 is B, 2 is Z.
KEY_DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEY_B=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
KEY_Z=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

usage() {
  cat <<EOF
Ferry watchtower demo (mock ZEC). CHAIN=$CHAIN; state and logs in $STATE.

  infra/demo-watchtower.sh run       build, start everything from a fresh chain and play both stories
  infra/demo-watchtower.sh up        only start everything (B arms its own tower) and write $STATE/env
                                     for the UI: cd web && source $STATE/env && pnpm shoot:watchtower
  infra/demo-watchtower.sh down      stop the daemons, the tower and the chain (logs stay in $STATE/logs)
  infra/demo-watchtower.sh run-all   run with CHAIN=btc, then ltc, then evm

CHAIN=btc (default)  regtest bitcoind, Docker container ferry-wt-regtest, RPC :18943
CHAIN=ltc            regtest litecoind 0.21.5.6 (MWEB active), container ferry-litecoind, RPC :19643;
                     the tower follows it through a legacy watch-only wallet (ferry-watchtower --chain ltc)
CHAIN=evm            anvil on :18545 with FerryLock + MockUSDC; ferryd --counter evm, and a tower with
                     --counter evm that pays gas from its own key (created in $STATE/tower/gas.key)

Story 1 (refund): B arms its own tower (--watchtower-own), locks its $TICKER and is killed. Z locks ZEC
  and waits for B's go-ahead, which never comes. After T1 B's tower calls the swap off and refunds B
  before T2 - delta, which reveals B's share: Z reclaims its ZEC. B comes back to a refunded swap.
Story 2 (punish): B runs without --watchtower-own, so it refuses to arm the tower (and says why).
  B locks and is killed; Z locks ZEC and is killed too. Z's tower takes the $TICKER for Z at T2.
  Z comes back to a finished swap.
On Bitcoin and Litecoin the tower broadcasts presigned transactions (tx_cancel, then tx_refund or
tx_punish). On EVM it calls FerryLock's refund (with B's share b) or punish, and there is no
cancel step: the deadlines are block timestamps, and the demo jumps anvil's clock to them.

Ports: Z API :$Z_PORT, B API :$B_PORT, peers :$Z_PEER_PORT/:$B_PEER_PORT, tower :$TOWER_PORT.
Environment: T1 [$T1] T2 [$T2] DELTA [$DELTA] BLOCK_MS [$BLOCK_MS] (blocks, btc/ltc)
  EVM_T1_SECS [$EVM_T1_SECS] EVM_REFUND_SECS [$EVM_REFUND_SECS] EVM_DELTA_SECS [$EVM_DELTA_SECS] (evm)
  FERRY_WT_DEMO_DIR [$STATE]
EOF
}

log() { printf '[wt-demo %s] %s\n' "$CHAIN" "$*"; }
die() { printf '[wt-demo %s] error: %s\n' "$CHAIN" "$*" >&2; exit 1; }

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

# Refuse to start on a port something else is already listening on.
port_free() { # port_free <port> <what>
  if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
    die "port $1 ($2) is already in use"
  fi
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
  local chain_args
  if [ "$CHAIN" = evm ]; then
    chain_args=(--counter evm --evm-rpc "$EVM_RPC" --evm-contract "$(cat "$STATE/lock")"
      --evm-token "$(cat "$STATE/usdc")" --evm-key-file "$STATE/$key.key" --evm-t1-secs "$EVM_T1_SECS"
      --evm-refund-secs "$EVM_REFUND_SECS" --evm-delta-secs "$EVM_DELTA_SECS" --evm-lock-confs 1 --zec-confs 3)
  else
    chain_args=(--chain "$CHAIN" --btc-rpc "$BTC_RPC" --btc-wallet "wt-$key"
      --t1 "$T1" --t2 "$T2" --delta "$DELTA" --btc-lock-confs 1 --zec-confs 2 --cancel-confs 1)
  fi
  "$FERRYD" --role "$role" --name "wt-$key" --api-listen "127.0.0.1:$port" --listen "127.0.0.1:$peer" \
    --data-dir "$STATE/$key" --dev-policy "${chain_args[@]}" \
    --zec mock --zec-mock-file "$STATE/zec-mock.json" --zec-mock-block-secs 1 \
    --poll-ms 300 --sweep-delay-secs 0:1 --ui-origin "http://localhost:$UI_PORT" --ui-origin "http://127.0.0.1:$UI_PORT" "$@" >>"$STATE/logs/$key.log" 2>&1 &
  echo $! >"$STATE/$key.pid"
  disown
  wait_http "$key" api "$key" /api/status
}

start_tower() {
  local chain_args
  if [ "$CHAIN" = evm ]; then
    chain_args=(--counter evm --evm-rpc "$EVM_RPC" --evm-key-file "$STATE/tower/gas.key"
      --evm-contract "$(cat "$STATE/lock")")
  else
    chain_args=(--chain "$CHAIN" --btc-rpc "$BTC_RPC" --network regtest)
  fi
  "$WATCHTOWER" --listen "127.0.0.1:$TOWER_PORT" --data-dir "$STATE/tower" --token-file "$STATE/tower/token" \
    "${chain_args[@]}" --poll-ms 300 >>"$STATE/logs/tower.log" 2>&1 &
  echo $! >"$STATE/tower.pid"
  disown
  wait_http tower curl -sf "$TOWER/health"
}

TOWER_ARGS=()
tower_args() { TOWER_ARGS=(--watchtower "$TOWER" --watchtower-token-file "$STATE/tower/token" "$@"); }

mine() { rpc "" generatetoaddress "[${1:-1}, \"$MINER\"]" >/dev/null; }

# until_ok <max blocks> <description> <cmd...>: mine a block every BLOCK_MS until cmd succeeds.
# On EVM, anvil makes its own blocks: just poll (max blocks become max seconds).
until_ok() {
  local max=$1 what=$2
  shift 2
  [ "$CHAIN" = evm ] && max=$((max * 2))
  for _ in $(seq 1 "$max"); do
    "$@" 2>/dev/null && return 0
    if [ "$CHAIN" = evm ]; then
      sleep 0.5
    else
      mine 1
      sleep "$(python3 -c "print($BLOCK_MS/1000)")"
    fi
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

show_package() { # show_package <id>: the tower's view, one line per broadcast or call
  tower "/packages/$1" | python3 -c '
import json,sys
j=json.load(sys.stdin)
print("  tower package %s… (%s): status=%s outcome=%s" % (j["id"][:8], j["role"], j["status"], j["outcome"]))
for b in j.get("broadcasts", []):
    print("    broadcast %-6s %s…  at lock_confs=%s cancel_confs=%s error=%s" % (b["spend"], b["txid"][:16], b["lock_confs"], b["cancel_confs"], b["error"]))
for s in j.get("sends", []):
    when = "t1+%ds, refund window ends at t2-%ds" % (s["block_time"] - j["t1"], j["refund_margin"]) if s["call"] == "refund" else "t2+%ds" % (s["block_time"] - j["t2"])
    print("    called %-6s %s  at block time %s (%s) error=%s" % (s["call"], (s["tx_hash"] or "-")[:18] + "…", s["block_time"], when, s["error"]))
print("    advice: %s" % j["advice"])'
}

# sent_ok <package id> <name>: how many error-free broadcasts (btc/ltc: spend) or calls (evm) named so.
sent_ok() {
  tower "/packages/$1" | field "[b['spend'] for b in j.get('broadcasts', []) if not b['error']].count('$2') + [s['call'] for s in j.get('sends', []) if not s['error']].count('$2'.lower())"
}

# in_window <package id>: every call the tower made obeyed its rule, by the block time it was sent
# at (refund in [t1, t2 - delta), punish from t2).
in_window() {
  tower "/packages/$1" | python3 -c '
import json,sys
j=json.load(sys.stdin)
ok=[s for s in j["sends"] if not s["error"]]
sys.exit(not ok or not all(
    (j["t1"] <= s["block_time"] and s["block_time"] + j["refund_margin"] < j["t2"]) if s["call"] == "refund"
    else s["block_time"] >= j["t2"] for s in ok))'
}

new_swap() {
  api z /api/swaps -XPOST -H 'content-type: application/json' \
    -d "{\"maker\":\"$MAKER_URL\",\"zec_zat\":100000000}" | field "j['id']"
}

down() {
  for k in z b tower; do stop_pid "$k"; done
  if [ "$CHAIN" = evm ]; then
    stop_pid anvil
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  log "stopped"
}

# Litecoin: activate MWEB as on mainnet (as infra/demo.sh does). It locks in by BIP9 signalling at
# block 431; every later block needs a HogEx, and the first HogEx needs a peg-in.
activate_mweb() {
  rpc "" generatetoaddress "[431, \"$MINER\"]" >/dev/null
  local mweb
  mweb=$(rpc miner getnewaddress '["", "mweb"]' | result)
  rpc miner sendtoaddress "[\"$mweb\", 1]" >/dev/null
  mine 1
  rpc "" getblockchaininfo | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin)["result"]["softforks"]["mweb"]["bip9"]["status"] != "active")' \
    || die "MWEB did not activate"
  log "MWEB active at height $(rpc "" getblockcount | result)"
}

start_node() {
  command -v docker >/dev/null || die "docker is required"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  port_free "$BTC_RPC_PORT" "$TICKER node RPC"
  log "starting the $TICKER node on 127.0.0.1:$BTC_RPC_PORT (container $CONTAINER, no -txindex)"
  docker run -d --name "$CONTAINER" -p "127.0.0.1:$BTC_RPC_PORT:$NODE_RPC_PORT" "$IMAGE" \
    -regtest -server -printtoconsole -rpcport="$NODE_RPC_PORT" -rpcuser=ferry -rpcpassword=ferry \
    -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 -fallbackfee=0.0002 >/dev/null
  for _ in $(seq 1 60); do rpc "" getblockcount >/dev/null 2>&1 && break; sleep 0.5; done
  rpc "" getblockcount >/dev/null 2>&1 || { docker logs --tail 30 "$CONTAINER" >&2; die "the $TICKER node did not come up"; }
  rpc "" createwallet '["miner"]' >/dev/null
  MINER=$(rpc miner getnewaddress "[\"\", \"$ADDR_TYPE\"]" | result)
  if [ "$CHAIN" = ltc ]; then
    activate_mweb
  else
    mine 101
  fi
}

chain_time() { "$CAST" block latest --field timestamp --rpc-url "$EVM_RPC"; }

# warp <unix secs>: the next anvil block has this timestamp (anvil keeps 1 s blocks from there).
warp() {
  local now
  now=$(chain_time)
  if [ "$1" -gt "$now" ]; then
    "$CAST" rpc evm_setNextBlockTimestamp "$1" --rpc-url "$EVM_RPC" >/dev/null
    "$CAST" rpc evm_mine --rpc-url "$EVM_RPC" >/dev/null
    log "  jumped anvil's clock forward $(($1 - now))s"
  fi
}

usdc_balance() { "$CAST" call "$(cat "$STATE/usdc")" "balanceOf(address)(uint256)" "$1" --rpc-url "$EVM_RPC" | awk '{print $1}'; }

deploy() { # deploy <contract path:name> -> address
  "$FORGE" create --root "$ROOT/contracts" "$1" --rpc-url "$EVM_RPC" --private-key "$KEY_DEPLOYER" --broadcast \
    >>"$STATE/logs/forge.log" 2>&1 || { tail -n 20 "$STATE/logs/forge.log" >&2; die "forge create $1 failed"; }
  awk '/Deployed to:/{a=$3} END{print a}' "$STATE/logs/forge.log"
}

start_anvil() {
  [ -x "$ANVIL" ] && [ -x "$FORGE" ] && [ -x "$CAST" ] || die "foundry is required (curl -L https://foundry.paradigm.xyz | bash; foundryup)"
  stop_pid anvil
  port_free "$ANVIL_PORT" anvil
  log "starting anvil on $EVM_RPC (1 s blocks)"
  "$ANVIL" --port "$ANVIL_PORT" --host 127.0.0.1 --block-time 1 --silent >>"$STATE/logs/anvil.log" 2>&1 &
  echo $! >"$STATE/anvil.pid"
  disown
  for _ in $(seq 1 40); do "$CAST" chain-id --rpc-url "$EVM_RPC" >/dev/null 2>&1 && break; sleep 0.25; done
  "$CAST" chain-id --rpc-url "$EVM_RPC" >/dev/null 2>&1 || die "anvil did not come up"
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
  umask 022
  "$CAST" send "$usdc" "mint(address,uint256)" "$("$CAST" wallet address "$KEY_B")" 1000000000 \
    --private-key "$KEY_DEPLOYER" --rpc-url "$EVM_RPC" >/dev/null
}

setup() {
  log "building ferryd and ferry-watchtower"
  (cd "$ROOT" && cargo build -q -p ferryd -p ferry-watchtower)
  for k in z b tower; do stop_pid "$k"; done
  rm -rf "$STATE/z" "$STATE/b" "$STATE/tower" "$STATE/zec-mock.json"
  mkdir -p "$STATE/logs" "$STATE/tower"
  for p in "$Z_PORT" "$B_PORT" "$Z_PEER_PORT" "$B_PEER_PORT" "$TOWER_PORT"; do port_free "$p" "demo daemons"; done

  if [ "$CHAIN" = evm ]; then
    start_anvil
    log "starting the watchtower on $TOWER (--counter evm; token in $STATE/tower/token)"
    start_tower
    local account
    account=$(curl -sf "$TOWER/health" | field "j['account']")
    "$CAST" send "$account" --value 1ether --private-key "$KEY_DEPLOYER" --rpc-url "$EVM_RPC" >/dev/null
    log "funded the tower's own gas account $account with 1 ETH (its key never leaves $STATE/tower/gas.key)"
  else
    start_node
    log "starting the watchtower on $TOWER (keyless, --chain $CHAIN; token in $STATE/tower/token)"
    start_tower
  fi
  tower_args --watchtower-own
  log "starting B (maker, arms its OWN tower) and Z (arms the tower)"
  if [ "$CHAIN" = evm ]; then
    start_ferryd b b "$B_PORT" "$B_PEER_PORT" --maker-offer "$EVM_RATE" "${TOWER_ARGS[@]}"
  else
    start_ferryd b b "$B_PORT" "$B_PEER_PORT" --maker-offer 410000 "${TOWER_ARGS[@]}"
  fi
  tower_args
  start_ferryd z z "$Z_PORT" "$Z_PEER_PORT" --zec-mock-balance 500000000 "${TOWER_ARGS[@]}"
  if [ "$CHAIN" != evm ]; then
    local b_addr
    b_addr=$(api b /api/addresses | field "j['btc']['address']")
    rpc miner sendtoaddress "[\"$b_addr\", 1]" >/dev/null
    mine 1
  fi
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

restart_b() { # restart_b [--watchtower-own]
  stop_pid b
  tower_args "$@"
  if [ "$CHAIN" = evm ]; then
    start_ferryd b b "$B_PORT" "$B_PEER_PORT" --maker-offer "$EVM_RATE" "${TOWER_ARGS[@]}"
  else
    start_ferryd b b "$B_PORT" "$B_PEER_PORT" --maker-offer 410000 "${TOWER_ARGS[@]}"
  fi
}

run_utxo() {
  setup

  # ------------------------------------------------------------ story 1: B killed, tower refunds
  log "story 1: B locks $TICKER, then B is killed; its tower must refund it"
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
  [ "$(sent_ok "$bpkg" Refund)" = 1 ] || die "the refund was not broadcast by the tower"
  [ "$(sent_ok "$zpkg" Punish)" = 0 ] || die "Z's package punished after a refund"
  log "  restarting B: it finds its swap finished"
  restart_b --watchtower-own
  until_ok 10 "B sees Refunded" state_is b "$id" Refunded
  log "story 1 done: B $(swap_field b "$id" "j['state']"), Z $(swap_field z "$id" "j['state']")"

  # ------------------------------------------------------------ story 2: both killed, tower punishes
  log "story 2: B runs without --watchtower-own, so it refuses to arm; both parties are killed"
  restart_b
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
  [ "$(sent_ok "$zpkg" Punish)" = 1 ] || die "the punish was not broadcast by the tower"
  log "  restarting Z: it finds the $TICKER taken for it"
  tower_args
  start_ferryd z z "$Z_PORT" "$Z_PEER_PORT" "${TOWER_ARGS[@]}"
  until_ok 10 "Z sees Punished" state_is z "$id" Punished
  log "story 2 done: Z $(swap_field z "$id" "j['state']") ($TICKER taken by its tower while it was offline)"
  log "all stories passed; logs in $STATE/logs. Stop with: CHAIN=$CHAIN infra/demo-watchtower.sh down"
}

run_evm() {
  setup
  local b_addr z_addr
  b_addr=$("$CAST" wallet address "$KEY_B")
  z_addr=$("$CAST" wallet address "$KEY_Z")

  # ------------------------------------------------------------ story 1: B killed, tower refunds
  log "story 1: B locks USDC in FerryLock, then B is killed; its tower must refund it"
  local id bpkg zpkg t1 t2 before
  id=$(new_swap)
  until_ok 30 "B's tower armed" tower_armed b "$id"
  bpkg=$(tower_package b "$id")
  log "  B armed tower package ${bpkg:0:8}… (checked against the lock on chain); killing B (pid $(cat "$STATE/b.pid")) before it signs Ready"
  stop_pid b
  until_ok 30 "Z's tower armed" tower_armed z "$id"
  zpkg=$(tower_package z "$id")
  until_ok 30 "Z locks ZEC" state_is z "$id" ZecLocked
  t1=$(swap_field z "$id" "j['deadlines']['t1_unix']")
  t2=$(swap_field z "$id" "j['deadlines']['t2_unix']")
  before=$(usdc_balance "$b_addr")
  log "  Z locked ZEC and waits for Ready, which never comes. Nothing happens before t1:"
  sleep 2
  [ "$(sent_ok "$bpkg" Refund)" = 0 ] || die "the tower refunded before t1"
  log "  $(tower "/packages/$bpkg" | field "j['note']")"
  warp "$t1"
  until_ok 30 "B's tower refunds" tower_outcome "$bpkg" refunded
  until_ok 30 "Z reclaims its ZEC" state_is z "$id" ZecReclaimed
  show_package "$bpkg"
  show_package "$zpkg"
  [ "$(sent_ok "$bpkg" Refund)" = 1 ] || die "the refund was not sent by the tower"
  [ "$(sent_ok "$zpkg" Punish)" = 0 ] || die "Z's package punished after a refund"
  local got=$(( $(usdc_balance "$b_addr") - before ))
  [ "$got" -gt 0 ] || die "B's account got no USDC back"
  in_window "$bpkg" || die "the refund was sent outside [t1, t2 - delta)"
  log "  B's account got its $((got / 1000000)) USDC back; Z read b from the refund and reclaimed its ZEC"
  log "  restarting B: it finds its swap finished"
  restart_b --watchtower-own
  until_ok 15 "B sees Refunded" state_is b "$id" Refunded
  log "story 1 done: B $(swap_field b "$id" "j['state']"), Z $(swap_field z "$id" "j['state']")"

  # ------------------------------------------------------------ story 2: both killed, tower punishes
  log "story 2: B runs without --watchtower-own, so it refuses to arm; both parties are killed"
  restart_b
  id=$(new_swap)
  until_ok 30 "B's lock" state_is b "$id" Locked
  [ "$(swap_field b "$id" "(j.get('watchtower') or {}).get('status')")" = refused ] ||
    die "B should have refused to arm a tower it was not told is its own"
  log "  B: $(swap_field b "$id" "j['watchtower']['note']")"
  log "  B locked; killing B (pid $(cat "$STATE/b.pid")) before it signs Ready"
  stop_pid b
  until_ok 30 "Z's tower armed" tower_armed z "$id"
  zpkg=$(tower_package z "$id")
  until_ok 30 "Z locks ZEC" state_is z "$id" ZecLocked
  t2=$(swap_field z "$id" "j['deadlines']['t2_unix']")
  log "  Z locked ZEC; killing Z (pid $(cat "$STATE/z.pid"))"
  stop_pid z
  before=$(usdc_balance "$z_addr")
  warp $((t2 - EVM_DELTA_SECS))
  sleep 2
  [ "$(sent_ok "$zpkg" Punish)" = 0 ] || die "the tower punished before t2"
  log "  just before t2: $(tower "/packages/$zpkg" | field "j['note']")"
  warp "$t2"
  until_ok 30 "Z's tower punishes" tower_outcome "$zpkg" punished
  show_package "$zpkg"
  [ "$(sent_ok "$zpkg" Punish)" = 1 ] || die "the punish was not sent by the tower"
  in_window "$zpkg" || die "the punish was sent before t2"
  local got=$(( $(usdc_balance "$z_addr") - before ))
  [ "$got" -gt 0 ] || die "Z's account got no USDC"
  log "  restarting Z: it finds the $((got / 1000000)) USDC paid to its account"
  tower_args
  start_ferryd z z "$Z_PORT" "$Z_PEER_PORT" "${TOWER_ARGS[@]}"
  until_ok 15 "Z sees Punished" state_is z "$id" Punished
  log "story 2 done: Z $(swap_field z "$id" "j['state']") (USDC taken by its tower while it was offline)"
  log "all stories passed; logs in $STATE/logs. Stop with: CHAIN=evm infra/demo-watchtower.sh down"
}

run() {
  if [ "$CHAIN" = evm ]; then run_evm; else run_utxo; fi
}

run_all() {
  local c
  for c in btc ltc evm; do
    if ! CHAIN=$c "${BASH_SOURCE[0]}" run; then
      CHAIN=$c "${BASH_SOURCE[0]}" down
      die "CHAIN=$c failed (logs in $ROOT/.demo/watchtower*)"
    fi
    CHAIN=$c "${BASH_SOURCE[0]}" down
  done
  log "btc, ltc and evm: all stories passed"
}

case "${1:-help}" in
  run) run ;;
  up) up ;;
  down) down ;;
  run-all) run_all ;;
  *) usage ;;
esac
