import { useEffect, useMemo, useState } from "react";
import type { Direction, PairId } from "@/api";
import { ZEC, defaultPick, isNear, isPair, isToken, nearToken, pickOn, resolvePath, type Path, type PathCtx, type Side, type Token } from "../../../server/paths.mjs";
import { useLocal } from "./daemon";
import { useNear } from "./near";
import { useRoutes } from "./routes";

// The swap card's two coins, any coin on either side (server/paths.mjs says which way each pair goes
// and whether this server runs it), and what this server runs, for that.

export * from "../../../server/paths.mjs";
export type { Path, PathCtx, Side, Token } from "../../../server/paths.mjs";

export interface Pick {
  sell: Token;
  buy: Token;
}

// The opt-out from a private swap, for two coins: NEAR Intents alone. `available`: NEAR Intents takes
// both coins here; `on`: the person chose it for these two (remembered per pair).
export interface OptOut {
  on: boolean;
  available: boolean;
  set: (on: boolean) => void;
}

// What every card on /app gets: the two coins, their path, what this server runs, and the two ways
// to change them (a coin picked on a side, the arrow). `blocked`: why nothing can start now.
export interface CardProps {
  pick: Pick;
  path: Path;
  ctx: PathCtx;
  onPick: (side: Side, token: Token) => void;
  onFlip: () => void;
  blocked: string | null;
  optOut?: OptOut | null;
}

// What this server runs: its daemons each way, its router, NEAR Intents.
export function usePathCtx(): PathCtx {
  const d = useLocal();
  const routes = useRoutes();
  const near = useNear();
  return useMemo(() => {
    const info = near.info;
    return {
      ready: d.known,
      sell: d.pairs.filter((p) => p.sell.daemon).map((p) => p.id),
      buy: d.pairs.filter((p) => p.buy.daemon).map((p) => p.id),
      routes: routes.legs,
      near:
        info === undefined
          ? undefined
          : !info || !info.available
            ? null
            : {
                tokens: Object.fromEntries(near.tokens.map((t) => [t.assetId, { symbol: t.symbol, blockchain: t.blockchain, ferry: t.ferry }])),
                // sell, buy and direct (NEAR Intents alone)
                runs: info.execution,
                reason: info.reason,
                vias: info.vias,
                compose: info.compose ?? null,
              },
    };
  }, [d.known, d.pairs, routes.legs, near.info, near.tokens]);
}

// ------------------------------------------------------------------------------------------------
// the pick: what the URL names, else what this browser remembers

const KEY = "ferry.pick";
const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, v: string) => {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    /* private window: the pick lasts this page */
  }
};
const both = (sell: string | null | undefined, buy: string | null | undefined): Pick | null => (sell && buy && isToken(sell) && isToken(buy) ? { sell: sell as Token, buy: buy as Token } : null);
const oriented = (t: Token, dir: Direction): Pick => (dir === "sell" ? { sell: ZEC, buy: t } : { sell: t, buy: ZEC });
const isDir = (v: string | null): v is Direction => v === "sell" || v === "buy";

// How the card starts: "url" a pick the link names (kept even if this server can't run it, and the
// card says why); "stored" one this browser remembers (dropped for the default when this server
// can't run it); "legacy" the direction and pair the page followed before there was a pick.
type Start = { pick: Pick | null; source: "url" | "stored" | "legacy" | "picked" };

function start(): Start {
  const q = new URLSearchParams(window.location.search);
  const url = both(q.get("sell"), q.get("buy")) ?? both(q.get("from"), q.get("to"));
  if (url) return { pick: url, source: "url" };
  const dir = q.get("dir");
  const near = q.get("near");
  if (near) return { pick: oriented(nearToken(near), isDir(dir) ? dir : (read("ferry.direction") as Direction) === "buy" ? "buy" : "sell"), source: "url" };
  // remembered: the pick, else an older page's private swap or NEAR asset
  const [s, b] = (read(KEY) ?? "").split(">");
  const route = (read("ferry.route") ?? "").split(">");
  const oldNear = read("ferry.near");
  const stored = both(s, b) ?? both(route[0], route[1]) ?? (oldNear ? oriented(nearToken(oldNear), read("ferry.direction") === "buy" ? "buy" : "sell") : null);
  if (stored) {
    // ?dir= turns a remembered ZEC swap round; a coin-to-coin one gives way to the page's own pair
    if (isDir(dir) || q.get("pair")) {
      const t = stored.sell === ZEC ? stored.buy : stored.buy === ZEC ? stored.sell : null;
      return t && isDir(dir) && !isPair(t) ? { pick: oriented(t, dir), source: "stored" } : { pick: null, source: "legacy" };
    }
    return { pick: stored, source: "stored" };
  }
  return { pick: null, source: "legacy" };
}

export const storePick = (p: Pick) => write(KEY, `${p.sell}>${p.buy}`);

// the pairs the person opted out of a private swap for (NEAR Intents alone), "sell>buy"
const PUBLIC_KEY = "ferry.public";
function readPublic(): Set<string> {
  try {
    const v = JSON.parse(read(PUBLIC_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
const PRIVATE_KINDS = ["route", "route-near", "near-route", "near-near"];

export interface Selection {
  // null while what this server runs is still unknown and nothing names a pick
  pick: Pick | null;
  path: Path | null;
  // the opt-out for two coins (null: these two aren't coin to coin)
  optOut: OptOut | null;
  set: (p: Pick) => void;
  // a coin picked on one side (the other side's coin swaps them)
  pickSide: (side: Side, token: Token) => void;
  flip: () => void;
}

// The card's pick, with the DaemonProvider kept on the pair and direction of a ZEC swap.
export function useSelection(ctx: PathCtx): Selection {
  const d = useLocal();
  const [state, setState] = useState<Start>(start);
  let pick = state.pick;
  if (state.source === "legacy" && ctx.ready) pick = isPair(d.pair) ? oriented(d.pair, d.dir) : null;
  // a remembered pick this server can't run gives way to the default
  if ((state.source === "stored" || state.source === "legacy") && ctx.ready && (!pick || resolvePath(pick.sell, pick.buy, ctx).available === false)) pick = defaultPick(ctx);
  // private by default; NEAR Intents alone only where the person opted out, for these two coins
  const [publics, setPublics] = useState<Set<string>>(readPublic);
  const privatePath = pick ? resolvePath(pick.sell, pick.buy, ctx) : null;
  const publicPath = pick && privatePath && PRIVATE_KINDS.includes(privatePath.kind) ? resolvePath(pick.sell, pick.buy, ctx, { public: true }) : null;
  const pickKey = pick ? `${pick.sell}>${pick.buy}` : "";
  const optOut: OptOut | null =
    pick && publicPath
      ? {
          on: publics.has(pickKey) && publicPath.available === true,
          available: publicPath.available === true,
          set: (on) => {
            const next = new Set(publics);
            if (on) next.add(pickKey);
            else next.delete(pickKey);
            setPublics(next);
            write(PUBLIC_KEY, JSON.stringify([...next]));
          },
        }
      : null;
  const path = optOut?.on ? publicPath : privatePath;

  // follow the daemon of a ZEC swap: its direction, and its pair
  const follow = (p: Pick) => {
    const r = resolvePath(p.sell, p.buy, ctx);
    if (!r.available || !r.dir) return;
    if (d.dir !== r.dir) d.chooseDirection(r.dir);
    if (r.pair && d.pair !== r.pair) d.choosePair(r.pair as PairId, r.dir);
  };
  const set = (p: Pick) => {
    setState({ pick: p, source: "picked" });
    storePick(p);
    follow(p);
  };
  // a pick the page started with (a link, a remembered one) once the server said what it runs
  const want = path?.available && path.dir ? `${path.dir}|${path.pair ?? ""}` : "";
  useEffect(() => {
    if (want && pick) follow(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);
  return {
    pick,
    path,
    optOut,
    set,
    pickSide: (side, token) => pick && set(pickOn(pick, side, token)),
    flip: () => pick && set({ sell: pick.buy, buy: pick.sell }),
  };
}

// whether the followed daemon is the one this ZEC swap runs on
export function following(path: Path, d: { dir: Direction; pair: PairId }): boolean {
  if (!path.dir) return true;
  return d.dir === path.dir && (!path.pair || d.pair === path.pair);
}

// a coin's name for people: "ZEC", "BTC", "SOL"
export const nearAssetOf = (t: Token): string | null => (isNear(t) ? t.slice(5) : null);
