// The coin on the other side of the swap. ferryd reports it in /api/status
// (chains.btc.coin, offer.pair); the API keeps its btc_* field names for either coin.
// decimals: the btc_* amounts are in 10^-decimals of a coin.
export type CoinInfo = { id: "btc" | "ltc"; ticker: string; name: string; unit: string; decimals: number };
const COINS: Record<CoinInfo["id"], CoinInfo> = {
  btc: { id: "btc", ticker: "BTC", name: "Bitcoin", unit: "sat", decimals: 8 },
  ltc: { id: "ltc", ticker: "LTC", name: "Litecoin", unit: "lit", decimals: 8 },
};
let current: CoinInfo = COINS.btc;
// A daemon's coin is fixed for its lifetime, so one module-level value is enough: it is set
// from each status just before the state update that re-renders.
export const coin = (): CoinInfo => current;
export function setCoinFrom(status: { chains?: { btc?: { coin?: string } }; offer?: { pair?: string } } | null) {
  const id = status?.chains?.btc?.coin ?? (status?.offer?.pair?.endsWith("/LTC") ? "ltc" : "btc");
  current = COINS[id === "ltc" ? "ltc" : "btc"];
}

export const zec = (zat: number) => (zat / 1e8).toFixed(2);
export const btc = (sat: number) => (sat / 1e8).toFixed(8);
// prose amounts: 0.0041 rather than 0.00410000
export const btcShort = (sat: number) => (sat / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
export const short = (hex: string, head = 6, tail = 4) =>
  hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;

// "+1:05" relative to the first event of the swap
export function offset(at: string, start: string): string {
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(start)) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
