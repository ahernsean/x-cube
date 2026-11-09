// Compact text encoding of a state, for saving and sharing.
//
// Format: "X1:" followed by 80 pairs of characters, one pair per slot in slot order.
// First char: cubelet id (alphabet below) or "." for empty. Second char: orientation a..x.

import { NUM_ROT } from "./geometry.ts";
import { CUBELETS, NUM_SLOTS, State } from "./puzzle.ts";

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ORI_ALPHABET = "abcdefghijklmnopqrstuvwx";
const PREFIX = "X1:";

export function encodeState(st: State): string {
  let out = PREFIX;
  for (let s = 0; s < NUM_SLOTS; s++) {
    const id = st.occ[s];
    out += id < 0 ? ".." : ID_ALPHABET[id] + ORI_ALPHABET[st.ori[s]];
  }
  return out;
}

export function decodeState(code: string): State {
  const c = code.trim();
  if (!c.startsWith(PREFIX)) throw new Error("not an X-Cube state code");
  const body = c.slice(PREFIX.length);
  if (body.length !== NUM_SLOTS * 2) throw new Error("state code has the wrong length");
  const st = new State();
  const seen = new Set<number>();
  for (let s = 0; s < NUM_SLOTS; s++) {
    const a = body[s * 2];
    const b = body[s * 2 + 1];
    if (a === ".") continue;
    const id = ID_ALPHABET.indexOf(a);
    const o = ORI_ALPHABET.indexOf(b);
    if (id < 0 || id >= CUBELETS.length || o < 0 || o >= NUM_ROT) throw new Error(`bad entry at slot ${s}`);
    if (seen.has(id)) throw new Error(`cubelet ${id} appears twice`);
    seen.add(id);
    st.occ[s] = id;
    st.ori[s] = o;
  }
  if (seen.size !== CUBELETS.length) throw new Error(`state has ${seen.size} cubelets, expected ${CUBELETS.length}`);
  return st;
}
