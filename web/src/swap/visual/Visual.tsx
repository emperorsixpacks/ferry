import { Crossing } from "./Crossing";
import { KeyHalves } from "./KeyHalves";
import { ShieldedStream } from "./ShieldedStream";
import type { Direction, Scene } from "./scene";
import "./visual.css";

export interface VisualProps {
  scene: Scene;
  amounts: { zec: string; btc: string };
}

// The three candidate pictures of a swap; `?direction=A|B|C` picks one.
export function Visual({ direction, ...props }: VisualProps & { direction: Direction }) {
  if (direction === "A") return <Crossing {...props} />;
  if (direction === "B") return <KeyHalves {...props} />;
  return <ShieldedStream {...props} />;
}

// What has happened so far, from this party's side.
export function progress(scene: Scene) {
  const { step, role, phase } = scene;
  const theirsLocked = role === "Z" ? step >= 2 : step >= 3;
  const mineLocked = role === "Z" ? step >= 3 : step >= 2;
  return {
    agreeing: step >= 1,
    theirsLocked,
    mineLocked,
    claiming: step >= 4,
    done: step >= 5,
    unwinding: phase === "unwinding",
    undone: phase === "refunded" || phase === "lost",
  };
}
