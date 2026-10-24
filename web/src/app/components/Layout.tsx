import type { ReactNode } from "react";
import { Warning } from "@phosphor-icons/react";
import { Link, usePath } from "@/router";
import { coin, zec } from "@/format";
import { btcText } from "@/swap/shared";
import { counterBalance } from "@/api";
import { useLocal, type Status } from "../lib/daemon";
import { Wordmark } from "./LogoMark";

// SealPad's app shell: a sticky blurred header with the logo square, mono nav tabs, the pair this
// daemon swaps and an obsidian chip where SealPad has its wallet button. Below md the tabs move
// to a second row.

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
  const width = wide ? "max-w-[1400px]" : "max-w-6xl";
  const tabs = nav.map((n) => ({ ...n, active: n.to === "/app" ? path === "/app" || path.startsWith("/app/") : path === n.to }));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div className={`mx-auto flex h-16 items-center gap-10 px-6 ${width}`}>
          <Link to="/" className="flex shrink-0 items-center">
            <Wordmark />
          </Link>
          <nav className="hidden h-full items-stretch gap-8 md:flex">
            {tabs.map((t) => (
              <Tab key={t.to} {...t} />
            ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <PairChip online={online} status={d.status} />
            <WalletChip name={d.status?.name ?? (d.role === "Z" ? "Z" : "B")} status={d.status} />
          </div>
        </div>
        <nav className="flex h-11 items-stretch gap-6 overflow-x-auto border-t border-slate-100 px-6 md:hidden">
          {tabs.map((t) => (
            <Tab key={t.to} {...t} />
          ))}
        </nav>
      </header>
      <main className={`mx-auto px-6 py-10 ${wide ? "max-w-[1400px]" : "max-w-6xl"}`}>
        {!online ? <OfflineBanner error={d.error} /> : null}
        {children}
      </main>
    </div>
  );
}

function Tab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`relative flex shrink-0 items-center font-mono text-[11px] tracking-[0.16em] whitespace-nowrap uppercase transition-colors ${
        active ? "text-slate-900" : "text-slate-500 hover:text-slate-900"
      }`}
    >
      {label}
      {active ? <span className="absolute inset-x-0 bottom-0 h-0.5 bg-brand-500" /> : null}
    </Link>
  );
}

// The pair this daemon swaps and the chain it's on: "ZEC ⇄ LTC | regtest", "ZEC ⇄ USDC | Base Sepolia".
function PairChip({ online, status }: { online: boolean; status: Status | null }) {
  if (!online) {
    return (
      <span className="inline-flex h-9 items-center gap-2 border border-rose-300 bg-rose-50 px-3 font-mono text-[11px] tracking-[0.14em] text-rose-700 uppercase">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" />
        Offline
      </span>
    );
  }
  const network = coin().kind === "evm" ? coin().name : (status?.chains.btc.network ?? "regtest");
  return (
    <span className="inline-flex h-9 items-stretch border border-slate-200 bg-white font-mono text-[11px] tracking-[0.14em] uppercase">
      <span className="flex items-center gap-2 px-3 text-slate-900">
        <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
        ZEC ⇄ {coin().ticker}
      </span>
      <span className="hidden items-center border-l border-slate-200 px-3 text-slate-500 sm:flex md:hidden xl:flex">{network}</span>
    </span>
  );
}

function WalletChip({ name, status }: { name: string; status: Status | null }) {
  const amount = (n: string, ticker: string) => (
    <span className="hidden items-center gap-1.5 border-l border-white/10 px-3 lg:flex">
      <span className="text-white">{n}</span>
      <span className="text-slate-400">{ticker}</span>
    </span>
  );
  return (
    <span className="inline-flex h-9 min-w-0 items-stretch bg-slate-900 font-mono text-xs">
      <span className="flex min-w-0 items-center px-3 font-sans text-sm font-semibold text-white">
        <span className="truncate">{name}</span>
      </span>
      {amount(status ? zec(status.balances.zec_shielded_zat) : "–", "ZEC")}
      {amount(status ? btcText(counterBalance(status)) : "–", coin().ticker)}
    </span>
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
