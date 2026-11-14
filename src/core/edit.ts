// Fitting edited sticker colors to real cubelets.
//
// The Lab's color editor keeps the shape (which slots are filled) and lets the owner
// repaint the stickers that can be seen. fitColors finds a state with that shape whose
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
    return { state: null, problem: problem("The core corners can't all be turned this way at once. One of them needs another turn", []) };
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


// ---------------------------------------------------------------- shape editing
//
// The shape is which outer spots are filled, and it follows from the core alone: a core
// corner has outer cubelets on two of its three sides, a core single edge on one of its
// two, a core double edge on both, and the centers of two opposite faces have no
// extension center. A shape edit moves real cubelets, each as a rotation of the whole
// puzzle would carry it, so the result is always a position that can be drawn and fitted;
// the paint goes with the cubelets. The one thing an edit can leave wrong is the sum of
// the core corners' twists, which reachableFit reports.

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
 * What tapping the cubelet in slot s with the Shape tool does:
 * - "swing": it moves at once (around its core corner or core single edge to the bare
 *   side, or, an extension center, with the one opposite it to the faces that have none);
 * - "lift": it is against a core double edge and can go to any of `targets`, the bare
 *   sides of the core single edges;
 * - null: nothing (an empty slot or a core cubelet).
 */
export function shapeTap(shape: State, s: number): { kind: "swing" } | { kind: "lift"; targets: number[] } | null {
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

/**
 * The shape and paint after tapping the cubelet in slot s with the Shape tool (see
 * shapeTap), or null if the tap does nothing. Paint moves with its cubelet; a face the
 * edit uncovers takes the color of the cubelet now there.
 */
export function editShape(shape: State, colors: FaceColors, s: number, target?: number): { shape: State; colors: FaceColors; carries: Carry[] } | null {
  const list = carriesFor(shape, s, target);
  if (!list) return null;
  const st = shape.clone();
  const out = colors.slice();
  for (const { from } of list) {
    st.occ[from] = -1;
    for (let d = 0; d < 6; d++) out[from * 6 + d] = undefined;
  }
  for (const { from, to, rot } of list) {
    st.occ[to] = shape.occ[from];
    st.ori[to] = ROT_MUL[rot * NUM_ROT + shape.ori[from]];
    for (let d = 0; d < 6; d++) out[to * 6 + ROT_DIR[rot * 6 + d]] = colors[from * 6 + d];
  }
  for (let t = 0; t < NUM_SLOTS; t++)
    for (let d = 0; d < 6; d++) {
      const i = t * 6 + d;
      if (st.occ[t] < 0 || !isExposed(st, t, d)) out[i] = undefined;
      else if (out[i] === undefined) out[i] = st.colorAt(t, d);
    }
  return { shape: st, colors: out, carries: list };
}
