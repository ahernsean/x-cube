// A step-by-step solver: from any position turns can reach to solved, as a list of steps a
// person could follow, each with a goal, its turns, and what it changes.
//
// The method (it is not the shortest; it is one a person can learn):
//   1. hold:   turn the whole puzzle so white is up.
//   2. shape:  back to the X shape, with face turns (found by search).
//   3. core:   white core cubelets up, yellow down, with the shape-keeping turns
//              (U, D, R2, L2, F2, B2).
//   4. parity: if the outer corners, or the outer edges, need an odd number of swaps, one
//              turn makes both even: an outer turn swaps both oddly, and U swaps only the
//              edges oddly (the white core cubelets it moves are look-alikes).
//   5. corners, 6. edges: three at a time, each step one fixed 3-cycle wrapped in setup
//              turns: [setup: cycle]. An outer cubelet is turned one way in each spot, so
//              placing it is all there is to do.
// Steps 2 and 3 scramble the outer cubelets freely, and may trade look-alike core cubelets; steps 4 to 6 change nothing but the
// cubelets they name.
//
// Ease. Turns are chosen for a person's hands, not for their number (EASE): the back
// face and back extension are the hardest to turn, then the bottom, then the H and S
// slices; M is fine. A step may begin with a regrip, a turn of the whole puzzle about its
// vertical axis, when that makes the rest easier; a regrip is never in the middle of a
// step. So the side centers are not fixed in space: the "grip" is how many quarter turns
// the puzzle is from green in front, and each outer cubelet's home turns with it.

import { isHomeX, isSolved } from "./analyze.ts";
import { DIRS, ROT_DIR, ROTATIONS, axisRotation, matVec, type Vec3 } from "./geometry.ts";
import { formatAlg, parseAlg } from "./notation.ts";
import { COLOR_NAME, CUBELETS, FACE_COLOR, MOVE_DEFS, NUM_SLOTS, SLOT_POS, State, applyTurn, applyTurns, invertTurns, slotAt, type Kind, type Turn } from "./puzzle.ts";
import { unreachableReason } from "./serialize.ts";

export type Stage = "hold" | "shape" | "core" | "coreTop" | "coreTopC" | "coreMiddle" | "coreBottom" | "coreBottomC" | "parity" | "corners" | "edges" | "topEdges" | "topCorners" | "sideEdges" | "bottomCorners" | "bottomEdges";

/**
 * The order the outer cubelets are solved in. Both orders use the same two 3-cycles.
 * - "kinds": every X-face corner, then every extension edge.
 * - "layers": the white X-face's edges, then its corners, then the extension side edges,
 *   then the yellow X-face's corners, then its edges: top to bottom, as a 3x3x3 is often
 *   solved. Cubelets of later layers are moved about freely until their turn comes.
 */
export type Mode = "kinds" | "layers";

export interface SolveStep {
  stage: Stage;
  /** What the step achieves, in the owner's terms. */
  goal: string;
  /** The turns in notation, as [setup: cycle] where the step is one. */
  alg: string;
  turns: Turn[];
  /**
   * The cubelets the step is for, by the slot each is in before the step. In the parity,
   * corners and edges stages, where each goes; in the shape and core stages the pair is
   * the same slot twice, marking a spot that is wrong before the step and right after.
   */
  moved: [from: number, to: number][];
  /** Slots, before the step, of cubelets the step may leave anywhere: nothing depends on them yet. */
  free: number[];
  /**
   * The step's turns in parts, in order, with how many turns each has: a cycle step is an
   * optional regrip, the setup, the cycle, and the setup undone; any other step is one part.
   */
  parts: { name: "regrip" | "setup" | "cycle" | "undo" | "turns"; turns: number }[];
  /** In a cycle step: the slots, before the step, of the moved cubelets that end up solved. The others are only passing through. */
  lands: number[];
  /**
   * Quarter turns of the whole puzzle (y) the step begins with, 0 to 3. `moved` gives
   * places as the puzzle is held before the step: after it, each is turned with the regrip.
   */
  regrip: number;
}

// ---------------------------------------------------------------- shared tables

const turn = (name: string): Turn => parseAlg(name)[0];
const SLOTS = [...Array(NUM_SLOTS).keys()];
const isCore = (s: number) => SLOT_POS[s].every((c) => Math.abs(c) < 2);
const nonzero = (s: number) => SLOT_POS[s].filter((c) => c !== 0).length;
const CORNER_SLOTS = SLOTS.filter((s) => isCore(s) && nonzero(s) === 3);
const EDGE_SLOTS = SLOTS.filter((s) => isCore(s) && nonzero(s) === 2);
const SOLVED = State.solved();
const homeSlots = (kind: Kind) => CUBELETS.filter((c) => c.kind === kind).map((c) => c.home);
const kindAt = (st: State, s: number) => CUBELETS[st.occ[s]].kind;

/** Where a turn sends each slot's cubelet (the same for every position the turn is allowed in). */
function slotPerm(t: Turn): Int16Array {
  const d = MOVE_DEFS[t.def];
  const m = ROTATIONS[axisRotation(d.axis, d.ccw * t.amount)];
  const p = Int16Array.from(SLOTS);
  for (const s of d.slots) p[s] = slotAt(matVec(m, SLOT_POS[s]));
  return p;
}

// ---------------------------------------------------------------- ease and grip

/** How hard each kind of turn is on the hands (lower is easier), by move name. */
const EASE: Record<string, number> = { U: 2, R: 2, L: 2, F: 2, r: 2, l: 2, f: 2, M: 2, D: 4, d: 4, u: 4, H: 6, S: 6, E: 6, B: 8, b: 8, x: 4, y: 4, z: 4 };
const ease = (turns: readonly Turn[]) => turns.reduce((sum, t) => sum + EASE[MOVE_DEFS[t.def].name], 0);
const ALL_TURNS: Turn[] = MOVE_DEFS.flatMap((_, def) => ([1, 2, 3] as const).map((amount) => ({ def, amount })));

const compose = (first: Int16Array, then: Int16Array) => first.map((s) => then[s]);
const Y = slotPerm(turn("y"));
/** Y_POWER[m][s]: where the cubelet in slot s is after m regrips (y turns). */
const Y_POWER = [Int16Array.from(SLOTS), Y, compose(Y, Y), compose(compose(Y, Y), Y)];
const REGRIP = [[], [turn("y")], [turn("y2")], [turn("y'")]];
/** The turn that does, after one regrip, what t did before it: the same layer by its new name. */
const AFTER_Y = new Map(
  ALL_TURNS.map((t) => {
    const want = compose(slotPerm(t), Y).join();
    return [t, ALL_TURNS.find((u) => MOVE_DEFS[u.def].kind === MOVE_DEFS[t.def].kind && compose(Y, slotPerm(u)).join() === want)!] as const;
  }),
);
const sameTurn = (t: Turn) => ALL_TURNS[t.def * 3 + t.amount - 1];
/** The turns as named after m regrips. */
const regripped = (turns: readonly Turn[], m: number): Turn[] => (m ? regripped(turns.map((t) => AFTER_Y.get(sameTurn(t))!), m - 1) : [...turns]);

// ---------------------------------------------------------------- 1. hold

const ROTATION_TURNS = ["x", "x'", "z", "z'", "x2"].map(turn);
const centerAt = (st: State, home: number) => st.occ.indexOf(SOLVED.occ[home]);
const UP = slotAt([0, 1, 0]);
const FRONT = slotAt([0, 0, 1]);
const held = (st: State) => centerAt(st, UP) === UP;
/** The grip: how many regrips the puzzle is from green in front (with white up). */
const gripOf = (st: State) => Y_POWER.findIndex((p) => p[FRONT] === centerAt(st, FRONT));

function holdTurns(st: State): Turn[] {
  for (const t of ROTATION_TURNS) {
    const after = st.clone();
    applyTurn(after, t);
    if (held(after)) return [t];
  }
  throw new Error("the centers can't be turned to white up");
}

// ---------------------------------------------------------------- 2. shape
//
// The shape depends on the core alone: which way each core corner's and core single
// edge's sticker faces, and where the four core double edges are. Each cubelet's
// "marker" is that sticker's face (for a double edge, its front or back face), and the
// tables below follow the markers' axes through face turns, as three coordinates:
// corners (3^8), edges (2^12), and the double edges' places (495).

const FACE_TURNS = ["R", "L", "U", "D", "F", "B"].flatMap((f) => [f, f + "2", f + "'"]).map(turn);
const N_TWIST = 3 ** 8, N_FLIP = 1 << 12;
/** The axis an edge slot's marker is on when its bit is 0: up-down in the top and bottom layers, front-back in the middle. */
const mainAxis = (s: number) => (SLOT_POS[s][1] ? 1 : 2);
const otherAxis = (s: number) => [0, 1, 2].find((a) => SLOT_POS[s][a] !== 0 && a !== mainAxis(s))!;
const MIDDLE_MASK = EDGE_SLOTS.reduce((m, s, i) => m | (SLOT_POS[s][1] === 0 ? 1 << i : 0), 0);
const PLACE_MASKS = [...Array(N_FLIP).keys()].filter((m) => bitCount(m) === 4);
const PLACE_INDEX = new Int16Array(N_FLIP).fill(-1);
PLACE_MASKS.forEach((m, i) => (PLACE_INDEX[m] = i));
const N_PLACE = PLACE_MASKS.length; // 495
function bitCount(n: number): number {
  return n ? (n & 1) + bitCount(n >> 1) : 0;
}

/** The three coordinates of a position's core. */
function shapeCoords(st: State): [twist: number, flip: number, place: number] {
  const markerAxis = (s: number) => {
    const c = CUBELETS[st.occ[s]];
    const h = SLOT_POS[c.home];
    const marker = h[1] ? (h[1] > 0 ? 2 : 3) : h[2] > 0 ? 4 : 5;
    return ROT_DIR[st.ori[s] * 6 + marker] >> 1;
  };
  let twist = 0, flip = 0, place = 0;
  CORNER_SLOTS.forEach((s, i) => (twist += markerAxis(s) * 3 ** i));
  EDGE_SLOTS.forEach((s, i) => {
    if (markerAxis(s) !== mainAxis(s)) flip |= 1 << i;
    if (kindAt(st, s) === "doubleEdge") place |= 1 << i;
  });
  return [twist, flip, PLACE_INDEX[place]];
}

interface ShapeTables {
  twist: Uint16Array; // [coordinate * 18 + face turn] -> coordinate
  flip: Uint16Array;
  place: Uint16Array;
  /** Fewest face turns to the X shape, from the corners and places alone, and from the edges and places alone. */
  twistDist: Uint8Array;
  flipDist: Uint8Array;
}
let shapeTables: ShapeTables | null = null;

function buildShapeTables(): ShapeTables {
  const twist = new Uint16Array(N_TWIST * 18), flip = new Uint16Array(N_FLIP * 18), place = new Uint16Array(N_PLACE * 18);
  FACE_TURNS.forEach((t, m) => {
    const d = MOVE_DEFS[t.def];
    const rot = axisRotation(d.axis, d.ccw * t.amount);
    const perm = slotPerm(t);
    const axisTo = [0, 1, 2].map((a) => ROT_DIR[rot * 6 + a * 2] >> 1);
    const cTo = CORNER_SLOTS.map((s) => CORNER_SLOTS.indexOf(perm[s]));
    const eTo = EDGE_SLOTS.map((s) => EDGE_SLOTS.indexOf(perm[s]));
    for (let c = 0; c < N_TWIST; c++) {
      let out = 0;
      for (let i = 0, rest = c; i < 8; i++, rest = (rest / 3) | 0) out += (cTo[i] === i ? rest % 3 : axisTo[rest % 3]) * 3 ** cTo[i];
      twist[c * 18 + m] = out;
    }
    for (let c = 0; c < N_FLIP; c++) {
      let out = 0;
      EDGE_SLOTS.forEach((s, i) => {
        const before = c & (1 << i) ? otherAxis(s) : mainAxis(s);
        const axis = eTo[i] === i ? before : axisTo[before]; // only the turned layer's cubelets turn
        if (axis !== mainAxis(EDGE_SLOTS[eTo[i]])) out |= 1 << eTo[i];
      });
      flip[c * 18 + m] = out;
    }
    PLACE_MASKS.forEach((mask, c) => {
      let out = 0;
      for (let i = 0; i < 12; i++) if (mask & (1 << i)) out |= 1 << eTo[i];
      place[c * 18 + m] = PLACE_INDEX[out];
    });
  });
  // The X shape: every corner's marker up or down, the double edges in the middle layer,
  // and every single edge's marker up or down. A double edge may face either way.
  const goalPlace = PLACE_INDEX[MIDDLE_MASK];
  const distances = (n: number, moves: Uint16Array, goals: number[]) => {
    const dist = new Uint8Array(n * N_PLACE).fill(255);
    let frontier = goals.map((g) => g * N_PLACE + goalPlace);
    for (const g of frontier) dist[g] = 0;
    for (let depth = 1; frontier.length; depth++) {
      const next: number[] = [];
      for (const at of frontier) {
        const a = (at / N_PLACE) | 0, p = at % N_PLACE;
        for (let m = 0; m < 18; m++) {
          const to = moves[a * 18 + m] * N_PLACE + place[p * 18 + m];
          if (dist[to] === 255) {
            dist[to] = depth;
            next.push(to);
          }
        }
      }
      frontier = next;
    }
    return dist;
  };
  const upright = [...Array(8).keys()].reduce((sum, i) => sum + 3 ** i, 0);
  const flipGoals = [...Array(N_FLIP).keys()].filter((f) => (f & ~MIDDLE_MASK) === 0);
  return { twist, flip, place, twistDist: distances(N_TWIST, twist, [upright]), flipDist: distances(N_FLIP, flip, flipGoals) };
}

/**
 * The easiest turns found that bring the held position st to the X shape, and the regrip
 * to begin with: every way with the fewest face turns, and (while the search stays small)
 * with one more, is weighed by ease under each of the four grips.
 */
function shapeTurns(st: State): { turns: Turn[]; regrip: number } {
  const T = (shapeTables ??= buildShapeTables());
  const [twist0, flip0, place0] = shapeCoords(st);
  const left = (tw: number, fl: number, pl: number) => Math.max(T.twistDist[tw * N_PLACE + pl], T.flipDist[fl * N_PLACE + pl]);
  const fewest = left(twist0, flip0, place0);
  if (fewest === 255) throw new Error("no face turns bring this core to the X shape");
  const path: number[] = [];
  const found: number[][] = [];
  let nodes = 0;
  const dfs = (tw: number, fl: number, pl: number, budget: number, lastFace: number) => {
    const h = left(tw, fl, pl);
    if (h === 0) {
      if (budget === 0) found.push([...path]);
      return;
    }
    if (h > budget || found.length >= 4000 || nodes++ > 400000) return;
    for (let m = 0; m < 18; m++) {
      const face = (m / 3) | 0;
      // One turn per face in a row, and opposite faces (which commute) in one order only.
      if (face === lastFace || (face === (lastFace ^ 1) && face < lastFace)) continue;
      path.push(m);
      dfs(T.twist[tw * 18 + m], T.flip[fl * 18 + m], T.place[pl * 18 + m], budget - 1, face);
      path.pop();
    }
  };
  let budget = fewest;
  for (; !found.length && budget <= 14; budget++) dfs(twist0, flip0, place0, budget, -1);
  if (!found.length) throw new Error("no face turns bring this core to the X shape");
  nodes = 0;
  dfs(twist0, flip0, place0, budget, -1); // one turn more than the fewest
  let best: { turns: Turn[]; regrip: number; cost: number } | null = null;
  for (const way of found)
    for (let m = 0; m < 4; m++) {
      const turns = regripped(way.map((i) => FACE_TURNS[i]), m);
      const cost = ease(turns) + ease(REGRIP[m]);
      if (!best || cost < best.cost) best = { turns, regrip: m, cost };
    }
  return best!;
}

// ---------------------------------------------------------------- 3. core
//
// In the X shape every core corner and core single edge shows white or yellow, up or
// down. Which of the eight corner spots, and which of the eight edge spots, show white is
// one of 70 x 70 arrangements, so the fewest shape-keeping turns to "white up" is a table.

const KEEP_TURNS = ["U", "U2", "U'", "D", "D2", "D'", "R2", "L2", "F2", "B2"].map(turn);
const SINGLE_SLOTS = EDGE_SLOTS.filter((s) => SLOT_POS[s][1] !== 0);
const upMask = (slots: number[]) => slots.reduce((m, s, i) => m | (SLOT_POS[s][1] > 0 ? 1 << i : 0), 0);
let coreTable: Int8Array | null = null; // [corner mask * 256 + edge mask] -> the next turn of the easiest way to white up, -1 at the goal, -2 unreachable
const KEEP_PERMS = KEEP_TURNS.map((t) => {
  const p = slotPerm(t);
  return { corners: CORNER_SLOTS.map((s) => CORNER_SLOTS.indexOf(p[s])), edges: SINGLE_SLOTS.map((s) => SINGLE_SLOTS.indexOf(p[s])) };
});
const moveMask = (mask: number, to: number[]) => to.reduce((out, t, i) => out | (mask & (1 << i) ? 1 << t : 0), 0);

function buildCoreTable(): Int8Array {
  const table = new Int8Array(256 * 256).fill(-2);
  const goal = upMask(CORNER_SLOTS) * 256 + upMask(SINGLE_SLOTS);
  const inverse = KEEP_TURNS.map((t) => KEEP_TURNS.findIndex((u) => u.def === t.def && u.amount === 4 - t.amount));
  // Easiest first (Dijkstra, with the states waiting at each cost in its own list).
  const cost = new Int32Array(256 * 256).fill(1 << 30);
  const waiting: number[][] = [[goal]];
  cost[goal] = 0;
  table[goal] = -1;
  for (let c = 0; c < waiting.length; c++)
    for (const at of waiting[c] ?? []) {
      if (cost[at] !== c) continue;
      KEEP_PERMS.forEach((p, m) => {
        const from = moveMask(at >> 8, p.corners) * 256 + moveMask(at & 255, p.edges);
        const to = c + ease([KEEP_TURNS[m]]);
        if (cost[from] <= to) return;
        cost[from] = to;
        table[from] = inverse[m]; // turn m led away from `at`, so its inverse leads back
        (waiting[to] ??= []).push(from);
      });
    }
  return table;
}

const whiteMask = (st: State, slots: number[]) => slots.reduce((m, s, i) => m | (CUBELETS[st.occ[s]].stickers.includes("W") ? 1 << i : 0), 0);

function coreTurns(st: State): Turn[] {
  const table = (coreTable ??= buildCoreTable());
  let corners = whiteMask(st, CORNER_SLOTS), edges = whiteMask(st, SINGLE_SLOTS);
  const out: Turn[] = [];
  for (let m = table[corners * 256 + edges]; m !== -1; m = table[corners * 256 + edges]) {
    if (m === -2) throw new Error("the shape-keeping turns can't bring the white core cubelets up");
    out.push(KEEP_TURNS[m]);
    corners = moveMask(corners, KEEP_PERMS[m].corners);
    edges = moveMask(edges, KEEP_PERMS[m].edges);
  }
  return out;
}

// ---------------------------------------------------------------- 2-3, by layers
//
// In the layers mode the shape and core stages are replaced by five, each step of which
// brings one more core cubelet of one kind where it belongs, keeping those already there:
//   coreTop      white core single edges in the top layer, white up;
//   coreTopC     white core corners in the top layer, white up;
//   coreMiddle   core double edges in the middle layer;
//   coreBottom   yellow core single edges in the bottom layer, yellow down;
//   coreBottomC  yellow core corners in the bottom layer, yellow down.
// When all five are done the puzzle is in the X shape and the core is solved. Look-alike
// cubelets are interchangeable, so each kind is tracked as a set of four (slot, axis)
// codes: the slot, and the axis its white or yellow sticker (for a double edge, its front
// or back face) points along. For each kind and each count, a table gives the fewest
// face turns to have at least that many of the four where they belong; a step is found by
// iterative deepening on face turns with the largest of those distances as the bound, and
// among the fewest turns (and, for short steps, one more) the easiest is taken.

/** The five kinds tracked, in stage order, with the slots their codes index into. */
const TRACKED = (() => {
  const marker = (h: Vec3) => (h[1] ? (h[1] > 0 ? 2 : 3) : h[2] > 0 ? 4 : 5);
  const of = (kind: Kind, color: "W" | "Y" | null) => CUBELETS.filter((c) => c.kind === kind && (!color || c.stickers.includes(color))).map((c) => c.id);
  const kinds = [
    { stage: "coreTop", ids: of("singleEdge", "W"), slots: EDGE_SLOTS, good: (s: number, axis: number) => SLOT_POS[s][1] === 1 && axis === 1 },
    { stage: "coreTopC", ids: of("coreCorner", "W"), slots: CORNER_SLOTS, good: (s: number, axis: number) => SLOT_POS[s][1] === 1 && axis === 1 },
    { stage: "coreMiddle", ids: of("doubleEdge", null), slots: EDGE_SLOTS, good: (s: number) => SLOT_POS[s][1] === 0 },
    { stage: "coreBottom", ids: of("singleEdge", "Y"), slots: EDGE_SLOTS, good: (s: number, axis: number) => SLOT_POS[s][1] === -1 && axis === 1 },
    { stage: "coreBottomC", ids: of("coreCorner", "Y"), slots: CORNER_SLOTS, good: (s: number, axis: number) => SLOT_POS[s][1] === -1 && axis === 1 },
  ] as const;
  return kinds.map((k) => ({ ...k, marker: (id: number) => marker(SLOT_POS[CUBELETS[id].home]) }));
})();

interface LayerTables {
  /** For each kind: its reachable arrangements numbered 0..n-1 by their sorted codes' index. */
  id: Map<number, number>[];
  /** next[k][state * 18 + m]: the arrangement after face turn m. */
  next: Uint16Array[];
  /** dist[k][j][state]: fewest face turns to at least j of kind k where they belong (255: never). */
  dist: Uint8Array[][];
}
let layerTables: LayerTables | null = null;

const base = (k: number) => TRACKED[k].slots.length * 3;
/** The index of four codes of kind k, taken in ascending order. */
function tupleIndex(k: number, codes: number[]): number {
  const B = base(k);
  const c = [...codes].sort((x, y) => x - y);
  return ((c[0] * B + c[1]) * B + c[2]) * B + c[3];
}
const countGood = (k: number, codes: number[]) => codes.filter((code) => TRACKED[k].good(TRACKED[k].slots[(code / 3) | 0], code % 3)).length;

/** The four codes of kind k in st. */
function codesOf(st: State, k: number): number[] {
  const t = TRACKED[k];
  return t.ids.map((id) => {
    const s = st.occ.indexOf(id);
    return t.slots.indexOf(s) * 3 + (ROT_DIR[st.ori[s] * 6 + t.marker(id)] >> 1);
  });
}

function buildLayerTables(): LayerTables {
  const ids: Map<number, number>[] = [], next: Uint16Array[] = [], dist: Uint8Array[][] = [];
  TRACKED.forEach((t, k) => {
    const B = base(k);
    // Where each code goes under each face turn.
    const step = new Uint8Array(18 * B);
    FACE_TURNS.forEach((turnDef, m) => {
      const d = MOVE_DEFS[turnDef.def];
      const rot = axisRotation(d.axis, d.ccw * turnDef.amount);
      const perm = slotPerm(turnDef);
      const axisTo = [0, 1, 2].map((a) => ROT_DIR[rot * 6 + a * 2] >> 1);
      t.slots.forEach((s, i) => {
        const moves = d.slots.includes(s);
        for (let axis = 0; axis < 3; axis++) step[m * B + i * 3 + axis] = moves ? t.slots.indexOf(perm[s]) * 3 + axisTo[axis] : i * 3 + axis;
      });
    });
    // Every arrangement reachable from solved, numbered as found, and its moves.
    const id = new Map<number, number>();
    const all: number[][] = [];
    const add = (codes: number[]) => {
      const i = tupleIndex(k, codes);
      if (!id.has(i)) (id.set(i, all.length), all.push(codes));
      return id.get(i)!;
    };
    add(codesOf(State.solved(), k));
    const moves: number[] = [];
    for (let n = 0; n < all.length; n++) for (let m = 0; m < 18; m++) moves.push(add(all[n].map((c) => step[m * B + c])));
    const table = Uint16Array.from(moves);
    const good = all.map((codes) => countGood(k, codes));
    const perCount: Uint8Array[] = [];
    for (let j = 0; j <= 4; j++) {
      const dj = new Uint8Array(all.length).fill(255);
      let frontier: number[] = [];
      good.forEach((g, n) => g >= j && (dj[n] = 0, frontier.push(n)));
      for (let depth = 1; frontier.length; depth++) {
        const more: number[] = [];
        for (const n of frontier)
          for (let m = 0; m < 18; m++) {
            const to = table[n * 18 + m];
            if (dj[to] === 255) (dj[to] = depth, more.push(to));
          }
        frontier = more;
      }
      perCount.push(dj);
    }
    ids.push(id);
    next.push(table);
    dist.push(perCount);
  });
  return { id: ids, next, dist };
}

/** The next layer-by-layer core step from st, or null when the core is done. */
function layerCoreStep(st: State): SolveStep | null {
  const T = (layerTables ??= buildLayerTables());
  const codes = TRACKED.map((_, k) => codesOf(st, k));
  const counts = codes.map((c, k) => countGood(k, c));
  const k = counts.findIndex((n) => n < 4);
  if (k < 0) return null;
  // Keep every kind before k complete, and bring at least one more of kind k.
  const kinds = TRACKED.map((_, i) => i).filter((i) => i <= k);
  const need = kinds.map((i) => (i < k ? 4 : counts[k] + 1));
  const at = kinds.map((i) => T.id[i].get(tupleIndex(i, codes[i]))!);
  const tables = kinds.map((i, n) => T.dist[i][need[n]]);
  const nexts = kinds.map((i) => T.next[i]);
  const bound = (cs: number[]) => {
    let h = 0;
    for (let n = 0; n < cs.length; n++) h = Math.max(h, tables[n][cs[n]]);
    return h;
  };
  const found: number[][] = [];
  const path: number[] = [];
  const dfs = (cs: number[], budget: number, lastFace: number) => {
    const h = bound(cs);
    if (h === 0) {
      if (budget === 0) found.push([...path]);
      return;
    }
    if (h > budget || found.length >= 200) return;
    for (let m = 0; m < 18; m++) {
      const face = (m / 3) | 0;
      if (face === lastFace || (face === (lastFace ^ 1) && face < lastFace)) continue;
      path.push(m);
      dfs(cs.map((c, n) => nexts[n][c * 18 + m]), budget - 1, face);
      path.pop();
    }
  };
  let depth = bound(at);
  for (; !found.length && depth <= 16; depth++) dfs(at, depth, -1);
  if (!found.length) throw new Error("no face turns place the next core cubelet");
  if (depth <= 8) dfs(at, depth, -1); // and the ways one turn longer, which may be easier
  let best: { turns: Turn[]; regrip: number; cost: number } | null = null;
  for (const way of found)
    for (let m = 0; m < 4; m++) {
      const turns = regripped(way.map((i) => FACE_TURNS[i]), m);
      const cost = ease(turns) + ease(REGRIP[m]);
      if (!best || cost < best.cost) best = { turns, regrip: m, cost };
    }
  const { turns, regrip } = best!;
  const t = TRACKED[k];
  // The step is for the cubelets of kind k not yet where they belong.
  const wrong = t.ids.map((id) => st.occ.indexOf(id)).filter((s) => !t.good(s, ROT_DIR[st.ori[s] * 6 + t.marker(st.occ[s])] >> 1));
  const done = TRACKED.slice(0, k).flatMap((x) => x.ids.map((id) => st.occ.indexOf(id)));
  const all = [...REGRIP[regrip], ...turns];
  const result = st.clone();
  applyTurns(result, all);
  return {
    stage: t.stage,
    goal: LAYER_GOAL[k](countGood(k, codesOf(result, k))),
    alg: formatAlg(all),
    turns: all,
    parts: [...REGRIP[regrip].map(() => ({ name: "regrip" as const, turns: 1 })), { name: "turns", turns: turns.length }],
    moved: wrong.map((s) => [s, s]),
    free: SLOTS.filter((s) => st.occ[s] >= 0 && !wrong.includes(s) && !done.includes(s) && !["center", "extCenter"].includes(kindAt(st, s))),
    lands: [],
    regrip,
  };
}

const LAYER_GOAL: ((n: number) => string)[] = [
  (n) => `Put a white core edge in the top layer, white up (${n} of 4)`,
  (n) => `Put a white core corner in the top layer, white up (${n} of 4)`,
  (n) => `Put a core double edge in the middle layer (${n} of 4)`,
  (n) => `Put a yellow core edge in the bottom layer, yellow down (${n} of 4)`,
  (n) => `Put a yellow core corner in the bottom layer, yellow down (${n} of 4)`,
];

// ---------------------------------------------------------------- 4-6. outer cubelets
//
// With the shape and core done, each outer corner and outer edge has one home, and is
// turned the one right way whenever it is there. So each kind is a plain permutation of
// 16 spots, solved with 3-cycles when it is even.

/**
 * The 3-cycles the method uses, one per kind. Each is a commutator, "(A) o (A undone) o
 * undone", with A three face or slice turns and o an outer turn, and is written grouped
 * that way. They are Dave Baum's cycles turned a quarter around the puzzle, which puts
 * them on the front, left and right: no back turn, and M in place of S.
 */
export const CYCLES: Record<"outerCorner" | "outerEdge", { a: string; o: string }> = {
  outerCorner: { a: "F' L' F", o: "r" },
  outerEdge: { a: "F' M' F", o: "r" },
};
/** A cycle, or its inverse, in notation. */
function cycleAlg(kind: "outerCorner" | "outerEdge", inverse: boolean): string {
  const a = parseAlg(CYCLES[kind].a), o = parseAlg(CYCLES[kind].o);
  const [A, Au, O, Ou] = [a, invertTurns(a), o, invertTurns(o)].map((t) => formatAlg(t));
  return inverse ? `${O} (${A}) ${Ou} (${Au})` : `(${A}) ${O} (${Au}) ${Ou}`;
}

/** Turns allowed in a setup: they keep the X shape, so the cycle that follows does what it does from solved. */
const SETUP_TURNS = [...KEEP_TURNS, ...["r", "l", "f", "b"].flatMap((f) => [f, f + "2", f + "'"]).map(turn)];

interface CycleTable {
  /** For a triple of slots a, b, c (key a,b,c): the easiest setup after which the cycle, or its inverse, sends a to b, b to c and c to a. */
  setups: Map<string, { setup: Turn[]; inverse: boolean; cost: number }>;
}
const cycleTables = new Map<string, CycleTable>();

function cycleTable(kind: "outerCorner" | "outerEdge"): CycleTable {
  const known = cycleTables.get(kind);
  if (known) return known;
  const after = SOLVED.clone();
  applyTurns(after, parseAlg(cycleAlg(kind, false)));
  const to = (s: number) => after.occ.indexOf(SOLVED.occ[s]);
  const first = SLOTS.find((s) => SOLVED.occ[s] >= 0 && to(s) !== s)!;
  const triple = [first, to(first), to(to(first))];
  const perms = SETUP_TURNS.map(slotPerm);
  const setups: CycleTable["setups"] = new Map();
  // Easiest first over where a run of setup turns, undone, would take the cycle's three
  // spots: the run that takes them to a, b, c is the inverse of the setup for a, b, c.
  for (const inverse of [false, true]) {
    const start = inverse ? [triple[0], triple[2], triple[1]] : triple;
    const best = new Map([[start.join(), 0]]);
    const waiting: { at: number[]; path: Turn[] }[][] = [[{ at: start, path: [] }]];
    for (let c = 0; c < waiting.length; c++)
      for (const { at, path } of waiting[c] ?? []) {
        if (best.get(at.join()) !== c) continue;
        const known = setups.get(at.join());
        if (!known || known.cost > c) setups.set(at.join(), { setup: invertTurns(path), inverse, cost: c });
        perms.forEach((p, m) => {
          const moved = at.map((s) => p[s]);
          const cost = c + ease([SETUP_TURNS[m]]);
          if ((best.get(moved.join()) ?? 1 << 30) <= cost) return;
          best.set(moved.join(), cost);
          (waiting[cost] ??= []).push({ at: moved, path: [...path, SETUP_TURNS[m]] });
        });
      }
  }
  const table = { setups };
  cycleTables.set(kind, table);
  return table;
}

const OUTER_NAME = { outerCorner: ["X-face corners", "corners"], outerEdge: ["extension edges", "edges"] } as const;

/** For each slot of this kind, the slot its cubelet belongs in, as the puzzle is gripped. */
const homes = (st: State, kind: Kind) => {
  const turned = Y_POWER[gripOf(st)];
  return new Map(homeSlots(kind).map((s) => [s, turned[CUBELETS[st.occ[s]].home]]));
};

function isOdd(home: Map<number, number>): boolean {
  let swaps = 0;
  const seen = new Set<number>();
  for (const start of home.keys())
    for (let s = start, n = 0; !seen.has(s); s = home.get(s)!, n++) {
      seen.add(s);
      if (n) swaps++;
    }
  return swaps % 2 === 1;
}

/** A set of outer spots solved together, as one stage. */
interface Group {
  stage: Stage;
  kind: "outerCorner" | "outerEdge";
  /** What the spots are called, for the goal. */
  name: string;
  /** Whether a home slot is one of the group's (the layers don't change with the grip). */
  has: (slot: number) => boolean;
}
const layer = (y: number) => (slot: number) => SLOT_POS[slot][1] === y;
const GROUPS: Record<Mode, Group[]> = {
  kinds: [
    { stage: "corners", kind: "outerCorner", name: "", has: () => true },
    { stage: "edges", kind: "outerEdge", name: "", has: () => true },
  ],
  layers: [
    { stage: "topEdges", kind: "outerEdge", name: "the white X-face's edges", has: layer(1) },
    { stage: "topCorners", kind: "outerCorner", name: "the white X-face's corners", has: layer(1) },
    { stage: "sideEdges", kind: "outerEdge", name: "the extension side edges", has: layer(0) },
    { stage: "bottomCorners", kind: "outerCorner", name: "the yellow X-face's corners", has: layer(-1) },
    { stage: "bottomEdges", kind: "outerEdge", name: "the yellow X-face's edges", has: layer(-1) },
  ],
};

/** The next 3-cycle step for this group, or null when all of it is home. */
function cycleStep(st: State, group: Group): SolveStep | null {
  const { kind } = group;
  const home = homes(st, kind);
  const unsolved = [...home.keys()].filter((s) => home.get(s) !== s);
  if (!unsolved.some((s) => group.has(home.get(s)!))) return null;
  const table = cycleTable(kind);
  // Each candidate sends the cubelet in a home (to b), the one in b on to c, and the one in
  // c back to a, for any other unsolved spot c: a cubelet already home is never moved. It
  // must bring a cubelet of this group home. Prefer the step that sends the most cubelets
  // home, then the easiest: its setup, done and undone, and the regrip it begins with.
  let best: { triple: number[]; setup: Turn[]; inverse: boolean; landing: number; cost: number; regrip: number } | null = null;
  for (const a of unsolved) {
    const b = home.get(a)!;
    for (const c of unsolved) {
      if (c === a || c === b) continue;
      const lands = [b, c, a].filter((to, i) => home.get([a, b, c][i]) === to);
      if (!lands.some((to) => group.has(to))) continue;
      const landing = lands.length;
      if (best && landing < best.landing) continue;
      for (let m = 0; m < 4; m++)
        for (const t of [[a, b, c], [b, c, a], [c, a, b]]) {
          const found = table.setups.get(t.map((s) => Y_POWER[m][s]).join());
          if (!found) continue;
          const cost = 2 * found.cost + ease(REGRIP[m]);
          if (!best || landing > best.landing || (landing === best.landing && cost < best.cost)) best = { triple: [a, b, c], setup: found.setup, inverse: found.inverse, landing, cost, regrip: m };
        }
    }
  }
  if (!best) throw new Error(`no setup reaches the next three ${OUTER_NAME[kind][1]}`);
  const cycle = cycleAlg(kind, best.inverse);
  const [a, b, c] = best.triple;
  const { landing } = best;
  const moved: [number, number][] = [[a, b], [b, c], [c, a]];
  const alg = `${formatAlg(REGRIP[best.regrip])} ${best.setup.length ? `[${formatAlg(best.setup)}: ${cycle}]` : cycle}`.trim();
  return {
    stage: group.stage,
    goal: `${group.name ? `For ${group.name}: cycle` : "Cycle"} three ${OUTER_NAME[kind][0]}. ${landing === 3 ? "All three end up solved" : landing === 2 ? "Two end up solved" : "One ends up solved"}`,
    alg,
    turns: parseAlg(alg),
    parts: ([["regrip", REGRIP[best.regrip].length], ["setup", best.setup.length], ["cycle", 8], ["undo", best.setup.length]] as const).filter(([, n]) => n).map(([name, turns]) => ({ name, turns })),
    moved,
    free: [],
    lands: moved.filter(([from, to]) => home.get(from) === to).map(([from]) => from),
    regrip: best.regrip,
  };
}

function parityStep(st: State): SolveStep | null {
  const corners = isOdd(homes(st, "outerCorner")), edges = isOdd(homes(st, "outerEdge"));
  if (!corners && !edges) return null;
  // U moves eight outer corners in two rings of four (an even change) and four outer
  // edges in one ring (an odd one); an outer turn moves four of each in a ring.
  const alg = corners && edges ? "r" : edges ? "U" : "U r";
  const turns = parseAlg(alg);
  const after = st.clone();
  applyTurns(after, turns);
  const what = corners && edges ? "The X-face corners and the extension edges each need" : `The ${OUTER_NAME[corners ? "outerCorner" : "outerEdge"][0]} need`;
  return {
    stage: "parity",
    goal: `${what} an odd number of swaps, which 3-cycles can't do. ${corners && edges ? "One outer turn makes" : edges ? "A U turn makes" : "A U turn and an outer turn make"} both even`,
    alg,
    turns,
    parts: [{ name: "turns", turns: turns.length }],
    moved: SLOTS.filter((s) => st.occ[s] >= 0 && !isCore(s) && after.occ[s] !== st.occ[s]).map((s) => [s, after.occ.indexOf(st.occ[s])]),
    free: [],
    lands: [],
    regrip: 0,
  };
}

// ---------------------------------------------------------------- the whole method

/**
 * What the shape and core steps leave free: every cubelet but the centers and the ones the
 * step is for. The other core cubelets may trade places with their look-alikes.
 */
const others = (st: State, wrong: number[]) => SLOTS.filter((s) => st.occ[s] >= 0 && !wrong.includes(s) && !["center", "extCenter"].includes(kindAt(st, s)));

/** The next step from st toward solved, or null when st is solved. Throws if turns can't reach st. */
export function nextStep(st: State, mode: Mode = "kinds"): SolveStep | null {
  const why = unreachableReason(st);
  if (why) throw new Error(`turns can't reach this position (${why})`);
  if (!held(st)) {
    const turns = holdTurns(st);
    // The color a center shows is the color of the face its core center cubelet came from.
    const up = COLOR_NAME[FACE_COLOR[[0, 1, 2, 3, 4, 5].find((d) => slotAt(DIRS[d]) === CUBELETS[st.occ[UP]].home)!]];
    return { stage: "hold", goal: `Turn the whole puzzle so the white center is up (now ${up} is up). Nothing else moves`, alg: formatAlg(turns), turns, parts: [{ name: "turns", turns: turns.length }], moved: [], free: [], lands: [], regrip: 0 };
  }
  if (mode === "layers") {
    const step = layerCoreStep(st);
    if (step) return step;
  }
  if (!isHomeX(st)) {
    const { turns, regrip } = shapeTurns(st);
    // The step is for the core cubelets that keep the puzzle out of shape: a corner or
    // single edge whose sticker faces sideways, and any core edge in the wrong layer.
    const sideways = (s: number) => ROT_DIR[st.ori[s] * 6 + (SLOT_POS[CUBELETS[st.occ[s]].home][1] > 0 ? 2 : 3)] >> 1 !== 1;
    const wrong = [...CORNER_SLOTS, ...EDGE_SLOTS].filter((s) => {
      const kind = kindAt(st, s);
      if (kind === "doubleEdge") return SLOT_POS[s][1] !== 0;
      return sideways(s) || (kind === "singleEdge" && SLOT_POS[s][1] === 0);
    });
    const all = [...REGRIP[regrip], ...turns];
    return { stage: "shape", goal: "Bring the puzzle back to the X shape", alg: formatAlg(all), turns: all, parts: [...REGRIP[regrip].map(() => ({ name: "regrip" as const, turns: 1 })), { name: "turns", turns: turns.length }], moved: wrong.map((s) => [s, s]), free: others(st, wrong), lands: [], regrip };
  }
  const core = coreTurns(st);
  if (core.length) {
    const wrong = [...CORNER_SLOTS, ...SINGLE_SLOTS].filter((s) => CUBELETS[st.occ[s]].stickers.includes("W") !== SLOT_POS[s][1] > 0);
    return { stage: "core", goal: "Bring the white core cubelets up and the yellow ones down", alg: formatAlg(core), turns: core, parts: [{ name: "turns", turns: core.length }], moved: wrong.map((s) => [s, s]), free: others(st, wrong), lands: [], regrip: 0 };
  }
  const parity = parityStep(st);
  if (parity) return parity;
  for (const group of GROUPS[mode]) {
    const step = cycleStep(st, group);
    if (step) return step;
  }
  return null;
}

/** Every step from st to solved, in order. Throws if turns can't reach st. */
export function solveSteps(start: State, mode: Mode = "kinds"): SolveStep[] {
  const st = start.clone();
  const steps: SolveStep[] = [];
  for (let step = nextStep(st, mode); step; step = nextStep(st, mode)) {
    if (steps.length > 60) throw new Error("the method did not finish");
    for (const t of step.turns) if (!applyTurn(st, t)) throw new Error(`a step's turn was refused (${step.alg})`);
    steps.push(step);
  }
  if (!isSolved(st)) throw new Error("the method finished without solving the puzzle");
  return steps;
}
