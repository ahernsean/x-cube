// State codes: X2 (44 letters, every reachable position, with a check) and X1 (read only,
// and written for positions turns can't reach).
import assert from "node:assert/strict";
import { test } from "node:test";
import { KNOWN_ALGORITHMS } from "../src/core/algorithms.ts";
import { axisRotation, NUM_ROT, ROT_DIR, ROT_INV, ROT_MUL, ROTATIONS } from "../src/core/geometry.ts";
import { parseAlg } from "../src/core/notation.ts";
import { CUBELETS, MOVE_DEFS, NUM_SLOTS, SLOT_NEIGHBOR, SLOT_POS, State, applyTurn, applyTurns, blockedReason } from "../src/core/puzzle.ts";
import {
  CHECK_PRIME,
  X2_POSITIONS,
  decodeState,
  encodeState,
  encodeX1,
  encodeX2,
  positionAt,
  positionIndex,
  unreachableReason,
} from "../src/core/serialize.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}
const pick = (rand: () => number, n: number) => Math.floor(rand() * n);

/** Random legal turns of every kind, rotations included. */
function scrambled(rand: () => number, n: number): State {
  const st = State.solved();
  for (let i = 0; i < n; i++) {
    let t;
    do t = { def: pick(rand, MOVE_DEFS.length), amount: (1 + pick(rand, 3)) as 1 | 2 | 3 };
    while (blockedReason(st, t));
    applyTurn(st, t);
  }
  return st;
}
const after = (alg: string) => {
  const st = State.solved();
  assert.ok(applyTurns(st, parseAlg(alg)).ok);
  return st;
};
const randomIndex = (rand: () => number) => {
  let r = 0n;
  for (let k = 0; k < 6; k++) r = (r << 32n) | BigInt(pick(rand, 2 ** 32));
  return r % X2_POSITIONS;
};
const letters = (code: string) => code.replace(/ /g, "");
const withLetter = (code: string, i: number, ch: string) => code.slice(0, i) + ch + code.slice(i + 1);
const refused = (code: string) => {
  try {
    decodeState(code);
    return false;
  } catch {
    return true;
  }
};

test("X2: 44 letters in groups of 4, and every scrambled position comes back exactly", () => {
  const rand = rng(11);
  for (let i = 0; i < 150; i++) {
    const st = scrambled(rand, 1 + pick(rand, 300));
    const code = encodeState(st);
    assert.match(code, /^[A-Z]{4}( [A-Z]{4}){10}$/);
    assert.ok(decodeState(code).equals(st), code);
  }
});

test("X2: the index is a one-to-one numbering of positions, solved is 0", () => {
  assert.equal(positionIndex(State.solved()), 0n);
  assert.ok(positionAt(0n).equals(State.solved()));
  const rand = rng(12);
  for (let i = 0; i < 150; i++) {
    const n = randomIndex(rand);
    assert.equal(positionIndex(positionAt(n)), n);
  }
  assert.throws(() => positionAt(X2_POSITIONS), RangeError);
});

test("X2: twins and center spins that look the same get different codes", () => {
  // The up center turned half way and everything else home: looks solved.
  const spun = after("(U R L U2 R' L')2");
  assert.equal(spun.appearanceKey(), State.solved().appearanceKey());
  assert.ok(!spun.equals(State.solved()));
  assert.notEqual(encodeState(spun), encodeState(State.solved()));
  assert.ok(decodeState(encodeState(spun)).equals(spun));
});

// Schreier-Sims: the order of a permutation group given by generators.
function groupOrder(deg: number, gens: Int32Array[]): bigint {
  const ident = () => Int32Array.from({ length: deg }, (_, i) => i);
  const mul = (a: Int32Array, b: Int32Array) => a.map((x) => b[x]);
  const inv = (a: Int32Array) => {
    const r = new Int32Array(deg);
    a.forEach((x, i) => (r[x] = i));
    return r;
  };
  const isId = (a: Int32Array) => a.every((x, i) => x === i);
  interface Level {
    base: number;
    orbit: number[];
    transv: Map<number, Int32Array>;
    gens: Int32Array[];
    done: Set<number>;
  }
  const levels: Level[] = [];
  const sift = (g: Int32Array, from: number) => {
    for (let l = from; l < levels.length; l++) {
      const t = levels[l].transv.get(g[levels[l].base]);
      if (!t) return { g, l };
      g = mul(g, inv(t));
    }
    return { g, l: levels.length };
  };
  const update = (l: number) => {
    const L = levels[l];
    for (let i = 0; i < L.orbit.length; i++)
      for (const s of L.gens) {
        const q = s[L.orbit[i]];
        if (!L.transv.has(q)) {
          L.transv.set(q, mul(L.transv.get(L.orbit[i])!, s));
          L.orbit.push(q);
        }
      }
    for (let i = 0; i < L.orbit.length; i++)
      L.gens.forEach((s, gi) => {
        const p = L.orbit[i];
        if (L.done.has(p * 4096 + gi)) return;
        L.done.add(p * 4096 + gi);
        const sg = mul(mul(L.transv.get(p)!, s), inv(L.transv.get(s[p])!));
        if (!isId(sg)) add(sg, l + 1);
      });
  };
  const add = (g: Int32Array, from: number) => {
    const r = sift(g, from);
    if (isId(r.g)) return;
    if (r.l === levels.length) {
      const b = r.g.findIndex((x, i) => x !== i);
      levels.push({ base: b, orbit: [b], transv: new Map([[b, ident()]]), gens: [], done: new Set() });
    }
    for (let k = r.l; k >= from; k--) {
      levels[k].gens.push(r.g);
      update(k);
    }
  };
  for (const g of gens) add(g, 0);
  return levels.reduce((o, L) => o * BigInt(L.orbit.length), 1n);
}

test("X2: the number of indexes is exactly the number of reachable positions", () => {
  // Reachable positions = core positions (inner turns, slices, rotations) times the
  // arrangements of outer cubelets on their sites (outer turns), since inner turns leave
  // sites alone. Both groups are built from the engine's own turns.
  const isCore = (s: number) => SLOT_POS[s].every((c) => Math.abs(c) < 2);
  const core = [...Array(NUM_SLOTS).keys()].filter(isCore);
  const coreIdx = new Map(core.map((s, i) => [s, i]));
  const coreGens = MOVE_DEFS.filter((d) => d.kind !== "outer").map((d) => {
    const g = new Int32Array(core.length * NUM_ROT);
    for (const s of core)
      for (let r = 0; r < NUM_ROT; r++) {
        const st = State.solved();
        const id = st.occ[s];
        st.ori[s] = r;
        applyTurn(st, { def: MOVE_DEFS.indexOf(d), amount: 1 });
        const to = st.occ.indexOf(id);
        g[coreIdx.get(s)! * NUM_ROT + r] = coreIdx.get(to)! * NUM_ROT + st.ori[to];
      }
    return g;
  });
  const coreOrder = groupOrder(core.length * NUM_ROT, coreGens);

  // Outer cubelets as (site, rotation relative to the core cubelet behind it).
  const sites = (st: State) => {
    const m = new Map<number, { site: number; rel: number }>();
    for (let s = 0; s < NUM_SLOTS; s++) {
      const id = st.occ[s];
      if (id < 0 || isCore(s)) continue;
      const axis = SLOT_POS[s].findIndex((c) => Math.abs(c) === 2);
      const d = axis * 2 + (SLOT_POS[s][axis] > 0 ? 0 : 1);
      const inward = SLOT_NEIGHBOR[s * 6 + (d ^ 1)];
      const k = st.occ[inward];
      const q = st.ori[inward];
      const local = ROT_DIR[ROT_INV[q] * 6 + d];
      m.set(id, { site: k * 6 + local, rel: ROT_MUL[ROT_INV[q] * NUM_ROT + st.ori[s]] });
    }
    return m;
  };
  const home = sites(State.solved());
  const siteList = [...new Set([...home.values()].map((v) => v.site))];
  const siteIdx = new Map(siteList.map((k, i) => [k, i]));
  const deg = siteList.length * NUM_ROT;
  const outerGens = new Map<string, Int32Array>();
  const rand = rng(13);
  for (let w = 0; w < 60; w++) {
    const st = State.solved();
    for (let i = 0; i < 300; i++) {
      let t;
      do t = { def: pick(rand, MOVE_DEFS.length), amount: (1 + pick(rand, 3)) as 1 | 2 | 3 };
      while (blockedReason(st, t));
      const before = MOVE_DEFS[t.def].kind === "outer" ? sites(st) : null;
      applyTurn(st, t);
      if (!before) continue;
      const now = sites(st);
      const g = new Int32Array(deg);
      for (const [id, b] of before) {
        const a = now.get(id)!;
        const m = ROT_MUL[a.rel * NUM_ROT + ROT_INV[b.rel]];
        for (let r = 0; r < NUM_ROT; r++) g[siteIdx.get(b.site)! * NUM_ROT + r] = siteIdx.get(a.site)! * NUM_ROT + ROT_MUL[m * NUM_ROT + r];
      }
      outerGens.set(g.join(), g);
    }
  }
  const outerOrder = groupOrder(deg, [...outerGens.values()]);
  assert.equal(coreOrder * outerOrder, X2_POSITIONS);
});


test("X2 check: the prime is the largest that fits, and its guarantees hold", () => {
  const isPrime = (n: bigint) => {
    for (let d = 2n; d * d <= n; d++) if (n % d === 0n) return false;
    return n > 1n;
  };
  assert.ok(isPrime(CHECK_PRIME));
  for (let p = CHECK_PRIME + 1n; p <= 26n ** 44n / X2_POSITIONS; p++) assert.ok(!isPrime(p), `${p} is a larger prime that fits`);
  assert.ok((X2_POSITIONS - 1n) * CHECK_PRIME + CHECK_PRIME - 1n < 26n ** 44n, "every value fits in 44 letters");
  // Any change confined to 6 neighboring letters alters the value by less than 26^6 < p
  // times a power of 26, which p can't divide.
  assert.ok(26n ** 6n < CHECK_PRIME);
  // A swap of letters d apart alters it by a multiple of 26^d - 1; p divides none for d < 44.
  let x = 1n;
  for (let d = 1; d < 44; d++) {
    x = (x * 26n) % CHECK_PRIME;
    assert.notEqual(x, 1n, `26^${d} = 1 mod p`);
  }
});

test("X2 check: typos are refused", () => {
  const rand = rng(14);
  const code = letters(encodeState(scrambled(rand, 80)));
  for (let i = 0; i < 44; i++)
    for (let c = 65; c < 91; c++) {
      const ch = String.fromCharCode(c);
      if (ch !== code[i]) assert.ok(refused(withLetter(code, i, ch)), `one wrong letter at ${i}`);
    }
  for (let i = 0; i < 44; i++)
    for (let j = i + 1; j < 44; j++) {
      if (code[i] === code[j]) continue;
      assert.ok(refused(withLetter(withLetter(code, i, code[j]), j, code[i])), `swap of letters ${i} and ${j}`);
    }
  for (let n = 0; n < 3000; n++) {
    const start = pick(rand, 39);
    let bad = code;
    for (let i = start; i < start + 6; i++) if (rand() < 0.6) bad = withLetter(bad, i, String.fromCharCode(65 + pick(rand, 26)));
    if (bad !== code) assert.ok(refused(bad), "changes within 6 neighboring letters");
  }
  assert.ok(refused(code.slice(1)) && refused(code + "A"), "a missing or extra letter");
});

test("X2 input: case, spaces, dashes and an X2: prefix are ignored; other errors say what is wrong", () => {
  const st = after("F f U R");
  const code = encodeState(st);
  for (const form of [code.toLowerCase(), letters(code), code.replace(/ /g, "-"), "X2: " + code, `\n  ${code}  \n`])
    assert.ok(decodeState(form).equals(st), form);
  assert.throws(() => decodeState(code.slice(0, -1)), /has 44 letters, this has 43/);
  assert.throws(() => decodeState(withLetter(code, 0, "1")), /"1" is not a letter/);
  const wrong = withLetter(code, 0, code[0] === "A" ? "B" : "A");
  assert.throws(() => decodeState(wrong), /typo/);
  assert.throws(() => decodeState("Y1:" + code), /not an X-Cube state code/);
});

test("X1 codes still read, and convert to X2 when turns can reach them", () => {
  // The owner's saved position "One edge flipped".
  const owner = decodeState(
    "X1:7k4qIb6h5hYwwc2kTc......qhphZcMaNalsskthukFm0hzhkrWaXa............chbhaaor8pgefeendsDjVrjcihhh........vb..GvnaLdKh1rOkPkQqRcHfAjUryaxr3p......9e..CoBqEhScmmruJm",
  );
  assert.equal(unreachableReason(owner), null);
  assert.ok(decodeState(encodeX2(owner)).equals(owner));
  const st = scrambled(rng(15), 120);
  assert.ok(decodeState(encodeX1(st)).equals(st));
  assert.equal(encodeState(decodeState(encodeX1(st))), encodeX2(st));
});

test("positions turns can't reach: refused by X2 with a reason, kept as X1", () => {
  const swapTwins = State.solved();
  const [a, b] = CUBELETS.filter((c) => c.kind === "coreCorner" && c.stickers[2]).slice(0, 2).map((c) => swapTwins.occ.indexOf(c.id));
  [swapTwins.occ[a], swapTwins.occ[b]] = [swapTwins.occ[b], swapTwins.occ[a]];
  // Each keeps white up: turned about the vertical axis onto the other's spot.
  for (const s of [a, b]) {
    const from = SLOT_POS[CUBELETS[swapTwins.occ[s]].home];
    swapTwins.ori[s] = [0, 1, 2, 3].map((k) => axisRotation(1, k)).find((r) => positionsMatchTo(r, from, SLOT_POS[s]))!;
  }
  assert.match(unreachableReason(swapTwins)!, /swapped/);
  assert.throws(() => encodeX2(swapTwins), /swapped/);
  assert.equal(encodeState(swapTwins), encodeX1(swapTwins));
  assert.ok(decodeState(encodeState(swapTwins)).equals(swapTwins));

  const twisted = State.solved();
  const s = CUBELETS.find((c) => c.kind === "coreCorner")!.home;
  twisted.ori[s] = [...Array(NUM_ROT).keys()].find((r) => r !== 0 && positionsMatch(r, s))!;
  assert.match(unreachableReason(twisted)!, /twisted/);
});

/** Does rotation r carry position p to q? */
function positionsMatchTo(r: number, p: readonly number[], q: readonly number[]): boolean {
  const m = ROTATIONS[r];
  return [0, 1, 2].every((i) => m[i * 3] * p[0] + m[i * 3 + 1] * p[1] + m[i * 3 + 2] * p[2] === q[i]);
}
const positionsMatch = (r: number, s: number) => positionsMatchTo(r, SLOT_POS[s], SLOT_POS[s]);

test("every known algorithm starts from a position turns can reach, so it has an X2 code", () => {
  for (const a of KNOWN_ALGORITHMS) assert.equal(unreachableReason(a.start()), null, a.name);
});
