import { useMemo, useState } from "react";
import "@fontsource/big-shoulders-display/latin-800";
import "@fontsource/big-shoulders-display/latin-900";
import "@fontsource/martian-mono/latin-300";
import "@fontsource/martian-mono/latin-400";
import "@fontsource/martian-mono/latin-500";
import "@fontsource/instrument-serif/latin-400";
import "@fontsource/instrument-serif/latin-400-italic";
import "@fontsource/instrument-sans/latin-400";
import "@fontsource/instrument-sans/latin-500";
import "@fontsource/instrument-sans/latin-600";
import "@fontsource/fragment-mono/latin-400";
import { startSwap, type Role, type Status, type SwapView } from "../../api";
import { short, zec } from "../../format";
import { Link } from "../../router";
import { btcFor, btcText } from "../shared";
import { phaseOf, stepsOf, transactions } from "../steps";
import { clock, clockSeconds, roughDuration, typicalSeconds, unwoundBy, type BlockTimes } from "../timing";
import { CipherText } from "../visual/ShieldedStream";
import { pinnedStep } from "../visual/scene";
import { Current, type CurrentPalette } from "./Current";
import "./bold.css";

export type BoldTake = "bold1" | "bold2";

// digits and a few same-width marks, so the huge amount never changes width while it churns
const NUM_GLYPHS = "0123456789#%$&";

// Canvas colours per take; the CSS tokens carry the same values.
const PALETTES: Record<BoldTake, CurrentPalette> = {
  bold1: { glyph: "#3f7f86", line: "#9cc7c4", accent: "#ff2e88", font: "500 12px 'Martian Mono', monospace" },
  bold2: { glyph: "#6f78e6", line: "#11131a", accent: "#2b3bff", font: "400 12px 'Fragment Mono', monospace" },
};

// What the page is showing, from this party's side.
type View = "offline" | "idle" | "starting" | "progress" | "unwinding" | "done" | "refunded" | "settled" | "lost";

interface Props {
  take: BoldTake;
  role: Role;
  status: Status | null;
  connected: boolean;
  error: string | null;
  swap?: SwapView;
  starting: boolean;
  bt: BlockTimes;
  amount: string;
  setAmount: (v: string) => void;
  onStarted: () => void;
  onAgain: () => void;
}

const has = (v: SwapView | undefined, ...kinds: string[]) => !!v?.timeline.some((e) => kinds.includes(e.kind));
const confirmed = (v: SwapView | undefined, kind: string) => !!v?.timeline.some((e) => e.kind === kind && e.height != null);

function viewOf(p: Props): View {
  if (!p.connected && !p.status) return "offline";
  if (p.swap) return phaseOf(p.swap);
  return p.starting ? "starting" : "idle";
}

// `?scene=0..5` pins the stage for design work: idle, agreeing, their lock, my lock, claiming, done.
function pinned(sw: SwapView | undefined) {
  const s = pinnedStep();
  if (s == null) return null;
  const z = sw?.role !== "B";
  return {
    view: (s === 0 ? "idle" : s === 5 ? "done" : "progress") as View,
    zecLocked: z ? s >= 3 : s >= 2,
    btcLocked: z ? s >= 2 : s >= 3,
  };
}

export function Bold(props: Props) {
  const { take, role, status, swap, amount } = props;
  let view = viewOf(props);
  const z = role === "Z";

  // what each chain is showing right now
  let zecLocked = z ? confirmed(swap, "zec_lock_broadcast") : has(swap, "zec_confirmed", "zec_note_seen");
  let btcLocked = z ? has(swap, "btc_lock_seen") : confirmed(swap, "btc_lock_broadcast");
  const pin = pinned(swap);
  if (pin) ({ view, zecLocked, btcLocked } = { ...pin });

  const zat = swap?.amounts.zec_zat ?? Math.round(Number(amount) * 1e8);
  const okZat = Number.isFinite(zat) && zat > 0;
  const gross = swap?.amounts.btc_sat ?? (status && okZat ? Math.round((zat / 1e8) * status.offer.rate_sat_per_zec) : 0);
  const zecText = okZat ? zec(zat) : "0.00";
  const btcShown = btcText(btcFor(role, gross, status));

  const zec_ = zecSide(view, z, zecLocked);
  const btc_ = btcSide(view, z, btcLocked);
  const running = view === "progress" || view === "starting" || view === "unwinding";
  const state = useMemo(
    () => ({ energy: running ? 1 : 0, sealed: zec_.sealed, settled: view === "done" || view === "settled" }),
    [running, zec_.sealed, view],
  );

  return (
    <div className={`bd bd-${take} bd-v-${view}${zec_.sealed ? " bd-sealed" : ""}`}>
      <Current palette={PALETTES[take]} state={state} />
      <div className="bd-seam" aria-hidden />

      <header className="bd-top">
        <span className="bd-word">Ferry</span>
        <div className="bd-top-r">
          <span className="bd-meta">No bridge / No custodian / Nothing unshielded</span>
          <Link to="/how-it-works" className="bd-pill">
            How it works
          </Link>
        </div>
      </header>

      <section className="bd-half bd-zec" aria-label="Zcash side">
        <span className="bd-meta">Zcash / shielded pool / {z ? "you send" : "you receive"}</span>
        <h1 className="bd-head">{z ? "Goes in shielded." : "Comes out shielded."}</h1>
        <div className={`bd-amount${zec_.ghost ? " bd-faint" : ""}`}>
          <CipherText text={zecText} sealed={zec_.sealed} className="bd-num" glyphs={NUM_GLYPHS} />
          <span className="bd-unit">ZEC</span>
        </div>
        <p className="bd-say">{zec_.say}</p>
      </section>

      <section className="bd-half bd-btc" aria-label="Bitcoin side">
        <span className="bd-meta">Bitcoin / in the open / {z ? "you get" : "you pay"}</span>
        <h2 className="bd-head">{z ? "Comes out Bitcoin." : "Goes in as Bitcoin."}</h2>
        <div className={`bd-amount${btc_.live ? " bd-live" : ""}${btc_.landed ? " bd-landed" : ""}`}>
          {btc_.live ? (
            <CipherText key="live" text={btcShown} sealed={false} resolveOnMount className="bd-num" glyphs={NUM_GLYPHS} />
          ) : (
            <span className="bd-num bd-ghost">{btcShown}</span>
          )}
          <span className="bd-unit">BTC</span>
        </div>
        <p className="bd-say">{btc_.say}</p>
      </section>

      <Card key={swap?.id ?? "new"} {...props} view={view} zecText={zecText} btcShown={btcShown} />

      <footer className="bd-foot">
        <span className="bd-meta">
          Your wallet <b>{status ? zec(status.balances.zec_shielded_zat) : "–"}</b> ZEC
        </span>
        <span className="bd-meta">
          Your wallet <b>{status ? btcText(status.balances.btc_sat) : "–"}</b> BTC
        </span>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// the two halves

function zecSide(view: View, z: boolean, locked: boolean): { sealed: boolean; ghost: boolean; say: string } {
  if (view === "offline") return { sealed: false, ghost: true, say: "Waiting for your Ferry daemon." };
  if (z) {
    switch (view) {
      case "done":
        return { sealed: true, ghost: false, say: "Gone, and the chain never saw how much." };
      case "settled":
        return { sealed: true, ghost: false, say: "Stays sealed for good. You were paid for it in Bitcoin." };
      case "refunded":
        return { sealed: false, ghost: false, say: "Back in your shielded wallet." };
      case "unwinding":
        return { sealed: locked, ghost: false, say: locked ? "Still sealed, and on its way back to you." : "It never left your wallet." };
      default:
        return locked
          ? { sealed: true, ghost: false, say: "Sealed. The chain shows only ciphertext." }
          : { sealed: false, ghost: false, say: "Only you can see this amount." };
    }
  }
  switch (view) {
    case "done":
      return { sealed: false, ghost: false, say: "In your shielded wallet. Only you can see this amount." };
    case "refunded":
    case "lost":
      return { sealed: false, ghost: true, say: view === "lost" ? "It was never released to you." : "No ZEC changed hands." };
    case "unwinding":
      return { sealed: locked, ghost: !locked, say: "Their ZEC goes back to them." };
    default:
      return locked
        ? { sealed: true, ghost: false, say: "Locked for you. The chain shows only ciphertext." }
        : { sealed: false, ghost: false, say: "What you get, into your shielded wallet." };
  }
}

function btcSide(view: View, z: boolean, locked: boolean): { live: boolean; landed: boolean; say: string } {
  if (view === "offline") return { live: false, landed: false, say: "" };
  if (z) {
    switch (view) {
      case "done":
        return { live: true, landed: true, say: "In your wallet. To anyone watching, an ordinary payment." };
      case "settled":
        return { live: true, landed: true, say: "Released to you after the deadline, because they never took it back." };
      case "refunded":
        return { live: false, landed: false, say: "Back with the other side. Nothing changed hands." };
      case "unwinding":
        return { live: false, landed: false, say: "Going back to the other side." };
      default:
        return locked
          ? { live: true, landed: false, say: "Locked in the open, waiting for the swap." }
          : { live: false, landed: false, say: "What you get, once the other side locks it." };
    }
  }
  switch (view) {
    case "done":
      return { live: true, landed: false, say: "Paid. To anyone watching, an ordinary payment." };
    case "refunded":
      return { live: true, landed: true, say: "Back in your wallet." };
    case "lost":
      return { live: true, landed: false, say: "Went to the other side after the deadline." };
    case "unwinding":
      return { live: true, landed: false, say: "Coming back to you." };
    default:
      return locked
        ? { live: true, landed: false, say: "Your BTC, locked in the open, waiting for the swap." }
        : { live: false, landed: false, say: "What you pay." };
  }
}

// ------------------------------------------------------------------------------------------------
// the card: the one inverted block, and the whole UI

function Card(props: Props & { view: View; zecText: string; btcShown: string }) {
  const { view, role, status, error, swap, bt, onAgain, zecText, btcShown } = props;
  const [open, setOpen] = useState(false);
  const mine = role === "Z" ? "ZEC" : "BTC";
  const mineAmount = role === "Z" ? `${zecText} ZEC` : `${btcShown} BTC`;

  if (view === "offline") {
    return (
      <div className="bd-card bd-card-quiet" role="alert">
        <span className="bd-card-meta">Offline</span>
        <p className="bd-card-title">Can't reach your Ferry daemon</p>
        <p className="bd-card-note">{error ?? "Connecting…"}</p>
      </div>
    );
  }
  if (view === "idle") return <Form {...props} />;
  if (view === "starting") {
    return (
      <div className="bd-card" aria-live="polite">
        <Bar total={5} done={0} />
        <span className="bd-card-meta">Step 1 of 5</span>
        <p className="bd-card-title">Starting your swap</p>
        <p className="bd-card-note">Agreeing the terms with the other side.</p>
      </div>
    );
  }

  const sw = swap!;
  if (view === "progress" || view === "unwinding") {
    const steps = stepsOf(sw);
    const at = steps.findIndex((s) => s.status === "active");
    const by = unwoundBy(status, sw, bt);
    const quiet = view === "unwinding";
    return (
      <div className={`bd-card${quiet ? " bd-card-quiet" : ""}`} aria-live="polite">
        <Bar total={steps.length} done={steps.filter((s) => s.status === "done").length} />
        <span className="bd-card-meta">
          {quiet ? "Undoing the swap" : `Step ${at + 1} of ${steps.length}`}
          {at > 0 && steps[at - 1].at ? <span> / last update {clockSeconds(steps[at - 1].at!)}</span> : null}
        </span>
        <p className="bd-card-title">{at >= 0 ? steps[at].title : "Finishing"}</p>
        <p className="bd-card-note">
          {quiet
            ? `Nothing is lost. Your ${mine} should be back by about ${by ? clock(by) : "–"}.`
            : `If anything goes wrong, your ${mine} comes back to you automatically by about ${by ? clock(by) : "–"}.`}
        </p>
        <DetailsToggle open={open} setOpen={setOpen} />
        {open ? <Details swap={sw} status={status} /> : null}
      </div>
    );
  }

  const copy: Record<string, { meta: string; title: string; note: string; again: string; quiet: boolean }> = {
    done: {
      meta: "Complete",
      title: role === "Z" ? `You received ${btcShown} BTC` : `You received ${zecText} ZEC`,
      note: role === "Z" ? `${zecText} ZEC left your shielded wallet.` : `It's in your shielded wallet. You paid ${btcShown} BTC.`,
      again: "Swap again",
      quiet: false,
    },
    refunded: {
      meta: "Undone",
      title: has(sw, role === "Z" ? "zec_lock_broadcast" : "btc_lock_broadcast") ? `Your ${mineAmount} is back` : "Nothing left your wallet",
      note: "The swap didn't complete, so it was undone. Nothing changed hands.",
      again: "Try again",
      quiet: true,
    },
    settled: {
      meta: "Complete",
      title: `You received ${btcShown} BTC`,
      note: `The other side stopped responding, so after the deadline the Bitcoin was released to you. Your ${zecText} ZEC stays sealed: you've been paid for it.`,
      again: "Swap again",
      quiet: false,
    },
    lost: {
      meta: "Deadline passed",
      title: "The swap didn't complete in time",
      note: `Your daemon was offline past the deadline, so the ${btcShown} BTC went to the other side.`,
      again: "Start a new swap",
      quiet: true,
    },
  };
  const c = copy[view];
  return (
    <div className={`bd-card bd-card-result${c.quiet ? " bd-card-quiet" : ""}${view === "lost" ? " bd-card-alarm" : ""}`} aria-live="polite">
      <span className="bd-card-meta">{c.meta}</span>
      <p className="bd-card-title bd-big">{c.title}</p>
      <p className="bd-card-note">{c.note}</p>
      <div className="bd-row">
        <button type="button" className="bd-go" onClick={onAgain}>
          {c.again}
        </button>
        <DetailsToggle open={open} setOpen={setOpen} />
      </div>
      {open ? <Details swap={sw} status={status} /> : null}
    </div>
  );
}

function Bar({ total, done }: { total: number; done: number }) {
  return (
    <div className="bd-bar" style={{ gridTemplateColumns: `repeat(${total}, 1fr)` }} aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={`bd-tick ${i < done ? "bd-tick-done" : i === done ? "bd-tick-active" : ""}`} />
      ))}
    </div>
  );
}

function DetailsToggle({ open, setOpen }: { open: boolean; setOpen: (f: (v: boolean) => boolean) => void }) {
  return (
    <button type="button" className="bd-link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
      {open ? "Hide details" : "Details"}
    </button>
  );
}

function Details({ swap, status }: { swap: SwapView; status: Status | null }) {
  const txs = transactions(swap);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (txid: string) => {
    navigator.clipboard?.writeText(txid).then(
      () => {
        setCopied(txid);
        setTimeout(() => setCopied((c) => (c === txid ? null : c)), 1400);
      },
      () => {},
    );
  };
  const fee = status?.offer.fee_sat;
  return (
    <div className="bd-details">
      <dl className="bd-facts">
        <div>
          <dt>Swap</dt>
          <dd className="bd-mono" title={swap.id}>
            {short(swap.id, 10, 6)}
          </dd>
        </div>
        <div>
          <dt>Terms</dt>
          <dd>
            {zec(swap.amounts.zec_zat)} ZEC for {btcText(swap.amounts.btc_sat)} BTC
            {swap.role === "Z" && fee ? `, less a ${fee.toLocaleString("en-US")} sat network fee` : ""}
          </dd>
        </div>
      </dl>
      {txs.length ? (
        <ul className="bd-txs">
          {txs.map((t) => (
            <li key={t.txid}>
              <span className={`bd-chain bd-chain-${t.chain}`}>{t.chain === "zec" ? "Zcash" : "Bitcoin"}</span>
              <span>{t.label}</span>
              <button type="button" className="bd-txid" onClick={() => copy(t.txid)} title={`Copy ${t.txid}`}>
                {copied === t.txid ? "copied" : short(t.txid, 8, 6)}
              </button>
              <span className="bd-h">{t.height != null ? `block ${t.height}` : "pending"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="bd-privacy">
        {swap.role === "Z" ? "Your ZEC only moves between shielded addresses" : "The ZEC you receive only moves between shielded addresses"}, so its amount and addresses never
        appear on chain. Nothing on Bitcoin points to your Zcash wallet.
      </p>
      <Link to="/inspect" className="bd-more">
        Watch every step of the protocol
      </Link>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------

function Form({ role, status, bt, amount, setAmount, onStarted, btcShown }: Props & { btcShown: string }) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const offer = status?.offer;
  const zat = Math.round(Number(amount) * 1e8);
  const valid = amount.trim() !== "" && Number.isFinite(zat) && zat > 0;
  const gross = offer && valid ? Math.round((zat / 1e8) * offer.rate_sat_per_zec) : 0;
  let problem: string | null = null;
  if (amount.trim() === "") problem = "Enter how much ZEC.";
  else if (!valid) problem = "Enter an amount, like 1.00.";
  else if (offer) {
    if (zat < offer.min_zat) problem = `The smallest swap is ${zec(offer.min_zat)} ZEC.`;
    else if (zat > offer.max_zat) problem = `The largest swap is ${zec(offer.max_zat)} ZEC.`;
    else if (role === "Z" && status && zat > status.balances.zec_shielded_zat) problem = `You have ${zec(status.balances.zec_shielded_zat)} shielded ZEC.`;
    else if (role === "B" && status && gross > status.balances.btc_sat) problem = `You have ${btcText(status.balances.btc_sat)} BTC.`;
  }

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setFail(null);
    try {
      await startSwap(zat, role);
      onStarted();
    } catch (e) {
      setFail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const err = problem ?? fail;

  return (
    <form
      className="bd-card bd-card-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className={`bd-field${problem ? " bd-field-bad" : ""}`}>
        <span>{role === "Z" ? "You send" : "You receive"}</span>
        <input inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!problem} aria-describedby="bd-note" />
        <em>ZEC</em>
      </label>
      <div className="bd-get">
        <span>{role === "Z" ? "You get" : "You pay"}</span>
        <strong>{problem && valid === false ? "–" : `≈ ${btcShown} BTC`}</strong>
      </div>
      <button type="submit" className="bd-go" disabled={!status || !!problem || busy}>
        {busy ? "Starting…" : "Swap"}
      </button>
      <p id="bd-note" className={`bd-card-note${err ? " bd-err" : ""}`} role={err ? "alert" : undefined}>
        {err ??
          (offer
            ? `Rate 1 ZEC = ${btcText(offer.rate_sat_per_zec)} BTC. ${offer.fee_sat != null ? `${offer.fee_sat.toLocaleString("en-US")} sat network fee. ` : ""}Typically ${roughDuration(typicalSeconds(status, bt))}.`
            : "Waiting for your daemon.")}
      </p>
    </form>
  );
}
