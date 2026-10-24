import { useEffect, useMemo, useState } from "react";
import { LOCAL_ROLE, startSwap, type Role, type Status, type SwapView } from "../api";
import { short, zec } from "../format";
import { btcFor, btcText } from "./shared";
import { Link } from "../router";
import { useDaemon } from "../useDaemon";
import { phaseOf, stepsOf, transactions, type Phase } from "./steps";
import { clock, clockSeconds, roughDuration, typicalSeconds, unwoundBy, useBlockTimes, type BlockTimes } from "./timing";
import { directionParam, pinScene, pinnedStep, sceneOf } from "./visual/scene";
import { Visual } from "./visual/Visual";
import { Bold } from "./bold/Bold";
import "./swap.css";

const DISMISSED = "ferry.dismissed";

export default function SwapApp() {
  const role = LOCAL_ROLE;
  const d = useDaemon(role);
  const bt = useBlockTimes(d.status);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISSED);
    } catch {
      return null;
    }
  });
  const [starting, setStarting] = useState(false);
  const [amount, setAmount] = useState("1.00");
  const direction = directionParam();

  const latest = useMemo(() => {
    const all = Object.values(d.swaps);
    all.sort((x, y) => (x.timeline[0]?.at ?? "").localeCompare(y.timeline[0]?.at ?? ""));
    return all.at(-1);
  }, [d.swaps]);
  const current = latest && latest.id !== dismissed ? latest : undefined;
  useEffect(() => {
    if (current) setStarting(false);
  }, [current]);

  const dismiss = () => {
    if (!latest) return;
    setDismissed(latest.id);
    try {
      sessionStorage.setItem(DISMISSED, latest.id);
    } catch {
      /* per-tab convenience only */
    }
  };

  const panel =
    !d.connected && !d.status ? (
      <Offline error={d.error} />
    ) : current ? (
      ["progress", "unwinding"].includes(phaseOf(current)) ? (
        <Progress swap={current} status={d.status} bt={bt} />
      ) : (
        <Result swap={current} status={d.status} onAgain={dismiss} />
      )
    ) : starting ? (
      <Starting />
    ) : (
      <SwapForm role={role} status={d.status} bt={bt} amount={amount} setAmount={setAmount} onStarted={() => setStarting(true)} />
    );

  const header = (
    <header className="sw-top">
      <div className="sw-brand">
        <span className="sw-wordmark">Ferry</span>
        <span className="sw-thesis">Shielded ZEC ⇄ BTC. No bridge. No custodian. Nothing unshielded.</span>
      </div>
      <Link to="/how-it-works" className="sw-how">
        How it works →
      </Link>
    </header>
  );

  if (direction === "bold1" || direction === "bold2") {
    return (
      <Bold
        take={direction}
        role={role}
        status={d.status}
        connected={d.connected}
        error={d.error}
        swap={current}
        starting={starting}
        bt={bt}
        amount={amount}
        setAmount={setAmount}
        onStarted={() => setStarting(true)}
        onAgain={dismiss}
      />
    );
  }

  if (direction) {
    let scene = sceneOf(role, current);
    if (starting && !current) scene = { ...scene, step: 1, phase: "progress", caption: "Agreeing the swap with the other side" };
    scene = pinScene(scene, pinnedStep());
    const zat = current?.amounts.zec_zat ?? Math.round(Number(amount) * 1e8);
    const gross = current?.amounts.btc_sat ?? (d.status && Number.isFinite(zat) ? Math.round((zat / 1e8) * d.status.offer.rate_sat_per_zec) : 0);
    const amounts = { zec: Number.isFinite(zat) && zat > 0 ? zec(zat) : "0.00", btc: btcText(btcFor(role, gross, d.status)) };
    return (
      <div className={`vx-page vx-page-${direction}`}>
      <div className={`sw vx vx-${direction}`}>
        {header}
        <main className="vx-grid">
          <figure className="vx-stage">
            <Visual direction={direction} scene={scene} amounts={amounts} />
            <figcaption className="vx-caption" aria-live="polite">
              <span key={scene.caption}>{scene.caption}</span>
            </figcaption>
          </figure>
          <div className="vx-panel">
            <Wallet status={d.status} />
            {panel}
          </div>
        </main>
      </div>
      </div>
    );
  }

  return (
    <div className="sw">
      {header}
      <Wallet status={d.status} />
      <main className="sw-main">{panel}</main>
    </div>
  );
}

function Wallet({ status }: { status: Status | null }) {
  return (
    <dl className="sw-wallet" aria-label="Your wallet">
      <div>
        <dt>Shielded ZEC</dt>
        <dd className="mono" key={`z${status?.balances.zec_shielded_zat}`}>{status ? zec(status.balances.zec_shielded_zat) : "–"}</dd>
      </div>
      <div>
        <dt>BTC</dt>
        <dd className="mono" key={`b${status?.balances.btc_sat}`}>{status ? btcText(status.balances.btc_sat) : "–"}</dd>
      </div>
    </dl>
  );
}

function Offline({ error }: { error: string | null }) {
  return (
    <section className="sw-card sw-offline" role="alert">
      <h1>Can't reach your Ferry daemon</h1>
      <p>{error ?? "Connecting…"}</p>
    </section>
  );
}

function Starting() {
  return (
    <section className="sw-progress" aria-busy="true">
      <h1 className="sw-title">Starting your swap…</h1>
      <p className="sw-lead">Agreeing the terms with the other side.</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------

function SwapForm({
  role,
  status,
  bt,
  amount,
  setAmount,
  onStarted,
}: {
  role: Role;
  status: Status | null;
  bt: BlockTimes;
  amount: string;
  setAmount: (v: string) => void;
  onStarted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offer = status?.offer;
  const zat = Math.round(Number(amount) * 1e8);
  const valid = amount.trim() !== "" && Number.isFinite(zat) && zat > 0;
  const gross = offer && valid ? Math.round((zat / 1e8) * offer.rate_sat_per_zec) : null;
  const fee = offer?.fee_sat;

  let problem: string | null = null;
  if (offer && valid) {
    if (zat < offer.min_zat) problem = `The smallest swap is ${zec(offer.min_zat)} ZEC.`;
    else if (zat > offer.max_zat) problem = `The largest swap is ${zec(offer.max_zat)} ZEC.`;
    else if (role === "Z" && status && zat > status.balances.zec_shielded_zat) problem = `You have ${zec(status.balances.zec_shielded_zat)} shielded ZEC.`;
    else if (role === "B" && status && gross != null && gross > status.balances.btc_sat) problem = `You have ${btcText(status.balances.btc_sat)} BTC.`;
  } else if (amount.trim() !== "" && !valid) problem = "Enter an amount, like 1.00.";

  const submit = async () => {
    if (!valid || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await startSwap(zat, role);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const zecField = (
    <div className="sw-field">
      <label htmlFor="sw-amount">{role === "Z" ? "You send" : "You receive"}</label>
      <div className={`sw-amount${problem ? " sw-amount-bad" : ""}`}>
        <input
          id="sw-amount"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={!!problem}
          aria-describedby="sw-amount-note"
        />
        <span className="sw-unit">ZEC</span>
      </div>
      <p id="sw-amount-note" className={problem ? "sw-note sw-note-bad" : "sw-note"}>
        {problem ?? (role === "Z" ? "From your shielded balance" : "Into your shielded wallet")}
      </p>
    </div>
  );
  const btcSide = gross != null ? btcFor(role, gross, status) : null;
  const btcField = (
    <div className="sw-field">
      <span className="sw-label">{role === "Z" ? "You receive" : "You pay"}</span>
      <div className="sw-amount sw-amount-out" aria-live="polite">
        <span className="mono">{btcSide != null && !problem ? `≈ ${btcText(btcSide)}` : "–"}</span>
        <span className="sw-unit">BTC</span>
      </div>
    </div>
  );

  return (
    <form
      className="sw-card sw-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1 className="sw-title">{role === "Z" ? "Swap shielded ZEC for BTC" : "Buy shielded ZEC with BTC"}</h1>
      {zecField}
      <div className="sw-turn" aria-hidden>
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M12 4v15M6 13l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {btcField}

      <dl className="sw-terms">
        <div>
          <dt>Rate</dt>
          <dd>{offer ? <>1 ZEC = {btcText(offer.rate_sat_per_zec)} BTC</> : "–"}</dd>
        </div>
        <div>
          <dt>Network fee</dt>
          <dd>{fee != null ? <>{fee.toLocaleString("en-US")} sat, {role === "Z" ? "taken from the BTC you receive" : "on top of what you pay"}</> : role === "Z" ? "Taken from the BTC you receive" : "Paid from your BTC wallet"}</dd>
        </div>
        <div>
          <dt>Takes</dt>
          <dd>Typically {roughDuration(typicalSeconds(status, bt))}</dd>
        </div>
      </dl>

      <button type="submit" className="sw-button" disabled={!status || !valid || !!problem || busy}>
        {busy ? "Starting…" : "Swap"}
      </button>
      {error ? (
        <p className="sw-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// ------------------------------------------------------------------------------------------------

function Progress({ swap, status, bt }: { swap: SwapView; status: Status | null; bt: BlockTimes }) {
  const phase = phaseOf(swap);
  const steps = stepsOf(swap);
  const by = unwoundBy(status, swap, bt);
  const z = `${zec(swap.amounts.zec_zat)} ZEC`;
  const b = `${btcText(btcFor(swap.role, swap.amounts.btc_sat, status))} BTC`;
  const mine = swap.role === "Z" ? "ZEC" : "BTC";

  return (
    <section className="sw-progress" aria-live="polite">
      <h1 className="sw-title">
        {phase === "unwinding" ? "Undoing the swap" : swap.role === "Z" ? `Swapping ${z} for ${b}` : `Buying ${z} for ${b}`}
      </h1>
      <p className="sw-safe">
        <Shield />
        <span>
          {phase === "unwinding"
            ? `Nothing is lost. Your ${mine} should be back by about ${by ? clock(by) : "–"}.`
            : `If anything goes wrong, your ${mine} comes back to you automatically by about ${by ? clock(by) : "–"}.`}
        </span>
      </p>
      <ol className="sw-steps">
        {steps.map((s, i) => (
          <li key={i} className={`sw-step sw-step-${s.status}`}>
            <span className="sw-dot" aria-hidden>
              {s.status === "done" ? <Tick /> : null}
            </span>
            <span className="sw-step-text">
              <span className="sw-step-title">{s.title}</span>
              {s.status === "active" && s.note ? <span className="sw-step-note">{s.note}</span> : null}
            </span>
            <span className="sw-step-at">{s.at ? clockSeconds(s.at) : ""}</span>
            <span className="sr-only">{s.status === "done" ? "done" : s.status === "active" ? "in progress" : "not started"}</span>
          </li>
        ))}
      </ol>
      <Details swap={swap} status={status} by={by} />
    </section>
  );
}

const RESULT: Record<Exclude<Phase, "progress" | "unwinding">, "good" | "neutral" | "bad"> = {
  done: "good",
  settled: "good",
  refunded: "neutral",
  lost: "bad",
};

function Result({ swap, status, onAgain }: { swap: SwapView; status: Status | null; onAgain: () => void }) {
  const phase = phaseOf(swap) as keyof typeof RESULT;
  const z = `${zec(swap.amounts.zec_zat)} ZEC`;
  const b = `${btcText(btcFor(swap.role, swap.amounts.btc_sat, status))} BTC`;
  const lockedZec = swap.timeline.some((e) => e.kind === "zec_lock_broadcast");
  const lockedBtc = swap.timeline.some((e) => e.kind === "btc_lock_broadcast");

  let title = "";
  let body = "";
  const feeKnown = status?.offer.fee_sat != null;
  if (phase === "done") {
    if (swap.role === "B") {
      title = `You received ${z}`;
      body = `It's in your shielded wallet. You paid ${b}.`;
    } else if (feeKnown) {
      title = `You received ${b}`;
      body = `${z} left your shielded wallet. The swap is complete.`;
    } else {
      // without the daemon's fee we can't name the exact amount that arrived
      title = "Your BTC has arrived";
      body = `${b}, less the Bitcoin network fee, for ${z} from your shielded wallet.`;
    }
  } else if (phase === "refunded") {
    title = "The swap didn't complete";
    body =
      swap.role === "Z"
        ? lockedZec
          ? `Your ${z} is back in your wallet.`
          : "Nothing left your wallet."
        : lockedBtc
          ? `Your ${b} is back in your wallet.`
          : "Nothing left your wallet.";
  } else if (phase === "settled") {
    title = `You received ${b}`;
    body = `The other side stopped responding, so after the deadline the Bitcoin was released to you. The ${z} you locked stays where it is: you have been paid for it.`;
  } else {
    title = "The swap didn't complete in time";
    body = `Your daemon was offline past the deadline, so the ${b} went to the other side.`;
  }

  return (
    <section className={`sw-result sw-result-${RESULT[phase]}`}>
      <span className="sw-badge" aria-hidden>
        {RESULT[phase] === "good" ? <Tick /> : <Back />}
      </span>
      <h1 className="sw-title">{title}</h1>
      <p className="sw-lead">{body}</p>
      <button type="button" className="sw-button" onClick={onAgain}>
        {phase === "done" || phase === "settled" ? "Swap again" : "Try again"}
      </button>
      <Details swap={swap} status={status} by={null} />
    </section>
  );
}

// ------------------------------------------------------------------------------------------------

export function Details({ swap, status, by }: { swap: SwapView; status: Status | null; by: Date | null }) {
  const txs = transactions(swap);
  const phase = phaseOf(swap);
  return (
    <details className="sw-details">
      <summary>Details</summary>
      <dl className="sw-facts">
        <div>
          <dt>Swap</dt>
          <dd className="mono" title={swap.id}>
            {short(swap.id, 10, 6)}
          </dd>
        </div>
        <div>
          <dt>Amounts</dt>
          <dd>
            {zec(swap.amounts.zec_zat)} ZEC for {btcText(swap.amounts.btc_sat)} BTC
            {swap.role === "Z" && status?.offer.fee_sat ? `, less a ${status.offer.fee_sat.toLocaleString("en-US")} sat network fee` : ""}
          </dd>
        </div>
        {by && (phase === "progress" || phase === "unwinding") ? (
          <div>
            <dt>Safety</dt>
            <dd>
              {swap.role === "Z"
                ? "If the other side stops responding, the swap is called off after a deadline and your ZEC returns to you. If they also never take their Bitcoin back, it is released to you instead."
                : "If the other side stops responding, the swap is called off after a deadline and your BTC returns to you. Keep this app running until then."}
            </dd>
          </div>
        ) : null}
      </dl>
      {txs.length ? (
        <ul className="sw-txs">
          {txs.map((t) => (
            <li key={t.txid}>
              <span className="sw-tx-label">{t.label}</span>
              <span className="mono" title={t.txid}>
                {short(t.txid, 8, 6)}
              </span>
              <span className="sw-tx-h">{t.height != null ? <>block <span className="mono">{t.height}</span></> : "pending"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="sw-privacy">
        {swap.role === "Z" ? "Your ZEC only moves between shielded addresses, so its amount and addresses are never public." : "The ZEC you receive only moves between shielded addresses, so its amount and addresses are never public."}{" "}
        {phase === "done" ? "On Bitcoin the payment looks like any other Taproot payment, and nothing on Bitcoin links to your Zcash wallet." : null}
      </p>
      <Link to="/how-it-works" className="sw-more">
        See every step of the protocol →
      </Link>
    </details>
  );
}

// ------------------------------------------------------------------------------------------------

function Tick() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%">
      <path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Back() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%">
      <path d="M5 12a7 7 0 1 0 2.1-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6.5 3.5v4h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Shield() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden className="sw-shield">
      <path d="M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6l7-3z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M8.8 12.2l2.2 2.2 4.2-4.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
