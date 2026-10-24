import { useEffect, useMemo, useState } from "react";
import { getStatus, getSwaps, getWithdrawals, pairChain, type Addresses, type PairId, type SendAsset, type Status, type SwapView, type Withdrawal } from "@/api";
import { CHAIN_NAMES, chainOfNetwork, coinOf, isMainnet, networkLabel } from "@/format";
import { useLocal } from "./daemon";
import { pairName } from "./pairs";
import type { ReceiveCoin } from "./receive";

// The node's wallet, for /wallet: every daemon the UI server fronts holds coins of its own (a Z
// daemon the ZEC it sells and what that earns, a B daemon what it buys ZEC with and the ZEC it
// bought; an EVM daemon also its gas ETH). The page shows them by coin, and says which side of the
// node holds what only where it matters: adding funds and sending them out.

// One of the person's daemons: `side` sell (Z) or buy (B), for `pair`.
export interface Node {
  base: string;
  side: "sell" | "buy";
  pair: PairId;
  status: Status | null;
}

export function useNodes(): Node[] {
  const d = useLocal();
  return useMemo(() => {
    const seen = new Map<string, Node>();
    for (const p of d.pairs)
      for (const side of ["sell", "buy"] as const) {
        const s = p[side];
        if (!s.daemon || seen.has(s.daemon)) continue;
        // the followed daemon's live status is fresher than the probe's
        seen.set(s.daemon, { base: s.daemon, side, pair: p.id, status: s.daemon === d.daemon && d.status ? d.status : s.status });
      }
    return [...seen.values()];
  }, [d.pairs, d.daemon, d.status]);
}

// Polls `load` for each base every `ms` (and when the bases change): base → its last answer, or the
// error. `on` false: nothing.
function usePoll<T>(bases: string[], load: (base: string) => Promise<T>, ms: number, on = true): { data: Record<string, T>; errors: Record<string, string>; refresh: () => void } {
  const [data, setData] = useState<Record<string, T>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [kick, setKick] = useState(0);
  const key = bases.join(",");
  useEffect(() => {
    if (!on || !bases.length) return;
    let alive = true;
    const run = () =>
      Promise.all(
        bases.map((b) =>
          load(b).then(
            (v) => {
              if (!alive) return;
              setData((x) => ({ ...x, [b]: v }));
              setErrors((x) => {
                if (!(b in x)) return x;
                const { [b]: _, ...rest } = x;
                void _;
                return rest;
              });
            },
            (e: Error) => alive && setErrors((x) => ({ ...x, [b]: e.message })),
          ),
        ),
      );
    run();
    const id = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on, ms, kick]);
  return { data, errors, refresh: () => setKick((n) => n + 1) };
}

// ------------------------------------------------------------------------------------------------
// coins

export type CoinKind = "zec" | "btc" | "ltc" | "token" | "eth";

// What one daemon holds of one coin, in base units. `inSwap`: what its live swaps hold of it, locked
// or about to be; `free` excludes the part still in the wallet (sends use free coins only).
export interface Holding {
  node: Node;
  asset: SendAsset;
  units: bigint;
  free: bigint;
  inSwap: bigint;
}

export interface Coin {
  // "zec", a pair ("btc", "usdc-base"), or an EVM chain's gas ("eth:base-sepolia")
  key: string;
  kind: CoinKind;
  label: string;
  ticker: string;
  decimals: number;
  network: string;
  networkName: string;
  mainnet: boolean;
  // its logo: ZEC, a pair, or ETH on a chain
  logo: { pair: PairId | "zec" } | { eth: string | null };
  holdings: Holding[];
  total: bigint;
  free: bigint;
  inSwap: bigint;
}

const big = (v: unknown): bigint => {
  try {
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.max(0, Math.floor(v)));
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  } catch {
    /* not an amount */
  }
  return 0n;
};
const LOCKS = { Z: "zec_lock_broadcast", B: "btc_lock_broadcast" };

// what a daemon's live swaps hold of its own coin: Z the ZEC it sells, B the coin it pays with
function heldBy(status: Status, swaps: SwapView[], asset: SendAsset): { inSwap: bigint; inWallet: bigint } {
  let inSwap = 0n;
  let inWallet = 0n;
  const role = status.role;
  const mine = (role === "Z" && asset === "zec") || (role === "B" && (asset === "btc" || asset === "token"));
  if (!mine) return { inSwap, inWallet };
  for (const s of swaps) {
    if (s.outcome || s.role !== role) continue;
    const n = big(role === "Z" ? s.amounts.zec_zat : s.amounts.btc_sat);
    inSwap += n;
    if (!s.timeline.some((e) => e.kind === LOCKS[role])) inWallet += n;
  }
  return { inSwap, inWallet };
}

// The coins the node holds, by coin: shielded ZEC first, then each pair's coin, then gas.
export function coinsOf(nodes: Node[], statuses: Record<string, Status>, swaps: Record<string, SwapView[]>): Coin[] {
  const coins = new Map<string, Coin>();
  const add = (key: string, make: () => Omit<Coin, "holdings" | "total" | "free" | "inSwap">, h: Holding) => {
    const c = coins.get(key) ?? { ...make(), holdings: [], total: 0n, free: 0n, inSwap: 0n };
    c.holdings.push(h);
    c.total += h.free + h.inSwap;
    c.free += h.free;
    c.inSwap += h.inSwap;
    coins.set(key, c);
  };
  for (const node of nodes) {
    const status = statuses[node.base] ?? node.status;
    if (!status) continue;
    const list = swaps[node.base] ?? [];
    const holding = (asset: SendAsset, units: bigint): Holding => {
      const { inSwap, inWallet } = heldBy(status, list, asset);
      const free = units > inWallet ? units - inWallet : 0n;
      return { node: { ...node, status }, asset, units, free, inSwap };
    };
    const zecNet = status.chains.zec.network;
    add("zec", () => ({ key: "zec", kind: "zec", label: "Shielded ZEC", ticker: "ZEC", decimals: 8, network: zecNet, networkName: networkLabel(zecNet, "zec"), mainnet: isMainnet(zecNet), logo: { pair: "zec" } }), holding("zec", big(status.balances.zec_shielded_zat)));
    const c = coinOf(status, pairChain(node.pair));
    const net = status.chains.btc.network;
    if (c.kind === "evm") {
      const name = networkLabel(net, "evm");
      add(node.pair, () => ({ key: node.pair, kind: "token", label: c.ticker, ticker: c.ticker, decimals: c.decimals, network: net, networkName: name, mainnet: isMainnet(net), logo: { pair: node.pair } }), holding("token", big(status.balances.token_units ?? status.balances.btc_sat)));
      add(`eth:${net}`, () => ({ key: `eth:${net}`, kind: "eth", label: "ETH", ticker: "ETH", decimals: 18, network: net, networkName: name, mainnet: isMainnet(net), logo: { eth: chainOfNetwork(net) ?? pairChain(node.pair) } }), holding("eth", big(status.balances.eth_wei ?? "0")));
    } else {
      const kind = c.id === "ltc" ? "ltc" : "btc";
      add(node.pair, () => ({ key: node.pair, kind, label: c.asset, ticker: c.ticker, decimals: 8, network: net, networkName: networkLabel(net, kind), mainnet: isMainnet(net), logo: { pair: node.pair } }), holding("btc", big(status.balances.btc_sat)));
    }
  }
  const order = (k: string) => (k === "zec" ? 0 : k.startsWith("eth:") ? 2 : 1);
  return [...coins.values()].sort((a, b) => order(a.key) - order(b.key));
}

// which side of the node a holding is on, in plain words: "Selling ZEC for BTC", "Buying ZEC with USDC"
export function sideName(node: Node): string {
  const t = pairName(node.pair).ticker;
  return node.side === "sell" ? `Selling ZEC for ${t}` : `Buying ZEC with ${t}`;
}

// Where funds can usefully be added: the sides that spend the coin in swaps (ZEC: the selling sides;
// a coin: the buying sides; gas: every EVM side, as each pays its own), else any.
export function fundOptions(coin: Coin): Holding[] {
  if (coin.kind === "eth") return coin.holdings;
  const want = coin.kind === "zec" ? "sell" : "buy";
  const useful = coin.holdings.filter((h) => h.node.side === want);
  return useful.length ? useful : coin.holdings;
}

// Where to add funds first: the first side that spends it, a buying side for gas
export const fundFirst = (coin: Coin): Holding => fundOptions(coin).find((h) => coin.kind !== "eth" || h.node.side === "buy") ?? fundOptions(coin)[0];

// Where to send from first: the most free coins.
export const sendFirst = (coin: Coin): Holding => [...coin.holdings].sort((a, b) => (b.free > a.free ? 1 : b.free < a.free ? -1 : 0))[0];

// Whether a daemon can send coins out (the "withdraw" feature), and preview a send's fee.
export const canSend = (s: Status | null) => !!s?.features?.includes("withdraw");
export const canPreview = (s: Status | null) => !!s?.features?.includes("withdraw_preview");

// ------------------------------------------------------------------------------------------------
// amounts

// base units → "4.99", "0.05", "125.5": at least two places, at most `places`, no trailing zeros
export function unitsText(units: bigint, decimals: number, places = Math.min(decimals, 8)): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  let frac = s.slice(s.length - decimals, s.length - decimals + places).replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${Number(whole).toLocaleString("en-US")}.${frac}`;
}

// "1.5" → base units; null when it isn't an amount of this coin
export function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt((w || "0") + f.padEnd(decimals, "0"));
}

// "4.99" for an input: every place it has, no grouping
export function inputText(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${s.slice(0, s.length - decimals) || "0"}${frac ? `.${frac}` : ""}`;
}

// What a send's fee is usually, when the node can't say beforehand: about this, in the coin it is paid in
export const USUAL_FEE: Record<SendAsset, bigint> = { zec: 15_000n, btc: 3_000n, token: 100_000_000_000_000n, eth: 50_000_000_000_000n };

// ------------------------------------------------------------------------------------------------
// adding funds

// The address a coin is added at, from a daemon's GET /api/addresses, and the payment link wallets
// read from its QR code: ZIP-321 for Zcash, BIP-21 for Bitcoin and Litecoin, EIP-681 for a token
// (a transfer of it to the node's account, on its chain) or ETH. Null when the node gave none.
export function fundingOf(coin: Coin, h: Holding, a: Addresses | undefined): { address: string; uri: string } | null {
  if (!a) return null;
  if (coin.kind === "zec") {
    const address = a.zec?.address;
    return address ? { address, uri: `zcash:${address}` } : null;
  }
  const address = a.btc?.address;
  if (!address) return null;
  if (coin.kind === "btc") return { address, uri: `bitcoin:${address}` };
  if (coin.kind === "ltc") return { address, uri: `litecoin:${address}` };
  const counter = h.node.status?.counter;
  const chainId = a.btc?.chain_id ?? counter?.chain_id ?? CHAIN_IDS[coin.network] ?? null;
  const at = chainId ? `@${chainId}` : "";
  if (coin.kind === "eth") return { address, uri: `ethereum:${address}${at}` };
  const token = a.btc?.token ?? counter?.token;
  return { address, uri: token ? `ethereum:${token}${at}/transfer?address=${address}` : `ethereum:${address}${at}` };
}

// chain ids of the EVM networks ferryd names (when a daemon doesn't say)
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  sepolia: 11155111,
  base: 8453,
  "base-sepolia": 84532,
  arbitrum: 42161,
  "arbitrum-sepolia": 421614,
  optimism: 10,
  "op-sepolia": 11155420,
  anvil: 31337,
};

// a Zcash block, a Bitcoin one, a Litecoin one (seconds), for "about N min"
const BLOCK_SECS = { zec: 75, btc: 600, ltc: 150 };

// The plain notes under the code: which network (and which not), what can't be used, and when the
// coins can be swapped.
export function fundingNotes(coin: Coin, h: Holding): string[] {
  const notes: string[] = [];
  if (coin.kind === "zec") {
    const confs = h.node.status?.offer.zec_confs ?? 3;
    notes.push(`Shielded ZEC on ${coin.networkName} only. This is a unified address: send from a wallet that sends shielded, like Zashi. Transparent ZEC (from a t… address) can't be used here.`);
    notes.push(`Ready to swap after ${confs} confirmation${confs === 1 ? "" : "s"}, about ${Math.max(1, Math.round((confs * BLOCK_SECS.zec) / 60))} min.`);
  } else if (coin.kind === "btc" || coin.kind === "ltc") {
    const name = coin.kind === "ltc" ? "Litecoin" : "Bitcoin";
    const net = coin.networkName === name ? `${name} network` : coin.networkName;
    notes.push(`Send ${coin.ticker} on the ${net} only. Not ${coin.kind === "ltc" ? "Bitcoin" : "Bitcoin Cash"}, and not ${coin.ticker} wrapped on another chain.`);
    notes.push(`Ready to swap after 1 confirmation, about ${Math.round(BLOCK_SECS[coin.kind] / 60 * 10) / 10} min.`);
  } else {
    const chain = chainOfNetwork(coin.network);
    const not = chain === "ethereum" ? (coin.mainnet ? "" : " (a test network), not Ethereum mainnet") : ` — not Ethereum${chain ? "" : " or any other chain"}`;
    if (coin.kind === "token") {
      notes.push(`${coin.ticker} on ${coin.networkName}${not}. Sent on another chain, it won't arrive.`);
      notes.push(`Your node also needs a little ETH on ${coin.networkName} to pay for gas.`);
    } else notes.push(`ETH on ${coin.networkName}${not}, to pay for gas. Each side of your node pays its own, so each needs a little.`);
    notes.push("Ready to swap after 1 confirmation, a few seconds.");
  }
  if (!coin.mainnet) notes.push("A test network: these coins have no value.");
  return notes;
}

// The ReceiveCoin (lib/receive) of a coin, for checking a send's address.
export function receiveOf(coin: Coin, h: Holding): ReceiveCoin {
  if (coin.kind === "zec") return { key: `zec:${coin.network}`, kind: "zec", ticker: "ZEC", noun: "shielded ZEC", network: coin.network, networkName: coin.networkName };
  if (coin.kind === "btc" || coin.kind === "ltc") return { key: `${coin.key}:${coin.network}`, kind: coin.kind, ticker: coin.ticker, noun: coin.label, network: coin.network, networkName: coin.networkName };
  const counter = h.node.status?.counter;
  const contracts = [counter?.token, counter?.contract].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  // ETH is received at any address of the chain; a token's receive key is its pair's
  const key = coin.kind === "token" ? `${coin.key}:${coin.network}` : `eth:${coin.network}`;
  return { key, kind: "evm", ticker: coin.ticker, noun: `${coin.ticker} on ${coin.networkName}`, network: coin.network, networkName: coin.networkName, contracts };
}

// ------------------------------------------------------------------------------------------------
// sends

export type SendState = "sending" | "sent" | "failed";

// a daemon's word for a send, as one of three: on its way ("sending", "pending"), confirmed, or
// never going to be
export function sendState(w: Withdrawal): SendState {
  const s = (w.status ?? "").toLowerCase();
  if (s === "failed" || (w.error && s !== "confirmed")) return "failed";
  if (s === "confirmed" || (w.confirmations ?? 0) >= 1) return "sent";
  return "sending";
}

// which of the node's coins a send moved: ferryd also takes "ltc" for a Litecoin daemon's coin and
// a token's symbol for "token"
export const sendAsset = (w: Withdrawal): SendAsset => (w.asset === "zec" || w.asset === "btc" || w.asset === "token" || w.asset === "eth" ? w.asset : w.asset === "ltc" ? "btc" : "token");

export const sentAt = (w: Withdrawal): number | null => {
  const v = w.created_at;
  if (typeof v === "number") return v * (v < 1e12 ? 1000 : 1);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

// The live data /wallet needs: each daemon's status and swaps (5 s; the daemon the page follows
// live, from its event stream) and, on the person's own node, its sends (4 s).
export function useWallet(own: boolean) {
  const d = useLocal();
  const nodes = useNodes();
  const bases = nodes.map((n) => n.base);
  const statuses = usePoll(bases, getStatus, 5000);
  const swaps = usePoll(bases, getSwaps, 5000);
  const sending = bases.filter((b) => canSend(statuses.data[b] ?? nodes.find((n) => n.base === b)?.status ?? null));
  const sends = usePoll(sending, getWithdrawals, 4000, own);
  // the followed daemon's swaps as they happen (its own role's: the provider also holds the other
  // direction's), over the polled ones
  const liveSwaps = useMemo(() => {
    if (!d.daemon || !d.status) return swaps.data;
    const byId = new Map((swaps.data[d.daemon] ?? []).map((s) => [s.id, s]));
    for (const s of Object.values(d.swaps)) if (s.role === d.status.role) byId.set(s.id, s);
    return { ...swaps.data, [d.daemon]: [...byId.values()] };
  }, [swaps.data, d.swaps, d.daemon, d.status]);
  const liveStatuses = useMemo(() => (d.daemon && d.status ? { ...statuses.data, [d.daemon]: d.status } : statuses.data), [statuses.data, d.daemon, d.status]);
  const coins = useMemo(() => coinsOf(nodes, liveStatuses, liveSwaps), [nodes, liveStatuses, liveSwaps]);
  return { nodes, coins, statuses, swaps, sends };
}

export const chainNameOf = (c: string | null) => (c && c in CHAIN_NAMES ? CHAIN_NAMES[c as keyof typeof CHAIN_NAMES] : null);
