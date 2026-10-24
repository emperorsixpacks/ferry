import { useEffect, useMemo, useState } from "react";
import { injectStall, startSwap, type Role, type SwapView } from "./api";
import { CrossingChart } from "./components/Crossing";
import { Deadlines } from "./components/Deadlines";
import { Observer } from "./components/Observer";
import { PartyPanel } from "./components/PartyPanel";
import { deriveCrossing, deriveDeadlines, latestEvent } from "./derive";
import { btcShort, zec } from "./format";
import { Link } from "./router";
import "@fontsource/instrument-serif/latin-400";
import "@fontsource/instrument-serif/latin-400-italic";
import "@fontsource/instrument-sans/latin-400";
import "@fontsource/instrument-sans/latin-500";
import "@fontsource/instrument-sans/latin-600";
import "@fontsource/fragment-mono/latin-400";
import "./inspector.css";
import { currentSwapId, useDaemon } from "./useDaemon";

function useNarrow(query = "(max-width: 720px)") {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

function isStalled(v?: SwapView) {
  if (!v) return false;
  const kinds = v.timeline.map((e) => e.kind);
  return kinds.lastIndexOf("fault_injected") > kinds.lastIndexOf("fault_cleared");
}

// Mirrors when a stall changes the story; the daemon has the final say and returns an error otherwise.
const CAN_STALL: Record<Role, string[]> = {
  Z: ["CancelSigned", "BtcLockSeen", "ZecLocked", "RedeemSigReceived"],
  B: ["BtcLocked", "ZecSeen"],
};

const PATH_TITLE = { happy: "The crossing", refund: "Cancelled and refunded", punish: "Cancelled and punished" };

export default function App() {
  const z = useDaemon("Z");
  const b = useDaemon("B");
  const narrow = useNarrow();
  const [amount, setAmount] = useState("1.00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = currentSwapId(z, b);
  const zs = id ? z.swaps[id] : undefined;
  const bs = id ? b.swaps[id] : undefined;
  const crossing = useMemo(() => (zs || bs ? deriveCrossing(zs, bs) : null), [zs, bs]);
  const deadlines = deriveDeadlines(zs ?? bs);
  const last = latestEvent(zs, bs);
  const active = !!(zs || bs) && !crossing?.finished;

  const offer = z.status?.offer ?? b.status?.offer;
  const zat = Math.round(Number(amount) * 1e8);
  const amountOk = Number.isFinite(zat) && (!offer || (zat >= offer.min_zat && zat <= offer.max_zat));
  const quote = offer && amountOk ? Math.round((zat / 1e8) * offer.rate_sat_per_zec) : null;
  const amounts = zs?.amounts ?? bs?.amounts ?? { zec_zat: amountOk ? zat : 1e8, btc_sat: quote ?? 410000 };

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stalled = { Z: isStalled(zs), B: isStalled(bs) };
  const canStall = (role: Role) => {
    const v = role === "Z" ? zs : bs;
    return !!v && active && !stalled.Z && !stalled.B && CAN_STALL[role].includes(v.state) && !(role === "Z" && v.secrets.mine_revealed);
  };

  return (
    <div className="page insp">
      <header className="masthead">
        <h1 className="wordmark">Ferry</h1>
        <p className="thesis">Shielded ZEC ⇄ BTC. No bridge. No custodian. Nothing unshielded.</p>
        <Link to="/" className="back-link">
          ← Back to the app
        </Link>
      </header>

      <form
        className="controls"
        onSubmit={(e) => {
          e.preventDefault();
          if (amountOk && !active) run(() => startSwap(zat));
        }}
      >
        <div className="field">
          <label htmlFor="amount">Z sends</label>
          <div className="input-wrap">
            <input
              id="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={active}
              aria-describedby="quote"
            />
            <span className="unit">ZEC</span>
          </div>
          <span id="quote" className="quote">
            {quote != null ? (
              <>
                for <span className="mono">{btcShort(quote)}</span> BTC at {offer!.rate_sat_per_zec.toLocaleString("en-US")} sat per ZEC
              </>
            ) : offer ? (
              <>Between {zec(offer.min_zat)} and {zec(offer.max_zat)} ZEC</>
            ) : (
              "Waiting for the daemons"
            )}
          </span>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || active || !amountOk || !z.connected}>
          {active ? "Swap in progress" : "Start swap"}
        </button>
        <div className="faults" role="group" aria-label="Demo faults">
          <button type="button" className="btn btn-fault" disabled={busy || !canStall("Z")} onClick={() => id && run(() => injectStall("Z", id))}>
            Make Z stall
          </button>
          <button type="button" className="btn btn-fault" disabled={busy || !canStall("B")} onClick={() => id && run(() => injectStall("B", id))}>
            Make B stall
          </button>
          <p className="fault-hint">
            {stalled.Z
              ? "Z stopped responding. B cancels after T1 and refunds, which lets Z reclaim its ZEC."
              : stalled.B
                ? "B stopped responding. Z cancels after T1 and, with no refund by T2, takes the BTC."
                : "Stall a party mid-swap to see the timelocks take over."}
          </p>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </form>

      <main className="board">
        <PartyPanel role="Z" status={z.status} swap={zs} connected={z.connected} error={z.error} stalled={stalled.Z} />

        <section className="crossing" aria-labelledby="crossing-title">
          <div className="crossing-head">
            <h2 id="crossing-title">{PATH_TITLE[crossing?.path ?? "happy"]}</h2>
            <p className="narration" aria-live="polite">
              {last ? (
                <>
                  <b>{last.who}</b> {last.e.label}
                </>
              ) : (
                "B locks BTC first, so Z never puts ZEC into an unfunded swap."
              )}
            </p>
          </div>
          <CrossingChart
            model={crossing}
            amounts={amounts}
            heights={{ btc: z.status?.chains.btc.height ?? null, zec: z.status?.chains.zec.height ?? null }}
            narrow={narrow}
          />
          <ol className="legs">
            {(crossing?.legs ?? deriveCrossing().legs).map((l) => (
              <li key={l.n + l.title} className={`leg leg-${l.status}${crossing && crossing.path !== "happy" && l.n > 2 ? " leg-abort" : ""}`}>
                <span className="leg-n">{l.n}</span>
                <span className="leg-title">{l.title}</span>
                <span className="leg-meta">{l.status === "done" ? <>height <span className="mono">{l.height}</span></> : l.status === "mempool" ? "in mempool" : l.who === "Z or B" ? "either party" : `by ${l.who}`}</span>
              </li>
            ))}
          </ol>
          <Deadlines
            d={deadlines}
            height={z.status?.chains.btc.height ?? null}
            path={crossing?.path ?? "happy"}
            t1Blocks={(zs ?? bs)?.deadlines.t1_blocks ?? 12}
            t2Blocks={(zs ?? bs)?.deadlines.t2_blocks ?? 24}
          />
          <Observer btc={(zs ?? bs)?.observer.btc ?? []} zec={(zs ?? bs)?.observer.zec ?? []} />
        </section>

        <PartyPanel role="B" status={b.status} swap={bs} connected={b.connected} error={b.error} stalled={stalled.B} />
      </main>

    </div>
  );
}
