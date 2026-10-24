// "What each chain sees": the observer lines from the API, one per public transaction.
import { coin } from "../format";

function split(line: string): [string | null, string] {
  const i = line.indexOf(": ");
  return i > 0 && i < 24 ? [line.slice(0, i), line.slice(i + 2)] : [null, line];
}

export function Observer({ btc, zec }: { btc: string[]; zec: string[] }) {
  return (
    <section className="observer" aria-labelledby="observer-title">
      <div className="observer-head">
        <h2 id="observer-title">What each chain sees</h2>
        <p>Everything a public observer could learn about this swap, one line per transaction.</p>
      </div>

      <div className="observer-cols">
        <div className="obs obs-btc">
          <h3>A {coin().name} observer</h3>
          {btc.length ? (
            <ol>
              {btc.map((l, i) => {
                const [name, rest] = split(l);
                return (
                  <li key={i}>
                    {name ? <span className="obs-tx mono">{name}</span> : null}
                    <span>{rest}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="empty">No transactions yet.</p>
          )}
        </div>

        <div className="obs obs-zec">
          <h3>A Zcash observer</h3>
          {zec.length ? (
            <ol>
              {zec.map((l, i) => {
                const [name, rest] = split(l);
                return (
                  <li key={i}>
                    {name ? <span className="obs-tx mono">{name}</span> : null}
                    <span>{rest}</span>
                    <span className="sealed" aria-label="Encrypted fields">
                      {["value", "sender", "receiver", "memo"].map((f) => (
                        <span key={f} className="sealed-field">
                          <span className="sealed-name">{f}</span>
                          <span className="sealed-bar" />
                        </span>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="empty">No transactions yet.</p>
          )}
        </div>
      </div>

      <dl className="unlink">
        <div>
          <dt>Shared amount</dt>
          <dd>None. The ZEC value is encrypted, so there is nothing to match against the {coin().ticker} amount.</dd>
        </div>
        <div>
          <dt>Shared key</dt>
          <dd>None. {coin().name} shows secp256k1 keys; each Ironwood spend shows only a freshly randomized rk.</dd>
        </div>
        <div>
          <dt>Shared address</dt>
          <dd>None. The joint address is single-use and never published; only the two parties can find its note.</dd>
        </div>
        <div>
          <dt>Timing</dt>
          <dd>The ZEC sweep waits a random delay, so it doesn't line up with the {coin().name} redeem.</dd>
        </div>
      </dl>
    </section>
  );
}
