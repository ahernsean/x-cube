// A step-by-step solver: from any position turns can reach to solved, as a list of steps a
// person could follow, each with a goal, its turns, and what it changes.
//
// The method (it is not the shortest; it is one a person can learn):
//   1. hold:   turn the whole puzzle so white is up and green is in front. No later step
//              turns the whole puzzle or leaves a center moved, so the centers stay there.
//   2. shape:  back to the X shape, with face turns (at most 12; found by search).
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

import { isHomeX, isSolved } from "./analyze.ts";
import { ROT_DIR, ROTATIONS, axisRotation, matVec } from "./geometry.ts";
import { formatAlg, parseAlg } from "./notation.ts";
import { CUBELETS, MOVE_DEFS, NUM_SLOTS, SLOT_POS, State, applyTurn, applyTurns, invertTurns, slotAt, type Kind, type Turn } from "./puzzle.ts";
import { unreachableReason } from "./serialize.ts";

export type Stage = "hold" | "shape" | "core" | "parity" | "corners" | "edges";

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

// ---------------------------------------------------------------- 1. hold

const ROTATION_TURNS = ["x", "x2", "x'", "y", "y2", "y'", "z", "z2", "z'"].map(turn);
const centerAt = (st: State, home: number) => st.occ.indexOf(SOLVED.occ[home]);
const UP = slotAt([0, 1, 0]);
const FRONT = slotAt([0, 0, 1]);
const held = (st: State) => centerAt(st, UP) === UP && centerAt(st, FRONT) === FRONT;

function holdTurns(st: State): Turn[] {
  if (held(st)) return [];
  for (const options of [ROTATION_TURNS.map((t) => [t]), ROTATION_TURNS.flatMap((a) => ROTATION_TURNS.map((b) => [a, b]))])
    for (const turns of options) {
      const t = st.clone();
      applyTurns(t, turns);
      if (held(t)) return turns;
    }
  throw new Error("the centers can't be turned to white up, green front");
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

/** Fewest face turns that bring the held position st to the X shape. */
function shapeTurns(st: State): Turn[] {
  const T = (shapeTables ??= buildShapeTables());
  const [twist0, flip0, place0] = shapeCoords(st);
  const left = (tw: number, fl: number, pl: number) => Math.max(T.twistDist[tw * N_PLACE + pl], T.flipDist[fl * N_PLACE + pl]);
  if (left(twist0, flip0, place0) === 255) throw new Error("no face turns bring this core to the X shape");
  const path: number[] = [];
  const dfs = (tw: number, fl: number, pl: number, budget: number, lastFace: number): boolean => {
    const h = left(tw, fl, pl);
    if (h === 0) return true;
    if (h > budget) return false;
    for (let m = 0; m < 18; m++) {
      const face = (m / 3) | 0;
      // One turn per face in a row, and opposite faces (which commute) in one order only.
      if (face === lastFace || (face === (lastFace ^ 1) && face < lastFace)) continue;
      path.push(m);
      if (dfs(T.twist[tw * 18 + m], T.flip[fl * 18 + m], T.place[pl * 18 + m], budget - 1, face)) return true;
      path.pop();
    }
    return false;
  };
  for (let budget = left(twist0, flip0, place0); budget <= 14; budget++) if (dfs(twist0, flip0, place0, budget, -1)) return path.map((m) => FACE_TURNS[m]);
  throw new Error("no face turns bring this core to the X shape");
}

// ---------------------------------------------------------------- 3. core
//
// In the X shape every core corner and core single edge shows white or yellow, up or
// down. Which of the eight corner spots, and which of the eight edge spots, show white is
// one of 70 x 70 arrangements, so the fewest shape-keeping turns to "white up" is a table.

const KEEP_TURNS = ["U", "U2", "U'", "D", "D2", "D'", "R2", "L2", "F2", "B2"].map(turn);
const SINGLE_SLOTS = EDGE_SLOTS.filter((s) => SLOT_POS[s][1] !== 0);
const upMask = (slots: number[]) => slots.reduce((m, s, i) => m | (SLOT_POS[s][1] > 0 ? 1 << i : 0), 0);
let coreTable: Int8Array | null = null; // [corner mask * 256 + edge mask] -> a turn toward white up, -1 at the goal, -2 unreachable
const KEEP_PERMS = KEEP_TURNS.map((t) => {
  const p = slotPerm(t);
  return { corners: CORNER_SLOTS.map((s) => CORNER_SLOTS.indexOf(p[s])), edges: SINGLE_SLOTS.map((s) => SINGLE_SLOTS.indexOf(p[s])) };
});
const moveMask = (mask: number, to: number[]) => to.reduce((out, t, i) => out | (mask & (1 << i) ? 1 << t : 0), 0);

function buildCoreTable(): Int8Array {
  const table = new Int8Array(256 * 256).fill(-2);
  const goal = upMask(CORNER_SLOTS) * 256 + upMask(SINGLE_SLOTS);
  table[goal] = -1;
  let frontier = [goal];
  const inverse = KEEP_TURNS.map((t) => KEEP_TURNS.findIndex((u) => u.def === t.def && u.amount === 4 - t.amount));
  while (frontier.length) {
    const next: number[] = [];
    for (const at of frontier)
      KEEP_PERMS.forEach((p, m) => {
        const from = moveMask(at >> 8, p.corners) * 256 + moveMask(at & 255, p.edges);
        if (table[from] !== -2) return;
        table[from] = inverse[m]; // turn m led away from `at`, so its inverse leads back
        next.push(from);
      });
    frontier = next;
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

// ---------------------------------------------------------------- 4-6. outer cubelets
//
// With the shape and core done, each outer corner and outer edge has one home, and is
// turned the one right way whenever it is there. So each kind is a plain permutation of
// 16 spots, solved with 3-cycles when it is even.

/** The 3-cycles the method uses, one per kind (Dave Baum's, in this project's grip; test/puzzle.test.ts checks them). */
export const CYCLES: Record<"outerCorner" | "outerEdge", string> = {
  outerCorner: "R' F' R b R' F R b'",
  outerEdge: "R' S' R b R' S R b'",
};

/** Turns allowed in a setup: they keep the X shape, so the cycle that follows does what it does from solved. */
const SETUP_TURNS = [...KEEP_TURNS, ...["r", "l", "f", "b"].flatMap((f) => [f, f + "2", f + "'"]).map(turn)];

interface CycleTable {
  alg: Turn[];
  /** For a triple of slots a, b, c (key a,b,c): the setup after which the cycle, or its inverse, sends a to b, b to c and c to a. */
  setups: Map<string, { setup: Turn[]; inverse: boolean }>;
}
const cycleTables = new Map<string, CycleTable>();

function cycleTable(kind: "outerCorner" | "outerEdge"): CycleTable {
  const known = cycleTables.get(kind);
  if (known) return known;
  const alg = parseAlg(CYCLES[kind]);
  const after = SOLVED.clone();
  applyTurns(after, alg);
  const to = (s: number) => after.occ.indexOf(SOLVED.occ[s]);
  const first = SLOTS.find((s) => SOLVED.occ[s] >= 0 && to(s) !== s)!;
  const triple = [first, to(first), to(to(first))];
  const perms = SETUP_TURNS.map(slotPerm);
  const setups: CycleTable["setups"] = new Map();
  // Breadth first over where a run of setup turns, undone, would take the cycle's three
  // spots: the run that takes them to a, b, c is the inverse of the setup for a, b, c.
  for (const inverse of [false, true]) {
    const start = inverse ? [triple[0], triple[2], triple[1]] : triple;
    let frontier: { at: number[]; path: Turn[] }[] = [{ at: start, path: [] }];
    const seen = new Set([start.join()]);
    while (frontier.length) {
      const next: typeof frontier = [];
      for (const { at, path } of frontier) {
        const known = setups.get(at.join());
        if (!known || known.setup.length > path.length) setups.set(at.join(), { setup: invertTurns(path), inverse });
        perms.forEach((p, m) => {
          const moved = at.map((s) => p[s]);
          if (seen.has(moved.join())) return;
          seen.add(moved.join());
          next.push({ at: moved, path: [...path, SETUP_TURNS[m]] });
        });
      }
      frontier = next;
    }
  }
  const table = { alg, setups };
  cycleTables.set(kind, table);
  return table;
}

const OUTER_NAME = { outerCorner: ["X-face corners", "corners"], outerEdge: ["extension edges", "edges"] } as const;

/** For each slot of this kind, the slot its cubelet belongs in. */
const homes = (st: State, kind: Kind) => new Map(homeSlots(kind).map((s) => [s, CUBELETS[st.occ[s]].home]));

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

/** The next 3-cycle step for this kind, or null when all of it is home. */
function cycleStep(st: State, kind: "outerCorner" | "outerEdge"): SolveStep | null {
  const home = homes(st, kind);
  const unsolved = [...home.keys()].filter((s) => home.get(s) !== s);
  if (!unsolved.length) return null;
  const table = cycleTable(kind);
  // Each candidate sends the cubelet in a home (to b), and the one in b on to its home c;
  // where those two are swapped with each other, any other unsolved spot serves as c.
  // Prefer the step that sends the most cubelets home, then the shortest setup.
  let best: { triple: number[]; setup: Turn[]; inverse: boolean; landing: number } | null = null;
  for (const a of unsolved) {
    const b = home.get(a)!;
    const thirds = home.get(b) === a ? unsolved.filter((s) => s !== a && s !== b) : [home.get(b)!];
    for (const c of thirds) {
      const found = [[a, b, c], [b, c, a], [c, a, b]].map((t) => table.setups.get(t.join())).filter((x) => !!x).sort((x, y) => x.setup.length - y.setup.length)[0];
      const landing = [b, c, a].filter((to, i) => home.get([a, b, c][i]) === to).length;
      if (found && (!best || landing > best.landing || (landing === best.landing && found.setup.length < best.setup.length))) best = { triple: [a, b, c], ...found, landing };
    }
  }
  if (!best) throw new Error(`no setup reaches the next three ${OUTER_NAME[kind][1]}`);
  const cycle = best.inverse ? invertTurns(table.alg) : table.alg;
  const [a, b, c] = best.triple;
  const { landing } = best;
  return {
    stage: kind === "outerCorner" ? "corners" : "edges",
    goal: `Cycle three ${OUTER_NAME[kind][0]}: ${landing === 3 ? "all three go" : landing === 2 ? "two go" : "one goes"} home`,
    alg: best.setup.length ? `[${formatAlg(best.setup)}: ${formatAlg(cycle)}]` : formatAlg(cycle),
    turns: [...best.setup, ...cycle, ...invertTurns(best.setup)],
    moved: [[a, b], [b, c], [c, a]],
    free: [],
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
    moved: SLOTS.filter((s) => st.occ[s] >= 0 && !isCore(s) && after.occ[s] !== st.occ[s]).map((s) => [s, after.occ.indexOf(st.occ[s])]),
    free: [],
  };
}

// ---------------------------------------------------------------- the whole method

/**
 * What the shape and core steps leave free: every cubelet but the centers and the ones the
 * step is for. The other core cubelets may trade places with their look-alikes.
 */
const others = (st: State, wrong: number[]) => SLOTS.filter((s) => st.occ[s] >= 0 && !wrong.includes(s) && !["center", "extCenter"].includes(kindAt(st, s)));

/** The next step from st toward solved, or null when st is solved. Throws if turns can't reach st. */
export function nextStep(st: State): SolveStep | null {
  const why = unreachableReason(st);
  if (why) throw new Error(`turns can't reach this position (${why})`);
  if (!held(st)) {
    const turns = holdTurns(st);
    return { stage: "hold", goal: "Hold the puzzle with the white center up and the green center in front", alg: formatAlg(turns), turns, moved: [], free: [] };
  }
  if (!isHomeX(st)) {
    const turns = shapeTurns(st);
    // The step is for the core cubelets that keep the puzzle out of shape: a corner or
    // single edge whose sticker faces sideways, and any core edge in the wrong layer.
    const sideways = (s: number) => ROT_DIR[st.ori[s] * 6 + (SLOT_POS[CUBELETS[st.occ[s]].home][1] > 0 ? 2 : 3)] >> 1 !== 1;
    const wrong = [...CORNER_SLOTS, ...EDGE_SLOTS].filter((s) => {
      const kind = kindAt(st, s);
      if (kind === "doubleEdge") return SLOT_POS[s][1] !== 0;
      return sideways(s) || (kind === "singleEdge" && SLOT_POS[s][1] === 0);
    });
    return { stage: "shape", goal: "Bring the puzzle back to the X shape", alg: formatAlg(turns), turns, moved: wrong.map((s) => [s, s]), free: others(st, wrong) };
  }
  const core = coreTurns(st);
  if (core.length) {
    const wrong = [...CORNER_SLOTS, ...SINGLE_SLOTS].filter((s) => CUBELETS[st.occ[s]].stickers.includes("W") !== SLOT_POS[s][1] > 0);
    return { stage: "core", goal: "Bring the white core cubelets up and the yellow ones down", alg: formatAlg(core), turns: core, moved: wrong.map((s) => [s, s]), free: others(st, wrong) };
  }
  return parityStep(st) ?? cycleStep(st, "outerCorner") ?? cycleStep(st, "outerEdge");
}

/** Every step from st to solved, in order. Throws if turns can't reach st. */
export function solveSteps(start: State): SolveStep[] {
  const st = start.clone();
  const steps: SolveStep[] = [];
  for (let step = nextStep(st); step; step = nextStep(st)) {
    if (steps.length > 60) throw new Error("the method did not finish");
    for (const t of step.turns) if (!applyTurn(st, t)) throw new Error(`a step's turn was refused (${step.alg})`);
    steps.push(step);
  }
  if (!isSolved(st)) throw new Error("the method finished without solving the puzzle");
  return steps;
}
