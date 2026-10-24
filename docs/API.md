# ferryd HTTP API (v0)

Each party runs one `ferryd`. The demo UI talks to two of them (Z on :7101, B on :7102).
All responses are JSON. Amounts: `zat` (ZEC zatoshis) and `sat` (BTC satoshis), as integers.

## GET /api/status

```json
{
  "role": "Z",                      // "Z" holds ZEC, "B" holds BTC
  "name": "zoe",
  "balances": { "zec_shielded_zat": 500000000, "btc_sat": 0 },
  "chains": {
    "btc": { "network": "regtest", "height": 412 },
    "zec": { "network": "regtest", "height": 233, "pool": "ironwood" }
  },
  "offer": { "pair": "ZEC/BTC", "rate_sat_per_zec": 410000, "min_zat": 10000000, "max_zat": 1000000000 }
}
```

## POST /api/swaps

Start a swap as taker against a maker.

```json
{ "maker": "http://127.0.0.1:7102", "zec_zat": 100000000 }
```
→ `201 { "id": "f3c1…" }`

## GET /api/swaps  → `[SwapView]`
## GET /api/swaps/:id → `SwapView`

```json
{
  "id": "f3c1…",
  "role": "Z",
  "counterparty": "http://127.0.0.1:7102",
  "state": "ZecLocked",             // see state list below
  "outcome": null,                  // null | "swapped" | "refunded" | "punished"
  "amounts": { "zec_zat": 100000000, "btc_sat": 410000 },
  "deadlines": { "t1_blocks": 12, "t2_blocks": 24, "btc_lock_height": 405, "cancel_height": null },
  "keys": {
    "my_share_point_pallas": "hex", "my_share_point_secp": "hex",
    "peer_share_point_pallas": "hex", "peer_share_point_secp": "hex",
    "dleq_verified": true,
    "joint_ak": "hex", "sigma": 1
  },
  "addresses": { "btc_lock": "bcrt1p…", "zec_joint": "uregtest1…" },
  "secrets": { "mine_revealed": false, "peer_learned": false },
  "timeline": [
    { "at": "2026-10-16T13:05:01Z", "chain": "local|btc|zec|peer", "kind": "dleq_verified|btc_lock_broadcast|zec_note_seen|redeem_adaptor_received|btc_redeemed|secret_extracted|zec_swept|cancel_broadcast|refund_broadcast|punish_broadcast|…",
      "label": "Human-readable sentence", "txid": "hex|null", "height": 407 }
  ],
  "observer": {
    "btc": ["Taproot output 0.0041 BTC (2 script leaves, internal key unspendable)", "…"],
    "zec": ["Ironwood action (amount, sender, receiver encrypted)", "…"]
  }
}
```

`observer` lists what a public chain observer can see for this swap, one line per transaction.
It is what the UI's "what each chain sees" panel renders.

## GET /api/events (Server-Sent Events)

`event: swap` with a `SwapView` body on every state change; `event: status` with the status body
whenever a balance or height changes.

## POST /api/swaps/:id/fault (demo only)

`{ "fault": "stall" }` makes this party stop acting, to demonstrate cancel/refund/punish paths.

## States

B: `Negotiated → LockBuilt → CancelSigned → BtcLocked → ZecSeen → RedeemSigSent → BtcRedeemed → ZecSwept`
   or `→ Cancelled → Refunded` / `→ Punished`

Z: `Negotiated → CancelSigned → BtcLockSeen → ZecLocked → RedeemSigReceived → BtcRedeemed`
   or `→ Cancelled → ZecReclaimed` / `→ Punished`
