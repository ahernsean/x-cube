// Every algorithm the Lab lists (src/core/algorithms.ts) does what it says from its position.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KNOWN_ALGORITHMS } from "../src/core/algorithms.ts";
import { effect, faceView, isHomeX } from "../src/core/analyze.ts";
import { parseAlg } from "../src/core/notation.ts";
import { CUBELETS, applyTurns } from "../src/core/puzzle.ts";

const WHITE_TOP = [".WWW.", "WWWWW", "WWWWW", "WWWWW", ".WWW."];

for (const a of KNOWN_ALGORITHMS) {
  test(`known algorithm "${a.name}": ${a.alg} gives ${a.result}`, () => {
    const start = a.start();
    const st = start.clone();
    const r = applyTurns(st, parseAlg(a.alg));
    assert.ok(r.ok, r.error ?? "");
    assert.ok(isHomeX(st), "ends in the X shape, white up");
    if (a.result === "x-shape") assert.ok(!isHomeX(start), "starts out of shape");
    if (a.result === "x-shape, white top kept") {
      assert.ok(!isHomeX(start), "starts out of shape");
      assert.deepEqual(faceView(start, 2), WHITE_TOP, "starts with the white top solved");
      assert.deepEqual(faceView(st, 2), WHITE_TOP, "keeps it");
    }
    if (a.result === "3-cycle") {
      const e = effect(start, st);
      assert.equal(e.moved.length, 3);
      assert.equal(e.cycles.length, 1);
    }
  });
}

test("known algorithms: the corner 3-cycle moves X-face corners, the edge 3-cycle outer edges", () => {
  const kinds = (id: string) => {
    const a = KNOWN_ALGORITHMS.find((k) => k.id === id)!;
    const st = a.start().clone();
    applyTurns(st, parseAlg(a.alg));
    return [...new Set(effect(a.start(), st).moved.map((m) => CUBELETS[m.id].kind))];
  };
  assert.deepEqual(kinds("baum-corner"), ["outerCorner"]);
  assert.deepEqual(kinds("baum-edge"), ["outerEdge"]);
});
