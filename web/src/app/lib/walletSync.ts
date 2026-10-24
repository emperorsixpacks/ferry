import { useEffect, useRef, useState } from "react";
import type { Status, SwapView } from "@/api";
import { phaseOf } from "@/swap/steps";

// A real wallet shows a finished swap's coins a sync after the daemon reports the outcome. Until
// the header balance has caught up, the result says "Updating wallet…" instead of a line the
// header contradicts. The hold is capped, so a wallet that never moves can't keep it forever.

const CAP_MS = 15_000;

type Asset = "zec_shielded_zat" | "btc_sat";

// Which balance a finished swap should raise for this party, if any.
function expected(v: SwapView): Asset | null {
  const phase = phaseOf(v);
  const lockedMine = v.timeline.some((e) => e.kind === (v.role === "Z" ? "zec_lock_broadcast" : "btc_lock_broadcast"));
  if (v.role === "Z") {
    if (phase === "done" || phase === "settled") return "btc_sat";
    if (phase === "refunded" && lockedMine) return "zec_shielded_zat";
    return null;
  }
  if (phase === "done") return "zec_shielded_zat";
  if (phase === "refunded" && lockedMine) return "btc_sat";
  return null;
}

// The balances last seen while each swap was still running, kept for the life of the page.
const before = new Map<string, Status["balances"]>();

// called by the daemon provider on every update, so the baseline exists whichever page is open
export function noteRunning(swaps: SwapView[], status: Status | null) {
  if (!status) return;
  for (const s of swaps) if (!s.outcome) before.set(s.id, status.balances);
}

export function useWalletCaughtUp(swap: SwapView, status: Status | null): boolean {
  const firstDone = useRef<number | null>(null);
  const [, tick] = useState(0);

  const asset = expected(swap);
  const base = before.get(swap.id);
  // no baseline means the swap finished before this page saw it run: nothing to wait for
  const waiting = !!swap.outcome && !!asset && !!base && !!status && status.balances[asset] <= base[asset];
  if (waiting && firstDone.current == null) firstDone.current = Date.now();
  const capped = firstDone.current != null && Date.now() - firstDone.current >= CAP_MS;

  useEffect(() => {
    if (!waiting || capped) return;
    const id = setTimeout(() => tick((n) => n + 1), CAP_MS - (Date.now() - (firstDone.current ?? Date.now())) + 50);
    return () => clearTimeout(id);
  }, [waiting, capped]);

  return !waiting || capped;
}
