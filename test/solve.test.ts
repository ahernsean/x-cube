// The step-by-step solver (src/core/solve.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isHomeX, isSolved } from "../src/core/analyze.ts";
import { fitColors, visibleColors } from "../src/core/edit.ts";
import { DIRS } from "../src/core/geometry.ts";
import { parseAlg } from "../src/core/notation.ts";
import { CUBELETS, FACE_COLOR, MOVE_DEFS, NUM_SLOTS, SLOT_POS, State, applyTurn, applyTurns, invertTurns, slotAt, turnName, type Kind } from "../src/core/puzzle.ts";
import { decodeState, rotsTo, unreachableReason } from "../src/core/serialize.ts";
import { nextStep, solveSteps, type Mode, type SolveStep } from "../src/core/solve.ts";

const after = (alg: string) => {
  const st = State.solved();
  assert.ok(applyTurns(st, parseAlg(alg)).ok);
  return st;
};
const random = (seed: number) => (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), (seed >>> 12) % n);
const scrambled = (rnd: (n: number) => number) => {
  const st = State.solved();
  for (let i = 5 + rnd(40); i > 0; i--) applyTurn(st, { def: rnd(MOVE_DEFS.length), amount: (1 + rnd(3)) as 1 | 2 | 3 });
  return st;
};
/** What shows on every face of every slot whose cubelet is not in `except`. */
const look = (st: State, except: Set<number>) => {
  let out = "";
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (st.occ[s] < 0 || except.has(st.occ[s])) out += "|";
    else for (let d = 0; d < 6; d++) out += st.colorAt(s, d) ?? "-";
  }
  return out;
};
const usage = { turns: 0, back: 0 };
const LAYER_CORE = ["coreTop", "coreTopC", "coreMiddle", "coreBottom", "coreBottomC"];
/** How many core cubelets of the i-th layer stage's kind are where they belong in st. */
function coreInPlace(st: State, i: number): number {
  const wanted = [
    ["singleEdge", "W", 1], ["coreCorner", "W", 1], ["doubleEdge", null, 0], ["singleEdge", "Y", -1], ["coreCorner", "Y", -1],
  ][i] as [string, string | null, number];
  let n = 0;
  for (let s = 0; s < NUM_SLOTS; s++) {
    const c = CUBELETS[st.occ[s]];
    if (!c || c.kind !== wanted[0] || (wanted[1] && !c.stickers.includes(wanted[1] as "W"))) continue;
    if (SLOT_POS[s][1] !== wanted[2] || SLOT_POS[s].some((v) => Math.abs(v) > 1)) continue;
    // A white or yellow sticker must face up or down; a double edge only has to be in the middle.
    if (wanted[1] && st.colorAt(s, wanted[2] > 0 ? 2 : 3) !== wanted[1]) continue;
    n++;
  }
  return n;
}
/** Whether the cubelet in a slot is home: each of its stickers matches the center of the face it is on. */
const atHome = (st: State, slot: number) =>
  [0, 1, 2, 3, 4, 5].every((d) => {
    const center = CUBELETS[st.occ[slotAt(DIRS[d])]];
    const color = st.colorAt(slot, d);
    return !color || color === FACE_COLOR[[0, 1, 2, 3, 4, 5].find((h) => slotAt(DIRS[h]) === center.home)!];
  });
/** Whether the white center is up (yellow is up once an outer step has flipped the puzzle over). */
const whiteUp = (st: State) => CUBELETS[st.occ[slotAt([0, 1, 0])]].home === slotAt([0, 1, 0]);
/** st turned white up, if it is held yellow up. */
const upright = (st: State) => {
  if (whiteUp(st)) return st;
  const turned = st.clone();
  applyTurns(turned, parseAlg("x2"));
  return turned;
};
/** Plays the steps from st, checking each does what it reports; returns the final state. */
function play(start: State, steps: SolveStep[], mode: Mode = "kinds"): State {
  const st = start.clone();
  const order = ["hold", "shape", "core", "parity", ...(mode === "kinds" ? ["corners", "edges"] : ["topEdges", "topCorners", "sideEdges", "bottomCorners", "bottomEdges"])];
  if (mode === "layers") order.splice(1, 2, ...LAYER_CORE);
  let stage = 0;
  for (const step of steps) {
    if (step.stage === "regrip") {
      // A regrip is a step of its own, anywhere: it only turns the whole puzzle.
      assert.ok(step.turns.length && step.turns.every((t) => MOVE_DEFS[t.def].kind === "rotation"), `a regrip step only turns the whole puzzle (${step.alg})`);
      assert.ok(step.turns.length <= 2, `${step.alg} regrips with at most a flip and a turn`);
      assert.equal(step.regrip, step.alg);
      assert.deepEqual(step.moved, []);
      assert.ok(applyTurns(st, step.turns).ok);
      continue;
    }
    assert.ok(order.indexOf(step.stage) >= stage, `${step.stage} comes after ${order[stage]}`);
    stage = order.indexOf(step.stage);
    const before = st.clone();
    assert.ok(applyTurns(st, step.turns).ok, `every turn of ${step.alg} is allowed`);
    assert.deepEqual(parseAlg(step.alg), step.turns, "the notation is the turns");
    assert.equal(step.parts.reduce((n, part) => n + part.turns, 0), step.turns.length, `the parts of ${step.alg} are all of its turns`);
    if (step.stage === "hold") continue;
    // Any regrip is a step before this one: this one turns no whole puzzle.
    assert.equal(step.regrip, "", `${step.alg} has no regrip of its own`);
    assert.ok(!step.turns.some((t) => MOVE_DEFS[t.def].kind === "rotation"), `${step.alg} turns no whole puzzle`);
    const seen = st.clone();
    usage.turns += step.turns.length;
    for (const t of step.turns) if (/^[Bb]/.test(turnName(t))) usage.back++;
    if (["corners", "edges"].includes(step.stage)) assert.ok(!/[bBSH]/.test(step.alg.slice(step.alg.indexOf(":") + 1)), `the cycle in ${step.alg} has no back turn and no S or H`);
    // Every cubelet the step doesn't name, or free, shows the same in the same slot.
    const named = new Set([...step.moved.map(([from]) => before.occ[from]), ...step.free.map((s) => before.occ[s])]);
    assert.equal(look(seen, named), look(before, named), `${step.alg} changes only what it names`);
    if (LAYER_CORE.includes(step.stage)) {
      // One more cubelet of the stage's kind where it belongs, and every earlier kind kept.
      const k = LAYER_CORE.indexOf(step.stage);
      const n = (st: State) => LAYER_CORE.map((_, i) => coreInPlace(upright(st), i));
      const [was, now] = [n(before), n(seen)];
      assert.ok(now[k] > was[k] && now.slice(0, k).every((c) => c === 4), `${step.alg} brings one more of its kind in, keeping the earlier kinds (${was} to ${now})`);
      assert.match(step.goal, new RegExp(`\\(${now[k]} of 4\\)$`));
      continue;
    }
    assert.ok(isHomeX(seen), `${step.alg} ends in the X shape`);
    if (step.stage === "shape") continue;
    for (let s = 0; s < NUM_SLOTS; s++)
      if (["coreCorner", "singleEdge"].includes(CUBELETS[seen.occ[s]]?.kind)) assert.equal(seen.colorAt(s, SLOT_POS[s][1] > 0 ? 2 : 3), SLOT_POS[s][1] > 0 === whiteUp(seen) ? "W" : "Y", `after ${step.alg}, the core cubelets are the color of their X-face center`);
    if (step.stage !== "core") for (const [from, to] of step.moved) assert.equal(seen.occ[to], before.occ[from], `${step.alg} moves the cubelet it says where it says`);
    // A cycle brings home the cubelets it says, and at least one.
    if (!["core", "parity"].includes(step.stage)) {
      // Its parts: the setup, the eight turns of the cycle, and the setup undone, after any regrip.
      const names = step.parts.map((part) => part.name).join();
      assert.ok(["cycle", "setup,cycle,undo", "regrip,cycle", "regrip,setup,cycle,undo"].includes(names), `${step.alg} is ${names}`);
      const [setup, undo] = [step.parts.find((part) => part.name === "setup"), step.parts.find((part) => part.name === "undo")];
      assert.equal(setup?.turns, undo?.turns);
      if (setup) assert.deepEqual(step.turns.slice(-setup.turns), parseAlg(`(${step.alg.slice(step.alg.indexOf("[") + 1, step.alg.indexOf(":"))})'`), `${step.alg} ends by undoing its setup`);
      assert.ok(step.lands.length >= 1, `${step.alg} brings a cubelet home`);
      assert.match(step.goal, [/One ends up solved$/, /Two end up solved$/, /All three end up solved$/][step.lands.length - 1]);
      for (const [from, to] of step.moved) assert.equal(atHome(seen, to), step.lands.includes(from), `${step.alg} says which cubelets end at home`);
    }
  }
  return st;
}

test("solve: scrambled positions are solved, each step changing only what it reports", () => {
  const rnd = random(11);
  let turns = 0, most = 0;
  for (let trial = 0; trial < 60; trial++) {
    const st = scrambled(rnd);
    const steps = solveSteps(st);
    assert.ok(isSolved(play(st, steps)), `trial ${trial}`);
    const n = steps.reduce((sum, s) => sum + s.turns.length, 0);
    turns += n;
    most = Math.max(most, n);
    const shape = steps.find((s) => s.stage === "shape");
    assert.ok(!shape || shape.turns.length <= 12, "the shape step is at most 12 turns");
  }
  assert.ok(most <= 300 && turns / 60 <= 220, `solutions stay learnable in length (average ${turns / 60}, most ${most})`);
  // Ease: the back face and back extension are the hardest to turn, so they are rare.
  assert.ok(usage.back / usage.turns < 0.03, `back turns are rare (${usage.back} of ${usage.turns})`);
});

test("solve: positions from the color editor are solved, whichever parity they need", () => {
  // Outer cubelets traded at random, then fitted as the editor fits paint. This is the
  // constructive check of the editor's "Valid": each such position gets actual turns to solved.
  const rnd = random(2026);
  const parity = new Set<string>();
  for (let trial = 0; trial < 60; trial++) {
    const st = scrambled(rnd);
    for (const kind of ["outerCorner", "outerEdge"] as Kind[]) {
      const slots = [...Array(NUM_SLOTS).keys()].filter((s) => st.occ[s] >= 0 && CUBELETS[st.occ[s]].kind === kind);
      for (let i = rnd(4); i > 0; i--) {
        const [a, b] = [slots[rnd(slots.length)], slots[rnd(slots.length)]];
        if (a === b) continue;
        const [ia, ib] = [st.occ[a], st.occ[b]];
        [st.occ[a], st.ori[a], st.occ[b], st.ori[b]] = [ib, rotsTo(ib, a)[0], ia, rotsTo(ia, b)[0]];
      }
    }
    const fit = fitColors(st, visibleColors(st));
    assert.equal(fit.level, "reachable");
    const steps = solveSteps(fit.state!);
    assert.ok(isSolved(play(fit.state!, steps)), `trial ${trial}`);
    parity.add(steps.find((s) => s.stage === "parity")?.alg ?? "none");
  }
  assert.deepEqual([...parity].sort(), ["U", "U r", "none", "r"], "the sample needs every parity fix, and none");
});

test("solve: layer by layer solves the same positions, the core a cubelet at a time from the top", () => {
  // The other order: white X-face edges, its corners, the side edges, then the yellow
  // X-face's corners and edges. A layer, once done, stays done.
  const rnd = random(77);
  let turns = 0;
  for (let trial = 0; trial < 40; trial++) {
    const st = scrambled(rnd);
    const steps = solveSteps(st, "layers");
    assert.ok(isSolved(play(st, steps, "layers")), `trial ${trial}`);
    turns += steps.reduce((sum, s) => sum + s.turns.length, 0);
    assert.ok(steps.every((s) => s.stage !== "corners" && s.stage !== "edges"));
  }
  assert.ok(turns / 40 <= 260, `layer by layer stays learnable in length (average ${turns / 40})`);
});

test("solve: two outer edges traded alone are solved through the U parity step", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  const [fu, ru] = [CUBELETS.find((c) => c.name === "Fx.U")!.home, CUBELETS.find((c) => c.name === "Rx.U")!.home];
  [colors[fu * 6 + 4], colors[ru * 6 + 0]] = ["R", "G"];
  const fit = fitColors(st, colors);
  const steps = solveSteps(fit.state!);
  assert.equal(steps[0].stage, "parity");
  assert.equal(steps[0].alg, "U");
  assert.ok(isSolved(play(fit.state!, steps)));
});

test("solve: an outer step flips the puzzle over when the cubelets it cycles are on the bottom", () => {
  // Shape and core done; the first corners to cycle are three yellow X-face corners.
  const st = decodeState("GAQB MAQZ OPMU ADTJ BUGX BTTM REMC BKDW RYUV XEPY LUSB");
  for (const mode of ["kinds", "layers"] as Mode[]) {
    const steps = solveSteps(st, mode);
    assert.ok(isSolved(play(st, steps, mode)), mode);
    const i = steps.findIndex((s) => s.stage === "regrip" && s.alg.includes("x2"));
    assert.ok(i >= 0, `${mode}: some regrip step flips the puzzle over`);
    const next = steps[i + 1];
    assert.ok(next.moved.filter(([from]) => SLOT_POS[from][1] > 0).length >= 2, `${mode}: the step after the flip is for cubelets now on top (${next.alg})`);
    assert.ok(!steps.some((s) => s.stage === "hold"), `${mode}: the steps go on with yellow up, with no hold step`);
  }
  const first = nextStep(st)!;
  assert.equal(first.stage, "regrip");
  assert.equal(first.alg, "x2", "the first step flips the puzzle over, alone");
  assert.match(first.goal, /^Flip the puzzle over, so yellow is up\. Nothing else moves$/);
  const turned = st.clone();
  applyTurns(turned, first.turns);
  const second = nextStep(turned)!;
  assert.equal(second.stage, "corners");
  assert.ok(second.moved.every(([from]) => SLOT_POS[from][1] > 0), "its three corners are on top, where the flip brought them");
});

test("solve: a layer core step flips the puzzle over for yellow core cubelets on the bottom, and the next goes on yellow up", () => {
  // Layer by layer, at the yellow core corners, all four of them still to place.
  const st = decodeState("GWSV OIRU LSII FXSG YHCO UAHZ SCBW RRHP LSSB IWGO GTNA");
  const flip = nextStep(st, "layers")!;
  assert.equal(flip.stage, "regrip");
  assert.ok(flip.alg.startsWith("x2"), `it flips the puzzle over, in a step of its own (${flip.alg})`);
  const next = st.clone();
  applyTurns(next, flip.turns);
  const first = nextStep(next, "layers")!;
  assert.equal(first.stage, "coreBottomC");
  assert.equal(first.regrip, "", `it goes on yellow up (${first.alg})`);
  assert.ok(first.moved.every(([from]) => SLOT_POS[from][1] > 0), "its corners are on top, where the flip brought them");
  assert.match(first.goal, /top layer, yellow up \([1-4] of 4\)$/, "the goal is as the puzzle is held");
  applyTurns(next, first.turns);
  const second = nextStep(next, "layers")!;
  assert.ok(second.stage === "coreBottomC" || (second.stage === "regrip" && !second.alg.includes("x2")), `it goes on yellow up (${second.alg})`);
  assert.ok(isSolved(play(st, solveSteps(st, "layers"), "layers")));
});

test("solve: a position held yellow up starts with a hold step until its core is done, layer by layer goes on yellow up", () => {
  const st = after("x2 R U");
  assert.equal(nextStep(st)!.stage, "hold");
  const steps = solveSteps(st, "layers");
  assert.ok(isSolved(play(st, steps, "layers")));
  assert.notEqual(steps[0].stage, "hold", "layer by layer, the core steps go on yellow up");
  const flipped = after("U r x2");
  assert.notEqual(nextStep(flipped)!.stage, "hold", "with the shape and core done, the outer steps go on yellow up");
});

test("solve: layer by layer works each white or yellow layer with it on top, nearly always", () => {
  const rnd = random(77);
  let steps = 0, down = 0;
  for (let trial = 0; trial < 20; trial++) {
    const st = scrambled(rnd);
    for (const step of solveSteps(st, "layers")) {
      const held = st.clone();
      applyTurns(held, parseAlg(step.regrip));
      const white = /^(coreTop|top)/.test(step.stage), yellow = /^(coreBottom|bottom)/.test(step.stage);
      if (white || yellow) {
        steps++;
        if (white !== whiteUp(held)) down++;
      }
      applyTurns(st, step.turns);
    }
  }
  assert.ok(down / steps < 0.06, `${down} of ${steps} steps build a layer while it is on the bottom`);
});

test("solve: the stages come as needed", () => {
  assert.deepEqual(solveSteps(State.solved()), []);
  assert.equal(nextStep(State.solved()), null);
  assert.deepEqual(solveSteps(after("x y")).map((s) => s.stage), ["hold"], "a turned-over solved puzzle only needs holding");
  assert.equal(nextStep(after("R"))!.stage, "shape");
  assert.equal(nextStep(after("R"))!.turns.length, 1, "one turn undoes one turn");
  assert.equal(nextStep(after("R2"))!.stage, "core");
  const cycle = nextStep(after("(F' L' F) r (F' L F) r'"))!;
  assert.equal(cycle.stage, "corners");
  assert.equal(cycle.alg, "r (F' L' F) r' (F' L F)", "one 3-cycle is undone by its inverse, with no setup, written as a commutator");
  assert.match(cycle.goal, /All three end up solved/);
  assert.equal(cycle.lands.length, 3);
  // So is the mirrored one, with R inside for a right-handed person.
  for (const [kind, alg, undo] of [["corners", "(F R F') l' (F R' F') l", "l' (F R F') l (F R' F')"], ["edges", "(F M' F') l' (F M F') l", "l' (F M' F') l (F M F')"]]) {
    const mirrored = nextStep(after(alg))!;
    assert.equal(mirrored.stage, kind);
    assert.equal(mirrored.alg, undo, `the mirrored ${kind} cycle is undone by its own inverse`);
  }
  // The hold step only brings white up; whichever side is in front then is the grip, and
  // the rest is solved from there. Later steps turn the whole puzzle only about its
  // vertical axis, so white stays up.
  const start = after("R U F' x");
  const tipped = solveSteps(start);
  assert.equal(tipped[0].stage, "hold");
  assert.match(tipped[0].goal, /so the white center is up \(now \w+ is up\)/);
  assert.ok(tipped.slice(1).every((s) => s.turns.every((t) => !/^[xz]/.test(turnName(t)))));
  assert.ok(isSolved(play(start, tipped)));
  assert.deepEqual(solveSteps(after("y")), [], "a solved puzzle is solved in any grip");
});

test("solve: a position no turns reach is refused", () => {
  const st = State.solved();
  const [a, b] = [CUBELETS.find((c) => c.name === "Fx.U")!.home, CUBELETS.find((c) => c.name === "Rx.U")!.home];
  const [ia, ib] = [st.occ[a], st.occ[b]];
  [st.occ[a], st.ori[a], st.occ[b], st.ori[b]] = [ib, rotsTo(ib, a)[0], ia, rotsTo(ia, b)[0]];
  assert.ok(unreachableReason(st));
  assert.throws(() => solveSteps(st), /turns can't reach this position/);
});

test("solve: a regrip that flips the puzzle both over and around is said as one move", () => {
  const st = State.solved();
  for (const t of parseAlg("R H L F M L M M M F D R H M U H H S")) applyTurn(st, t);
  applyTurns(st, parseAlg("x' R y R L' U2 F R' U F' R' D2 R y2 R' D2 R R F U F U' F2 R' x2 L2 D2 R' U2 R2 F U L F' L' F' L U2 F U2 F' U2 L' F D U' F R F' D' F' R' U2 R U R' U R y2 R F L F' U2 F L' F' R' U"));
  const step = nextStep(st, "layers")!;
  assert.equal(step.stage, "regrip");
  assert.equal(step.alg, "x2 y2");
  assert.equal(step.goal, "Reorient the puzzle in your hand so that white is up and blue is in front. Nothing else moves");
});
