// One number for "how far along is my swap", shared by the visual directions, plus the caption
// that goes under the picture. Derived from the local party's own timeline, like the checklist.

import type { Role, SwapView } from "../../api";
import { phaseOf, type Phase } from "../steps";

export type Step = 0 | 1 | 2 | 3 | 4 | 5;
// 0 nothing yet, 1 agreeing, 2 their coins locked, 3 my coins locked, 4 claiming, 5 done

export interface Scene {
  step: Step;
  phase: Phase | "idle";
  caption: string;
  role: Role;
}

const CAPTIONS: Record<Role, string[]> = {
  Z: [
    "Ready when you are",
    "Agreeing the swap with the other side",
    "Their Bitcoin is locked for you",
    "Your ZEC is locked in a shielded address only this swap can open",
    "Claiming your BTC",
    "Done. The BTC is yours",
  ],
  B: [
    "Ready when you are",
    "Agreeing the swap with the other side",
    "Your BTC is locked, waiting for their ZEC",
    "Their ZEC is locked for you, shielded",
    "Claiming your ZEC",
    "Done. The ZEC is in your shielded wallet",
  ],
};

export function sceneOf(role: Role, swap?: SwapView): Scene {
  if (!swap) return { step: 0, phase: "idle", caption: CAPTIONS[role][0], role };
  const phase = phaseOf(swap);
  if (phase === "done" || phase === "settled") return { step: 5, phase, caption: CAPTIONS[role][5], role };
  if (phase === "unwinding") return { step: 3, phase, caption: "Undoing the swap. Everything goes back where it came from", role };
  if (phase === "refunded") return { step: 0, phase, caption: "Undone. Your coins are back in your wallet", role };
  if (phase === "lost") return { step: 0, phase, caption: "The deadline passed while you were offline", role };
  const has = (...kinds: string[]) => swap.timeline.some((e) => kinds.includes(e.kind));
  const confirmed = (kind: string) => swap.timeline.some((e) => e.kind === kind && e.height != null);
  let step: Step = 1;
  if (role === "Z") {
    if (has("btc_lock_seen")) step = 2;
    if (confirmed("zec_lock_broadcast")) step = 3;
    if (has("btc_redeem_broadcast")) step = 4;
  } else {
    if (confirmed("btc_lock_broadcast")) step = 2;
    if (has("zec_confirmed")) step = 3;
    if (has("secret_extracted")) step = 4;
  }
  return { step, phase, caption: CAPTIONS[role][step], role };
}

// `?scene=0..5` pins the picture to one step, for designing and screenshots.
export function pinnedStep(): Step | null {
  const v = new URLSearchParams(window.location.search).get("scene");
  if (v == null) return null;
  const n = Number(v);
  return n >= 0 && n <= 5 ? (n as Step) : null;
}

export function pinScene(scene: Scene, step: Step | null): Scene {
  if (step == null) return scene;
  const phase = step === 0 ? "idle" : step === 5 ? "done" : "progress";
  return { ...scene, step, phase, caption: CAPTIONS[scene.role][step] };
}

export type Direction = "A" | "B" | "C" | "bold1" | "bold2";
// The app is "bold2". `?direction=` remains a dev switch for the earlier explorations:
// plain (the text-only app), A, B, C, bold1.
export function directionParam(): Direction | null {
  const raw = new URLSearchParams(window.location.search).get("direction") ?? "bold2";
  if (raw === "plain") return null;
  if (raw === "bold1" || raw === "bold2") return raw;
  const v = raw.toUpperCase();
  return v === "A" || v === "B" || v === "C" ? v : "bold2";
}
