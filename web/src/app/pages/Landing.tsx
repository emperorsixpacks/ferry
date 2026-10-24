import { ArrowRight, GithubLogo } from "@phosphor-icons/react";
import { Link } from "@/router";
import { btcText } from "@/swap/shared";
import { CipherGrid } from "../components/CipherGrid";
import { CipherSwarm } from "../components/CipherSwarm";
import { LogoMark } from "../components/LogoMark";
import { Reveal } from "../components/Reveal";
import { useLocal } from "../lib/daemon";

// `/`: SealPad's landing pattern, told for Ferry.
export function Landing() {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <Navbar />
      <Hero />
      <Narrative />
      <Guarantees />
      <Lifecycle />
      <FinalCTA />
      <Footer />
    </div>
  );
}

const links = [
  { to: "#guarantees", label: "GUARANTEES" },
  { to: "#flow", label: "HOW IT WORKS" },
  { to: "/how-it-works", label: "DOCS" },
  { to: "/safety", label: "SAFETY" },
  { to: "/inspect", label: "INSPECT" },
];

function Navbar() {
  return (
    <nav className="fixed inset-x-0 top-0 z-50 flex h-20 items-center justify-between border-b border-slate-200 bg-white/80 px-6 backdrop-blur md:px-8">
      <Link to="/" className="flex items-center gap-3">
        <LogoMark size={36} />
        <span className="font-bold tracking-wider text-slate-900">FERRY</span>
      </Link>
      <ul className="hidden items-center gap-10 font-mono text-xs tracking-widest text-slate-700 lg:flex">
        {links.map((l) => (
          <li key={l.label}>
            {l.to.startsWith("#") ? (
              <a href={l.to} className="transition-colors hover:text-brand-600">
                {l.label}
              </a>
            ) : (
              <Link to={l.to} className="transition-colors hover:text-brand-600">
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <Link to="/app" className="bg-slate-900 px-5 py-2.5 text-xs font-medium tracking-tight text-white transition-colors hover:bg-slate-800">
        Launch app
      </Link>
    </nav>
  );
}

function Hero() {
  const d = useLocal();
  const settled = d.list.filter((s) => s.outcome === "swapped").length;
  const offer = d.status?.offer;
  return (
    <section className="relative overflow-hidden border-b border-slate-200 bg-canvas">
      <CipherSwarm />
      <div className="relative mx-auto max-w-7xl px-6 pt-32 pb-24 md:px-8 lg:pt-40 lg:pb-32">
        <div className="lg:grid lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-7">
            <p className="font-mono text-[11px] tracking-[0.18em] text-brand-500 uppercase">Shielded ZEC ⇄ BTC · Atomic swaps</p>
            <h1 className="mt-10 text-5xl leading-[1.02] font-medium tracking-tight text-slate-900 md:text-6xl lg:text-[5.25rem]">
              Shielded ZEC in.
              <br />
              Bitcoin out.
              <br />
              <span className="text-slate-400">No middleman.</span>
            </h1>
            <p className="mt-10 max-w-prose text-lg leading-relaxed text-slate-600">
              Swap with a stranger without trusting them. No bridge, no custodian, and your ZEC never leaves the shielded pool.
            </p>
            <div className="mt-12 flex flex-wrap items-center gap-8">
              <Link to="/app" className="bg-slate-900 px-7 py-3.5 text-sm font-medium tracking-tight text-white transition-colors hover:bg-slate-800">
                Launch app
              </Link>
              <Link to="/how-it-works" className="inline-flex items-center gap-1.5 text-sm text-slate-700 transition-colors hover:text-brand-600">
                How it works
                <ArrowRight size={14} weight="bold" />
              </Link>
            </div>
          </div>
          <div className="mt-20 lg:col-span-5 lg:mt-3 lg:border-l lg:border-slate-200 lg:pl-12">
            <p className="font-mono text-[10px] tracking-[0.18em] text-brand-500 uppercase">Network state</p>
            <p className="mt-8 text-[5.5rem] leading-none font-medium tracking-tight text-slate-900 tabular-nums lg:text-[7.5rem]">{String(settled).padStart(2, "0")}</p>
            <p className="mt-3 text-sm text-slate-500">swaps settled on this daemon</p>
            <div className="mt-10">
              <CipherGrid />
            </div>
            <dl className="mt-16 space-y-7 border-t border-slate-200 pt-8">
              <div>
                <dt className="font-mono text-[10px] tracking-[0.18em] text-slate-400 uppercase">Network</dt>
                <dd className="mt-1.5 text-sm text-slate-900 capitalize">{d.status ? `${d.status.chains.btc.network} Bitcoin, ${d.status.chains.zec.network} Zcash` : "–"}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] tracking-[0.18em] text-slate-400 uppercase">Rate</dt>
                <dd className="mt-1.5 font-mono text-sm text-slate-900">{offer ? `1 ZEC = ${btcText(offer.rate_sat_per_zec)} BTC` : "–"}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

function Narrative() {
  return (
    <section className="border-t border-b border-slate-200 bg-cloud">
      <div className="mx-auto max-w-5xl px-6 py-32 text-center md:px-8 lg:py-48">
        <Reveal direction="fade" duration={1100}>
          <h2 className="text-4xl leading-[1.08] font-medium tracking-tight text-slate-900 md:text-6xl lg:text-7xl">
            Bridges hold your coins.
            <br />
            Unshielding shows them.
            <br />
            <span className="text-brand-500">Ferry does neither.</span>
          </h2>
        </Reveal>
        <Reveal direction="fade" delay={400}>
          <p className="mt-14 font-mono text-[10px] tracking-[0.22em] text-slate-500 uppercase">A private way across</p>
        </Reveal>
      </div>
    </section>
  );
}

const guarantees = [
  { n: "01", title: "No custodian", desc: "Nobody holds your coins in between. Both sides lock their own coins in a way only the swap can open, and the way back is signed before anything moves." },
  { n: "02", title: "Never unshielded", desc: "Your ZEC goes from shielded address to shielded address. Its amount and addresses never appear on chain, before, during or after the swap." },
  { n: "03", title: "An ordinary payment", desc: "On Bitcoin a finished swap is a single-signature payment, like millions of others. Nothing on it points to your Zcash wallet." },
];

function Guarantees() {
  return (
    <section id="guarantees" className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-32 md:px-8 lg:py-40">
        <Reveal>
          <div className="lg:max-w-3xl">
            <p className="font-mono text-[11px] tracking-[0.18em] text-brand-500 uppercase">What you get</p>
            <h2 className="mt-10 text-4xl leading-[1.05] font-medium tracking-tight text-slate-900 md:text-5xl lg:text-[3.5rem]">
              Three guarantees
              <br />
              bridges can't make.
            </h2>
          </div>
        </Reveal>
        <div className="mt-20 grid gap-12 md:grid-cols-3 lg:mt-24 lg:gap-16">
          {guarantees.map((g, i) => (
            <Reveal key={g.n} delay={i * 100}>
              <span className="font-mono text-2xl tracking-tight text-slate-400 tabular-nums">{g.n}</span>
              <div className="mt-6 h-px bg-slate-200" />
              <h3 className="mt-8 text-2xl font-medium tracking-tight text-slate-900">{g.title}</h3>
              <p className="mt-4 text-sm leading-relaxed text-slate-600">{g.desc}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const phases = [
  { n: "01", title: "Bitcoin locked", desc: "The other side locks their bitcoin first, in a way only you can claim." },
  { n: "02", title: "ZEC sealed", desc: "Your ZEC moves to a shielded address made for this swap, which needs both halves of a key to open." },
  { n: "03", title: "You claim", desc: "Claiming the bitcoin shows your half of the key, which is exactly what lets them open the ZEC." },
  { n: "04", title: "Settled", desc: "They sweep the ZEC into their own shielded wallet. If anyone vanishes, a deadline sends every coin home." },
];

function Lifecycle() {
  return (
    <section id="flow" className="border-t border-slate-200 bg-canvas">
      <div className="mx-auto max-w-7xl px-6 py-32 md:px-8 lg:py-40">
        <Reveal>
          <div className="lg:max-w-3xl">
            <p className="font-mono text-[11px] tracking-[0.18em] text-brand-500 uppercase">Lifecycle</p>
            <h2 className="mt-10 text-4xl leading-[1.05] font-medium tracking-tight text-slate-900 md:text-5xl lg:text-[3.5rem]">From lock to settle.</h2>
            <p className="mt-8 max-w-prose text-lg leading-relaxed text-slate-600">
              Every swap moves through four steps. Nobody can take without giving, and nothing waits on trust: the chains enforce each step.
            </p>
          </div>
        </Reveal>
        <div className="mt-20 grid gap-12 md:grid-cols-2 lg:mt-24 lg:grid-cols-4 lg:gap-10">
          {phases.map((p, i) => (
            <Reveal key={p.n} delay={i * 100}>
              <span className="font-mono text-[11px] tracking-[0.18em] text-slate-400 tabular-nums">{p.n}</span>
              <div className="mt-4 h-px bg-slate-200" />
              <h3 className="mt-6 text-xl font-medium tracking-tight text-slate-900">{p.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{p.desc}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  return (
    <section className="border-t border-slate-200 bg-canvas">
      <div className="mx-auto max-w-5xl px-6 py-32 text-center md:px-8 lg:py-48">
        <Reveal>
          <p className="font-mono text-[11px] tracking-[0.18em] text-brand-500 uppercase">Get started</p>
          <h2 className="mt-10 text-4xl leading-[1.02] font-medium tracking-tight text-slate-900 md:text-5xl lg:text-[4rem]">Shielded by default.</h2>
          <p className="mx-auto mt-8 max-w-prose text-lg leading-relaxed text-slate-600">Start a swap or read how it works. Regtest only: no real coins at stake.</p>
          <div className="mt-12 flex flex-wrap items-center justify-center gap-8">
            <Link to="/app" className="bg-slate-900 px-7 py-3.5 text-sm font-medium tracking-tight text-white transition-colors hover:bg-slate-800">
              Launch app
            </Link>
            <Link to="/how-it-works" className="inline-flex items-center gap-1.5 text-sm text-slate-700 transition-colors hover:text-brand-600">
              How it works
              <ArrowRight size={14} weight="bold" />
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  const cols = [
    { title: "PROTOCOL", links: [["Guarantees", "#guarantees"], ["Lifecycle", "#flow"], ["Swap", "/app"]] },
    { title: "RESOURCES", links: [["How it works", "/how-it-works"], ["What could go wrong", "/safety"], ["Protocol inspector", "/inspect"]] },
  ];
  return (
    <footer className="border-t border-slate-200 bg-slate-50 px-6 pt-24 pb-12 md:px-8">
      <div className="mx-auto grid max-w-7xl gap-12 md:grid-cols-3">
        <div>
          <div className="mb-4 flex items-center gap-2.5">
            <LogoMark size={32} />
            <span className="font-bold tracking-wider text-slate-900">FERRY</span>
          </div>
          <p className="max-w-xs text-sm leading-relaxed text-slate-500">
            Atomic swaps between shielded ZEC and bitcoin.
            <br />
            No bridge, no custodian, nothing unshielded.
          </p>
          <span className="mt-4 inline-flex items-center gap-2 text-slate-700">
            <GithubLogo size={18} />
            <span className="text-sm">Open source</span>
          </span>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <h5 className="mb-4 font-mono text-xs tracking-widest text-slate-500">{c.title}</h5>
            <ul className="space-y-3 text-sm text-slate-700">
              {c.links.map(([label, to]) => (
                <li key={label}>
                  {to.startsWith("#") ? (
                    <a href={to} className="transition-colors hover:text-brand-600">
                      {label}
                    </a>
                  ) : (
                    <Link to={to} className="transition-colors hover:text-brand-600">
                      {label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto mt-16 flex max-w-7xl flex-wrap justify-between gap-4 border-t border-slate-200 pt-8 font-mono text-[11px] tracking-[0.12em] text-slate-500">
        <span>© 2026 Ferry</span>
        <div className="flex flex-wrap gap-6">
          <span>Zcash shielded pool</span>
          <span>Bitcoin</span>
        </div>
      </div>
    </footer>
  );
}
