// Mock ferryd pair for UI development and demos without chains.
//
// Implements docs/API.md for two parties in one process: Z on :7101 and B on :7102.
// Both daemons share one simulated world (a regtest-like Bitcoin chain, a Zcash chain with the
// Ironwood pool, and the swaps), and each party only reports its own view of it. Either party can
// start a swap: POST /api/swaps on Z sells shielded ZEC to a B maker, on B buys it from a Z maker.
//
// The parties are small state machines that act on chain conditions, like the real daemon:
// confirmations, the T1/T2 relative timelocks and the peer's messages. POST /fault makes one
// party stop acting, which drives the cancel/refund and punish paths.
//
// Env: MOCK_SPEED (default 1, higher is faster), MOCK_Z_PORT, MOCK_B_PORT, MOCK_WALLET_LAG_MS,
// MOCK_BTC_NETWORK / MOCK_ZEC_NETWORK (labels only; the mock still mines fast).
//
// B serves the peer offers of a few mock B makers and Z those of a few Z makers (mock/makers.mjs)
// for the maker list, and their firm quotes (POST /peer/quote, signed like ferryd's;
// MOCK_QUOTE_SECS, default 45).
//
// MOCK_ROUTE_PORT (unset: none) also serves a mock ferry-route there, for private swaps: a route
// runs two of these swaps one after the other (mock/router.mjs).
//
// MOCK_NEAR_PORT (unset: none) also serves a mock of NEAR Intents' 1Click API there (mock/oneclick.mjs;
// MOCK_NEAR_SPEED, default MOCK_SPEED, paces its part).
// Z takes payout_to (features: "payout"; MOCK_PAYOUT=0 leaves it out, as an older ferryd): its
// redeem then pays into a 1Click deposit address, and the mock 1Click sees the deposit. What the
// mock 1Click delivers to a party's own address (GET /api/addresses) is credited to it in BTC.

import http from "node:http";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { MOCK_MAKERS, mockMakerAt, mockMakerByUrl } from "./makers.mjs";
import { mockRouter } from "./router.mjs";
import { mockOneClick } from "./oneclick.mjs";
import { bucketFor, marketOf, signingText } from "../server/quotes.mjs";

const SPEED = Number(process.env.MOCK_SPEED ?? 1) || 1;
const Z_PORT = Number(process.env.MOCK_Z_PORT ?? 7101);
const B_PORT = Number(process.env.MOCK_B_PORT ?? 7102);

const ms = (n) => n / SPEED;
const BTC_BLOCK_MS = ms(5000);
const BTC_FAST_BLOCK_MS = ms(1200); // see the clock below
const ZEC_BLOCK_MS = ms(3500);
const STEP_GAP_MS = ms(2000); // pause between off-chain protocol steps, so they can be read
const SWEEP_DELAY_MS = ms(8000);
// a real wallet shows incoming coins a sync after the outcome; MOCK_WALLET_LAG_MS imitates that
const WALLET_LAG_MS = Number(process.env.MOCK_WALLET_LAG_MS ?? 0); // B's random delay before sweeping, to avoid lining up with redeem

const T1 = 12;
const T2 = 24;
const DELTA = 3;
const BTC_CONFS = 2; // Z waits for this many confirmations of tx_lock
const ZEC_CONFS = 3; // B waits for this many confirmations of the lock note
const CANCEL_CONFS = 1;
const RATE = 410000; // sat per ZEC
const FEE_SAT = 2000; // per presigned BTC transaction, like ferryd's --fee-sat
const ZEC_FEE_RESERVE = 50_000; // what a real Z wallet keeps for the lock's fee (ferry-zec)
const LOCK_FEE_RESERVE = 10_000; // what ferryd's B keeps for its lock's own fee

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
  btc: { network: process.env.MOCK_BTC_NETWORK ?? "regtest", height: 412, txs: [], lastBlock: now() },
  zec: { network: process.env.MOCK_ZEC_NETWORK ?? "regtest", height: 233, pool: "ironwood", txs: [], lastBlock: now() },
};

const START = { Z: { zec_shielded_zat: 500000000, btc_sat: 0 }, B: { zec_shielded_zat: 0, btc_sat: 5000000 } };
const parties = {
  Z: { role: "Z", name: "zoe", port: Z_PORT, balances: { ...START.Z }, address: "bcrt1q" + bech(38) },
  B: { role: "B", name: "bram", port: B_PORT, balances: { ...START.B }, address: "bcrt1q" + bech(38) },
};

const swaps = [];

function credit(role, asset, amount) {
  const apply = () => (parties[role].balances[asset] += amount);
  if (WALLET_LAG_MS > 0) setTimeout(apply, WALLET_LAG_MS);
  else apply();
}
let refuseNextLock = false; // mock only: POST /api/_mock/refuse-next-lock

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

const makerOf = (makerUrl) => mockMakerByUrl(makerUrl, Z_PORT);
const rateOf = (makerUrl) => makerOf(makerUrl)?.rate ?? RATE;

// `taker` proposes ("Z" sells ZEC, "B" buys it); the other party is the maker. `rate`: a firm
// quote's, else the maker's offer. A route's swap (mock/router.mjs) carries its label (`route`), may
// be in another coin's units (`coin`: only BTC moves balances) and sweeps to Z (`sweepTo`).
function newSwap(taker, makerUrl, zec_zat, rate = rateOf(makerUrl), { route = null, coin = "btc", sweepTo = null, payoutTo = null } = {}) {
  const btc_sat = Math.round((zec_zat / 1e8) * rate);
  const pts = { Z: { p: hex(32), s: point() }, B: { p: hex(32), s: point() } };
  const s = {
    id: hex(16),
    taker,
    makerUrl,
    route,
    coin,
    sweepTo,
    payoutTo,
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
  const [t, m] = taker === "B" ? [s.views.B, s.views.Z] : [s.views.Z, s.views.B];
  log(s, t, "peer", "propose_sent", `Sent Propose to ${m.role}: amounts, T1/T2, Pallas and secp256k1 points, DLEQ proof`);
  log(s, m, "peer", "propose_received", `Received ${t.role}'s Propose: ` + zecAmount(zec_zat) + " for " + btcAmount(btc_sat));
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
    case "Negotiated": {
      // as maker B checks Z's proof and answers with Accept; as taker it checks Z's Accept
      const maker = s.taker !== "B";
      if (maker && !f.verified) {
        f.verified = true;
        log(s, v, "local", "dleq_verified", "Verified Z's DLEQ proof: Z_p and Z_s share one discrete log");
        return;
      }
      if (maker && !f.accSent) {
        f.accSent = true;
        log(s, v, "peer", "accept_sent", "Sent Accept with B's points and DLEQ proof. Derived the joint Ironwood address");
        return;
      }
      if (!maker && !f.verified) {
        if (!z.flags.accSent) return;
        f.verified = true;
        log(s, v, "local", "dleq_verified", "Verified Z's DLEQ proof: Z_p and Z_s share one discrete log. Derived the joint Ironwood address");
        return;
      }
      if (z.flags.verified) {
        v.state = "LockBuilt";
        log(s, v, "peer", "lock_template_sent", "Built tx_lock from B's wallet (not broadcast) and sent the template");
      }
      return;
    }
    case "LockBuilt":
      if (z.flags.cancelSigsSent) {
        v.state = "CancelSigned";
        log(s, v, "peer", "refund_adaptor_verified", "Checked Z's adaptor signature on tx_refund under B_s. Sent B's tx_cancel signature");
      }
      return;
    case "CancelSigned": {
      if (s.coin === "btc") parties.B.balances.btc_sat -= s.amounts.btc_sat;
      const tx = broadcast("btc", "btc_lock", s);
      v.state = "BtcLocked";
      log(s, v, "btc", "btc_lock_broadcast", "Broadcast tx_lock: " + btcAmount(s.amounts.btc_sat) + " to the Taproot lock address", tx);
      s.observer.btc.push(`tx_lock: a P2TR output of ${btcAmount(s.amounts.btc_sat)}. Until it is spent it looks like any single-key Taproot payment; its two script leaves stay hidden.`);
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
        log(s, v, "local", "sweep_delayed", `Waiting ${Math.round(SWEEP_DELAY_MS * SPEED / 1000)}s before sweeping, so the ZEC sweep does not line up with the Bitcoin transaction`);
        return;
      }
      if (lockH != null && h >= lockH + T1) return cancelB(s, v);
      return;
    case "BtcRedeemed":
      if (!s.tx.zec_sweep && now() >= f.sweepAt) {
        const tx = broadcast("zec", "zec_sweep", s);
        const to = s.sweepTo ? `the route's shielded address (${parties[s.sweepTo].name}'s wallet)` : "B's own shielded address";
        log(s, v, "zec", "zec_sweep_broadcast", `Swept the joint note to ${to}, signing with ask = σ(z + b)`, tx);
        s.observer.zec.push("Ironwood bundle: 2 actions. Only nullifiers, randomized keys (rk) and encrypted notes; nothing in it appears on Bitcoin.");
        return;
      }
      if (s.tx.zec_sweep && mined("zec", s.tx.zec_sweep)) {
        v.state = "ZecSwept";
        v.outcome = "swapped";
        credit(s.sweepTo ?? "B", "zec_shielded_zat", s.amounts.zec_zat);
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
        if (s.coin === "btc") credit("B", "btc_sat", s.amounts.btc_sat);
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
    // the watcher keeps running while stalled, as in ferryd
    if (!f.cancelledByMe) log(s, v, "btc", "cancel_seen", "Saw B broadcast tx_cancel after T1", s.tx.cancel);
    return;
  }
  if (v.stalled) return;
  if (!ready(v)) return;

  switch (v.state) {
    case "Negotiated": {
      // as maker Z checks B's proof and answers with Accept; as taker it checks B's Accept
      const maker = s.taker === "B";
      if (maker && !f.verified) {
        f.verified = true;
        log(s, v, "local", "dleq_verified", "Verified B's DLEQ proof: B_p and B_s share one discrete log");
        return;
      }
      if (maker && !f.accSent) {
        f.accSent = true;
        log(s, v, "peer", "accept_sent", "Sent Accept with Z's points and DLEQ proof. Derived the joint Ironwood address");
        return;
      }
      if (!maker && !f.verified && b.flags.accSent) {
        f.verified = true;
        log(s, v, "local", "dleq_verified", "Verified B's DLEQ proof: B_p and B_s share one discrete log. Derived the joint Ironwood address");
        return;
      }
      if (f.verified && b.state !== "Negotiated" && !f.cancelSigsSent) {
        f.cancelSigsSent = true;
        log(s, v, "peer", "cancel_sigs_sent", "Checked B's tx_lock template. Signed tx_cancel and sent an adaptor signature on tx_refund under B_s");
        return;
      }
      if (f.cancelSigsSent && b.state !== "LockBuilt" && b.state !== "Negotiated") {
        v.state = "CancelSigned";
        log(s, v, "peer", "cancel_sig_received", "Received B's tx_cancel signature. Both abort paths are now presigned");
      }
      return;
    }
    case "CancelSigned":
      if (s.tx.btc_lock && confs("btc", s.tx.btc_lock) >= BTC_CONFS) {
        v.state = "BtcLockSeen";
        log(s, v, "btc", "btc_lock_seen", `tx_lock has ${BTC_CONFS} confirmations and pays the agreed Taproot address`);
      }
      return;
    case "BtcLockSeen": {
      if (refuseNextLock) {
        // like ferryd when Z's wallet can't fund the lock from Ironwood notes only: nothing is sent
        refuseNextLock = false;
        v.state = "ZecLockRefused";
        f.refused = true;
        log(s, v, "local", "zec_lock_refused", "Z's wallet couldn't fund the lock from Ironwood notes only; nothing was sent");
        return;
      }
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
        s.observer.btc.push(`tx_redeem: key-path spend: one 64-byte Schnorr signature, no script and no second key revealed, paying ${btcAmount(s.amounts.btc_sat)} to a P2TR output. Indistinguishable from an ordinary single-key Taproot payment.`);
        return;
      }
      if (s.tx.btc_redeem && mined("btc", s.tx.btc_redeem)) {
        v.state = "BtcRedeemed";
        v.outcome = "swapped";
        if (s.payoutTo) {
          // payout_to: the redeem paid someone else (a NEAR Intents deposit address)
          near?.deposit(s.payoutTo, s.amounts.btc_sat - FEE_SAT);
          log(s, v, "local", "swap_complete", `Swap complete. ${btcAmount(s.amounts.btc_sat - FEE_SAT)} paid to ${s.payoutTo} (payout_to)`);
          return;
        }
        if (s.coin === "btc") credit("Z", "btc_sat", s.amounts.btc_sat - FEE_SAT);
        log(s, v, "local", "swap_complete", `Swap complete. ${btcAmount(s.amounts.btc_sat - FEE_SAT)} is in Z's wallet`);
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
        if (!locked) {
          v.outcome = "refunded";
          v.state = "Refunded";
        }
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
        credit("Z", "zec_shielded_zat", s.amounts.zec_zat);
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
        if (s.coin === "btc") credit("Z", "btc_sat", s.amounts.btc_sat);
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

// the mock 1Click (mock/oneclick.mjs), when MOCK_NEAR_PORT is set: what it delivers to a party's own
// BTC address, or refunds there, lands in that party's wallet
const PAYOUT = process.env.MOCK_PAYOUT !== "0";
const NEAR_PORT = process.env.MOCK_NEAR_PORT ? Number(process.env.MOCK_NEAR_PORT) : null;
const near = NEAR_PORT
  ? mockOneClick({
      speed: Number(process.env.MOCK_NEAR_SPEED ?? SPEED) || SPEED,
      onDeliver: ({ asset, address, amount }) => {
        if (asset !== "nep141:btc.omft.near") return;
        for (const role of ["Z", "B"]) if (parties[role].address === address) credit(role, "btc_sat", Number(amount));
      },
    })
  : null;

// the mock router (mock/router.mjs), when MOCK_ROUTE_PORT is set
const ROUTE_PORT = process.env.MOCK_ROUTE_PORT ? Number(process.env.MOCK_ROUTE_PORT) : null;
const router = ROUTE_PORT ? mockRouter({ swaps, newSwap: (...a) => newSwap(...a), chains, parties, inject: (s, role) => inject(s, role), makerOf, ms, speed: SPEED }) : null;

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
    taker: s.taker === role,
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
      dleq_verified: !!v.flags.verified,
      joint_ak: s.keys.joint_ak,
      sigma: s.keys.sigma,
    },
    addresses: s.addresses,
    secrets: v.secrets,
    timeline: v.timeline.map(({ tx, ...e }) => e),
    observer: { btc: [...s.observer.btc], zec: [...s.observer.zec] },
    // a route's swap: its label, as ferryd stores the one the router sends
    ...(s.route ? { route: s.route } : {}),
    ...(s.payoutTo && role === "Z" ? { payout_to: s.payoutTo } : {}),
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
    offer: { pair: "ZEC/BTC", rate_sat_per_zec: RATE, min_zat: 10000000, max_zat: 1000000000, fee_sat: FEE_SAT, t1_blocks: T1, t2_blocks: T2, btc_lock_confs: BTC_CONFS, zec_confs: ZEC_CONFS },
    features: PAYOUT ? ["route", "payout"] : ["route"],
  };
}

// GET /api/addresses: where to fund this party (its BTC address is fixed for the mock's lifetime)
function addressesView(role) {
  const p = parties[role];
  return { role, name: p.name, btc: { coin: "btc", network: chains.btc.network, address: p.address }, zec: { address: `u${chains.zec.network}1mockwallet${Buffer.from(p.name).toString("hex")}` } };
}

const STARTED = now();
// the tokens the mock's EVM partners name (Base Sepolia's addresses)
const MOCK_TOKENS = { usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", weth: "0x4200000000000000000000000000000000000006" };

// ferryd's GET /peer/offer for one mock maker. Live-rate makers refresh every 60 s, like
// --maker-price-feed; a paused one stopped refreshing before the mock started.
function peerOffer(m) {
  const t = Math.floor(now() / 1000);
  const up = Math.floor((now() - STARTED) / 1000);
  const updated = m.source === "fixed" ? undefined : m.paused ? Math.floor(STARTED / 1000) - m.ageS : t - ((m.ageS + up) % 60);
  // Bram and Zoe are the mock's real parties: their liquidity follows their balances
  const own =
    m.role === "Z"
      ? Math.max(0, parties.Z.balances.zec_shielded_zat - ZEC_FEE_RESERVE)
      : Math.max(0, Math.floor(((parties.B.balances.btc_sat - FEE_SAT) * 1e8) / m.rate));
  const liquidity = m.slug === null ? own : m.liquidity;
  // a private-swap partner (mock/makers.mjs ROUTE_MAKERS) says which coin it swaps, as ferryd does:
  // an ERC-20 on a local chain (anvil, so the operator's entry names the chain), or Litecoin
  const evm = m.counter === "usdc" || m.counter === "weth";
  const counter = evm
    ? { counter: "evm", token_symbol: m.counter.toUpperCase(), chain_id: 31337, token: MOCK_TOKENS[m.counter], network: "anvil" }
    : { ...(m.counter === "ltc" ? { coin: "ltc" } : {}), network: chains.btc.network };
  return {
    role: m.role,
    ...counter,
    making: !m.paused,
    paused: !!m.paused,
    rate_sat_per_zec: m.rate,
    min_zat: m.min,
    max_zat: m.max,
    terms: { t1: T1, t2: T2, ...(evm ? {} : { btc_fee: FEE_SAT }), btc_lock_confirmations: BTC_CONFS, zec_confirmations: ZEC_CONFS, cancel_confirmations: CANCEL_CONFS, redeem_margin: DELTA, refund_margin: DELTA, keypath: true },
    rate_source: m.source,
    ...(updated != null ? { rate_updated_at: updated } : {}),
    liquidity: { zec_zat: Math.min(liquidity, m.max) },
    quote_key: quoteKey(m).public,
    // a ferryd that can pay a taker's coin to a payout address (a NEAR Intents deposit address)
    ...(PAYOUT ? { features: ["payout"] } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// firm quotes, as ferryd's crate::quote: one key per mock maker, a quote per bucket, one swap each

const QUOTE_SECS = Number(process.env.MOCK_QUOTE_SECS ?? 45);
const keys = new Map();
const quotes = new Map(); // quote_id -> { q, maker, expires, used }
// a mock maker's own key: Bram and Zoe both have the slug null
const keyOf = (m) => `${m.role}:${m.slug}`;

function quoteKey(m) {
  if (!keys.has(keyOf(m))) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const der = publicKey.export({ format: "der", type: "spki" });
    const pt = der.subarray(der.length - 65); // 04 || x || y
    const compressed = Buffer.concat([Buffer.from([pt[64] & 1 ? 3 : 2]), pt.subarray(1, 33)]);
    keys.set(keyOf(m), { privateKey, public: compressed.toString("hex") });
  }
  return keys.get(keyOf(m));
}

const busy = () => swaps.some((s) => !(s.views.Z.outcome && s.views.B.outcome));

// POST /peer/quote {pair, taker_role, bucket_zat} for mock maker m: [status, body]
function peerQuote(m, body) {
  const b = bucketFor(Number(body?.bucket_zat));
  if (!b || b.bucket !== body.bucket_zat) return [400, { error: "firm quotes are asked for by bucket, not by amount" }];
  if (body.pair !== m.pair) return [400, { error: `this maker swaps ${m.pair}` }];
  // a B maker quotes Z takers (selling ZEC), a Z maker B takers (buying it)
  const taker = m.role === "Z" ? "B" : "Z";
  if (body.taker_role !== taker) return [400, { error: `this maker quotes takers with role ${taker}` }];
  if (m.paused) return [403, { error: "not making offers" }];
  if (busy()) return [409, { error: "busy with another swap; ask again when it is done" }];
  const offer = peerOffer(m);
  if (b.bucket < m.min || b.lower >= m.max) return [400, { error: "outside this maker's range" }];
  const min = Math.max(b.lower, m.min);
  const max = Math.min(b.bucket, m.max, offer.liquidity.zec_zat);
  if (max < min || (b.lower > 0 && max <= b.lower)) return [409, { error: "not enough liquidity for this bucket right now" }];
  const t = Math.floor(now() / 1000);
  const q = {
    v: 1,
    quote_id: hex(16),
    pair: m.pair,
    market: marketOf(offer),
    maker_role: m.role,
    taker_role: taker,
    rate_sat_per_zec: m.rate,
    min_zat: min,
    max_zat: max,
    issued_at: t,
    expires_at: t + QUOTE_SECS,
  };
  const sig = sign("sha256", Buffer.from(signingText(q)), { key: quoteKey(m).privateKey, dsaEncoding: "ieee-p1363" });
  quotes.set(q.quote_id, { q, maker: keyOf(m), expires: now() + QUOTE_SECS * 1000, used: false });
  return [200, { ...q, maker_key: quoteKey(m).public, sig: sig.toString("hex") }];
}

// A swap start that names a quote: its rate, or why the maker refuses it (as ferryd words it).
function honour(quote, maker, zat) {
  const e = quotes.get(quote?.quote_id);
  if (!e || e.maker !== keyOf(maker)) return { error: "The maker refused: unknown firm quote (it expired a while ago, or the maker restarted); get a new one" };
  if (e.used) return { error: "The maker refused: the firm quote was already used for another swap" };
  if (now() >= e.expires) return { error: "The maker refused: the firm quote expired; get a new one" };
  if (zat < e.q.min_zat || zat > e.q.max_zat) return { error: "the amount is outside the firm quote's range" };
  return { rate: e.q.rate_sat_per_zec, take: () => (e.used = true) };
}

// ---------------------------------------------------------------------------------------------
// clock

setInterval(() => {
  // Once one party is stalled and the other has nothing left to do but wait out a timelock,
  // the block producer speeds up so the abort paths don't take minutes.
  const waiting = swaps.some((s) => {
    const [z, b] = [s.views.Z, s.views.B];
    const bWaits = (z.stalled || z.flags.refused) && (b.state === "RedeemSigSent" || (b.state === "BtcLocked" && !s.tx.zec_lock));
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
  router?.tick();
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
    if (req.method === "GET" && path === "/api/addresses") return send(res, 200, addressesView(role));

    // the mock makers' public offers (ferryd's GET /peer/offer): B makers on B, Z makers on Z
    const maker = req.method === "GET" ? mockMakerAt(path, role) : undefined;
    if (maker === null) return send(res, 404, { error: "not found" });
    if (maker) return maker.offline ? send(res, 503, { error: "offline" }) : send(res, 200, peerOffer(maker));
    const quoting = req.method === "POST" ? mockMakerAt(path, role, "quote") : undefined;
    if (quoting === null) return send(res, 404, { error: "not found" });
    if (quoting) {
      if (quoting.offline) return send(res, 503, { error: "offline" });
      const [code, body] = peerQuote(quoting, await readBody(req));
      return send(res, code, body);
    }

    // mock only, for screenshot and film scripts: forget every swap and restore the starting
    // balances, so each story starts from the same wallet. Chains keep their heights.
    if (req.method === "POST" && path === "/api/_mock/refuse-next-lock") {
      refuseNextLock = true;
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/_mock/reset") {
      swaps.length = 0;
      router?.reset();
      for (const r of ["Z", "B"]) parties[r].balances = { ...START[r] };
      for (const r of ["Z", "B"]) for (const c of clients[r]) c.last = {};
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/api/swaps") return send(res, 200, swaps.map((s) => swapView(s, role)));

    if (req.method === "POST" && path === "/api/swaps") {
      const body = await readBody(req);
      const zat = Number(body?.zec_zat);
      if (!body || !Number.isInteger(zat)) return send(res, 400, { error: "zec_zat must be an integer" });
      // Z takes from a B maker (sells ZEC), B from a Z maker (buys it); ferryd's checks and words
      const maker = makerOf(body.maker) ?? MOCK_MAKERS.find((m) => m.role !== role);
      if (maker.offline) return send(res, 502, { error: "maker unreachable: connection refused" });
      if (maker.role === role) return send(res, 400, { error: `the counterparty also has role ${role}` });
      if (maker.paused) return send(res, 400, { error: "the counterparty is not making offers" });
      if (zat < maker.min || zat > maker.max) return send(res, 400, { error: `Amount must be between ${zecAmount(maker.min)} and ${zecAmount(maker.max)}` });
      if (swaps.some((s) => !(s.views.Z.outcome && s.views.B.outcome))) return send(res, 409, { error: "A swap is already in progress" });
      // a firm quote holds the swap to its rate
      const firm = body.quote ? honour(body.quote, maker, zat) : null;
      if (firm?.error) return send(res, 400, { error: firm.error });
      const rate = firm?.rate ?? maker.rate;
      const sat = Math.round((zat / 1e8) * rate);
      // ferryd's route and payout fields, with its words
      if (body.payout_to != null && (!PAYOUT || role !== "Z")) return send(res, 400, { error: PAYOUT ? "payout_to: only a Z taker (selling ZEC) is paid out" : "unknown field payout_to" });
      if (body.payout_to != null && (typeof body.payout_to !== "string" || !/^[A-Za-z0-9:._-]{8,128}$/.test(body.payout_to))) return send(res, 400, { error: "payout_to: not an address" });
      if (body.min_counter != null && role !== "Z") return send(res, 400, { error: "min_counter: only for role Z" });
      if (body.max_counter != null && role !== "B") return send(res, 400, { error: "max_counter: only for role B" });
      if (body.min_counter != null && sat < Number(body.min_counter)) return send(res, 400, { error: `The maker pays ${btcAmount(sat)} for ${zecAmount(zat)}, below your minimum of ${btcAmount(Number(body.min_counter))} (min_counter)` });
      if (body.max_counter != null && sat > Number(body.max_counter)) return send(res, 400, { error: `The maker asks ${btcAmount(sat)} for ${zecAmount(zat)}, above your limit of ${btcAmount(Number(body.max_counter))} (max_counter)` });
      const theirs = (msg) => (role === "Z" ? msg : `The maker refused: ${msg}`);
      const mine = (msg) => (role === "B" ? msg : `The maker refused: ${msg}`);
      const zHave = parties.Z.balances.zec_shielded_zat;
      if (zHave < zat + ZEC_FEE_RESERVE)
        return send(res, 400, { error: theirs(`Z does not have enough shielded ZEC: ${zHave} zat spendable in Ironwood, ${zat + ZEC_FEE_RESERVE} zat needed (the amount plus fees)`) });
      const bHave = parties.B.balances.btc_sat;
      if (bHave < sat + LOCK_FEE_RESERVE)
        return send(res, 400, { error: mine(`B does not have enough BTC: ${btcAmount(sat + LOCK_FEE_RESERVE)} needed (the amount plus about ${btcAmount(LOCK_FEE_RESERVE)} for the lock's fee), ${btcAmount(bHave)} in the wallet`) });
      firm?.take();
      const s = newSwap(role, body.maker ?? null, zat, rate, { payoutTo: body.payout_to ?? null });
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

if (NEAR_PORT) {
  http
    .createServer((req, res) =>
      near.handler(req, res, readBody).catch(() => {
        if (!res.headersSent) send(res, 500, { message: "internal error" });
      }),
    )
    .listen(NEAR_PORT, "127.0.0.1", () => console.log(`mock 1Click (NEAR Intents) on http://127.0.0.1:${NEAR_PORT}  key ${near.publicKey}`));
}

if (ROUTE_PORT) {
  http
    .createServer((req, res) =>
      router.handler(req, res, readBody).catch(() => {
        if (!res.headersSent) send(res, 500, { error: "internal error" });
      }),
    )
    .listen(ROUTE_PORT, "127.0.0.1", () => console.log(`mock ferry-route on http://127.0.0.1:${ROUTE_PORT}`));
}
