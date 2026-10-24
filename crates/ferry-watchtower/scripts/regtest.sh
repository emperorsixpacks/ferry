#!/usr/bin/env bash
# Throwaway regtest bitcoind for the watchtower's regtest tests (no -txindex, like a pruned
# node: the tower follows the swap through its watch-only wallet).
# RPC: http://127.0.0.1:18943  user=ferry pass=ferry
# Then: cargo test -p ferry-watchtower --test regtest -- --ignored --test-threads=1
set -euo pipefail
NAME=ferry-wt-regtest
IMAGE=bitcoin/bitcoin:28.1
PORT=18943
case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:18443" "$IMAGE" \
      -regtest -server -printtoconsole \
      -rpcuser=ferry -rpcpassword=ferry \
      -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
      -fallbackfee=0.0002 >/dev/null
    for _ in $(seq 1 30); do
      if curl -s --user ferry:ferry -H 'content-type: text/plain;' \
        --data-binary '{"jsonrpc":"1.0","id":"p","method":"getblockcount","params":[]}' \
        "http://127.0.0.1:$PORT/" | grep -q '"error":null'; then
        echo "bitcoind regtest up on 127.0.0.1:$PORT"; exit 0
      fi
      sleep 1
    done
    echo "bitcoind did not come up"; docker logs --tail 30 "$NAME"; exit 1 ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped" || echo "not running" ;;
  *)
    echo "usage: $0 start|stop"; exit 2 ;;
esac
