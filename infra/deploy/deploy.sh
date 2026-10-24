#!/usr/bin/env bash
# Deploy the Ferry testnet demo to one Linux host over SSH (Docker + compose on the host).
# Run `infra/deploy/deploy.sh help` for usage; docs/DEPLOY.md has the full walkthrough.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_DIR="${FERRY_REMOTE_DIR:-ferry}"
PROJECT="${FERRY_COMPOSE_PROJECT:-ferry}"
# docker compose through infra/deploy/compose, which passes the enabled pairs (COMPOSE_PROFILES in
# the host's .env) on to the web server; infra/deploy/ctl does the per-pair work on the host.
COMPOSE="FERRY_COMPOSE_PROJECT=$PROJECT infra/deploy/compose"
CTL="FERRY_COMPOSE_PROJECT=$PROJECT infra/deploy/ctl"
ALL_PROFILES="--profile ltc --profile usdc-base --profile weth-base"
LOCAL_TESTNET="${FERRY_TESTNET_DIR:-$ROOT/.testnet}"
LOCAL_SIGNET_RPC="${LOCAL_SIGNET_RPC:-http://127.0.0.1:38332}"

usage() {
  cat <<EOF
Usage: infra/deploy/deploy.sh <ssh-host> [command]

  up (default)     copy the repository (tracked and untracked files git doesn't ignore) to
                   <ssh-host>:~/$REMOTE_DIR, create what is missing there (infra/deploy/.env, the
                   node RPC passwords, the enabled pairs' Base Sepolia keys), build and start
                   everything, and stop the pairs that are no longer enabled
  status           containers, node sync, daemon balances and swaps, for every enabled pair
  logs [service]   follow logs (bitcoind, ferryd-z, ferryd-b, web, caddy; litecoind,
                   ferryd-{z,b}-ltc, ferryd-{z,b}-usdc-base, ferryd-{z,b}-weth-base; default: all)
  addresses        what to fund, where and how much: B's signet address and Z's Zcash testnet
                   address, then each enabled pair's addresses, amounts and faucets
  pairs            the optional pairs (ltc, usdc-base, weth-base) and which are enabled
  enable <pair>    add a pair to COMPOSE_PROFILES in the host's .env (then run \`up\`)
  disable <pair>   remove it (\`up\` then stops its containers; its volumes are kept)
  wrap-weth <ETH>  wrap Base Sepolia ETH into WETH in the WETH maker's account (WETH deposit())
  rotate-tokens    replace every daemon's API token (the web server picks them up)
  down             stop everything, every pair (volumes, so wallets and synced chains, are kept)
  migrate-wallets [--force]
                   owner only: move the wallets of a local infra/testnet.sh setup to the host
                   (copies .testnet/{z,b} into the ferryd volumes and imports the zoe/bram
                   bitcoind wallet descriptors), so already-funded addresses keep working

Set DOMAIN in ~/$REMOTE_DIR/infra/deploy/.env on the host before the first real start: Caddy
requests a TLS certificate for it. Environment: FERRY_REMOTE_DIR [$REMOTE_DIR].
EOF
}

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] error: %s\n' "$*" >&2; exit 1; }

[ $# -ge 1 ] || { usage; exit 2; }
case "$1" in help | -h | --help) usage; exit 0 ;; esac
HOST=$1
CMD=${2:-up}

remote() { ssh "$HOST" "cd $REMOTE_DIR && $*"; }
rcompose() { remote "$COMPOSE $*"; }
rctl() { remote "$CTL $*"; }

# GET a daemon's control API from inside its container (the API is not published; the token is
# read from its file there and never put on a command line).
api() { # api <z|b> <path>
  rcompose exec -T "ferryd-$1" ferry-api "$2"
}

# bitcoin-cli inside the bitcoind container, authenticated by its cookie file.
btc_cli() { # btc_cli [bitcoin-cli args...]
  rcompose exec -T bitcoind bitcoin-cli -signet -datadir=/home/bitcoin/.bitcoin -rpcport=38332 "$@"
}

sync_repo() {
  log "copying the repository to $HOST:~/$REMOTE_DIR"
  ssh "$HOST" "mkdir -p $REMOTE_DIR"
  # Whatever git ignores stays here (keys, local state, build outputs), plus some large
  # tracked directories the server doesn't need.
  rsync -az --delete \
    --filter=':- .gitignore' \
    --exclude .git --exclude target --exclude node_modules --exclude vendor \
    --exclude .demo --exclude .e2e-real --exclude .film-real --exclude .testnet \
    --exclude web/dist --exclude web/film --exclude web/screenshots --exclude spikes \
    --exclude docs/evidence \
    --exclude infra/deploy/.env --exclude infra/deploy/secrets \
    "$ROOT/" "$HOST:$REMOTE_DIR/"
}

ensure_env() {
  # Secrets are generated on the server and never leave it: on the first run .env and the node
  # RPC passwords, later only what is missing (a newly enabled pair's keys). Nothing existing is
  # overwritten (infra/deploy/ctl secrets).
  rctl secrets
  if remote 'grep -q "^DOMAIN=ferry.example.com$" infra/deploy/.env'; then
    die "set DOMAIN in $HOST:~/$REMOTE_DIR/infra/deploy/.env (DNS must point at the host), then run again"
  fi
}

cmd_up() {
  command -v rsync >/dev/null || die "rsync is required"
  sync_repo
  ensure_env
  log "building and starting (the first build compiles zcash-devtool: allow 20-40 minutes)"
  rcompose up -d --build
  rctl stop-disabled
  rcompose ps
  log "done. Follow the sync with: infra/deploy/deploy.sh $HOST status"
  log "what to fund: infra/deploy/deploy.sh $HOST addresses"
}

cmd_status() {
  rcompose ps
  btc_cli getblockchaininfo | python3 -c '
import json, sys
r = json.load(sys.stdin)
state = "synced" if not r["initialblockdownload"] and r["blocks"] == r["headers"] else "syncing"
print("signet node  %s: block %d of %d headers (%.2f%%)" % (state, r["blocks"], r["headers"], 100 * r["verificationprogress"]))' \
    || echo "signet node  not answering"
  for key in z b; do
    api "$key" /api/status | python3 -c '
import json, sys
s = json.load(sys.stdin)
b = s["balances"]
print("ferryd %s  %s: btc %d sat  zec %d zat  (zec %s height %d)"
      % (s["role"], s["name"], b["btc_sat"], b["zec_shielded_zat"], s["chains"]["zec"]["network"], s["chains"]["zec"]["height"]))' \
      || echo "ferryd $key  not answering"
    api "$key" /api/swaps | python3 -c '
import json, sys
for s in json.load(sys.stdin):
    print("  swap %s…  %-18s outcome %s" % (s["id"][:12], s["state"], s["outcome"]))' || true
  done
  echo
  rctl status
}

cmd_addresses() {
  for key in b z; do
    api "$key" /api/addresses | python3 -c '
import json, sys
a = json.load(sys.stdin)
btc, zec = a["btc"], a["zec"]["address"]
if a["role"] == "B":
    print("B (%s) holds the BTC. Send %s sats to:\n  %s" % (a["name"], btc["network"], btc["address"]))
else:
    print("Z (%s) holds the ZEC. Send testnet ZEC (TAZ) to:\n  %s" % (a["name"], zec or "(not available yet)"))
    print("  (Z is paid in %s BTC at %s)" % (btc["network"], btc["address"]))' \
      || echo "ferryd $key is not answering yet"
  done
  echo
  rctl addresses
}

cmd_rotate_tokens() {
  rctl rotate-tokens
}

local_rpc() { # local_rpc <wallet> <method> [json params]
  curl -sf --user ferry:ferry -H 'content-type: text/plain;' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"deploy\",\"method\":\"$2\",\"params\":${3:-[]}}" \
    "$LOCAL_SIGNET_RPC/wallet/$1"
}

cmd_migrate_wallets() {
  local force=${1:-}
  for key in z b; do
    [ -d "$LOCAL_TESTNET/$key" ] || die "no local $LOCAL_TESTNET/$key (this command moves the wallets of infra/testnet.sh)"
  done
  # Two live instances would act on the same keys and swap records.
  local running=
  for key in z b; do
    if [ -f "$LOCAL_TESTNET/$key.pid" ] && kill -0 "$(cat "$LOCAL_TESTNET/$key.pid")" 2>/dev/null; then
      running="$running $key"
    fi
  done
  if [ -n "$running" ]; then
    [ "$force" = --force ] || die "the local infra/testnet.sh daemons are running (${running# }). Stop them first: kill the pids in $LOCAL_TESTNET/{z,b}.pid, keeping the signet node up, or pass --force"
    log "WARNING: the local daemons are still running (${running# }); both copies will act on the same wallets"
  fi
  local tmp
  tmp=$(mktemp)
  chmod 600 "$tmp"
  trap 'rm -f "$tmp"' EXIT

  log "stopping the daemons on $HOST"
  rcompose stop ferryd-z ferryd-b web
  rcompose up -d bitcoind

  # 1. Data dirs: the zcash-devtool wallet, its age identity and any swap records. What the host
  #    had is kept in ~/$REMOTE_DIR-backups first.
  for key in z b; do
    local vol=${PROJECT}_ferryd-$key
    log "copying $LOCAL_TESTNET/$key into volume $vol"
    COPYFILE_DISABLE=1 tar -C "$LOCAL_TESTNET/$key" --exclude api-token --exclude ._\* -czf - . | ssh "$HOST" "
      set -e
      mkdir -p ~/$REMOTE_DIR-backups && chmod 700 ~/$REMOTE_DIR-backups
      docker volume create $vol >/dev/null
      docker run --rm -v $vol:/data -v \$HOME/$REMOTE_DIR-backups:/backup debian:bookworm-slim \
        tar -C /data -czf /backup/$vol-\$(date +%Y%m%d-%H%M%S).tgz .
      docker run --rm -i -v $vol:/data debian:bookworm-slim sh -c \
        'find /data -mindepth 1 -delete && tar -xz -C /data && chown -R 10001:10001 /data && chmod 700 /data'"
  done

  # 2. bitcoind wallets: same keys (descriptors), so addresses already shown or funded stay ours.
  for wallet in zoe bram; do
    if ! local_rpc "$wallet" getwalletinfo >/dev/null 2>&1; then
      log "local bitcoind wallet $wallet not reachable at $LOCAL_SIGNET_RPC; skipped (is infra/testnet.sh's node up?)"
      continue
    fi
    local_rpc "$wallet" listdescriptors '[true]' | python3 -c '
import json, sys
ds = json.load(sys.stdin)["result"]["descriptors"]
req = []
for d in ds:
    r = {"desc": d["desc"], "timestamp": d["timestamp"], "active": d["active"]}
    if "internal" in d: r["internal"] = d["internal"]
    if "range" in d: r["range"] = d["range"]
    if "next" in d: r["next_index"] = d["next"]
    req.append(r)
print(json.dumps(req))' >"$tmp"
    local label_addr
    label_addr=$(local_rpc "$wallet" getaddressesbylabel '["ferry-funding"]' \
      | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(min(r) if r else "")' 2>/dev/null || true)
    log "importing $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$tmp") descriptors into $wallet on $HOST"
    btc_cli -named createwallet wallet_name="$wallet" blank=true load_on_startup=true >/dev/null 2>&1 \
      || btc_cli loadwallet "$wallet" >/dev/null 2>&1 || true
    rcompose exec -T bitcoind bitcoin-cli -signet -datadir=/home/bitcoin/.bitcoin -rpcport=38332 \
      -rpcwallet="$wallet" -stdin importdescriptors <"$tmp" | python3 -c '
import json, sys
res = json.load(sys.stdin)
bad = [r for r in res if not r.get("success")]
print("  %d imported, %d failed%s" % (len(res) - len(bad), len(bad), (": " + json.dumps(bad[0].get("error"))) if bad else ""))'
    : >"$tmp"
    if [ -n "$label_addr" ]; then
      # ferryd shows the wallet's "ferry-funding" address: make it the migrated one only.
      for other in $(btc_cli -rpcwallet="$wallet" getaddressesbylabel ferry-funding 2>/dev/null \
        | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)))' 2>/dev/null); do
        [ "$other" = "$label_addr" ] || btc_cli -rpcwallet="$wallet" setlabel "$other" '""' >/dev/null
      done
      btc_cli -rpcwallet="$wallet" setlabel "$label_addr" ferry-funding >/dev/null && log "  funding address $label_addr kept"
    fi
  done

  log "starting the daemons"
  rcompose up -d
  log "done. Check with: infra/deploy/deploy.sh $HOST addresses"
  log "The host's previous ferryd volumes are backed up in $HOST:~/$REMOTE_DIR-backups/. They hold"
  log "wallet keys: copy them somewhere safe if you need them, then delete them there (rm -r ~/$REMOTE_DIR-backups)."
}

case "$CMD" in
  up) cmd_up ;;
  status) cmd_status ;;
  logs) rcompose logs -f --tail 100 ${3:-} ;;
  addresses) cmd_addresses ;;
  rotate-tokens) cmd_rotate_tokens ;;
  migrate-wallets) cmd_migrate_wallets "${3:-}" ;;
  pairs) rctl pairs ;;
  enable | disable)
    case "${3:-}" in
      ltc | usdc-base | weth-base) ;;
      *) die "usage: infra/deploy/deploy.sh <ssh-host> $CMD ltc|usdc-base|weth-base" ;;
    esac
    rctl "$CMD" "$3"
    log "next: infra/deploy/deploy.sh $HOST   (creates what the pair needs, starts or stops it)" ;;
  wrap-weth) rctl wrap-weth "${3:-}" ;;
  down)
    # shellcheck disable=SC2086 # several --profile flags
    rcompose $ALL_PROFILES down ;;
  *) usage; exit 2 ;;
esac
