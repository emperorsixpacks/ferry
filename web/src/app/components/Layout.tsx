import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, CaretDown, CaretRight, WarningCircle } from "@phosphor-icons/react";
import { Link, usePath } from "@/router";
import { coin, isMainnet, networkLabel } from "@/format";
import { counterBalance } from "@/api";
import { useLocal, type Status } from "../lib/daemon";
import { pairName } from "../lib/pairs";
import { cn } from "../lib/utils";
import { Wordmark } from "./LogoMark";
import { PairLogo, TokenLogo } from "./Logos";
import { Fold } from "./ui/fold";
import { Popover } from "./ui/popover";

// The app shell: a sticky header across the full width (the mark on the left; Swap, Ramp and Help
// as a segmented pill in the true centre; the network and your account on the right, or "Start a
// swap" on the landing) and a footer with the deeper pages. Below md the tabs get their own row,
// the same pill centred, so they stay one tap away on a phone.

const nav = [
  { to: "/app", label: "Swap", match: (p: string) => p === "/app" || p === "/app/activity" || p.startsWith("/app/swap/") || p.startsWith("/app/route/") || p.startsWith("/app/near/") },
  { to: "/ramp", label: "Ramp", match: (p: string) => p === "/ramp" },
  { to: "/help", label: "Help", match: (p: string) => p === "/help" || p === "/how-it-works" || p === "/safety" || p === "/privacy" },
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

// `landing`: the landing page's bar, with "Start a swap" where the account would be
export function SiteHeader({ landing = false }: { landing?: boolean } = {}) {
  const path = usePath().replace(/\/+$/, "") || "/";
  const d = useLocal();
  const online = d.connected || !!d.status;
  const tabs = nav.map((n) => ({ ...n, active: n.match(path) }));
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur-md">
      <div className="relative flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-10">
        <Link to="/" className="flex shrink-0 items-center rounded-lg" aria-label="Ferry, home">
          <Wordmark size={26} />
        </Link>
        <nav aria-label="Main" className="absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 md:block">
          <Tabs tabs={tabs} />
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <NetworkBadge status={d.status} />
          {landing ? (
            <Link to="/app" className="inline-flex h-10 shrink-0 items-center rounded-full bg-slate-900 px-5 text-sm font-semibold text-white transition-colors hover:bg-slate-800">
              Start a swap
            </Link>
          ) : online ? (
            <AccountMenu name={d.status?.name ?? null} status={d.status} />
          ) : (
            <span className="inline-flex h-9 items-center gap-2 rounded-full bg-rose-50 px-3 text-xs font-medium text-rose-700">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden />
              Not connected
            </span>
          )}
        </div>
      </div>
      <nav aria-label="Main" className="flex justify-center border-t border-slate-100 px-4 py-2 md:hidden">
        <Tabs tabs={tabs} />
      </nav>
    </header>
  );
}

// Swap, Ramp and Help on a light grey track; the page you're on is a white pill.
function Tabs({ tabs }: { tabs: { to: string; label: string; active: boolean }[] }) {
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-slate-100 p-1">
      {tabs.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          aria-current={t.active ? "page" : undefined}
          className={cn(
            "rounded-full px-4 py-1.5 text-sm whitespace-nowrap transition-[color,background-color,box-shadow]",
            t.active ? "bg-white font-medium text-slate-900 shadow-[0_1px_3px_rgba(24,24,27,0.12),0_1px_1px_rgba(24,24,27,0.04)]" : "text-slate-500 hover:text-slate-900",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

// "Testnet" or "Mainnet", with each chain's network on a tap.
function NetworkBadge({ status }: { status: Status | null }) {
  if (!status) return null;
  const counterNet = status.chains.btc.network;
  const zecNet = status.chains.zec.network;
  const main = isMainnet(counterNet) && isMainnet(zecNet);
  const kind = coin().kind === "evm" ? "evm" : coin().id === "ltc" ? "ltc" : "btc";
  const names = [networkLabel(counterNet, kind), networkLabel(zecNet, "zec")];
  const word = main ? "Mainnet" : "Testnet";
  return (
    <Popover
      label={`${word}: ${names.join(" and ")}`}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900"
      trigger={
        <>
          <span className={cn("h-1.5 w-1.5 rounded-full", main ? "bg-slate-900" : "bg-[#F4B728]")} aria-hidden />
          {word}
        </>
      }
    >
      <span className="block font-medium text-slate-900">{main ? "Main networks" : "Test networks"}</span>
      {main ? null : <span className="mt-1 block text-slate-600">Coins here are for testing and have no value.</span>}
      <span className="mt-3 block border-t border-slate-100 pt-3 text-xs text-slate-500">{names.join(" · ")}</span>
    </Popover>
  );
}

// a balance for the menu: no long raw decimals (4 significant digits below 1,000, whole above)
const amount = (n: number) =>
  n === 0 ? "0" : n.toLocaleString("en-US", n < 1000 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 0 });

// Your Ferry node: its initial and name in the bar; its balances, the pair on screen and the
// way to your swaps in a small menu under it. Escape or a click elsewhere closes it, and Escape
// puts focus back on the button.
function AccountMenu({ name, status }: { name: string | null; status: Status | null }) {
  const { pair } = useLocal();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
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
  const c = coin();
  const zecBal = status ? amount(status.balances.zec_shielded_zat / 1e8) : "–";
  const other = status ? amount(counterBalance(status) / 10 ** c.decimals) : "–";
  const label = name ?? "Your Ferry node";
  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Your Ferry node${name ? `, ${name}` : ""}`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-10 min-w-0 items-center gap-2 rounded-full border border-slate-200 bg-white p-1 text-sm transition-colors hover:border-slate-300 sm:pr-3"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white uppercase" aria-hidden>
          {(name ?? "?").slice(0, 1)}
        </span>
        <span className="hidden max-w-[8rem] truncate font-medium text-slate-900 sm:inline">{name ?? "…"}</span>
        <CaretDown size={12} weight="bold" className={cn("hidden shrink-0 text-slate-500 transition-transform sm:block", open && "rotate-180")} aria-hidden />
      </button>
      <div
        id={id}
        hidden={!open}
        className="absolute top-full right-0 z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-2 text-sm shadow-[0_16px_48px_-16px_rgba(24,24,27,0.25)]"
      >
        <div className="px-3 pt-2 pb-3">
          <p className="text-xs text-slate-500">Your Ferry node</p>
          <p className="mt-0.5 truncate font-medium text-slate-900">{label}</p>
        </div>
        <dl className="space-y-2 rounded-xl bg-slate-50 px-3 py-3">
          <div className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-2 text-slate-600">
              <TokenLogo id="zec" size={18} />
              Shielded ZEC
            </dt>
            <dd className="text-slate-900 tabular-nums">{zecBal} ZEC</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="flex min-w-0 items-center gap-2 text-slate-600">
              <PairLogo pair={pair} size={18} />
              <span className="truncate">{pairName(pair).noun}</span>
            </dt>
            <dd className="shrink-0 text-slate-900 tabular-nums">
              {other} {c.ticker}
            </dd>
          </div>
        </dl>
        <p className="px-3 pt-3 pb-2 text-xs text-slate-500">Pair on screen: ZEC ⇄ {pairName(pair).noun}</p>
        {/* a link closes the menu (the click bubbles up to here) */}
        <div className="border-t border-slate-100 pt-1" onClick={() => setOpen(false)}>
          {(
            [
              ["Activity", "/app/activity"],
              ["Help", "/help"],
            ] as const
          ).map(([text, to]) => (
            <Link key={to} to={to} className="flex items-center justify-between rounded-xl px-3 py-2 text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900">
              {text}
              <CaretRight size={12} weight="bold" className="text-slate-400" aria-hidden />
            </Link>
          ))}
        </div>
      </div>
    </div>
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

// the footer's pages (the landing's closing footer shows the same ones)
export const FOOTER_LINKS: [string, string][] = [
  ["Help", "/help"],
  ["What the world sees", "/privacy"],
  ["Safety details", "/safety"],
  ["How it works in depth", "/how-it-works"],
  ["For developers", "/inspect"],
];

export function SiteFooter() {
  const links = FOOTER_LINKS;
  return (
    <footer className="border-t border-slate-200/80 bg-white">
      <div className="flex flex-col gap-5 px-4 py-10 sm:px-6 md:flex-row lg:px-10 md:items-center md:justify-between">
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
