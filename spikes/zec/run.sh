#!/usr/bin/env bash
# Ferry spike S3: sweep an Ironwood (NU6.3) note locked to a split spend key
# ask = a + b (ak = A + B) on a local Zebra + Zaino regtest.
#
# Usage: ./run.sh            # fresh chain, runs both ak sign cases (flip / no flip)
#        KEEP=1 ./run.sh     # leave the containers running afterwards
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
DT="$HERE/../../vendor/zcash-devtool/target/release/zcash-devtool"
JK="$HERE/jointkey/target/release/jointkey"
SRV=localhost:8137
DATA="$HERE/data"
HEIGHTS="$HERE/conf/activation_heights.toml"
ZEBRA_IMG=zfnd/zebra:7.0.0-rc.0
ZAINO_IMG=zingodevops/zaino:0.10.2-no-tls

log() { printf '\n== %s\n' "$*"; }
rpc() {
  curl -sf -u regtest:regtest -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" \
    http://127.0.0.1:18232
}
mine() { # <n>; generate can return a JSON error (HTTP 200) right after zebrad starts, so check the tip moved
  local target=$(($(height) + $1))
  while (($(height) < target)); do
    local n=$((target - $(height)))
    rpc generate "[$((n < 10 ? n : 10))]" >/dev/null || sleep 2
  done
}
height() { rpc getblockcount | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])'; }
dt() { "$DT" "$@" 2> >(grep -v -E 'WARN|INFO' >&2); }
account_uuid() { # <wallet dir> <account name>
  "$DT" wallet -w "$1" list-accounts 2>/dev/null | awk -v n="$2" '/^Account /{u=$2} $1=="Name:" && $2==n {print u}'
}
jq_key() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }

[[ -x "$DT" ]] || { echo "build zcash-devtool with --features regtest_support first" >&2; exit 1; }
[[ -x "$JK" ]] || (cd jointkey && cargo build --release)

log "0. clean slate"
docker rm -f ferry-zaino ferry-zebra >/dev/null 2>&1 || true
docker volume rm ferry-zebra-state >/dev/null 2>&1 || true
docker network create ferry-zec >/dev/null 2>&1 || true
docker volume create ferry-zebra-state >/dev/null
rm -rf "$DATA" && mkdir -p "$DATA"

start_zebra() { # <miner address>
  sed "s/MINER_ADDRESS/$1/" conf/zebrad.toml.tmpl >conf/zebrad.toml
  docker rm -f ferry-zebra >/dev/null 2>&1 || true
  docker run -d --name ferry-zebra --platform linux/amd64 --network ferry-zec \
    -p 127.0.0.1:18232:18232 -v ferry-zebra-state:/home/zebra/.cache/zebra \
    -v "$HERE/conf/zebrad.toml:/etc/zebrad/zebrad.toml:ro" \
    "$ZEBRA_IMG" zebrad -c /etc/zebrad/zebrad.toml start >/dev/null
  until rpc getblockcount >/dev/null 2>&1; do sleep 2; done
}

log "1a. Zebra regtest (placeholder t-addr miner) + Zaino"
# wallet init needs a live lightwalletd, and zebrad needs a miner address up front:
# start with a throwaway testnet t-addr, then restart with the funder's UA.
start_zebra tmWxWwf15vYpBNP82EJ2vNWSS5CaikXYbjb
mine 1
docker run -d --name ferry-zaino --platform linux/amd64 --network ferry-zec \
  -p 127.0.0.1:8137:8137 -v "$HERE/conf/zainod.toml:/app/config/zainod.toml:ro" \
  "$ZAINO_IMG" start -c /app/config/zainod.toml >/dev/null
until "$DT" wallet -w "$DATA/probe" init --name probe -i "$DATA/probe.age" -n regtest \
  --activation-heights "$HEIGHTS" -s $SRV >/dev/null 2>&1; do sleep 3; rm -rf "$DATA/probe"; done
rm -rf "$DATA/probe" "$DATA/probe.age"

log "1b. funder wallet; coinbase pays straight into Ironwood"
dt wallet -w "$DATA/funder" init --name funder -i "$DATA/funder.age" -n regtest --activation-heights "$HEIGHTS" -s $SRV
FUNDER_UA=$("$DT" wallet -w "$DATA/funder" list-addresses 2>/dev/null | awk '/Default Address/{print $3}')
start_zebra "$FUNDER_UA"
mine 105 # coinbase maturity is 100
dt wallet -w "$DATA/funder" sync -s $SRV >/dev/null
"$DT" wallet -w "$DATA/funder" balance 2>/dev/null | grep -E 'Balance|Ironwood Spendable'

log "1c. recipient wallet"
dt wallet -w "$DATA/recipient" init --name recipient -i "$DATA/recipient.age" -n regtest --activation-heights "$HEIGHTS" -s $SRV
RECIPIENT_UA=$("$DT" wallet -w "$DATA/recipient" list-addresses 2>/dev/null | awk '/Default Address/{print $3}')

sweep_case() { # <want_negated true|false> <value zats>
  local want=$1 value=$2 keys="$DATA/joint_$1.json" wd="$DATA/joint_$1"
  log "2. [$want] joint key: ask = a + b; need ak sign flip = $want"
  # ~50% of random (a, b) give A + B with ỹ = 1; resample until we hit the case under test.
  until "$JK" keygen "$keys" | grep "negated=$want" >/dev/null; do :; done
  local jua ufvk birthday
  jua=$(jq_key "$keys" ua)
  ufvk=$(jq_key "$keys" ufvk)
  echo "joint UA: $jua"

  log "3. [$want] fund joint address, import UFVK view-only, sync"
  birthday=$(height)
  dt wallet -w "$DATA/funder" send -i "$DATA/funder.age" --address "$jua" --value "$value" --memo ferry -s $SRV | tail -1
  mine 11 # untrusted (externally received) notes need 10 confirmations by default
  dt wallet -w "$wd" init --name scratch -i "$wd.age" -n regtest --activation-heights "$HEIGHTS" -s $SRV
  dt wallet -w "$wd" import-ufvk --name joint "$ufvk" "$birthday" -s $SRV
  dt wallet -w "$wd" sync -s $SRV >/dev/null
  local acct
  acct=$(account_uuid "$wd" joint)
  "$DT" wallet -w "$wd" balance "$acct" 2>/dev/null | grep -E 'Ironwood Spendable'

  log "4. [$want] PCZT create (view-only) -> prove | sign(a+b) -> combine -> send"
  dt pczt -w "$wd" create "$acct" --address "$RECIPIENT_UA" --value $((value - 10000)) --output "$wd.pczt"
  dt pczt -w "$wd" inspect "$wd.pczt"
  dt pczt -w "$wd" prove "$wd.pczt" --output "$wd.proven.pczt"
  "$JK" sign "$keys" "$wd.pczt" "$wd.signed.pczt"
  dt pczt -w "$wd" combine -i "$wd.proven.pczt" -i "$wd.signed.pczt" -o "$wd.final.pczt"
  local txid
  txid=$(dt pczt -w "$wd" send "$wd.final.pczt" -s $SRV | tail -1)
  echo "sweep txid: $txid"
  mine 1
  rpc getrawtransaction "[\"$txid\",1]" |
    python3 -c 'import json,sys;r=json.load(sys.stdin)["result"];print("mined at",r["height"],"tx v%d"%r["version"])'
}

sweep_case true 500000000
sweep_case false 300000000

log "5. recipient balance (expect 4.9999 + 2.9999 = 7.9998 REG)"
mine 3
dt wallet -w "$DATA/recipient" sync -s $SRV >/dev/null
"$DT" wallet -w "$DATA/recipient" balance 2>/dev/null | grep -E '^\s+Balance'
"$DT" wallet -w "$DATA/recipient" list-tx 2>/dev/null | grep -E '^[0-9a-f]{64}|Amount|Output'

[[ -n "${KEEP:-}" ]] || docker rm -f ferry-zaino ferry-zebra >/dev/null
log "GO"
