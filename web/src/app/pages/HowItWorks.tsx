import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Bank, Clock, Eye, Key, Lock, Play, Scales } from "@phosphor-icons/react";
import { Link } from "@/router";
import { CipherGrid } from "../components/CipherGrid";
import { Label, Layout } from "../components/Layout";
import { ScrambleText } from "../components/ScrambleText";
import { Card, CardContent } from "../components/ui/card";
import { StatusBadge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

// /how-it-works: the plain-language story in SealPad's Docs layout (sticky contents, numbered
// sections, small cards and callouts). No protocol vocabulary; /inspect has that.

const sections = [
  { id: "problem", label: "The problem" },
  { id: "halves", label: "One key, cut in two" },
  { id: "fair", label: "Bitcoin makes it fair" },
  { id: "deadline", label: "If anyone disappears" },
  { id: "seen", label: "What the world sees" },
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

export function HowItWorks() {
  const active = useActive();
  return (
    <Layout>
      <div className="space-y-8">
        <div className="space-y-4">
          <p className="font-mono text-xs tracking-widest text-brand-600">DOCUMENTATION</p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">How Ferry works</h1>
          <p className="max-w-3xl text-slate-600">
            Ferry lets you swap shielded ZEC for bitcoin with a stranger. You never trust them, nobody holds your coins in between, and your ZEC never leaves
            the shielded pool. Here is how, in five short steps.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <StatusBadge variant="outline" className="border-brand-200 bg-brand-50/40 text-brand-700">
              <Lock size={10} weight="fill" />
              Shielded
            </StatusBadge>
            <StatusBadge variant="outline">No custodian</StatusBadge>
            <StatusBadge variant="outline">5 min read</StatusBadge>
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
            <Section id="problem" n="01" eyebrow="The problem" icon={<Scales size={18} weight="duotone" className="text-brand-500" />} title="Swapping today means giving something up">
              <p>
                To trade ZEC for bitcoin you either hand your coins to someone in the middle, an exchange or a bridge, and hope they hand back the other side,
                or your ZEC has to leave the shielded pool, where its amount and addresses become public.
              </p>
              <Problem />
            </Section>

            <Section id="halves" n="02" eyebrow="One key, cut in two" icon={<Key size={18} weight="duotone" className="text-brand-500" />} title="Your ZEC goes somewhere only two halves can open">
              <p>
                Your ZEC moves to a fresh shielded address made just for this swap. Spending from it takes a key that exists only in two halves: you hold one,
                the other side holds the other. Neither half opens it alone.
              </p>
              <Halves />
            </Section>

            <Section id="fair" n="03" eyebrow="Bitcoin makes it fair" icon={<Bank size={18} weight="duotone" className="text-brand-500" />} title="Taking the bitcoin hands over your half">
              <p>
                The other side locks their bitcoin first, in a way only you can claim. But claiming it means showing your half of the key in public, and that is
                exactly what lets them open the ZEC. Nobody can take without giving.
              </p>
              <Fair />
            </Section>

            <Section id="deadline" n="04" eyebrow="If anyone disappears" icon={<Clock size={18} weight="duotone" className="text-brand-500" />} title="A deadline sends everyone's coins home">
              <p>
                Before anything is locked, both sides sign the way back. If the swap isn't finished by a deadline, it is called off and each side's coins return
                automatically. Going quiet after that only hurts the one who went quiet.
              </p>
              <Deadline />
            </Section>

            <Section id="seen" n="05" eyebrow="What the world sees" icon={<Eye size={18} weight="duotone" className="text-brand-500" />} title="Two chains, nothing that ties them together">
              <p>
                On Zcash, the swap is ciphertext: no amounts, no addresses. On Bitcoin, it looks like an ordinary payment from one wallet to another. Nothing on one
                chain points to the other.
              </p>
              <Seen />
            </Section>

            <Card>
              <CardContent className="space-y-4 py-8 text-center">
                <p className="text-lg font-semibold text-slate-900">That's the whole idea.</p>
                <Link to="/app" className="inline-flex items-center gap-2 rounded bg-brand-500 px-8 py-3 font-semibold text-white transition-colors hover:bg-brand-600">
                  Try a swap
                  <ArrowRight size={14} weight="bold" />
                </Link>
                <p>
                  <Link to="/inspect" className="font-mono text-[11px] tracking-widest text-slate-500 uppercase underline-offset-4 hover:text-brand-600 hover:underline">
                    For developers: watch the protocol live
                  </Link>
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  );
}

function Section({ id, n, eyebrow, icon, title, children }: { id: string; n: string; eyebrow: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4">
      <div className="flex items-center gap-2">
        {icon}
        <p className="font-mono text-[10px] tracking-widest text-brand-600 uppercase">
          {n} — {eyebrow}
        </p>
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h2>
      <div className="space-y-4 text-sm leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

function Box({ label, children, hot }: { label: string; children: ReactNode; hot?: boolean }) {
  return (
    <div className={`rounded border p-4 ${hot ? "border-brand-300 bg-brand-50/40" : "border-slate-200 bg-white"}`}>
      <Label className="mb-2">{label}</Label>
      {children}
    </div>
  );
}

// 01 ------------------------------------------------------------------------------------------

function Problem() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setShown((v) => !v), 3000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Box label="Option A: a middleman">
        <div className="flex items-center gap-3 py-2">
          <span className="grid h-10 w-10 place-items-center bg-slate-900 font-mono text-[10px] text-white">ZEC</span>
          <span className="h-px flex-1 border-t border-dashed border-slate-300" />
          <span className="grid h-10 w-24 place-items-center border border-slate-900 font-mono text-[10px] tracking-widest text-slate-900 uppercase">Exchange</span>
        </div>
        <p className="text-slate-600">Someone else holds your coins. You hope they send the bitcoin back.</p>
      </Box>
      <Box label="Option B: leave the shielded pool" hot={shown}>
        <p className="py-2 font-mono text-base text-slate-900">
          {shown ? (
            <ScrambleText key="plain" text="1.00 ZEC  zs1…→ t1Vx…" duration={700} />
          ) : (
            <span className="text-brand-600">
              <ScrambleText key="enc" text="ENCRYPTED NOTE" mode="live" speed={160} />
            </span>
          )}
        </p>
        <p className="text-slate-600">The amount and the addresses become public, for good.</p>
      </Box>
    </div>
  );
}

// 02 ------------------------------------------------------------------------------------------

function Halves() {
  const [mine, setMine] = useState(true);
  const [theirs, setTheirs] = useState(false);
  const open = mine && theirs;
  const half = (on: boolean, set: (f: (v: boolean) => boolean) => void, label: string) => (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => set((v) => !v)}
      className={`flex items-center justify-between gap-3 rounded border p-3 text-left text-sm transition-colors ${on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-brand-300"}`}
    >
      <span className="inline-flex items-center gap-2 font-medium">
        <Key size={16} weight={on ? "fill" : "regular"} className={on ? "text-brand-500" : ""} />
        {label}
      </span>
      <span className="font-mono text-[10px] tracking-widest uppercase">{on ? "Used" : "Tap to use"}</span>
    </button>
  );
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_260px]">
      <Box label="Shielded address, made for this swap" hot={open}>
        <p className="py-3 font-mono text-3xl font-medium text-slate-900">
          {open ? <ScrambleText key="o" text="1.00 ZEC" duration={600} /> : <span className="text-brand-600"><ScrambleText key="s" text="▓▓▓▓ ZEC" mode="live" speed={150} /></span>}
        </p>
        <p className="text-slate-600">{open ? "Both halves: it opens." : mine || theirs ? "One half isn't enough." : "Locked. Needs both halves."}</p>
      </Box>
      <div className="grid content-start gap-2">
        {half(mine, setMine, "Your half")}
        {half(theirs, setTheirs, "Their half")}
      </div>
    </div>
  );
}

// 03 ------------------------------------------------------------------------------------------

const FAIR = [
  ["The other side locks bitcoin", "Only you can claim it. Nothing has left your wallet yet."],
  ["You claim the bitcoin", "Doing that shows your half of the key, in public, on Bitcoin."],
  ["They pick up your half", "With your half and theirs, they have the whole key."],
  ["They open the ZEC", "You got the bitcoin, they got the ZEC. Neither could take without giving."],
];

function Fair() {
  const [i, setI] = useState(-1);
  const play = () => {
    setI(0);
    [1, 2, 3].forEach((s) => setTimeout(() => setI(s), 1300 * s));
  };
  useEffect(() => {
    const id = setTimeout(play, 500);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className="space-y-2">
      {FAIR.map(([t, d], k) => (
        <div key={k} className={`flex gap-4 rounded border p-4 transition-colors duration-500 ${k === i ? "border-brand-300 bg-brand-50/40" : "border-slate-200 bg-white"}`}>
          <div className={`shrink-0 pt-0.5 font-mono text-xs tracking-widest ${k <= i ? "text-brand-600" : "text-slate-400"}`}>{String(k + 1).padStart(2, "0")}</div>
          <div className="space-y-1">
            <p className={`font-semibold ${k <= i ? "text-slate-900" : "text-slate-400"}`}>{t}</p>
            <p className={k <= i ? "text-slate-600" : "text-slate-400"}>{d}</p>
          </div>
        </div>
      ))}
      <Button variant="outline" size="default" onClick={play} className="mt-2">
        <Play size={12} weight="fill" />
        Play again
      </Button>
    </div>
  );
}

// 04 ------------------------------------------------------------------------------------------

function Deadline() {
  const [run, setRun] = useState(0);
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const v = Math.min(1, (now - start) / 5000);
      setT(v);
      if (v < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run]);
  const DEAD = 0.72;
  const past = t >= DEAD;
  return (
    <Box label="The other side goes silent">
      <div className="relative mt-2 h-2 bg-slate-200">
        <div className="absolute inset-y-0 left-0 bg-slate-900" style={{ width: `${Math.min(t, DEAD) * 100}%` }} />
        {past ? <div className="absolute inset-y-0 bg-brand-500" style={{ left: `${DEAD * 100}%`, width: `${(t - DEAD) * 100}%` }} /> : null}
        <div className="absolute -top-1.5 h-5 w-px bg-brand-500" style={{ left: `${DEAD * 100}%` }} />
      </div>
      <div className="relative mt-2 h-4 font-mono text-[10px] tracking-widest text-slate-500 uppercase">
        <span className="absolute left-0">Swap starts</span>
        <span className="absolute -translate-x-1/2 text-brand-600" style={{ left: `${DEAD * 100}%` }}>
          Deadline
        </span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className={`rounded border p-3 ${past ? "border-brand-300 bg-brand-50/40" : "border-slate-200"}`}>
          <Label>Your ZEC</Label>
          <p className="mt-1 font-medium text-slate-900">{past ? "Back in your wallet" : "Locked for the swap"}</p>
        </div>
        <div className={`rounded border p-3 ${past ? "border-brand-300 bg-brand-50/40" : "border-slate-200"}`}>
          <Label>Their bitcoin</Label>
          <p className="mt-1 font-medium text-slate-900">{past ? "Back in their wallet" : "Locked for the swap"}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-slate-600">{past ? "At the deadline the swap was called off, and both coins went home." : "The clock keeps running."}</p>
        <Button variant="outline" onClick={() => setRun((r) => r + 1)}>
          <Play size={12} weight="fill" />
          Play again
        </Button>
      </div>
    </Box>
  );
}

// 05 ------------------------------------------------------------------------------------------

function Seen() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Box label="What Zcash shows">
          <div className="space-y-1 py-1 font-mono text-xs break-all text-brand-600">
            {[0, 1, 2, 3].map((k) => (
              <p key={k}>
                <ScrambleText text="0000000000000000000000000000" mode="live" speed={120 + k * 20} />
              </p>
            ))}
          </div>
          <div className="mt-3">
            <CipherGrid cols={24} />
          </div>
          <p className="mt-3 text-slate-600">No amounts. No addresses. Only ciphertext.</p>
        </Box>
        <Box label="What Bitcoin shows">
          <table className="w-full font-mono text-xs">
            <tbody>
              {[
                ["bc1p…7f2q", "0.0712 BTC", false],
                ["bc1p…a91x", "0.0041 BTC", true],
                ["bc1q…3k8d", "1.2300 BTC", false],
                ["bc1p…e04m", "0.2500 BTC", false],
              ].map(([a, v, ours]) => (
                <tr key={a as string} className="border-b border-slate-100 last:border-0">
                  <td className={`py-2 ${ours ? "text-slate-900" : "text-slate-500"}`}>{a}</td>
                  <td className={`py-2 text-right ${ours ? "text-slate-900" : "text-slate-500"}`}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-slate-600">One of these is your swap. It looks like every other payment.</p>
        </Box>
      </div>
      <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-4 text-sm">
        <Label>Can the two be linked?</Label>
        <p className="text-slate-700">No. Nothing on one chain points to the other: no shared amount, no shared address, and the shielded side reveals neither.</p>
      </div>
    </div>
  );
}
