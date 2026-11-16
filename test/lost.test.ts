import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVE_DEFS, State, applyTurn, type Turn } from "../src/core/puzzle.ts";
import { parseAlg } from "../src/core/notation.ts";
import { solveSteps } from "../src/core/solve.ts";
import { answerOf, bestQuestion, centerColor, holdAs, narrow, slipCandidates, wayBack } from "../src/core/lost.ts";

const random = (seed: number) => (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), (seed >>> 12) % n);
const UP = 2, FRONT = 4;

test("lost: the candidates are the right result and every single slip, each look once", () => {
  const start = State.solved();
  const cands = slipCandidates(start, parseAlg("R U R'"));
  assert.equal(cands[0].slip, "none");
  const keys = cands.map((c) => c.state.appearanceKey());
  assert.equal(new Set(keys).size, keys.length, "no two candidates look the same");
  // R' made as R: R U R.
  const wrongWay = State.solved();
  for (const t of parseAlg("R U R")) applyTurn(wrongWay, t);
  assert.ok(keys.includes(wrongWay.appearanceKey()), "a turn made the other way is a candidate");
  // U left out:
  const skipped = State.solved();
  for (const t of parseAlg("R R'")) applyTurn(skipped, t);
  assert.ok(keys.includes(skipped.appearanceKey()), "a turn left out is a candidate");
  const layer = State.solved();
  for (const t of parseAlg("r U R'")) applyTurn(layer, t);
  assert.ok(keys.includes(layer.appearanceKey()), "an outer turn for an inner one is a candidate");
});

test("lost: from the centers and a few stickers the interview finds the slip, and its way back returns to the start", () => {
  const rnd = random(31);
  let interviews = 0, most = 0;
  for (let k = 0; k < 3; k++) {
    const st = State.solved();
    for (let i = 30; i > 0; i--) applyTurn(st, { def: rnd(MOVE_DEFS.length), amount: (1 + rnd(3)) as 1 | 2 | 3 });
    const cur = st.clone();
    let prev: { start: State; turns: Turn[] } | null = null;
    for (const step of solveSteps(st, "kinds").slice(0, 12)) {
      // Slips in this step or the one before it.
      const start: State = prev?.start ?? cur;
      const turns = [...(prev?.turns ?? []), ...step.turns];
      const all = slipCandidates(start, turns);
      const truth = all[rnd(all.length)];
      // The person holds the puzzle some way of their own.
      const held = truth.state.clone();
      for (const t of parseAlg(["", "y", "x2", "z y'"][rnd(4)])) applyTurn(held, t);
      const up = centerColor(held, UP)!, front = centerColor(held, FRONT)!;
      let group = holdAs(all, up, front);
      const real = holdAs([truth], up, front)[0];
      let asked = 0;
      for (let q = bestQuestion(group); q; q = bestQuestion(group)) {
        const a = answerOf(real.state, q);
        assert.ok(a !== null, "every question is about a spot the person can see");
        group = narrow(group, q, a);
        asked++;
      }
      assert.equal(group.length, 1);
      assert.equal(group[0].state.appearanceKey(), real.state.appearanceKey(), "the one left looks like the person's puzzle");
      const back = group[0].state.clone();
      for (const t of wayBack(group[0])) applyTurn(back, t);
      assert.equal(back.appearanceKey(), start.appearanceKey(), "its way back returns to where the turns began");
      interviews++;
      most = Math.max(most, asked);
      prev = { start: cur.clone(), turns: step.turns };
      for (const t of step.turns) applyTurn(cur, t);
    }
  }
  assert.ok(interviews >= 30 && most <= 8, `${interviews} interviews, at most ${most} questions`);
});
