// The editor (src/core/edit.ts): fitting painted sticker colors to real cubelets, and
// editing the shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNPAINTED, draftColors, draftFilled, draftProblems, draftSpots, draftTap, fitColors, repaint, visibleColors, type Draft } from "../src/core/edit.ts";
import { parseAlg } from "../src/core/notation.ts";
import { CUBELETS, FACE_COLOR, MOVE_DEFS, NUM_SLOTS, SLOT_POS, State, applyTurn, applyTurns, slotAt, type Color, type Kind } from "../src/core/puzzle.ts";
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

test("edit: more spots than cubelets say what the spots share and how many have a wrong sticker", () => {
  const st = State.solved();
  const shared = visibleColors(st);
  shared[280] = UNPAINTED;
  shared[201] = "W";
  shared[456] = "W";
  assert.equal(fitColors(st, shared).problems[0].text, "These six extension edges show white, but only four have white. At least two of them have a sticker with the wrong color");
  const mixed = visibleColors(st);
  mixed[158] = "R";
  mixed[152] = "Y";
  mixed[157] = UNPAINTED;
  // This paint has a second problem too (five yellow core corners); the corners' is among them.
  assert.ok(fitColors(st, mixed).problems.some((p) => p.text === "Only two X-face corners have colors like these three do. At least one of them has a sticker with the wrong color"));
});

test("edit: two corners painted alike are named as looking the same, without saying which sticker is wrong", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  const s = at(1, 1, 2); // twist Fx.UR in place, so it shows as Rx.UF does
  colors[s * 6 + F] = "R";
  colors[s * 6 + U] = "G";
  colors[s * 6 + R] = "W";
  const fit = fitColors(st, colors);
  assert.equal(fit.problems[0].text, "These two X-face corners look the same, but the puzzle has only one like that. One of them has a sticker with the wrong color");
  assert.deepEqual([...fit.problems[0].slots].sort(), [s, at(2, 1, 1)].sort());
});

test("edit: an outer cubelet turned against the outward-color rule is real cubelets, but not possible", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(0, 1, 2) * 6 + F] = "W"; // flip Fx.U in place: white out front, green on top
  colors[at(0, 1, 2) * 6 + U] = "G";
  const fit = fitColors(st, colors);
  assert.equal(fit.level, "cubelets");
  assert.deepEqual(fit.problems, [{ text: "This cubelet's white sticker has the wrong color", slots: [at(0, 1, 2)] }]);
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
  assert.equal(fit.problems[0].text, "These two extension edges look the same, but the puzzle has only one like that. One of them has a sticker with the wrong color");
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

test("edit: core corners twisted as no turns twist them are refused, naming none", () => {
  const st = State.solved();
  const corner = at(1, 1, 1);
  st.ori[corner] = rotsTo(st.occ[corner], corner).find((o) => o !== st.ori[corner])!; // a core corner twisted in place
  const fit = fitColors(st, visibleColors(st));
  assert.equal(fit.level, "possible");
  assert.deepEqual(fit.problems, [{ text: "The core corners can't all have these orientations at once. One of them needs to be rotated", slots: [] }]);
});

// ---------------------------------------------------------------- shape editing

const draft = (st = State.solved()): Draft => ({ shape: st.clone(), removed: new Set(), added: new Set() });
const OUTER = [...Array(NUM_SLOTS).keys()].filter((s) => SLOT_POS[s].some((c) => Math.abs(c) === 2));
/** The bare outer spots against core slot c. */
const bareOf = (d: Draft, c: number) => OUTER.filter((n) => !draftFilled(d, n) && SLOT_POS[n].every((v, i) => v === SLOT_POS[c][i] || (Math.abs(v) === 2 && SLOT_POS[c][i] === Math.sign(v))));
const texts = (d: Draft) => draftProblems(d).map((p) => p.text);
/** The paint a draft's shape shows, every sticker of it as on a solved puzzle. */
const solvedPaint = (d: Draft): (Color | undefined)[] => draftColors(d, []).map((c, i) => (c === UNPAINTED ? (FACE_COLOR[i % 6] as Color) : undefined));

test("edit: an extension cubelet on a core corner comes and goes alone, and the line names the corner", () => {
  const d = draft();
  const tap = draftTap(d, at(2, 1, 1))!; // Rx.UF
  assert.deepEqual(tap.carries, [], "nothing turns");
  const paint = repaint(visibleColors(State.solved()) as (Color | undefined)[], tap);
  assert.equal(paint[at(1, 1, 1) * 6 + U], "W", "the corner's own sticker keeps its paint");
  assert.equal(paint[at(1, 1, 1) * 6 + R], "R", "and the side it bares takes the color that was over it");
  assert.equal(paint[at(2, 0, 1) * 6 + U], "W", "its top's white falls onto the cubelet below it");
  assert.equal(paint[at(2, 1, 0) * 6 + F], "G", "its front's green onto the cubelet behind it");
  assert.ok(!draftFilled(d, at(2, 1, 1)) && draftFilled(d, at(1, 1, 2)), "only the tapped cubelet goes");
  assert.deepEqual(draftProblems(d).map((p) => p.text), ["This core corner has only one extension, but it has to have two"]);
  assert.deepEqual(draftProblems(d)[0].slots, [at(1, 1, 1)], "the line names the corner");
  draftTap(d, at(1, 2, 1)); // its top gets one: two again, but not where they were
  assert.deepEqual(draftProblems(d), [], "two extensions on every core corner");
  assert.equal(d.removed.size + d.added.size, 0, "made of real cubelets at once");
  assert.deepEqual(bareOf(d, at(1, 1, 1)), [at(2, 1, 1)], "the right side is the bare one now");
  // One corner turned alone: no turns leave the corners so.
  const fit = fitColors(d.shape, visibleColors(d.shape));
  assert.equal(fit.level, "possible");
  assert.deepEqual(fit.problems.map((p) => p.text), ["The core corners can't all have these orientations at once. One of them needs to be rotated"]);
  assert.deepEqual(fit.problems[0].slots, [], "any corner may be the wrong one, so none is named");
  // Three on one corner, and none on a core edge, each named.
  const e = draft();
  draftTap(e, at(1, 2, 1)); // UFR's bare top
  draftTap(e, at(0, 1, 2)); // UF's one extension
  assert.deepEqual(draftProblems(e).map((p) => p.text).slice(0, 2), ["This core corner has three extensions, but it can have only two", "This core edge has no extensions, but it has to have one or two"]);
  const f = draft();
  draftTap(f, at(2, 1, 1));
  draftTap(f, at(-2, 1, 1)); // UFR and UFL down to one each
  assert.deepEqual(draftProblems(f)[0], { text: "These two core corners have only one extension each, but each has to have two", slots: [at(1, 1, 1), at(-1, 1, 1)].sort((a, b) => a - b) });
});

test("edit: tapping a core corner turns it through its three ways, and a core single edge over", () => {
  const d = draft();
  const UFR = at(1, 1, 1);
  const ways = [bareOf(d, UFR)];
  for (let i = 0; i < 3; i++) {
    assert.ok(draftTap(d, UFR), "the tap turns the corner");
    ways.push(bareOf(d, UFR));
  }
  assert.deepEqual(ways, [[at(1, 2, 1)], [at(2, 1, 1)], [at(1, 1, 2)], [at(1, 2, 1)]], "clockwise as seen from outside: up, right, front, and back up");
  const UF = at(0, 1, 1);
  draftTap(d, UF);
  assert.deepEqual(bareOf(d, UF), [at(0, 1, 2)], "the edge's bare side goes from up to front");
  assert.equal(draftTap(d, at(1, 0, 1)), null, "a core edge with two extension cubelets has nothing to turn to");
  assert.equal(draftTap(d, at(0, 0, 1)), null, "a tap on a center does nothing");
});

test("edit: a cubelet comes or goes alone, and the shape may be wrong meanwhile", () => {
  const d = draft();
  let paint = visibleColors(d.shape) as (Color | undefined)[];
  const tap = draftTap(d, at(2, 0, 1))!; // Rx.F, one of two on the FR double edge
  assert.deepEqual(tap.carries, [], "nothing moves");
  assert.deepEqual(tap.unpaint.filter((f) => Math.floor(f / 6) === at(1, 0, 1)), [at(1, 0, 1) * 6 + R], "of the core edge, only the face it bares");
  paint = repaint(paint, tap);
  assert.equal(paint[at(1, 0, 1) * 6 + R], "R", "its outward color falls onto the core edge it bared");
  assert.equal(paint[at(2, 0, 0) * 6 + F], "G", "and its front's green onto the extension center behind it");
  assert.equal(paint[at(2, 0, 1) * 6 + R], undefined);
  assert.equal(paint[at(0, 1, 2) * 6 + F], "G", "the others keep their paint");
  assert.equal(draftColors(d, paint)[at(1, 0, 1) * 6 + R], "R", "and the core edge shows it");
  assert.deepEqual([...d.removed], [at(2, 0, 1)]);
  assert.deepEqual(texts(d), ["Only three core edges have two extensions, but there must be four"]);
  assert.ok(draftSpots(d).includes(at(2, 0, 1)), "its spot is one a tap can fill again");
  paint = repaint(paint, draftTap(d, at(0, 2, 1))!); // the bare top of the UF single edge gets a cubelet
  assert.equal(paint[at(0, 2, 1) * 6 + U], "W", "a cubelet that comes takes the color of the sticker it covers");
  assert.equal(paint[at(0, 1, 1) * 6 + U], undefined);
  assert.equal(paint[at(0, 2, 1) * 6 + F], undefined, "its other stickers are not painted yet");
  assert.deepEqual(texts(d), [], "four double edges again");
  assert.equal(d.removed.size + d.added.size, 0, "a shape the puzzle can have is made of real cubelets at once");
  assert.ok(draftFilled(d, at(0, 2, 1)) && !draftFilled(d, at(2, 0, 1)));
  assert.equal(fitColors(d.shape, visibleColors(d.shape)).level, "reachable", "what it shows can be reached");
  // One too many double edges names them all.
  draftTap(d, at(0, 2, -1));
  const [five] = draftProblems(d);
  assert.equal(five.text, "Five core edges have two extensions, but there can be only four");
  assert.equal(five.slots.length, 5);
});

test("edit: extension centers come and go alone, and the two faces without one must be opposite", () => {
  const d = draft();
  draftTap(d, at(2, 0, 0)); // Rx
  assert.deepEqual(texts(d), ["Only three centers have an extension center, but there must be four"]);
  draftTap(d, at(0, 2, 0)); // one over the up center
  assert.deepEqual(texts(d), ["The two centers without an extension center must be opposite each other"]);
  assert.equal(draftProblems(d)[0].slots.length, 2, "the two centers are named");
  draftTap(d, at(0, 2, 0));
  draftTap(d, at(-2, 0, 0)); // Lx: now up, down, left and right are bare, and front and back have theirs
  draftTap(d, at(0, 2, 0));
  draftTap(d, at(0, -2, 0));
  assert.deepEqual(texts(d), []);
  assert.equal(d.removed.size + d.added.size, 0);
  assert.equal(CUBELETS[d.shape.occ[at(0, 2, 0)]].kind, "extCenter", "a real extension center is there");
});

test("edit: the stickers a shape shows follow from each cubelet's own spot, right or wrong", () => {
  for (const st of [State.solved(), after("F f R U"), after("M R S' x")]) {
    const d = draft(st);
    assert.deepEqual(draftColors(d, visibleColors(st) as (Color | undefined)[]), visibleColors(st), "a real shape shows what the position shows");
  }
  const d = draft();
  draftTap(d, at(0, 2, 1)); // a cubelet over the UF single edge: the shape is wrong
  const shows = draftColors(d, []);
  assert.equal(shows[at(0, 2, 1) * 6 + U], UNPAINTED, "the cubelet put in shows a sticker on top, not painted yet");
  assert.equal(shows[at(0, 2, 1) * 6 + F], UNPAINTED);
  assert.equal(shows[at(0, 1, 1) * 6 + U], undefined, "the core edge under it is covered");
  assert.equal(shows[at(0, 1, 1) * 6 + F], undefined, "a core edge with cubelets on both sides has no sticker showing");
  const paint: (Color | undefined)[] = [];
  paint[at(0, 2, 1) * 6 + U] = "W";
  assert.equal(draftColors(d, paint)[at(0, 2, 1) * 6 + U], "W", "a sticker can be painted while the shape is wrong");
});

test("edit: a core cubelet's sticker can be painted where it is drawn, whatever the shape", () => {
  // A core corner left with one extension has two bare sides; its sticker is drawn on top, so it is on top.
  const d = draft();
  draftTap(d, at(1, 1, 2)); // the front extension's up-right cubelet taken off the UFR core corner
  const shows = draftColors(d, []);
  assert.equal(shows[at(1, 1, 1) * 6 + U], UNPAINTED, "the core corner's sticker, on top as drawn, can be painted");
  assert.equal(shows[at(1, 1, 1) * 6 + F], null, "its other bare side is plastic");
  const paint: (Color | undefined)[] = [];
  paint[at(1, 1, 1) * 6 + U] = "Y";
  assert.equal(draftColors(d, paint)[at(1, 1, 1) * 6 + U], "Y", "and takes the paint");
});

test("edit: a sticker not painted yet fits any color", () => {
  const st = after("R U");
  const colors = visibleColors(st);
  const some = colors.map((c, i) => (c && i % 5 === 0 ? UNPAINTED : c));
  const fit = fitColors(st, some);
  assert.equal(fit.level, "reachable");
  assert.ok(fit.state!.equals(st), "the unpainted stickers take the colors of the position");
  const wrong = some.slice();
  const i = wrong.findIndex((c, k) => c === "W" && k % 5 !== 0);
  wrong[i] = "Y";
  const j = wrong.findIndex((c, k) => c && c !== UNPAINTED && k !== i && Math.floor(k / 6) === Math.floor(i / 6));
  if (j >= 0) assert.notEqual(fitColors(st, wrong).level, "reachable", "a wrong color still shows up beside unpainted ones");
});

test("edit: any shape is reached by tapping only what differs, and then fits what it shows", () => {
  const rnd = (() => {
    let seed = 11;
    return (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), (seed >>> 8) % n);
  })();
  const scramble = () => {
    const st = State.solved();
    for (let i = 0; i < 25; i++) applyTurn(st, { def: rnd(MOVE_DEFS.length), amount: (1 + rnd(3)) as 1 | 2 | 3 });
    return st;
  };
  for (let n = 0; n < 30; n++) {
    const [from, to] = [scramble(), scramble()];
    const d = draft(from);
    for (let guard = 0; guard < 200; guard++) {
      const wrong = OUTER.filter((s) => draftFilled(d, s) !== to.occ[s] >= 0 && (draftFilled(d, s) || draftSpots(d).includes(s)));
      if (!wrong.length) break;
      assert.ok(draftTap(d, wrong[rnd(wrong.length)]), "every tap on a spot that differs does something");
    }
    assert.equal(d.removed.size + d.added.size, 0, `scramble ${n}: the shape is right, made of real cubelets`);
    assert.equal(d.shape.shapeKey(), to.shapeKey(), `scramble ${n}: the shape is the one wanted`);
    const fit = fitColors(d.shape, visibleColors(to));
    assert.equal(fit.level, "reachable", `scramble ${n}: the real colors fit (${fit.problems[0]?.text})`);
  }
  assert.ok(solvedPaint(draft()).filter(Boolean).length > 0);
});
