import type { ReactNode } from "react";
import { Warning } from "@phosphor-icons/react";
import { Link, usePath } from "@/router";
import { coin, zec } from "@/format";
import { btcText } from "@/swap/shared";
import { useLocal } from "../lib/daemon";
import { Wordmark } from "./LogoMark";

// SealPad's app shell: a sticky blurred header with the logo square, the nav, the network pill
// and an obsidian chip where SealPad has its wallet button.

const nav = [
  { to: "/app", label: "Swap" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/safety", label: "Safety" },
  { to: "/inspect", label: "Inspect" },
];

export function Layout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const path = usePath();
  const d = useLocal();
  const online = d.connected || !!d.status;
  const network = d.status?.chains.btc.network ?? "regtest";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className={`mx-auto flex items-center justify-between px-6 py-4 ${wide ? "max-w-[1400px]" : "max-w-6xl"}`}>
          <div className="flex items-center gap-8">
            <Link to="/" className="flex items-center">
              <Wordmark />
            </Link>
            <nav className="hidden items-center gap-8 md:flex">
              {nav.map((n) => {
                const active = n.to === "/app" ? path === "/app" || path.startsWith("/app/") : path === n.to;
                return (
                  <Link key={n.to} to={n.to} className={`text-sm transition-colors ${active ? "font-semibold text-brand-600" : "text-slate-600 hover:text-slate-900"}`}>
                    {n.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`hidden h-10 items-center gap-2 rounded border px-3 font-mono text-[10px] tracking-widest uppercase sm:inline-flex ${
                online ? "border-brand-200 bg-brand-50 text-brand-700" : "border-rose-300 bg-rose-50 text-rose-700"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-brand-500" : "animate-pulse bg-rose-500"}`} />
              {online ? network : "Daemon offline"}
            </span>
            <span className="inline-flex h-10 items-center gap-3 bg-slate-900 px-4 font-mono text-xs text-white">
              <span className="font-sans font-semibold">{d.status?.name ?? (d.role === "Z" ? "Z" : "B")}</span>
              <span className="text-slate-400">{d.status ? `${zec(d.status.balances.zec_shielded_zat)} ZEC` : "–"}</span>
              <span className="text-slate-400">{d.status ? `${btcText(d.status.balances.btc_sat)} ${coin().ticker}` : "–"}</span>
            </span>
          </div>
        </div>
      </header>
      <main className={`mx-auto px-6 py-10 ${wide ? "max-w-[1400px]" : "max-w-6xl"}`}>
        {!online ? <OfflineBanner error={d.error} /> : null}
        {children}
      </main>
    </div>
  );
}

// SealPad's NetworkBanner, for a daemon this page can't reach
function OfflineBanner({ error }: { error: string | null }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border border-rose-300 bg-rose-50 px-5 py-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Warning size={22} weight="fill" className="mt-0.5 shrink-0 text-rose-600" />
        <div>
          <p className="text-sm font-semibold text-rose-900">Can't reach your Ferry daemon</p>
          <p className="mt-1 font-mono text-xs text-rose-700">{error ?? "Connecting…"}</p>
        </div>
      </div>
    </div>
  );
}

// SealPad's page header: orange mono eyebrow, bold title, one-line subtitle
export function PageHeader({ eyebrow, title, subtitle, aside, children }: { eyebrow: string; title: string; subtitle?: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="mb-2 font-mono text-xs tracking-widest text-brand-600 uppercase">{eyebrow}</p>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle ? <div className="mt-1 text-slate-600">{subtitle}</div> : null}
        {children}
      </div>
      {aside}
    </div>
  );
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`font-mono text-[10px] tracking-widest text-slate-500 uppercase ${className}`}>{children}</p>;
}

export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 font-medium text-slate-900">{value}</div>
    </div>
  );
}
