// The coin on the other side of the swap. ferryd reports it in /api/status
// (chains.btc.coin, offer.pair); the API keeps its btc_* field names for either coin.
// decimals: the btc_* amounts are in 10^-decimals of a coin.
// name: the counter chain ("Bitcoin", "Base"); asset: what moves on it ("Bitcoin", "USDC").
// kind: "utxo" (Taproot scripts, block-count deadlines) or "evm" (FerryLock, block-time deadlines).
export type CoinInfo = {
  id: "btc" | "ltc" | "usdc";
  ticker: string;
  name: string;
  asset: string;
  unit: string;
  decimals: number;
  kind: "utxo" | "evm";
};
const COINS: Record<CoinInfo["id"], CoinInfo> = {
  btc: { id: "btc", ticker: "BTC", name: "Bitcoin", asset: "Bitcoin", unit: "sat", decimals: 8, kind: "utxo" },
  ltc: { id: "ltc", ticker: "LTC", name: "Litecoin", asset: "Litecoin", unit: "lit", decimals: 8, kind: "utxo" },
  usdc: { id: "usdc", ticker: "USDC", name: "Base", asset: "USDC", unit: "USDC", decimals: 6, kind: "evm" },
};
// The EVM chain a USDC daemon runs on, by its network name.
const EVM_CHAINS: Record<string, string> = { anvil: "Anvil", "base-sepolia": "Base Sepolia", base: "Base" };
let current: CoinInfo = COINS.btc;
// A daemon's coin is fixed for its lifetime, so one module-level value is enough: it is set
// from each status just before the state update that re-renders.
export const coin = (): CoinInfo => current;
export function setCoinFrom(
  status: { chains?: { btc?: { coin?: string; network?: string } }; offer?: { pair?: string } } | null,
) {
  const pair = status?.offer?.pair ?? "";
  const id = status?.chains?.btc?.coin ?? (pair.endsWith("/LTC") ? "ltc" : pair.endsWith("/USDC") ? "usdc" : "btc");
  const base = COINS[id === "ltc" || id === "usdc" ? id : "btc"];
  const network = status?.chains?.btc?.network ?? "";
  current = base.kind === "evm" ? { ...base, name: EVM_CHAINS[network] ?? base.name } : base;
}

export const zec = (zat: number) => (zat / 1e8).toFixed(2);
// btc_* amounts in whole coins of the counter asset (8 places for BTC/LTC, 6 for USDC)
export const btc = (sat: number) => (sat / 10 ** coin().decimals).toFixed(coin().kind === "evm" ? 2 : coin().decimals);
// prose amounts: 0.0041 rather than 0.00410000
export const btcShort = (sat: number) => btc(sat).replace(/0+$/, "").replace(/\.$/, "");
export const short = (hex: string, head = 6, tail = 4) =>
  hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;

// "+1:05" relative to the first event of the swap
export function offset(at: string, start: string): string {
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(start)) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
