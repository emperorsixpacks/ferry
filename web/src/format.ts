export const zec = (zat: number) => (zat / 1e8).toFixed(2);
export const btc = (sat: number) => (sat / 1e8).toFixed(8);
// prose amounts: 0.0041 BTC rather than 0.00410000
export const btcShort = (sat: number) => (sat / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
export const short = (hex: string, head = 6, tail = 4) =>
  hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;

// "+1:05" relative to the first event of the swap
export function offset(at: string, start: string): string {
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(start)) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
