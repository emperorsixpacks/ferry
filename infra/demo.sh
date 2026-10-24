#!/usr/bin/env bash
# One-command local Ferry demo: regtest bitcoind (Docker), two ferryd daemons and a block producer.
# Run `infra/demo.sh help` for usage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${FERRY_DEMO_DIR:-$ROOT/.demo}"

# CHAIN=ltc swaps ZEC against Litecoin: litecoind regtest instead of bitcoind (infra/demo-ltc.sh).
CHAIN="${CHAIN:-btc}"
case "$CHAIN" in
  btc)
    TICKER=BTC
    CONTAINER="${BITCOIND_CONTAINER:-ferry-bitcoind}"
    IMAGE="${BITCOIND_IMAGE:-bitcoin/bitcoin:28.1}"
    BTC_RPC_PORT="${BTC_RPC_PORT:-18643}"
    NODE_RPC_PORT=18443 # inside the container
    ADDR_TYPE=bech32m ;;
  ltc)
    TICKER=LTC
    CONTAINER="${BITCOIND_CONTAINER:-ferry-litecoind}"
    # Litecoin Core 0.21.5.6 (Taproot + MWEB), pinned like infra/ltc/regtest.sh.
    IMAGE="${BITCOIND_IMAGE:-uphold/litecoin-core:0.21@sha256:46ebcaa617f66f3f35be4d7c2fe46bb07f037fd9f4482c4e1d1b044997d30b1c}"
    BTC_RPC_PORT="${BTC_RPC_PORT:-19643}"
    NODE_RPC_PORT=19443
    # Litecoin Core's wallet has no bech32m type.
    ADDR_TYPE=bech32 ;;
  *) echo "CHAIN must be btc or ltc" >&2; exit 2 ;;
esac
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
# ZEC_BACKEND=devtool: Zebra + Zaino regtest in Docker (amd64 images; emulated on arm64).
ZEBRA_IMAGE="${ZEBRA_IMAGE:-zfnd/zebra:7.0.0-rc.0}"
ZAINO_IMAGE="${ZAINO_IMAGE:-zingodevops/zaino:0.10.2-no-tls}"
ZEBRA_CONTAINER="${ZEBRA_CONTAINER:-ferry-demo-zebra}"
ZAINO_CONTAINER="${ZAINO_CONTAINER:-ferry-demo-zaino}"
ZEC_NET="$ZEBRA_CONTAINER-net"
ZEC_RPC_PORT="${ZEC_RPC_PORT:-18232}"
ZAINO_PORT="${ZAINO_PORT:-8137}"
ZEC_RPC="http://127.0.0.1:$ZEC_RPC_PORT"
ZEC_DEVTOOL="${ZEC_DEVTOOL:-$ROOT/vendor/zcash-devtool/target/release/zcash-devtool}"
ZEC_SIGNER="${ZEC_SIGNER:-$ROOT/tools/ferry-zec-signer/target/release/ferry-zec-signer}"
T1="${T1:-12}"
T2="${T2:-24}"
DELTA="${DELTA:-3}"
BTC_LOCK_CONFS="${BTC_LOCK_CONFS:-2}"
ZEC_CONFS="${ZEC_CONFS:-3}"
POLL_MS="${POLL_MS:-500}"
FERRYD="${FERRYD:-$ROOT/target/debug/ferryd}"

usage() {
  cat <<EOF
Ferry local demo: shielded ZEC <-> $TICKER atomic swap between two daemons on one machine.
CHAIN=ltc (or infra/demo-ltc.sh) runs it against litecoind instead of bitcoind.

  infra/demo.sh up       start bitcoind (regtest, Docker container $CONTAINER), build ferryd,
                         start Z ($Z_NAME, :$Z_PORT) and B ($B_NAME, :$B_PORT, maker at $RATE sat/ZEC),
                         fund B's BTC wallet and start the block producer. Starts from a fresh chain.
  infra/demo.sh down     stop the daemons, the block producer and bitcoind (logs stay in $STATE/logs)
  infra/demo.sh status   chain height, daemon status and swaps at a glance
  infra/demo.sh logs [z|b|miner|bitcoind|zec-miner|zebra|zaino]   follow a log
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
  CHAIN [btc|ltc, $CHAIN]  BITCOIND_CONTAINER [$CONTAINER]  BITCOIND_IMAGE
  BLOCK_SECS [$BLOCK_SECS]  FAST_BLOCK_SECS [$FAST_BLOCK_SECS]  BTC_RPC_PORT [$BTC_RPC_PORT]
  Z_PORT [$Z_PORT]  B_PORT [$B_PORT]  Z_PEER_PORT [$Z_PEER_PORT]  B_PEER_PORT [$B_PEER_PORT]
  UI_ORIGINS [$UI_ORIGINS] (browser origins allowed on the API)  RATE [$RATE sat/ZEC]  B_FUND_BTC [$B_FUND_BTC]
  T1 [$T1]  T2 [$T2]  DELTA [$DELTA]  BTC_LOCK_CONFS [$BTC_LOCK_CONFS]  ZEC_CONFS [$ZEC_CONFS]  POLL_MS [$POLL_MS]
  ZEC_BACKEND [mock|devtool, $ZEC_BACKEND]   mock: a stand-in Zcash chain in $STATE/zec-mock.json
    ZEC_BALANCE_ZAT [$ZEC_BALANCE_ZAT] (Z's starting shielded balance)  ZEC_BLOCK_SECS [$ZEC_BLOCK_SECS]
    devtool: real Ironwood via ferry-zec on Zebra ($ZEBRA_CONTAINER, RPC :$ZEC_RPC_PORT) + Zaino
      ($ZAINO_CONTAINER, :$ZAINO_PORT). A miner wallet takes the (Ironwood) coinbase and pays Z
      ZEC_BALANCE_ZAT; a ZEC block every ~ZEC_BLOCK_SECS+2s (blocks take ~2s under amd64 emulation).
      Setup mines ~125 blocks first (coinbase maturity), a few minutes. Needs ZEC_DEVTOOL
      [vendor/zcash-devtool + infra/patches/zcash-devtool-ferry.patch, built with --features regtest_support]; builds ZEC_SIGNER
      [tools/ferry-zec-signer] if missing. Extra ferryd flags: ZEC_ARGS_Z / ZEC_ARGS_B
  FERRYD_ARGS (extra flags for both daemons)   FERRY_DEMO_DIR [$STATE]
  MAKER_ARGS (extra flags for B, e.g. "--maker-price-feed coingecko --maker-spread-bps 50")
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
  log "starting the $TICKER node ($IMAGE) on 127.0.0.1:$BTC_RPC_PORT"
  docker run -d --name "$CONTAINER" -p "127.0.0.1:$BTC_RPC_PORT:$NODE_RPC_PORT" "$IMAGE" \
    -regtest -server -txindex -printtoconsole -rpcport="$NODE_RPC_PORT" \
    -rpcuser=ferry -rpcpassword=ferry -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
    -fallbackfee=0.0002 >/dev/null
  for _ in $(seq 1 60); do
    rpc "" getblockcount >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  docker logs --tail 30 "$CONTAINER" >&2
  die "the $TICKER node did not come up"
}

# Litecoin: activate MWEB as on mainnet. It locks in by BIP9 signalling at block 431; every
# later block needs a HogEx, and the first HogEx needs a peg-in, so without this the block
# producer would fail past block 431 with "bad-txns-vin-empty".
activate_mweb() { # activate_mweb <miner address>
  rpc "" generatetoaddress "[431, \"$1\"]" >/dev/null
  local mweb
  mweb=$(rpc miner getnewaddress '["", "mweb"]' | result)
  rpc miner sendtoaddress "[\"$mweb\", 1]" >/dev/null
  rpc "" generatetoaddress "[1, \"$1\"]" >/dev/null
  rpc "" getblockchaininfo | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin)["result"]["softforks"]["mweb"]["bip9"]["status"] != "active")' \
    || die "MWEB did not activate"
  log "MWEB active at height $(rpc "" getblockcount | result)"
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
      zec_args=(--zec devtool --zec-devtool "$ZEC_DEVTOOL" --zec-signer "$ZEC_SIGNER"
        --zec-wallet-dir "$STATE/zec/$key" --zec-identity "$STATE/zec/$key.age"
        --zec-server "localhost:$ZAINO_PORT" --zec-node-rpc "$ZEC_RPC"
        --zec-activation-heights "$STATE/zec/activation_heights.toml" ${!extra_var:-}) ;;
    *) die "ZEC_BACKEND must be mock or devtool" ;;
  esac
  # shellcheck disable=SC2206
  local extra=(${FERRYD_ARGS:-})
  local origins=()
  for o in $UI_ORIGINS; do origins+=(--ui-origin "$o"); done
  "$FERRYD" --role "$role" --name "$name" --api-listen "127.0.0.1:$port" --listen "127.0.0.1:$peer_port" \
    --data-dir "$STATE/$key" --demo-faults --dev-policy ${origins[@]+"${origins[@]}"} \
    --chain "$CHAIN" --btc-rpc "$BTC_RPC" --btc-wallet "$name" "${zec_args[@]}" \
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

# ---------------------------------------------------------------- Zcash regtest (ZEC_BACKEND=devtool)

zrpc() { # zrpc <method> [json params]
  curl -sf -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":\"demo\",\"method\":\"$1\",\"params\":${2:-[]}}" "$ZEC_RPC"
}

# zheight: the tip, waiting (up to 2 min) for zebrad's RPC to answer with a number.
zheight() {
  local h
  for _ in $(seq 1 120); do
    h=$(zrpc getblockcount 2>/dev/null | result 2>/dev/null) && [[ "$h" =~ ^[0-9]+$ ]] && { echo "$h"; return 0; }
    sleep 1
  done
  echo "[demo] error: zebrad RPC at $ZEC_RPC is not answering" >&2
  return 1
}

# zmine <n>: `generate` can answer with a JSON error (HTTP 200) while zebrad warms up, so this
# checks that the tip actually moved.
zmine() {
  local h target
  h=$(zheight)
  target=$((h + $1))
  while h=$(zheight) && [ "$h" -lt "$target" ]; do
    zrpc generate "[$((target - h < 10 ? target - h : 10))]" >/dev/null || sleep 1
  done
  [ "$h" -ge "$target" ] || die "could not mine ZEC blocks"
}

# Always with stdin closed: given an existing identity file, devtool can block reading stdin.
zdt() { RUST_LOG=error NO_COLOR=1 "$ZEC_DEVTOOL" "$@" </dev/null; }

# with_timeout <secs> <cmd...>: a devtool call against a server that is not up yet can hang.
with_timeout() { perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$@"; }

zwallet_init() { # zwallet_init <key>
  zdt wallet -w "$STATE/zec/$1" init --name "$1" -i "$STATE/zec/$1.age" -n regtest \
    --activation-heights "$STATE/zec/activation_heights.toml" -s "localhost:$ZAINO_PORT" >/dev/null
}

zwallet_ua() { zdt wallet -w "$STATE/zec/$1" list-addresses | awk '/Default Address/{print $3; exit}'; }

start_zebra() { # start_zebra <miner address>
  cat >"$STATE/zec/zebrad.toml" <<TOML
[network]
network = "Regtest"
listen_addr = "0.0.0.0:18233"

[network.testnet_parameters.activation_heights]
Canopy = 1
NU5 = 1
NU6 = 1
"NU6.1" = 1
"NU6.2" = 1
"NU6.3" = 1

[mining]
miner_address = "$1"

[rpc]
listen_addr = "0.0.0.0:18232"
enable_cookie_auth = false

[state]
cache_dir = "/home/zebra/.cache/zebra"
TOML
  docker rm -f "$ZEBRA_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$ZEBRA_CONTAINER" --platform linux/amd64 --network "$ZEC_NET" \
    -p "127.0.0.1:$ZEC_RPC_PORT:18232" -v "$ZEBRA_CONTAINER-state:/home/zebra/.cache/zebra" \
    -v "$STATE/zec/zebrad.toml:/etc/zebrad/zebrad.toml:ro" \
    "$ZEBRA_IMAGE" zebrad -c /etc/zebrad/zebrad.toml start >/dev/null
  for _ in $(seq 1 120); do
    zrpc getblockcount >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs --tail 30 "$ZEBRA_CONTAINER" >&2
  die "zebrad did not come up"
}

# Zebra + Zaino on a fresh chain; a miner wallet takes the coinbase (which lands in Ironwood),
# then pays Z its starting balance. Z's and B's wallets are created here too.
start_zec() {
  local build_devtool="(cd vendor/zcash-devtool && patch -p1 < ../../infra/patches/zcash-devtool-ferry.patch && cargo build --release --features regtest_support)"
  [ -x "$ZEC_DEVTOOL" ] || die "ZEC_DEVTOOL not found: $ZEC_DEVTOOL
  build it: $build_devtool"
  "$ZEC_DEVTOOL" pczt create-max --help 2>/dev/null | grep -q -- --discard-ovk &&
    "$ZEC_DEVTOOL" pczt create-max --help 2>/dev/null | grep -q -- --ironwood-only &&
    "$ZEC_DEVTOOL" pczt create --help 2>/dev/null | grep -q -- --ironwood-only ||
    die "$ZEC_DEVTOOL lacks Ferry's patch (create/create-max --ironwood-only, create-max --discard-ovk, Ironwood signing): $build_devtool"
  if [ ! -x "$ZEC_SIGNER" ]; then
    log "building ferry-zec-signer"
    (cd "$ROOT/tools/ferry-zec-signer" && cargo build -q --release) || die "building ferry-zec-signer failed"
  fi
  docker rm -f "$ZAINO_CONTAINER" "$ZEBRA_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$ZEBRA_CONTAINER-state" >/dev/null 2>&1 || true
  docker network create "$ZEC_NET" >/dev/null 2>&1 || true
  rm -rf "$STATE/zec" && mkdir -p "$STATE/zec"
  # `down` removes exactly these, so a second demo (another FERRY_DEMO_DIR) is left alone.
  echo "$ZAINO_CONTAINER $ZEBRA_CONTAINER" >"$STATE/zec/containers"
  cat >"$STATE/zec/activation_heights.toml" <<TOML
overwinter = 1
sapling = 1
blossom = 1
heartwood = 1
canopy = 1
nu5 = 1
nu6 = 1
nu6_1 = 1
nu6_2 = 1
nu6_3 = 1
nu7 = "never"
TOML
  cat >"$STATE/zec/zainod.toml" <<TOML
backend = "fetch"
network = "Regtest"

[grpc_settings]
listen_address = "0.0.0.0:8137"

[validator_settings]
validator_jsonrpc_listen_address = "$ZEBRA_CONTAINER:18232"
validator_user = "regtest"
validator_password = "regtest"

[storage.database]
path = "/app/data"
TOML

  # zebrad wants a miner address before any wallet can exist (wallet init needs Zaino up):
  # start with a throwaway testnet t-address, then restart with the miner wallet's UA.
  log "starting zebrad ($ZEBRA_IMAGE) on 127.0.0.1:$ZEC_RPC_PORT and zainod on :$ZAINO_PORT"
  start_zebra tmWxWwf15vYpBNP82EJ2vNWSS5CaikXYbjb
  zmine 1
  docker run -d --name "$ZAINO_CONTAINER" --platform linux/amd64 --network "$ZEC_NET" \
    -p "127.0.0.1:$ZAINO_PORT:8137" -v "$STATE/zec/zainod.toml:/app/config/zainod.toml:ro" \
    "$ZAINO_IMAGE" start -c /app/config/zainod.toml >/dev/null
  # Ready = a wallet can be created against it (zainod also has to index block 1 first, which
  # under amd64 emulation can take a while). Each attempt is time-boxed; the last error is kept.
  local ok=
  for _ in $(seq 1 90); do
    if with_timeout 30 "$ZEC_DEVTOOL" wallet -w "$STATE/zec/miner" init --name miner -i "$STATE/zec/miner.age" \
      -n regtest --activation-heights "$STATE/zec/activation_heights.toml" -s "localhost:$ZAINO_PORT" \
      </dev/null >"$STATE/zec/probe.log" 2>&1; then ok=1; break; fi
    rm -rf "$STATE/zec/miner"
    sleep 3
  done
  if [ -z "$ok" ]; then
    docker logs --tail 15 "$ZAINO_CONTAINER" >&2
    echo "[demo] last wallet init attempt:" >&2
    tail -n 5 "$STATE/zec/probe.log" >&2
    die "zainod did not come up (zebrad height $(zheight 2>/dev/null || echo '?'))"
  fi
  start_zebra "$(zwallet_ua miner)"
  log "mining 105 ZEC blocks (coinbase maturity is 100; ~2s a block under emulation)"
  zmine 105
  zwallet_init z
  zwallet_init b
  zdt wallet -w "$STATE/zec/miner" sync -s "localhost:$ZAINO_PORT" >/dev/null
  zdt wallet -w "$STATE/zec/miner" send -i "$STATE/zec/miner.age" --address "$(zwallet_ua z)" \
    --value "$ZEC_BALANCE_ZAT" -s "localhost:$ZAINO_PORT" >/dev/null
  # A note from another wallet is spendable after 10 confirmations under devtool's default policy.
  zmine 11
  log "funded Z with $ZEC_BALANCE_ZAT zat of shielded (Ironwood) ZEC"
}

# One ZEC block every ZEC_BLOCK_SECS (plus the time zebrad takes to make it).
zec_producer() {
  while true; do
    sleep "$ZEC_BLOCK_SECS"
    if zrpc generate '[1]' >/dev/null; then
      echo "$(date '+%H:%M:%S') zec block $(zheight)"
    else
      echo "$(date '+%H:%M:%S') zec mining failed"
    fi
  done
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
  if alive z || alive b || alive miner || alive zec-miner; then
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
  [ "$ZEC_BACKEND" = devtool ] && start_zec

  rpc "" createwallet '["miner"]' >/dev/null
  local miner
  miner=$(rpc miner getnewaddress "[\"\", \"$ADDR_TYPE\"]" | result)
  if [ "$CHAIN" = ltc ]; then
    activate_mweb "$miner"
  else
    rpc "" generatetoaddress "[101, \"$miner\"]" >/dev/null
    log "mined 101 blocks to the miner wallet"
  fi

  log "starting B ($B_NAME, maker at $RATE sat/ZEC): API :$B_PORT, peer :$B_PEER_PORT"
  # shellcheck disable=SC2086
  start_ferryd b b "$B_NAME" "$B_PORT" "$B_PEER_PORT" --maker-offer "$RATE" ${MAKER_ARGS:-}
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
  b_addr=$(rpc "$B_NAME" getnewaddress "[\"\", \"$ADDR_TYPE\"]" | result)
  rpc miner sendtoaddress "[\"$b_addr\", $B_FUND_BTC]" >/dev/null
  rpc "" generatetoaddress "[1, \"$miner\"]" >/dev/null
  log "funded $B_NAME with $B_FUND_BTC $TICKER"

  producer "$miner" >>"$STATE/logs/miner.log" 2>&1 &
  echo $! >"$STATE/miner.pid"
  if [ "$ZEC_BACKEND" = devtool ]; then
    zec_producer >>"$STATE/logs/zec-miner.log" 2>&1 &
    echo $! >"$STATE/zec-miner.pid"
  fi

  log "ready (ZEC/$TICKER): Z http://127.0.0.1:$Z_PORT  B http://127.0.0.1:$B_PORT (maker $MAKER_URL)  $TICKER node $BTC_RPC  (ZEC: $ZEC_BACKEND, a block every ${BLOCK_SECS}s)"
  log "API tokens and UI settings: $STATE/env"
  log "UI: cd web && source $STATE/env && pnpm dev:ui"
}

cmd_down() {
  stop_pid miner
  stop_pid zec-miner
  stop_pid z
  stop_pid b
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && log "removed $CONTAINER" || true
  if [ -f "$STATE/zec/containers" ]; then
    for c in $(cat "$STATE/zec/containers"); do
      docker rm -f "$c" >/dev/null 2>&1 && log "removed $c" || true
    done
  fi
  log "stopped (logs in $STATE/logs)"
}

cmd_status() {
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "bitcoind  up, height $(rpc "" getblockcount | result)  ($BTC_RPC)"
  else
    echo "bitcoind  down"
  fi
  if alive miner; then echo "producer  up (pid $(cat "$STATE/miner.pid"))"; else echo "producer  down"; fi
  if [ -f "$STATE/zec/containers" ] && docker ps --format '{{.Names}}' | grep -qx "$ZEBRA_CONTAINER"; then
    echo "zebrad    up, height $(zheight 2>/dev/null || echo '?')  ($ZEC_RPC, zaino :$ZAINO_PORT)"
    if alive zec-miner; then echo "zec producer up (pid $(cat "$STATE/zec-miner.pid"))"; else echo "zec producer down"; fi
  fi
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
  elif [ "$which" = zebra ]; then
    docker logs -f --tail 50 "$ZEBRA_CONTAINER"
  elif [ "$which" = zaino ]; then
    docker logs -f --tail 50 "$ZAINO_CONTAINER"
  else
    tail -n 50 -f "$STATE/logs/$which.log"
  fi
}

cmd_mine() {
  local miner
  miner=$(rpc miner getnewaddress "[\"\", \"$ADDR_TYPE\"]" | result) || die "the $TICKER node is not up"
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
