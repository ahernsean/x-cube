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

import { DIRS, NUM_ROT, ROT_DIR, ROT_INV } from "./geometry.ts";
import { isExposed } from "./analyze.ts";
import { COLOR_NAME, CUBELETS, FACE_COLOR, NUM_SLOTS, SLOT_POS, State, slotAt, type Color } from "./puzzle.ts";

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
  /** Why the colors fall short of "possible". Empty when level is "possible". */
  problems: Problem[];
}

export interface Problem {
  /** In the owner's terms, naming spots by where they are and sides by their center colors. */
  text: string;
  /** The slots it is about, to point them out. */
  slots: number[];
}

/** Direction pointing away from the core for an outer (extension) slot, or -1. */
function outwardDir(s: number): number {
  const p = SLOT_POS[s];
  const axis = p.findIndex((c) => Math.abs(c) === 2);
  return axis < 0 ? -1 : axis * 2 + (p[axis] > 0 ? 0 : 1);
}

/** "red, yellow, and orange". */
function listColors(cs: Color[]): string {
  const n = cs.map((c) => COLOR_NAME[c]);
  return n.length < 3 ? n.join(" and ") : `${n.slice(0, -1).join(", ")}, and ${n[n.length - 1]}`;
}

/** The colors showing on slot s, in direction order. */
function shownColors(colors: FaceColors, s: number): Color[] {
  const out: Color[] = [];
  for (let d = 0; d < 6; d++) {
    const c = colors[s * 6 + d];
    if (c) out.push(c);
  }
  return out;
}

const HOLD_WORD = ["right", "left", "top", "bottom", "front", "back"];

/**
 * Words for the six directions: "top" and "bottom", and each side by the color its center
 * shows now (painted colors included), or by its place in the Front view ("right") when
 * that color is missing or shows on another center too.
 */
export function sideWords(shape: State, colors: FaceColors): { word: string[]; byColor: boolean[] } {
  const center = DIRS.map((v, d) => {
    const outer = slotAt([v[0] * 2, v[1] * 2, v[2] * 2]);
    const s = outer >= 0 && shape.occ[outer] >= 0 ? outer : slotAt(v);
    return colors[s * 6 + d] ?? null;
  });
  const byColor = center.map((c, d) => d >> 1 !== 1 && !!c && center.filter((o) => o === c).length === 1);
  return { word: HOLD_WORD.map((w, d) => (byColor[d] ? COLOR_NAME[center[d]!] : w)), byColor };
}

/** Where slot s is, in words: "bottom corner of the blue extension on the red side". Notes in `used` which directions it named. */
function where(s: number, words: string[], used: Set<number>): string {
  const p = SLOT_POS[s];
  const dirs: number[] = [];
  let ext = -1;
  for (let a = 0; a < 3; a++) {
    if (!p[a]) continue;
    const d = a * 2 + (p[a] > 0 ? 0 : 1);
    if (Math.abs(p[a]) === 2) ext = d;
    else dirs.push(d);
  }
  for (const d of [...dirs, ext]) if (d >= 0) used.add(d);
  const vert = dirs.filter((d) => d >> 1 === 1), sides = dirs.filter((d) => d >> 1 !== 1);
  const side = (d: number) => `the ${words[d]} side`;
  const between = (a: number, b: number) => `between the ${words[a]} and ${words[b]} sides`;
  if (ext >= 0) {
    const of = `the ${words[ext]} extension`;
    if (dirs.length === 0) return `center of ${of}`;
    if (dirs.length === 1) return vert.length ? `${words[vert[0]]} edge of ${of}` : `edge of ${of} on ${side(sides[0])}`;
    if (vert.length) return `${words[vert[0]]} corner of ${of} on ${side(sides[0])}`;
    return `corner of ${of} ${between(sides[0], sides[1])}`;
  }
  if (dirs.length === 1) return vert.length ? `center of the ${words[vert[0]]}` : `center of ${side(sides[0])}`;
  if (dirs.length === 2) return vert.length ? `core edge at the ${words[vert[0]]} on ${side(sides[0])}` : `core edge ${between(sides[0], sides[1])}`;
  return `core corner at the ${words[vert[0]]} ${between(sides[0], sides[1])}`;
}

/** Why no cubelet shows these colors, when there's a simple reason. */
function noCubelet(cs: Color[]): string {
  const dup = cs.find((c, i) => cs.indexOf(c) !== i);
  if (dup) return `no cubelet has two ${COLOR_NAME[dup]} stickers`;
  for (let k = 0; k < 6; k += 2)
    if (cs.includes(FACE_COLOR[k]) && cs.includes(FACE_COLOR[k + 1]))
      return `${COLOR_NAME[FACE_COLOR[k]]} and ${COLOR_NAME[FACE_COLOR[k + 1]]} are opposite colors, never on one cubelet`;
  return "no cubelet has these colors";
}

/** The order to name a cubelet's colors in: "the white and red cubelet". */
const COLOR_ORDER: Color[] = ["W", "Y", "G", "B", "R", "O"];

const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

/** Builds a problem's text from spots and a sentence, adding a note when a side was named by its place. */
function problem(shape: State, colors: FaceColors, slots: number[], say: (at: (s: number) => string) => string): Problem {
  const { word, byColor } = sideWords(shape, colors);
  const used = new Set<number>();
  const text = cap(say((s) => where(s, word, used)));
  const byPlace = [...used].some((d) => d >> 1 !== 1 && !byColor[d]);
  return { text: byPlace ? `${text} (sides named as in the Front view)` : text, slots };
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
  const problems: Problem[] = [];
  if (loose.state) {
    for (const s of strict.slots)
      if (strict.cand.get(s)!.length === 0) {
        const out = COLOR_NAME[outwardColor(loose.state, s)!];
        problems.push(problem(shape, colors, [s], (at) => `${at(s)} can't be turned this way: that cubelet's ${out} sticker always faces away from the core`));
      }
    if (!problems.length) problems.push({ text: "Every cubelet exists, but not all can face these ways at once on a real puzzle", slots: [] });
    return { level: "cubelets", state: loose.state, problems };
  }
  for (const s of loose.slots)
    if (loose.cand.get(s)!.length === 0) {
      const cs = shownColors(colors, s);
      problems.push(problem(shape, colors, [s], (at) => `${at(s)} shows ${listColors(cs)}: ${noCubelet(cs)}`));
    }
  if (!problems.length) {
    // Every slot has candidates, but some cubelet would be needed twice.
    for (const s of loose.unmatched) {
      const [id] = loose.cand.get(s)![0];
      const other = loose.slotOf.get(id);
      const named = listColors(COLOR_ORDER.filter((c) => CUBELETS[id].stickers.includes(c)));
      problems.push(
        other === undefined
          ? problem(shape, colors, [s], (at) => `${at(s)} would need the ${named} cubelet, which is used elsewhere`)
          : problem(shape, colors, [s, other], (at) => `${at(s)} and the ${at(other)} would both need the ${named} cubelet`),
      );
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

