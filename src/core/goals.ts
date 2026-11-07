// Fast goal tests for search.
//
// Each occupied slot gets an "appearance code": which look-alike class of cubelet
// is there, and which way its stickers face. Two states look identical exactly
// when every slot has the same code. Goals compare codes on a chosen set of slots,
// so "don't care" regions are simply left out of the mask.

import { NUM_ROT, ROT_DIR } from "./geometry.ts";
import { CUBELETS, NUM_SLOTS, State } from "./puzzle.ts";

/** Look-alike class per cubelet: cubelets with identical stickers on identical faces share a class. */
export const APPEARANCE_CLASS: Int16Array = (() => {
  const keyOf = (id: number) => CUBELETS[id].stickers.map((c) => c ?? "-").join("");
  const classes = new Map<string, number>();
  const out = new Int16Array(CUBELETS.length);
  for (const c of CUBELETS) {
    const k = keyOf(c.id);
    if (!classes.has(k)) classes.set(k, classes.size);
    out[c.id] = classes.get(k)!;
  }
  return out;
})();

/**
 * CANON_ORI[id * 24 + r] = smallest rotation index that makes cubelet `id` show its
 * stickers in the same directions as rotation r does.
 */
export const CANON_ORI: Uint8Array = (() => {
  const t = new Uint8Array(CUBELETS.length * NUM_ROT);
  for (const c of CUBELETS) {
    const sig = (r: number) => {
      let k = "";
      for (let d = 0; d < 6; d++) if (c.stickers[d]) k += `${c.stickers[d]}${ROT_DIR[r * 6 + d]}`;
      return k;
    };
    const first = new Map<string, number>();
    for (let r = 0; r < NUM_ROT; r++) {
      const k = sig(r);
      if (!first.has(k)) first.set(k, r);
      t[c.id * NUM_ROT + r] = first.get(k)!;
    }
  }
  return t;
})();

/** Appearance code of one slot: -1 for empty. */
export function slotCode(st: State, s: number): number {
  const id = st.occ[s];
  if (id < 0) return -1;
  return APPEARANCE_CLASS[id] * NUM_ROT + CANON_ORI[id * NUM_ROT + st.ori[s]];
}

export function appearanceCodes(st: State): Int16Array {
  const out = new Int16Array(NUM_SLOTS);
  for (let s = 0; s < NUM_SLOTS; s++) out[s] = slotCode(st, s);
  return out;
}

/** Goal: the slots in `mask` (default: all) look exactly as they do in `target`. */
export function looksLike(target: State, mask?: readonly number[]): (st: State) => boolean {
  const slots = Int16Array.from(mask ?? [...Array(NUM_SLOTS).keys()]);
  const codes = appearanceCodes(target);
  const want = Int16Array.from(slots, (s) => codes[s]);
  return (st: State) => {
    for (let i = 0; i < slots.length; i++) if (slotCode(st, slots[i]) !== want[i]) return false;
    return true;
  };
}

/** Goal: the occupancy (shape) of `mask` slots matches `target`. */
export function shapeLike(target: State, mask?: readonly number[]): (st: State) => boolean {
  const slots = Int16Array.from(mask ?? [...Array(NUM_SLOTS).keys()]);
  const want = Int8Array.from(slots, (s) => (target.occ[s] >= 0 ? 1 : 0));
  return (st: State) => {
    for (let i = 0; i < slots.length; i++) if ((st.occ[slots[i]] >= 0 ? 1 : 0) !== want[i]) return false;
    return true;
  };
}

export const all =
  (...goals: ((st: State) => boolean)[]) =>
  (st: State) =>
    goals.every((g) => g(st));
