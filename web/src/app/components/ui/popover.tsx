import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

// A small panel under a button: what a tooltip would say, but it works on a tap too. Escape or a
// click elsewhere closes it; Escape puts focus back on the button.
export function Popover({ label, trigger, children, className, panelClassName }: { label: string; trigger: ReactNode; children: ReactNode; className?: string; panelClassName?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <span ref={root} className="relative inline-flex min-w-0">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={className}
      >
        {trigger}
      </button>
      <span
        id={id}
        role="status"
        hidden={!open}
        className={cn(
          "absolute top-full right-0 z-50 mt-2 w-64 rounded-2xl border border-slate-200 bg-white p-4 text-left text-sm text-slate-700 shadow-[0_16px_48px_-16px_rgba(24,24,27,0.22)]",
          panelClassName,
        )}
      >
        {children}
      </span>
    </span>
  );
}
