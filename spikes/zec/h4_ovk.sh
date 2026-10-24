#!/usr/bin/env bash
# Audit H4 A/B test: can the counterparty (a second wallet holding the joint UFVK) see where a
# sweep of the joint note went? Sweeps once with devtool's default OVK policy (Sender = the
# joint account's OVK) and once with `pczt create-max --discard-ovk`, then lets the observer
# wallet sync + enhance (full tx download, so OVK decryption is attempted) and reads what it
# recovered.
#
# Needs a running regtest with a funded wallet: by default the devtool demo
# (ZEC_BACKEND=devtool infra/demo.sh up) and its miner wallet.
#   FUNDER=<wallet dir> FUNDER_ID=<age file> OUT=<scratch dir> ./h4_ovk.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DT="$HERE/../../vendor/zcash-devtool/target/release/zcash-devtool"
JK="$HERE/jointkey/target/release/jointkey"
SRV=${SRV:-localhost:8137}
RPC=${RPC:-http://127.0.0.1:18232}
DEMO="${FERRY_DEMO_DIR:-$HERE/../../.demo}"
FUNDER=${FUNDER:-$DEMO/zec/miner}
FUNDER_ID=${FUNDER_ID:-$DEMO/zec/miner.age}
HEIGHTS=${HEIGHTS:-$DEMO/zec/activation_heights.toml}
OUT=${OUT:-$HERE/data/h4}

rpc() { curl -sf -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"; }
height() { rpc getblockcount | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])'; }
mine() { local t=$(($(height) + $1)); while (($(height) < t)); do rpc generate '[1]' >/dev/null || sleep 1; done; }
dt() { RUST_LOG=error NO_COLOR=1 "$DT" "$@"; }
key() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }
acct() { dt wallet -w "$1" list-accounts | awk '/^Account /{u=$2} $1=="Name:" && $2=="joint" {print u}'; }

rm -rf "$OUT" && mkdir -p "$OUT"
dt wallet -w "$OUT/recipient" init --name r -i "$OUT/r.age" -n regtest --activation-heights "$HEIGHTS" -s $SRV >/dev/null
RECIPIENT=$(dt wallet -w "$OUT/recipient" list-addresses | awk '/Default Address/{print $3; exit}')

run_case() { # <label> [extra create-max flags]
  local label=$1 extra=${2:-} dir="$OUT/$1"
  mkdir -p "$dir"
  "$JK" keygen "$dir/keys.json" >/dev/null
  local birthday ufvk
  birthday=$(height)
  ufvk=$(key "$dir/keys.json" ufvk)
  dt wallet -w "$FUNDER" sync -s $SRV >/dev/null
  dt wallet -w "$FUNDER" send -i "$FUNDER_ID" --address "$(key "$dir/keys.json" ua)" --value 100000000 -s $SRV >/dev/null
  mine 11
  for w in sweeper observer; do
    dt wallet -w "$dir/$w" init --name scratch -i "$dir/$w.age" -n regtest --activation-heights "$HEIGHTS" -s $SRV >/dev/null
    dt wallet -w "$dir/$w" import-ufvk --name joint "$ufvk" "$birthday" -s $SRV >/dev/null
    dt wallet -w "$dir/$w" sync -s $SRV >/dev/null
  done
  local a
  a=$(acct "$dir/sweeper")
  # shellcheck disable=SC2086
  dt pczt -w "$dir/sweeper" create-max "$a" --address "$RECIPIENT" $extra --output "$dir/c.pczt"
  dt pczt -w "$dir/sweeper" prove "$dir/c.pczt" --output "$dir/p.pczt"
  "$JK" sign "$dir/keys.json" "$dir/c.pczt" "$dir/s.pczt" >/dev/null
  dt pczt -w "$dir/sweeper" combine -i "$dir/p.pczt" -i "$dir/s.pczt" -o "$dir/f.pczt"
  local txid
  txid=$(dt pczt -w "$dir/sweeper" send "$dir/f.pczt" -s $SRV | tail -1)
  mine 2
  dt wallet -w "$dir/observer" sync -s $SRV >/dev/null
  dt wallet -w "$dir/observer" enhance -s $SRV >/dev/null
  local internal
  internal=$(python3 -c "print(bytes.fromhex('$txid')[::-1].hex().upper())")
  local seen
  seen=$(sqlite3 "$dir/observer/data.sqlite" "SELECT group_concat(s.value || ' zat -> ' || coalesce(s.to_address, '(address unknown)'), '; ')
    FROM sent_notes s JOIN transactions t ON t.id_tx = s.transaction_id WHERE hex(t.txid) = '$internal'")
  echo "[$label] sweep $txid; observer recovers: ${seen:-nothing}"
}

run_case sender-ovk
run_case discard-ovk --discard-ovk
echo "recipient was $RECIPIENT"
