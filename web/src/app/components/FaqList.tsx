import type { Faq } from "../lib/faq";
import { Fold } from "./ui/fold";

// Questions in a rounded box, one fold each.
export function FaqList({ items, label }: { items: Faq[]; label?: string }) {
  return (
    <div className="divide-y divide-slate-100 overflow-hidden rounded-3xl border border-slate-200 bg-white" aria-label={label} role={label ? "group" : undefined}>
      {items.map((f) => (
        <Fold
          key={f.q}
          title={<span className="text-[15px] font-medium text-slate-900">{f.q}</span>}
          buttonClassName="px-5 py-4 hover:bg-slate-50 sm:px-6"
          bodyClassName="px-5 pb-5 text-[15px] leading-relaxed text-slate-600 sm:px-6"
        >
          <p>{f.a}</p>
        </Fold>
      ))}
    </div>
  );
}
