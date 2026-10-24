import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// Buttons: the ink action, the outlined secondary, a text link
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap transition-colors disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        ink: "rounded-2xl bg-slate-900 font-semibold text-white hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400",
        outline: "rounded-full border border-slate-200 bg-white font-medium text-slate-900 hover:border-slate-300 hover:bg-slate-50",
        link: "text-slate-700 hover:text-slate-900",
      },
      size: {
        default: "px-4 py-2 text-sm",
        lg: "px-6 py-3 text-sm",
        none: "",
      },
    },
    defaultVariants: { variant: "ink", size: "default" },
  },
);

export function Button({ className, variant, size, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
