// Editing a position: its shape, and the colors of its stickers.
//
// The Lab's editor (Edit puzzle) lets the owner set the shape (shape editing, at the end of
// this file) and paint the stickers that can be seen. fitColors finds a state with that shape whose
// visible faces show exactly those colors, using each cubelet once, or says why there is
// none. Faces that can't be seen (pressed against a neighbor) are not constrained, so
// hidden cubelets and the hidden faces of visible ones are filled in as needed, keeping
// the starting state wherever possible.
//
// Three levels of validity:
// - "cubelets": every slot can hold a real cubelet showing those colors, each cubelet once;
// - "possible": also obeys the outward-color rule (an outer cubelet always shows the same
//   color away from the core), which no sequence of turns can break;
// - "reachable": some state showing those colors can be reached by turning.
//
// Reachable. Many states show the same colors: look-alike core cubelets can trade places,
// and cubelets and faces nobody can see can be anything. The colors are reachable when
// any one of those states is. Turns keep six things true (serialize.ts lists them), and
// the paint settles fewer of them than it seems:
// - Every sticker of an outer corner or outer edge is on a face nothing can cover, so the
//   paint settles which outer cubelet is in each spot and how it is turned, and the
//   outward-color rule is the whole of what turns demand of that.
// - A core corner or core single edge shows its one sticker on its one bare face, so the
//   shape settles the corner twists and the single edges' flips. A shape that turns made
//   has them right.
// - The center colors must be arranged as turning the whole puzzle arranges them. The
//   paint settles this, and it is the one thing the paint can get wrong.
// - Every parity can be put right without changing what shows: flipping a core double
//   edge (never seen) fixes the flip sum; trading two look-alike core single edges fixes
//   the outer swap parity, because it trades the sites of the outer edges on them; trading
//   two look-alike core corners then fixes the core swap parity; a quarter turn of a
//   white or yellow center, and of an extension center, fixes the two center spin sums.
// So colors that are "possible" are reachable exactly when the centers are arranged
// right. reachableFit doesn't rely on that argument: it builds the state and has
// unreachableReason check it.

import { axisRotation, DIRS, matVec, NUM_ROT, ROT_DIR, ROT_INV, ROT_MUL, ROTATIONS } from "./geometry.ts";
import { isExposed } from "./analyze.ts";
import { COLOR_NAME, CUBELETS, FACE_COLOR, NUM_SLOTS, SLOT_NEIGHBOR, SLOT_POS, State, slotAt, type Color, type Kind } from "./puzzle.ts";
import { rotsTo, unreachableReason } from "./serialize.ts";

/** A sticker that hasn't been painted: it may be any color. */
export const UNPAINTED = "?";
/**
 * Colors indexed by slot * 6 + direction: a color for a visible sticker, UNPAINTED for a
 * sticker of any color, null for a visible face without a sticker (black plastic),
 * undefined for a face that can't be seen.
 */
export type FaceColors = (Color | typeof UNPAINTED | null | undefined)[];

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
  /** "cubelets", "possible" or "reachable" (see above); null when the colors can't be real cubelets. */
  level: "cubelets" | "possible" | "reachable" | null;
  /**
   * A state with the shape and these colors: one that turns can reach when level is
   * "reachable", one obeying the outward-color rule when it is "possible".
   */
  state: State | null;
  /** Why the colors fall short of "reachable". Empty when level is "reachable". */
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
    if (c && c !== UNPAINTED) out.push(c);
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

/**
 * What a fit must obey besides the colors: nothing, the outward-color rule, or "turned":
 * each cubelet turned as some rotation of the whole puzzle would turn it into its slot,
 * which every turn keeps true (and which implies the outward-color rule).
 */
type Rule = "none" | "outward" | "turned";

/** Every (cubelet, orientation) that could sit in slot s and show these colors there. */
function candidates(shape: State, colors: FaceColors, s: number, rule: Rule): [number, number][] {
  const kind = CUBELETS[shape.occ[s]].kind;
  const out: [number, number][] = [];
  const outDir = outwardDir(s);
  // Try the current occupant and orientation first, so an unchanged slot keeps its cubelet.
  const ids = [shape.occ[s], ...CUBELETS.filter((c) => c.kind === kind && c.id !== shape.occ[s]).map((c) => c.id)];
  for (const id of ids) {
    const c = CUBELETS[id];
    const oris = [shape.ori[s], ...[...Array(NUM_ROT).keys()].filter((o) => o !== shape.ori[s])];
    for (const o of oris) {
      if (rule === "outward" && c.outward !== null && ROT_DIR[o * 6 + c.outward] !== outDir) continue;
      if (rule === "turned" && !rotsTo(id, s).includes(o)) continue;
      let ok = true;
      for (let d = 0; d < 6 && ok; d++) {
        const want = colors[s * 6 + d];
        if (want === undefined) continue;
        const has = c.stickers[ROT_DIR[ROT_INV[o] * 6 + d]];
        if (want === UNPAINTED ? has === null : has !== want) ok = false;
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

function attempt(shape: State, colors: FaceColors, rule: Rule) {
  const slots = [...Array(NUM_SLOTS).keys()].filter((s) => shape.occ[s] >= 0);
  const cand = new Map(slots.map((s) => [s, candidates(shape, colors, s, rule)] as const));
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

const SOLVED = State.solved();
/** The core center each extension center is fused to. */
const FUSED_TO = new Map(CUBELETS.filter((c) => c.kind === "extCenter").map((c) => [c.id, SOLVED.occ[SLOT_NEIGHBOR[c.home * 6 + (c.outward! ^ 1)]]]));
/** The core center slot in each direction. */
const CENTER_SLOTS = DIRS.map((d) => slotAt(d));

/** Slots of `st` holding cubelets of this kind, optionally only those with this sticker color. */
const slotsOf = (st: State, kind: Kind, color?: Color) =>
  [...Array(NUM_SLOTS).keys()].filter((s) => st.occ[s] >= 0 && CUBELETS[st.occ[s]].kind === kind && (!color || CUBELETS[st.occ[s]].stickers.includes(color)));

/** Trades the cubelets in slots a and b, each turned to show what the other showed. False if they can't. */
function trade(st: State, a: number, b: number): boolean {
  const look = (s: number) => [0, 1, 2, 3, 4, 5].map((d) => st.colorAt(s, d)).join();
  const [la, lb, ia, ib] = [look(a), look(b), st.occ[a], st.occ[b]];
  const put = (s: number, id: number, want: string) => {
    st.occ[s] = id;
    for (const o of rotsTo(id, s)) {
      st.ori[s] = o;
      if (look(s) === want) return true;
    }
    return false;
  };
  return put(a, ib, la) && put(b, ia, lb);
}

/** Gives the cubelet in slot s a quarter turn about the axis its slot is on (a center's spin). */
function spin(st: State, s: number) {
  const axis = SLOT_POS[s].findIndex((c) => c !== 0);
  st.ori[s] = ROT_MUL[axisRotation(axis, 1) * NUM_ROT + st.ori[s]];
}

/**
 * Changes to a state that nobody can see, each changing a different set of the parities
 * turns keep (see the top of this file). Each returns false if the state has no place for it.
 */
const UNSEEN_CHANGES: ((st: State) => boolean)[] = [
  // Flip a core double edge: it has no stickers.
  (st) => {
    const [s] = slotsOf(st, "doubleEdge");
    if (s === undefined) return false;
    const other = rotsTo(st.occ[s], s).find((o) => o !== st.ori[s]);
    if (other === undefined) return false;
    st.ori[s] = other;
    return true;
  },
  // Trade two look-alike core single edges, or two look-alike core corners.
  ...(["singleEdge", "coreCorner"] as const).map((kind) => (st: State) => {
    for (const color of ["W", "Y"] as const) {
      const [a, b] = slotsOf(st, kind, color);
      if (b !== undefined) return trade(st, a, b);
    }
    return false;
  }),
  // Spin a white or yellow center, or an extension center: only the face on its axis has a sticker.
  ...(["center", "extCenter"] as const).map((kind) => (st: State) => {
    const s = slotsOf(st, kind).find((s) => CUBELETS[st.occ[s]].stickers.some((c) => c));
    if (s === undefined) return false;
    spin(st, s);
    return true;
  }),
];
/** Every set of unseen changes, fewest first, so a fit keeps as much of the start as it can. */
const CHANGE_SETS = [...Array(1 << UNSEEN_CHANGES.length).keys()].sort((a, b) => bits(a) - bits(b) || a - b);
function bits(n: number): number {
  return n ? (n & 1) + bits(n >> 1) : 0;
}

/** What's wrong with the arrangement of the center colors of st, or null if turns can arrange them so. */
function centerProblem(st: State): Problem | null {
  const ids = CENTER_SLOTS.map((s) => st.occ[s]);
  if (ids.some((id) => id < 0 || CUBELETS[id].kind !== "center")) return null;
  // The direction each center's cubelet faces when solved.
  const home = ids.map((id) => CENTER_SLOTS.indexOf(CUBELETS[id].home));
  const ok = [...Array(NUM_ROT).keys()].some((r) => home.every((h, d) => ROT_DIR[r * 6 + h] === d));
  if (ok) return null;
  // The spot that shows a center's color: its extension center, if it has one.
  const spot = (d: number) => {
    const out = SLOT_NEIGHBOR[CENTER_SLOTS[d] * 6 + d];
    return out >= 0 && st.occ[out] >= 0 ? out : CENTER_SLOTS[d];
  };
  // Opposite spots whose colors aren't an opposite pair.
  const apart = [0, 2, 4].filter((d) => (home[d] ^ 1) !== home[d + 1]);
  if (apart.length) {
    const pairs = [0, 4, 2].map((h) => `${COLOR_NAME[FACE_COLOR[h]]} and ${COLOR_NAME[FACE_COLOR[h + 1]]}`);
    return problem(`Opposite centers must be ${pairs[0]}, ${pairs[1]}, or ${pairs[2]}`, apart.flatMap((d) => [spot(d), spot(d + 1)]));
  }
  return problem("Wrong center color order", [0, 1, 2, 3, 4, 5].map(spot));
}

/**
 * A state turns can reach that has the shape and shows the colors, or the problem that
 * leaves none. Call it only for colors that fit under the outward-color rule.
 */
function reachableFit(shape: State, colors: FaceColors): { state: State; problem?: undefined } | { state: null; problem: Problem } {
  const a = attempt(shape, colors, "turned");
  const start = "The position editing started from can't be reached by turning";
  if (!a.state) return { state: null, problem: problem(start, []) };
  const st = a.state;
  // A side core center has no stickers, so any of them fits behind any extension center.
  // Only the one fused to it is ever there.
  for (const s of slotsOf(st, "extCenter")) {
    const behind = SLOT_NEIGHBOR[s * 6 + (outwardDir(s) ^ 1)];
    const own = FUSED_TO.get(st.occ[s])!;
    const at = st.occ.indexOf(own);
    if (behind < 0 || st.occ[behind] < 0 || CUBELETS[st.occ[behind]].kind !== "center") return { state: null, problem: problem(start, []) };
    if (at !== behind && !trade(st, at, behind)) return { state: null, problem: problem(start, []) };
  }
  const centers = centerProblem(st);
  if (centers) return { state: null, problem: centers };
  for (const set of CHANGE_SETS) {
    const t = st.clone();
    if (UNSEEN_CHANGES.every((change, i) => !(set & (1 << i)) || change(t)) && unreachableReason(t) === null) return { state: t };
  }
  // A shape edit can leave the core corners turned as no turns leave them. Any one of
  // them may be the one turned wrong, so the problem points at none.
  if (unreachableReason(st) === "the core corners are twisted")
    return { state: null, problem: problem("The core corners can't all have these orientations at once. One of them needs a different orientation", []) };
  return { state: null, problem: problem(`${start} (${unreachableReason(st)})`, []) };
}

/** Finds real cubelets showing `colors` on the shape of `shape` (see the top of this file). */
export function fitColors(shape: State, colors: FaceColors): Fit {
  const strict = attempt(shape, colors, "outward");
  if (strict.state) {
    const reach = reachableFit(shape, colors);
    if (reach.state) return { level: "reachable", state: reach.state, problems: [] };
    return { level: "possible", state: strict.state, problems: [reach.problem] };
  }
  const loose = attempt(shape, colors, "none");
  const problems: Problem[] = [];
  if (loose.state) {
    for (const s of strict.slots)
      if (strict.cand.get(s)!.length === 0) {
        // White and yellow never point out: that rule needs no knowledge of the cubelet.
        const facing = colors[s * 6 + outwardDir(s)];
        if (facing === "W" || facing === "Y") {
          problems.push(problem(`This cubelet's ${COLOR_NAME[facing]} sticker has the wrong color`, [s]));
          continue;
        }
        const cs = shownColors(colors, s);
        problems.push(problem(`No cubelet has ${listColors(cs)} arranged this way. One of its stickers has the wrong color`, [s]));
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
            out.size === 1 && o && o !== UNPAINTED && shown.size === 1
              ? `These ${n} ${KIND_NAME[kindOf(shape, spots[0])][1]} look the same, but the puzzle has only ${k} like that. One of them has a sticker with the wrong color`
              : `These ${n} ${KIND_NAME[kindOf(shape, spots[0])][1]} can't all be right at once. One of them has a sticker with the wrong color`,
            spots,
          ),
        );
      }
    if (!problems.length) problems.push({ text: "These colors can't all be right at once. A sticker has the wrong color", slots: [] });
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


// ---------------------------------------------------------------- shape editing
//
// The shape is which outer spots are filled, and it follows from the core alone: a core
// corner has outer cubelets on two of its three sides, a core single edge on one of its
// two, a core double edge on both, and the centers of two opposite faces have no
// extension center. A shape edit moves real cubelets, each as a rotation of the whole
// puzzle would carry it, so the result is always a position that can be drawn and fitted.
// The one thing such a move can leave wrong is the sum of the core corners' twists, which
// reachableFit reports.

/** The core slot the cubelet in outer slot s rests against. */
const coreOf = (s: number) => SLOT_NEIGHBOR[s * 6 + (outwardDir(s) ^ 1)];
/** The outer slots against core slot c. */
const outerOf = (c: number) => [0, 1, 2, 3, 4, 5].map((d) => SLOT_NEIGHBOR[c * 6 + d]).filter((n) => n >= 0 && outwardDir(n) >= 0);
/** How many coordinates of slot s are not zero: 3 for a corner, 2 for an edge, 1 for a center. */
const span = (s: number) => SLOT_POS[s].filter((c) => c !== 0).length;
const ALL_ROTS = [...Array(NUM_ROT).keys()];
const carries = (r: number, from: number, to: number) => slotAt(matVec(ROTATIONS[r], SLOT_POS[from])) === to;

/** One cubelet's part in a shape edit: from a slot to a slot, turned by rotation `rot`. */
export interface Carry {
  from: number;
  to: number;
  rot: number;
}

/**
 * How the cubelet in outer slot s can move by itself, as real cubelets move:
 * - "swing": it moves at once (around its core corner or core single edge to the bare
 *   side, or, an extension center, with the one opposite it to the faces that have none);
 * - "lift": it is against a core double edge and can go to any of `targets`, the bare
 *   sides of the core single edges;
 * - null: nothing (an empty slot or a core cubelet).
 */
function shapeTap(shape: State, s: number): { kind: "swing" } | { kind: "lift"; targets: number[] } | null {
  if (s < 0 || shape.occ[s] < 0 || outwardDir(s) < 0) return null;
  const c = coreOf(s);
  if (span(c) !== 2 || outerOf(c).some((n) => shape.occ[n] < 0)) return { kind: "swing" };
  const targets: number[] = [];
  for (let e = 0; e < NUM_SLOTS; e++) {
    if (outwardDir(e) >= 0 || span(e) !== 2) continue;
    const bare = outerOf(e).filter((n) => shape.occ[n] < 0);
    if (bare.length === 1) targets.push(bare[0]);
  }
  return { kind: "lift", targets };
}

/** The cubelets a tap on slot s moves (see shapeTap); `target` is where a lifted cubelet goes. */
function carriesFor(shape: State, s: number, target?: number): Carry[] | null {
  const tap = shapeTap(shape, s);
  if (!tap) return null;
  const c = coreOf(s);
  if (tap.kind === "lift") {
    if (target === undefined || !tap.targets.includes(target)) return null;
    const b = coreOf(target);
    // The double edge and the single edge trade places, the single edge's sticker to the side left bare.
    return [
      { from: s, to: target, rot: ALL_ROTS.find((r) => carries(r, s, target))! },
      { from: c, to: b, rot: ALL_ROTS.find((r) => carries(r, c, b))! },
      { from: b, to: c, rot: ALL_ROTS.find((r) => carries(r, b, c) && ROT_DIR[r * 6 + outwardDir(target)] === outwardDir(s))! },
    ];
  }
  if (span(c) === 1) {
    // A quarter turn of all the centers about the axis that keeps its extension centers.
    const axis = [0, 1, 2].find((a) => a !== outwardDir(s) >> 1 && shape.occ[SLOT_NEIGHBOR[CENTER_SLOTS[a * 2] * 6 + a * 2]] >= 0);
    if (axis === undefined) return null;
    const rot = axisRotation(axis, 1);
    const moved = CENTER_SLOTS.flatMap((x, d) => [x, SLOT_NEIGHBOR[x * 6 + d]]).filter((x) => x >= 0 && shape.occ[x] >= 0);
    return moved.map((from) => ({ from, to: slotAt(matVec(ROTATIONS[rot], SLOT_POS[from])), rot }));
  }
  // A turn of the core cubelet, with the outer cubelets on it, that leaves side s bare.
  const bare = outerOf(c).find((n) => shape.occ[n] < 0);
  if (bare === undefined) return null;
  const rot = ALL_ROTS.find((r) => carries(r, c, c) && carries(r, bare, s))!;
  return [c, ...outerOf(c).filter((n) => shape.occ[n] >= 0)].map((from) => ({ from, to: slotAt(matVec(ROTATIONS[rot], SLOT_POS[from])), rot }));
}

/** The position after the cubelet in slot s moves (see shapeTap), or null if it can't; `target` is where a lifted cubelet goes. */
function editShape(shape: State, s: number, target?: number): { shape: State; carries: Carry[] } | null {
  const list = carriesFor(shape, s, target);
  if (!list) return null;
  const st = shape.clone();
  for (const { from } of list) st.occ[from] = -1;
  for (const { from, to, rot } of list) {
    st.occ[to] = shape.occ[from];
    st.ori[to] = ROT_MUL[rot * NUM_ROT + shape.ori[from]];
  }
  return { shape: st, carries: list };
}

// A shape being edited may be wrong for a while, as paint may. A draft is a real position
// (`shape`) and the changes tapped since that no moves of real cubelets
// account for yet: extension cubelets taken away (`removed`) and blank ones put in
// (`added`). When the changed shape is one the puzzle can have (draftProblems finds
// nothing), the changes are made by moving real cubelets and the two sets empty.

export interface Draft {
  shape: State;
  /** Outer slots filled in `shape` that have been emptied. */
  removed: Set<number>;
  /** Outer slots empty in `shape` that have been filled. */
  added: Set<number>;
}

/** Whether slot s is filled in the draft's shape. */
export const draftFilled = (d: Draft, s: number) => (d.shape.occ[s] >= 0 && !d.removed.has(s)) || d.added.has(s);

const EDGE_SLOTS = ALL_SLOTS().filter((s) => outwardDir(s) < 0 && span(s) === 2);
function ALL_SLOTS() {
  return [...Array(NUM_SLOTS).keys()];
}
const filledOn = (d: Draft, c: number) => outerOf(c).filter((n) => draftFilled(d, n));

/** The empty spots a tap can fill: every outer spot without a cubelet (each is against a core cubelet). */
export function draftSpots(d: Draft): number[] {
  return ALL_SLOTS().filter((s) => outwardDir(s) >= 0 && !draftFilled(d, s));
}

const CORNER_SLOTS = ALL_SLOTS().filter((s) => outwardDir(s) < 0 && span(s) === 3);

/** What keeps the draft's shape from being one the puzzle can have, apart from the core corners' twists. */
export function draftProblems(d: Draft): Problem[] {
  const out: Problem[] = [];
  const count = (n: number, one: string, many: string, limit: string) =>
    n > 4 ? `${cap(numberWord(n))} ${many}, but there can be only four` : `${n ? `Only ${numberWord(n)}` : "No"} ${n === 1 ? one : many}, but ${limit}`;
  // Core cubelets with a number of extensions none of them can have, named one by one.
  const wrong = (slots: number[], kind: string, one: string, each: string) => {
    if (!slots.length) return;
    const text = slots.length === 1 ? `This ${kind} ${one}` : `These ${numberWord(slots.length)} ${kind}s ${each}`;
    out.push(problem(text, slots));
  };
  wrong(CORNER_SLOTS.filter((c) => filledOn(d, c).length < 2), "core corner", "has only one extension, but it has to have two", "have only one extension each, but each has to have two");
  wrong(CORNER_SLOTS.filter((c) => filledOn(d, c).length > 2), "core corner", "has three extensions, but it can have only two", "have three extensions each, but each can have only two");
  wrong(EDGE_SLOTS.filter((c) => filledOn(d, c).length === 0), "core edge", "has no extensions, but it has to have one or two", "have no extensions, but each has to have one or two");
  const doubles = EDGE_SLOTS.filter((c) => filledOn(d, c).length === 2);
  if (doubles.length !== 4) out.push(problem(count(doubles.length, "core edge has two extensions", "core edges have two extensions", "there must be four"), doubles.length > 4 ? doubles : []));
  const bare = CENTER_SLOTS.filter((c) => filledOn(d, c).length === 0);
  if (bare.length !== 2) out.push(problem(count(6 - bare.length, "center has an extension center", "centers have an extension center", "there must be four"), []));
  else if (CENTER_SLOTS.indexOf(bare[0]) >> 1 !== CENTER_SLOTS.indexOf(bare[1]) >> 1) out.push(problem("The two centers without an extension center must be opposite each other", bare));
  return out;
}

/** Makes the draft's changes by moving real cubelets, if its shape is one the puzzle can have. */
function settle(d: Draft) {
  if (!d.removed.size && !d.added.size) return;
  if (draftProblems(d).length) return;
  const want = ALL_SLOTS().map((s) => draftFilled(d, s));
  let shape = d.shape;
  for (let guard = 0; guard < 64; guard++) {
    // A cubelet that should not be where it is goes where one is missing.
    let next: ReturnType<typeof editShape> = null;
    for (const s of ALL_SLOTS()) {
      if (shape.occ[s] < 0 || want[s] || outwardDir(s) < 0) continue;
      const tap = shapeTap(shape, s);
      const target = tap?.kind === "lift" ? tap.targets.find((t) => want[t]) : undefined;
      if (tap?.kind === "lift" && target === undefined) continue;
      if ((next = editShape(shape, s, target))) break;
    }
    if (!next) break;
    shape = next.shape;
  }
  if (ALL_SLOTS().some((s) => shape.occ[s] >= 0 !== want[s])) return;
  d.shape = shape;
  d.removed.clear();
  d.added.clear();
}

/**
 * A tap with the Shape tool on slot s, changing only what is tapped:
 * - an extension cubelet goes away;
 * - an empty spot (draftSpots) gets a cubelet;
 * - a core corner or core single edge turns, with the cubelets on it, when they are real
 *   (no change waits on them).
 * Returns null if the tap does nothing; otherwise what it does to the paint (see
 * repaint) and the real cubelets the tap itself moved (`carries`, to animate).
 */
export function draftTap(d: Draft, s: number): TapResult | null {
  if (s < 0) return null;
  if (outwardDir(s) < 0) {
    // A tap on the core cubelet itself turns its unit: a corner clockwise as seen from
    // outside (a second tap gives the third way it can sit), a single edge over.
    const on = filledOn(d, s);
    if (outerOf(s).some((n) => d.removed.has(n) || d.added.has(n))) return null;
    const [bare] = outerOf(s).filter((n) => !draftFilled(d, n));
    const p = SLOT_POS[s];
    const clockwise = (n: number) => {
      const a = DIRS[outwardDir(bare)], b = DIRS[outwardDir(n)];
      return (a[1] * b[2] - a[2] * b[1]) * p[0] + (a[2] * b[0] - a[0] * b[2]) * p[1] + (a[0] * b[1] - a[1] * b[0]) * p[2] < 0;
    };
    const turn = span(s) === 3 ? on.find(clockwise) : span(s) === 2 && on.length === 1 ? on[0] : undefined;
    const next = turn === undefined ? null : editShape(d.shape, turn);
    if (!next) return null;
    d.shape = next.shape;
    return { carries: next.carries, unpaint: unitOf(s).flatMap(faces), move: [] };
  }
  const set = (t: number, on: boolean) => {
    const [undo, mark] = on ? [d.removed, d.added] : [d.added, d.removed];
    if (!undo.delete(t)) mark.add(t);
  };
  // Each face of a cubelet that comes covers the face of whatever is behind it, seen from
  // that side, and takes that face's color; a cubelet that goes leaves each of its colors
  // on the face it bares behind it.
  const comes = !draftFilled(d, s);
  const pairs: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const n = SLOT_NEIGHBOR[s * 6 + (k ^ 1)];
    if (n >= 0 && draftFilled(d, n)) pairs.push([n * 6 + k, s * 6 + k]);
  }
  set(s, comes);
  settle(d);
  return {
    carries: [],
    unpaint: [...faces(s), ...pairs.map(([behind]) => behind)],
    move: pairs.map(([behind, own]) => (comes ? [behind, own] : [own, behind])),
  };
}

/**
 * What a Shape tool tap does: the real cubelets it moved (to animate), the faces (slot * 6
 * + direction) whose stickers are no longer the ones painted (`unpaint`: the whole unit when
 * it turns; when a cubelet only comes or goes, its own spot and every face it covers or
 * bares, on the core cubelet and on neighbors alike), and the paint that moves from face
 * to face (`move`, by slot * 6 + direction: from each face a cubelet that comes covers to
 * its own face over it, seen from the same side, and back when it goes).
 */
export interface TapResult {
  carries: Carry[];
  unpaint: number[];
  move: [from: number, to: number][];
}

/** The paint after a tap (see TapResult): what it moves goes with it, and the rest of what it changed is cleared. */
export function repaint(paint: readonly (Color | undefined)[], tap: TapResult): (Color | undefined)[] {
  const out = paint.slice();
  for (const f of tap.unpaint) out[f] = undefined;
  for (const [from, to] of tap.move) out[to] = paint[from];
  return out;
}

/** The six faces of slot s, by slot * 6 + direction. */
const faces = (s: number) => [0, 1, 2, 3, 4, 5].map((k) => s * 6 + k);

/** The core slot and outer slots of the unit outer slot s belongs to: a core cubelet with the spots against it. */
function unitOf(s: number): number[] {
  const c = outwardDir(s) < 0 ? s : coreOf(s);
  return [c, ...outerOf(c)];
}

/**
 * What the draft's shape shows, given the stickers painted so far (`paint`, by slot * 6 +
 * direction). An outer cubelet's stickers are on the faces nothing can touch. A core
 * cubelet's one is where the cubelet in the shape has it, when that face is bare: the
 * sticker drawn there can always be painted, even while the shape is wrong (a core corner
 * with one extension has two bare sides, and the sticker is on one of them). When that
 * face is covered, it is on the cubelet's bare side, if it has just one (a core edge with
 * cubelets on both sides has none). A sticker without paint is UNPAINTED.
 */
export function draftColors(d: Draft, paint: readonly (Color | undefined)[]): FaceColors {
  const out: FaceColors = new Array(NUM_SLOTS * 6).fill(undefined);
  for (const s of ALL_SLOTS()) {
    if (!draftFilled(d, s)) continue;
    const outer = outwardDir(s) >= 0;
    const bare = outer ? [] : outerOf(s).filter((n) => !draftFilled(d, n));
    const open = (dir: number) => {
      const n = SLOT_NEIGHBOR[s * 6 + dir];
      return n !== -2 && !(n >= 0 && draftFilled(d, n));
    };
    // Where the cubelet in the shape has its sticker, if that face is bare.
    const drawn = outer || d.shape.occ[s] < 0 ? -1 : [0, 1, 2, 3, 4, 5].find((dir) => d.shape.colorAt(s, dir) !== null && open(dir)) ?? -1;
    for (let dir = 0; dir < 6; dir++) {
      const n = SLOT_NEIGHBOR[s * 6 + dir];
      if (!open(dir)) continue;
      const sticker = outer ? n === -1 : drawn >= 0 ? dir === drawn : bare.length === 1 && n === bare[0];
      out[s * 6 + dir] = sticker ? (paint[s * 6 + dir] ?? UNPAINTED) : null;
    }
  }
  return out;
}
