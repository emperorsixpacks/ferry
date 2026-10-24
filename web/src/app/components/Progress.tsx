import type { ReactNode } from "react";
import { ArrowCounterClockwise, Check, CircleNotch, Wallet, Warning } from "@phosphor-icons/react";
import { clockSeconds } from "@/swap/timing";
import { cn } from "../lib/utils";
import type { PlainStep, Tone } from "../lib/progress";

// The progress pages' parts (a swap's and a private swap's): the status icon over the headline,
// and the plain steps, done ones ticked and the current one explained.

export function StatusIcon({ tone, holding }: { tone: Tone; holding?: boolean }) {
  const box = "flex h-14 w-14 items-center justify-center rounded-full";
  if (tone === "live")
    return (
      <span className={cn(box, "bg-slate-100 text-slate-900")}>
        <CircleNotch size={26} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden />
      </span>
    );
  if (tone === "good")
    return (
      <span className={cn(box, "bg-emerald-50 text-emerald-600")}>
        <Check size={26} weight="bold" aria-hidden />
      </span>
    );
  if (tone === "bad")
    return (
      <span className={cn(box, "bg-rose-50 text-rose-600")}>
        <Warning size={26} weight="bold" aria-hidden />
      </span>
    );
  return (
    <span className={cn(box, tone === "warn" ? "bg-slate-100 text-slate-900" : "bg-slate-100 text-slate-600")}>
      {holding ? <Wallet size={26} weight="bold" aria-hidden /> : <ArrowCounterClockwise size={26} weight="bold" aria-hidden />}
    </span>
  );
}

// A step may carry more under its note while it's the current one (a button, a countdown).
export type TrackerStep = PlainStep & { extra?: ReactNode };

export function Tracker({ steps, className = "mt-7" }: { steps: TrackerStep[]; className?: string }) {
  return (
    <ol className={cn("space-y-0", className)} aria-label="Progress">
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-4 pb-5 last:pb-0" aria-current={s.status === "active" ? "step" : undefined}>
          {i < steps.length - 1 ? <span className={cn("absolute top-7 bottom-1 left-[11px] w-0.5 rounded-full", s.status === "done" ? "bg-slate-900" : "bg-slate-200")} aria-hidden /> : null}
          <span
            className={cn(
              "relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
              s.status === "done" ? "bg-slate-900 text-white" : s.status === "active" ? "border-2 border-slate-900 bg-white" : "border-2 border-slate-200 bg-white",
            )}
            aria-hidden
          >
            {s.status === "done" ? <Check size={12} weight="bold" /> : s.status === "active" ? <span className="h-2 w-2 animate-pulse rounded-full bg-slate-900 motion-reduce:animate-none" /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className={cn("text-[15px]", s.status === "pending" ? "text-slate-500" : "font-medium text-slate-900")}>
                {s.title}
                <span className="sr-only">{s.status === "done" ? " (done)" : s.status === "active" ? " (now)" : ""}</span>
              </p>
              {s.status === "done" && s.at ? <span className="shrink-0 text-xs text-slate-500 tabular-nums">{clockSeconds(s.at)}</span> : null}
            </div>
            {s.status === "active" && s.note ? <p className="mt-1 text-sm text-slate-600">{s.note}</p> : null}
            {s.status === "active" && s.extra ? <div className="mt-2">{s.extra}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
