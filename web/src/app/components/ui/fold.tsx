import { useId, useRef, useState, type ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";

// A fold: a button that shows or hides what's under it. Closed by default; Escape inside closes
// it and puts focus back on its button.
export function Fold({
  title,
  children,
  defaultOpen = false,
  className,
  buttonClassName,
  bodyClassName,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  buttonClassName?: string;
  bodyClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className={className}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex w-full items-center justify-between gap-4 text-left transition-colors", buttonClassName)}
      >
        <span className="min-w-0">{title}</span>
        <CaretDown size={14} weight="bold" className={cn("shrink-0 text-slate-500 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
      </button>
      <div
        id={id}
        hidden={!open}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }
        }}
        className={bodyClassName}
      >
        {open ? children : null}
      </div>
    </div>
  );
}
