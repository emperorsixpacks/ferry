import { useEffect, useState } from "react";
import type { PairId, Status } from "@/api";
import { coinOf, networkLabel, short } from "@/format";

// Where the coins a swap gets go: the person's Ferry node (the default), or their own wallet, as an
// address they paste once per coin and network, remembered in this browser. Only on their own node
// (the UI server passes payout_to / sweep_to there only; server/own.mjs). Each address is checked
// here for its chain's format and network, so a slip is caught before anything starts; the daemon
// checks it again for its chain before it contacts a partner.

// A coin as it is received: shielded ZEC, Bitcoin or Litecoin, or a token on an EVM chain, on one
// network. `key` names it in the remembered addresses (an address of one network is useless on
// another).
export interface ReceiveCoin {
  key: string;
  kind: "zec" | "btc" | "ltc" | "evm";
  ticker: string;
  // in a sentence: "shielded ZEC", "Bitcoin", "USDC on Base Sepolia"
  noun: string;
  network: string;
  // the network, for people: "Zcash testnet", "Bitcoin local test network", "Base Sepolia"
  networkName: string;
  // EVM: contracts nobody should pay (the token itself, FerryLock)
  contracts?: string[];
}

// The coin a swap pays out: shielded ZEC, or the pair's coin, as its daemon describes it.
export function receiveCoin(token: "zec" | PairId, status: Status | null): ReceiveCoin | null {
  if (!status) return null;
  if (token === "zec") {
    const network = status.chains.zec.network;
    return { key: `zec:${network}`, kind: "zec", ticker: "ZEC", noun: "shielded ZEC", network, networkName: networkLabel(network, "zec") };
  }
  const c = coinOf(status);
  const network = status.chains.btc.network;
  if (c.kind === "evm") {
    const contracts = [status.counter?.token, status.counter?.contract].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    return { key: `${token}:${network}`, kind: "evm", ticker: c.ticker, noun: `${c.ticker} on ${networkLabel(network, "evm")}`, network, networkName: networkLabel(network, "evm"), contracts };
  }
  const kind = c.id === "ltc" ? "ltc" : "btc";
  return { key: `${token}:${network}`, kind, ticker: c.ticker, noun: c.asset, network, networkName: networkLabel(network, kind) };
}

// The coin a swap pays out, when the person may send it to their own wallet: on their own node
// (`own`), from a daemon that can pay another address (a sell's payout_to: "payout"; a buy's
// sweep_to came with route support: "route"). null: it goes to the Ferry node.
export function receiveFor(token: "zec" | PairId, status: Status | null, own: boolean): ReceiveCoin | null {
  if (!own || !status) return null;
  if (!(status.features ?? []).includes(token === "zec" ? "route" : "payout")) return null;
  return receiveCoin(token, status);
}

// ------------------------------------------------------------------------------------------------
// formats

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32 = 1;
const BECH32M = 0x2bc830a3;

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}

// A bech32 or bech32m string: its prefix, data (5-bit groups, checksum removed) and which checksum
// it carries; null when it isn't one or the checksum doesn't match. No length limit (a Zcash
// unified address is longer than bech32's usual 90).
export function bech32(s: string): { hrp: string; data: number[]; variant: "bech32" | "bech32m" } | null {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
  const t = s.toLowerCase();
  const at = t.lastIndexOf("1");
  if (at < 1 || at + 7 > t.length) return null;
  const hrp = t.slice(0, at);
  const data: number[] = [];
  for (const ch of t.slice(at + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const c = polymod([...expand, ...data]);
  const variant = c === BECH32 ? "bech32" : c === BECH32M ? "bech32m" : null;
  return variant ? { hrp, data: data.slice(0, -6), variant } : null;
}

const UA_PREFIX: Record<string, string> = { main: "u1", mainnet: "u1", test: "utest1", testnet: "utest1", regtest: "uregtest1" };
export const uaPrefix = (network: string) => UA_PREFIX[network] ?? `u${network}1`;
const SEGWIT: Record<"btc" | "ltc", Record<string, string>> = {
  btc: { bitcoin: "bc", main: "bc", mainnet: "bc", test: "tb", testnet: "tb", testnet4: "tb", signet: "tb", regtest: "bcrt" },
  ltc: { litecoin: "ltc", main: "ltc", mainnet: "ltc", test: "tltc", testnet: "tltc", regtest: "rltc" },
};
const MAINNETS = new Set(["main", "mainnet", "bitcoin", "litecoin"]);
// base58 addresses' first characters: mainnet, then the test networks
const LEGACY: Record<"btc" | "ltc", [RegExp, RegExp]> = { btc: [/^[13]/, /^[mn2]/], ltc: [/^[LM3]/, /^[mnQ2]/] };

// Why `text` isn't an address this coin can be paid at, in plain words; null when it is.
export function addressProblem(coin: ReceiveCoin, text: string): string | null {
  const a = text.trim();
  if (!a) return "Paste an address.";
  if (/\s/.test(a)) return "An address has no spaces. Copy it again from your wallet.";
  if (coin.kind === "zec") {
    const prefix = uaPrefix(coin.network);
    if (/^(t1|t3|tm|t2)/i.test(a) || /^tex1/i.test(a)) return `That's a transparent Zcash address (t…). Ferry sends ZEC shielded only: paste your wallet's unified address, which starts with ${prefix}.`;
    if (/^z(s|testsapling|regtestsapling)1/i.test(a)) return `That's an older Sapling address (zs…). Paste your wallet's unified address, which starts with ${prefix}.`;
    const other = Object.values(UA_PREFIX).some((p) => p !== prefix && a.toLowerCase().startsWith(p));
    if (!a.toLowerCase().startsWith(prefix)) return other ? `That's a Zcash address for another network. This node is on ${coin.networkName}: its addresses start with ${prefix}.` : `That isn't a Zcash unified address. On ${coin.networkName} it starts with ${prefix}.`;
    const d = bech32(a);
    if (!d || d.variant !== "bech32m" || d.hrp + "1" !== prefix) return "That address has a typo: its check digits don't match. Copy it again from your wallet.";
    if (d.data.length < 40) return "That address is too short. Copy the whole unified address from your wallet.";
    return null;
  }
  if (coin.kind === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return `That isn't an address on ${coin.networkName}. It's 0x and 40 letters and digits.`;
    if (/^0x0{40}$/.test(a)) return "That's the zero address: nobody can spend what's sent there.";
    if (coin.contracts?.includes(a.toLowerCase())) return `That's a contract of this swap, not a wallet: ${coin.ticker} sent there would be lost.`;
    return null;
  }
  const name = coin.kind === "ltc" ? "Litecoin" : "Bitcoin";
  const hrp = SEGWIT[coin.kind][coin.network] ?? SEGWIT[coin.kind].regtest;
  const main = MAINNETS.has(coin.network);
  if (/^[a-z]{2,4}1/i.test(a)) {
    const d = bech32(a);
    const known = Object.values(SEGWIT[coin.kind]);
    if (!d) return a.toLowerCase().startsWith(hrp + "1") ? "That address has a typo: its check digits don't match. Copy it again from your wallet." : `That isn't a ${name} address for ${coin.networkName}. It starts with ${hrp}1.`;
    if (d.hrp !== hrp) return known.includes(d.hrp) ? `That's a ${name} address for another network. This node is on ${coin.networkName}: addresses start with ${hrp}1.` : `That isn't a ${name} address. On ${coin.networkName} it starts with ${hrp}1.`;
    const version = d.data[0];
    const bytes = Math.floor(((d.data.length - 1) * 5) / 8);
    const ok = version === 0 ? d.variant === "bech32" && (bytes === 20 || bytes === 32) : version <= 16 && d.variant === "bech32m" && bytes >= 2 && bytes <= 40;
    return ok ? null : "That address has a typo: its check digits don't match. Copy it again from your wallet.";
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(a)) {
    const [mainFirst, testFirst] = LEGACY[coin.kind];
    if ((main ? mainFirst : testFirst).test(a)) return null;
    return `That's a ${name} address for another network. This node is on ${coin.networkName}.`;
  }
  return `That isn't a ${name} address for ${coin.networkName}.`;
}

// "bcrt1q…x7k2", for a line
export const shortAddress = (a: string) => short(a, 8, 6);

// An address as it is kept and sent: trimmed; bech32 ones (Zcash, Bitcoin, Litecoin) in lowercase,
// as wallets show them; an EVM one as typed (its mixed case is its own checksum).
export const cleanAddress = (coin: ReceiveCoin, a: string) => (coin.kind !== "evm" && bech32(a.trim()) ? a.trim().toLowerCase() : a.trim());

// ------------------------------------------------------------------------------------------------
// remembered per coin and network, in this browser

const KEY = "ferry.receive";
type Book = Record<string, string>;
const listeners = new Set<() => void>();

function readBook(): Book {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Book) : {};
  } catch {
    return {};
  }
}
let book: Book = readBook();

export const storedReceive = (key: string): string | null => book[key] ?? null;

export function storeReceive(key: string, address: string | null) {
  const next = { ...book };
  if (address) next[key] = address.trim();
  else delete next[key];
  book = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private window: remembered for this page */
  }
  for (const l of listeners) l();
}

// the address remembered for this coin (null: the Ferry node), kept in step across the page
export function useReceive(key: string | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  return key ? storedReceive(key) : null;
}

// NEAR Intents' assets: the address last used on each chain ("near:sol"), offered again
export const nearKey = (blockchain: string) => `near:${blockchain}`;
