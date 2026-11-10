// Text encodings of a state, for saving, sharing and typing by hand.
//
// X2 (written by encodeState): 44 letters A-Z in groups of 4, for example
//   "KOBR OMQX DWGW SCPY DMHJ LJLN WVLK WBDH RYWZ QQIS MZBR".
// Case, spaces, dashes and a leading "X2:" are ignored on input. It holds every position
// that turns can reach, losslessly (look-alike twins and center spins included), and
// nothing else. The letters are one base-26 number:
//   value = mix(index) * CHECK_PRIME + CHECK_REMAINDER
// where index (0..N-1) numbers the reachable positions (see "Index" below) and mix is a
// fixed shuffle of 0..N-1. A code is
// accepted only if value mod CHECK_PRIME is CHECK_REMAINDER, which catches every error
// confined to 6 neighboring letters, every swap of two letters, and all but about
// 1 in 3 billion other errors. The shuffle spreads near-solved positions over the whole
// range, so their codes share no letters by pattern.
//
// X1 (read always; written only for positions turns can't reach): "X1:" followed by 80
// pairs of characters, one pair per slot in slot order. First char: cubelet id (alphabet
// below) or "." for empty. Second char: orientation a..x.
//
// Index. Every move turns a cubelet's position and its orientation by the same rotation,
// so ROTATIONS[ori] maps a cubelet's home position to its slot. A reachable position is
// then given by, in this order of mixed-radix digits:
//   - the whole-puzzle rotation that carries the six core centers home (24);
//   - with that rotation undone, the core as a supercube: corner permutation (8!),
//     corner twists (3^7), core edge permutation of the same parity as the corners
//     (12!/2), edge flips (2^11), center spins (4^5 * 2);
//   - the outer cubelets by "site": the core cubelet and its face that each one rests
//     against. Inner turns never change sites; outer turns permute them. Outer corner
//     sites (16!), outer edge sites with the parity of the corners' (16!/2), extension
//     center spins relative to the fused core center (4^3 * 2).
// The parity-fixed digits are recovered from these invariants of reachable positions:
//   twist sum = 0 (mod 3); flip sum even; corner and edge permutations of equal parity;
//   center spin sum = corner parity (mod 2); outer corner and outer edge site
//   permutations of equal parity; extension center spin sum = outer corner parity (mod 2).

import { axisRotation, matVec, NUM_ROT, ROT_DIR, ROT_INV, ROT_MUL, ROTATIONS, type Vec3 } from "./geometry.ts";
import { CUBELETS, NUM_SLOTS, SLOT_NEIGHBOR, SLOT_POS, State, slotAt, type Kind } from "./puzzle.ts";

// ---------------------------------------------------------------- X1

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ORI_ALPHABET = "abcdefghijklmnopqrstuvwx";
const X1_PREFIX = "X1:";

export function encodeX1(st: State): string {
  let out = X1_PREFIX;
  for (let s = 0; s < NUM_SLOTS; s++) {
    const id = st.occ[s];
    out += id < 0 ? ".." : ID_ALPHABET[id] + ORI_ALPHABET[st.ori[s]];
  }
  return out;
}

function decodeX1(c: string): State {
  const body = c.slice(X1_PREFIX.length);
  if (body.length !== NUM_SLOTS * 2) throw new Error("X1 state code has the wrong length");
  const st = new State();
  const seen = new Set<number>();
  for (let s = 0; s < NUM_SLOTS; s++) {
    const a = body[s * 2];
    const b = body[s * 2 + 1];
    if (a === ".") continue;
    const id = ID_ALPHABET.indexOf(a);
    const o = ORI_ALPHABET.indexOf(b);
    if (id < 0 || id >= CUBELETS.length || o < 0 || o >= NUM_ROT) throw new Error(`bad entry at slot ${s}`);
    if (seen.has(id)) throw new Error(`cubelet ${id} appears twice`);
    seen.add(id);
    st.occ[s] = id;
    st.ori[s] = o;
  }
  if (seen.size !== CUBELETS.length) throw new Error(`state has ${seen.size} cubelets, expected ${CUBELETS.length}`);
  return st;
}

// ---------------------------------------------------------------- tables

const same = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const rotate = (r: number, v: Vec3) => matVec(ROTATIONS[r], v);
const isOuterSlot = (s: number) => SLOT_POS[s].some((c) => Math.abs(c) === 2);
const nonzero = (s: number) => SLOT_POS[s].filter((c) => c !== 0).length;
const axisOf = (d: number) => d >> 1;
/** Direction of the axis a slot sticks out along (outer slots, and core centers). */
const outwardDir = (p: Vec3) => {
  const a = p.findIndex((c) => Math.abs(c) === (p.some((c) => Math.abs(c) === 2) ? 2 : 1));
  return a * 2 + (p[a] > 0 ? 0 : 1);
};
const ids = (...kinds: Kind[]) => CUBELETS.filter((c) => kinds.includes(c.kind)).map((c) => c.id);

const CORE_SLOTS = [...Array(NUM_SLOTS).keys()].filter((s) => !isOuterSlot(s));
const CORNER_SLOTS = CORE_SLOTS.filter((s) => nonzero(s) === 3);
const EDGE_SLOTS = CORE_SLOTS.filter((s) => nonzero(s) === 2);
const CORNERS = ids("coreCorner");
const EDGES = ids("singleEdge", "doubleEdge");
const CENTERS = ids("center");
const OUTER_CORNERS = ids("outerCorner");
const OUTER_EDGES = ids("outerEdge");
const EXT_CENTERS = ids("extCenter");
const U_CENTER = CENTERS.find((id) => SLOT_POS[CUBELETS[id].home][1] === 1)!;
const F_CENTER = CENTERS.find((id) => SLOT_POS[CUBELETS[id].home][2] === 1)!;

/** Rotations that carry cubelet id's home position to slot s. */
const ROTS_TO: number[][][] = CUBELETS.map((c) =>
  SLOT_POS.map((p) => [...Array(NUM_ROT).keys()].filter((r) => same(rotate(r, SLOT_POS[c.home]), p))),
);
const rotsTo = (id: number, s: number) => ROTS_TO[id][s];

/**
 * Corner twist 0..2: where the cubelet's home up/down face points, counted around the
 * corner in one fixed turning sense (y axis first).
 */
function twistOf(id: number, s: number, ori: number): number {
  const p = SLOT_POS[s];
  const cyc = p[0] * p[1] * p[2] > 0 ? [1, 0, 2] : [1, 2, 0];
  const homeY = SLOT_POS[CUBELETS[id].home][1] > 0 ? 2 : 3;
  return cyc.indexOf(axisOf(ROT_DIR[ori * 6 + homeY]));
}

/** Edge flip 0..1: whether the cubelet's main face misses the slot's main axis (y in the up and down layers, z in the middle). */
function flipOf(id: number, s: number, ori: number): number {
  const h = SLOT_POS[CUBELETS[id].home];
  const main = h[1] ? (h[1] > 0 ? 2 : 3) : h[2] > 0 ? 4 : 5;
  const slotAxis = SLOT_POS[s][1] ? 1 : 2;
  return axisOf(ROT_DIR[ori * 6 + main]) === slotAxis ? 0 : 1;
}

/** Quarter turns 0..3 of rotation r about the axis of direction d, or -1 if r is not such a turn. */
function spinOf(r: number, d: number): number {
  for (let k = 0; k < 4; k++) if (axisRotation(axisOf(d), k) === r) return k;
  return -1;
}

/** Outer sites: [core cubelet, its own face direction], ordered by the home slot of the outer cubelet on it. */
interface Site {
  core: number;
  face: number;
}
const SITE_OF_HOME = new Map<number, Site>(); // outer cubelet id -> its home site
for (const c of CUBELETS) {
  if (c.outward === null) continue;
  const inward = SLOT_NEIGHBOR[c.home * 6 + (c.outward ^ 1)];
  SITE_OF_HOME.set(c.id, { core: State.solved().occ[inward], face: c.outward });
}
const sitesOf = (cubelets: number[]) => cubelets.map((id) => SITE_OF_HOME.get(id)!);
const CORNER_SITES = sitesOf(OUTER_CORNERS);
const EDGE_SITES = sitesOf(OUTER_EDGES);
const EXT_SITES = sitesOf(EXT_CENTERS);
const siteKey = (core: number, face: number) => core * 6 + face;

// ---------------------------------------------------------------- permutation ranks

/** Lehmer digits of a permutation: d[i] = how many later entries are smaller (radix n - i). */
function lehmer(p: readonly number[]): number[] {
  return p.map((v, i) => p.slice(i + 1).filter((w) => w < v).length);
}
function fromLehmer(d: readonly number[]): number[] {
  const pool = [...Array(d.length).keys()];
  return d.map((k) => pool.splice(k, 1)[0]);
}
const parity = (p: readonly number[]) => lehmer(p).reduce((a, b) => a + b, 0) & 1;

// Mixed-radix digits, most significant first. "Free" digits are written; the rest follow from the invariants.
class Digits {
  value = 0n;
  push(digit: number, radix: number) {
    this.value = this.value * BigInt(radix) + BigInt(digit);
  }
  pushPerm(p: readonly number[], dropLast2: boolean) {
    const d = lehmer(p);
    d.forEach((x, i) => {
      const radix = p.length - i;
      if (radix > (dropLast2 ? 2 : 1)) this.push(x, radix);
    });
  }
}
class Reader {
  // Digits are read from the least significant end, so callers read fields in reverse order.
  value: bigint;
  constructor(value: bigint) {
    this.value = value;
  }
  pop(radix: number): number {
    const d = Number(this.value % BigInt(radix));
    this.value /= BigInt(radix);
    return d;
  }
  /** A permutation of n written by pushPerm; with fixParity, its parity is made `want`. */
  popPerm(n: number, fixParity: boolean, want = 0): number[] {
    const d = new Array(n).fill(0);
    for (let i = n - (fixParity ? 3 : 2); i >= 0; i--) d[i] = this.pop(n - i);
    if (fixParity) d[n - 2] = (d.reduce((a, b) => a + b, 0) & 1) ^ want;
    return fromLehmer(d);
  }
}

const fact = (n: number) => {
  let r = 1n;
  for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return r;
};
/** Number of reachable positions: the X2 index runs 0..N-1. */
export const X2_POSITIONS: bigint =
  24n * fact(8) * 3n ** 7n * (fact(12) / 2n) * 2n ** 11n * 4n ** 5n * 2n * fact(16) * (fact(16) / 2n) * 4n ** 3n * 2n;

// ---------------------------------------------------------------- position <-> index

/** Why a state can't be reached by turning, or null if it can. */
export function unreachableReason(st: State): string | null {
  try {
    positionIndex(st);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The X2 index of a state; throws with the reason if turns can't reach it. */
export function positionIndex(st: State): bigint {
  const slotOf = new Int16Array(CUBELETS.length).fill(-1);
  for (let s = 0; s < NUM_SLOTS; s++) {
    const id = st.occ[s];
    if (id < 0) continue;
    if (!rotsTo(id, s).includes(st.ori[s])) throw new Error(`cubelet in ${s} is turned in a way no move turns it`);
    slotOf[id] = s;
  }
  if (slotOf.some((s) => s < 0)) throw new Error("a cubelet is missing");

  // Whole-puzzle rotation, from the up and front centers.
  const o = [...Array(NUM_ROT).keys()].find(
    (r) => same(rotate(r, [0, 1, 0]), SLOT_POS[slotOf[U_CENTER]]) && same(rotate(r, [0, 0, 1]), SLOT_POS[slotOf[F_CENTER]]),
  );
  if (o === undefined) throw new Error("the core centers are not in a turnable arrangement");
  const oi = ROT_INV[o];
  const normSlot = (id: number) => slotAt(rotate(oi, SLOT_POS[slotOf[id]]));
  const normOri = (id: number) => ROT_MUL[oi * NUM_ROT + st.ori[slotOf[id]]];

  const corner = new Array(8);
  const twists: number[] = [];
  for (const id of CORNERS) {
    const s = normSlot(id);
    const i = CORNER_SLOTS.indexOf(s);
    corner[i] = CORNERS.indexOf(id);
    twists[i] = twistOf(id, s, normOri(id));
  }
  const edge = new Array(12);
  const flips: number[] = [];
  for (const id of EDGES) {
    const s = normSlot(id);
    const i = EDGE_SLOTS.indexOf(s);
    edge[i] = EDGES.indexOf(id);
    flips[i] = flipOf(id, s, normOri(id));
  }
  const spins = CENTERS.map((id) => spinOf(normOri(id), outwardDir(SLOT_POS[CUBELETS[id].home])));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  if (sum(twists) % 3) throw new Error("the core corners are twisted");
  if (sum(flips) % 2) throw new Error("a core edge is flipped");
  if (parity(corner) !== parity(edge)) throw new Error("two core cubelets are swapped");
  if (spins.includes(-1) || (sum(spins) & 1) !== parity(corner)) throw new Error("a core center is turned");

  const siteIndex = new Map<number, number>();
  const where = (id: number) => {
    const s = slotOf[id];
    const d = outwardDir(SLOT_POS[s]);
    const core = st.occ[SLOT_NEIGHBOR[s * 6 + (d ^ 1)]];
    return siteKey(core, ROT_DIR[ROT_INV[st.ori[slotOf[core]]] * 6 + d]);
  };
  CORNER_SITES.forEach((x, i) => siteIndex.set(siteKey(x.core, x.face), i));
  EDGE_SITES.forEach((x, i) => siteIndex.set(siteKey(x.core, x.face), 100 + i));
  const sitePerm = (cubelets: number[], base: number) => {
    const p = new Array(16);
    cubelets.forEach((id, j) => {
      const i = (siteIndex.get(where(id)) ?? -1) - base;
      if (i < 0 || i >= 16 || p[i] !== undefined) throw new Error("an outer cubelet is not against a matching core cubelet");
      p[i] = j;
    });
    return p;
  };
  const oc = sitePerm(OUTER_CORNERS, 0);
  const oe = sitePerm(OUTER_EDGES, 100);
  const extSpins = EXT_CENTERS.map((id, i) => {
    const site = EXT_SITES[i];
    if (where(id) !== siteKey(site.core, site.face)) throw new Error("an extension center is off its core center");
    return spinOf(ROT_MUL[ROT_INV[st.ori[slotOf[site.core]]] * NUM_ROT + st.ori[slotOf[id]]], site.face);
  });

  if (parity(oc) !== parity(oe)) throw new Error("two outer cubelets are swapped");
  if (extSpins.includes(-1) || (sum(extSpins) & 1) !== parity(oc)) throw new Error("an extension center is turned");

  const out = new Digits();
  out.push(o, 24);
  out.pushPerm(corner, false);
  twists.slice(0, 7).forEach((t) => out.push(t, 3));
  out.pushPerm(edge, true);
  flips.slice(0, 11).forEach((f) => out.push(f, 2));
  spins.slice(0, 5).forEach((k) => out.push(k, 4));
  out.push(spins[5] >> 1, 2);
  out.pushPerm(oc, false);
  out.pushPerm(oe, true);
  extSpins.slice(0, 3).forEach((k) => out.push(k, 4));
  out.push(extSpins[3] >> 1, 2);
  return out.value;
}

/** The state with X2 index i (0 <= i < X2_POSITIONS). */
export function positionAt(i: bigint): State {
  if (i < 0n || i >= X2_POSITIONS) throw new RangeError("position index out of range");
  const r = new Reader(i);
  const ext3 = r.pop(2);
  const extSpins = [0, 0, 0].map(() => r.pop(4)).reverse();
  const oe0 = r.popPerm(16, true); // parity fixed below
  const oc = r.popPerm(16, false);
  const spin5 = r.pop(2);
  const spins = [0, 0, 0, 0, 0].map(() => r.pop(4)).reverse();
  const flips = new Array(11).fill(0).map(() => r.pop(2)).reverse();
  const edge0 = r.popPerm(12, true);
  const twists = new Array(7).fill(0).map(() => r.pop(3)).reverse();
  const corner = r.popPerm(8, false);
  const o = r.pop(24);

  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const cp = parity(corner);
  const edge = parity(edge0) === cp ? edge0 : [...edge0.slice(0, 10), edge0[11], edge0[10]];
  twists.push((3 - (sum(twists) % 3)) % 3);
  flips.push(sum(flips) & 1);
  spins.push(spin5 * 2 + ((sum(spins) & 1) ^ cp));
  const ocp = parity(oc);
  const oe = parity(oe0) === ocp ? oe0 : [...oe0.slice(0, 14), oe0[15], oe0[14]];
  extSpins.push(ext3 * 2 + ((sum(extSpins) & 1) ^ ocp));

  const st = new State();
  const put = (id: number, normSlot: number, normOri: number) => {
    const s = slotAt(rotate(o, SLOT_POS[normSlot]));
    st.occ[s] = id;
    st.ori[s] = ROT_MUL[o * NUM_ROT + normOri];
  };
  CORNER_SLOTS.forEach((s, i) => {
    const id = CORNERS[corner[i]];
    put(id, s, rotsTo(id, s).find((q) => twistOf(id, s, q) === twists[i])!);
  });
  EDGE_SLOTS.forEach((s, i) => {
    const id = EDGES[edge[i]];
    put(id, s, rotsTo(id, s).find((q) => flipOf(id, s, q) === flips[i])!);
  });
  CENTERS.forEach((id, i) => put(id, CUBELETS[id].home, axisRotation(axisOf(outwardDir(SLOT_POS[CUBELETS[id].home])), spins[i])));

  const coreSlot = new Map<number, number>();
  for (let s = 0; s < NUM_SLOTS; s++) if (st.occ[s] >= 0) coreSlot.set(st.occ[s], s);
  const siteSlot = (x: Site) => {
    const s = coreSlot.get(x.core)!;
    return SLOT_NEIGHBOR[s * 6 + ROT_DIR[st.ori[s] * 6 + x.face]];
  };
  const place = (id: number, s: number) => {
    st.occ[s] = id;
    st.ori[s] = rotsTo(id, s)[0];
  };
  CORNER_SITES.forEach((x, i) => place(OUTER_CORNERS[oc[i]], siteSlot(x)));
  EDGE_SITES.forEach((x, i) => place(OUTER_EDGES[oe[i]], siteSlot(x)));
  EXT_SITES.forEach((x, i) => {
    const s = siteSlot(x);
    st.occ[s] = EXT_CENTERS[i];
    st.ori[s] = ROT_MUL[st.ori[coreSlot.get(x.core)!] * NUM_ROT + axisRotation(axisOf(x.face), extSpins[i])];
  });
  return st;
}

// ---------------------------------------------------------------- X2 letters

const LETTERS = 44;
/** Largest prime no greater than 26^44 / X2_POSITIONS (checked in the tests). */
export const CHECK_PRIME = 3046917721n;
/** The remainder that marks an X-Cube code. Another puzzle can use another remainder. */
const CHECK_REMAINDER = 1n;
const N = X2_POSITIONS;
const OFFSET = (N * 414213562373095048n) / 10n ** 18n;
const FOLD = 2n ** 32n; // divides N
const gcd = (a: bigint, b: bigint): bigint => (b ? gcd(b, a % b) : a);
const MIX = (() => {
  let m = (N * 618033988749894848n) / 10n ** 18n;
  while (gcd(m, N) !== 1n) m++;
  return m;
})();
const MIX_INV = (() => {
  let [r0, r1, s0, s1] = [MIX, N, 1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return ((s0 % N) + N) % N;
})();
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
// Each round multiplies (which spreads low digits upward) and then adds the high part
// into the low 32 bits (which a multiply alone can't change for indexes with trailing zeros).
function mix(x: bigint): bigint {
  for (let round = 0; round < 2; round++) {
    x = (x * MIX + OFFSET) % N;
    x = x - (x % FOLD) + mod(x + x / FOLD, FOLD);
  }
  return x;
}
function unmix(x: bigint): bigint {
  for (let round = 0; round < 2; round++) {
    x = x - (x % FOLD) + mod(x - x / FOLD, FOLD);
    x = mod((x - OFFSET) * MIX_INV, N);
  }
  return x;
}

export function encodeX2(st: State): string {
  let v = mix(positionIndex(st)) * CHECK_PRIME + CHECK_REMAINDER;
  let s = "";
  for (let i = 0; i < LETTERS; i++) {
    s = String.fromCharCode(65 + Number(v % 26n)) + s;
    v /= 26n;
  }
  return s.replace(/(.{4})(?=.)/g, "$1 ");
}

function decodeX2(code: string): State {
  const t = code.toUpperCase().replace(/^X2:/, "").replace(/[\s-]/g, "");
  const bad = t.match(/[^A-Z]/);
  if (bad) throw new Error(`"${bad[0]}" is not a letter`);
  if (t.length !== LETTERS) throw new Error(`a state code has ${LETTERS} letters, this has ${t.length}`);
  let v = 0n;
  for (const ch of t) v = v * 26n + BigInt(ch.charCodeAt(0) - 65);
  if (v % CHECK_PRIME !== CHECK_REMAINDER) throw new Error("the code has a typo (its check doesn't match)");
  const mixed = v / CHECK_PRIME;
  if (mixed >= N) throw new Error("the code has a typo (it is out of range)");
  return positionAt(unmix(mixed));
}

// ---------------------------------------------------------------- either format

/** X2 for any position turns can reach; X1 otherwise, since X2 can't hold it. */
export function encodeState(st: State): string {
  return unreachableReason(st) === null ? encodeX2(st) : encodeX1(st);
}

/** Read an X2 or X1 code. */
export function decodeState(code: string): State {
  const c = code.trim();
  if (c.startsWith(X1_PREFIX)) return decodeX1(c);
  if (c.includes(":") && !/^x2:/i.test(c)) throw new Error("not an X-Cube state code");
  return decodeX2(c);
}
