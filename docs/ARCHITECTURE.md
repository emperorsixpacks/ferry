# Ferry architecture

```
ferry/
  Cargo.toml                 workspace
  crates/
    ferry-dleq/              cross-group DLEQ (Pallas SpendAuthG <-> secp256k1 G), Serai dleq 0.4.1
    ferry-btc/               Taproot lock/cancel scripts, tx templates, BIP340 adaptor sigs, bitcoind RPC
    ferry-zec/               joint Ironwood key (ak = ±(Z_p+B_p)), UFVK/UA, PCZT signer with raw ask,
                             wallet ops (drives zcash-devtool / zcash_client_* at devtool's pinned revs)
    ferry-core/              swap session: params, messages, state machine, timelock policy (no I/O)
    ferryd/                  daemon + CLI: runs one party (role Z or B), HTTP API for peer + UI,
                             chain watchers, persistence (one JSON file per swap)
  web/                       demo UI (two parties side by side + "what each chain sees")
  infra/                     docker: bitcoind regtest, Zebra regtest (NU6.3 at 1), Zaino
  docs/                      PROTOCOL.md, ARCHITECTURE.md, THREAT-MODEL.md, DEMO.md
  vendor/                    (gitignored) zcash-devtool, frost-tools checkouts
  spikes/                    day-0 go/no-go spikes, kept as evidence
```

## Roles

- **Z**: has shielded ZEC, wants BTC.
- **B**: has BTC, wants shielded ZEC.

Either role can be the maker. The maker runs `ferryd` with a public HTTP endpoint and an offer
(pair, rate, min/max). The taker's `ferryd` connects to it.

## Session messages (JSON, versioned)

| # | from | message | contents |
|---|---|---|---|
| 1 | taker→maker | `Propose` | session_id, role, amounts, T1, T2, fee rate, BTC key, Pallas+secp points, DLEQ proof, nonce, payout/refund addresses |
| 2 | maker→taker | `Accept` | same fields for the maker |
| 3 | B→Z | `LockTemplate` | unsigned lock txid/vout/amount (B's wallet funds it, not broadcast) |
| 4 | Z→B | `CancelSigs` | Z's sig on tx_cancel, Z's adaptor sig on tx_refund under B_s |
| 5 | B→Z | `CancelSig` | B's sig on tx_cancel |
| 6 | — | B broadcasts tx_lock | |
| 7 | — | Z sends ZEC to the joint address | |
| 8 | B→Z | `RedeemAdaptor` | B's adaptor sig on tx_redeem under Z_s (after N ZEC confirmations) |
| 9 | — | Z broadcasts tx_redeem; B extracts z and sweeps ZEC | |

Every message is checked against the session transcript hash; DLEQ proofs are bound to
`session_id/role`.

## State machines

```
B: Negotiated → LockBuilt → CancelSigned → BtcLocked → ZecSeen(n confs) → RedeemSigSent
     → BtcRedeemed(z extracted) → ZecSwept ✔
   timeouts: ≥T1 → Cancelled → Refunded(b revealed) ✔  |  T2 passes → Punished ✘

Z: Negotiated → CancelSigned → BtcLockSeen → ZecLocked → RedeemSigReceived → BtcRedeemed ✔
   timeouts: ≥T1 → Cancelled → (B refunds: b extracted) → ZecReclaimed ✔
                                 (no refund by T2) → Punished(BTC taken) ✔
```

## Demo environment

`infra/up.sh` starts bitcoind regtest, Zebra regtest (Ironwood active from block 1) and Zaino,
funds a ZEC wallet and a BTC wallet, and starts a block-producer loop. `ferryd` for each party runs
locally; the web UI talks to both daemons' HTTP APIs.
