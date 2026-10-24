// How a swap is labelled in lists, badges and headers, from this party's side.

import type { Role, Status, SwapView } from "@/api";
import { coin, zec } from "@/format";
import { btcFor, btcText } from "@/swap/shared";
import { phaseOf, stepsOf, type Phase } from "@/swap/steps";

export type BadgeTone = "default" | "secondary" | "destructive" | "outline";

// SealPad's mapping: settled is the orange badge, live states are grey, failures are red.
export const STATUS: Record<Phase, { label: string; tone: BadgeTone }> = {
  progress: { label: "Active", tone: "secondary" },
  unwinding: { label: "Cancelling", tone: "outline" },
  done: { label: "Settled", tone: "default" },
  settled: { label: "Settled", tone: "default" },
  refunded: { label: "Refunded", tone: "outline" },
  lost: { label: "Expired", tone: "destructive" },
};

export function amounts(v: SwapView, status: Status | null) {
  return {
    zec: `${zec(v.amounts.zec_zat)} ZEC`,
    btc: `${btcText(btcFor(v.role, v.amounts.btc_sat, status))} ${coin().ticker}`,
  };
}

export const direction = (role: Role) => (role === "Z" ? `ZEC → ${coin().ticker}` : `${coin().ticker} → ZEC`);

// one plain line under a list row or header
export function summary(v: SwapView, status: Status | null): string {
  const a = amounts(v, status);
  const phase = phaseOf(v);
  if (phase === "done" || phase === "settled") return v.role === "Z" ? `Received ${a.btc}` : `Received ${a.zec}`;
  if (phase === "refunded") {
    const locked = v.timeline.some((e) => e.kind === (v.role === "Z" ? "zec_lock_broadcast" : "btc_lock_broadcast"));
    if (!locked) return "Called off before any of your coins moved";
    return v.role === "Z" ? `${a.zec} back in your wallet` : `${a.btc} back in your wallet`;
  }
  if (phase === "lost") return `Deadline passed while you were offline`;
  const steps = stepsOf(v);
  const at = steps.findIndex((s) => s.status === "active");
  return at >= 0 ? `Step ${at + 1} of ${steps.length}: ${steps[at].title}` : "Finishing";
}

export const isLive = (v: SwapView) => !v.outcome;
