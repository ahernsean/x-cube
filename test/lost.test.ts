import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVE_DEFS, State, applyTurn, type Turn } from "../src/core/puzzle.ts";
import { parseAlg } from "../src/core/notation.ts";
import { solveSteps } from "../src/core/solve.ts";
import { answerOf, bestQuestion, centerColor, endCandidates, findAsHeld, holdAs, narrow, slipCandidates, twoSlipCandidates, twoSlips, wayBack } from "../src/core/lost.ts";

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

test("lost: a slip several turns back, in an earlier step, is found from the whole solve so far", () => {
  const rnd = random(7);
  let interviews = 0, total = 0, most = 0;
  for (let k = 0; k < 4; k++) {
    const st = State.solved();
    for (let i = 30; i > 0; i--) applyTurn(st, { def: rnd(MOVE_DEFS.length), amount: (1 + rnd(3)) as 1 | 2 | 3 });
    const steps = solveSteps(st, "kinds");
    for (const n of [6, 9, 12]) {
      // The person followed n steps and knows their last turn; the slip was 1 to 5 turns before it.
      const turns = steps.slice(0, n).flatMap((s) => s.turns);
      const all = slipCandidates(st, turns);
      const near = all.filter((c) => c.at >= turns.length - 6 && c.at < turns.length - 1);
      const truth = near[rnd(near.length)];
      const up = centerColor(truth.state, UP)!, front = centerColor(truth.state, FRONT)!;
      let group = holdAs(all, up, front);
      const real = holdAs([truth], up, front)[0];
      let asked = 0;
      for (let q = bestQuestion(group); q; q = bestQuestion(group)) {
        group = narrow(group, q, answerOf(real.state, q)!);
        asked++;
      }
      assert.equal(group.length, 1);
      assert.equal(group[0].state.appearanceKey(), real.state.appearanceKey());
      interviews++;
      total += asked;
      most = Math.max(most, asked);
    }
  }
  assert.ok(most <= 9, `${interviews} interviews, ${(total / interviews).toFixed(1)} questions on average, ${most} at most`);
  console.log(`whole solve: ${interviews} interviews, ${(total / interviews).toFixed(1)} questions on average, ${most} at most`);
});

test("lost: a turn made on the wrong face is a candidate", () => {
  const cands = slipCandidates(State.solved(), parseAlg("R U R'"));
  const wrong = State.solved();
  for (const t of parseAlg("R U L'")) applyTurn(wrong, t);
  assert.ok(cands.some((c) => c.slip === "face" && c.state.appearanceKey() === wrong.appearanceKey()));
});

test("lost: a last turn misremembered by up to two turns either way is still found", () => {
  const rnd = random(11);
  let interviews = 0, total = 0, most = 0;
  for (let k = 0; k < 4; k++) {
    const st = State.solved();
    for (let i = 30; i > 0; i--) applyTurn(st, { def: rnd(MOVE_DEFS.length), amount: (1 + rnd(3)) as 1 | 2 | 3 });
    const steps = solveSteps(st, "kinds");
    for (const n of [6, 9, 12]) {
      const turns = steps.slice(0, n).flatMap((s) => s.turns);
      const stepStart = steps.slice(0, n - 1).flatMap((s) => s.turns).length;
      // The person says their last turn was the step's last; it was really up to two either side.
      const said = turns.length - 1;
      const real = Math.min(said, said - 2 + rnd(5));
      const made = slipCandidates(st, turns.slice(0, real + 1)).filter((c) => c.at >= real - 5);
      const truth = made[rnd(made.length)];
      const stops = [...turns.keys()].filter((j) => j >= stepStart);
      const all = endCandidates(st, turns, [said, said - 1, said + 1, said - 2, said + 2], stops);
      const up = centerColor(truth.state, UP)!, front = centerColor(truth.state, FRONT)!;
      let group = holdAs(all, up, front);
      const held = holdAs([truth], up, front)[0];
      let asked = 0;
      for (let q = bestQuestion(group); q; q = bestQuestion(group)) {
        group = narrow(group, q, answerOf(held.state, q)!);
        asked++;
      }
      assert.equal(group.length, 1);
      assert.equal(group[0].state.appearanceKey(), held.state.appearanceKey(), "the one left looks like the person's puzzle");
      interviews++;
      total += asked;
      most = Math.max(most, asked);
    }
  }
  assert.ok(most <= 9, `${interviews} interviews, at most ${most} questions`);
  console.log(`misremembered last turn: ${interviews} interviews, ${(total / interviews).toFixed(1)} questions on average, ${most} at most`);
});

test("lost: a candidate's turns and its way back hold only turns the puzzle takes", () => {
  // F2 for the first F': both r turns are then refused, so they are neither made nor undone.
  const cands = slipCandidates(State.solved(), parseAlg("F' L' F r F' L F r'"));
  let checked = 0;
  for (const c of cands) {
    const st = State.solved();
    for (const t of c.made) assert.ok(applyTurn(st, t), "every turn made is one the puzzle takes");
    for (const t of wayBack(c)) assert.ok(applyTurn(st, t), "every turn of the way back is one the puzzle takes");
    assert.equal(st.appearanceKey(), State.solved().appearanceKey(), "the way back returns to the start");
    checked++;
  }
  const f2 = cands.find((c) => c.at === 0 && c.as[0]?.amount === 2);
  assert.ok(f2 && !f2.made.some((t) => MOVE_DEFS[t.def].kind === "outer"), "with F2 first, the refused r turns are left out");
  assert.ok(checked > 10);
});

test("lost: two stacked mistakes in a step's turns are found from a few answers", () => {
  const rnd = random(3);
  let interviews = 0, total = 0, most = 0;
  for (let k = 0; k < 4; k++) {
    const st = State.solved();
    for (let i = 30; i > 0; i--) applyTurn(st, { def: rnd(MOVE_DEFS.length), amount: (1 + rnd(3)) as 1 | 2 | 3 });
    const steps = solveSteps(st, "kinds");
    const m = steps.findIndex((s, i) => i >= 4 && s.turns.length >= 8);
    const at = st.clone();
    for (const s of steps.slice(0, m)) for (const t of s.turns) applyTurn(at, t);
    const turns = steps[m].turns;
    const seen = new Set<string>();
    const all = [...slipCandidates(at, turns, 0, seen), ...twoSlipCandidates(at, turns, 0, seen)];
    const two = all.filter((c) => c.second);
    for (let r = 0; r < 3; r++) {
      const truth = two[rnd(two.length)];
      const up = centerColor(truth.state, UP)!, front = centerColor(truth.state, FRONT)!;
      let group = holdAs(all, up, front);
      const held = holdAs([truth], up, front)[0];
      let asked = 0;
      for (let q = bestQuestion(group); q; q = bestQuestion(group)) {
        group = narrow(group, q, answerOf(held.state, q)!);
        asked++;
      }
      assert.equal(group.length, 1);
      assert.equal(group[0].state.appearanceKey(), held.state.appearanceKey());
      const back = group[0].state.clone();
      for (const t of wayBack(group[0])) assert.ok(applyTurn(back, t), "the way back takes only turns the puzzle makes");
      assert.equal(back.appearanceKey(), at.appearanceKey(), "and it returns to where the step began");
      interviews++;
      total += asked;
      most = Math.max(most, asked);
    }
  }
  assert.ok(most <= 10, `${interviews} interviews, at most ${most} questions`);
  console.log(`two stacked mistakes: ${interviews} interviews, ${(total / interviews).toFixed(1)} questions on average, ${most} at most`);
});

test("lost: two stacked mistakes are found wherever the person stopped, when the last turn isn't known", () => {
  // Codex's example: a Back on track step's turns, the first two made the other way round,
  // and the person stopping after the third.
  const start = State.solved();
  const turns = parseAlg("R' B' L' F' U2 R' D' U'");
  const truth = State.solved();
  for (const t of parseAlg("R B L'")) applyTurn(truth, t);
  const key = truth.appearanceKey();
  const has = (ends?: number[]) => twoSlipCandidates(start, turns, 0, new Set(), ends, 6).some((c) => c.state.appearanceKey() === key && c.last === 2);
  assert.ok(!has(), "stopping at the last turn alone doesn't give it");
  assert.ok(has(turns.map((_, i) => i)), "any turn of the step as the stop does");
  assert.ok(has([2]), "as does the turn named");
});

test("lost: knowing the puzzle exactly, two slips are found wherever the person stopped, however they hold it", () => {
  // Codex's example for Continue search: made as R B' L' F' U2 R' D, two slips seven turns
  // apart, and stopped there; then held turned a quarter about the vertical.
  const start = State.solved();
  const turns = parseAlg("R' B' L' F' U2 R' D' U'");
  const target = State.solved();
  for (const t of parseAlg("R B' L' F' U2 R' D y")) applyTurn(target, t);
  const found = findAsHeld(twoSlips(start, turns, 0, null, turns.map((_, i) => i)), target);
  assert.ok(found, "found");
  assert.equal(found!.last, 6, "stopped after turn 7");
  assert.equal(found!.state.appearanceKey(), target.appearanceKey(), "held as the puzzle is");
  // A search that finds nothing goes through every stop of a long step in reasonable time.
  const long = parseAlg("l U l' F R F' l F R' F' U' l' y r' U' F' L' F r F' L F r' U r x2 r' U' F'");
  const t0 = performance.now();
  assert.equal(findAsHeld(twoSlips(start, long, 0, null, long.map((_, i) => i)), parseAlg("R U F D L B R2 U2").reduce((st, t) => (applyTurn(st, t), st), State.solved())), undefined);
  console.log(`no match over ${long.length} turns: ${Math.round(performance.now() - t0)} ms`);
});
