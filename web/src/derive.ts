// Turns the two parties' views of one swap into the picture the UI draws.
// Everything here is derived from timeline kinds and states in docs/API.md, so it works the same
// against the mock and against real ferryd.

import type { SwapView, TimelineEntry } from "./api";
import { coin } from "./format";

export type Path = "happy" | "refund" | "punish";

export type BtcAt = "b-shore" | "lock" | "cancel" | "z-shore";
export type ZecAt = "z-shore" | "joint" | "b-shore";

export interface Leg {
  n: number;
  title: string;
  who: "Z" | "B" | "Z or B";
  chain: "btc" | "zec";
  status: "pending" | "mempool" | "done";
  height: number | null;
}

export interface Crossing {
  path: Path;
  btc: { at: BtcAt; pending: boolean };
  zec: { at: ZecAt; pending: boolean; stuck: boolean };
  legs: Leg[];
  // one party learned the other's share from a Bitcoin witness
  reveal: null | { learner: "B"; share: "z" } | { learner: "Z"; share: "b" };
  finished: boolean;
}

const find = (v: SwapView | undefined, kind: string): TimelineEntry | undefined =>
  v?.timeline.find((e) => e.kind === kind);

function leg(n: number, title: string, who: Leg["who"], chain: Leg["chain"], e: TimelineEntry | undefined, done?: boolean): Leg {
  const status = !e ? "pending" : done || e.height != null ? "done" : "mempool";
  return { n, title, who, chain, status, height: e?.height ?? null };
}

export function deriveCrossing(z?: SwapView, b?: SwapView): Crossing {
  const lock = find(b, "btc_lock_broadcast");
  const zlock = find(z, "zec_lock_broadcast");
  const redeem = find(z, "btc_redeem_broadcast");
  const sweep = find(b, "zec_sweep_broadcast");
  // EVM: no cancel transaction; the claim window simply closes at t1
  const evm = coin().kind === "evm";
  const cancel = find(b, "cancel_broadcast") ?? find(z, "cancel_broadcast") ?? (evm ? find(b, "cancel_seen") ?? find(z, "cancel_seen") : undefined);
  const refund = find(b, "refund_broadcast");
  const reclaim = find(z, "zec_reclaim_broadcast");
  const punish = find(z, "punish_broadcast");

  const path: Path = punish ? "punish" : cancel ? "refund" : "happy";

  let btc: Crossing["btc"] = { at: "b-shore", pending: false };
  if (lock) btc = { at: "lock", pending: lock.height == null };
  if (cancel) btc = evm ? { at: "lock", pending: false } : { at: "cancel", pending: cancel.height == null };
  if (redeem) btc = { at: "z-shore", pending: redeem.height == null };
  if (refund) btc = { at: "b-shore", pending: refund.height == null };
  if (punish) btc = { at: "z-shore", pending: punish.height == null };

  let zec: Crossing["zec"] = { at: "z-shore", pending: false, stuck: false };
  if (zlock) zec = { at: "joint", pending: zlock.height == null, stuck: false };
  if (sweep) zec = { at: "b-shore", pending: sweep.height == null, stuck: false };
  if (reclaim) zec = { at: "z-shore", pending: reclaim.height == null, stuck: false };
  if (punish && zlock) zec = { ...zec, stuck: true };

  const legs: Leg[] = [
    leg(1, `B locks ${coin().ticker}`, "B", "btc", lock),
    leg(2, "Z locks ZEC", "Z", "zec", zlock),
  ];
  if (path === "happy") {
    legs.push(leg(3, `${evm ? "Z claims" : "Z redeems"} ${coin().ticker}`, "Z", "btc", redeem), leg(4, "B sweeps ZEC", "B", "zec", sweep));
  } else {
    legs.push(evm ? leg(3, "t1 passes without a claim", "Z or B", "btc", cancel, true) : leg(3, "Cancel after T1", "Z or B", "btc", cancel));
    if (path === "refund") {
      legs.push(leg(4, `B refunds ${coin().ticker}`, "B", "btc", refund));
      if (zlock) legs.push(leg(5, "Z reclaims ZEC", "Z", "zec", reclaim));
    } else {
      legs.push(leg(4, "Z punishes", "Z", "btc", punish));
    }
  }

  let reveal: Crossing["reveal"] = null;
  if (b?.secrets.peer_learned) reveal = { learner: "B", share: "z" };
  else if (z?.secrets.peer_learned) reveal = { learner: "Z", share: "b" };

  return { path, btc, zec, legs, reveal, finished: !!(z?.outcome && b?.outcome) };
}

export interface Deadlines {
  lock: number;
  t1: number;
  t2: number;
  t2Projected: boolean; // T2 counts from the cancel's height; until then this is the earliest it can be
}

export function deriveDeadlines(v?: SwapView): Deadlines | null {
  const d = v?.deadlines;
  if (!d || d.btc_lock_height == null) return null;
  const t1 = d.btc_lock_height + d.t1_blocks;
  const base = d.cancel_height ?? t1;
  return { lock: d.btc_lock_height, t1, t2: base + d.t2_blocks, t2Projected: d.cancel_height == null };
}

// The most recent thing either party did, for the one-line narration under the chart.
export function latestEvent(z?: SwapView, b?: SwapView): { who: "Z" | "B"; e: TimelineEntry } | null {
  const all = [
    ...(z?.timeline ?? []).map((e, i) => ({ who: "Z" as const, e, i })),
    ...(b?.timeline ?? []).map((e, i) => ({ who: "B" as const, e, i })),
  ];
  all.sort((x, y) => x.e.at.localeCompare(y.e.at) || x.i - y.i);
  const last = all.at(-1);
  return last ? { who: last.who, e: last.e } : null;
}
