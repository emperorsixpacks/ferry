import type { ReactNode } from "react";
import { ArrowUpRight, Flask, WarningCircle } from "@phosphor-icons/react";
import { Link, usePath } from "@/router";
import { coin, isMainnet, networkLabel, zec } from "@/format";
import { btcText } from "@/swap/shared";
import { counterBalance } from "@/api";
import { useLocal, type Status } from "../lib/daemon";
import { pairName } from "../lib/pairs";
import { cn } from "../lib/utils";
import { Wordmark } from "./LogoMark";
import { PairLogo, TokenLogo } from "./Logos";
import { Fold } from "./ui/fold";
import { Popover } from "./ui/popover";

// The app shell: a quiet sticky header (logo, three tabs, a "Test network" pill when it applies and
// your balance) and a footer with the deeper pages. Below md the tabs get their own row, so they
// stay one tap away on a phone.

const nav = [
  { to: "/app", label: "Swap", match: (p: string) => p === "/app" || p.startsWith("/app/swap/") },
  { to: "/app/activity", label: "Activity", match: (p: string) => p === "/app/activity" },
  { to: "/help", label: "Help", match: (p: string) => p === "/help" || p === "/how-it-works" || p === "/safety" },
];

export const REPO_URL = "https://github.com/JemIIahh/ferry";

export function Layout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const d = useLocal();
  const online = d.connected || !!d.status;
  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900">
      <SiteHeader />
      <main className={cn("mx-auto w-full flex-1 px-4 py-8 sm:px-6 md:py-14", wide ? "max-w-[1400px]" : "max-w-6xl")}>
        {!online ? <OfflineBanner error={d.error} /> : null}
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

export function SiteHeader() {
  const path = usePath().replace(/\/+$/, "") || "/";
  const d = useLocal();
  const online = d.connected || !!d.status;
  const tabs = nav.map((n) => ({ ...n, active: n.match(path) }));
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" className="flex shrink-0 items-center rounded-lg" aria-label="Ferry, home">
          <Wordmark size={26} />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {tabs.map((t) => (
            <Tab key={t.to} {...t} />
          ))}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <TestPill status={d.status} />
          <BalanceChip online={online} name={d.status?.name ?? null} status={d.status} />
        </div>
      </div>
      <nav aria-label="Main" className="flex items-center justify-center gap-1 border-t border-slate-100 px-4 py-1.5 md:hidden">
        {tabs.map((t) => (
          <Tab key={t.to} {...t} />
        ))}
      </nav>
    </header>
  );
}

function Tab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors",
        active ? "bg-slate-100 font-medium text-slate-900" : "text-slate-500 hover:text-slate-900",
      )}
    >
      {label}
    </Link>
  );
}

// "Test network" when either chain isn't a main network; the networks themselves on a tap.
function TestPill({ status }: { status: Status | null }) {
  if (!status) return null;
  const counterNet = status.chains.btc.network;
  const zecNet = status.chains.zec.network;
  if (isMainnet(counterNet) && isMainnet(zecNet)) return null;
  const kind = coin().kind === "evm" ? "evm" : coin().id === "ltc" ? "ltc" : "btc";
  const names = [networkLabel(counterNet, kind), networkLabel(zecNet, "zec")];
  return (
    <Popover
      label={`Test network: ${names.join(" and ")}`}
      className="inline-flex h-8 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200"
      trigger={
        <>
          <Flask size={13} weight="bold" aria-hidden />
          <span className="sm:hidden">Test</span>
          <span className="hidden sm:inline">Test network</span>
        </>
      }
    >
      <span className="block font-medium text-slate-900">Test network</span>
      <span className="mt-1 block text-slate-600">Coins here are for testing and have no value.</span>
      <span className="mt-3 block border-t border-slate-100 pt-3 text-xs text-slate-500">{names.join(" · ")}</span>
    </Popover>
  );
}

// Your Ferry node and its balances: the name and ZEC on the chip, the other coin on lg+ and on a tap.
function BalanceChip({ online, name, status }: { online: boolean; name: string | null; status: Status | null }) {
  const { pair } = useLocal();
  if (!online) {
    return (
      <span className="inline-flex h-9 items-center gap-2 rounded-full bg-rose-50 px-3 text-xs font-medium text-rose-700">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden />
        Not connected
      </span>
    );
  }
  const zecBal = status ? zec(status.balances.zec_shielded_zat) : "–";
  const other = status ? btcText(counterBalance(status)) : "–";
  const ticker = coin().ticker;
  return (
    <Popover
      label={`Your Ferry node${name ? ` ${name}` : ""}: ${zecBal} ZEC and ${other} ${ticker}`}
      className="inline-flex h-9 min-w-0 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3 pl-1 text-sm shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-slate-300"
      trigger={
        <>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white uppercase" aria-hidden>
            {(name ?? "?").slice(0, 1)}
          </span>
          <span className="hidden max-w-[7rem] truncate font-medium text-slate-900 sm:inline">{name ?? "…"}</span>
          <span className="flex items-center gap-1.5 text-slate-700 tabular-nums">
            <TokenLogo id="zec" size={14} />
            {zecBal}
          </span>
          <span className="hidden items-center gap-1.5 text-slate-700 tabular-nums lg:flex">
            <PairLogo pair={pair} size={14} />
            {other}
          </span>
        </>
      }
    >
      <span className="block text-xs text-slate-500">Your Ferry node</span>
      <span className="mt-0.5 block font-medium text-slate-900">{name ?? "–"}</span>
      <span className="mt-3 flex items-center justify-between gap-4 border-t border-slate-100 pt-3">
        <span className="flex items-center gap-2 text-slate-600">
          <TokenLogo id="zec" size={18} />
          Shielded ZEC
        </span>
        <span className="text-slate-900 tabular-nums">{zecBal}</span>
      </span>
      <span className="mt-2 flex items-center justify-between gap-4">
        <span className="flex min-w-0 items-center gap-2 text-slate-600">
          <PairLogo pair={pair} size={18} />
          <span className="truncate">{pairName(pair).noun}</span>
        </span>
        <span className="shrink-0 text-slate-900 tabular-nums">
          {other} {ticker}
        </span>
      </span>
    </Popover>
  );
}

function OfflineBanner({ error }: { error: string | null }) {
  return (
    <div className="mx-auto mb-8 max-w-[480px] rounded-2xl border border-rose-100 bg-rose-50/70 px-5 py-4">
      <div className="flex items-start gap-3">
        <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-rose-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-rose-900">Can't reach your Ferry node</p>
          <p className="mt-1 text-sm text-rose-800">It may be starting up or stopped. This page reconnects by itself.</p>
          {error ? (
            <Fold title={<span className="text-xs font-medium text-rose-800">Technical details</span>} className="mt-2" buttonClassName="rounded-md py-1" bodyClassName="pt-1">
              <p className="font-mono text-xs break-words text-rose-800">{error}</p>
            </Fold>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SiteFooter() {
  const links: [string, string][] = [
    ["Help", "/help"],
    ["Safety details", "/safety"],
    ["How it works in depth", "/how-it-works"],
    ["For developers", "/inspect"],
  ];
  return (
    <footer className="border-t border-slate-200/80 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Wordmark size={22} />
          <span className="text-sm text-slate-500">Private swaps for shielded ZEC.</span>
        </div>
        <nav aria-label="More" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-500">
          {links.map(([label, to]) => (
            <Link key={to} to={to} className="rounded transition-colors hover:text-slate-900">
              {label}
            </Link>
          ))}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded transition-colors hover:text-slate-900">
            Open source
            <ArrowUpRight size={12} weight="bold" aria-hidden />
          </a>
        </nav>
      </div>
    </footer>
  );
}

// A page title for the inner pages
export function PageHeader({ eyebrow, title, subtitle, aside, children }: { eyebrow: string; title: string; subtitle?: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wider text-slate-500 uppercase">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle ? <div className="mt-1 text-slate-600">{subtitle}</div> : null}
        {children}
      </div>
      {aside}
    </div>
  );
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[11px] font-medium tracking-wider text-slate-500 uppercase ${className}`}>{children}</p>;
}

export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 font-medium text-slate-900">{value}</div>
    </div>
  );
}
