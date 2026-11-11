// The color editor's fitting: edited sticker colors to real cubelets (src/core/edit.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitColors, visibleColors } from "../src/core/edit.ts";
import { parseAlg } from "../src/core/notation.ts";
import { CUBELETS, FACE_COLOR, MOVE_DEFS, NUM_SLOTS, State, applyTurn, applyTurns, slotAt, type Kind } from "../src/core/puzzle.ts";
import { rotsTo, unreachableReason } from "../src/core/serialize.ts";

const [R, L, U, F, B] = [0, 1, 2, 4, 5];
const after = (alg: string) => {
  const st = State.solved();
  assert.ok(applyTurns(st, parseAlg(alg)).ok);
  return st;
};
const at = (x: number, y: number, z: number) => slotAt([x, y, z]);

test("edit: unedited colors fit back to the same state, in and out of shape", () => {
  for (const st of [State.solved(), after("F f R U r"), after("R' S' R b R' S R b'"), after("(R U F' L D)3"), after("M R S' x")]) {
    const fit = fitColors(st, visibleColors(st));
    assert.equal(fit.level, "reachable");
    assert.deepEqual(fit.problems, []);
    assert.ok(fit.state!.equals(st), "keeps every cubelet where it was");
  }
});

test("edit: repainting two outer edges as each other moves those cubelets", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(0, 1, 2) * 6 + F] = "R"; // Fx.U shows white and red
  colors[at(2, 1, 0) * 6 + R] = "G"; // Rx.U shows white and green
  const fit = fitColors(st, colors);
  assert.equal(fit.level, "reachable");
  assert.equal(fit.state!.occ[at(0, 1, 2)], st.occ[at(2, 1, 0)]);
  assert.equal(fit.state!.occ[at(2, 1, 0)], st.occ[at(0, 1, 2)]);
  assert.equal(fit.state!.colorAt(at(0, 1, 2), F), "R");
  assert.deepEqual(visibleColors(fit.state!), colors, "shows exactly the painted colors");
});

test("edit: colors no cubelet has are refused, naming the spot", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(0, 1, 2) * 6 + F] = "Y"; // white and yellow on one edge
  const fit = fitColors(st, colors);
  assert.equal(fit.level, null);
  assert.equal(fit.state, null);
  assert.deepEqual(fit.problems, [{ text: "White and yellow can never be on the same cubelet", slots: [at(0, 1, 2)] }]);
});

test("edit: one cubelet needed in two places is refused", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(0, 0, 2) * 6 + F] = "R"; // the front extension center painted red, like the right one
  const fit = fitColors(st, colors);
  assert.equal(fit.level, null);
  assert.equal(fit.problems.length, 1);
  assert.equal(fit.problems[0].text, "Two centers are red, but there can be only one");
  assert.deepEqual([...fit.problems[0].slots].sort(), [at(0, 0, 2), at(2, 0, 0)].sort());
});

test("edit: an outer cubelet turned against the outward-color rule is real cubelets, but not possible", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(0, 1, 2) * 6 + F] = "W"; // flip Fx.U in place: white out front, green on top
  colors[at(0, 1, 2) * 6 + U] = "G";
  const fit = fitColors(st, colors);
  assert.equal(fit.level, "cubelets");
  assert.deepEqual(fit.problems, [{ text: "White can't point straight out from the core on an extension cubelet", slots: [at(0, 1, 2)] }]);
});

test("edit: problems say what's wrong, and which slots they are about", () => {
  const st = State.solved();
  const say = (x: number, y: number, z: number, d: number, c: "W" | "Y" | "G" | "B" | "R" | "O") => {
    const colors = visibleColors(st);
    colors[at(x, y, z) * 6 + d] = c;
    return fitColors(st, colors).problems[0];
  };
  assert.deepEqual(say(1, -1, -2, 5, "O"), { text: "Red and orange can never be on the same cubelet", slots: [at(1, -1, -2)] });
  assert.equal(say(-1, 1, 2, F, "O").text, "No cubelet has two orange stickers");
  // A color no cubelet of that kind has: core corners are only white or yellow.
  assert.equal(say(1, -1, 1, 3, "B").text, "A core corner must be white or yellow, never blue");
  // Two stickers of a corner swapped: its colors exist, but go around it the other way.
  const swapped = visibleColors(st);
  swapped[at(-1, -1, -2) * 6 + 5] = "O";
  swapped[at(-1, -1, -2) * 6 + 1] = "B";
  assert.equal(fitColors(st, swapped).problems[0].text, "Wrong color order");
  // Look-alike core cubelets: more painted than the puzzle has.
  const lookAlike = say(1, 1, 1, U, "Y");
  assert.equal(lookAlike.text, "Five core corners are yellow, but there can be only four");
  assert.deepEqual([...lookAlike.slots].sort(), [at(1, 1, 1), at(1, -1, 1), at(-1, -1, 1), at(1, -1, -1), at(-1, -1, -1)].sort(), "names every spot competing for them");
  // Outer cubelets with the same colors are not look-alikes, but the count works the same.
  const threeGreenOrange = say(-1, 0, -2, 5, "G");
  assert.equal(threeGreenOrange.text, "Three extension edges are green and orange, but there can be only two");
  assert.deepEqual([...threeGreenOrange.slots].sort(), [at(-1, 0, 2), at(-2, 0, 1), at(-1, 0, -2)].sort());
});

test("edit: two spots wanting the one cubelet with a color pointing out are named together", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(1, 0, 2) * 6 + F] = "R"; // flip the green-red side edge of the green extension
  colors[at(1, 0, 2) * 6 + R] = "G";
  const fit = fitColors(st, colors);
  assert.equal(fit.level, "cubelets");
  assert.equal(fit.problems[0].text, "Two extension edges have red pointing straight out from the core, but only one with green and red does");
  assert.deepEqual([...fit.problems[0].slots].sort(), [at(1, 0, 2), at(2, 0, 1)].sort());
});

test("edit: no cubelet has opposite colors or two of one color (the reasons problems give)", () => {
  for (const c of CUBELETS) {
    const cs = c.stickers.filter((x) => x);
    assert.equal(new Set(cs).size, cs.length);
    for (let k = 0; k < 6; k += 2) assert.ok(!(cs.includes(FACE_COLOR[k]) && cs.includes(FACE_COLOR[k + 1])), `${c.name} has opposite colors`);
  }
});

// ---- Reachable: whether turns can make some state that shows the painted colors.

/** Trades the cubelets in two slots as taking them out and putting them back would, each turned the one way turns allow there. */
const tradeOuter = (st: State, a: number, b: number) => {
  const [ia, ib] = [st.occ[a], st.occ[b]];
  [st.occ[a], st.ori[a], st.occ[b], st.ori[b]] = [ib, rotsTo(ib, a)[0], ia, rotsTo(ia, b)[0]];
};

test("edit: when the first fit can't be reached but another can, the colors are valid", () => {
  // Two outer corners traded: with every other cubelet left alone no turns make this, but
  // trading look-alike core cubelets that show the same makes it reachable.
  const st = after("U F2 r U'");
  tradeOuter(st, at(2, 1, 1), at(-1, 1, -2));
  assert.match(unreachableReason(st)!, /two outer cubelets are swapped/);
  const colors = visibleColors(st);
  const fit = fitColors(st, colors);
  assert.equal(fit.level, "reachable");
  assert.deepEqual(fit.problems, []);
  assert.equal(unreachableReason(fit.state!), null);
  assert.deepEqual(visibleColors(fit.state!), colors, "shows exactly the painted colors");
  assert.ok(!fit.state!.equals(st), "by a state other than the first fit");
  const moved = [...Array(NUM_SLOTS).keys()].filter((s) => fit.state!.occ[s] !== st.occ[s] || fit.state!.ori[s] !== st.ori[s]);
  assert.ok(moved.every((s) => !["outerCorner", "outerEdge"].includes(CUBELETS[st.occ[s]].kind)), "leaving every outer corner and edge where it was painted");
});

test("edit: any outer cubelets traded, in or out of shape, leave colors turns can reach", () => {
  // The paint can't force a swap or flip parity: look-alike and unseen core cubelets
  // absorb every one (the argument is at the top of src/core/edit.ts).
  let seed = 20261110;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), (seed >>> 12) % n);
  let unreachableFirst = 0;
  for (let trial = 0; trial < 200; trial++) {
    const st = State.solved();
    for (let i = rnd(25); i > 0; i--) applyTurn(st, { def: rnd(MOVE_DEFS.length), amount: (1 + rnd(3)) as 1 | 2 | 3 });
    for (const kind of ["outerCorner", "outerEdge"] as Kind[]) {
      const slots = [...Array(NUM_SLOTS).keys()].filter((s) => st.occ[s] >= 0 && CUBELETS[st.occ[s]].kind === kind);
      for (let i = rnd(4); i > 0; i--) {
        const [a, b] = [slots[rnd(slots.length)], slots[rnd(slots.length)]];
        if (a !== b) tradeOuter(st, a, b);
      }
    }
    if (unreachableReason(st)) unreachableFirst++;
    const colors = visibleColors(st);
    const fit = fitColors(st, colors);
    assert.equal(fit.level, "reachable", `trial ${trial}`);
    assert.equal(unreachableReason(fit.state!), null, `trial ${trial}`);
    assert.deepEqual(visibleColors(fit.state!), colors, `trial ${trial}`);
  }
  assert.ok(unreachableFirst > 50, `the sample includes first fits turns can't reach (${unreachableFirst})`);
});

test("edit: center colors arranged as no turns arrange them can't be reached", () => {
  const st = State.solved();
  const [fx, bx, rx, lx] = [at(0, 0, 2), at(0, 0, -2), at(2, 0, 0), at(-2, 0, 0)];
  // Red and orange traded: each color is still opposite its partner, but they go around the other way.
  const mirrored = visibleColors(st);
  mirrored[rx * 6 + R] = "O";
  mirrored[lx * 6 + L] = "R";
  let fit = fitColors(st, mirrored);
  assert.equal(fit.level, "possible");
  assert.deepEqual(visibleColors(fit.state!), mirrored, "still shows a state with the paint");
  assert.equal(fit.problems.length, 1);
  assert.equal(fit.problems[0].text, "Wrong center color order");
  assert.deepEqual([...fit.problems[0].slots].sort(), [fx, bx, rx, lx, at(0, 1, 0), at(0, -1, 0)].sort(), "names every center that shows");
  // Red and green traded: red ends up opposite blue.
  const apart = visibleColors(st);
  apart[rx * 6 + R] = "G";
  apart[fx * 6 + F] = "R";
  fit = fitColors(st, apart);
  assert.equal(fit.level, "possible");
  assert.equal(fit.problems[0].text, "Opposite centers must be red and orange, green and blue, or white and yellow");
  assert.deepEqual([...fit.problems[0].slots].sort(), [fx, bx, rx, lx].sort());
  // Slices move the centers, and that arrangement is fine.
  const sliced = after("M S' H2 R");
  assert.equal(fitColors(sliced, visibleColors(sliced)).level, "reachable");
  // Out of shape, a center without an extension shows its own color.
  const turned = after("M");
  const colors = visibleColors(turned);
  const [up, down] = [at(0, 2, 0), at(0, -2, 0)];
  [colors[up * 6 + U], colors[down * 6 + 3]] = [colors[down * 6 + 3], colors[up * 6 + U]];
  fit = fitColors(turned, colors);
  assert.equal(fit.level, "possible");
  assert.equal(fit.problems[0].text, "Wrong center color order");
});

test("edit: a start no turns reach is refused, saying so", () => {
  const st = State.solved();
  const corner = at(1, 1, 1);
  st.ori[corner] = rotsTo(st.occ[corner], corner).find((o) => o !== st.ori[corner])!; // a core corner twisted in place
  const fit = fitColors(st, visibleColors(st));
  assert.equal(fit.level, "possible");
  assert.deepEqual(fit.problems, [{ text: "The position editing started from can't be reached by turning (the core corners are twisted)", slots: [] }]);
});
