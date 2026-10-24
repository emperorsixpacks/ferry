import type { ChainId, CoinId } from "./api";

// The coin on the other side of the swap. ferryd reports it in /api/status
// (chains.btc.coin, offer.pair); the API keeps its btc_* field names for either coin.
// decimals: the btc_* amounts are in 10^-decimals of a coin; places: how many of them we show.
// name: the counter chain ("Bitcoin", "Base Sepolia"); asset: what moves on it ("Bitcoin", "USDC").
// kind: "utxo" (Taproot scripts, block-count deadlines) or "evm" (FerryLock, block-time deadlines).
// chain: an EVM token's chain, when known.
export type CoinInfo = {
  id: CoinId;
  ticker: string;
  name: string;
  asset: string;
  unit: string;
  decimals: number;
  places: number;
  kind: "utxo" | "evm";
  chain: ChainId | null;
};
const COINS: Record<CoinId, CoinInfo> = {
  btc: { id: "btc", ticker: "BTC", name: "Bitcoin", asset: "Bitcoin", unit: "sat", decimals: 8, places: 8, kind: "utxo", chain: null },
  ltc: { id: "ltc", ticker: "LTC", name: "Litecoin", asset: "Litecoin", unit: "lit", decimals: 8, places: 8, kind: "utxo", chain: null },
  usdc: { id: "usdc", ticker: "USDC", name: "Base", asset: "USDC", unit: "USDC", decimals: 6, places: 2, kind: "evm", chain: "base" },
  weth: { id: "weth", ticker: "WETH", name: "Base", asset: "WETH", unit: "WETH", decimals: 18, places: 6, kind: "evm", chain: "base" },
};
export const CHAIN_NAMES: Record<ChainId, string> = { base: "Base", ethereum: "Ethereum", arbitrum: "Arbitrum", optimism: "Optimism" };
// An EVM daemon's network name (ferryd's network_name), and the chain it belongs to.
const NETWORKS: Record<string, { name: string; chain: ChainId | null }> = {
  anvil: { name: "Anvil", chain: null },
  base: { name: "Base", chain: "base" },
  "base-sepolia": { name: "Base Sepolia", chain: "base" },
  ethereum: { name: "Ethereum", chain: "ethereum" },
  sepolia: { name: "Sepolia", chain: "ethereum" },
  arbitrum: { name: "Arbitrum", chain: "arbitrum" },
  "arbitrum-sepolia": { name: "Arbitrum Sepolia", chain: "arbitrum" },
  optimism: { name: "Optimism", chain: "optimism" },
  "op-sepolia": { name: "OP Sepolia", chain: "optimism" },
};
export const chainOfNetwork = (network: string | null | undefined): ChainId | null => (network ? (NETWORKS[network]?.chain ?? null) : null);
const isCoin = (v: string): v is CoinId => v in COINS;

// a pair's coin when its daemon hasn't said yet (the swap page's coin picker lists them all)
export const coinInfo = (id: CoinId): CoinInfo => COINS[id];
let current: CoinInfo = COINS.btc;
// A local chain (anvil) doesn't say which chain it stands in for; the UI server's pair does.
let chainHint: ChainId | null = null;
export const setChainHint = (c: ChainId | null) => {
  chainHint = c;
};
// A daemon's coin is fixed for its lifetime, so one module-level value is enough: it is set
// from each status just before the state update that re-renders.
export const coin = (): CoinInfo => current;
type CoinStatus = { chains?: { btc?: { coin?: string; ticker?: string; network?: string } }; offer?: { pair?: string } } | null;

// The coin a daemon's status describes; `hint` names the chain a local EVM chain stands in for.
// Pure, so a page can describe a pair other than the one followed (Activity lists every pair).
export function coinOf(status: CoinStatus, hint: ChainId | null = null): CoinInfo {
  // an EVM daemon's own ticker first: it names the token actually configured
  const pairTicker = (status?.offer?.pair ?? "").split("/")[1] ?? "";
  const raw = (status?.chains?.btc?.ticker ?? status?.chains?.btc?.coin ?? pairTicker).toLowerCase();
  const base = COINS[isCoin(raw) ? raw : "btc"];
  if (base.kind !== "evm") return base;
  const network = status?.chains?.btc?.network ?? "";
  const net = NETWORKS[network];
  const chain = net?.chain ?? hint;
  // "Base Sepolia"; a local stand-in: "Arbitrum (local)"
  const name = net?.chain ? net.name : chain ? `${CHAIN_NAMES[chain]} (local)` : (net?.name ?? (network || base.name));
  return { ...base, name, chain };
}

export function setCoinFrom(status: CoinStatus) {
  current = coinOf(status, chainHint);
}

// A network's plain name for the "Test network" pill: never "regtest" or "anvil".
const MAINNETS = new Set(["bitcoin", "main", "mainnet", "litecoin", "ethereum", "base", "arbitrum", "optimism"]);
export const isMainnet = (network: string | null | undefined) => !!network && MAINNETS.has(network);
export function networkLabel(network: string, kind: "btc" | "ltc" | "evm" | "zec"): string {
  if (kind === "evm") return NETWORKS[network]?.chain ? NETWORKS[network].name : network === "anvil" ? "Local test chain" : network;
  const coinName = kind === "zec" ? "Zcash" : kind === "ltc" ? "Litecoin" : "Bitcoin";
  const names: Record<string, string> = { regtest: "local test network", signet: "Signet", test: "Testnet", testnet: "Testnet", testnet4: "Testnet4" };
  if (isMainnet(network)) return coinName;
  return `${coinName} ${names[network] ?? network}`;
}

export const zec = (zat: number) => (zat / 1e8).toFixed(2);
// btc_* amounts in whole coins of the counter asset (8 places for BTC/LTC, 2 for USDC, 6 for WETH)
export const btc = (sat: number) => (sat / 10 ** coin().decimals).toFixed(coin().places);
// prose amounts: 0.0041 rather than 0.00410000
export const btcShort = (sat: number) => btc(sat).replace(/0+$/, "").replace(/\.$/, "");
// the same for any coin, not only this daemon's
export const amountIn = (sat: number, c: CoinInfo) =>
  sat === 0 ? "0" : (sat / 10 ** c.decimals).toFixed(c.places).replace(/0+$/, "").replace(/\.$/, "");
export const short = (hex: string, head = 6, tail = 4) =>
  hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;

// "+1:05" relative to the first event of the swap
export function offset(at: string, start: string): string {
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(start)) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
