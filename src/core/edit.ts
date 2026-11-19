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
  /** Stickers its hint calls "circled" (slot, face direction): ones its colors can't tell apart. */
  marks?: { slot: number; face: number }[];
}

/** What a problem's spots should probably show instead: its words, and where it means. */
export interface Hint {
  text: string;
  /** The one spot the hint is about, when the problem names several. */
  slots?: number[];
  marks?: { slot: number; face: number }[];
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
  if (holders && cs.length === 3) return `No cubelet has ${listColors(cs)} arranged this way`;
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
/** A problem whose text ends in `hint`, if any (else `fallback`), haloing and marking where the hint means. */
const hinted = (text: string, slots: number[], hint: Hint | null, fallback?: string): Problem => {
  const end = hint?.text ?? fallback;
  const out: Problem = { text: end ? `${text}. ${end}` : text, slots: hint?.slots ?? slots };
  if (hint?.marks) out.marks = hint.marks;
  return out;
};

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
  const hint = centerHint(home, (d) => spot(d) === CENTER_SLOTS[d], spot);
  // Opposite spots whose colors aren't an opposite pair.
  const apart = [0, 2, 4].filter((d) => (home[d] ^ 1) !== home[d + 1]);
  if (apart.length) {
    const pairs = [0, 4, 2].map((h) => `${COLOR_NAME[FACE_COLOR[h]]} and ${COLOR_NAME[FACE_COLOR[h + 1]]}`);
    return hinted(`Opposite centers must be ${pairs[0]}, ${pairs[1]}, or ${pairs[2]}`, apart.flatMap((d) => [spot(d), spot(d + 1)]), hint);
  }
  return hinted("Wrong center color order", [0, 1, 2, 3, 4, 5].map(spot), hint);
}

/**
 * Which centers should be which color. A real puzzle's center colors are always some
 * rotation of solved's, with white and yellow on the two core centers that show (`core`
 * says which directions have one). The likeliest are those rotations that change the
 * fewest centers; each center shows a different color, so its color names it ("The red
 * center should probably be blue", "The red and orange centers should probably trade
 * places"). A center has one sticker, so up to three ways, as for one-sticker hints; else none.
 */
function centerHint(home: number[], core: (d: number) => boolean, spot: (d: number) => number): Hint | null {
  const name = (h: number) => COLOR_NAME[FACE_COLOR[h]];
  let best = Infinity;
  let ways: [number, number, number][][] = []; // per rotation: (direction, color now, color then)
  for (let r = 0; r < NUM_ROT; r++) {
    const want = [0, 1, 2, 3, 4, 5].map((d) => [0, 1, 2, 3, 4, 5].find((h) => ROT_DIR[r * 6 + h] === d)!);
    if (want.some((h, d) => (h === 2 || h === 3) !== core(d))) continue;
    const changes = [0, 1, 2, 3, 4, 5].filter((d) => want[d] !== home[d]).map((d): [number, number, number] => [d, home[d], want[d]]);
    if (changes.length > best) continue;
    if (changes.length < best) (best = changes.length), (ways = []);
    ways.push(changes);
  }
  if (!ways.length || best === 0 || ways.length > HINT_ONE_STICKER_OPTIONS) return null;
  // In the order colors are listed in, by the first color each way changes.
  const rank = (w: [number, number, number][]) => Math.min(...w.map(([, now]) => COLOR_ORDER.indexOf(FACE_COLOR[now])));
  ways.sort((a, b) => rank(a) - rank(b));
  const say = (changes: [number, number, number][], modal: string) => {
    if (changes.length === 2 && changes[0][1] === changes[1][2] && changes[0][2] === changes[1][1])
      return `the ${listColors(COLOR_ORDER.filter((c) => c === FACE_COLOR[changes[0][1]] || c === FACE_COLOR[changes[1][1]]))} centers ${modal} trade places`;
    if (changes.length > HINT_STICKERS) return null;
    return changes.map(([, now, then], i) => `the ${name(now)} center ${i ? "should" : modal} be ${name(then)}`).join(", and ");
  };
  const texts = ways.map((w, i) => say(w, i ? "should" : ways.length === 1 ? "should probably" : "should maybe"));
  if (texts.some((t) => t === null)) return null;
  return {
    text: texts.map((t, i) => (i ? `Or ${t}` : cap(t!))).join(". "),
    slots: [...new Set(ways.flatMap((w) => w.map(([d]) => spot(d))))],
  };
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
    return { state: null, problem: problem("The core corners can't all have these orientations at once. One of them needs to be rotated", []) };
  return { state: null, problem: problem(`${start} (${unreachableReason(st)})`, []) };
}

/** Finds real cubelets showing `colors` on the shape of `shape` (see the top of this file). */
/**
 * What the spots should probably show instead, from counting. No sticker is ever covered,
 * so once every sticker on the cubelets of one kind has a color, the colors they show,
 * cubelet by cubelet, are exactly the puzzle's cubelets of that kind. A cubelet no spot
 * shows is what one of the wrong spots should be; of those, the ones sharing the most
 * colors with what these spots show are named ("One of these should probably be yellow,
 * blue, and red"). Every center color shows on exactly one center of either kind, so for
 * centers it is the color no center shows. "Probably" for one answer, "maybe" for several:
 * the counts give the fewest stickers to change, and more than that may be wrong. Null when
 * the counts can't say: a sticker of that kind with no color yet, or nothing missing.
 * `wrong` is how many of the spots are wrong at least.
 */
export function missingColors(shape: State, colors: FaceColors, spots: number[], wrong = 1): Hint | null {
  const h = hintFor(shape, colors, spots, wrong);
  return h === null ? null : typeof h === "string" ? { text: h } : h;
}

function hintFor(shape: State, colors: FaceColors, spots: number[], wrong: number): string | Hint | null {
  const kind = kindOf(shape, spots[0]);
  const lead = spots.length === 1 ? "It" : `${cap(numberWord(wrong))} of these`;
  // Single colors join with "or"; lists of colors each get a sentence, so their commas can't run together.
  const say = (names: string[]) =>
    names.length === 1
      ? `${lead} should probably be ${names[0]}`
      : names.some((n) => / and |,/.test(n))
        ? [`${lead} should maybe be ${names[0]}`, ...names.slice(1).map((n) => `It could also be ${n}`)].join(". ")
        : `${lead} should maybe be ${names.join(" or ")}`;
  const centers = kind === "center" || kind === "extCenter";
  const counted = (s: number) => shape.occ[s] >= 0 && (centers ? ["center", "extCenter"].includes(CUBELETS[shape.occ[s]].kind) : CUBELETS[shape.occ[s]].kind === kind);
  const key = (cs: readonly (Color | null)[]) => COLOR_ORDER.filter((c) => cs.includes(c)).join("");
  const shown = new Map<string, number>();
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (!counted(s)) continue;
    const cs: Color[] = [];
    for (let d = 0; d < 6; d++) {
      const c = colors[s * 6 + d];
      if (c === UNPAINTED) return null;
      if (c) cs.push(c);
    }
    if (centers) for (const c of cs) shown.set(c, (shown.get(c) ?? 0) + 1);
    else shown.set(key(cs), (shown.get(key(cs)) ?? 0) + 1);
  }
  if (centers) {
    // The colors a center of these spots' kind can have (white or yellow on a core center,
    // a side color on an extension center) that no center of that kind shows.
    const kinds = new Set(spots.map((t) => CUBELETS[shape.occ[t]].kind));
    const can = new Set(CUBELETS.filter((c) => kinds.has(c.kind)).flatMap((c) => c.stickers.filter((x): x is Color => !!x)));
    const there = new Set<Color>();
    for (let s = 0; s < NUM_SLOTS; s++) if (shape.occ[s] >= 0 && kinds.has(CUBELETS[shape.occ[s]].kind)) for (const c of shownColors(colors, s)) there.add(c);
    const none = COLOR_ORDER.filter((c) => can.has(c) && !there.has(c));
    // Every color the kind can have is no help: the problem already says so.
    if (!none.length || none.length === can.size) return null;
    // A center's color is opposite the color of the center across from it, so of those
    // colors, the ones opposite those across from these spots are likelier.
    const across = (t: number) => {
      const p = SLOT_POS[t], far = Math.max(...p.map(Math.abs));
      for (const r of [far, 3 - far]) {
        const o = slotAt(p.map((v) => (-v / far) * r) as [number, number, number]);
        const c = o >= 0 ? shownColors(colors, o)[0] : undefined;
        if (c) return FACE_COLOR[FACE_COLOR.indexOf(c) ^ 1];
      }
      return undefined;
    };
    // Several wrong centers each need a different missing color: name them all, when the
    // counts leave exactly that many, else nothing a person could follow.
    if (wrong > 1) return none.length === wrong ? `${lead} should be ${listColors(none)}, one each` : null;
    const likely = none.filter((c) => spots.some((t) => across(t) === c));
    const left = likely.length ? likely : none;
    return left.length === 1 ? `${lead} should be ${COLOR_NAME[left[0]]}` : say(left.map((c) => COLOR_NAME[c]));
  }
  const have = new Map<string, number>();
  for (const c of CUBELETS) if (c.kind === kind) have.set(key(c.stickers), (have.get(key(c.stickers)) ?? 0) + 1);
  let short = new Set([...have].filter(([k, n]) => n > (shown.get(k) ?? 0)).map(([k]) => k));
  // With no cubelet missing, a spot's own colors are right and only their arrangement is wrong.
  if (!short.size) short = new Set(spots.map((t) => key(shownColors(colors, t))).filter((k) => have.has(k)));
  if (!short.size) return null;
  // A cubelet with one sticker is fixed by naming its color: the one color the counts
  // leave, said plainly. When they leave every color its kind can have, they add nothing
  // to the problem ("must be white or yellow"), so there is no hint.
  if (spots.every((t) => shownColors(colors, t).length === 1)) {
    const best = Math.min(...[...short].map((k) => Math.min(...spots.map((t) => (k.includes(shownColors(colors, t)[0]) ? 0 : 1)))));
    const left = [...short].filter((k) => spots.some((t) => (k.includes(shownColors(colors, t)[0]) ? 0 : 1) === best));
    if (left.length === [...have.keys()].length) return null;
    if (left.length === 1) return `${lead} should be ${listColors([...left[0]] as Color[])}`;
    return say(left.map((k) => listColors([...k] as Color[])));
  }
  // Otherwise, sticker by sticker. Every spot of this kind is some cubelet of this kind,
  // each a different one, turned as the outward-color rule allows. The likeliest ways to
  // make that so recolor the fewest stickers over all those spots together (two trading
  // places is one change), so a fix for one of these spots is offered only if some such
  // way uses it. A fix that suits this spot alone, but leaves another spot without the
  // cubelet it needs, is not.
  const all = [...Array(NUM_SLOTS).keys()].filter(counted);
  const ids = CUBELETS.filter((c) => c.kind === kind).map((c) => c.id);
  if (all.length !== ids.length) return null;
  const fits = all.map((t) => ids.map((id) => fitAt(colors, t, id)));
  const cost = fits.map((row) => row.map((f) => f?.cost ?? IMPOSSIBLE));
  const least = assignCost(cost);
  if (least >= IMPOSSIBLE) return null;
  const options: { spot: number; changes: Change[] }[] = [];
  let best = Infinity;
  for (const t of spots) {
    const i = all.indexOf(t);
    for (let j = 0; j < ids.length; j++) {
      const f = fits[i][j];
      if (!f || f.cost === 0) continue;
      const rest = cost.filter((_, r) => r !== i).map((row) => row.filter((_, c) => c !== j));
      if (f.cost + assignCost(rest) !== least) continue;
      if (f.cost < best) (best = f.cost), (options.length = 0);
      if (f.cost === best) options.push({ spot: t, changes: f.changes });
    }
  }
  // A hint is worth reading only while it is short: a fix of more than two stickers is
  // more a guess than a hint.
  if (!options.length || best > HINT_STICKERS) return null;
  return fixesText(colors, spots, options, wrong);
}

const IMPOSSIBLE = 1e6;

/** One sticker to recolor: its color, the color it should be, and the face it is on. */
type Change = [Color, Color, number];

/**
 * The fewest stickers of spot t to recolor so that it shows cubelet `id`, turned as the
 * outward-color rule allows, and which ones (from, to); null if no turn of it fits the spot's
 * shape of stickers. Two stickers trading places, and nothing else, counts as one change.
 */
function fitAt(colors: FaceColors, t: number, id: number): { cost: number; changes: Change[] } | null {
  const c = CUBELETS[id];
  const outDir = outwardDir(t);
  let best: { cost: number; changes: Change[] } | null = null;
  for (let o = 0; o < NUM_ROT; o++) {
    if (c.outward !== null && ROT_DIR[o * 6 + c.outward] !== outDir) continue;
    const changes: Change[] = [];
    let ok = true;
    for (let d = 0; d < 6 && ok; d++) {
      const want = colors[t * 6 + d];
      if (want === undefined) continue;
      const has = c.stickers[ROT_DIR[ROT_INV[o] * 6 + d]];
      if (want === null || want === UNPAINTED) ok = want === null ? has === null : has !== null;
      else if (has === null) ok = false;
      else if (has !== want) changes.push([want, has, d]);
    }
    if (!ok) continue;
    const cost = changes.length === 2 && changes[0][0] === changes[1][1] && changes[0][1] === changes[1][0] ? 1 : changes.length;
    if (!best || cost < best.cost) best = { cost, changes };
  }
  return best;
}

/** The least total of a square cost matrix over one-to-one assignments (the Hungarian method). */
function assignCost(a: number[][]): number {
  const n = a.length;
  if (!n) return 0;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++)
        if (!used[j]) {
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) (minv[j] = cur), (way[j] = j0);
          if (minv[j] < delta) (delta = minv[j]), (j1 = j);
        }
      for (let j = 0; j <= n; j++)
        if (used[j]) (u[p[j]] += delta), (v[j] -= delta);
        else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  let total = 0;
  for (let j = 1; j <= n; j++) total += a[p[j] - 1][j - 1];
  return total;
}

/** The colors of one spot, as a key that tells spots showing the same colors apart. */
const shownKey = (colors: FaceColors, s: number) => shownColors(colors, s).join("");

/**
 * Says which stickers to recolor: "Its red sticker should probably be orange", "Its blue and
 * orange stickers should probably trade places". Options on one sticker merge ("should maybe
 * be orange or blue"); each other option gets its own sentence, starting "Or". With several
 * spots, each option says which one by its colors, unless they all show the same.
 */
/**
 * The most stickers a hint asks to recolor, and the most ways it offers: three when each
 * recolors one sticker, which reads quickly, else two.
 */
const HINT_STICKERS = 2, HINT_OPTIONS = 2, HINT_ONE_STICKER_OPTIONS = 3;

function fixesText(colors: FaceColors, spots: number[], options: { spot: number; changes: Change[] }[], wrong: number): Hint | null {
  // Merge options that recolor the same single sticker of the same spot.
  const seen = new Map<string, { spot: number; changes: Change[]; to: Color[]; faces: Set<number> }>();
  for (const o of options) {
    const k = o.changes.length === 1 ? `${o.spot}|${o.changes[0][0]}` : `${o.spot}|${o.changes.map((c) => `${c[0]}>${c[1]}`).sort().join(",")}`;
    const had = seen.get(k);
    if (!had) seen.set(k, { ...o, to: o.changes.length === 1 ? [o.changes[0][1]] : [], faces: new Set(o.changes.map((c) => c[2])) });
    else {
      if (o.changes.length === 1 && !had.to.includes(o.changes[0][1])) had.to.push(o.changes[0][1]);
      for (const c of o.changes) had.faces.add(c[2]);
    }
  }
  // The same fix on look-alike spots is one fix: either spot will do.
  const list = [...new Map([...seen.values()].map((o) => [`${shownKey(colors, o.spot)}|${o.changes.map((c) => `${c[0]}>${c[1]}`).sort().join(",")}|${o.to.join()}`, o])).values()];
  if (list.length > (list.every((o) => o.changes.length === 1) ? HINT_ONE_STICKER_OPTIONS : HINT_OPTIONS)) return null;
  // The hint is about the spots its options are for, and the halo marks only those: a fix
  // that works on one look-alike spot may not on another.
  const mine = [...new Set(list.map((o) => o.spot).concat(options.map((o) => o.spot)))].filter((t) => spots.includes(t));
  const at = mine.length < spots.length ? mine : spots;
  const one = at.length === 1;
  const same = at.every((t) => shownKey(colors, t) === shownKey(colors, at[0]));
  const where = (t: number) => {
    if (one) return "";
    if (same) return "on one of these, ";
    const like = at.filter((u) => shownKey(colors, u) === shownKey(colors, t)).length;
    const cs = listColors(shownColors(colors, t));
    return like === 1 ? `on the one that is ${cs}, ` : `on one of those that are ${cs}, `;
  };
  const its = one ? "its" : "the";
  const marks: { slot: number; face: number }[] = [];
  // One clause per sticker, or per pair of stickers trading places. Stickers of one color
  // can't be told apart by it, so one meant alone is circled in the view ("its circled
  // yellow sticker"), when the hint is sure which; else "one of its yellow stickers".
  const clauses = (t: number, changes: Change[], modal: string, sure: boolean) => {
    const left = [...changes];
    const out: string[] = [];
    const mark = (face: number) => marks.push({ slot: t, face });
    while (left.length) {
      const [from, to, face] = left.shift()!;
      const verb = out.length ? "should" : modal;
      const back = left.findIndex(([f, x]) => f === to && x === from);
      if (back >= 0) {
        left.splice(back, 1);
        out.push(`${its} ${listColors(COLOR_ORDER.filter((c) => c === from || c === to))} stickers ${verb} trade places`);
        continue;
      }
      const n = shownColors(colors, t).filter((c) => c === from).length;
      const alike = left.filter(([f]) => f === from);
      if (n > 1 && alike.length === n - 1) {
        for (const x of alike) left.splice(left.indexOf(x), 1);
        if (sure && n === 2) {
          mark(face);
          out.push(`${its} circled ${COLOR_NAME[from]} sticker ${verb} be ${COLOR_NAME[to]}, and ${its} other ${COLOR_NAME[from]} sticker ${COLOR_NAME[alike[0][1]]}`);
        } else out.push(`${its} ${COLOR_NAME[from]} stickers ${verb} be ${listColors([to, ...alike.map(([, x]) => x)])}, one each`);
      } else if (n > 1 && sure && !alike.length) {
        mark(face);
        out.push(`${its} circled ${COLOR_NAME[from]} sticker ${verb} be ${COLOR_NAME[to]}`);
      } else out.push(`${n > 1 ? `one of ${its} ${COLOR_NAME[from]} stickers` : `${its} ${COLOR_NAME[from]} sticker`} ${verb} be ${COLOR_NAME[to]}`);
    }
    return out.length < 3 ? out.join(", and ") : `${out.slice(0, -1).join(", ")}, and ${out[out.length - 1]}`;
  };
  const modal = list.length === 1 && list[0].to.length <= 1 ? "should probably" : "should maybe";
  // Sure of a sticker: one option, on one spot, its changes on one face each.
  const sure = list.length === 1 && one && list[0].faces.size === new Set(list[0].changes.map((c) => c[2])).size;
  const sentences = list.map((o, i) => {
    let body: string;
    if (o.to.length > 1) {
      const [from, , face] = o.changes[0];
      const n = shownColors(colors, o.spot).filter((c) => c === from).length;
      const named = n > 1 && sure && o.faces.size === 1 ? (marks.push({ slot: o.spot, face }), `${its} circled ${COLOR_NAME[from]} sticker`) : n > 1 ? `one of ${its} ${COLOR_NAME[from]} stickers` : `${its} ${COLOR_NAME[from]} sticker`;
      body = `${named} ${i ? "should" : modal} be ${listColors(COLOR_ORDER.filter((c) => o.to.includes(c)), "or")}`;
    } else body = clauses(o.spot, o.changes, i ? "should" : modal, sure);
    const text = `${i && where(o.spot) === where(list[i - 1].spot) ? "" : where(o.spot)}${body}`;
    return i ? `Or ${text}` : cap(text);
  });
  const lead = wrong > 1 ? `At least ${numberWord(wrong)} of these have a sticker with the wrong color. ` : "";
  return { text: lead + sentences.join(". "), slots: at !== spots ? at : undefined, marks: marks.length ? marks : undefined };
}

/**
 * More spots than cubelets that fit them, the spots showing different colors: says what they
 * share when that alone leaves so few cubelets ("show green, but only four have green"), and
 * how many of the spots have a sticker with the wrong color.
 */
function tooFew(shape: State, colors: FaceColors, spots: number[], fit: number): [string, Hint | null] {
  const kind = kindOf(shape, spots[0]);
  const [one, many] = KIND_NAME[kind];
  const n = numberWord(spots.length), k = numberWord(fit);
  const wrong = spots.length - fit;
  const fix = `At least ${numberWord(wrong)} of them ${wrong === 1 ? "has" : "have"} a sticker with the wrong color`;
  const shared = COLOR_ORDER.filter((c) => spots.every((t) => shownColors(colors, t).includes(c)));
  const having = CUBELETS.filter((c) => c.kind === kind && shared.every((x) => c.stickers.includes(x))).length;
  const hint = missingColors(shape, colors, spots, wrong);
  const end = hint?.text ?? fix;
  if (shared.length && having === fit)
    return [`These ${n} ${many} show ${listColors(shared)}, but only ${k} ${fit === 1 ? "has" : "have"} ${listColors(shared)}. ${end}`, hint];
  return [`Only ${k} ${fit === 1 ? one : many} ${fit === 1 ? "has" : "have"} colors like these ${n} do. ${end}`, hint];
}

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
          problems.push(hinted(`This cubelet's ${COLOR_NAME[facing]} sticker has the wrong color`, [s], missingColors(shape, colors, [s])));
          continue;
        }
        const cs = shownColors(colors, s);
        problems.push(hinted(`No cubelet has ${listColors(cs)} arranged this way`, [s], missingColors(shape, colors, [s]), "One of its stickers has the wrong color"));
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
          hinted(
            out.size === 1 && o && o !== UNPAINTED && shown.size === 1
              ? `These ${n} ${KIND_NAME[kindOf(shape, spots[0])][1]} look the same, but the puzzle has only ${k} like that`
              : `These ${n} ${KIND_NAME[kindOf(shape, spots[0])][1]} can't all be right at once`,
            spots,
            missingColors(shape, colors, spots, spots.length - g.ids.size),
            "One of them has a sticker with the wrong color",
          ),
        );
      }
    if (!problems.length) problems.push({ text: "These colors can't all be right at once. A sticker has the wrong color", slots: [] });
    return { level: "cubelets", state: loose.state, problems };
  }
  for (const s of loose.slots)
    if (loose.cand.get(s)!.length === 0) {
      const cs = shownColors(colors, s);
      problems.push(hinted(noCubelet(CUBELETS[shape.occ[s]].kind, cs), [s], missingColors(shape, colors, [s])));
    }
  if (!problems.length) {
    // Every slot has candidates, but some spots compete for too few cubelets.
    const groups = competing(loose);
    for (const g of groups) {
      const spots = [...g.slots];
      const shown = new Set(spots.map((t) => listColors(shownColors(colors, t))));
      const n = numberWord(spots.length), k = numberWord(g.ids.size);
      if (shown.size === 1)
        problems.push(hinted(`${cap(n)} ${KIND_NAME[kindOf(shape, spots[0])][1]} are ${[...shown][0]}, but there can be only ${k} like that`, spots, missingColors(shape, colors, spots, spots.length - g.ids.size)));
      else {
        const [text, hint] = tooFew(shape, colors, spots, g.ids.size);
        problems.push({ ...hinted(text, spots, null), slots: hint?.slots ?? spots, ...(hint?.marks ? { marks: hint.marks } : {}) });
      }
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
  if (!out.length) return out;
  const taps = shapeTaps(d);
  return out.map((p) => shapeHint(d, p, taps));
}

/**
 * The spots the fewest taps change on the way to a shape the puzzle can have. A shape is
 * one when every core corner has two of its three spots filled, every core edge one or
 * both of its two (both on exactly four of them), and every center its one spot filled but
 * for two opposite ones; so each core cubelet is chosen on its own, but for which four edges
 * have two, which two centers have none, and the corners' twists, which the bare spots set
 * and which must add up to whole turns (so of a corner's two bare spots, the one that keeps
 * the twists whole is the one to fill). A spot is in the answer when some way with the
 * fewest taps changes it (the least cost with that spot forced to change is the least).
 */
/**
 * How far a core corner is twisted when spot `bare` is its bare one: none with it up or
 * down, else a third of a turn one way or the other, by which side and the corner's
 * handedness. Turns keep the sum over the corners a whole number of turns.
 */
function cornerTwist(c: number, bare: number): number {
  const axis = outwardDir(bare) >> 1;
  const [x, y, z] = SLOT_POS[c];
  return axis === 1 ? 0 : (axis === 0) === x * y * z > 0 ? 1 : 2;
}

function shapeTaps(d: Draft): number[] {
  const BIG = 1000;
  const cost = (forced: number) => {
    const at = (t: number, want: boolean) => (want === draftFilled(d, t) ? (t === forced ? BIG : 0) : 1);
    // Corners: which spot is bare, with the twists adding up to a whole turn (by dynamic
    // programming over the sum, mod 3).
    let sums = [0, BIG, BIG];
    for (const c of CORNER_SLOTS) {
      const o = outerOf(c);
      const next = [BIG, BIG, BIG];
      o.forEach((bare, drop) => {
        const k = o.reduce((sum, t, i) => sum + at(t, i !== drop), 0);
        const w = cornerTwist(c, bare);
        for (let r = 0; r < 3; r++) next[(r + w) % 3] = Math.min(next[(r + w) % 3], sums[r] + k);
      });
      sums = next;
    }
    let total = sums[0];
    const extra: number[] = [];
    for (const c of EDGE_SLOTS) {
      const [a, b] = outerOf(c);
      const one = Math.min(at(a, true) + at(b, false), at(a, false) + at(b, true));
      total += one;
      extra.push(at(a, true) + at(b, true) - one);
    }
    total += extra.sort((x, y) => x - y).slice(0, 4).reduce((x, y) => x + y, 0);
    total += Math.min(...[0, 1, 2].map((k) => CENTER_SLOTS.reduce((sum, c, i) => sum + outerOf(c).reduce((t2, t) => t2 + at(t, i >> 1 !== k), 0), 0)));
    return total;
  };
  const least = cost(-1);
  if (!least) return [];
  return ALL_SLOTS().filter((t) => outwardDir(t) >= 0 && cost(t) === least);
}

/**
 * A shape problem with what to tap: of the spots the fewest taps change (`taps`), those on
 * the core cubelets the problem names (or of the kind it is about, when it names none),
 * taking one away before putting one in, each haloed ("This extension should probably be
 * removed", "An extension should probably be added here"). One tap at a time: the next
 * problem's hint goes on from there.
 */
function shapeHint(d: Draft, p: Problem, taps: number[]): Problem {
  if (!taps.length) return p;
  const about = (t: number) =>
    p.slots.length ? p.slots.includes(coreOf(t)) || p.slots.includes(t) : / centers? /.test(p.text) ? span(coreOf(t)) === 1 : / core edges? /.test(p.text) ? span(coreOf(t)) === 2 : true;
  const mine = taps.filter(about);
  const pool = mine.length ? mine : taps;
  const off = pool.filter((t) => draftFilled(d, t));
  const pick = off.length ? off : pool;
  const noun = pick.every((t) => span(coreOf(t)) === 1) ? "extension center" : "extension";
  const text = off.length
    ? pick.length === 1
      ? `This ${noun} should probably be removed`
      : `One of these ${noun}s should probably be removed`
    : `An ${noun} should probably be added ${pick.length === 1 ? "here" : "in one of these spots"}`;
  // The halo marks the extensions to take away, or the empty spots to fill (the Lab draws a
  // glass box in each, haloed).
  return { text: `${p.text}. ${text}`, slots: pick };
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
