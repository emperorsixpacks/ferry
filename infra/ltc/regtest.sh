#!/usr/bin/env bash
# Start/stop a throwaway regtest litecoind (Litecoin Core 0.21.5.6: Taproot + MWEB) in Docker.
# RPC: http://127.0.0.1:19443  user=ferry pass=ferry
#
# The image is pinned by digest: uphold/litecoin-core:0.21 resolved on 2026-10-19 to v0.21.5.6
# (multi-arch amd64/arm64).
set -euo pipefail
NAME=ferry-ltc-regtest
IMAGE=uphold/litecoin-core:0.21@sha256:46ebcaa617f66f3f35be4d7c2fe46bb07f037fd9f4482c4e1d1b044997d30b1c
PORT=${FERRY_LTC_RPC_PORT:-19443}
rpc() {
  curl -s --user ferry:ferry -H 'content-type: text/plain;' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"p\",\"method\":\"$1\",\"params\":${2:-[]}}" \
    "http://127.0.0.1:$PORT/${3:-}"
}
case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:19443" "$IMAGE" \
      -regtest -server -txindex -printtoconsole \
      -rpcuser=ferry -rpcpassword=ferry -rpcport=19443 \
      -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
      -fallbackfee=0.0002 >/dev/null
    up=
    for _ in $(seq 1 30); do
      if rpc getblockcount | grep -q '"error":null'; then up=1; break; fi
      sleep 1
    done
    if [ -z "$up" ]; then
      echo "litecoind did not come up"; docker logs --tail 30 "$NAME"; exit 1
    fi
    if [ -z "${FERRY_LTC_NO_MWEB:-}" ]; then
      # Activate MWEB as on mainnet. It locks in by BIP9 signalling at block 431; from then on
      # every block needs a HogEx, and the first HogEx needs a peg-in, so without this step
      # generatetoaddress fails past block 431 with "bad-txns-vin-empty".
      rpc createwallet '["ferry-ltc-miner"]' >/dev/null
      miner=$(rpc getnewaddress '["", "bech32"]' wallet/ferry-ltc-miner | sed -E 's/.*"result":"([^"]+)".*/\1/')
      rpc generatetoaddress "[431, \"$miner\"]" >/dev/null
      mweb=$(rpc getnewaddress '["", "mweb"]' wallet/ferry-ltc-miner | sed -E 's/.*"result":"([^"]+)".*/\1/')
      rpc sendtoaddress "[\"$mweb\", 1]" wallet/ferry-ltc-miner >/dev/null
      rpc generatetoaddress "[1, \"$miner\"]" >/dev/null
      if ! rpc getblockchaininfo | grep -q '"mweb":{"type":"bip9","bip9":{"status":"active"'; then
        echo "MWEB did not activate"; rpc getblockchaininfo; exit 1
      fi
      echo "MWEB active (height $(rpc getblockcount | sed -E 's/.*"result":([0-9]+).*/\1/'))"
    fi
    echo "litecoind regtest up on 127.0.0.1:$PORT"; exit 0 ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped" || echo "not running" ;;
  logs)
    docker logs --tail "${2:-50}" "$NAME" ;;
  rpc)
    # rpc <method> [json-params] [wallet/<name>]
    shift; rpc "$@"; echo ;;
  *)
    echo "usage: $0 start|stop|logs [n]|rpc <method> [json-params] [wallet/<name>]"; exit 2 ;;
esac
