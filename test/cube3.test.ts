// The 3x3x3 as a second puzzle definition: the same engine, its own slots, pieces and notation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CUBE3, XCUBE, State, applyTurns } from "../src/core/puzzle.ts";
import { formatAlg, notationHelp, parseAlg } from "../src/core/notation.ts";
import { effect, faceView, isSolved, netView, statusLine } from "../src/core/analyze.ts";
import { search } from "../src/core/search.ts";
import { looksLike } from "../src/core/goals.ts";

const after = (alg: string) => {
  const st = State.solved(CUBE3);
  const r = applyTurns(st, parseAlg(alg, CUBE3));
  assert.ok(r.ok, r.error);
  return st;
};
const solved = State.solved(CUBE3);
/** Looks solved (a center's spin doesn't show). */
const looksSolved = (st: State) => st.appearanceKey() === solved.appearanceKey();

test("cube3: 26 pieces, 54 stickers, 8 corners, 12 edges and 6 centers, each unique", () => {
  assert.equal(CUBE3.numSlots, 26);
  assert.equal(CUBE3.numPieces, 26);
  assert.equal(CUBE3.pieces.flatMap((p) => p.stickers.filter((c) => c)).length, 54);
  const count = (k: string) => CUBE3.pieces.filter((p) => p.kind === k).length;
  assert.deepEqual([count("corner"), count("edge"), count("center")], [8, 12, 6]);
  assert.equal(new Set(CUBE3.appearanceClass).size, 26);
  assert.equal(CUBE3.slotName(CUBE3.slotAt([1, 1, 1])), "UFR");
});

test("cube3: solved, held any way, and not after a face turn", () => {
  assert.ok(isSolved(solved));
  assert.ok(isSolved(after("x y2 z'")));
  assert.ok(!isSolved(after("R")));
  assert.equal(statusLine(solved), "SOLVED");
});

test("cube3: turns have the orders and identities a 3x3x3 has", () => {
  for (const m of ["R", "L", "U", "D", "F", "B", "M", "E", "S"]) assert.ok(after(`${m}4`).equals(solved), m);
  assert.ok(after("(R U R' U')6").equals(solved));
  assert.ok(!after("(R U R' U')3").equals(solved));
  assert.ok(looksSolved(after("(R U)105")));
  assert.ok(!after("(R U)105").equals(solved), "the up center has turned a quarter, which doesn't show");
  assert.ok(!looksSolved(after("(R U)35")) && !looksSolved(after("(R U)21")) && !looksSolved(after("(R U)15")));
});

test("cube3: the superflip turns every edge over in place and leaves the corners solved", () => {
  const st = after("U R2 F B R B2 R U2 L B2 R U' D' R2 F R' L B2 U2 F2");
  const e = effect(solved, st);
  assert.equal(e.moved.length, 0);
  assert.equal(e.twisted.length, 12);
  for (let s = 0; s < CUBE3.numSlots; s++) assert.equal(st.occ[s], solved.occ[s]);
});

test("cube3: wide turns are Rw and 2Rw, as the WCA writes them; a lowercase r is refused", () => {
  assert.ok(after("Rw").equals(after("R M'")));
  assert.ok(after("2Rw2").equals(after("Rw2")));
  assert.ok(after("R 2Rw'").equals(after("R Rw'")));
  assert.ok(after("R2Rw").equals(after("R2 Rw")), "a count right after a turn is its amount");
  assert.ok(after("Rw").appearanceKey() === after("L x").appearanceKey());
  assert.ok(after("Rw").appearanceKey() !== after("L' x").appearanceKey());
  assert.ok(after("x").equals(after("R M' L'")));
  assert.ok(after("Uw").equals(after("U E'")));
  assert.equal(formatAlg(parseAlg("Rw U' 2Fw2", CUBE3), CUBE3), "Rw U' 2Fw2");
  for (const lower of ["r", "u", "f", "l", "d", "b"]) assert.throws(() => parseAlg(lower, CUBE3), /unknown move/);
  // On the X-Cube, r is the extension alone, and it has no wide turns.
  assert.equal(XCUBE.moves[XCUBE.moveByName.get("r")!].kind, "outer");
  assert.throws(() => parseAlg("Rw", XCUBE));
  assert.throws(() => parseAlg("2R", XCUBE), /unexpected character '2'/);
});

test("cube3: the notation help says what is the WCA's and what isn't", () => {
  const cube = notationHelp(CUBE3), x = notationHelp(XCUBE);
  assert.ok(cube.rows.some((r) => r.notation.startsWith("Rw")));
  assert.ok(!cube.rows.some((r) => r.notation.startsWith("r ")));
  assert.match(cube.note, /WCA reads it as R/);
  assert.ok(x.rows.some((r) => r.notation === "r l u d f b"));
  assert.ok(x.rows.some((r) => r.notation === "H"));
  assert.ok(!x.rows.some((r) => r.notation.startsWith("Rw")));
  assert.match(x.note, /H is this Lab's own/);
  // What the help shows parses: ′ is read as '.
  assert.ok(after("R′ U2").equals(after("R' U2")));
});

test("cube3: face views are 3 by 3", () => {
  assert.deepEqual(faceView(after("R"), 4), ["GGY", "GGY", "GGY"]);
  assert.equal(netView(solved).split("\n").length, 3 * 3 + 3);
});

test("cube3: search finds the way back from a few turns", () => {
  const r = search(after("R U F'"), looksLike(solved), { maxDepth: 3 });
  assert.equal(formatAlg(r.solutions[0], CUBE3), "F U' R'");
});
