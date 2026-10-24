// Plain-language progress for one side of a swap, read from that party's own timeline.

import type { SwapView, TimelineEntry } from "../api";

export type StepStatus = "done" | "active" | "pending";

export interface Step {
  title: string;
  status: StepStatus;
  at?: string;
  note?: string; // shown under the active step
}

export type Phase =
  | "progress" // going normally
  | "unwinding" // cancelled; funds are on their way back
  | "done" // swapped
  | "refunded" // undone; the user has their original coins back
  | "settled" // Z after punishing: the other side never refunded, so Z keeps the BTC
  | "lost"; // B after being punished

const find = (v: SwapView, ...kinds: string[]): TimelineEntry | undefined =>
  v.timeline.find((e) => kinds.includes(e.kind));

function step(title: string, done: TimelineEntry | undefined, note?: string): Step {
  return { title, status: done ? "done" : "pending", at: done?.at, note };
}

// The first step that isn't done becomes the active one.
function activate(steps: Step[]): Step[] {
  const i = steps.findIndex((s) => s.status !== "done");
  if (i >= 0) steps[i] = { ...steps[i], status: "active" };
  return steps;
}

export function phaseOf(v: SwapView): Phase {
  if (v.outcome === "swapped") return "done";
  if (v.outcome === "refunded") return "refunded";
  if (v.outcome === "punished") return v.role === "Z" ? "settled" : "lost";
  if (find(v, "cancel_broadcast", "cancel_seen", "zec_lock_refused") || ["Cancelled", "ZecReclaiming", "ZecLockRefused"].includes(v.state)) return "unwinding";
  return "progress";
}

export function stepsOf(v: SwapView): Step[] {
  const confirmed = (e?: TimelineEntry) => (e && e.height != null ? e : undefined);
  const terms = find(v, "cancel_sig_received", "refund_adaptor_verified");

  if (phaseOf(v) === "settled" || phaseOf(v) === "lost") {
    // the other side (Z's view) or this side (B's view) went quiet past both deadlines
    const cancel = find(v, "cancel_broadcast", "cancel_seen");
    const punish = find(v, "punish_broadcast", "punish_seen", "punished");
    return activate(
      v.role === "Z"
        ? [
            step("Agreed the swap with the other side", terms),
            step("Bitcoin locked by the other side", find(v, "btc_lock_seen")),
            step("Your ZEC is locked in a shielded address only this swap can open", confirmed(find(v, "zec_lock_broadcast"))),
            step("The other side stopped responding, so the swap was called off", cancel),
            step("They never took their bitcoin back, so after the deadline it was released to you", punish),
          ]
        : [
            step("Agreed the swap with the other side", terms),
            step("Your BTC is locked", confirmed(find(v, "btc_lock_broadcast"))),
            step("Your daemon stopped responding, so the swap was called off", cancel),
            step("After the deadline, the BTC went to the other side", punish),
          ],
    );
  }

  if (phaseOf(v) === "unwinding" || phaseOf(v) === "refunded") {
    const cancel = find(v, "cancel_broadcast", "cancel_seen");
    if (v.role === "Z") {
      const lockedZec = !!find(v, "zec_lock_broadcast");
      const refused = find(v, "zec_lock_refused");
      if (refused) {
        // Z's wallet wouldn't fund the lock shielded-only, so no ZEC ever left it
        const done = v.outcome === "refunded" ? v.timeline[v.timeline.length - 1] : undefined;
        return activate([
          step("Your wallet couldn't send the ZEC from shielded notes only, so nothing was sent", refused),
          step("The swap was called off", cancel, "Waiting for the deadline, then for the Bitcoin network"),
          step("Their Bitcoin goes back to them", find(v, "secret_extracted", "refund_seen") ?? done, "Waiting for the Bitcoin network"),
        ]);
      }
      const refundSeen = find(v, "secret_extracted");
      const back = find(v, "reclaimed") ?? (v.outcome === "refunded" ? refundSeen : undefined);
      return activate([
        step("The swap didn't finish in time, so it was called off", cancel),
        step("Their Bitcoin goes back to them, which unlocks your ZEC", refundSeen, "Waiting for the Bitcoin network"),
        ...(lockedZec ? [step("Bringing your ZEC back to your wallet", back, "Moving it back to your shielded address")] : []),
      ]);
    }
    const refund = find(v, "refund_broadcast");
    return activate([
      step("The swap didn't finish in time, so it was called off", cancel),
      step("Bringing your BTC back to your wallet", v.outcome === "refunded" ? find(v, "refunded") ?? confirmed(refund) : undefined, "Waiting for the Bitcoin network"),
    ]);
  }

  if (v.role === "Z") {
    return activate([
      step("Agreed the swap with the other side", terms, "Setting up the swap"),
      step("Bitcoin locked by the other side", find(v, "btc_lock_seen"), "Waiting for their Bitcoin to confirm"),
      step("Your ZEC is locked in a shielded address only this swap can open", confirmed(find(v, "zec_lock_broadcast")), "Waiting for the Zcash network"),
      step("Claiming your BTC", confirmed(find(v, "btc_redeem_broadcast")), "Waiting for the other side, then for one Bitcoin block"),
      step("Done", find(v, "swap_complete")),
    ]);
  }
  return activate([
    step("Agreed the swap with the other side", terms, "Setting up the swap"),
    step("Your BTC is locked", confirmed(find(v, "btc_lock_broadcast")), "Waiting for the Bitcoin network"),
    step("ZEC locked by the other side", find(v, "zec_confirmed"), "Waiting for their ZEC to confirm"),
    step("Claiming your ZEC", confirmed(find(v, "zec_sweep_broadcast")), "Waiting for their Bitcoin claim, then sending the ZEC to your shielded wallet"),
    step("Done", find(v, "swap_complete")),
  ]);
}

// Transactions for the Details section, oldest first.
export function transactions(v: SwapView): { chain: "btc" | "zec"; label: string; txid: string; height: number | null }[] {
  const names: Record<string, string> = {
    btc_lock_broadcast: "Bitcoin lock",
    btc_lock_seen: "Bitcoin lock",
    zec_lock_broadcast: "ZEC lock",
    zec_note_seen: "ZEC lock",
    btc_redeem_broadcast: "Bitcoin claim",
    secret_extracted: "",
    zec_sweep_broadcast: "ZEC claim",
    cancel_broadcast: "Bitcoin cancel",
    cancel_seen: "Bitcoin cancel",
    refund_broadcast: "Bitcoin refund",
    zec_reclaim_broadcast: "ZEC return",
    punish_broadcast: "Bitcoin settlement",
    punish_seen: "Bitcoin settlement",
  };
  const seen = new Set<string>();
  const out: ReturnType<typeof transactions> = [];
  for (const e of v.timeline) {
    if (!e.txid || seen.has(e.txid) || !(e.kind in names)) continue;
    let label = names[e.kind];
    if (!label) {
      if (seen.has(e.txid)) continue;
      label = v.role === "B" ? "Bitcoin claim" : "Bitcoin refund";
    }
    seen.add(e.txid);
    out.push({ chain: e.chain === "zec" ? "zec" : "btc", label, txid: e.txid, height: e.height });
  }
  return out;
}
