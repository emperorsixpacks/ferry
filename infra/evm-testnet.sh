#!/usr/bin/env bash
# Ferry on public test networks, EVM pair: shielded ZEC on Zcash testnet <-> Circle's test USDC
# locked in FerryLock on Base Sepolia. Run `infra/evm-testnet.sh help`.
set -euo pipefail
# Keys, wallets, tokens and logs: everything this script creates is private to the user.
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_STATE="$ROOT/.evm-testnet"
FORK_STATE="$ROOT/.evm-testnet-fork"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
ANVIL="${ANVIL:-$(command -v anvil || echo "$FOUNDRY_BIN/anvil")}"
FORGE="${FORGE:-$(command -v forge || echo "$FOUNDRY_BIN/forge")}"
CAST="${CAST:-$(command -v cast || echo "$FOUNDRY_BIN/cast")}"
FERRYD="${FERRYD:-$ROOT/target/debug/ferryd}"
ARTIFACT="$ROOT/crates/ferry-evm/artifacts/FerryLock.json"

# `fork ...` rehearses everything on a local anvil fork of Base Sepolia, with its own state
# directory, so nothing it creates or deploys mixes with the real setup.
FORK_PORT="${FORK_PORT:-18547}"
FORK_URL="${FORK_URL:-https://sepolia.base.org}"
if [ "${1:-}" = fork ]; then
  STATE="${FERRY_EVM_TESTNET_DIR:-$FORK_STATE}"
  EVM_RPC="${EVM_RPC:-http://127.0.0.1:$FORK_PORT}"
  ZEC_BACKEND="${ZEC_BACKEND:-mock}"
  FAULTS="${FAULTS:-1}"
else
  STATE="${FERRY_EVM_TESTNET_DIR:-$DEFAULT_STATE}"
fi

EVM_RPC="${EVM_RPC:-https://sepolia.base.org}"
CHAIN_ID=84532
# Circle's test USDC on Base Sepolia (faucet.circle.com).
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
EXPLORER="${EXPLORER:-https://sepolia.basescan.org}"

Z_PORT="${Z_PORT:-7951}"           # control API (/api/*, loopback)
B_PORT="${B_PORT:-7952}"
Z_PEER_PORT="${Z_PEER_PORT:-7961}" # peer protocol (/peer/*)
B_PEER_PORT="${B_PEER_PORT:-7962}"
MAKER_URL="http://127.0.0.1:$B_PEER_PORT"
UI_ORIGINS="${UI_ORIGINS:-http://localhost:7995 http://127.0.0.1:7995}"
Z_NAME="${Z_NAME:-zoe}"
B_NAME="${B_NAME:-bram}"

# USDC base units (10^-6) per ZEC: 40 USDC/ZEC. The default swap, 0.05 ZEC, is 2 USDC.
RATE="${RATE:-40000000}"
MIN_ZAT="${MIN_ZAT:-1000000}"
MAX_ZAT="${MAX_ZAT:-25000000}"
SWAP_ZAT="${SWAP_ZAT:-5000000}"
# Deadlines in seconds of Base block time (2 s blocks); `help` explains the choice.
T1_SECS="${T1_SECS:-2700}"
REFUND_SECS="${REFUND_SECS:-1800}"
DELTA_SECS="${DELTA_SECS:-300}"
LOCK_CONFS="${LOCK_CONFS:-10}"
ZEC_CONFS="${ZEC_CONFS:-3}"
POLL_MS="${POLL_MS:-4000}"
# https://sepolia.base.org answers eth_getLogs for at most 200 blocks at a time.
LOG_CHUNK="${LOG_CHUNK:-200}"
RPC_TRIES="${RPC_TRIES:-6}"
export ETH_RPC_TIMEOUT="${ETH_RPC_TIMEOUT:-30}"

# Test ETH to fund each account with, and the balance below which status asks for more. At
# Base Sepolia's usual base fee (about 0.005 gwei) deploying FerryLock (1.8M gas) costs about
# 0.00001 ETH, and a swap about 0.000002 ETH for B (approve + lock, 0.32M gas) and less for Z
# (claim, 75k gas); the minimums still cover one more step at 1 gwei, should gas spike.
DEPLOYER_ETH="${DEPLOYER_ETH:-0.005}"
DEPLOYER_MIN_ETH="${DEPLOYER_MIN_ETH:-0.002}"
B_ETH="${B_ETH:-0.002}"
B_MIN_ETH="${B_MIN_ETH:-0.0005}"
Z_ETH="${Z_ETH:-0.001}"
Z_MIN_ETH="${Z_MIN_ETH:-0.0002}"
ZEC_FEE_RESERVE_ZAT=50000

ZEC_BACKEND="${ZEC_BACKEND:-devtool}"
ZEC_NETWORK="${ZEC_NETWORK:-test}"
ZEC_SERVER="${ZEC_SERVER:-testnet.zec.rocks:443}"
ZEC_NODE_RPC="${ZEC_NODE_RPC:-}"
ZEC_DEVTOOL="${ZEC_DEVTOOL:-$ROOT/vendor/zcash-devtool/target/release/zcash-devtool}"
ZEC_SIGNER="${ZEC_SIGNER:-$ROOT/tools/ferry-zec-signer/target/release/ferry-zec-signer}"
ZEC_MOCK_BLOCK_SECS="${ZEC_MOCK_BLOCK_SECS:-5}"
ZEC_MOCK_BALANCE="${ZEC_MOCK_BALANCE:-100000000}"

FAULTS="${FAULTS:-}"
CDP_FAUCET="Coinbase CDP faucet (https://portal.cdp.coinbase.com/products/faucet)"
ALCHEMY_FAUCET="Alchemy faucet (https://www.alchemy.com/faucets/base-sepolia)"
CIRCLE_FAUCET="https://faucet.circle.com (network: Base Sepolia)"
TAZ_FAUCET="https://fauzec.com"

usage() {
  cat <<EOF
Ferry on Base Sepolia: shielded ZEC on Zcash testnet (TAZ) <-> Circle's test USDC in FerryLock.

  infra/evm-testnet.sh keys      create the accounts, once: B (the USDC maker), Z (the ZEC taker), a
                                 deployer, and a Zcash testnet wallet for each side. Kept in
                                 $STATE (mode 0700/0600); prints addresses only.
                                 Never overwrites a key that exists.
  infra/evm-testnet.sh status    balances (ETH and USDC on Base Sepolia, TAZ), FerryLock, the
                                 daemons, and what still needs funding, with the faucets
  infra/evm-testnet.sh deploy    deploy FerryLock from the deployer and check that the code on
                                 chain is exactly this build's FerryLock
  infra/evm-testnet.sh up        start B ($B_NAME, maker at $RATE USDC units/ZEC, API :$B_PORT, peer
                                 :$B_PEER_PORT) and Z ($Z_NAME, API :$Z_PORT, peer :$Z_PEER_PORT)
  infra/evm-testnet.sh swap [--refund|--punish]
                                 Z swaps SWAP_ZAT ($SWAP_ZAT zat) with B and the script follows it to
                                 the end, printing each step and the explorer link of every Base tx.
                                 --refund: Z stops after locking its ZEC, B refunds at t1, Z
                                 reclaims. --punish: B stops after locking, Z punishes at t2. Both
                                 need FAULTS=1 at \`up\`, and take t1 or t2 of real time.
  infra/evm-testnet.sh down      stop the two daemons (only the PIDs this script started)
  infra/evm-testnet.sh logs [z|b|anvil]
  infra/evm-testnet.sh fork up|fund|test|down
                                 rehearsal on a local anvil fork of Base Sepolia (127.0.0.1:$FORK_PORT)
                                 with the real USDC contract, state in $FORK_STATE,
                                 mock ZEC. \`fork fund\` gives the accounts the amounts \`status\`
                                 asks for (USDC moved from a real holder); \`fork test\` runs keys,
                                 fund, deploy, up, a swap, a refund and a punish (time jumped on
                                 the fork), then stops everything. Nothing touches the real chain.

Order on the real network: keys, fund (status says what and where), deploy, up, swap.

Before acting, deploy, up and swap check on the RPC that the chain id is $CHAIN_ID and that
$USDC reports symbol "USDC" and 6 decimals. ferryd itself refuses to start unless the
code at the FerryLock address is the FerryLock it was built with.

Deadlines (seconds of Base block time; FerryLock compares block timestamps):
  T1_SECS=$T1_SECS (45 min) from the proposal to t1, the end of the claim window. Base Sepolia
    makes a block every 2 s, so B's lock and its LOCK_CONFS=$LOCK_CONFS confirmations take about
    half a minute. The rest is for Z's ZEC lock to collect ZEC_CONFS=$ZEC_CONFS confirmations on
    Zcash testnet: blocks come every 75 s on average but the testnet has gaps of 10-20 minutes,
    and if the window runs out nothing is lost (B refunds at t1, Z reclaims its ZEC).
  DELTA_SECS=$DELTA_SECS (5 min): Z sends no claim after t1 - DELTA, B no refund after
    t2 - DELTA, B signs Ready only before t1 - DELTA. A claim that lands after t1 reverts but
    still shows z, so DELTA must cover the worst inclusion delay on a single-sequencer chain,
    with RPC retries. ferryd's Base Sepolia policy asks for at least 2 min.
  REFUND_SECS=$REFUND_SECS (30 min) from t1 to t2: B refunds as soon as a block at or after t1
    exists; punish opens at t2.
  LOCK_CONFS=$LOCK_CONFS (about 20 s): Z waits this many Base blocks on top of B's lock before
    sending ZEC. Base reorgs are rare and shallow; this costs nothing and the policy minimum is 2.
  POLL_MS=$POLL_MS: each daemon polls the chain this often. https://sepolia.base.org is rate
    limited; ferryd retries throttled requests with a backoff and reads only new log ranges.

Environment (defaults in brackets):
  EVM_RPC [$EVM_RPC]  EXPLORER [$EXPLORER]  FERRY_EVM_TESTNET_DIR [$STATE]
  RATE [$RATE USDC units/ZEC]  MIN_ZAT [$MIN_ZAT]  MAX_ZAT [$MAX_ZAT]  SWAP_ZAT [$SWAP_ZAT]
  T1_SECS [$T1_SECS]  REFUND_SECS [$REFUND_SECS]  DELTA_SECS [$DELTA_SECS]  LOCK_CONFS [$LOCK_CONFS]
  ZEC_CONFS [$ZEC_CONFS]  POLL_MS [$POLL_MS]  LOG_CHUNK [$LOG_CHUNK]  UI_ORIGINS [$UI_ORIGINS]
  Z_PORT [$Z_PORT] B_PORT [$B_PORT] Z_PEER_PORT [$Z_PEER_PORT] B_PEER_PORT [$B_PEER_PORT] FORK_PORT [$FORK_PORT]
  ZEC_BACKEND [devtool|mock, $ZEC_BACKEND]
    devtool: the real Zcash testnet through zcash-devtool wallets in $STATE/{z,b}/zec-wallet.
      ZEC_SERVER [$ZEC_SERVER]  ZEC_NODE_RPC (optional Zebra JSON-RPC)
      ZEC_DEVTOOL [$ZEC_DEVTOOL]
      ZEC_SIGNER [$ZEC_SIGNER] (built on first \`up\` if missing)
    mock: a stand-in Zcash chain (ZEC_MOCK_BLOCK_SECS [$ZEC_MOCK_BLOCK_SECS]), for the fork rehearsal.
  FAULTS=1 enables the fault endpoint that swap --refund/--punish use.  FERRYD_ARGS: extra flags.

The UI: cd web && source $STATE/env && PORT=7995 pnpm dev:ui
EOF
}

log() { printf '[evm-testnet] %s\n' "$*"; }
die() { printf '[evm-testnet] error: %s\n' "$*" >&2; exit 1; }

# alive <z|b|anvil>: the process in <name>.pid is running and is still the one this script
# started (its command line names our data directory or fork port), not a reused PID.
alive() {
  local pid mark
  pid=$(cat "$STATE/$1.pid" 2>/dev/null) || return 1
  case $1 in
    anvil) mark="--port $FORK_PORT" ;;
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

ccall() { retry "$CAST" call "$@" --rpc-url "$EVM_RPC"; }
eth_wei() { retry "$CAST" balance "$1" --rpc-url "$EVM_RPC"; }
usdc_units() { ccall "$USDC" "balanceOf(address)(uint256)" "$1" | awk '{print $1}'; }
chain_time() { retry "$CAST" block latest --field timestamp --rpc-url "$EVM_RPC"; }
# fmt_eth <wei>: ETH with at most 6 decimals
fmt_eth() { python3 -c 'import sys; print(("%.6f" % (int(sys.argv[1]) / 1e18)).rstrip("0").rstrip("."))' "$1"; }
# ge <a> <b>: a >= b, for integers of any size
ge() { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)' "$1" "$2"; }

is_anvil() {
  "$CAST" rpc web3_clientVersion --rpc-url "$EVM_RPC" 2>/dev/null | grep -qi anvil
}

# The RPC must be Base Sepolia (or a fork of it) and the token Circle's test USDC.
check_chain() {
  local id sym dec
  id=$(retry "$CAST" chain-id --rpc-url "$EVM_RPC") || die "cannot reach the EVM RPC $EVM_RPC"
  [ "$id" = "$CHAIN_ID" ] || die "$EVM_RPC reports chain id $id, not $CHAIN_ID (Base Sepolia)"
  sym=$(ccall "$USDC" "symbol()(string)") || die "eth_call symbol() on $USDC failed"
  dec=$(ccall "$USDC" "decimals()(uint8)") || die "eth_call decimals() on $USDC failed"
  [ "$sym" = '"USDC"' ] && [ "$dec" = 6 ] ||
    die "$USDC reports symbol $sym and $dec decimals, expected \"USDC\" and 6: not Circle's test USDC"
  if is_anvil; then
    # A fork deployment in the real state directory would look like a real one later.
    [ "$STATE" != "$DEFAULT_STATE" ] ||
      die "$EVM_RPC is an anvil fork: use the fork subcommands or set FERRY_EVM_TESTNET_DIR"
    FORK=1
  else
    FORK=
  fi
}

addr_of() { cat "$STATE/$1.addr" 2>/dev/null || die "no $1 account in $STATE: run infra/evm-testnet.sh keys"; }

tx_link() { echo "$EXPLORER/tx/$1"; }
addr_link() { echo "$EXPLORER/address/$1"; }

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
  log "created $1 account $(cat "$STATE/$1.addr")"
}

# The deployer is an encrypted keystore with a random password in a file next to it, so forge
# and cast take the key without it ever appearing on a command line.
new_deployer() {
  [ -s "$STATE/deployer.json" ] && return 0
  [ -s "$STATE/deployer.pass" ] || openssl rand -hex 32 >"$STATE/deployer.pass"
  local out
  out=$(CAST_PASSWORD="$(cat "$STATE/deployer.pass")" "$CAST" wallet new "$STATE" deployer.json) ||
    die "creating the deployer keystore failed"
  echo "$out" | awk '/^Address:/{print $2}' >"$STATE/deployer.addr"
  [ -s "$STATE/deployer.addr" ] || die "no address in cast's keystore output"
  log "created deployer account $(cat "$STATE/deployer.addr")"
}

zec_wallet_dir() { echo "$STATE/$1/zec-wallet"; }

# A Zcash testnet wallet laid out the way ferryd opens it (<data-dir>/zec-wallet, its mnemonic
# encrypted to <data-dir>/zec-identity.age). The birthday is the current tip.
new_zec_wallet() {
  local dir
  dir=$(zec_wallet_dir "$1")
  [ -f "$dir/keys.toml" ] && return 0
  mkdir -p "$dir" "$STATE/logs"
  # stdin from /dev/null: devtool then generates the mnemonic instead of reading one.
  if ! "$ZEC_DEVTOOL" wallet -w "$dir" init --name ferry -i "$STATE/$1/zec-identity.age" \
    -n "$ZEC_NETWORK" -s "$ZEC_SERVER" </dev/null >>"$STATE/logs/zec-init-$1.log" 2>&1; then
    tail -n 5 "$STATE/logs/zec-init-$1.log" >&2
    die "creating the Zcash wallet for $1 failed (log: $STATE/logs/zec-init-$1.log)"
  fi
  log "created the Zcash $ZEC_NETWORK wallet for $1"
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
  umask 077
  new_hex_key b
  new_hex_key z
  new_deployer
  if [ "$ZEC_BACKEND" = devtool ]; then
    [ -x "$ZEC_DEVTOOL" ] || die "zcash-devtool not found at $ZEC_DEVTOOL (build vendor/zcash-devtool, or set ZEC_DEVTOOL)"
    mkdir -p "$STATE/z" "$STATE/b"
    new_zec_wallet z
    new_zec_wallet b
  fi
  find "$STATE" -maxdepth 1 -type f -exec chmod 600 {} +
  echo
  echo "Base Sepolia accounts (keys in $STATE, never printed):"
  echo "  deployer  $(addr_of deployer)   deploys FerryLock once"
  echo "  B         $(addr_of b)   the maker: holds the USDC, locks, refunds"
  echo "  Z         $(addr_of z)   the taker: receives the USDC, sends the claim"
  if [ "$ZEC_BACKEND" = devtool ]; then
    echo "Zcash $ZEC_NETWORK wallets:"
    echo "  Z         $(zec_address z || echo '?')"
    echo "            holds the TAZ it swaps"
    echo "  B         $(zec_address b || echo '?')"
    echo "            receives the swapped ZEC"
  fi
  echo
  echo "Next: infra/evm-testnet.sh status  (what to fund, and where)"
}

# ------------------------------------------------------------------ FerryLock

artifact_field() { # artifact_field bytecode|deployedBytecode
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["object"].lower())' "$ARTIFACT" "$1"
}

lock_code_matches() {
  local code
  code=$(retry "$CAST" code "$1" --rpc-url "$EVM_RPC") || return 1
  [ "$(echo "$code" | tr 'A-F' 'a-f')" = "$(artifact_field deployedBytecode)" ]
}

# The recorded FerryLock, if the code there is this build's.
recorded_lock() {
  local lock
  lock=$(cat "$STATE/ferrylock" 2>/dev/null) || return 1
  lock_code_matches "$lock" && echo "$lock"
}

# The committed artifact (what ferryd compiles in and checks the deployment against) must be
# what the contracts build to now.
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
    if "$CAST" receipt --async "$1" --json --rpc-url "$EVM_RPC" 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
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
  [ -s "$STATE/ferrylock" ] && log "the recorded FerryLock $(cat "$STATE/ferrylock") has no FerryLock code on $EVM_RPC: deploying again"
  check_artifact
  if [ -s "$STATE/deploy.tx" ]; then
    tx=$(cat "$STATE/deploy.tx")
    log "waiting for the earlier deployment $tx"
  else
    local wei
    wei=$(eth_wei "$deployer") || die "cannot read the deployer's balance"
    [ "$wei" != 0 ] || die "the deployer $deployer has no ETH on Base Sepolia. Fund it from the $CDP_FAUCET or the $ALCHEMY_FAUCET (infra/evm-testnet.sh status)"
    log "deploying FerryLock from $deployer (balance $(fmt_eth "$wei") ETH)"
    tx=$("$CAST" send --async --keystore "$STATE/deployer.json" --password-file "$STATE/deployer.pass" \
      --rpc-url "$EVM_RPC" --create "0x$(artifact_field bytecode | sed 's/^0x//')") ||
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
  local gas
  gas=$(echo "$receipt" | python3 -c 'import json, sys; r = json.load(sys.stdin); print(int(r["gasUsed"], 16))')
  log "FerryLock deployed at $lock; its code matches this build ($gas gas)"
  echo "  contract  $(addr_link "$lock")"
  echo "  tx        $(tx_link "$tx")"
  [ -z "$FORK" ] || echo "  (an anvil fork: these links exist only locally)"
}

# ------------------------------------------------------------------ status

zec_balances() { # zec_balances <z|b> -> "total ironwood_spendable" in zat, or nothing
  local key=$1 dir
  if alive "$key"; then
    api "$key" /api/status | python3 -c '
import json, sys
b = json.load(sys.stdin)["balances"]["zec_shielded_zat"]
print(b, b)' 2>/dev/null
    return 0
  fi
  [ "$ZEC_BACKEND" = devtool ] || return 0
  dir=$(zec_wallet_dir "$key")
  [ -f "$dir/keys.toml" ] && [ -x "$ZEC_DEVTOOL" ] || return 0
  "$ZEC_DEVTOOL" wallet -w "$dir" sync -s "$ZEC_SERVER" >/dev/null 2>&1 || return 0
  "$ZEC_DEVTOOL" wallet -w "$dir" balance --json 2>/dev/null | python3 -c '
import json, sys
b = json.loads(sys.stdin.read().strip().splitlines()[-1])
print(b["total"], b["ironwood_spendable"])' 2>/dev/null || true
}

cmd_status() {
  need_foundry
  local id head now
  id=$(retry "$CAST" chain-id --rpc-url "$EVM_RPC" 2>/dev/null) || { echo "EVM RPC $EVM_RPC: unreachable"; id=; }
  if [ -n "$id" ]; then
    head=$(retry "$CAST" block-number --rpc-url "$EVM_RPC")
    now=$(chain_time)
    if [ "$id" = "$CHAIN_ID" ]; then
      echo "Base Sepolia (chain $id) via $EVM_RPC$(is_anvil && echo ' (anvil fork)'): block $head, time $now"
    else
      echo "WARNING: $EVM_RPC is chain $id, not Base Sepolia ($CHAIN_ID)"
    fi
  fi
  if [ ! -s "$STATE/b.addr" ]; then
    echo "No accounts yet: run infra/evm-testnet.sh keys"
    return 0
  fi
  local lock=""
  if [ -n "$id" ] && lock=$(recorded_lock); then
    echo "FerryLock   $lock (code matches this build)"
  elif [ -s "$STATE/ferrylock" ]; then
    echo "FerryLock   recorded at $(cat "$STATE/ferrylock") but there is no FerryLock code there on this RPC"
    lock=""
  else
    echo "FerryLock   not deployed (infra/evm-testnet.sh deploy)"
  fi
  local need_usdc=$((SWAP_ZAT * RATE / 100000000))
  local need_taz=$((SWAP_ZAT + ZEC_FEE_RESERVE_ZAT))
  local todo=()
  printf '%-9s %-44s %14s %12s\n' "" "Base Sepolia account" "ETH" "USDC"
  local who addr wei usdc min fund
  for who in deployer b z; do
    addr=$(addr_of "$who")
    wei=?
    usdc=?
    if [ -n "$id" ]; then
      wei=$(eth_wei "$addr" || echo ?)
      usdc=$(usdc_units "$addr" || echo ?)
    fi
    printf '%-9s %-44s %14s %12s\n' "$(echo "$who" | sed 's/^b$/B/;s/^z$/Z/')" "$addr" \
      "$([ "$wei" = ? ] && echo ? || fmt_eth "$wei")" \
      "$([ "$usdc" = ? ] && echo ? || "$CAST" format-units "$usdc" 6)"
    case $who in
      deployer) min=$DEPLOYER_MIN_ETH fund=$DEPLOYER_ETH ;;
      b) min=$B_MIN_ETH fund=$B_ETH ;;
      z) min=$Z_MIN_ETH fund=$Z_ETH ;;
    esac
    if [ "$who" = deployer ] && [ -n "$lock" ]; then
      :
    elif [ "$wei" = ? ] || ! ge "$wei" "$("$CAST" to-wei "$min")"; then
      todo+=("$(echo "$who" | sed 's/^b$/B/;s/^z$/Z/') $addr: about $fund ETH on Base Sepolia (it has less than $min), from the $CDP_FAUCET or the $ALCHEMY_FAUCET")
    fi
    if [ "$who" = b ] && { [ "$usdc" = ? ] || [ "$usdc" -lt "$need_usdc" ]; }; then
      todo+=("B $addr: at least $("$CAST" format-units "$need_usdc" 6) USDC, one swap of $(cast_zec "$SWAP_ZAT") ZEC (10 USDC covers several), from $CIRCLE_FAUCET")
    fi
  done
  if [ "$ZEC_BACKEND" = devtool ]; then
    echo "Zcash $ZEC_NETWORK wallets$(alive z || alive b || echo ' (syncing them now; this can take a minute)'):"
    local bal total spendable zaddr
    for who in z b; do
      zaddr=$(zec_address "$who" || echo "(no wallet: run keys)")
      bal=$(zec_balances "$who")
      total=${bal%% *}
      spendable=${bal##* }
      if [ -n "$bal" ]; then
        printf '  %s  %s TAZ (%s spendable in Ironwood)\n      %s\n' "$(echo "$who" | tr a-z A-Z)" \
          "$(cast_zec "$total")" "$(cast_zec "$spendable")" "$zaddr"
      else
        printf '  %s  balance unknown\n      %s\n' "$(echo "$who" | tr a-z A-Z)" "$zaddr"
      fi
      if [ "$who" = z ] && { [ -z "$bal" ] || [ "$spendable" -lt "$need_taz" ]; }; then
        if [ -n "$bal" ] && [ "$total" -ge "$need_taz" ]; then
          todo+=("Z: its TAZ is not spendable yet (zcash-devtool waits for 10 confirmations, about 13 minutes)")
        else
          todo+=("Z $zaddr: at least $(cast_zec "$need_taz") TAZ (the swap plus fees), from $TAZ_FAUCET")
        fi
      fi
    done
  else
    echo "Zcash: mock backend (ZEC_BACKEND=mock)"
  fi
  local key
  for key in z b; do
    if alive "$key"; then
      api "$key" /api/swaps | python3 -c '
import json, sys
role = sys.argv[1]
for s in json.load(sys.stdin):
    print("  %s swap %s…  %-16s outcome %s" % (role, s["id"][:12], s["state"], s["outcome"]))' "$(echo "$key" | tr a-z A-Z)"
      echo "ferryd $(echo "$key" | tr a-z A-Z) up (pid $(cat "$STATE/$key.pid"))"
    else
      echo "ferryd $(echo "$key" | tr a-z A-Z) down"
    fi
  done
  echo
  if [ ${#todo[@]} -eq 0 ]; then
    if [ -n "$lock" ] && alive z && alive b; then
      echo "Funded, deployed and running. Next: infra/evm-testnet.sh swap"
    elif [ -n "$lock" ]; then
      echo "Funded and deployed. Next: infra/evm-testnet.sh up, then swap"
    else
      echo "Funded. Next: infra/evm-testnet.sh deploy"
    fi
  else
    echo "Still to fund:"
    local t
    for t in "${todo[@]}"; do echo "  - $t"; done
  fi
}

cast_zec() { python3 -c 'import sys; print(("%.8f" % (int(sys.argv[1]) / 1e8)).rstrip("0").rstrip("."))' "$1"; }

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
  local origins=() extra=()
  for o in $UI_ORIGINS; do origins+=(--ui-origin "$o"); done
  [ -n "$FAULTS" ] && extra+=(--demo-faults)
  # shellcheck disable=SC2206
  extra+=(${FERRYD_ARGS:-})
  "$FERRYD" --counter evm --role "$role" --name "$name" --api-listen "127.0.0.1:$port" \
    --listen "127.0.0.1:$peer_port" --data-dir "$STATE/$key" "${zec_args[@]}" \
    ${origins[@]+"${origins[@]}"} \
    --evm-rpc "$EVM_RPC" --evm-contract "$lock" --evm-token "$USDC" --evm-key-file "$STATE/$key.key" \
    --evm-t1-secs "$T1_SECS" --evm-refund-secs "$REFUND_SECS" --evm-delta-secs "$DELTA_SECS" \
    --evm-lock-confs "$LOCK_CONFS" --evm-log-chunk "$LOG_CHUNK" --zec-confs "$ZEC_CONFS" \
    --poll-ms "$POLL_MS" "$@" ${extra[@]+"${extra[@]}"} >>"$STATE/logs/$key.log" 2>&1 &
  echo $! >"$STATE/$key.pid"
  disown
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
    die "already running (infra/evm-testnet.sh status); run infra/evm-testnet.sh down first"
  fi
  need_foundry
  check_chain
  [ -s "$STATE/b.key" ] && [ -s "$STATE/z.key" ] || die "no keys: run infra/evm-testnet.sh keys"
  recorded_lock >/dev/null || die "FerryLock is not deployed on $EVM_RPC: run infra/evm-testnet.sh deploy"
  local p
  for p in "$Z_PORT" "$B_PORT" "$Z_PEER_PORT" "$B_PEER_PORT"; do
    port_free "$p" || die "port $p is in use (set Z_PORT, B_PORT, Z_PEER_PORT, B_PEER_PORT)"
  done
  mkdir -p "$STATE/logs" "$STATE/z" "$STATE/b"
  if [ -z "${FERRYD_SKIP_BUILD:-}" ]; then
    log "building ferryd"
    (cd "$ROOT" && cargo build -q -p ferryd) || die "cargo build failed"
  fi
  if [ "$ZEC_BACKEND" = devtool ]; then
    [ -n "$ZEC_SERVER" ] || die "ZEC_SERVER=<lightwalletd host:port> is required (or ZEC_BACKEND=mock)"
    [ -x "$ZEC_DEVTOOL" ] || die "zcash-devtool not found at $ZEC_DEVTOOL (set ZEC_DEVTOOL)"
    [ -f "$(zec_wallet_dir z)/keys.toml" ] && [ -f "$(zec_wallet_dir b)/keys.toml" ] ||
      die "no Zcash wallets: run infra/evm-testnet.sh keys"
    if [ ! -x "$ZEC_SIGNER" ]; then
      log "building ferry-zec-signer"
      (cd "$ROOT/tools/ferry-zec-signer" && cargo build -q --release) || die "building ferry-zec-signer failed"
    fi
  fi
  local mock_z=()
  [ "$ZEC_BACKEND" = mock ] && mock_z=(--zec-mock-balance "$ZEC_MOCK_BALANCE")
  log "starting B ($B_NAME, maker at $RATE USDC units/ZEC): API :$B_PORT, peer :$B_PEER_PORT"
  start_ferryd b b "$B_NAME" "$B_PORT" "$B_PEER_PORT" --maker-offer "$RATE:$MIN_ZAT:$MAX_ZAT"
  log "starting Z ($Z_NAME): API :$Z_PORT, peer :$Z_PEER_PORT"
  start_ferryd z z "$Z_NAME" "$Z_PORT" "$Z_PEER_PORT" ${mock_z[@]+"${mock_z[@]}"}
  if [ -n "$FAULTS" ]; then touch "$STATE/faults"; else rm -f "$STATE/faults"; fi
  cat >"$STATE/env" <<ENV
export FERRY_Z_URL=http://127.0.0.1:$Z_PORT
export FERRY_B_URL=http://127.0.0.1:$B_PORT
export FERRY_MAKER_URL=$MAKER_URL
export FERRY_Z_TOKEN=$(cat "$STATE/z/api-token")
export FERRY_B_TOKEN=$(cat "$STATE/b/api-token")
ENV
  log "ready: Z http://127.0.0.1:$Z_PORT  B http://127.0.0.1:$B_PORT (maker $MAKER_URL), FerryLock $(cat "$STATE/ferrylock") on $EVM_RPC (ZEC: $ZEC_BACKEND/$ZEC_NETWORK)"
}

cmd_down() {
  stop_pid z
  stop_pid b
  log "stopped the daemons (logs in $STATE/logs)"
}

# ------------------------------------------------------------------ swap

# Both sides' timeline entries after the first <z shown> / <b shown>, in time order (local time),
# each transaction linked once; then a line "# <z count> <z state> <z outcome> <b count> <b state>
# <b outcome> <tx hashes shown so far, comma separated>".
follow() { # follow <id> <z shown> <b shown> <seen>
  local zj bj
  zj=$(api z "/api/swaps/$1") || return 1
  bj=$(api b "/api/swaps/$1") || return 1
  python3 -c '
import json, sys
from datetime import datetime
zs, bs, seen, explorer, fork = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
z, b = json.loads(sys.argv[6]), json.loads(sys.argv[7])
seen = set(h for h in seen.split(",") if h not in ("", "-"))
new = [(e["at"], "Z", e) for e in z["timeline"][zs:]] + [(e["at"], "B", e) for e in b["timeline"][bs:]]
for at, who, e in sorted(new, key=lambda n: n[0]):
    t = datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
    print("  %s %s  %s" % (t, who, e["label"]))
    tx = e.get("txid")
    if tx and tx not in seen:
        seen.add(tx)
        if e["chain"] == "btc":
            print("               Base tx  %s/tx/%s%s" % (explorer, tx, fork))
        elif e["chain"] == "zec":
            print("               Zcash tx %s" % tx)
print("#", len(z["timeline"]), z["state"], z["outcome"] or "-", len(b["timeline"]), b["state"],
      b["outcome"] or "-", ",".join(sorted(seen)) or "-")' "$2" "$3" "$4" "$EXPLORER" "${FORK:+ (fork only)}" "$zj" "$bj"
}

# The swap's Base transactions, from both sides' timelines.
base_txs() { # base_txs <id>
  local zj bj
  zj=$(api z "/api/swaps/$1") || return 1
  bj=$(api b "/api/swaps/$1") || return 1
  python3 -c '
import json, sys
names = {"btc_lock_broadcast": "lock", "btc_lock_seen": "lock", "btc_redeem_broadcast": "claim",
         "claim_seen": "claim", "refund_broadcast": "refund", "refund_seen": "refund",
         "punish_broadcast": "punish", "punish_seen": "punish"}
explorer, fork = sys.argv[1], sys.argv[2]
done = []
for s in (json.loads(sys.argv[3]), json.loads(sys.argv[4])):
    for e in s["timeline"]:
        if e["chain"] == "btc" and e.get("txid") and e["kind"] in names and e["txid"] not in done:
            done.append(e["txid"])
            print("  %-7s %s/tx/%s%s" % (names[e["kind"]], explorer, e["txid"], fork))' \
    "$EXPLORER" "${FORK:+ (fork only)}" "$zj" "$bj"
}

swap_field() { # swap_field <z|b> <id> <key path, dot separated>
  api "$1" "/api/swaps/$2" | python3 -c '
import json, sys
v = json.load(sys.stdin)
for k in sys.argv[1].split("."):
    v = v[k]
print("" if v is None else v)' "$3"
}

# warp <unix secs>: on an anvil fork only, the next block has this timestamp.
warp() {
  [ -n "$FORK" ] || return 0
  local now
  now=$(chain_time)
  if [ "$1" -gt "$now" ]; then
    "$CAST" rpc evm_setNextBlockTimestamp "$1" --rpc-url "$EVM_RPC" >/dev/null
    "$CAST" rpc evm_mine --rpc-url "$EVM_RPC" >/dev/null
    log "fork: jumped chain time forward $(($1 - now))s"
  fi
}

fault() { # fault <z|b> <id>
  api "$1" "/api/swaps/$2/fault" -X POST -H 'content-type: application/json' -d '{"fault":"stall"}' >/dev/null ||
    die "the fault endpoint refused (start the daemons with FAULTS=1)"
}

cmd_swap() {
  local mode=happy
  case "${1:-}" in
    "") ;;
    --refund) mode=refund ;;
    --punish) mode=punish ;;
    *) die "usage: infra/evm-testnet.sh swap [--refund|--punish]" ;;
  esac
  alive z && alive b || die "the daemons are not running (infra/evm-testnet.sh up)"
  [ "$mode" = happy ] || [ -f "$STATE/faults" ] ||
    die "swap --$mode stops one party through the fault endpoint: restart with FAULTS=1 infra/evm-testnet.sh up"
  need_foundry
  check_chain
  local z_addr b_addr z_before b_before id
  z_addr=$(addr_of z)
  b_addr=$(addr_of b)
  z_before=$(usdc_units "$z_addr")
  b_before=$(usdc_units "$b_addr")
  local usdc=$((SWAP_ZAT * RATE / 100000000))
  log "Z ($z_addr) swaps $(cast_zec "$SWAP_ZAT") ZEC for $("$CAST" format-units "$usdc" 6) USDC with B ($b_addr)"
  log "FerryLock $(addr_link "$(cat "$STATE/ferrylock")")${FORK:+ (fork only)}"
  local resp code
  resp=$(curl -s -m 120 -w '\n%{http_code}' -H "authorization: Bearer $(cat "$STATE/z/api-token")" \
    -H 'content-type: application/json' -d "{\"maker\":\"$MAKER_URL\",\"zec_zat\":$SWAP_ZAT}" \
    "http://127.0.0.1:$Z_PORT/api/swaps") || die "Z's API did not answer"
  code=$(echo "$resp" | tail -n 1)
  resp=$(echo "$resp" | sed '$d')
  case $code in 2??) ;; *) die "Z refused to start the swap (HTTP $code): $resp" ;; esac
  id=$(echo "$resp" | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')
  local t1 t2
  t1=$(swap_field z "$id" deadlines.t1_unix)
  t2=$(swap_field z "$id" deadlines.t2_unix)
  log "swap $id: claim window until t1 $(date -r "$t1" '+%H:%M:%S' 2>/dev/null || date -d "@$t1" '+%H:%M:%S'), punish from t2 $(date -r "$t2" '+%H:%M:%S' 2>/dev/null || date -d "@$t2" '+%H:%M:%S') (chain time)"
  local zn=0 bn=0 zs=- bs=- zo=- bo=- seen=- stalled= warped= out
  local deadline=$(($(date +%s) + t2 - $(chain_time) + 900))
  while :; do
    if out=$(follow "$id" "$zn" "$bn" "$seen" 2>/dev/null); then
      echo "$out" | sed '$d'
      read -r _ zn zs zo bn bs bo seen <<<"$(echo "$out" | tail -n 1)"
    fi
    case $mode in
      refund)
        if [ -z "$stalled" ] && [ "$zs" = ZecLocked ]; then
          fault z "$id"
          stalled=1
          log "Z stops here: it will not claim. B refunds once t1 has passed, then Z reclaims its ZEC"
        fi
        if [ -n "$stalled" ] && [ -z "$warped" ] && [ "$bs" = ReadySent ]; then
          warp "$t1"
          warped=1
        fi ;;
      punish)
        if [ -z "$stalled" ] && [ "$bs" = Locked ]; then
          fault b "$id"
          stalled=1
          log "B stops here: it will neither sign Ready nor refund. Z punishes at t2"
        fi
        if [ -n "$stalled" ] && [ -z "$warped" ] && [ "$zs" = ZecLocked ]; then
          warp "$t2"
          warped=1
        fi ;;
    esac
    [ "$zo" != - ] && [ "$bo" != - ] && break
    [ "$(date +%s)" -lt "$deadline" ] || die "gave up following the swap (Z: $zs, B: $bs); it goes on in the daemons"
    sleep 2
  done
  local z_after b_after
  z_after=$(usdc_units "$z_addr")
  b_after=$(usdc_units "$b_addr")
  echo
  echo "Base Sepolia transactions:"
  base_txs "$id" || true
  log "outcome: Z $zo, B $bo"
  log "Z's USDC $("$CAST" format-units "$z_before" 6) -> $("$CAST" format-units "$z_after" 6), B's USDC $("$CAST" format-units "$b_before" 6) -> $("$CAST" format-units "$b_after" 6)"
  case "$mode:$zo:$bo" in
    happy:swapped:swapped) [ $((z_after - z_before)) -eq "$usdc" ] || die "Z received $((z_after - z_before)) USDC units, expected $usdc" ;;
    refund:refunded:refunded) [ "$z_after" -eq "$z_before" ] && [ "$b_after" -eq "$b_before" ] || die "the refund moved USDC" ;;
    punish:punished:punished) [ $((z_after - z_before)) -eq "$usdc" ] || die "the punish paid Z $((z_after - z_before)) USDC units, expected $usdc" ;;
    *) die "unexpected outcome for a $mode swap: Z $zo, B $bo" ;;
  esac
  log "$mode swap finished as expected"
}

# ------------------------------------------------------------------ fork rehearsal

fork_up() {
  alive anvil && { log "the fork is already running"; return 0; }
  [ -x "$ANVIL" ] || die "anvil (Foundry) is required"
  port_free "$FORK_PORT" || die "port $FORK_PORT is in use"
  mkdir -p "$STATE/logs"
  chmod 700 "$STATE"
  log "starting anvil on 127.0.0.1:$FORK_PORT, forking $FORK_URL (2 s blocks, like Base)"
  "$ANVIL" --fork-url "$FORK_URL" --port "$FORK_PORT" --host 127.0.0.1 --block-time 2 \
    --retries 10 --fork-retry-backoff 1000 --timeout 30000 --silent >>"$STATE/logs/anvil.log" 2>&1 &
  echo $! >"$STATE/anvil.pid"
  disown
  for _ in $(seq 1 60); do
    "$CAST" chain-id --rpc-url "$EVM_RPC" >/dev/null 2>&1 && break
    alive anvil || break
    sleep 0.5
  done
  "$CAST" chain-id --rpc-url "$EVM_RPC" >/dev/null 2>&1 || die "anvil did not come up (log: $STATE/logs/anvil.log)"
  log "fork up at block $("$CAST" block-number --rpc-url "$EVM_RPC"), chain id $("$CAST" chain-id --rpc-url "$EVM_RPC")"
}

# A recent real holder of test USDC with at least <units>, found in the token's Transfer logs.
usdc_holder() {
  local need=$1 head from i
  head=$("$CAST" block-number --rpc-url "$EVM_RPC")
  for i in $(seq 0 20); do
    from=$((head - 199 - i * 200))
    local cands
    cands=$("$CAST" logs --address "$USDC" --from-block "$from" --to-block "$((from + 199))" \
      'Transfer(address indexed,address indexed,uint256)' --json --rpc-url "$EVM_RPC" 2>/dev/null | python3 -c '
import json, sys
seen = []
for l in json.load(sys.stdin):
    for t in l["topics"][1:3]:
        a = "0x" + t[-40:]
        if a not in seen and int(a, 16) != 0:
            seen.append(a)
print("\n".join(seen))') || continue
    local a
    for a in $cands; do
      [ "$("$CAST" code "$a" --rpc-url "$EVM_RPC")" = 0x ] || continue
      if ge "$(usdc_units "$a")" "$need"; then echo "$a"; return 0; fi
    done
  done
  return 1
}

fork_fund() {
  check_chain
  [ -n "$FORK" ] || die "fork fund only runs against an anvil fork (EVM_RPC=$EVM_RPC is not one)"
  local who addr eth
  for who in deployer b z; do
    addr=$(addr_of "$who")
    case $who in
      deployer) eth=$DEPLOYER_ETH ;;
      b) eth=$B_ETH ;;
      z) eth=$Z_ETH ;;
    esac
    "$CAST" rpc anvil_setBalance "$addr" "$("$CAST" to-hex "$("$CAST" to-wei "$eth")")" --rpc-url "$EVM_RPC" >/dev/null
    log "fork: $who $addr has $eth ETH"
  done
  local b need holder
  b=$(addr_of b)
  need=${FORK_USDC_UNITS:-10000000}
  [ "$(usdc_units "$b")" -ge "$need" ] && { log "fork: B already holds $("$CAST" format-units "$(usdc_units "$b")" 6) USDC"; return 0; }
  holder=$(usdc_holder "$need") || die "found no account holding $need USDC units in recent Transfer logs"
  "$CAST" rpc anvil_impersonateAccount "$holder" --rpc-url "$EVM_RPC" >/dev/null
  "$CAST" rpc anvil_setBalance "$holder" 0xde0b6b3a7640000 --rpc-url "$EVM_RPC" >/dev/null
  # The fork reads the token's state from the public RPC as it goes, which can fail now and then.
  local try
  for try in 1 2 3; do
    "$CAST" send "$USDC" "transfer(address,uint256)" "$b" "$need" --from "$holder" --unlocked \
      --rpc-url "$EVM_RPC" >/dev/null && break
    [ "$try" -lt 3 ] || die "the USDC transfer from $holder failed"
    sleep 3
    [ "$(usdc_units "$b")" -lt "$need" ] || break
  done
  "$CAST" rpc anvil_stopImpersonatingAccount "$holder" --rpc-url "$EVM_RPC" >/dev/null
  log "fork: moved $("$CAST" format-units "$need" 6) of the real test USDC from holder $holder to B; B holds $("$CAST" format-units "$(usdc_units "$b")" 6) USDC"
}

fork_down() {
  stop_pid anvil
  log "stopped the fork"
}

fork_test() {
  [ "$STATE" != "$DEFAULT_STATE" ] || die "the fork rehearsal does not run in the real state directory"
  trap 'cmd_down; fork_down' EXIT
  # A fresh fork knows nothing of earlier rehearsals: keep the keys, drop their swaps.
  rm -rf "$STATE/z/evm-swaps" "$STATE/b/evm-swaps" "$STATE/zec-mock.json" "$STATE/ferrylock" "$STATE/deploy.tx"
  fork_up
  cmd_keys
  fork_fund
  echo
  cmd_status
  echo
  cmd_deploy
  cmd_up
  cmd_swap
  cmd_swap --refund
  cmd_swap --punish
  echo
  cmd_status
  log "fork rehearsal passed: deploy, a swap, a refund and a punish against the real test USDC on a Base Sepolia fork"
}

cmd_fork() {
  case "${1:-}" in
    up) fork_up ;;
    fund) need_foundry; fork_fund ;;
    test) need_foundry; fork_test ;;
    down) fork_down ;;
    *) die "usage: infra/evm-testnet.sh fork up|fund|test|down" ;;
  esac
}

FORK=
case "${1:-help}" in
  keys) cmd_keys ;;
  status) cmd_status ;;
  deploy) cmd_deploy ;;
  up) cmd_up ;;
  down) cmd_down ;;
  swap) cmd_swap "${2:-}" ;;
  fork) cmd_fork "${2:-}" ;;
  logs) tail -n 50 -f "$STATE/logs/${2:-z}.log" ;;
  help | -h | --help) usage ;;
  *) usage; exit 2 ;;
esac
