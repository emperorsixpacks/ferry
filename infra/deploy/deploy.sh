#!/usr/bin/env bash
# Deploy the Ferry testnet demo to one Linux host over SSH (Docker + compose on the host).
# Run `infra/deploy/deploy.sh help` for usage; docs/DEPLOY.md has the full walkthrough.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_DIR="${FERRY_REMOTE_DIR:-ferry}"
PROJECT="${FERRY_COMPOSE_PROJECT:-ferry}"
COMPOSE="docker compose -p $PROJECT -f infra/deploy/docker-compose.yml --env-file infra/deploy/.env"
LOCAL_TESTNET="${FERRY_TESTNET_DIR:-$ROOT/.testnet}"
LOCAL_SIGNET_RPC="${LOCAL_SIGNET_RPC:-http://127.0.0.1:38332}"

usage() {
  cat <<EOF
Usage: infra/deploy/deploy.sh <ssh-host> [command]

  up (default)     copy the repository to <ssh-host>:~/$REMOTE_DIR, create infra/deploy/.env there on
                   first run (random RPC password and API tokens), then build and start everything
  status           containers, signet sync, daemon balances and swaps
  logs [service]   follow logs (bitcoind, ferryd-z, ferryd-b, web, caddy; default: all)
  addresses        where to send test coins (B's signet address, Z's Zcash testnet address)
  migrate-wallets  owner only: move the wallets of a local infra/testnet.sh setup to the host
                   (copies .testnet/{z,b} into the ferryd volumes and imports the zoe/bram
                   bitcoind wallet descriptors), so already-funded addresses keep working
  down             stop everything (volumes, so wallets and the synced chain, are kept)

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

# GET a daemon's control API from inside its container (the API is not published).
api() { # api <z|b> <path>
  local svc=ferryd-$1 port=7101
  [ "$1" = b ] && port=7102
  rcompose exec -T "$svc" sh -c "'curl -sf -H \"authorization: Bearer \$FERRY_TOKEN\" http://127.0.0.1:$port$2'"
}

btc_cli() { # btc_cli [bitcoin-cli args...]
  rcompose exec -T bitcoind sh -c "'bitcoin-cli -signet -rpcport=38332 -rpcuser=\"\$BTC_RPC_USER\" -rpcpassword=\"\$BTC_RPC_PASS\" $*'"
}

sync_repo() {
  log "copying the repository to $HOST:~/$REMOTE_DIR"
  ssh "$HOST" "mkdir -p $REMOTE_DIR"
  rsync -az --delete \
    --exclude .git --exclude target --exclude node_modules --exclude vendor \
    --exclude .demo --exclude .e2e-real --exclude .film-real --exclude .testnet \
    --exclude web/dist --exclude infra/deploy/.env \
    "$ROOT/" "$HOST:$REMOTE_DIR/"
}

ensure_env() {
  # First run: secrets are generated on the host and never leave it.
  remote '
    f=infra/deploy/.env
    if [ ! -f "$f" ]; then cp infra/deploy/.env.example "$f"; chmod 600 "$f"; fi
    for k in BTC_RPC_PASS FERRY_Z_TOKEN FERRY_B_TOKEN; do
      if grep -q "^$k=$" "$f"; then
        v=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n")
        umask 077; sed "s/^$k=$/$k=$v/" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      fi
    done'
  if remote 'grep -q "^DOMAIN=ferry.example.com$" infra/deploy/.env'; then
    die "set DOMAIN in $HOST:~/$REMOTE_DIR/infra/deploy/.env (DNS must point at the host), then run again"
  fi
}

cmd_up() {
  command -v rsync >/dev/null || die "rsync is required"
  sync_repo
  ensure_env
  log "building and starting (first build compiles zcash-devtool: allow 20-40 minutes)"
  rcompose up -d --build
  rcompose ps
  log "done. Follow the signet sync with: infra/deploy/deploy.sh $HOST status"
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
}

local_rpc() { # local_rpc <wallet> <method> [json params]
  curl -sf --user ferry:ferry -H 'content-type: text/plain;' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"deploy\",\"method\":\"$2\",\"params\":${3:-[]}}" \
    "$LOCAL_SIGNET_RPC/wallet/$1"
}

cmd_migrate_wallets() {
  for key in z b; do
    [ -d "$LOCAL_TESTNET/$key" ] || die "no local $LOCAL_TESTNET/$key (this command moves the wallets of infra/testnet.sh)"
  done
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
    local tmp
    tmp=$(mktemp)
    chmod 600 "$tmp"
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
    btc_cli "-named createwallet wallet_name=$wallet blank=true load_on_startup=true" >/dev/null 2>&1 \
      || btc_cli "loadwallet $wallet" >/dev/null 2>&1 || true
    remote "$COMPOSE exec -T bitcoind sh -c 'bitcoin-cli -signet -rpcport=38332 -rpcuser=\"\$BTC_RPC_USER\" -rpcpassword=\"\$BTC_RPC_PASS\" -rpcwallet=$wallet -stdin importdescriptors'" \
      <"$tmp" | python3 -c '
import json, sys
res = json.load(sys.stdin)
bad = [r for r in res if not r.get("success")]
print("  %d imported, %d failed%s" % (len(res) - len(bad), len(bad), (": " + json.dumps(bad[0].get("error"))) if bad else ""))'
    rm -f "$tmp"
    if [ -n "$label_addr" ]; then
      # ferryd shows the wallet's "ferry-funding" address: make it the migrated one only.
      for other in $(btc_cli "-rpcwallet=$wallet getaddressesbylabel ferry-funding" 2>/dev/null \
        | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)))' 2>/dev/null); do
        [ "$other" = "$label_addr" ] || btc_cli "-rpcwallet=$wallet setlabel $other \"\"" >/dev/null
      done
      btc_cli "-rpcwallet=$wallet setlabel $label_addr ferry-funding" >/dev/null && log "  funding address $label_addr kept"
    fi
  done

  log "starting the daemons"
  rcompose up -d
  log "done. Check with: infra/deploy/deploy.sh $HOST addresses"
}

case "$CMD" in
  up) cmd_up ;;
  status) cmd_status ;;
  logs) rcompose logs -f --tail 100 ${3:-} ;;
  addresses) cmd_addresses ;;
  migrate-wallets) cmd_migrate_wallets ;;
  down) rcompose down ;;
  *) usage; exit 2 ;;
esac
