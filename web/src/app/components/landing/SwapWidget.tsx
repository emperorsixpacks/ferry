import { useState, type ReactNode } from "react";
import { ArrowDown, CaretDown } from "@phosphor-icons/react";
import { Link } from "@/router";
import { coin } from "@/format";
import { btcText } from "@/swap/shared";
import { useLocal } from "../../lib/daemon";
import { bestMaker, counterFor, quoteOf, selectable, useMakers } from "../../lib/makers";
import { pairName } from "../../lib/pairs";
import { PairLogo, TokenLogo } from "../Logos";
import { TokenPicker } from "../TokenPicker";

// The app's swap card on the landing: 1 ZEC quoted live at the best partner's rate from the server's
// partner list (GET /api/makers), never the local node's own offer. The coin can be changed here
// (the app's token picker); the button opens the app.
export function SwapWidget() {
  const d = useLocal();
  const makers = useMakers();
  const [picker, setPicker] = useState(false);
  const usable = makers.list ? makers.list.filter((m) => selectable(m, d.role)) : [];
  const maker = bestMaker(usable, 1e8, d.role);
  const quote = maker ? quoteOf(maker) : null;
  const out = quote ? counterFor(quote, 1e8, d.role) : 0;
  const name = pairName(d.pair);
  const z = d.role === "Z";
  const line =
    makers.list === undefined
      ? "Finding the best rate…"
      : makers.list === null
        ? "This server lists no swap partners yet."
        : !quote || !maker
          ? "No partner is taking swaps for this coin right now."
          : `1 ZEC = ${btcText(quote.rate)} ${coin().ticker} · best rate, from ${maker.name}`;
  const zecSide = (
    <Box label={z ? "You sell" : "You get"} pill={<ZecPill />}>
      <span className="text-slate-900">1</span>
    </Box>
  );
  const coinSide = (
    <Box
      label={z ? "You get" : "You pay"}
      pill={
        <button
          type="button"
          onClick={() => setPicker(true)}
          aria-haspopup="dialog"
          aria-label={`${name.noun}. Choose another coin`}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3 pl-1.5 shadow-[0_1px_2px_rgba(24,24,27,0.06)] transition-colors hover:border-slate-300 hover:bg-slate-50"
        >
          <PairLogo pair={d.pair} size={28} />
          <span className="text-[15px] font-semibold text-slate-900">{name.label}</span>
          <CaretDown size={14} weight="bold" className="text-slate-500" aria-hidden />
        </button>
      }
    >
      <span className={out ? "text-slate-900" : "text-slate-300"}>{out ? `≈ ${btcText(out)}` : "–"}</span>
    </Box>
  );
  return (
    <div className="w-full rounded-[28px] bg-white p-2 text-slate-900">
      <div className="flex flex-col">
        {z ? zecSide : coinSide}
        <div className="relative z-10 -my-[18px] flex justify-center" aria-hidden>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl border-4 border-white bg-slate-100 text-slate-700">
            <ArrowDown size={16} weight="bold" />
          </span>
        </div>
        {z ? coinSide : zecSide}
      </div>
      <p className="min-h-10 px-3 pt-3 pb-1 text-[13px] text-slate-600" aria-live="polite">
        {line}
      </p>
      <Link to="/app" className="mt-1 flex h-14 w-full items-center justify-center rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800">
        {z ? "Sell ZEC" : "Buy ZEC"} in the app
      </Link>
      <TokenPicker open={picker} onClose={() => setPicker(false)} makers={makers} role={d.role} />
    </div>
  );
}

function ZecPill() {
  return (
    <span className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3.5 pl-1.5 shadow-[0_1px_2px_rgba(24,24,27,0.06)]">
      <TokenLogo id="zec" size={28} />
      <span className="text-[15px] font-semibold text-slate-900">ZEC</span>
    </span>
  );
}

function Box({ label, pill, children }: { label: string; pill: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-3xl bg-slate-50 px-5 py-4">
      <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">{label}</p>
      <div className="mt-2 flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-[28px] leading-tight font-medium tracking-tight tabular-nums sm:text-[32px]">{children}</span>
        {pill}
      </div>
    </div>
  );
}
