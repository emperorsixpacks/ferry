import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle, Clock, Eye, EyeSlash, Lightning, ShieldCheck, Warning } from "@phosphor-icons/react";
import { Link } from "@/router";
import { Label, Layout } from "../components/Layout";
import { Card, CardContent } from "../components/ui/card";
import { StatusBadge } from "../components/ui/badge";
import { Box, Section } from "./HowItWorks";

// /safety: the threat model in plain language (docs/THREAT-MODEL.md is the same content for the
// repo). Same Docs layout as /how-it-works.

const sections = [
  { id: "trust", label: "Who you trust" },
  { id: "whatif", label: "What if…" },
  { id: "online", label: "Online, or a watchtower" },
  { id: "them", label: "What they learn" },
  { id: "world", label: "What the world sees" },
  { id: "limits", label: "Known limits" },
];

function useActive() {
  const [active, setActive] = useState(sections[0].id);
  useEffect(() => {
    const on = () => {
      let cur = sections[0].id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top - 140 <= 0) cur = s.id;
      }
      setActive(cur);
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return active;
}

export function Safety() {
  const active = useActive();
  return (
    <Layout>
      <div className="space-y-8">
        <div className="space-y-4">
          <p className="font-mono text-xs tracking-widest text-brand-600">DOCUMENTATION</p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">What could go wrong</h1>
          <p className="max-w-3xl text-slate-600">
            Who you have to trust, what happens if the other side disappears or cheats, what they and everyone else get to see, and the limits we know about.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <StatusBadge variant="outline" className="border-brand-200 bg-brand-50/40 text-brand-700">
              <ShieldCheck size={10} weight="fill" />
              Threat model
            </StatusBadge>
            <StatusBadge variant="outline">Testnet</StatusBadge>
            <StatusBadge variant="outline">4 min read</StatusBadge>
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-[220px_1fr] lg:items-start lg:gap-12">
          <aside className="hidden self-start lg:sticky lg:top-24 lg:block">
            <Label className="mb-3">Contents</Label>
            <nav className="flex flex-col border-l border-slate-200">
              {sections.map((s, i) => {
                const on = active === s.id;
                return (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    className={`-ml-px flex items-center gap-3 border-l-2 py-2 pl-3 text-sm transition-colors ${on ? "border-brand-500 font-semibold text-brand-600" : "border-transparent text-slate-600 hover:text-slate-900"}`}
                  >
                    <span className={`font-mono text-[10px] tracking-widest ${on ? "text-brand-500" : "text-slate-400"}`}>{String(i + 1).padStart(2, "0")}</span>
                    <span>{s.label}</span>
                  </a>
                );
              })}
            </nav>
          </aside>

          <div className="min-w-0 space-y-12">
            <Section id="trust" n="01" eyebrow="Who you trust" icon={<ShieldCheck size={18} weight="duotone" className="text-brand-500" />} title="Nobody holds your coins, ever">
              <p>
                There is no exchange, bridge or Ferry server in the middle. At every moment your coins are either in your wallet or locked where the two
                blockchains' own rules decide who gets them. What you do rely on:
              </p>
              <Trust />
            </Section>

            <Section id="whatif" n="02" eyebrow="What if…" icon={<Lightning size={18} weight="duotone" className="text-brand-500" />} title="Pick what goes wrong">
              <p>You have ZEC and want bitcoin; the other side has bitcoin and wants ZEC. They always lock first. Choose a situation to see where both coins end up.</p>
              <WhatIf />
            </Section>

            <Section id="online" n="03" eyebrow="Your one job" icon={<Clock size={18} weight="duotone" className="text-brand-500" />} title="Stay online, or arm a watchtower">
              <p>
                Ferry watches the deadlines and acts for you, but only while it is running. This is true of every swap of this kind, not just Ferry. Being late
                costs the bitcoin side more than the ZEC side. If you can't stay online, a watchtower can meet the deadlines for you.
              </p>
              <Online />
              <Watchtower />
            </Section>

            <Section id="them" n="04" eyebrow="What they learn" icon={<Eye size={18} weight="duotone" className="text-brand-500" />} title="The other side sees the swap, not you">
              <p>Both sides can watch the one shared address made for this swap. That's all they can watch.</p>
              <Them />
            </Section>

            <Section id="world" n="05" eyebrow="What the world sees" icon={<EyeSlash size={18} weight="duotone" className="text-brand-500" />} title="Your ZEC never leaves the shielded pool">
              <p>
                Ferry refuses to lock unless your shielded balance alone covers the swap, and refuses to sign anything with a see-through part. Our end-to-end
                test checks every ZEC transaction after it is mined. From the latest run:
              </p>
              <World />
            </Section>

            <Section id="limits" n="06" eyebrow="Known limits" icon={<Warning size={18} weight="duotone" className="text-brand-500" />} title="What we haven't solved yet">
              <p>Said plainly, so you can weigh them yourself.</p>
              <Limits />
            </Section>

            <Card>
              <CardContent className="space-y-4 py-8 text-center">
                <p className="text-lg font-semibold text-slate-900">Want the details?</p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Link to="/app" className="inline-flex items-center gap-2 rounded bg-brand-500 px-8 py-3 font-semibold text-white transition-colors hover:bg-brand-600">
                    Try a swap
                    <ArrowRight size={14} weight="bold" />
                  </Link>
                  <Link to="/inspect" className="inline-flex items-center gap-2 rounded border border-slate-300 px-6 py-3 font-semibold text-slate-800 transition-colors hover:border-brand-300">
                    Watch the protocol live
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  );
}

// 01 ------------------------------------------------------------------------------------------

function Trust() {
  const items: [string, string, string | null][] = [
    ["The two blockchains", "Zcash and Bitcoin confirm transactions and keep their usual rules.", null],
    ["The maths", "Zcash's shielded pool, Bitcoin's signatures, and one proof that ties your key on one chain to the same key on the other.", "That proof is unaudited"],
    ["Your own Ferry", "It runs on your machine, holds your keys like any wallet, and acts on the deadlines for you.", null],
  ];
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        {items.map(([t, d, warn]) => (
          <Box key={t} label={t}>
            <p className="text-slate-600">{d}</p>
            {warn ? (
              <p className="mt-3 inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-amber-700 uppercase">
                <Warning size={12} weight="fill" />
                {warn}
              </p>
            ) : null}
          </Box>
        ))}
      </div>
      <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <Label className="mb-1">About this demo</Label>
        The public demo runs both sides on one server with test coins, so you can watch a swap without installing anything. In real use, each side runs its
        own Ferry.
      </div>
    </div>
  );
}

// 02 ------------------------------------------------------------------------------------------

type Outcome = { you: string; them: string; why: string; good: "both" | "you" | "them" };

const CASES: { k: string; label: string; o: Outcome }[] = [
  {
    k: "plan",
    label: "Nothing goes wrong",
    o: { you: "The bitcoin", them: "Your ZEC", why: "Claiming the bitcoin reveals your half of the key, which is exactly what opens the ZEC for them.", good: "both" },
  },
  {
    k: "nolock",
    label: "You never send the ZEC",
    o: { you: "Your ZEC, never sent", them: "Their bitcoin, after the deadline", why: "They call the swap off at the deadline and take their bitcoin back.", good: "both" },
  },
  {
    k: "short",
    label: "Your shielded balance is too small",
    o: {
      you: "Your ZEC, untouched",
      them: "Their bitcoin, never locked",
      why: "Ferry won't top up from transparent or other pools, so it turns the swap down before either side locks anything.",
      good: "both",
    },
  },
  {
    k: "wrong",
    label: "The wrong amount arrives",
    o: {
      you: "Your ZEC back",
      them: "Their bitcoin back",
      why: "They never send the piece you need to claim. The swap is called off, and their refund reveals their half, so you can take your ZEC back.",
      good: "both",
    },
  },
  {
    k: "youvanish",
    label: "You send ZEC, then go offline",
    o: {
      you: "Your ZEC back, whenever you return",
      them: "Their bitcoin back",
      why: "They refund at the deadline. The refund reveals their half, so your ZEC is yours to reclaim later.",
      good: "both",
    },
  },
  {
    k: "theyvanish",
    label: "They lock bitcoin, then go offline",
    o: {
      you: "Their bitcoin",
      them: "Nothing",
      why: "After the second deadline you take their bitcoin. Your ZEC stays locked, so for you it ends like a finished swap. Going quiet only hurts the one who went quiet.",
      good: "you",
    },
  },
  {
    k: "both",
    label: "Someone tries to take both",
    o: { you: "—", them: "—", why: "Not possible. Every way out either reveals the half the other side needs, or only opens after a deadline.", good: "both" },
  },
];

function WhatIf() {
  const [k, setK] = useState("plan");
  const c = CASES.find((x) => x.k === k)!;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Scenario">
        {CASES.map((x) => (
          <button
            key={x.k}
            type="button"
            aria-pressed={x.k === k}
            onClick={() => setK(x.k)}
            className={`rounded border px-3 py-2 text-left text-sm transition-colors ${x.k === k ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-brand-300"}`}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div key={k} className="grid gap-3 md:grid-cols-2">
        <Box label="You end up with" hot={c.o.good !== "them"}>
          <p className="py-1 text-lg font-semibold text-slate-900">{c.o.you}</p>
        </Box>
        <Box label="They end up with">
          <p className="py-1 text-lg font-semibold text-slate-900">{c.o.them}</p>
        </Box>
      </div>
      <div className="flex gap-3 rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <CheckCircle size={18} weight="fill" className="mt-0.5 shrink-0 text-brand-500" />
        <p>{c.o.why}</p>
      </div>
    </div>
  );
}

// 03 ------------------------------------------------------------------------------------------

function Online() {
  const D1 = 45;
  const D2 = 80;
  return (
    <Box label="Two deadlines">
      <div className="relative mt-3 h-2 bg-slate-200">
        <div className="absolute inset-y-0 left-0 bg-slate-900" style={{ width: `${D1}%` }} />
        <div className="absolute inset-y-0 bg-slate-400" style={{ left: `${D1}%`, width: `${D2 - D1}%` }} />
        {[D1, D2].map((d) => (
          <div key={d} className="absolute -top-1.5 h-5 w-px bg-brand-500" style={{ left: `${d}%` }} />
        ))}
      </div>
      <div className="relative mt-2 h-4 font-mono text-[10px] tracking-widest text-slate-500 uppercase">
        <span className="absolute left-0">Locked</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-brand-600" style={{ left: `${D1}%` }}>
          Deadline 1
        </span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-brand-600" style={{ left: `${D2}%` }}>
          Deadline 2
        </span>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <div className="rounded border border-slate-200 p-3">
          <Label>If you (ZEC) miss deadline 1</Label>
          <p className="mt-1 text-slate-700">You can no longer claim the bitcoin, but you still get your ZEC back.</p>
        </div>
        <div className="rounded border border-brand-300 bg-brand-50/40 p-3">
          <Label>If they (bitcoin) miss deadline 2</Label>
          <p className="mt-1 text-slate-700">They lose their bitcoin to you. That's what keeps them honest.</p>
        </div>
      </div>
      <p className="mt-4 text-slate-600">
        Ferry also stays clear of the edges: it won't claim or refund right before a deadline, when a transaction stuck in the queue could give a secret away.
      </p>
    </Box>
  );
}

function Watchtower() {
  const cant = ["move your coins anywhere else: whatever it sends pays only you", "act early: the chain itself enforces the deadlines"];
  return (
    <Box label="A watchtower">
      <p className="text-slate-700">
        Once the swap's way back is signed, Ferry can hand a watchtower your signed call-off and your refund (bitcoin side) or penalty (ZEC side). It holds no
        keys. It watches the chain and sends each one on time, even with your machine off. Litecoin works the same way.
      </p>
      <p className="mt-2 text-slate-700">
        For USDC there is nothing to sign in advance: the tower calls the swap contract's refund or penalty itself and pays the fee from its own account. The
        contract pays only the two of you, whoever calls.
      </p>
      <ul className="mt-3 space-y-2">
        {cant.map((c) => (
          <li key={c} className="flex gap-2 text-slate-700">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-brand-500" />
            It can't {c}
          </li>
        ))}
        <li className="flex gap-2 text-slate-700">
          <Warning size={16} className="mt-0.5 shrink-0 text-slate-400" />
          At worst it fails to act (for USDC, also if it runs out of fee money), and you are back to staying online yourself
        </li>
      </ul>
      <div className="mt-4 rounded border border-brand-300 bg-brand-50/40 p-3">
        <Label>If you hold the bitcoin, litecoin or USDC: only your own tower</Label>
        <p className="mt-1 text-slate-700">
          Your refund reveals your half of the shared ZEC key, and for USDC the tower holds that half itself, since the contract's refund needs it. A tower
          that passed it to the other side early could let them take both coins. Ferry won't arm a tower for your side unless you mark it as your own. The ZEC
          side can use any tower: its penalty reveals nothing.
        </p>
      </div>
    </Box>
  );
}

// 04 ------------------------------------------------------------------------------------------

function Them() {
  const sees = ["The amounts and deadlines you agreed on", "That your ZEC reached the shared address", "That it later left", "Your IP address, unless you use Tor or a VPN"];
  const never = ["Where the ZEC went after the swap", "Your balance", "Your other addresses or history"];
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Box label="They can see">
          <ul className="space-y-2">
            {sees.map((s) => (
              <li key={s} className="flex gap-2 text-slate-700">
                <Eye size={16} className="mt-0.5 shrink-0 text-slate-400" />
                {s}
              </li>
            ))}
          </ul>
        </Box>
        <Box label="They never see" hot>
          <ul className="space-y-2">
            {never.map((s) => (
              <li key={s} className="flex gap-2 text-slate-700">
                <EyeSlash size={16} className="mt-0.5 shrink-0 text-brand-500" />
                {s}
              </li>
            ))}
          </ul>
        </Box>
      </div>
      <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <Label className="mb-1">Tested, both ways</Label>
        In the end-to-end test the other side downloads the sweep and recovers no recipient and no amount. A control run with this protection switched off
        shows the same check does catch the leak.
      </div>
    </div>
  );
}

// 05 ------------------------------------------------------------------------------------------

const TXS = [
  ["Normal swap", "Your ZEC sent to the swap", "ad59673a", 5],
  ["Normal swap", "They collect the ZEC", "4d4914e4", 2],
  ["Called off", "Your ZEC sent to the swap", "90579cad", 2],
  ["Called off", "You take it back", "46ee4dfa", 2],
  ["Penalty", "Your ZEC sent to the swap", "1662b575", 2],
] as const;

function World() {
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left font-mono text-[10px] tracking-widest text-slate-500 uppercase">
              <th className="px-4 py-3 font-normal">Story</th>
              <th className="px-4 py-3 font-normal">Transaction</th>
              <th className="px-4 py-3 font-normal">See-through parts</th>
              <th className="px-4 py-3 font-normal">Shielded parts</th>
            </tr>
          </thead>
          <tbody>
            {TXS.map(([story, what, id, n]) => (
              <tr key={id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 text-slate-500">{story}</td>
                <td className="px-4 py-3 text-slate-900">
                  {what} <span className="font-mono text-xs text-slate-400">{id}…</span>
                </td>
                <td className="px-4 py-3 font-mono text-slate-900">0</td>
                <td className="px-4 py-3 font-mono text-brand-600">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Box label="On Bitcoin">
          <p className="text-slate-600">
            When the swap goes to plan, it looks like an ordinary payment from a single-key wallet. When it's called off, the refund or penalty does show the
            swap's shape.
          </p>
        </Box>
        <Box label="Between the two">
          <p className="text-slate-600">
            The ZEC amount is hidden, nothing on one chain refers to the other, and the ZEC is collected after a random wait so it doesn't line up in time with
            the bitcoin.
          </p>
        </Box>
      </div>
    </div>
  );
}

// 06 ------------------------------------------------------------------------------------------

const LIMITS = [
  ["Unaudited cross-chain proof", "The proof tying your two keys together comes from an experimental library. A bug there could break the fairness guarantee."],
  ["Fixed fees on the way back", "The call-off, refund and penalty are signed in advance with a set fee. If fees spike they could confirm slowly. Mainnet needs a fee-bump plan."],
  ["Zcash reorganisations", "Zcash blocks are only probably final, so the bitcoin side waits for several confirmations. A deeper reorganisation is still a risk."],
  ["Not quantum-recoverable", "The shared address uses a key Zcash's quantum-recovery plan doesn't cover. It is single-use and short-lived, like today's FROST multisig setups."],
  ["Testnet only", "Ferry has run real swaps on test networks and in a full local test with real shielded notes, but it has no independent review and has not run on mainnet."],
];

function Limits() {
  return (
    <div className="space-y-2">
      {LIMITS.map(([t, d]) => (
        <div key={t} className="flex gap-4 rounded border border-slate-200 bg-white p-4">
          <Warning size={18} weight="duotone" className="mt-0.5 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">{t}</p>
            <p className="text-slate-600">{d}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
