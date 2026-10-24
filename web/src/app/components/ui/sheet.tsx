import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";

// A modal panel: a bottom sheet on phones; above sm, a centred dialog, or with `anchored` a panel
// under whatever opened it (render it inside a `relative` box). Focus moves in on open (to
// [data-autofocus], else the first control), Tab stays inside, Escape or a click outside closes it,
// and focus goes back to whatever opened it.

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  onClose,
  title,
  note,
  anchored,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  note?: ReactNode;
  anchored?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = panel.current;
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    const phone = window.matchMedia("(max-width: 639px)").matches;
    if (!anchored || phone) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [open, anchored]);

  if (!open) return null;
  const body = (
    <div className={cn("fixed inset-0 z-50 flex items-end justify-center", anchored ? "sm:contents" : "sm:items-center sm:p-6")}>
      <div className={cn("sheet-fade absolute inset-0 bg-slate-900/20", anchored && "sm:fixed sm:z-40 sm:bg-transparent")} onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "sheet-in relative flex max-h-[85vh] w-full flex-col rounded-t-3xl border border-slate-200 bg-white shadow-[0_24px_64px_-24px_rgba(24,24,27,0.28)]",
          anchored ? "sm:absolute sm:top-full sm:right-0 sm:z-50 sm:mt-2 sm:max-h-[calc(100vh-11rem)] sm:w-[380px] sm:rounded-3xl" : "sm:max-w-[420px] sm:rounded-3xl",
        )}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-slate-200 sm:hidden" aria-hidden />
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 sm:pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            {note ? <p className="mt-1 text-sm text-slate-500">{note}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 -mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <X size={18} weight="bold" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
  return anchored ? body : createPortal(body, document.body);
}

// Up/Down (and Home/End) move between a list's options, as in a native select.
export function arrowKeys(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-option]:not([aria-disabled=true]):not([disabled])")];
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : at < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
  items[next]?.focus();
}
