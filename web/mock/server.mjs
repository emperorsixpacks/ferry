// Mock ferryd pair for UI development and demos without chains.
//
// Implements docs/API.md for two parties in one process: Z on :7101 and B on :7102.
// Both daemons share one simulated world (a regtest-like Bitcoin chain, a Zcash chain with the
// Ironwood pool, and the swaps), and each party only reports its own view of it.
//
// The parties are small state machines that act on chain conditions, like the real daemon:
// confirmations, the T1/T2 relative timelocks and the peer's messages. POST /fault makes one
// party stop acting, which drives the cancel/refund and punish paths.
//
// Env: MOCK_SPEED (default 1, higher is faster), MOCK_Z_PORT, MOCK_B_PORT.

import http from "node:http";
import { randomBytes } from "node:crypto";

const SPEED = Number(process.env.MOCK_SPEED ?? 1) || 1;
const Z_PORT = Number(process.env.MOCK_Z_PORT ?? 7101);
const B_PORT = Number(process.env.MOCK_B_PORT ?? 7102);

const ms = (n) => n / SPEED;
const BTC_BLOCK_MS = ms(5000);
const BTC_FAST_BLOCK_MS = ms(1200); // see the clock below
const ZEC_BLOCK_MS = ms(3500);
const STEP_GAP_MS = ms(2000); // pause between off-chain protocol steps, so they can be read
const SWEEP_DELAY_MS = ms(8000); // B's random delay before sweeping, to avoid lining up with redeem

const T1 = 12;
const T2 = 24;
const DELTA = 3;
const BTC_CONFS = 2; // Z waits for this many confirmations of tx_lock
const ZEC_CONFS = 3; // B waits for this many confirmations of the lock note
const CANCEL_CONFS = 1;
const RATE = 410000; // sat per ZEC

// ---------------------------------------------------------------------------------------------
// world

const hex = (n) => randomBytes(n).toString("hex");
const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const bech = (n) => Array.from(randomBytes(n), (x) => BECH[x & 31]).join("");
const point = () => (Math.random() < 0.5 ? "02" : "03") + hex(32);
const now = () => Date.now();
const iso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const btcAmount = (sat) => (sat / 1e8).toFixed(4).replace(/0+$/, "").replace(/\.$/, "") + " BTC";
const zecAmount = (zat) => (zat / 1e8).toFixed(2) + " ZEC";

const chains = {
  btc: { network: "regtest", height: 412, txs: [], lastBlock: now() },
  zec: { network: "regtest", height: 233, pool: "ironwood", txs: [], lastBlock: now() },
};

const parties = {
  Z: { role: "Z", name: "zoe", port: Z_PORT, balances: { zec_shielded_zat: 500000000, btc_sat: 0 } },
  B: { role: "B", name: "bram", port: B_PORT, balances: { zec_shielded_zat: 0, btc_sat: 5000000 } },
};

const swaps = [];

function broadcast(chain, kind, swap) {
  const tx = { txid: hex(32), kind, swapId: swap.id, height: null };
  chains[chain].txs.push(tx);
  swap.tx[kind] = tx;
  return tx;
}

const confs = (chain, tx) => (tx && tx.height != null ? chains[chain].height - tx.height + 1 : 0);
const mined = (chain, tx) => confs(chain, tx) > 0;

function mine(chain) {
  const c = chains[chain];
  c.height += 1;
  c.lastBlock = now();
  for (const tx of c.txs) if (tx.height == null) tx.height = c.height;
  // fill in the heights of timeline entries whose tx just confirmed
  for (const s of swaps)
    for (const p of Object.values(s.views))
      for (const e of p.timeline) if (e.tx && e.height == null && e.tx.height != null) e.height = e.tx.height;
}

// ---------------------------------------------------------------------------------------------
// swaps

function newSwap(taker, makerUrl, zec_zat) {
  const btc_sat = Math.round((zec_zat / 1e8) * RATE);
  const pts = { Z: { p: hex(32), s: point() }, B: { p: hex(32), s: point() } };
  const s = {
    id: hex(16),
    taker,
    makerUrl,
    amounts: { zec_zat, btc_sat },
    keys: { pts, joint_ak: hex(32), sigma: Math.random() < 0.5 ? 1 : -1 },
    addresses: { btc_lock: "bcrt1p" + bech(58), zec_joint: "uregtest1" + bech(104) },
    tx: {},
    observer: { btc: [], zec: [] },
    views: {},
  };
  for (const role of ["Z", "B"]) {
    s.views[role] = {
      role,
      state: "Negotiated",
      outcome: null,
      timeline: [],
      secrets: { mine_revealed: false, peer_learned: false },
      stalled: false,
      flags: {},
      lastAction: now(),
    };
  }
  swaps.push(s);
  const z = s.views.Z;
  const b = s.views.B;
  log(s, z, "peer", "propose_sent", "Sent Propose to B: amounts, T1/T2, Pallas and secp256k1 points, DLEQ proof");
  log(s, b, "peer", "propose_received", "Received Z's Propose: " + zecAmount(zec_zat) + " for " + btcAmount(btc_sat));
  return s;
}

function log(s, view, chain, kind, label, tx = null) {
  view.timeline.push({ at: iso(), chain, kind, label, txid: tx ? tx.txid : null, height: tx ? tx.height : null, tx });
  view.lastAction = now();
}

const ready = (view) => now() - view.lastAction >= STEP_GAP_MS;

function lockHeight(s) {
  return s.tx.btc_lock?.height ?? null;
}

function cancelHeight(s) {
  return s.tx.cancel?.height ?? null;
}

// One protocol step for B (holds BTC, wants shielded ZEC). Returns after at most one action.
function stepB(s) {
  const v = s.views.B;
  const z = s.views.Z;
  const f = v.flags;
  const h = chains.btc.height;
  const lockH = lockHeight(s);

  // Chain observations happen even while stalled: the watcher keeps running, only actions stop.
  if (s.tx.punish && mined("btc", s.tx.punish) && v.state !== "Punished") {
    v.state = "Punished";
    v.outcome = "punished";
    log(s, v, "btc", "punish_seen", "Z claimed the locked BTC with tx_punish after T2. B never refunded", s.tx.punish);
    return;
  }
  if (s.tx.cancel && v.state !== "Cancelled" && !["Refunded", "Punished"].includes(v.state) && !f.cancelSeen) {
    f.cancelSeen = true;
    v.state = "Cancelled";
    if (f.cancelledByMe) return;
    log(s, v, "btc", "cancel_seen", "Saw Z broadcast tx_cancel after T1", s.tx.cancel);
    return;
  }
  if (v.stalled) return;
  if (!ready(v)) return;

  switch (v.state) {
    case "Negotiated":
      if (!f.accepted) {
        f.accepted = true;
        log(s, v, "local", "dleq_verified", "Verified Z's DLEQ proof: Z_p and Z_s share one discrete log");
        return;
      }
      if (!f.accSent) {
        f.accSent = true;
        log(s, v, "peer", "accept_sent", "Sent Accept with B's points and DLEQ proof. Derived the joint Ironwood address");
        return;
      }
      if (z.flags.dleq) {
        v.state = "LockBuilt";
        log(s, v, "peer", "lock_template_sent", "Built tx_lock from B's wallet (not broadcast) and sent the template");
      }
      return;
    case "LockBuilt":
      if (z.flags.cancelSigsSent) {
        v.state = "CancelSigned";
        log(s, v, "peer", "refund_adaptor_verified", "Checked Z's adaptor signature on tx_refund under B_s. Sent B's tx_cancel signature");
      }
      return;
    case "CancelSigned": {
      parties.B.balances.btc_sat -= s.amounts.btc_sat;
      const tx = broadcast("btc", "btc_lock", s);
      v.state = "BtcLocked";
      log(s, v, "btc", "btc_lock_broadcast", "Broadcast tx_lock: " + btcAmount(s.amounts.btc_sat) + " to the Taproot lock address", tx);
      s.observer.btc.push(`tx_lock: a P2TR output of ${btcAmount(s.amounts.btc_sat)}. Until it is spent it looks like any other Taproot payment.`);
      return;
    }
    case "BtcLocked": {
      const note = s.tx.zec_lock;
      if (note && mined("zec", note) && !f.noteSeen) {
        f.noteSeen = true;
        log(s, v, "zec", "zec_note_seen", "Found the lock note at the joint address with the shared viewing key", note);
        return;
      }
      if (note && confs("zec", note) >= ZEC_CONFS) {
        v.state = "ZecSeen";
        log(s, v, "zec", "zec_confirmed", `Lock note has ${ZEC_CONFS} confirmations and holds exactly ${zecAmount(s.amounts.zec_zat)}`);
        return;
      }
      if (lockH != null && h >= lockH + T1) return cancelB(s, v);
      return;
    }
    case "ZecSeen":
      // Never hand out the redeem signature after T1 − Δ; tx_cancel only becomes valid at T1.
      if (h >= lockH + T1) return cancelB(s, v);
      if (h >= lockH + T1 - DELTA) return;
      v.state = "RedeemSigSent";
      log(s, v, "peer", "redeem_adaptor_sent", "Sent Z an adaptor signature on tx_redeem, encrypted under Z_s");
      return;
    case "RedeemSigSent":
      if (s.tx.btc_redeem && mined("btc", s.tx.btc_redeem)) {
        v.state = "BtcRedeemed";
        v.secrets.peer_learned = true;
        f.sweepAt = now() + SWEEP_DELAY_MS;
        log(s, v, "btc", "secret_extracted", "Read z from Z's redeem signature in the tx_redeem witness (z = s − s′). B can now spend the joint Ironwood note", s.tx.btc_redeem);
        return;
      }
      if (lockH != null && h >= lockH + T1) return cancelB(s, v);
      return;
    case "BtcRedeemed":
      if (!s.tx.zec_sweep && now() >= f.sweepAt) {
        const tx = broadcast("zec", "zec_sweep", s);
        log(s, v, "zec", "zec_sweep_broadcast", "Swept the joint note to B's own shielded address, signing with ask = σ(z + b)", tx);
        s.observer.zec.push("Ironwood bundle: 2 actions. Only nullifiers, randomized keys (rk) and encrypted notes; nothing in it appears on Bitcoin.");
        return;
      }
      if (s.tx.zec_sweep && mined("zec", s.tx.zec_sweep)) {
        v.state = "ZecSwept";
        v.outcome = "swapped";
        parties.B.balances.zec_shielded_zat += s.amounts.zec_zat;
        log(s, v, "local", "swap_complete", "Swap complete. B holds " + zecAmount(s.amounts.zec_zat) + " in its own Ironwood notes");
      }
      return;
    case "Cancelled":
      if (!s.tx.refund && s.tx.cancel && confs("btc", s.tx.cancel) >= CANCEL_CONFS && cancelHeight(s) != null && h < cancelHeight(s) + T2 - DELTA) {
        const tx = broadcast("btc", "refund", s);
        v.secrets.mine_revealed = true;
        log(s, v, "btc", "refund_broadcast", "Broadcast tx_refund. Completing Z's adaptor signature puts b in the witness", tx);
        s.observer.btc.push("tx_refund: spends the cancel output by script path with two Schnorr signatures, paying B.");
        return;
      }
      if (s.tx.refund && mined("btc", s.tx.refund)) {
        v.state = "Refunded";
        v.outcome = "refunded";
        parties.B.balances.btc_sat += s.amounts.btc_sat;
        log(s, v, "local", "refunded", "BTC is back in B's wallet. Revealing b unlocks nothing for B");
      }
      return;
  }
}

function cancelB(s, v) {
  v.flags.cancelledByMe = true;
  v.flags.cancelSeen = true;
  v.state = "Cancelled";
  if (s.tx.cancel) return;
  const tx = broadcast("btc", "cancel", s);
  log(s, v, "btc", "cancel_broadcast", `T1 reached without a redeem. Broadcast the presigned tx_cancel`, tx);
  s.observer.btc.push(`tx_cancel: spends the lock output through its ${T1}-block CSV leaf into a new P2TR output.`);
}

// One protocol step for Z (holds shielded ZEC, wants BTC).
function stepZ(s) {
  const v = s.views.Z;
  const b = s.views.B;
  const f = v.flags;
  const h = chains.btc.height;
  const lockH = lockHeight(s);
  const cancelH = cancelHeight(s);

  if (v.stalled && f.resumeOnCancel && s.tx.cancel && mined("btc", s.tx.cancel)) {
    v.stalled = false;
    log(s, v, "local", "fault_cleared", "Z is back online and sees tx_cancel confirmed");
    return;
  }
  if (s.tx.cancel && !f.cancelSeen && !["BtcRedeemed", "Punished", "ZecReclaimed"].includes(v.state)) {
    f.cancelSeen = true;
    v.state = "Cancelled";
    if (!f.cancelledByMe && !v.stalled) log(s, v, "btc", "cancel_seen", "Saw B broadcast tx_cancel after T1. Waiting for B's refund", s.tx.cancel);
    return;
  }
  if (v.stalled) return;
  if (!ready(v)) return;

  switch (v.state) {
    case "Negotiated":
      if (!f.dleq && b.flags.accSent) {
        f.dleq = true;
        log(s, v, "local", "dleq_verified", "Verified B's DLEQ proof: B_p and B_s share one discrete log. Derived the joint Ironwood address");
        return;
      }
      if (f.dleq && b.state !== "Negotiated" && !f.cancelSigsSent) {
        f.cancelSigsSent = true;
        log(s, v, "peer", "cancel_sigs_sent", "Checked B's tx_lock template. Signed tx_cancel and sent an adaptor signature on tx_refund under B_s");
        return;
      }
      if (f.cancelSigsSent && b.state !== "LockBuilt" && b.state !== "Negotiated") {
        v.state = "CancelSigned";
        log(s, v, "peer", "cancel_sig_received", "Received B's tx_cancel signature. Both abort paths are now presigned");
      }
      return;
    case "CancelSigned":
      if (s.tx.btc_lock && confs("btc", s.tx.btc_lock) >= BTC_CONFS) {
        v.state = "BtcLockSeen";
        log(s, v, "btc", "btc_lock_seen", `tx_lock has ${BTC_CONFS} confirmations and pays the agreed Taproot address`);
      }
      return;
    case "BtcLockSeen": {
      parties.Z.balances.zec_shielded_zat -= s.amounts.zec_zat;
      const tx = broadcast("zec", "zec_lock", s);
      v.state = "ZecLocked";
      log(s, v, "zec", "zec_lock_broadcast", `Sent ${zecAmount(s.amounts.zec_zat)} from Z's Ironwood notes to the joint address`, tx);
      s.observer.zec.push("Ironwood bundle: 2 actions. Value, sender, receiver and memo are encrypted. valueBalance 0, so no amount leaves the pool.");
      return;
    }
    case "ZecLocked":
      if (b.state === "RedeemSigSent" || b.state === "BtcRedeemed" || b.state === "ZecSwept") {
        v.state = "RedeemSigReceived";
        log(s, v, "peer", "redeem_adaptor_received", "Received B's adaptor signature on tx_redeem and verified it under Z_s");
        return;
      }
      if (lockH != null && h >= lockH + T1) return cancelZ(s, v);
      return;
    case "RedeemSigReceived":
      if (!s.tx.btc_redeem && lockH != null && h < lockH + T1 - DELTA) {
        const tx = broadcast("btc", "btc_redeem", s);
        v.secrets.mine_revealed = true;
        log(s, v, "btc", "btc_redeem_broadcast", "Decrypted the adaptor with z, added Z's signature and broadcast tx_redeem", tx);
        s.observer.btc.push("tx_redeem: spends the lock output by script path, revealing one 2-of-2 leaf and two Schnorr signatures.");
        return;
      }
      if (s.tx.btc_redeem && mined("btc", s.tx.btc_redeem)) {
        v.state = "BtcRedeemed";
        v.outcome = "swapped";
        parties.Z.balances.btc_sat += s.amounts.btc_sat;
        log(s, v, "local", "swap_complete", `Swap complete. ${btcAmount(s.amounts.btc_sat)} is in Z's wallet`);
        return;
      }
      if (!s.tx.btc_redeem && lockH != null && h >= lockH + T1) return cancelZ(s, v);
      return;
    case "Cancelled": {
      const locked = !!s.tx.zec_lock;
      if (s.tx.refund && mined("btc", s.tx.refund) && !v.secrets.peer_learned) {
        v.secrets.peer_learned = true;
        log(s, v, "btc", "secret_extracted", locked
          ? "Read b from B's tx_refund witness. Z can now spend the joint note on its own"
          : "Read b from B's tx_refund witness. No ZEC was locked, so there is nothing to reclaim", s.tx.refund);
        if (!locked) v.outcome = "refunded";
        return;
      }
      if (locked && v.secrets.peer_learned && !s.tx.zec_reclaim) {
        const tx = broadcast("zec", "zec_reclaim", s);
        log(s, v, "zec", "zec_reclaim_broadcast", "Swept the joint note back to Z's own shielded address", tx);
        s.observer.zec.push("Ironwood bundle: 2 actions. Only nullifiers, randomized keys (rk) and encrypted notes; it looks like any other shielded spend.");
        return;
      }
      if (s.tx.zec_reclaim && mined("zec", s.tx.zec_reclaim)) {
        v.state = "ZecReclaimed";
        v.outcome = "refunded";
        parties.Z.balances.zec_shielded_zat += s.amounts.zec_zat;
        log(s, v, "local", "reclaimed", `${zecAmount(s.amounts.zec_zat)} is back in Z's own Ironwood notes`);
        return;
      }
      if (!s.tx.refund && !s.tx.punish && cancelH != null && h >= cancelH + T2) {
        const tx = broadcast("btc", "punish", s);
        log(s, v, "btc", "punish_broadcast", "T2 passed without a refund. Broadcast tx_punish to take the BTC", tx);
        s.observer.btc.push(`tx_punish: spends the cancel output through its ${T2}-block CSV leaf with one signature, paying Z.`);
        return;
      }
      if (s.tx.punish && mined("btc", s.tx.punish)) {
        v.state = "Punished";
        v.outcome = "punished";
        parties.Z.balances.btc_sat += s.amounts.btc_sat;
        log(s, v, "local", "punished", "Z holds the BTC. Z's ZEC stays in the joint note, which is B's penalty for not refunding");
      }
      return;
    }
  }
}

function cancelZ(s, v) {
  v.flags.cancelledByMe = true;
  v.flags.cancelSeen = true;
  v.state = "Cancelled";
  if (s.tx.cancel) return;
  const tx = broadcast("btc", "cancel", s);
  log(s, v, "btc", "cancel_broadcast", "T1 reached without B's redeem signature. Broadcast the presigned tx_cancel", tx);
  s.observer.btc.push(`tx_cancel: spends the lock output through its ${T1}-block CSV leaf into a new P2TR output.`);
}

function inject(s, role) {
  const v = s.views[role];
  const allowed = role === "Z"
    ? ["CancelSigned", "BtcLockSeen", "ZecLocked", "RedeemSigReceived"].includes(v.state) && !s.tx.btc_redeem
    : ["BtcLocked", "ZecSeen"].includes(v.state);
  if (v.stalled) return "already stalled";
  if (!allowed) return role === "Z" ? "Z can only stall between presigning and broadcasting tx_redeem" : "B can only stall after locking BTC and before sending the redeem signature";
  v.stalled = true;
  v.flags.resumeOnCancel = role === "Z";
  log(s, v, "local", "fault_injected", role === "Z"
    ? "Demo fault: Z stops responding until it sees tx_cancel"
    : "Demo fault: B stops responding and will not refund");
  return null;
}

// ---------------------------------------------------------------------------------------------
// views

function swapView(s, role) {
  const v = s.views[role];
  const peer = role === "Z" ? "B" : "Z";
  const { pts } = s.keys;
  return {
    id: s.id,
    role,
    counterparty: `http://127.0.0.1:${parties[peer].port}`,
    state: v.state,
    outcome: v.outcome,
    amounts: s.amounts,
    deadlines: { t1_blocks: T1, t2_blocks: T2, btc_lock_height: lockHeight(s), cancel_height: cancelHeight(s) },
    keys: {
      my_share_point_pallas: pts[role].p,
      my_share_point_secp: pts[role].s,
      peer_share_point_pallas: pts[peer].p,
      peer_share_point_secp: pts[peer].s,
      dleq_verified: role === "Z" ? !!v.flags.dleq : !!v.flags.accepted,
      joint_ak: s.keys.joint_ak,
      sigma: s.keys.sigma,
    },
    addresses: s.addresses,
    secrets: v.secrets,
    timeline: v.timeline.map(({ tx, ...e }) => e),
    observer: { btc: [...s.observer.btc], zec: [...s.observer.zec] },
  };
}

function statusView(role) {
  const p = parties[role];
  return {
    role,
    name: p.name,
    balances: { ...p.balances },
    chains: {
      btc: { network: chains.btc.network, height: chains.btc.height },
      zec: { network: chains.zec.network, height: chains.zec.height, pool: chains.zec.pool },
    },
    offer: { pair: "ZEC/BTC", rate_sat_per_zec: RATE, min_zat: 10000000, max_zat: 1000000000 },
  };
}

// ---------------------------------------------------------------------------------------------
// clock

setInterval(() => {
  // Once one party is stalled and the other has nothing left to do but wait out a timelock,
  // the block producer speeds up so the abort paths don't take minutes.
  const waiting = swaps.some((s) => {
    const [z, b] = [s.views.Z, s.views.B];
    const bWaits = z.stalled && (b.state === "RedeemSigSent" || (b.state === "BtcLocked" && !s.tx.zec_lock));
    const zWaits = b.stalled && (z.state === "ZecLocked" || z.state === "Cancelled");
    return bWaits || zWaits;
  });
  if (now() - chains.btc.lastBlock >= (waiting ? BTC_FAST_BLOCK_MS : BTC_BLOCK_MS)) mine("btc");
  if (now() - chains.zec.lastBlock >= ZEC_BLOCK_MS) mine("zec");
  for (const s of swaps) {
    if (s.views.Z.outcome && s.views.B.outcome) continue;
    stepB(s);
    stepZ(s);
  }
  for (const role of ["Z", "B"]) pushEvents(role);
}, 200);

// ---------------------------------------------------------------------------------------------
// http

const clients = { Z: new Set(), B: new Set() };

function pushEvents(role) {
  for (const c of clients[role]) {
    const status = JSON.stringify(statusView(role));
    if (status !== c.last.status) {
      c.last.status = status;
      c.res.write(`event: status\ndata: ${status}\n\n`);
    }
    for (const s of swaps) {
      const body = JSON.stringify(swapView(s, role));
      if (body !== c.last[s.id]) {
        c.last[s.id] = body;
        c.res.write(`event: swap\ndata: ${body}\n\n`);
      }
    }
  }
}

function send(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

function handler(role) {
  return async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (req.method === "OPTIONS") return send(res, 204, {});

    if (req.method === "GET" && path === "/api/status") return send(res, 200, statusView(role));

    if (req.method === "GET" && path === "/api/swaps") return send(res, 200, swaps.map((s) => swapView(s, role)));

    if (req.method === "POST" && path === "/api/swaps") {
      const body = await readBody(req);
      const zat = Number(body?.zec_zat);
      if (!body || !Number.isInteger(zat)) return send(res, 400, { error: "zec_zat must be an integer" });
      if (zat < 10000000 || zat > 1000000000) return send(res, 400, { error: "Amount must be between 0.1 and 10 ZEC" });
      if (swaps.some((s) => !(s.views.Z.outcome && s.views.B.outcome))) return send(res, 409, { error: "A swap is already in progress" });
      if (parties.Z.balances.zec_shielded_zat < zat) return send(res, 400, { error: "Z does not have enough shielded ZEC" });
      if (parties.B.balances.btc_sat < Math.round((zat / 1e8) * RATE)) return send(res, 400, { error: "B does not have enough BTC" });
      const s = newSwap(role, body.maker ?? null, zat);
      return send(res, 201, { id: s.id });
    }

    let m = path.match(/^\/api\/swaps\/([0-9a-f]+)$/);
    if (req.method === "GET" && m) {
      const s = swaps.find((x) => x.id === m[1]);
      return s ? send(res, 200, swapView(s, role)) : send(res, 404, { error: "no such swap" });
    }

    m = path.match(/^\/api\/swaps\/([0-9a-f]+)\/fault$/);
    if (req.method === "POST" && m) {
      const s = swaps.find((x) => x.id === m[1]);
      if (!s) return send(res, 404, { error: "no such swap" });
      const body = await readBody(req);
      if (body?.fault !== "stall") return send(res, 400, { error: "unknown fault" });
      const err = inject(s, role);
      return err ? send(res, 409, { error: err }) : send(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write(": connected\n\n");
      const c = { res, last: {} };
      clients[role].add(c);
      pushEvents(role);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients[role].delete(c);
      });
      return;
    }

    send(res, 404, { error: "not found" });
  };
}

for (const role of ["Z", "B"]) {
  const port = parties[role].port;
  http.createServer(handler(role)).listen(port, "127.0.0.1", () => {
    console.log(`mock ferryd ${role} (${parties[role].name}) on http://127.0.0.1:${port}  speed x${SPEED}`);
  });
}
