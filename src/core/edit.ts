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

import { NUM_ROT, ROT_DIR, ROT_INV } from "./geometry.ts";
import { isExposed } from "./analyze.ts";
import { COLOR_NAME, CUBELETS, FACE_COLOR, NUM_SLOTS, SLOT_POS, State, type Color, type Kind } from "./puzzle.ts";

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
  /** What's wrong, in the owner's terms. It doesn't say where: the Lab points the slots out. */
  text: string;
  /** The slots it is about. */
  slots: number[];
}

/** Direction pointing away from the core for an outer (extension) slot, or -1. */
function outwardDir(s: number): number {
  const p = SLOT_POS[s];
  const axis = p.findIndex((c) => Math.abs(c) === 2);
  return axis < 0 ? -1 : axis * 2 + (p[axis] > 0 ? 0 : 1);
}

/** "red, yellow, and orange". */
function listColors(cs: Color[], and = "and"): string {
  const n = cs.map((c) => COLOR_NAME[c]);
  return n.length < 3 ? n.join(` ${and} `) : `${n.slice(0, -1).join(", ")}, ${and} ${n[n.length - 1]}`;
}

/** The order colors are listed in. */
const COLOR_ORDER: Color[] = ["W", "Y", "G", "B", "R", "O"];

/** The colors showing on slot s (a color twice if painted twice), in COLOR_ORDER. */
function shownColors(colors: FaceColors, s: number): Color[] {
  const out: Color[] = [];
  for (let d = 0; d < 6; d++) {
    const c = colors[s * 6 + d];
    if (c) out.push(c);
  }
  return out.sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));
}

/** Why no cubelet of this kind can show these colors, as the problem's text. */
function noCubelet(kind: Kind, cs: Color[]): string {
  const sameKind = CUBELETS.filter((c) => c.kind === kind);
  const can = new Set(sameKind.flatMap((c) => c.stickers.filter((x): x is Color => !!x)));
  const cannot = [...new Set(cs)].filter((c) => !can.has(c));
  if (cannot.length)
    return `${/^[aeiouX]/.test(KIND_NAME[kind][0]) ? "An" : "A"} ${KIND_NAME[kind][0]} must be ${listColors(COLOR_ORDER.filter((c) => can.has(c)), "or")}, never ${listColors(cannot, "or")}`;
  const dup = cs.find((c, i) => cs.indexOf(c) !== i);
  if (dup) return `No cubelet has two ${COLOR_NAME[dup]} stickers`;
  for (let k = 0; k < 6; k += 2)
    if (cs.includes(FACE_COLOR[k]) && cs.includes(FACE_COLOR[k + 1]))
      return `${cap(COLOR_NAME[FACE_COLOR[k]])} and ${COLOR_NAME[FACE_COLOR[k + 1]]} can never be on the same cubelet`;
  // The colors are on a cubelet of this kind, but not in this arrangement: on a corner,
  // the three colors go around it in a fixed order that no turn can mirror.
  const holders = sameKind.filter((c) => cs.every((x) => c.stickers.includes(x))).length;
  if (holders && cs.length === 3) return "Wrong color order";
  if (holders) return `No cubelet in this position can show ${listColors(cs)} this way`;
  return `No cubelet in this position has ${listColors(cs)}`;
}

/** The owner's names for the kinds of cubelet (AGENTS.md), singular and plural. */
const KIND_NAME: Record<Kind, [string, string]> = {
  // Plural for counts: each center color shows on exactly one center of either kind.
  center: ["core center", "centers"],
  extCenter: ["extension center", "centers"],
  coreCorner: ["core corner", "core corners"],
  singleEdge: ["core single edge", "core single edges"],
  doubleEdge: ["core double edge", "core double edges"],
  outerCorner: ["X-face corner", "X-face corners"],
  outerEdge: ["extension edge", "extension edges"],
};
const kindOf = (shape: State, s: number) => CUBELETS[shape.occ[s]].kind;

const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

const problem = (text: string, slots: number[]): Problem => ({ text, slots });

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

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

/**
 * Spots competing for too few cubelets in a failed attempt. From a spot left without one,
 * the spots reachable by trading cubelets (its candidates, the spots those fill, their
 * candidates, ...) are N spots sharing N - 1 cubelets; spots whose sets overlap are one
 * group. Any of them may be the one painted wrong.
 */
function competing(a: ReturnType<typeof attempt>) {
  const groups: { slots: Set<number>; ids: Set<number> }[] = [];
  for (const s of a.unmatched) {
    const slots = new Set<number>(), ids = new Set<number>();
    const visit = (t: number) => {
      if (slots.has(t)) return;
      slots.add(t);
      for (const [id] of a.cand.get(t)!) {
        ids.add(id);
        const holder = a.slotOf.get(id);
        if (holder !== undefined) visit(holder);
      }
    };
    visit(s);
    const g = groups.find((g) => [...slots].some((t) => g.slots.has(t)));
    if (g) for (const t of slots) g.slots.add(t), [...ids].forEach((id) => g.ids.add(id));
    else groups.push({ slots, ids });
  }
  return groups;
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
        // White and yellow never point out: that rule needs no knowledge of the cubelet.
        const facing = colors[s * 6 + outwardDir(s)];
        if (facing === "W" || facing === "Y") {
          problems.push(problem(`${cap(COLOR_NAME[facing])} can't point straight out from the core on an extension cubelet`, [s]));
          continue;
        }
        const cs = shownColors(colors, s);
        const kind = CUBELETS[shape.occ[s]].kind;
        const holders = CUBELETS.filter((c) => c.kind === kind && c.outward !== null && cs.every((x) => c.stickers.includes(x)));
        const outs = COLOR_ORDER.filter((x) => holders.some((c) => c.stickers[c.outward!] === x));
        const one = holders.length === 1;
        problems.push(problem(`The ${one ? "cubelet" : "cubelets"} with ${listColors(cs)} always ${one ? "has" : "have"} ${listColors(outs, "or")} pointing straight out from the core`, [s]));
      }
    // Every spot fits a cubelet turned a way the rule allows, but some compete for too few.
    if (!problems.length)
      for (const g of competing(strict)) {
        const spots = [...g.slots];
        const out = new Set(spots.map((t) => colors[t * 6 + outwardDir(t)]));
        const shown = new Set(spots.map((t) => listColors(shownColors(colors, t))));
        const [o] = out;
        const n = numberWord(spots.length), k = numberWord(g.ids.size);
        problems.push(
          problem(
            out.size === 1 && o && shown.size === 1
              ? `${cap(n)} ${KIND_NAME[kindOf(shape, spots[0])][1]} have ${COLOR_NAME[o]} pointing straight out from the core, but only ${k} with ${[...shown][0]} ${g.ids.size === 1 ? "does" : "do"}`
              : `${cap(n)} ${KIND_NAME[kindOf(shape, spots[0])][1]} can't all be turned this way at once. A sticker is probably painted wrong`,
            spots,
          ),
        );
      }
    if (!problems.length) problems.push({ text: "Each spot matches a cubelet, but they can't all be turned this way at once. A sticker is probably painted wrong", slots: [] });
    return { level: "cubelets", state: loose.state, problems };
  }
  for (const s of loose.slots)
    if (loose.cand.get(s)!.length === 0) {
      const cs = shownColors(colors, s);
      problems.push(problem(noCubelet(CUBELETS[shape.occ[s]].kind, cs), [s]));
    }
  if (!problems.length) {
    // Every slot has candidates, but some spots compete for too few cubelets.
    const groups = competing(loose);
    for (const g of groups) {
      const spots = [...g.slots];
      const shown = new Set(spots.map((t) => listColors(shownColors(colors, t))));
      const n = numberWord(spots.length), k = numberWord(g.ids.size);
      problems.push(
        problem(
          shown.size === 1
            ? `${cap(n)} ${KIND_NAME[kindOf(shape, spots[0])][1]} are ${[...shown][0]}, but there can be only ${k}`
            : `${cap(n)} ${KIND_NAME[kindOf(shape, spots[0])][1]} can only be filled by ${k} ${g.ids.size === 1 ? "cubelet" : "cubelets"} on the puzzle`,
          spots,
        ),
      );
    }
  }
  return { level: null, state: null, problems };
}

