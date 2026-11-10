// The color editor's fitting: edited sticker colors to real cubelets (src/core/edit.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitColors, sideWords, visibleColors } from "../src/core/edit.ts";
import { parseAlg } from "../src/core/notation.ts";
import { CUBELETS, FACE_COLOR, State, applyTurns, slotAt } from "../src/core/puzzle.ts";

const [R, U, F] = [0, 2, 4];
const after = (alg: string) => {
  const st = State.solved();
  assert.ok(applyTurns(st, parseAlg(alg)).ok);
  return st;
};
const at = (x: number, y: number, z: number) => slotAt([x, y, z]);

test("edit: unedited colors fit back to the same state, in and out of shape", () => {
  for (const st of [State.solved(), after("F f R U r"), after("R' S' R b R' S R b'"), after("(R U F' L D)3")]) {
    const fit = fitColors(st, visibleColors(st));
    assert.equal(fit.level, "possible");
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
  assert.equal(fit.level, "possible");
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
  assert.deepEqual(fit.problems, [{ text: "Green extension, top edge, shows white and yellow, but white and yellow are opposite colors, never on one cubelet", slots: [at(0, 1, 2)] }]);
});

test("edit: one cubelet needed in two places is refused", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(0, 0, 2) * 6 + F] = "R"; // the front extension center painted red, like the right one
  const fit = fitColors(st, colors);
  assert.equal(fit.level, null);
  assert.equal(fit.problems.length, 1);
  // Red now shows on two centers, so the sides are named by their place instead.
  assert.equal(fit.problems[0].text, "Right extension, center, and front extension, center, both show red. There is only one cubelet with those colors (sides named as in the Front view)");
  assert.deepEqual([...fit.problems[0].slots].sort(), [at(0, 0, 2), at(2, 0, 0)].sort());
});

test("edit: an outer cubelet turned against the outward-color rule is real cubelets, but not possible", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(0, 1, 2) * 6 + F] = "W"; // flip Fx.U in place: white out front, green on top
  colors[at(0, 1, 2) * 6 + U] = "G";
  const fit = fitColors(st, colors);
  assert.equal(fit.level, "cubelets");
  assert.deepEqual(fit.problems, [{ text: "Green extension, top edge: that cubelet's green sticker always faces out from the core. One of its stickers is probably painted wrong", slots: [at(0, 1, 2)] }]);
});

test("edit: problems name spots by where they are and sides by their center colors now", () => {
  const st = State.solved();
  const colors = visibleColors(st);
  colors[at(1, -1, -2) * 6 + 5] = "O"; // Bx.DR: red, yellow and orange
  assert.deepEqual(fitColors(st, colors).problems, [{ text: "Blue extension, bottom-left corner, shows yellow, red, and orange, but red and orange are opposite colors, never on one cubelet", slots: [at(1, -1, -2)] }]);
  // After a slice turn the side centers move, and the words follow them.
  const h = after("H");
  assert.deepEqual(sideWords(h, visibleColors(h)).word, ["blue", "green", "top", "bottom", "red", "orange"]);
  const twoReds = visibleColors(st);
  twoReds[at(1, 0, 2) * 6 + F] = "R";
  twoReds[at(1, 0, 2) * 6 + R] = "R";
  assert.match(fitColors(st, twoReds).problems[0].text, /^Green extension, right edge, shows red and red, but no cubelet has two red stickers$/);
});

test("edit: spots are named as seen looking at their extension, or by neighboring colors", () => {
  const st = State.solved();
  const say = (x: number, y: number, z: number, d: number, c: "W" | "Y" | "G" | "B" | "R" | "O") => {
    const colors = visibleColors(st);
    colors[at(x, y, z) * 6 + d] = c;
    return fitColors(st, colors).problems[0].text;
  };
  assert.equal(say(-1, 1, 2, F, "O"), "Green extension, top-left corner, shows white, orange, and orange, but no cubelet has two orange stickers");
  assert.equal(say(2, 1, 1, R, "B"), "Red extension, top-left corner, shows white, green, and blue, but green and blue are opposite colors, never on one cubelet");
  // Look-alike core cubelets: more painted than the puzzle has.
  assert.equal(say(1, 1, 1, U, "Y"), "Core, top corner between the red and green sides, shows yellow, but the puzzle's 4 cubelets like that are all in other spots");
});

test("edit: no cubelet has opposite colors or two of one color (the reasons problems give)", () => {
  for (const c of CUBELETS) {
    const cs = c.stickers.filter((x) => x);
    assert.equal(new Set(cs).size, cs.length);
    for (let k = 0; k < 6; k += 2) assert.ok(!(cs.includes(FACE_COLOR[k]) && cs.includes(FACE_COLOR[k + 1])), `${c.name} has opposite colors`);
  }
});
