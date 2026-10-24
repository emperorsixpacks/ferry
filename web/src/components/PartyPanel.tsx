import { counterBalance, type Role, type Status, type SwapView, type TimelineEntry } from "../api";
import { btc, coin, offset, short, zec } from "../format";

const ROLE = () => ({
  Z: { has: "has shielded ZEC", wants: `wants ${coin().ticker}`, mine: "z", peer: "b", peerName: "B" },
  B: { has: `has ${coin().ticker}`, wants: "wants shielded ZEC", mine: "b", peer: "z", peerName: "Z" },
});

const OUTCOME: Record<string, string> = { swapped: "Swapped", refunded: "Refunded", punished: "Punished" };

const CHAIN_MARK = (): Record<TimelineEntry["chain"], string> => ({ btc: coin().name, zec: "Zcash", peer: "Message", local: "Local" });

export function PartyPanel({
  role,
  status,
  swap,
  connected,
  error,
  stalled,
}: {
  role: Role;
  status: Status | null;
  swap: SwapView | undefined;
  connected: boolean;
  error: string | null;
  stalled: boolean;
}) {
  const r = ROLE()[role];
  const start = swap?.timeline[0]?.at;
  const outcome = swap?.outcome;
  const won = outcome === "swapped" || (outcome === "punished" && role === "Z");

  return (
    <section className={`party party-${role.toLowerCase()}`} aria-label={`Party ${role}`}>
      <header className="party-head">
        <span className="party-letter" aria-hidden>{role}</span>
        <div>
          <h2>
            {status?.name ?? (role === "Z" ? "Z" : "B")} <span className="party-has">{r.has}</span>
          </h2>
          <p className="party-wants">
            {r.wants}
            <span className={`conn${connected ? " conn-on" : ""}`}>{connected ? "daemon online" : "daemon offline"}</span>
          </p>
        </div>
      </header>
      {!connected && error ? <p className="conn-error" role="alert">{error}</p> : null}

      <dl className="balances">
        <div>
          <dt>Shielded ZEC</dt>
          <dd className="mono" key={`z${status?.balances.zec_shielded_zat}`}>{status ? zec(status.balances.zec_shielded_zat) : "–"}</dd>
        </div>
        <div>
          <dt>{coin().ticker}</dt>
          <dd className="mono" key={`b${status?.balances.btc_sat}`}>{status ? btc(counterBalance(status)) : "–"}</dd>
        </div>
      </dl>

      <div className="state-row">
        <span className="state-label">State</span>
        <span className="state mono">{swap?.state ?? "Idle"}</span>
        {stalled && !outcome ? <span className="badge badge-abort">Stalled</span> : null}
        {outcome ? <span className={`badge${won ? " badge-good" : " badge-abort"}`}>{OUTCOME[outcome]}</span> : null}
      </div>

      <div className="secrets">
        <h3>Key shares</h3>
        <ul>
          <li className="share share-known">
            <span className="share-sym">{r.mine}</span>
            <span>
              {r.mine === "z" ? "Z's share" : "B's share"}, known to {role}
              {swap?.secrets.mine_revealed ? <em> revealed on {coin().name}</em> : null}
            </span>
          </li>
          <li className={`share${swap?.secrets.peer_learned ? " share-learned" : ""}`}>
            <span className="share-sym">{r.peer}</span>
            <span>
              {swap?.secrets.peer_learned ? (
                <>
                  {r.peerName}'s share, read from {r.peerName}'s {revealedIn(role)}
                </>
              ) : (
                <>{r.peerName}'s share, unknown to {role}</>
              )}
            </span>
          </li>
        </ul>
        {swap?.secrets.peer_learned ? (
          <p className="magic" role="status">
            {role} read {r.peer} from {r.peerName}'s {revealedIn(role)} → {role} can now spend the joint Ironwood note
          </p>
        ) : null}
      </div>

      <div className="log">
        <h3>Timeline</h3>
        {swap && start ? (
          <ol>
            {swap.timeline.map((e, i) => (
              <li key={i} className={`entry entry-${e.chain}${e.kind === "secret_extracted" ? " entry-magic" : ""}${e.kind.startsWith("fault") ? " entry-fault" : ""}`}>
                <span className="entry-t mono">{offset(e.at, start)}</span>
                <span className="entry-body">
                  <span className="entry-label">{e.label}</span>
                  {e.txid || e.height != null ? (
                    <span className="entry-meta">
                      <span className="entry-chain">{CHAIN_MARK()[e.chain]}</span>
                      {e.txid ? <span className="mono" title={e.txid}>{short(e.txid, 8, 6)}</span> : null}
                      <span className="mono">{e.height != null ? `height ${e.height}` : "in mempool"}</span>
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">No swap yet. {role === "Z" ? "Z starts one as taker against B's offer." : "B is the maker and waits for a taker."}</p>
        )}
      </div>

      {swap ? (
        <details className="keys">
          <summary>Key material</summary>
          <dl>
            <dt>{r.mine.toUpperCase()}_p (Pallas)</dt>
            <dd className="mono">{short(swap.keys.my_share_point_pallas, 12, 8)}</dd>
            <dt>{r.mine.toUpperCase()}_s (secp256k1)</dt>
            <dd className="mono">{short(swap.keys.my_share_point_secp, 12, 8)}</dd>
            <dt>{r.peer.toUpperCase()}_p, {r.peer.toUpperCase()}_s</dt>
            <dd className="mono">
              {short(swap.keys.peer_share_point_pallas, 8, 4)}, {short(swap.keys.peer_share_point_secp, 8, 4)}
            </dd>
            <dt>DLEQ proof</dt>
            <dd>{swap.keys.dleq_verified ? "verified" : "not yet verified"}</dd>
            <dt>Joint ak, σ</dt>
            <dd className="mono">
              {short(swap.keys.joint_ak, 12, 8)}, {swap.keys.sigma > 0 ? "+1" : "−1"}
            </dd>
            <dt>Lock address</dt>
            <dd className="mono">{short(swap.addresses.btc_lock, 14, 8)}</dd>
            <dt>Joint address</dt>
            <dd className="mono">{short(swap.addresses.zec_joint, 14, 8)}</dd>
          </dl>
        </details>
      ) : null}
    </section>
  );
}

// What revealed the peer's share to `role`: B learns z from Z's redeem (Bitcoin) or claim (EVM),
// Z learns b from B's refund.
function revealedIn(role: Role): string {
  if (coin().kind === "evm") return role === "B" ? "claim" : "refund";
  return role === "B" ? "redeem signature" : "refund signature";
}
