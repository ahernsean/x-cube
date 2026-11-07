import assert from "node:assert/strict";
import { test } from "node:test";
import { NUM_ROT, ROT_DIR, ROT_MUL } from "../src/core/geometry.ts";
import { effect, isHomeX, isSolved, isXShape, outerAvailability } from "../src/core/analyze.ts";
import { formatAlg, parseAlg } from "../src/core/notation.ts";
import {
  CUBELETS,
  MOVE_DEFS,
  NUM_SLOTS,
  SLOT_POS,
  State,
  applyTurn,
  applyTurns,
  blockedReason,
  slotAt,
  type Turn,
} from "../src/core/puzzle.ts";
import { decodeState, encodeState } from "../src/core/serialize.ts";

const run = (alg: string, from = State.solved()) => {
  const st = from.clone();
  const r = applyTurns(st, parseAlg(alg));
  return { st, r };
};
const avail = (st: State) => Object.fromEntries(outerAvailability(st));

// Deterministic pseudo-random generator so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
function randomLegalScramble(st: State, n: number, rand: () => number, kinds = ["inner", "outer", "slice"]) {
  const turns: Turn[] = [];
  while (turns.length < n) {
    const def = Math.floor(rand() * MOVE_DEFS.length);
    if (!kinds.includes(MOVE_DEFS[def].kind)) continue;
    const t: Turn = { def, amount: (1 + Math.floor(rand() * 3)) as 1 | 2 | 3 };
    if (blockedReason(st, t)) continue;
    applyTurn(st, t);
    turns.push(t);
  }
  return turns;
}

test("geometry: 24 rotations form a group", () => {
  assert.equal(NUM_ROT, 24);
  for (let a = 0; a < 24; a++) {
    assert.equal(ROT_MUL[a * 24], a);
    assert.equal(ROT_MUL[a], a);
  }
});

test("inventory: 80 slots, 62 cubelets, counts by kind match the agreed inventory", () => {
  assert.equal(NUM_SLOTS, 80);
  assert.equal(CUBELETS.length, 62);
  const count: Record<string, number> = {};
  for (const c of CUBELETS) count[c.kind] = (count[c.kind] ?? 0) + 1;
  assert.deepEqual(count, {
    center: 6,
    extCenter: 4,
    coreCorner: 8,
    singleEdge: 8,
    doubleEdge: 4,
    outerCorner: 16,
    outerEdge: 16,
  });
  const stickers = (k: string) => [...new Set(CUBELETS.filter((c) => c.kind === k).map((c) => c.stickers.filter(Boolean).length))];
  assert.deepEqual(stickers("coreCorner"), [1]);
  assert.deepEqual(stickers("singleEdge"), [1]);
  assert.deepEqual(stickers("doubleEdge"), [0]);
  assert.deepEqual(stickers("outerCorner"), [3]);
  assert.deepEqual(stickers("outerEdge"), [2]);
  assert.deepEqual(stickers("extCenter"), [1]);
  // 18 core stickers: 8 corners + 8 single edges + 2 X-face centers
  const core = CUBELETS.filter((c) => !["outerCorner", "outerEdge", "extCenter"].includes(c.kind));
  assert.equal(core.reduce((n, c) => n + c.stickers.filter(Boolean).length, 0), 18);
});

test("solved state is an X and solved", () => {
  const st = State.solved();
  assert.ok(isHomeX(st));
  assert.ok(isSolved(st));
});

test("every move, four times, is the identity; every move then its inverse is the identity", () => {
  const rand = rng(1);
  const st = State.solved();
  randomLegalScramble(st, 40, rand);
  for (let def = 0; def < MOVE_DEFS.length; def++) {
    const t: Turn = { def, amount: 1 };
    if (blockedReason(st, t)) continue;
    const a = st.clone();
    for (let k = 0; k < 4; k++) applyTurn(a, t);
    assert.ok(a.equals(st), MOVE_DEFS[def].name);
    const b = st.clone();
    applyTurn(b, t);
    applyTurn(b, { def, amount: 3 });
    assert.ok(b.equals(st), MOVE_DEFS[def].name + "'");
  }
});

test("owner-confirmed: after R, r and l turn; f and b refuse (6/9); u and d have 3", () => {
  const { st } = run("R");
  assert.deepEqual(avail(st), { r: 9, l: 9, u: 3, d: 3, f: 6, b: 6 });
});

test("owner-confirmed: after F, f and b turn freely; l and r refuse", () => {
  const { st, r } = run("F f f' b b'");
  assert.ok(r.ok);
  assert.equal(avail(st).l, 6);
  assert.equal(avail(st).r, 6);
});

test("owner-confirmed: U and R2 keep the X shape", () => {
  assert.ok(isHomeX(run("U").st));
  assert.ok(isHomeX(run("R2").st));
  assert.ok(isHomeX(run("U R2 D' F2 H").st));
  assert.ok(!isHomeX(run("R").st));
});

test("fused centers: an extension center always stays next to its core face center", () => {
  const rand = rng(7);
  const st = State.solved();
  const ext = CUBELETS.filter((c) => c.kind === "extCenter");
  for (let i = 0; i < 300; i++) {
    randomLegalScramble(st, 1, rand);
    for (const e of ext) {
      const p = SLOT_POS[e.home];
      const coreHome = slotAt([p[0] / 2, p[1] / 2, p[2] / 2]);
      const coreId = CUBELETS.find((c) => c.home === coreHome)!.id;
      const se = st.occ.indexOf(e.id);
      const sc = st.occ.indexOf(coreId);
      const pe = SLOT_POS[se], pc = SLOT_POS[sc];
      assert.deepEqual([pe[0] - pc[0], pe[1] - pc[1], pe[2] - pc[2]], [pc[0], pc[1], pc[2]]);
    }
  }
});

test("outer cubelets: the outward-facing color never changes (so look-alike twins are NOT interchangeable)", () => {
  const rand = rng(3);
  const st = State.solved();
  for (let i = 0; i < 400; i++) {
    randomLegalScramble(st, 1, rand);
    for (let s = 0; s < NUM_SLOTS; s++) {
      const id = st.occ[s];
      if (id < 0) continue;
      const c = CUBELETS[id];
      if (c.outward === null) continue;
      // the cubelet's outward face must point away from the core: the axis where |coord| == 2
      const p = SLOT_POS[s];
      const axis = p.findIndex((v) => Math.abs(v) === 2);
      const worldOut = axis * 2 + (p[axis] > 0 ? 0 : 1);
      assert.equal(ROT_DIR[st.ori[s] * 6 + c.outward], worldOut);
    }
  }
});

test("outer turns never change the shape", () => {
  const rand = rng(11);
  const st = State.solved();
  for (let i = 0; i < 300; i++) {
    randomLegalScramble(st, 1, rand, ["inner", "slice"]);
    const before = st.shapeKey();
    for (let def = 0; def < MOVE_DEFS.length; def++) {
      if (MOVE_DEFS[def].kind !== "outer") continue;
      const t: Turn = { def, amount: 1 };
      if (blockedReason(st, t)) continue;
      const a = st.clone();
      applyTurn(a, t);
      assert.equal(a.shapeKey(), before);
    }
  }
});

test("Baum's 3-cycles, translated to the white-up grip, keep the X shape and move exactly 3 cubelets", () => {
  for (const alg of ["R' S' R b R' S R b'", "R' F' R b R' F R b'"]) {
    const { st, r } = run(alg);
    assert.ok(r.ok, alg);
    assert.ok(isHomeX(st), alg);
    const e = effect(State.solved(), st);
    assert.equal(e.moved.length, 3, alg);
    assert.equal(e.cycles.length, 1, alg);
  }
  // Taken literally in a white-up grip (his H as our horizontal slice), it jams.
  assert.equal(run("R' H R u R' H' R u'").r.ok, false);
});

test("notation: commutators, conjugates, repeats, inverses", () => {
  const f = (s: string) => formatAlg(parseAlg(s));
  assert.equal(f("[R' H R, u]"), "R' H R u R' H' R u'");
  assert.equal(f("[R: U]"), "R U R'");
  assert.equal(f("(R U2)3"), "R U2 R U2 R U2");
  assert.equal(f("(R U2) x 2"), "R U2 R U2");
  assert.equal(f("(R U2)*2"), "R U2 R U2");
  assert.equal(f("(R U)'"), "U' R'");
  assert.equal(f("R2' x y' z2"), "R2 x y' z2");
  assert.equal(f("R' H R, u, R' H' R, u'"), "R' H R u R' H' R u'");
  assert.throws(() => parseAlg("Q"));
});

test("state codes round-trip", () => {
  const rand = rng(5);
  const st = State.solved();
  randomLegalScramble(st, 50, rand);
  assert.ok(decodeState(encodeState(st)).equals(st));
});

test("x/y/z rotations keep the puzzle looking solved", () => {
  for (const a of ["x", "y", "z", "x y", "z2 y'"]) {
    const { st } = run(a);
    assert.ok(isXShape(st), a);
    assert.ok(isSolved(st), a);
  }
});
