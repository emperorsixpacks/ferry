#!/usr/bin/env bash
# The local demo as ZEC <-> LTC: infra/demo.sh against a litecoind regtest node (container
# ferry-litecoind, RPC 127.0.0.1:19643; MWEB is activated on startup). Same commands and
# environment as infra/demo.sh; `infra/demo-ltc.sh help` lists them.
set -euo pipefail
CHAIN=ltc exec "$(dirname "${BASH_SOURCE[0]}")/demo.sh" "$@"
