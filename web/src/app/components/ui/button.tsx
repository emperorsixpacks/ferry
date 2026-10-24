import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// SealPad's buttons: the orange action, the obsidian launch button, the outlined secondary
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        brand: "rounded bg-brand-500 font-semibold text-white hover:bg-brand-600 disabled:bg-slate-300",
        ink: "bg-slate-900 font-medium tracking-tight text-white hover:bg-slate-800 disabled:bg-slate-300",
        outline: "rounded border border-slate-200 bg-white font-medium text-slate-900 hover:border-brand-300 hover:text-brand-600",
        link: "text-slate-700 hover:text-brand-600",
      },
      size: {
        default: "px-5 py-2.5 text-sm",
        lg: "px-8 py-3 text-sm",
        xl: "px-7 py-3.5 text-sm",
        none: "",
      },
    },
    defaultVariants: { variant: "brand", size: "default" },
  },
);

export function Button({ className, variant, size, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
