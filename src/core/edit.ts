// Fitting edited sticker colors to real cubelets.
//
// The Lab's color editor keeps the shape (which slots are filled) and lets the owner
// repaint the stickers that can be seen. fitColors finds a state with that shape whose
// visible faces show exactly those colors, using each cubelet once, or says why there is
// none. Faces that can't be seen (pressed against a neighbor) are not constrained, so
// hidden cubelets and the hidden faces of visible ones are filled in as needed, keeping
// the starting state wherever possible.
//
// Two levels of validity:
// - "cubelets": every slot can hold a real cubelet showing those colors, each cubelet once;
// - "possible": also obeys the outward-color rule (an outer cubelet always shows the same
//   color away from the core), which no sequence of turns can break.
// Whether a "possible" state can actually be reached by turning is not checked here.

import { FACE_NAMES, NUM_ROT, ROT_DIR, ROT_INV } from "./geometry.ts";
import { isExposed } from "./analyze.ts";
import { COLOR_NAME, CUBELETS, NUM_SLOTS, SLOT_POS, State, slotName, type Color } from "./puzzle.ts";

/**
 * Colors indexed by slot * 6 + direction: a color for a visible sticker, null for a
 * visible face without a sticker (black plastic), undefined for a face that can't be seen.
 */
export type FaceColors = (Color | null | undefined)[];

/** What the owner sees on the state st: its visible faces' colors. */
export function visibleColors(st: State): FaceColors {
  const out: FaceColors = new Array(NUM_SLOTS * 6).fill(undefined);
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (st.occ[s] < 0) continue;
    for (let d = 0; d < 6; d++) if (isExposed(st, s, d)) out[s * 6 + d] = st.colorAt(s, d);
  }
  return out;
}

export interface Fit {
  /** "cubelets" or "possible" (see above); null when the colors can't be real cubelets. */
  level: "cubelets" | "possible" | null;
  /** A state with the shape and these colors (obeying the outward-color rule when level is "possible"). */
  state: State | null;
  /** Why the colors fall short of "possible", in the owner's terms. Empty when level is "possible". */
  problems: string[];
}

/** Direction pointing away from the core for an outer (extension) slot, or -1. */
function outwardDir(s: number): number {
  const p = SLOT_POS[s];
  const axis = p.findIndex((c) => Math.abs(c) === 2);
  return axis < 0 ? -1 : axis * 2 + (p[axis] > 0 ? 0 : 1);
}

/** "U white, F green" for the visible faces of slot s. */
function describe(colors: FaceColors, s: number): string {
  const parts: string[] = [];
  for (let d = 0; d < 6; d++) {
    const c = colors[s * 6 + d];
    if (c) parts.push(`${FACE_NAMES[d]} ${COLOR_NAME[c]}`);
  }
  return parts.join(", ");
}

/** Every (cubelet, orientation) that could sit in slot s and show these colors there. */
function candidates(shape: State, colors: FaceColors, s: number, outwardRule: boolean): [number, number][] {
  const kind = CUBELETS[shape.occ[s]].kind;
  const out: [number, number][] = [];
  const outDir = outwardDir(s);
  // Try the current occupant and orientation first, so an unchanged slot keeps its cubelet.
  const ids = [shape.occ[s], ...CUBELETS.filter((c) => c.kind === kind && c.id !== shape.occ[s]).map((c) => c.id)];
  for (const id of ids) {
    const c = CUBELETS[id];
    const oris = [shape.ori[s], ...[...Array(NUM_ROT).keys()].filter((o) => o !== shape.ori[s])];
    for (const o of oris) {
      if (outwardRule && c.outward !== null && ROT_DIR[o * 6 + c.outward] !== outDir) continue;
      let ok = true;
      for (let d = 0; d < 6 && ok; d++) {
        const want = colors[s * 6 + d];
        if (want === undefined) continue;
        if (c.stickers[ROT_DIR[ROT_INV[o] * 6 + d]] !== want) ok = false;
      }
      if (ok) out.push([id, o]);
    }
  }
  return out;
}

/** Assigns each filled slot a distinct cubelet (bipartite matching by augmenting paths). */
function match(slots: number[], cand: Map<number, [number, number][]>) {
  const slotOf = new Map<number, number>(); // cubelet id -> slot
  const choice = new Map<number, [number, number]>(); // slot -> (id, ori)
  const tryAssign = (s: number, seen: Set<number>): boolean => {
    for (const [id, o] of cand.get(s)!) {
      if (seen.has(id)) continue;
      seen.add(id);
      const other = slotOf.get(id);
      if (other === undefined || tryAssign(other, seen)) {
        slotOf.set(id, s);
        choice.set(s, [id, o]);
        return true;
      }
    }
    return false;
  };
  const unmatched: number[] = [];
  for (const s of slots) if (!tryAssign(s, new Set())) unmatched.push(s);
  return { choice, slotOf, unmatched };
}

function attempt(shape: State, colors: FaceColors, outwardRule: boolean) {
  const slots = [...Array(NUM_SLOTS).keys()].filter((s) => shape.occ[s] >= 0);
  const cand = new Map(slots.map((s) => [s, candidates(shape, colors, s, outwardRule)] as const));
  const m = match(slots, cand);
  let state: State | null = null;
  if (m.unmatched.length === 0) {
    state = new State();
    for (const [s, [id, o]] of m.choice) {
      state.occ[s] = id;
      state.ori[s] = o;
    }
  }
  return { slots, cand, ...m, state };
}

/** Finds real cubelets showing `colors` on the shape of `shape` (see the top of this file). */
export function fitColors(shape: State, colors: FaceColors): Fit {
  const strict = attempt(shape, colors, true);
  if (strict.state) return { level: "possible", state: strict.state, problems: [] };
  const loose = attempt(shape, colors, false);
  const problems: string[] = [];
  if (loose.state) {
    for (const s of strict.slots)
      if (strict.cand.get(s)!.length === 0)
        problems.push(`${slotName(s)} (${describe(colors, s)}): that cubelet can't be turned this way; its ${COLOR_NAME[outwardColor(loose.state, s)!]} side always faces outward`);
    if (!problems.length) problems.push("Every cubelet exists, but not all can face these ways at once on a real puzzle");
    return { level: "cubelets", state: loose.state, problems };
  }
  for (const s of loose.slots)
    if (loose.cand.get(s)!.length === 0) problems.push(`${slotName(s)} (${describe(colors, s)}): no cubelet has these colors`);
  if (!problems.length) {
    // Every slot has candidates, but some cubelet would be needed twice.
    for (const s of loose.unmatched) {
      const [id] = loose.cand.get(s)![0];
      const other = loose.slotOf.get(id);
      const twin = other === undefined ? "" : ` and ${slotName(other)} (${describe(colors, other)})`;
      problems.push(`${slotName(s)} (${describe(colors, s)})${twin} would need the same cubelet`);
    }
  }
  return { level: null, state: null, problems };
}

/** The color on the outward face of the outer cubelet in slot s of st. */
function outwardColor(st: State, s: number): Color | null {
  const c = CUBELETS[st.occ[s]];
  if (c.outward === null) return null;
  return c.stickers[c.outward];
}

