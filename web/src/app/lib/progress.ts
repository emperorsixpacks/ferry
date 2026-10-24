// A swap in plain words, for people who have never heard of an atomic swap: a status word, a
// headline, and three or four steps, read from this party's own timeline. The full step list
// (swap/steps.ts) stays for the technical details.

import type { Status, SwapView, TimelineEntry } from "@/api";
import { CHAIN_NAMES, amountIn, coin, zec, type CoinInfo } from "@/format";
import { btcFor } from "@/swap/shared";
import { phaseOf, type Phase, type StepStatus } from "@/swap/steps";

export interface PlainStep {
  title: string;
  status: StepStatus;
  at?: string;
  // one sentence under the step while it's the current one
  note?: string;
}

export type Tone = "live" | "warn" | "good" | "neutral" | "bad";

// the status word on a badge and above the headline
export const STATUS_WORD: Record<Phase, { label: string; tone: Tone }> = {
  progress: { label: "In progress", tone: "live" },
  unwinding: { label: "Cancelling", tone: "warn" },
  done: { label: "Done", tone: "good" },
  settled: { label: "Done", tone: "good" },
  refunded: { label: "Cancelled", tone: "neutral" },
  lost: { label: "Expired", tone: "bad" },
};

// The coin and chain words for a swap: "BTC" on "Bitcoin", "USDC" on "Base".
export interface Words {
  c: CoinInfo;
  ticker: string;
  chain: string;
}
export function wordsFor(c: CoinInfo = coin()): Words {
  const chain = c.kind === "evm" ? (c.chain ? CHAIN_NAMES[c.chain] : "its network") : c.name;
  return { c, ticker: c.ticker, chain };
}

const find = (v: SwapView, ...kinds: string[]): TimelineEntry | undefined => v.timeline.find((e) => kinds.includes(e.kind));
const confirmed = (e?: TimelineEntry) => (e && e.height != null ? e : undefined);
const step = (title: string, done: TimelineEntry | undefined, note?: string): PlainStep => ({ title, status: done ? "done" : "pending", at: done?.at, note });
function activate(steps: PlainStep[]): PlainStep[] {
  const i = steps.findIndex((s) => s.status !== "done");
  if (i >= 0) steps[i] = { ...steps[i], status: "active" };
  return steps;
}

// "1.00 ZEC" and "0.0041 BTC" as this party sees them (Z receives the locked amount less the
// payout's fee)
export function swapAmounts(v: SwapView, status: Status | null, w: Words = wordsFor()) {
  return { zec: `${zec(v.amounts.zec_zat)} ZEC`, coin: `${amountIn(btcFor(v.role, v.amounts.btc_sat, status), w.c)} ${w.ticker}` };
}

// whether this party's own coins were ever locked (a lock that lapsed never reached the chain)
export function lockedMine(v: SwapView): boolean {
  if (v.role === "Z" && find(v, "zec_lock_lapsed")) return false;
  return !!find(v, v.role === "Z" ? "zec_lock_broadcast" : "btc_lock_broadcast");
}

export function plainSteps(v: SwapView, w: Words = wordsFor()): PlainStep[] {
  const phase = phaseOf(v);
  const t = w.ticker;
  const terms = find(v, "cancel_sig_received", "refund_adaptor_verified", "terms_agreed");
  const cancel = find(v, "cancel_broadcast", "cancel_seen");

  if (phase === "settled" || phase === "lost") {
    const punish = find(v, "punish_broadcast", "punish_seen", "punished");
    return activate(
      v.role === "Z"
        ? [
            step(`Partner locked their ${t}`, find(v, "btc_lock_seen")),
            step("Your ZEC was locked", confirmed(find(v, "zec_lock_broadcast"))),
            step("Your partner stopped responding", cancel, "The swap is called off at the deadline."),
            step(`After the deadline, their ${t} was released to you`, punish, `Waiting for the deadline, then for the ${w.chain} network.`),
          ]
        : [
            step(`Your ${t} was locked`, confirmed(find(v, "btc_lock_broadcast"))),
            step("Your Ferry node stopped responding", cancel),
            step(`After the deadline, the ${t} went to your partner`, punish),
          ],
    );
  }

  if (phase === "unwinding" || phase === "refunded") {
    if (v.role === "Z") {
      const refused = find(v, "zec_lock_refused");
      const end = v.outcome === "refunded" ? v.timeline[v.timeline.length - 1] : undefined;
      if (refused) {
        return activate([
          step("Nothing was sent", refused),
          step("The swap is called off", cancel, "Waiting for the deadline."),
          step(`Your partner gets their ${t} back`, find(v, "secret_extracted", "refund_seen") ?? end, `Waiting for the ${w.chain} network.`),
        ]);
      }
      const theirs = find(v, "secret_extracted");
      return activate([
        step("The swap is called off", cancel, "It didn't finish before the deadline."),
        step(`Your partner takes their ${t} back`, theirs, "That unlocks your ZEC."),
        ...(lockedMine(v) ? [step("Your ZEC comes back", find(v, "reclaimed") ?? (v.outcome === "refunded" ? (theirs ?? end) : undefined), "Moving it back to your shielded wallet.")] : []),
      ]);
    }
    return activate([
      step("The swap is called off", cancel, "It didn't finish before the deadline."),
      step(`Your ${t} comes back`, v.outcome === "refunded" ? (find(v, "refunded") ?? confirmed(find(v, "refund_broadcast")) ?? v.timeline[v.timeline.length - 1]) : undefined, `Waiting for the ${w.chain} network.`),
    ]);
  }

  if (v.role === "Z") {
    return activate([
      step(`Partner locks their ${t}`, find(v, "btc_lock_seen"), terms ? `Waiting for their ${t} to confirm on ${w.chain}. They lock first, so you never go first.` : "Setting up the swap with your partner."),
      step("Your ZEC is locked", confirmed(find(v, "zec_lock_broadcast")), "Your ZEC goes to a private address that only this swap can open."),
      step(`You receive ${t}`, find(v, "swap_complete") ?? confirmed(find(v, "btc_redeem_broadcast")), find(v, "btc_redeem_broadcast") ? `Claimed. It lands with the next ${w.chain} block.` : `Claiming your ${t} as soon as your partner is ready.`),
    ]);
  }
  return activate([
    step(`Your ${t} is locked`, confirmed(find(v, "btc_lock_broadcast")), terms ? `Locking your ${t} where only this swap can open it.` : "Setting up the swap with your partner."),
    step("Partner locks their ZEC", find(v, "zec_confirmed"), "Waiting for their ZEC to confirm on Zcash."),
    step("You receive ZEC", find(v, "swap_complete") ?? confirmed(find(v, "zec_sweep_broadcast")), `Your partner claims the ${t}, which lets you take the ZEC into your shielded wallet.`),
  ]);
}

// One plain line for a list row or banner.
export function plainSummary(v: SwapView, status: Status | null, w: Words = wordsFor()): string {
  const a = swapAmounts(v, status, w);
  const phase = phaseOf(v);
  if (phase === "done" || phase === "settled") return v.role === "Z" ? `You received ${a.coin}` : `You received ${a.zec}`;
  if (phase === "refunded") return lockedMine(v) ? `Your ${v.role === "Z" ? a.zec : a.coin} is back` : "Nothing left your wallet";
  if (phase === "lost") return "The deadline passed while your Ferry node was offline";
  const steps = plainSteps(v, w);
  const at = steps.findIndex((s) => s.status === "active");
  return at >= 0 ? `Step ${at + 1} of ${steps.length}: ${steps[at].title}` : "Finishing";
}
