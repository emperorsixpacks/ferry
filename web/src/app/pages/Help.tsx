import { ArrowRight, BookOpen, ShieldCheck } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link } from "@/router";
import { FaqList } from "../components/FaqList";
import { Layout } from "../components/Layout";
import { FAQ_GROUPS } from "../lib/faq";

// /help: plain answers, grouped, with the two deep pages for anyone who wants more.
export function Help() {
  return (
    <Layout>
      <div className="mx-auto w-full max-w-[680px]">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Help</h1>
        <p className="mt-2 text-slate-600">Short answers to what people ask most. Tap a question to open it.</p>

        <div className="mt-10 space-y-10">
          {FAQ_GROUPS.map((g, i) => (
            <section key={g.title} aria-labelledby={`faq-${i}`}>
              <h2 id={`faq-${i}`} className="mb-3 text-xs font-medium tracking-wider text-slate-500 uppercase">
                {g.title}
              </h2>
              <FaqList items={g.items} />
            </section>
          ))}
        </div>

        <div className="mt-12 grid gap-3 sm:grid-cols-2">
          <Deeper to="/how-it-works" icon={<BookOpen size={20} weight="regular" />} title="The full explanation" body="How a swap works, step by step, in plain words." />
          <Deeper to="/safety" icon={<ShieldCheck size={20} weight="regular" />} title="Every way it can go wrong" body="Who you trust, each failure case, and what each side ends up with." />
        </div>
      </div>
    </Layout>
  );
}

function Deeper({ to, icon, title, body }: { to: string; icon: ReactNode; title: string; body: string }) {
  return (
    <Link to={to} className="group flex flex-col rounded-3xl border border-slate-200 p-5 transition-colors hover:border-slate-300 hover:bg-slate-50">
      <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-700" aria-hidden>
        {icon}
      </span>
      <span className="mt-4 inline-flex items-center gap-1.5 font-medium text-slate-900">
        {title}
        <ArrowRight size={14} weight="bold" className="text-slate-400 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
      </span>
      <span className="mt-1 text-sm text-slate-600">{body}</span>
    </Link>
  );
}
