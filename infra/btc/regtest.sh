#!/usr/bin/env bash
# Start/stop a throwaway regtest bitcoind in Docker for the regtest tests (crates/*/tests).
# RPC: http://127.0.0.1:18543  user=ferry pass=ferry
set -euo pipefail
NAME=ferry-btc-regtest
IMAGE=bitcoin/bitcoin:28.1
case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p 127.0.0.1:18543:18443 "$IMAGE" \
      -regtest -server -txindex -printtoconsole \
      -rpcuser=ferry -rpcpassword=ferry \
      -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
      -fallbackfee=0.0002 >/dev/null
    for _ in $(seq 1 30); do
      if curl -s --user ferry:ferry -H 'content-type: text/plain;' \
        --data-binary '{"jsonrpc":"1.0","id":"p","method":"getblockcount","params":[]}' \
        http://127.0.0.1:18543/ | grep -q '"error":null'; then
        echo "bitcoind regtest up on 127.0.0.1:18543"; exit 0
      fi
      sleep 1
    done
    echo "bitcoind did not come up"; docker logs --tail 30 "$NAME"; exit 1 ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped" || echo "not running" ;;
  logs)
    docker logs --tail "${2:-50}" "$NAME" ;;
  *)
    echo "usage: $0 start|stop|logs [n]"; exit 2 ;;
esac
