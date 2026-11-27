// Fast goal tests for search.
//
// Each occupied slot gets an "appearance code": which look-alike class of piece
// is there, and which way its stickers face. Two states look identical exactly
// when every slot has the same code. Goals compare codes on a chosen set of slots,
// so "don't care" regions are simply left out of the mask.

import { NUM_ROT } from "./geometry.ts";
import { XCUBE, State } from "./puzzle.ts";

/** The X-Cube's look-alike classes and canonical orientations (PuzzleDef.appearanceClass, canonOri). */
export const APPEARANCE_CLASS: Int16Array = XCUBE.appearanceClass;
export const CANON_ORI: Uint8Array = XCUBE.canonOri;

/** Appearance code of one slot: -1 for empty. */
export function slotCode(st: State, s: number): number {
  const id = st.occ[s];
  if (id < 0) return -1;
  const P = st.puzzle;
  return P.appearanceClass[id] * NUM_ROT + P.canonOri[id * NUM_ROT + st.ori[s]];
}

export function appearanceCodes(st: State): Int16Array {
  const out = new Int16Array(st.puzzle.numSlots);
  for (let s = 0; s < out.length; s++) out[s] = slotCode(st, s);
  return out;
}

/** Goal: the slots in `mask` (default: all) look exactly as they do in `target`. */
export function looksLike(target: State, mask?: readonly number[]): (st: State) => boolean {
  const slots = Int16Array.from(mask ?? [...Array(target.puzzle.numSlots).keys()]);
  const codes = appearanceCodes(target);
  const want = Int16Array.from(slots, (s) => codes[s]);
  return (st: State) => {
    for (let i = 0; i < slots.length; i++) if (slotCode(st, slots[i]) !== want[i]) return false;
    return true;
  };
}

/** Goal: the occupancy (shape) of `mask` slots matches `target`. */
export function shapeLike(target: State, mask?: readonly number[]): (st: State) => boolean {
  const slots = Int16Array.from(mask ?? [...Array(target.puzzle.numSlots).keys()]);
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
