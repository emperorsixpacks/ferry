#!/usr/bin/env bash
# Rebuild the contracts and refresh the ABI + bytecode that crates/ferry-evm compiles in.
# crates/ferry-evm has a test that fails when these drift from a fresh `forge build`.
set -euo pipefail
cd "$(dirname "$0")"
forge build --force
dest=../crates/ferry-evm/artifacts
mkdir -p "$dest"
for c in FerryLock MockUSDC; do
  jq '{abi, bytecode: {object: .bytecode.object}, deployedBytecode: {object: .deployedBytecode.object}}' \
    "out/$c.sol/$c.json" > "$dest/$c.json"
done
echo "wrote $dest/{FerryLock,MockUSDC}.json"
