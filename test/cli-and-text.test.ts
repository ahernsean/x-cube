// The command-line driver (src/cli/xc.ts), the text views it prints, and the smaller
// engine helpers that the puzzle tests don't reach.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { faceView, netView, statusLine } from "../src/core/analyze.ts";
import { all, looksLike, shapeLike } from "../src/core/goals.ts";
import { formatAlg, parseAlg, simplify } from "../src/core/notation.ts";
import { CUBELETS, NUM_SLOTS, State, applyTurns } from "../src/core/puzzle.ts";
import { search } from "../src/core/search.ts";
import { decodeState, encodeState, encodeX1 } from "../src/core/serialize.ts";

const after = (alg: string, from = State.solved()) => {
  const st = from.clone();
  assert.ok(applyTurns(st, parseAlg(alg)).ok);
  return st;
};

/** Runs the CLI; returns its exit status and output. */
const xc = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["src/cli/xc.ts", ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

test("cli: show prints the status, flat view and effect of Baum's edge 3-cycle", () => {
  const r = xc("show", "R' S' R b R' S R b'");
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^alg: R' S' R b R' S R b' {2}\(8 turns\)$/m);
  assert.match(r.out, /^X shape \| outer turns: r l u\(0\/9\) d\(0\/9\) f b$/m);
  assert.ok(r.out.includes(netView(after("R' S' R b R' S R b'"))), "prints the flat view of the result");
  assert.match(r.out, /^cubelets moved: 3$/m);
  assert.equal((r.out.match(/^ {2}cycle: /gm) ?? []).length, 1);
});

test("cli: steps prints a status line per turn, stopping at a refused turn", () => {
  const r = xc("steps", "R f U");
  assert.equal(r.status, 0, r.err);
  const lines = r.out.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ {2}1 R {3}not X shape/);
  assert.match(lines[1], /^ {2}2 f {3}BLOCKED: .*6\/9/);
});

test("cli: solve prints the steps from a position to solved", () => {
  const r = xc("solve", "R2 U r");
  assert.equal(r.status, 0);
  assert.match(r.out, /^ 1 core +\S/m);
  assert.match(r.out, /\d+ turns in \d+ steps?\n$/);
  assert.match(xc("solve", "").out, /already solved/);
});

test("cli: effect says the corner 3-cycle moves 3 cubelets and prints no flat view", () => {
  const r = xc("effect", "[R' F' R, b]");
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^cubelets moved: 3$/m);
  assert.ok(!r.out.includes("    L          F"), "effect has no flat view");
});

test("cli: order says R U looks like the start again after 105 repetitions, and not before", () => {
  const r = xc("order", "R U");
  assert.equal(r.status, 0, r.err);
  const n = Number(/after (\d+) repetitions/.exec(r.out)?.[1]);
  assert.equal(n, 105);
  const start = State.solved().appearanceKey();
  assert.equal(after(`(R U)${n}`).appearanceKey(), start);
  assert.notEqual(after(`(R U)${n - 1}`).appearanceKey(), start);
});

test("cli: encode, then show --state, matches show --from", () => {
  const enc = xc("encode", "R U");
  assert.equal(enc.status, 0, enc.err);
  const [code, shape] = enc.out.trim().split("\n");
  assert.equal(code, encodeState(after("R U")));
  assert.equal(shape, "(not X shape)");
  const fromState = xc("show", "F", "--state", code);
  const fromSetup = xc("show", "F", "--from", "R U");
  assert.equal(fromState.status, 0, fromState.err);
  assert.equal(fromState.out, fromSetup.out);
});

test("cli: refused setup, unknown command and no command exit with an error", () => {
  const setup = xc("show", "U", "--from", "R f");
  assert.equal(setup.status, 1);
  assert.match(setup.err, /^setup failed: /);
  const unknown = xc("frobnicate", "R");
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /unknown command frobnicate/);
  const none = xc();
  assert.equal(none.status, 1);
  assert.match(none.err, /^usage: /);
});

test("text views: face rows, the whole net, and the status line", () => {
  const solved = State.solved();
  assert.deepEqual(faceView(solved, 2), [".WWW.", "WWWWW", "WWWWW", "WWWWW", ".WWW."]); // U
  assert.deepEqual(faceView(solved, 4), [".....", "GGGGG", "GGGGG", "GGGGG", "....."]); // F
  const net = netView(solved).split("\n");
  assert.equal(net.length, 18); // U label, 5 rows, L F R B labels, 5 rows, D label, 5 rows
  assert.equal(net.filter((l) => l === "O O O O O  G G G G G  R R R R R  B B B B B").length, 3, "three middle rows of L F R B");
  assert.equal(statusLine(solved), "X shape | SOLVED | outer turns: r l u(0/9) d(0/9) f b");
  assert.equal(statusLine(after("R")), "not X shape | outer turns: r l u(3/9) d(3/9) f(6/9) b(6/9)");
  assert.equal(statusLine(after("x")), "X shape (rotated) | SOLVED | outer turns: r l u d f(0/9) b(0/9)");
});

test("notation: simplify merges and cancels neighboring turns of the same move", () => {
  const s = (alg: string) => formatAlg(simplify(parseAlg(alg)));
  assert.equal(s("R R"), "R2");
  assert.equal(s("R R R"), "R'");
  assert.equal(s("R R'"), "");
  assert.equal(s("R U U' R'"), "");
  assert.equal(s("R2 R2 U F"), "U F");
});

test("goals: shapeLike compares only the shape; all needs every goal", () => {
  const solved = State.solved();
  assert.ok(shapeLike(solved)(after("U R2")), "U and R2 keep the X shape");
  assert.ok(!shapeLike(solved)(after("R")));
  assert.ok(all(shapeLike(solved), looksLike(solved))(solved));
  assert.ok(!all(shapeLike(solved), looksLike(solved))(after("U")), "same shape, different look");
});

test("search: stops at its node limit and says the search was incomplete", () => {
  const target = after("R U R' U' F");
  const r = search(State.solved(), looksLike(target), { maxDepth: 6, nodeLimit: 50 });
  assert.equal(r.complete, false);
  assert.deepEqual(r.solutions, []);
  assert.ok(r.nodes <= 51);
});

test("state: appearanceKey makes look-alike twins compare equal, other cubelets don't", () => {
  const solved = State.solved();
  const swapped = (kind: string, sameColor: boolean) => {
    const st = solved.clone();
    const [a, b] = CUBELETS.filter((c) => c.kind === kind && (!sameColor || c.stickers.join() === CUBELETS.find((x) => x.kind === kind)!.stickers.join()))
      .slice(0, 2)
      .map((c) => st.occ.indexOf(c.id));
    [st.occ[a], st.occ[b]] = [st.occ[b], st.occ[a]];
    return st;
  };
  const twins = swapped("coreCorner", true);
  assert.notEqual(encodeState(twins), encodeState(solved));
  assert.equal(twins.appearanceKey(), solved.appearanceKey());
  assert.notEqual(swapped("outerEdge", false).appearanceKey(), solved.appearanceKey());
});

test("state codes: malformed X1 codes are refused with a reason", () => {
  const good = encodeX1(State.solved());
  assert.throws(() => decodeState("Y1:" + good.slice(3)), /not an X-Cube state code/);
  assert.throws(() => decodeState(good.slice(0, -2)), /wrong length/);
  assert.throws(() => decodeState(good.slice(0, 3) + "!a" + good.slice(5)), /bad entry at slot 0/);
  assert.throws(() => decodeState(good.slice(0, 3) + good[3] + "z" + good.slice(5)), /bad entry at slot 0/);
  const firstFilled = [...Array(NUM_SLOTS).keys()].find((s) => good[3 + 2 * s] !== ".")!;
  const secondFilled = [...Array(NUM_SLOTS).keys()].find((s) => s > firstFilled && good[3 + 2 * s] !== ".")!;
  const dup = good.slice(0, 3 + 2 * secondFilled) + good.slice(3 + 2 * firstFilled, 5 + 2 * firstFilled) + good.slice(5 + 2 * secondFilled);
  assert.throws(() => decodeState(dup), /appears twice/);
  const missing = good.slice(0, 3 + 2 * firstFilled) + ".." + good.slice(5 + 2 * firstFilled);
  assert.throws(() => decodeState(missing), /state has 61 cubelets, expected 62/);
  assert.equal(encodeX1(decodeState("  " + good + "\n")), good, "surrounding whitespace is ignored");
});
