import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, ArrowSquareOut, Bank, Eye, EyeSlash, LinkBreak, LockSimple, Warning } from "@phosphor-icons/react";
import { Link } from "@/router";
import { CopyText } from "../components/CopyText";
import { REPO_URL, SiteFooter, SiteHeader } from "../components/Layout";
import { ChainLogo, PairLogo, TokenLogo } from "../components/Logos";
import { Fold } from "../components/ui/fold";
import { cn } from "../lib/utils";
import "../privacy.css";

// /privacy, "What the world sees". One example, done four ways: someone is watching Alice's bitcoin
// address and she moves 0.5 BTC out of it, through a typical bridge, through NEAR Intents alone, in
// one Ferry swap, and in a Ferry private route (BTC → shielded ZEC → USDC). Each card shows what a
// block explorer shows once it's done, chain by chain, and draws a line between the chains only
// where a public link exists. Then who else learns what, the limits, and the real transactions.
//
// Sources (keep in step): docs/THREAT-MODEL.md ("What the other side learns", "What everyone else
// sees", "Routes", "Paying out to another address"), docs/PROTOCOL.md (Privacy), docs/EVM.md (What
// the public sees on Base), docs/ARCHITECTURE.md (Cross-chain settlement with NEAR Intents), and
// docs/evidence/ (the live Base Sepolia swap; the regtest run's pool check). The bridge column is
// the common case of bridges in general, not a Ferry document.

const DOCS = `${REPO_URL}/blob/master/docs`;
const SRC = {
  them: `${DOCS}/THREAT-MODEL.md#what-the-other-side-learns`,
  world: `${DOCS}/THREAT-MODEL.md#what-everyone-else-sees`,
  routes: `${DOCS}/THREAT-MODEL.md#routes-coin-a--shielded-zec--coin-c`,
  near: `${DOCS}/THREAT-MODEL.md#paying-out-to-another-address-payout_to-near-intents`,
  nearWhy: `${DOCS}/ARCHITECTURE.md#cross-chain-settlement-with-near-intents`,
  protocol: `${DOCS}/PROTOCOL.md#privacy`,
  base: `${DOCS}/EVM.md#what-the-public-sees-on-base`,
  e2e: `${DOCS}/evidence/e2e-real-regtest-2026-10-19.txt`,
  sepolia: `${DOCS}/evidence/evm-base-sepolia-live-2026-10-20.txt`,
};
// the live Base Sepolia swap of 2026-10-20 (docs/evidence/evm-base-sepolia-live-2026-10-20.txt)
const SEPOLIA = {
  contract: "https://sepolia.basescan.org/address/0x74b775EA7Bc7a2b2688b7A72Da5dee674BBd65Ef",
  lock: "https://sepolia.basescan.org/tx/0xeac4a050a97702fbca0fb1cf8ad8d4f965549e0612c62e0d85d233182fa926bb",
  claim: "https://sepolia.basescan.org/tx/0xde25c161c7e9b978de9aed580d12b0530813a460dd543124fbfc345978996aad",
  zecLock: "94948a388c0d6bb8bfd5628ffeada3cc28afd51e3f99ea4d2057f7b2a66c4696",
  zecSweep: "aaaa26a425285c8e35e4b677fd07a841bf2d74fceea706dc4fbb3996de5a1a4f",
};
const NEAR_EXPLORER = "https://explorer.near-intents.org";

export function Privacy() {
  return (
    <div className="flex min-h-screen flex-col overflow-x-clip bg-white text-slate-900">
      <SiteHeader />
      <main className="flex-1">
        <Intro />
        <Compare />
        <Limits />
        <Evidence />
        <More />
      </main>
      <SiteFooter />
    </div>
  );
}

const wrap = "mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-10";
const h2 = "text-[28px] leading-[1.1] font-semibold tracking-[-0.025em] text-slate-900 sm:text-[34px]";

function Intro() {
  return (
    <section aria-labelledby="pv-title" className={cn(wrap, "pt-8 md:pt-10")}>
      <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">Privacy, side by side</p>
      <h1 id="pv-title" className="mt-2.5 text-[38px] leading-[1.04] font-semibold tracking-[-0.035em] text-slate-900 sm:text-[48px]">
        What the world sees
      </h1>
      <div className="mt-3 flex flex-col gap-5">
        <p className="max-w-[60rem] text-[17px] leading-relaxed text-slate-600">
          Someone is watching Alice's bitcoin address, and she moves 0.5 BTC out of it. Here is what anyone with a block explorer sees once it's done, four ways, and
          whether they can follow her.
        </p>
        <Legend />
      </div>
      <Glance />
    </section>
  );
}

// on a phone the cards stack, so the four verdicts come first, each a jump to its card
function Glance() {
  return (
    <nav aria-label="The four, at a glance" className="mt-6 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 md:hidden">
      {COLS.map((c, i) => (
        <a key={c.key} href={`#pv-card-${c.key}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-slate-50">
          <span className="flex min-w-0 items-center gap-2.5 font-medium text-slate-900">
            <Num n={i + 1} />
            <span className="truncate">{c.title}</span>
          </span>
          <Pill linked={c.linked} />
        </a>
      ))}
    </nav>
  );
}

function Num({ n }: { n: number }) {
  return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700 tabular-nums">{n}</span>;
}

function Pill({ linked }: { linked: boolean }) {
  return linked ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-xs font-medium text-white">
      <Eye size={12} weight="bold" aria-hidden />
      Linked
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#F4B728]/20 px-2.5 py-1 text-xs font-medium text-slate-900">
      <EyeSlash size={12} weight="bold" aria-hidden />
      Not linked
    </span>
  );
}

function Legend() {
  return (
    <ul aria-label="How to read the cards" className="flex flex-wrap gap-x-6 gap-y-2.5 text-[13px] text-slate-600">
      <li className="flex items-center gap-2">
        <span className="relative flex h-5 w-2 justify-center" aria-hidden>
          <span className="h-full w-0.5 bg-slate-900" />
          <span className="absolute top-0 h-1.5 w-1.5 rounded-full bg-slate-900" />
          <span className="absolute bottom-0 h-1.5 w-1.5 rounded-full bg-slate-900" />
        </span>
        Public link
      </li>
      <li className="flex items-center gap-2">
        <LinkBreak size={15} weight="bold" className="text-slate-500" aria-hidden />
        No link on chain
      </li>
      <li className="flex items-center gap-2">
        <Secret />
        On chain, unreadable
      </li>
      <li className="flex items-center gap-2">
        <AliceTag />
        Who they can name
      </li>
      <li className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-slate-900 underline decoration-slate-400 decoration-dotted underline-offset-4" aria-hidden>
          0.5
        </span>
        Could hint
      </li>
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------
// The four cards

type Val =
  | { t: "addr"; v: string; who?: "alice" | "found" | "unknown" }
  | { t: "name"; v: string }
  | { t: "secret" }
  | { t: "amount"; v: string; hint?: boolean };

type Chain = "bitcoin" | "base" | "zcash";

type Lane = { chain: Chain; rows: [string, Val][]; note: string };

type Between =
  | { kind: "link"; icon: ReactNode; title: string; body: string }
  | { kind: "none"; body: ReactNode };

type Col = {
  key: string;
  title: string;
  ferry?: boolean;
  example: string;
  flow: ("btc" | "zec" | "usdc-base")[];
  a: Lane;
  between: Between;
  b: Lane;
  linked: boolean;
  verdict: [string, string];
  who: [string, string][];
  details: ReactNode;
};

const ALICE_BTC = "bc1q…7ace";
const ALICE_BASE = "0x7c…a1ce";

const btcOut = (to: Val, note: string, hint = false): Lane => ({
  chain: "bitcoin",
  rows: [
    ["From", { t: "addr", v: ALICE_BTC, who: "alice" }],
    ["To", to],
    ["Amount", { t: "amount", v: "0.5 BTC", hint }],
  ],
  note,
});

const COLS: Col[] = [
  {
    key: "bridge",
    title: "A typical bridge",
    example: "Alice moves 0.5 BTC to Base, as USDC.",
    flow: ["btc", "usdc-base"],
    a: btcOut({ t: "name", v: "The bridge's address" }, "Public, like every Bitcoin payment."),
    between: { kind: "link", icon: <Bank size={14} weight="bold" aria-hidden />, title: "Linked by the bridge", body: "It pairs the deposit with the payout, and holds the coins in between." },
    b: {
      chain: "base",
      rows: [
        ["From", { t: "name", v: "The bridge" }],
        ["To", { t: "addr", v: ALICE_BASE, who: "found" }],
        ["Amount", { t: "amount", v: "USDC worth ≈0.5 BTC" }],
      ],
      note: "Public. The payout goes to Alice's account.",
    },
    linked: true,
    verdict: ["Linked", "Anyone can follow Alice from Bitcoin to Base."],
    who: [
      ["The other side", "The bridge itself."],
      ["A middleman", "The bridge: it sees both sides and holds the coins."],
      ["NEAR Intents", "Not involved."],
    ],
    details: (
      <>
        <Bullets
          items={[
            "Both steps are public: Alice's deposit on Bitcoin and the payout on Base, with their addresses and amounts.",
            "The bridge pairs them. Often the destination is written into the deposit itself, or the bridge's contract logs the pair; either way its own records hold both.",
            "Between the two steps the bridge holds the coins, so Alice trusts it to pay out.",
          ]}
        />
        <p className="mt-3 text-xs text-slate-500">Bridges differ in the details; this is the common case.</p>
      </>
    ),
  },
  {
    key: "near",
    title: "NEAR Intents alone",
    example: "Alice moves 0.5 BTC to Base, as USDC.",
    flow: ["btc", "usdc-base"],
    a: btcOut({ t: "name", v: "A NEAR Intents deposit address" }, "Public. The deposit address is made for this one swap."),
    between: { kind: "link", icon: <NearMark size={14} light />, title: "Linked by NEAR Intents", body: "Its deposit address ties the payout to its destination, and the settlement is public on NEAR. It holds the coin while it settles." },
    b: {
      chain: "base",
      rows: [
        ["From", { t: "name", v: "NEAR Intents" }],
        ["To", { t: "addr", v: ALICE_BASE, who: "found" }],
        ["Amount", { t: "amount", v: "USDC worth ≈0.5 BTC" }],
      ],
      note: "Public. NEAR Intents' explorer finds the swap from its deposit address.",
    },
    linked: true,
    verdict: ["Linked", "Anyone can follow Alice from Bitcoin to Base."],
    who: [
      ["The other side", "A solver fills the trade and sees its amounts."],
      ["A middleman", "NEAR Intents holds the coin while it settles."],
      ["NEAR Intents", "Its 1Click service sees the quote: the amounts and where the coins go."],
    ],
    details: (
      <>
        <Bullets
          items={[
            "1Click makes a deposit address for each quote. The deposit, the settlement on NEAR and the payout are all public, and the deposit address ties the payout to its destination.",
            "Settlement on NEAR is atomic, but the path around it is not: NEAR Intents holds your coin from the deposit until it pays out, and you rely on it to deliver or refund.",
            "Its ZEC deposit address is transparent (we checked the live 1Click API on 2026-10-20). ZEC sent there would leave the shielded pool with its amount on show, so Ferry never sends ZEC to NEAR Intents.",
          ]}
        />
        <Sources links={[["Threat model: NEAR Intents", SRC.near], ["Architecture: NEAR Intents", SRC.nearWhy]]} />
      </>
    ),
  },
  {
    key: "swap",
    title: "One Ferry swap",
    ferry: true,
    example: "Alice swaps 0.5 BTC for shielded ZEC.",
    flow: ["btc", "zec"],
    a: btcOut({ t: "addr", v: "bc1p…9m5k" }, "Looks like any wallet paying another."),
    between: { kind: "none", body: "Nothing on either chain points to the other." },
    b: {
      chain: "zcash",
      rows: [
        ["From", { t: "secret" }],
        ["To", { t: "secret" }],
        ["Amount", { t: "secret" }],
      ],
      note: "Anyone can see that a shielded transaction happened. Not who, to whom, or how much.",
    },
    linked: false,
    verdict: ["Not linked", "The trail ends at an ordinary-looking payment."],
    who: [
      ["The other side", "Your swap partner: the amounts and its own side. Not your wallet, or where your ZEC went."],
      ["A middleman", "None. Nobody holds the coins; the two chains' rules do."],
      ["NEAR Intents", "Not involved."],
    ],
    details: (
      <>
        <Bullets
          items={[
            "Bitcoin: Alice's payment, and the partner's later spend of it, each carry one signature and no script, like any single-key wallet (a Taproot key-path spend).",
            "Zcash: every transaction stays in the shielded pool. Ferry locks ZEC only from a shielded balance, and won't sign anything with a transparent part.",
            "Nothing on one chain refers to the other, and the ZEC is collected after a random wait, so the two don't line up in time.",
            "Selling ZEC for BTC looks the same, the other way round. With USDC or WETH on Base, that side is a visible call to Ferry's contract instead of an ordinary payment.",
          ]}
        />
        <Sources links={[["Threat model: what everyone sees", SRC.world], ["Protocol: privacy", SRC.protocol], ["What the public sees on Base", SRC.base]]} />
      </>
    ),
  },
  {
    key: "route",
    title: "A Ferry private route",
    ferry: true,
    example: "Alice moves 0.5 BTC to Base as USDC, through shielded ZEC.",
    flow: ["btc", "zec", "usdc-base"],
    a: btcOut({ t: "addr", v: "bc1p…9m5k" }, "Looks like any wallet paying another.", true),
    between: {
      kind: "none",
      body: (
        <>
          In between, four shielded <TokenLogo id="zec" size={13} className="inline-block align-[-2px]" /> ZEC transactions and a random pause. Nothing points across.
        </>
      ),
    },
    b: {
      chain: "base",
      rows: [
        ["From", { t: "name", v: "Ferry's swap contract" }],
        ["To", { t: "addr", v: "0x3f…b2d9", who: "unknown" }],
        ["Amount", { t: "amount", v: "USDC worth ≈0.49 BTC", hint: true }],
      ],
      note: "Public, and visibly a Ferry swap. Nothing in it points to Bitcoin.",
    },
    linked: false,
    verdict: ["Not linked on chain", "Two separate swaps. Amounts and timing could still hint."],
    who: [
      ["The other side", "Two different partners. Each sees only its own swap."],
      ["A middleman", "None. Your own Ferry runs both swaps."],
      ["NEAR Intents", "Only if the USDC goes on through it. Then it sees that leg."],
    ],
    details: (
      <>
        <Bullets
          items={[
            "In the app this is a private swap: two Ferry swaps in a row. Swap 1 buys shielded ZEC with the bitcoin and pays it straight into Alice's second Ferry wallet. After a random pause, swap 2 sells that ZEC for USDC, with a different partner.",
            "All four Zcash transactions are shielded, and the two swaps share no key, hash or secret.",
            "Both outer swaps are public on their own chains. On Base, swap 2 is a call to Ferry's contract, with the USDC amount.",
            "The USDC is paid to your node's Base account, the one it uses for every swap there, and that account's own history (where its gas came from, say) is public.",
            "What could still hint: the amounts in and out sit near the two coins' price ratio (testable to within a percent or two), and both times are public. A quiet chain has few candidates. Two partners who compare notes could link the swaps.",
            "What helps: standard amounts, on by default: a route is split into fixed sizes (0.1, 0.25, 0.5, 1 ZEC and up), each its own swap at its own random time, so its legs look like the many single swaps of those sizes. Partners take turns per part. On Base every part pays the same account, so there the parts can be added back up.",
          ]}
        />
        <Sources links={[["Threat model: routes", SRC.routes]]} />
      </>
    ),
  },
];

function Compare() {
  return (
    <section aria-label="Four ways, compared" className={cn(wrap, "mt-10 md:mt-12")}>
      <div className="grid gap-4 md:grid-cols-2 md:gap-y-0 lg:grid-cols-4">
        {COLS.map((c, i) => (
          <Card key={c.key} c={c} i={i} />
        ))}
      </div>
      <p className="mt-4 text-xs text-slate-500 md:mt-0">Example addresses and amounts. The real transactions are further down.</p>
    </section>
  );
}

// One way of doing it. Seven rows that line up across the cards (a subgrid from md up): the title,
// the first chain, what joins them (or doesn't), the second chain, the verdict, who else learns
// what, and the details.
function Card({ c, i }: { c: Col; i: number }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        el.dataset.on = "";
        io.disconnect();
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <article
      ref={ref}
      id={`pv-card-${c.key}`}
      aria-labelledby={`pv-${c.key}`}
      style={{ "--pv-delay": `${300 + i * 250}ms` } as CSSProperties}
      className={cn(
        "pv-card flex scroll-mt-32 flex-col rounded-[24px] border bg-white p-5 md:row-span-7 md:mb-4 md:grid md:grid-rows-subgrid lg:mb-0",
        c.ferry ? "border-slate-300 shadow-[0_20px_48px_-32px_rgba(24,24,27,0.4)]" : "border-slate-200",
      )}
    >
      <header className="mb-4">
        {/* the number, title and coins on one line; from lg (four narrow columns) the number and
            coins share the first line and the title takes the second */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3">
          <span className="hidden lg:order-1 lg:flex" aria-hidden>
            <Num n={i + 1} />
          </span>
          <h2 id={`pv-${c.key}`} className="flex min-w-0 items-center gap-2.5 text-lg font-semibold tracking-tight text-slate-900 lg:order-3 lg:basis-full">
            <span className="lg:hidden" aria-hidden>
              <Num n={i + 1} />
            </span>
            {c.title}
          </h2>
          <Flow ids={c.flow} />
        </div>
        <p className="mt-2 text-sm leading-snug text-slate-600">{c.example}</p>
      </header>
      <LaneBox lane={c.a} />
      <Join between={c.between} />
      <LaneBox lane={c.b} />
      <Verdict linked={c.linked} head={c.verdict[0]} body={c.verdict[1]} />
      <div className="mt-5 border-t border-slate-100 pt-4">
        <p className="text-[11px] font-medium tracking-wider text-slate-500 uppercase">Who can see what</p>
        <dl className="mt-2.5 space-y-2 text-[13px] leading-snug">
          {c.who.map(([k, v]) => (
            <div key={k}>
              <dt className="inline font-medium text-slate-900">{k}: </dt>
              <dd className="inline text-slate-600">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <Fold
        title={<span className="text-[13px] font-medium text-slate-700">What exactly is public</span>}
        className="mt-4 border-t border-slate-100 pt-1 md:self-start"
        buttonClassName="rounded-lg py-2"
        bodyClassName="pt-1 pb-1 text-[13px] leading-relaxed text-slate-600"
      >
        {c.details}
      </Fold>
    </article>
  );
}

// the coins, left to right: BTC → USDC on Base
function Flow({ ids }: { ids: Col["flow"] }) {
  const name = { btc: "BTC", zec: "shielded ZEC", "usdc-base": "USDC on Base" } as const;
  return (
    <span className="flex shrink-0 items-center gap-1 lg:order-2" aria-label={ids.map((id) => name[id]).join(" to ")} role="img">
      {ids.map((id, j) => (
        <span key={id} className="flex items-center gap-1">
          {j > 0 ? <ArrowRight size={11} weight="bold" className="text-slate-400" aria-hidden /> : null}
          {id === "usdc-base" ? <PairLogo pair="usdc-base" size={20} /> : <TokenLogo id={id} size={20} />}
        </span>
      ))}
    </span>
  );
}

const CHAIN: Record<Chain, { name: string; mark: ReactNode; tag: string }> = {
  bitcoin: { name: "Bitcoin", mark: <ChainLogo id="bitcoin" size={16} />, tag: "Public" },
  base: { name: "Base", mark: <ChainLogo id="base" size={16} />, tag: "Public" },
  zcash: { name: "Zcash", mark: <TokenLogo id="zec" size={16} />, tag: "Shielded" },
};

function LaneBox({ lane }: { lane: Lane }) {
  const ch = CHAIN[lane.chain];
  const shielded = lane.chain === "zcash";
  return (
    <section
      aria-label={`On ${ch.name}`}
      className={cn("rounded-2xl border p-3.5", shielded ? "border-[#F4B728]/45 bg-[#FFFBF0]" : "border-slate-200 bg-slate-50/80")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-slate-900">
          {ch.mark}
          {ch.name}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            shielded ? "bg-[#F4B728]/20 text-slate-800" : "border border-slate-200 bg-white text-slate-500",
          )}
        >
          {ch.tag}
        </span>
      </div>
      <dl className="mt-3 space-y-1.5">
        {lane.rows.map(([k, v]) => (
          <div key={k} className="flex min-h-6 items-center justify-between gap-3">
            <dt className="shrink-0 text-xs text-slate-500">{k}</dt>
            <dd className="flex min-w-0 items-center justify-end gap-1.5 text-right text-[13px]">
              <Value v={v} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2.5 text-xs leading-snug text-slate-500">{lane.note}</p>
    </section>
  );
}

function Value({ v }: { v: Val }) {
  switch (v.t) {
    case "secret":
      return <Secret />;
    case "name":
      return <span className="font-medium text-slate-900">{v.v}</span>;
    case "amount":
      return v.hint ? (
        <span className="font-medium text-slate-900 tabular-nums underline decoration-slate-400 decoration-dotted underline-offset-4" title="The amounts in and out sit near the two coins' price ratio: they could hint">
          {v.v}
        </span>
      ) : (
        <span className="font-medium text-slate-900 tabular-nums">{v.v}</span>
      );
    case "addr":
      return (
        <>
          {v.who === "alice" ? <AliceTag /> : null}
          {v.who === "found" ? <AliceTag reveal /> : null}
          {v.who === "unknown" ? <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500">whose?</span> : null}
          <span className="font-data truncate text-slate-900">{v.v}</span>
        </>
      );
  }
}

// Alice's name: on her own address from the start, and on the far side once a link gives it away
function AliceTag({ reveal = false }: { reveal?: boolean }) {
  return (
    <span className={cn("inline-flex shrink-0 rounded-full bg-slate-900 px-1.5 py-px text-[10px] font-semibold text-white", reveal && "pv-reveal")}>Alice</span>
  );
}

function Secret() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#F4B728]/20 px-1.5 py-px text-[12px] font-medium text-slate-800">
      <LockSimple size={11} weight="bold" className="text-[#A87A00]" aria-hidden />
      encrypted
    </span>
  );
}

// what joins the two chains: an ink line through the bridge or NEAR Intents, or nothing at all
function Join({ between }: { between: Between }) {
  // the line runs down from the first chain's mark to the second's (lanes: 1px border + 14px
  // padding + half a 16px mark = 23px)
  if (between.kind === "link") {
    return (
      <div className="relative flex min-h-[104px] flex-col justify-center py-4 pl-12">
        <span className="pv-line absolute inset-y-0 left-[22px] w-0.5 bg-slate-900" aria-hidden />
        <span className="pv-dot absolute top-0 left-[19px] z-10 -mt-1 h-2 w-2 rounded-full bg-slate-900" aria-hidden />
        <span className="pv-dot pv-dot-end absolute bottom-0 left-[19px] z-10 -mb-1 h-2 w-2 rounded-full bg-slate-900" aria-hidden />
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1 text-[13px] font-medium text-white">
          {between.icon}
          {between.title}
        </span>
        <p className="mt-2 text-xs leading-snug text-slate-500">{between.body}</p>
      </div>
    );
  }
  return (
    <div className="relative flex min-h-[104px] flex-col justify-center py-4 pl-12">
      <span className="absolute top-1/2 left-[12px] flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-dashed border-slate-300 bg-white" aria-hidden>
        <LinkBreak size={13} weight="bold" className="text-slate-500" />
      </span>
      <span className="inline-flex w-fit items-center rounded-full border border-dashed border-slate-300 bg-white px-3 py-1 text-[13px] font-medium text-slate-700">No link</span>
      <p className="mt-2 text-xs leading-snug text-slate-500">{between.body}</p>
    </div>
  );
}

function Verdict({ linked, head, body }: { linked: boolean; head: string; body: string }) {
  return (
    <div className={cn("mt-4 flex items-start gap-3 rounded-2xl px-3.5 py-3", linked ? "bg-slate-100" : "bg-[#F4B728]/15")}>
      <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", linked ? "bg-slate-900 text-white" : "bg-white text-slate-900")} aria-hidden>
        {linked ? <Eye size={15} weight="bold" /> : <EyeSlash size={15} weight="bold" />}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-slate-900">{head}</p>
        <p className="text-[13px] leading-snug text-slate-700">{body}</p>
      </div>
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((t) => (
        <li key={t} className="flex gap-2">
          <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-slate-400" aria-hidden />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

function Sources({ links }: { links: [string, string][] }) {
  return (
    <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {links.map(([label, href]) => (
        <Ext key={href} href={href} className="text-slate-500">
          {label}
        </Ext>
      ))}
    </p>
  );
}

function Ext({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cn("inline-flex items-center gap-1 rounded underline-offset-4 transition-colors hover:text-slate-900 hover:underline", className)}>
      {children}
      <ArrowSquareOut size={12} aria-hidden />
    </a>
  );
}

// NEAR Intents, as a small mark: an N on a tile (not its logo); `light` for an ink background
function NearMark({ size = 16, light = false }: { size?: number; light?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className="shrink-0" aria-hidden>
      <rect width="32" height="32" rx="9" className={light ? "fill-white" : "fill-slate-900"} />
      <path d="M10 23V9h2.6l6.8 9.6V9H22v14h-2.6l-6.8-9.6V23z" className={light ? "fill-slate-900" : "fill-white"} />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------
// The limits, plainly

const LIMITS: [string, string][] = [
  [
    "Amounts and timing",
    "Every public chain shows its own amounts and times. In a route, the amount in and the amount out sit near the two coins' price ratio, minutes to hours apart, and on a quiet chain an analyst can test the few candidates. Standard amounts (fixed sizes at random times) blur this; on an EVM chain, where every part pays the same account, the parts can still be added back up.",
  ],
  ["Your swap partner", "It learns the amounts and the deadlines, and your IP address, because the two Ferry nodes talk directly. Use Tor or a VPN if that matters."],
  [
    "Partners who compare notes",
    "A route uses a different partner for each swap, but nobody can prove two names aren't one operator. Two partners who share notes can link your swaps. Today every partner is run by the Ferry team.",
  ],
  ["On Base, a swap looks like a swap", "Every step there is a public call to Ferry's contract, with the amount. Your node uses one account for its swaps there, so they link to each other."],
  ["A called-off swap shows its shape", "On Bitcoin, only a swap that completes looks ordinary. A refund or a penalty is visibly a swap."],
  ["Early software", "Ferry has run on test networks only: 15 live swaps on public test networks, and local tests. Nothing on mainnet, and no independent review."],
];

function Limits() {
  return (
    <section aria-labelledby="pv-limits" className="mt-20 border-t border-slate-100 bg-slate-50/70 py-16 sm:mt-24 sm:py-20">
      <div className={wrap}>
        <h2 id="pv-limits" className={h2}>
          What Ferry can't hide
        </h2>
        <p className="mt-3 max-w-[40rem] text-[17px] leading-relaxed text-slate-600">Said plainly, so you can weigh them yourself.</p>
        <ul className="mt-10 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {LIMITS.map(([t, d]) => (
            <li key={t} className="flex gap-3.5 rounded-[20px] border border-slate-200 bg-white p-5">
              <Warning size={18} weight="duotone" className="mt-0.5 shrink-0 text-slate-700" aria-hidden />
              <div>
                <p className="font-medium text-slate-900">{t}</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{d}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-sm text-slate-500">
          <Ext href={SRC.routes}>What can still link a route's two swaps</Ext>
          <span className="mx-2 text-slate-300" aria-hidden>
            ·
          </span>
          <Ext href={SRC.them}>What the other side learns</Ext>
        </p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// The real transactions

// every ZEC transaction of the regtest run, as mined (docs/evidence/e2e-real-regtest-2026-10-19.txt)
const POOL: [string, string, string, number][] = [
  ["Normal swap", "lock", "ad59673a", 5],
  ["Normal swap", "collect", "4d4914e4", 2],
  ["Called off", "lock", "90579cad", 2],
  ["Called off", "take back", "46ee4dfa", 2],
  ["Penalty", "lock", "1662b575", 2],
];

function Evidence() {
  return (
    <section aria-labelledby="pv-proof" className="border-t border-slate-100 py-16 sm:py-20">
      <div className={wrap}>
        <h2 id="pv-proof" className={h2}>
          Check it yourself
        </h2>
        <p className="mt-3 max-w-[40rem] text-[17px] leading-relaxed text-slate-600">Real transactions from our own runs, and where to look them up.</p>
        <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
          <Proof title="A real Ferry swap, on public test networks" date="2026-10-20">
            <p>
              Two Ferry nodes, both ours, swapped 0.05 test ZEC for 2 test USDC. On Base Sepolia, both steps are calls to Ferry's contract that anyone can open. On the
              Zcash testnet, the two transactions are shielded.
            </p>
            <ul className="mt-4 space-y-2">
              <ProofRow mark={<ChainLogo id="base" size={16} />} label="The lock">
                <Ext href={SEPOLIA.lock} className="font-medium text-slate-900">
                  Basescan
                </Ext>
              </ProofRow>
              <ProofRow mark={<ChainLogo id="base" size={16} />} label="The claim">
                <Ext href={SEPOLIA.claim} className="font-medium text-slate-900">
                  Basescan
                </Ext>
              </ProofRow>
              <ProofRow mark={<ChainLogo id="base" size={16} />} label="Ferry's contract">
                <Ext href={SEPOLIA.contract} className="font-medium text-slate-900">
                  Basescan
                </Ext>
              </ProofRow>
              <ProofRow mark={<TokenLogo id="zec" size={16} />} label="ZEC locked">
                <CopyText value={SEPOLIA.zecLock} head={8} tail={4} />
              </ProofRow>
              <ProofRow mark={<TokenLogo id="zec" size={16} />} label="ZEC collected">
                <CopyText value={SEPOLIA.zecSweep} head={8} tail={4} />
              </ProofRow>
            </ul>
            <Foot href={SRC.sepolia}>The full log</Foot>
          </Proof>

          <Proof title="Every ZEC transaction, checked as mined" date="2026-10-19">
            <p>A full local test with real shielded notes checks each Zcash transaction of a normal, a called-off and a penalty swap as it is mined: no transparent part, and nothing outside the newest shielded pool.</p>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Parts of each ZEC transaction</caption>
                <thead className="bg-slate-50 text-[11px] text-slate-500">
                  <tr>
                    <th scope="col" className="px-2.5 py-2 font-medium sm:px-3">
                      Transaction
                    </th>
                    <th scope="col" className="px-1.5 py-2 text-right font-medium sm:px-2">
                      <abbr title="Transparent" className="no-underline sm:hidden">
                        Transp.
                      </abbr>
                      <span className="hidden sm:inline">Transparent</span>
                    </th>
                    <th scope="col" className="px-1.5 py-2 text-right font-medium sm:px-2">
                      Sapling
                    </th>
                    <th scope="col" className="px-1.5 py-2 text-right font-medium sm:px-2">
                      Orchard
                    </th>
                    <th scope="col" className="px-2.5 py-2 text-right font-medium sm:px-3">
                      Ironwood
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {POOL.map(([story, step, id, n]) => (
                    <tr key={id}>
                      <td className="px-2.5 py-2 text-slate-700 sm:px-3">
                        {story}, {step}
                        <span className="font-data block text-[10px] text-slate-400">{id}…</span>
                      </td>
                      <td className="px-1.5 py-2 text-right font-medium text-slate-900 tabular-nums sm:px-2">0</td>
                      <td className="px-1.5 py-2 text-right font-medium text-slate-900 tabular-nums sm:px-2">0</td>
                      <td className="px-1.5 py-2 text-right font-medium text-slate-900 tabular-nums sm:px-2">0</td>
                      <td className="px-2.5 py-2 text-right text-slate-500 tabular-nums sm:px-3">{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4">
              The same run checks the other side: it downloads the transaction that collects the ZEC and recovers no recipient or amount. With that protection switched
              off, the same check finds both.
            </p>
            <Foot href={SRC.e2e}>The full log</Foot>
          </Proof>

          <Proof title="NEAR Intents, in the open" date="2026-10-20">
            <p>NEAR Intents is public by design: anyone can look a swap up on its own explorer from the deposit address.</p>
            <p className="mt-3">
              Its ZEC deposit address is transparent: we checked the live 1Click API. So Ferry never sends ZEC to NEAR Intents. When you reach another chain through it, Ferry
              does the private hop and NEAR Intents only ever touches the other coin.
            </p>
            <ul className="mt-4 space-y-2">
              <ProofRow mark={<NearMark size={16} />} label="Its explorer">
                <Ext href={NEAR_EXPLORER} className="font-medium text-slate-900">
                  explorer.near-intents.org
                </Ext>
              </ProofRow>
            </ul>
            <Foot href={SRC.nearWhy}>How Ferry and NEAR Intents fit</Foot>
          </Proof>
        </div>
      </div>
    </section>
  );
}

function Proof({ title, date, children }: { title: string; date: string; children: ReactNode }) {
  return (
    <article className="flex min-w-0 flex-col rounded-[24px] border border-slate-200 bg-white p-5 text-sm leading-relaxed text-slate-600 sm:p-6">
      <p className="text-xs text-slate-500 tabular-nums">{date}</p>
      <h3 className="mt-1.5 text-[17px] font-semibold tracking-tight text-slate-900">{title}</h3>
      <div className="mt-3 flex flex-1 flex-col">{children}</div>
    </article>
  );
}

function ProofRow({ mark, label, children }: { mark: ReactNode; label: string; children: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">
      <span className="flex items-center gap-2 text-slate-700">
        {mark}
        {label}
      </span>
      <span className="min-w-0 text-right">{children}</span>
    </li>
  );
}

function Foot({ href, children }: { href: string; children: ReactNode }) {
  return (
    <p className="mt-auto pt-5 text-xs">
      <Ext href={href} className="text-slate-500">
        {children}
      </Ext>
    </p>
  );
}

// ------------------------------------------------------------------------------------------------

function More() {
  return (
    <section aria-label="Read more" className="border-t border-slate-100">
      <div className={cn(wrap, "flex flex-col items-start gap-6 py-14 md:flex-row md:items-center md:justify-between")}>
        <div>
          <p className="text-xl font-semibold tracking-tight text-slate-900">Your ZEC stays shielded the whole way.</p>
          <p className="mt-1 text-slate-600">Every failure case and who you trust is on the safety page.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/app" className="inline-flex h-11 items-center justify-center rounded-full bg-slate-900 px-6 text-sm font-semibold text-white transition-colors hover:bg-slate-800">
            Start a swap
          </Link>
          <Link
            to="/safety"
            className="inline-flex h-11 items-center justify-center rounded-full border border-slate-200 bg-white px-5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900"
          >
            Safety details
          </Link>
          <Link
            to="/how-it-works"
            className="inline-flex h-11 items-center justify-center rounded-full border border-slate-200 bg-white px-5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900"
          >
            How it works
          </Link>
        </div>
      </div>
    </section>
  );
}
