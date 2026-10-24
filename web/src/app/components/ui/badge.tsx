import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";
import type { Tone } from "../../lib/progress";

const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive/10 text-destructive",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// the docs pages' small uppercase badge
export function StatusBadge({ className, ...props }: React.ComponentProps<typeof Badge>) {
  return <Badge className={cn("text-[10px] tracking-wider uppercase", className)} {...props} />;
}

const TONES: Record<Tone, string> = {
  live: "bg-slate-100 text-slate-700",
  warn: "bg-slate-100 text-slate-800",
  good: "bg-emerald-50 text-emerald-700",
  neutral: "bg-slate-100 text-slate-600",
  bad: "bg-rose-50 text-rose-700",
};

// A swap's status word in a soft tint: In progress, Cancelling, Done, Cancelled, Expired.
export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>
      {tone === "live" ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-500 motion-reduce:animate-none" aria-hidden /> : null}
      {children}
    </span>
  );
}
