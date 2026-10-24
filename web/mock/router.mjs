// A mock ferry-route (crates/ferry-route) for the node mock (mock/server.mjs): the same HTTP API
// and RouteView, over the mock's own swaps, so the private-swap UI can be built and tested without
// real daemons.
//
// A route (coin A → shielded ZEC → coin C) runs two of the mock world's swaps one after the other.
// The mock has one B party (bram) and one Z party (zoe); they stand in for the user's B daemon of
// every "from" pair and Z daemon of every "to" pair:
//   leg 1   bram buys ZEC from a Z maker (a real mock swap, labelled "<id>/1"); its sweep pays zoe
//   settle  the sweep needs 10 confirmations, then zoe must be able to spend the second amount
//   pause   the privacy pause, drawn once (MOCK_ROUTE_PAUSE_SCALE shrinks it: 1/60 makes Standard's
//           5–30 min 5–30 s)
//   leg 2   zoe sells the ZEC to a B maker (a mock swap labelled "<id>/2"), retried for a while if
//           the partner refuses or pays less than the minimum, else the route holds the ZEC
// Coins other than BTC run on the mock's one chain in that coin's units and move no balances.
//
// A route may name payout_to (a NEAR Intents deposit address, which the UI server makes): swap 2 then
// pays its coin there, and the mock 1Click sees the deposit, as with ferryd's payout_to.
//
// Env: MOCK_ROUTE_LEGS ["btc:b,usdc-base:b,btc:z,usdc-base:z,ltc:z"] the daemons it has (pair:role),
// MOCK_ROUTE_PAUSE_SCALE [1/60], MOCK_ROUTE_WINDOW_SECS [120] how long leg 2 is tried (at speed 1).
// Mock only: POST /api/_mock/fault {"leg2": "refund"} makes the next second swap stall once its
// ZEC is locked, so it is called off and refunded and the route holds the ZEC ("Finish now", i.e.
// POST /api/routes/:id/continue, then completes it); POST /api/_mock/reset forgets every route.

import { randomBytes } from "node:crypto";

const UNITS = { btc: { ticker: "BTC", decimals: 8 }, ltc: { ticker: "LTC", decimals: 8 }, usdc: { ticker: "USDC", decimals: 6 }, weth: { ticker: "WETH", decimals: 18 } };
const unitOf = (pair) => UNITS[pair.split("-")[0]] ?? { ticker: pair.toUpperCase(), decimals: 8 };
const assetOf = (pair) => pair.split("-")[0];
const NEEDED_CONFS = 10;
const SWEEP_FEE = 10_000;
const LOCK_RESERVE = 50_000;
const FIELDS = ["from", "to", "zec_zat", "maker1", "maker2", "max_in", "min_out", "delay_secs", "keep_bps", "payout_to"];

export function unitsStr(n, u) {
  const s = (n / 10 ** u.decimals).toFixed(Math.min(u.decimals, 8)).replace(/0+$/, "").replace(/\.$/, "");
  return u.ticker ? `${s} ${u.ticker}` : s;
}
const zecStr = (zat) => unitsStr(zat, { ticker: "ZEC", decimals: 8 });
function duration(s) {
  if (s < 90) return "1 minute";
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h} h` : m === 60 ? `${h + 1} h` : `${h} h ${m} min`;
}
const inAbout = (s) => (s < 60 ? "in less than a minute" : `in about ${duration(s)}`);

// `world`: the mock's swaps and parties (mock/server.mjs)
export function mockRouter(world, env = process.env) {
  // `capacity(role)`: the party's {free_slots, ...} as ferryd's GET /api/status says it
  const { swaps, newSwap, chains, parties, inject, makerOf, ms, capacity = () => ({ free_slots: 1 }) } = world;
  const legs = (env.MOCK_ROUTE_LEGS ?? "btc:b,usdc-base:b,btc:z,usdc-base:z,ltc:z")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [pair, role] = s.split(":");
      return { pair, role: (role ?? "").toUpperCase() };
    });
  const pauseScale = Number(env.MOCK_ROUTE_PAUSE_SCALE ?? 1 / 60);
  const windowMs = ms(Number(env.MOCK_ROUTE_WINDOW_SECS ?? 120) * 1000);
  const retryMs = ms(6000);
  const routes = new Map();
  let fault = null; // "refund": the next second swap stalls once its ZEC is locked
  const now = () => Date.now();
  const secs = (t = now()) => Math.floor(t / 1000);
  const iso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const has = (pair, role) => legs.some((l) => l.pair === pair && l.role === role);
  const swapOf = (id) => swaps.find((s) => s.id === id) ?? null;
  // the daemon of a leg runs as many swaps as it takes at once (ferryd's 409 "busy"): asked again
  const full = (role) => capacity(role).free_slots === 0;
  const display = (m) => m?.name ?? m?.url ?? "your partner";
  const walletOf = (role) => parties[role].name;
  const zecWallet = () => `your wallet "${walletOf("Z")}"`;
  const label = (r, n) => (n === 1 ? `${r.id}/1` : r.leg2_gen <= 1 ? `${r.id}/2` : `${r.id}/2-${r.leg2_gen}`);
  const outMin = (r) => Math.ceil((r.min_out * r.zec2_zat) / Math.max(1, r.min_out_basis_zat));
  const isFinal = (r) => r.phase === "done" || r.phase === "failed";
  const isActive = (r) => !isFinal(r) && r.phase !== "holding";

  function log(r, kind, text) {
    r.timeline.push({ at: iso(), kind, label: text });
  }

  function hold(r, why) {
    r.phase = "holding";
    r.outcome = "holding_zec";
    r.starting.inflight = false;
    const text = `${why}. You hold about ${unitsStr(r.held_zat, { ticker: "", decimals: 8 })} shielded ZEC in ${zecWallet()}.`;
    log(r, "holding", text);
    r.reason = text;
  }
  function fail(r, outcome, why) {
    r.phase = "failed";
    r.outcome = outcome;
    log(r, "failed", why);
    r.reason = why;
  }
  function done(r, why) {
    r.phase = "done";
    r.outcome = "swapped";
    log(r, "done", why);
    r.reason = why;
  }

  function snapshot(leg, s, role) {
    const v = s.views[role];
    leg.state = v.state;
    leg.outcome = v.outcome;
    leg.zec_zat = s.amounts.zec_zat;
    leg.counter_units = s.amounts.btc_sat;
  }

  // Start leg n now: the mock's POST /api/swaps checks, as ferryd and the maker would answer.
  function start(r, n) {
    const leg = r.legs[n - 1];
    const maker = n === 1 ? r.maker1 : r.maker2[r.starting.maker_idx % r.maker2.length];
    leg.maker = maker;
    leg.label = label(r, n);
    if (r.starting.attempts === 0)
      log(
        r,
        `leg${n}_starting`,
        n === 1
          ? `Starting swap 1 of 2 with ${display(maker)}: your ${leg.unit.ticker} for ${zecStr(r.zec_zat)}`
          : `Starting swap 2 of 2 with ${display(maker)}: ${zecStr(r.zec2_zat)} for your ${leg.unit.ticker}`,
      );
    r.starting.attempts += 1;
    const m = makerOf(maker.url);
    const zat = n === 1 ? r.zec_zat : r.zec2_zat;
    let refusal = null;
    let busy = false;
    if (!m || m.offline) refusal = "maker unreachable: connection refused";
    else if (m.role === leg.role) refusal = `the counterparty also has role ${leg.role}`;
    else if (m.paused) refusal = "The maker refused: not making offers";
    else if (zat < m.min || zat > m.max) refusal = `Amount must be between ${zecStr(m.min)} and ${zecStr(m.max)}`;
    else if (full(leg.role)) {
      refusal = "Busy: this node already runs as many swaps as it takes at once (--max-swaps); try again once one of them finishes";
      busy = true;
    }
    const counter = m ? Math.round((zat / 1e8) * m.rate) : 0;
    if (!refusal && n === 1 && counter > r.max_in) refusal = `The maker asks ${unitsStr(counter, leg.unit)}, more than your limit of ${unitsStr(r.max_in, leg.unit)}`;
    if (!refusal && n === 2 && counter < outMin(r)) refusal = `The maker pays ${unitsStr(counter, leg.unit)}, less than your minimum of ${unitsStr(outMin(r), leg.unit)}`;
    if (!refusal && n === 2 && parties.Z.balances.zec_shielded_zat < zat + LOCK_RESERVE) refusal = "Z does not have enough shielded ZEC";

    if (refusal) {
      if (n === 1) {
        if (busy && now() < r.starting.window_ends) {
          r.starting.next_at = now() + retryMs;
          r.problem = `Your ${r.from} daemon is running as many swaps as it takes at once; trying again`;
          return;
        }
        return fail(r, "not_started", `Swap 1 with ${display(maker)} didn't start: ${refusal}. Nothing moved.`);
      }
      if (r.starting.last_error !== refusal) log(r, "leg2_refused", `Swap 2 with ${display(maker)} didn't start: ${refusal}. Your ZEC stays put; trying again.`);
      r.starting.last_error = refusal;
      r.problem = `Swap 2 with ${display(maker)} didn't start: ${refusal}`;
      r.starting.next_at = now() + retryMs;
      r.starting.maker_idx += 1;
      return;
    }
    // swap 2 of a route that ends on NEAR Intents pays its coin into the deposit address (payout_to)
    const s = newSwap(leg.role, maker.url, zat, m.rate, { route: leg.label, coin: assetOf(leg.pair), sweepTo: n === 1 ? "Z" : undefined, payoutTo: n === 2 ? r.payout_to : null });
    r.problem = null;
    leg.swap_id = s.id;
    r.phase = n === 1 ? "leg1" : "leg2";
    log(r, `leg${n}_started`, `Swap ${n} of 2 started with ${display(maker)}`);
    snapshot(leg, s, leg.role);
  }

  function step(r) {
    const t = now();
    if (r.phase === "leg1_starting") {
      if (r.stop_requested) return fail(r, "not_started", "You stopped the route before anything moved.");
      if (t >= r.starting.next_at) start(r, 1);
      return;
    }
    if (r.phase === "leg1" || r.phase === "settling") {
      const s = swapOf(r.legs[0].swap_id);
      if (!s) return;
      const v = s.views.B;
      snapshot(r.legs[0], s, "B");
      if (v.outcome === "refunded")
        return fail(r, "refunded", `Swap 1 was called off and refunded: your ${r.legs[0].unit.ticker} is back in your wallet, minus network fees. Swap 2 never started.`);
      if (v.outcome === "punished")
        return fail(r, "punished", `Swap 1 failed and your ${r.legs[0].unit.ticker} was lost: it was not refunded before the deadline, so the partner took it as the penalty. Swap 2 never started.`);
      if (r.phase === "leg1") {
        if (v.outcome !== "swapped" && v.state !== "BtcRedeemed") return;
        r.phase = "settling";
        r.held_zat = Math.max(0, r.zec_zat - SWEEP_FEE);
        log(r, "leg1_swapped", `Swap 1 is done: about ${zecStr(r.held_zat)} is on its way to ${zecWallet()}`);
        if (r.stop_requested) return hold(r, "You stopped the route before swap 2");
      }
      const sweep = s.tx.zec_sweep;
      if (sweep) {
        r.zec.sweep_txid = sweep.txid;
        r.zec.sweep_height = sweep.height;
        r.zec.sweep_confs = sweep.height != null ? chains.zec.height - sweep.height + 1 : 0;
      }
      r.zec.spendable_zat = parties.Z.balances.zec_shielded_zat;
      if (v.outcome !== "swapped" || r.zec.sweep_confs < NEEDED_CONFS) return;
      if (r.zec.spendable_zat < r.zec2_zat + LOCK_RESERVE) return;
      if (r.not_before == null) {
        const [lo, hi] = r.delay_secs;
        r.not_before = secs(t + (lo + Math.random() * (hi - lo)) * pauseScale * 1000 / world.speed);
      }
      r.phase = "pausing";
      const wait = Math.max(0, r.not_before - secs(t));
      log(r, "zec_spendable", wait === 0 ? `Your ZEC is in ${zecWallet()} and can be spent` : `Your ZEC is in ${zecWallet()} and can be spent. Privacy pause: swap 2 starts ${inAbout(wait)}`);
      return;
    }
    if (r.phase === "pausing") {
      if (secs(t) >= (r.not_before ?? 0)) enterLeg2(r);
      return;
    }
    if (r.phase === "leg2_starting") {
      if (r.stop_requested) return hold(r, "You stopped the route before swap 2");
      if (t >= r.starting.window_ends && r.starting.attempts > 0) {
        const mins = Math.round(Number(env.MOCK_ROUTE_WINDOW_SECS ?? 120) / 60) || 1;
        const last = r.starting.last_error;
        return hold(r, `No partner took your ZEC at your price within ${mins} minutes${last ? ` (last answer: ${last})` : ""}`);
      }
      if (t >= r.starting.next_at) start(r, 2);
      return;
    }
    if (r.phase === "leg2") {
      const s = swapOf(r.legs[1].swap_id);
      if (!s) return;
      const v = s.views.Z;
      if (r.fault === "refund" && v.state === "ZecLocked" && !v.stalled) {
        inject(s, "Z");
        r.fault = "used";
      }
      snapshot(r.legs[1], s, "Z");
      const got = unitsStr(s.amounts.btc_sat, r.legs[1].unit);
      if (v.outcome === "swapped") return done(r, `Done: you received ${got}.`);
      if (v.outcome === "punished") return done(r, `Done: your partner vanished after locking, so you claimed their ${got} as the penalty.`);
      if (v.outcome === "refunded") {
        if (v.state === "ZecReclaimed") {
          r.held_zat = Math.max(0, r.held_zat - 2 * SWEEP_FEE);
          r.zec2_zat = Math.max(1, r.zec2_zat - 2 * SWEEP_FEE);
        }
        return hold(r, "Swap 2 was called off and refunded");
      }
    }
  }

  function enterLeg2(r) {
    r.phase = "leg2_starting";
    r.starting = { next_at: now(), window_ends: now() + windowMs, attempts: 0, maker_idx: 0, last_error: null };
    r.legs[1].label = label(r, 2);
    if (fault) {
      r.fault = fault;
      fault = null;
    }
  }

  function note(r) {
    const [a, c] = [r.legs[0].unit.ticker, r.legs[1].unit.ticker];
    const stopping = r.stop_requested ? " You asked to stop: swap 2 won't run, and you keep the ZEC." : "";
    const maker2 = r.legs[1].maker ?? r.maker2[r.starting.maker_idx % Math.max(1, r.maker2.length)];
    switch (r.phase) {
      case "leg1_starting":
        return `Starting swap 1 of 2: your ${a} for ${zecStr(r.zec_zat)} with ${display(r.maker1)}.${stopping}`;
      case "leg1":
        return `Swap 1 of 2: buying ${zecStr(r.zec_zat)} with your ${a} from ${display(r.maker1)}. Then it is sold for ${c}.${stopping}`;
      case "settling":
        if (r.legs[0].outcome !== "swapped") return `Swap 1 is done. Your ZEC is on its way to ${zecWallet()}.`;
        if (r.zec.sweep_confs < NEEDED_CONFS) return `Your ZEC is in ${zecWallet()}: ${r.zec.sweep_confs} of ${NEEDED_CONFS} confirmations before it can be spent.`;
        return `Your ZEC is in ${zecWallet()}; waiting for the wallet to show ${zecStr(r.zec2_zat + LOCK_RESERVE)} as spendable.`;
      case "pausing":
        return `Your ZEC is in ${zecWallet()}. Privacy pause: selling it for ${c} ${inAbout(Math.max(0, (r.not_before ?? 0) - secs()))}.`;
      case "leg2_starting":
        return `Your ZEC is in ${zecWallet()}. Looking for a partner to sell ${zecStr(r.zec2_zat)} for at least ${unitsStr(outMin(r), r.legs[1].unit)}.${r.starting.last_error ? ` Last answer: ${r.starting.last_error}.` : ""}${stopping}`;
      case "leg2":
        return `Swap 2 of 2: selling ${zecStr(r.zec2_zat)} for ${c} with ${display(maker2)}. If it can't finish, its refund returns your ZEC to ${zecWallet()}.`;
      default:
        return r.reason ?? "";
    }
  }

  const STATE = { leg1_starting: "leg1", leg1: "leg1", settling: "settling", pausing: "pausing", leg2_starting: "leg2", leg2: "leg2", done: "done", holding: "holding", failed: "failed" };

  function view(r) {
    return {
      id: r.id,
      from: r.from,
      to: r.to,
      state: STATE[r.phase],
      phase: r.phase,
      outcome: r.outcome,
      amounts: { in_max: r.max_in, zec_zat: r.zec_zat, zec2_zat: r.zec2_zat, out_min: outMin(r), keep_zat: 0 },
      privacy: { delay_secs: r.delay_secs, not_before: r.not_before },
      zec: { sweep_txid: r.zec.sweep_txid, sweep_confs: r.zec.sweep_confs, needed_confs: NEEDED_CONFS, spendable_zat: r.zec.spendable_zat, need_zat: r.zec2_zat + LOCK_RESERVE, held_zat: r.held_zat },
      legs: r.legs.map((l, i) => ({
        n: i + 1,
        pair: l.pair,
        role: l.role,
        unit: l.unit,
        wallet: l.wallet,
        maker: l.maker ? display(l.maker) : null,
        maker_url: l.maker?.url ?? null,
        label: l.label,
        swap_id: l.swap_id,
        state: l.state,
        outcome: l.outcome,
        zec_zat: l.zec_zat,
        counter_units: l.counter_units,
        watchtower: null,
        earlier_swaps: l.earlier,
      })),
      payout_to: r.payout_to ?? null,
      timeline: r.timeline,
      note: note(r),
      problem: r.problem,
      stop_requested: r.stop_requested,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  const makerArg = (v) => {
    const url = typeof v === "string" ? v : typeof v?.url === "string" ? v.url : null;
    if (!url || !/^https?:\/\/[^/]+/.test(url)) return null;
    return { url: url.trim().replace(/\/+$/, ""), name: typeof v?.name === "string" && v.name.trim() ? v.name.trim() : undefined };
  };
  const samePartner = (a, b) => (!!a.name && a.name.toLowerCase() === b.name?.toLowerCase()) || a.url === b.url;

  // POST /api/routes: [status, body]
  function create(body) {
    if (!body || typeof body !== "object") return [400, { error: "bad request body: expected an object" }];
    const unknown = Object.keys(body).find((k) => !FIELDS.includes(k));
    if (unknown) return [400, { error: `bad request body: unknown field \`${unknown}\`` }];
    const from = String(body.from ?? "").trim().toLowerCase();
    const to = String(body.to ?? "").trim().toLowerCase();
    if (!has(from, "B")) return [400, { error: `no ${from} daemon with role B is configured (--leg ${from}:b=URL)` }];
    if (!has(to, "Z")) return [400, { error: `no ${to} daemon with role Z is configured (--leg ${to}:z=URL)` }];
    if (assetOf(from) === assetOf(to)) return [400, { error: `${from} → ${to} swaps an asset for itself: the amounts in and out would match and link the two legs` }];
    const maker1 = makerArg(body.maker1);
    const maker2 = Array.isArray(body.maker2) ? body.maker2.map(makerArg) : [];
    if (!maker1 || maker2.some((m) => !m)) return [400, { error: "a maker is not an http(s) maker URL" }];
    if (!maker2.length || maker2.length > 8) return [400, { error: "maker2 must list 1 to 8 partners" }];
    const same = maker2.find((m) => samePartner(m, maker1));
    if (same) return [400, { error: `${display(same)} can't take both swaps: the same partner on both legs could link them` }];
    const pos = (v) => Number.isInteger(v) && v > 0;
    if (!pos(body.zec_zat) || !pos(body.max_in) || !pos(body.min_out)) return [400, { error: "zec_zat, max_in and min_out must be positive" }];
    // ferry-route's checks: an address of letters and digits, and swap 2's daemon must take it
    const payoutTo = body.payout_to == null ? null : String(body.payout_to).trim();
    if (payoutTo != null && (!payoutTo || payoutTo.length > 128 || !/^[A-Za-z0-9]+$/.test(payoutTo))) return [400, { error: "payout_to must be an address (ASCII letters and digits)" }];
    if (payoutTo != null && world.payout === false) return [400, { error: `the ${to} daemon does not take payout_to (its /api/status lacks features: ["payout"]); it would pay its own wallet instead` }];
    const delay = body.delay_secs ?? [300, 1800];
    if (!Array.isArray(delay) || delay.length !== 2 || !(delay[0] <= delay[1]) || delay[1] > 86_400) return [400, { error: "delay_secs must be [min, max] with min ≤ max ≤ 86400" }];
    if ([...routes.values()].some((r) => isActive(r) && (r.from === from || r.to === to))) return [409, { error: "Another route is already using one of these daemons" }];
    const zec2 = body.zec_zat - SWEEP_FEE - LOCK_RESERVE;
    if (zec2 <= 0) return [400, { error: `${zecStr(body.zec_zat)} is too little to route: ${SWEEP_FEE + LOCK_RESERVE} zat of it pay the sweep fee and leg 2's lock reserve` }];
    const t = now();
    const leg = (pair, role) => ({ pair, role, unit: unitOf(pair), wallet: walletOf(role), maker: null, label: null, swap_id: null, state: null, outcome: null, zec_zat: null, counter_units: null, earlier: [] });
    const r = {
      id: "r" + randomBytes(8).toString("hex"),
      created_at: secs(t),
      updated_at: secs(t),
      from,
      to,
      zec_zat: body.zec_zat,
      zec2_zat: zec2,
      held_zat: 0,
      max_in: body.max_in,
      min_out: body.min_out,
      min_out_basis_zat: zec2,
      delay_secs: delay,
      payout_to: payoutTo,
      not_before: null,
      maker1,
      maker2,
      phase: "leg1_starting",
      outcome: null,
      legs: [leg(from, "B"), leg(to, "Z")],
      leg2_gen: 1,
      starting: { next_at: t, window_ends: t + ms(300_000), attempts: 0, maker_idx: 0, last_error: null },
      zec: { sweep_txid: null, sweep_height: null, sweep_confs: 0, spendable_zat: null },
      stop_requested: false,
      reason: null,
      problem: null,
      timeline: [],
      fault: null,
    };
    r.legs[0].label = label(r, 1);
    log(r, "created", `Route created: ${r.legs[0].unit.ticker} → shielded ZEC → ${r.legs[1].unit.ticker}, buying ${zecStr(r.zec_zat)} on the way`);
    routes.set(r.id, r);
    // start leg 1 now, so a refusal shows up in the answer
    step(r);
    return [201, view(r)];
  }

  // POST /api/routes/:id/continue: leave holding, or skip the pause
  function resume(r, body) {
    if (r.phase === "pausing") {
      r.not_before = secs();
      log(r, "pause_skipped", "Privacy pause skipped at your request: the short gap between the two swaps makes them easier to link.");
      enterLeg2(r);
      return null;
    }
    if (r.phase === "holding") {
      if (r.legs[1].swap_id) {
        r.leg2_gen += 1;
        const l = r.legs[1];
        l.earlier.push(l.swap_id);
        Object.assign(l, { swap_id: null, state: null, outcome: null, zec_zat: null, counter_units: null });
      }
      if (Array.isArray(body?.maker2) && body.maker2.length) r.maker2 = body.maker2.map(makerArg).filter(Boolean);
      if (Number.isInteger(body?.min_out) && body.min_out > 0) {
        r.min_out = body.min_out;
        r.min_out_basis_zat = r.zec2_zat;
      }
      Object.assign(r, { phase: "settling", outcome: null, reason: null, stop_requested: false });
      r.starting = { next_at: now(), window_ends: null, attempts: 0, maker_idx: 0, last_error: null };
      r.legs[1].label = label(r, 2);
      log(r, "continued", `Trying swap 2 again: ${zecStr(r.zec2_zat)} for at least ${unitsStr(outMin(r), r.legs[1].unit)}`);
      return null;
    }
    if (r.phase === "settling") return "Your ZEC can't be spent yet; swap 2 starts by itself once it can";
    if (r.phase === "leg1_starting" || r.phase === "leg1") return "Swap 1 is still running";
    if (r.phase === "leg2_starting" || r.phase === "leg2") return "Swap 2 is already under way";
    return "The route is over";
  }

  function stop(r) {
    if (r.phase === "leg1_starting") fail(r, "not_started", "You stopped the route before anything moved.");
    else if (r.phase === "leg2_starting") hold(r, "You stopped the route before swap 2");
    else if (r.phase === "leg1") {
      if (!r.stop_requested) log(r, "stop_requested", "Stopping: swap 2 won't run. If swap 1 completes, you keep the ZEC.");
      r.stop_requested = true;
    } else if (r.phase === "settling" || r.phase === "pausing") hold(r, "You stopped the route before swap 2");
    else if (r.phase === "leg2") return "Swap 2 is running and can't be stopped; if it fails, its refund returns your ZEC";
    else if (r.phase !== "holding") return "The route is over";
    return null;
  }

  // ------------------------------------------------------------------------------------------ http

  const clients = new Set();
  const last = new Map(); // id -> the view's JSON as last sent
  const list = () => [...routes.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));

  function publish() {
    for (const r of routes.values()) {
      const v = view(r);
      // the note's countdown changes every second; send a route when anything else does
      const key = JSON.stringify({ ...v, note: v.phase === "pausing" ? "" : v.note, updated_at: 0 });
      if (last.get(r.id) === key) continue;
      last.set(r.id, key);
      r.updated_at = secs();
      v.updated_at = r.updated_at;
      for (const c of clients) c.write(`event: route\ndata: ${JSON.stringify(v)}\n\n`);
    }
  }

  function tick() {
    for (const r of routes.values()) if (isActive(r)) step(r);
    publish();
  }

  function send(res, code, body) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function handler(req, res, readBody) {
    const path = new URL(req.url, "http://x").pathname;
    if (req.method === "GET" && path === "/api/status")
      return send(res, 200, {
        legs: legs.map((l) => ({ pair: l.pair, role: l.role })),
        routes: { total: routes.size, active: [...routes.values()].filter(isActive).length },
        needed_confs: NEEDED_CONFS,
        default_delay_secs: [300, 1800],
        leg2_window_secs: Number(env.MOCK_ROUTE_WINDOW_SECS ?? 120),
      });
    if (req.method === "GET" && path === "/api/routes") return send(res, 200, list().map(view));
    if (req.method === "POST" && path === "/api/routes") {
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: "bad request body: not JSON" });
      const [code, out] = create(body);
      publish();
      return send(res, code, out);
    }
    let m = path.match(/^\/api\/routes\/([a-z0-9]+)$/);
    if (req.method === "GET" && m) {
      const r = routes.get(m[1]);
      return r ? send(res, 200, view(r)) : send(res, 404, { error: "no such route" });
    }
    m = path.match(/^\/api\/routes\/([a-z0-9]+)\/(continue|stop)$/);
    if (req.method === "POST" && m) {
      const r = routes.get(m[1]);
      if (!r) return send(res, 404, { error: "no such route" });
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: "bad request body: not JSON" });
      const refused = m[2] === "continue" ? resume(r, body) : stop(r);
      if (refused) return send(res, 409, { error: refused });
      step(r);
      publish();
      return send(res, 200, view(r));
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const r of list().reverse()) res.write(`event: route\ndata: ${JSON.stringify(view(r))}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (req.method === "POST" && path === "/api/_mock/fault") {
      const body = await readBody(req);
      if (body?.leg2 !== "refund") return send(res, 400, { error: 'unknown fault: send {"leg2": "refund"}' });
      // a route already on its way to its second swap takes it, else the next one to get there
      const waiting = [...routes.values()].find((r) => ["leg1", "settling", "pausing", "leg2_starting"].includes(r.phase) && !r.fault);
      if (waiting) waiting.fault = "refund";
      else fault = "refund";
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/_mock/reset") {
      reset();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  }

  function reset() {
    routes.clear();
    last.clear();
    fault = null;
  }

  return { handler, tick, reset, routes };
}
