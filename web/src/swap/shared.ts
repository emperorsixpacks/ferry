import type { Role, Status } from "../api";
import { btcShort } from "../format";

export const btcText = (sat: number) => (sat === 0 ? "0" : btcShort(sat));

// What the BTC side means to this party: Z receives the locked amount less the fee of the
// transaction that pays it out; B pays the locked amount (its own lock fee comes on top).
export const btcFor = (role: Role, sat: number, status: Status | null) =>
  role === "Z" ? Math.max(0, sat - (status?.offer.fee_sat ?? 0)) : sat;
