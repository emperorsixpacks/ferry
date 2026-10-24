import { useEffect, useRef, useState } from "react";
import type { Status, SwapView } from "../api";
import { coin } from "../format";

// Seconds per block. Public networks use their target spacing; regtest has whatever block
// producer is running (the demo stack mines both chains every ~5 s), so it starts from that and
// is then measured from the heights this page has seen.
const TARGET = { btc: 600, zec: 75 };
const REGTEST_GUESS = { btc: 5, zec: 5 };

export interface BlockTimes {
  btc: number;
  zec: number;
}

export function useBlockTimes(status: Status | null): BlockTimes {
  const first = useRef<{ btc?: [number, number]; zec?: [number, number] }>({});
  const [times, setTimes] = useState<BlockTimes>({ btc: TARGET.btc, zec: TARGET.zec });

  useEffect(() => {
    if (!status) return;
    const now = Date.now() / 1000;
    const next = { ...times };
    for (const chain of ["btc", "zec"] as const) {
      const { network, height } = status.chains[chain];
      // a local EVM chain (anvil) is measured like regtest; public EVM chains (Base) make 2 s blocks
      const local = network === "regtest" || (chain === "btc" && network === "anvil");
      if (chain === "btc" && coin().kind === "evm" && !local) {
        next.btc = 2;
        continue;
      }
      if (!local) {
        // Litecoin targets 2.5 min blocks
        next[chain] = chain === "btc" && coin().id === "ltc" ? 150 : TARGET[chain];
        continue;
      }
      const f = first.current[chain];
      if (!f) {
        first.current[chain] = [height, now];
        next[chain] = REGTEST_GUESS[chain];
      } else if (height - f[0] >= 2) {
        next[chain] = (now - f[1]) / (height - f[0]);
      } else if (times[chain] === TARGET[chain]) {
        next[chain] = REGTEST_GUESS[chain];
      }
    }
    if (next.btc !== times.btc || next.zec !== times.zec) setTimes(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return times;
}

interface Terms {
  t1: number;
  lockConfs: number;
  zecConfs: number;
}

function terms(status: Status | null, swap?: SwapView): Terms {
  return {
    t1: swap?.deadlines.t1_blocks ?? status?.offer.t1_blocks ?? 12,
    lockConfs: status?.offer.btc_lock_confs ?? 2,
    zecConfs: status?.offer.zec_confs ?? 3,
  };
}

// How long a swap usually takes, from the offer's terms and the block times: the BTC lock's
// confirmations, then the ZEC lock's, plus a margin for the blocks that carry the lock and the
// redeem, the counterparty's random sweep delay (up to ~20 s) and the wallets' own handling.
export function typicalSeconds(status: Status | null, bt: BlockTimes): number {
  const t = terms(status, undefined);
  const margin = bt.btc + bt.zec + 20 + 60;
  return t.lockConfs * bt.btc + t.zecConfs * bt.zec + margin;
}

export function confirmationsLabel(status: Status | null): string {
  const t = terms(status, undefined);
  return `${t.lockConfs} ${coin().name} + ${t.zecConfs} Zcash confirmations`;
}

// When the swap has fully unwound if the other side disappears: T1 after the BTC lock confirms,
// then the cancel and the refund each confirm, then the ZEC comes home (random delay + 1 block).
export function unwoundBy(status: Status | null, swap: SwapView, bt: BlockTimes): Date | null {
  if (!status) return null;
  const d = swap.deadlines;
  if (d.t1_unix != null) {
    // EVM: the refund can land right after t1 (block time, which may run ahead of the wall clock
    // on a local chain), then the ZEC comes home after the random delay and a Zcash block.
    const chainNow = d.now_unix ?? status.chains.btc.time ?? Date.now() / 1000;
    const seconds = Math.max(0, d.t1_unix - chainNow) + 2 * bt.btc + 20 + bt.zec;
    return new Date(Date.now() + seconds * 1000);
  }
  const t = terms(status, swap);
  const height = status.chains.btc.height;
  const lock = swap.deadlines.btc_lock_height ?? height + t.lockConfs;
  const cancelAt = swap.deadlines.cancel_height ?? lock + t.t1;
  const blocksLeft = Math.max(0, cancelAt - height) + 2;
  const seconds = blocksLeft * bt.btc + 20 + bt.zec;
  return new Date(Date.now() + seconds * 1000);
}

export const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const clockSeconds = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function roughDuration(seconds: number): string {
  if (seconds < 90) return "about a minute";
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} minutes`;
  const h = Math.round(m / 6) / 10;
  return `about ${h} hours`;
}
