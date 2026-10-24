import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { short } from "../../format";

// SealPad's CopyAddress chip: truncated mono hex that copies the full value.
export function CopyText({ value, truncate = true, head = 6, tail = 4, className }: { value: string; truncate?: boolean; head?: number; tail?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${value}`}
      aria-label={`Copy ${value}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
      className={`group inline-flex max-w-full cursor-pointer items-center gap-1.5 text-left font-mono text-xs text-slate-500 transition-colors hover:text-slate-900 ${className ?? ""}`}
    >
      <span className="min-w-0 break-all">{truncate ? short(value, head, tail) : value}</span>
      {copied ? <Check size={12} weight="bold" className="text-brand-500" /> : <Copy size={12} weight="bold" className="opacity-40 transition-opacity group-hover:opacity-100" />}
    </button>
  );
}
