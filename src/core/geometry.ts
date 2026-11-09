// Integer 3D geometry for the X-Cube lattice.
//
// Coordinate system (right-handed, same as three.js):
//   +x = R (right), +y = U (up), +z = F (front, toward the viewer).
// Every cubelet position has integer coordinates in -2..2.

export type Vec3 = readonly [number, number, number];
/** Row-major 3x3 integer matrix. */
export type Mat3 = readonly number[];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      r[i * 3 + j] = s;
    }
  return r;
}

export function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** +90 degree (counterclockwise when viewed from the positive end) rotations. */
const QUARTER: readonly Mat3[] = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0], // about +x
  [0, 0, 1, 0, 1, 0, -1, 0, 0], // about +y
  [0, -1, 0, 1, 0, 0, 0, 0, 1], // about +z
];

const key = (m: Mat3) => m.join(",");

/** The 24 proper rotations of the cube. Index 0 is the identity. */
export const ROTATIONS: readonly Mat3[] = (() => {
  const out: Mat3[] = [IDENTITY];
  const seen = new Set([key(IDENTITY)]);
  for (let i = 0; i < out.length; i++)
    for (const q of QUARTER) {
      const m = matMul(q, out[i]);
      if (!seen.has(key(m))) {
        seen.add(key(m));
        out.push(m);
      }
    }
  return out;
})();

export const NUM_ROT = ROTATIONS.length; // 24

const ROT_INDEX = new Map(ROTATIONS.map((m, i) => [key(m), i]));

export function rotIndex(m: Mat3): number {
  const i = ROT_INDEX.get(key(m));
  if (i === undefined) throw new Error("not a cube rotation");
  return i;
}

/** ROT_MUL[a * 24 + b] = index of ROTATIONS[a] * ROTATIONS[b] (apply b first, then a). */
export const ROT_MUL: Uint8Array = (() => {
  const t = new Uint8Array(NUM_ROT * NUM_ROT);
  for (let a = 0; a < NUM_ROT; a++)
    for (let b = 0; b < NUM_ROT; b++) t[a * NUM_ROT + b] = rotIndex(matMul(ROTATIONS[a], ROTATIONS[b]));
  return t;
})();

export const ROT_INV: Uint8Array = (() => {
  const t = new Uint8Array(NUM_ROT);
  for (let a = 0; a < NUM_ROT; a++)
    for (let b = 0; b < NUM_ROT; b++) if (ROT_MUL[a * NUM_ROT + b] === 0) t[a] = b;
  return t;
})();

/** Rotation index for `quarters` counterclockwise quarter turns about axis 0=x, 1=y, 2=z. */
export function axisRotation(axis: number, quarters: number): number {
  let m = IDENTITY;
  const q = ((quarters % 4) + 4) % 4;
  for (let i = 0; i < q; i++) m = matMul(QUARTER[axis], m);
  return rotIndex(m);
}

/** Face directions, indexed 0..5. */
export const FACE_NAMES = ["R", "L", "U", "D", "F", "B"] as const;
export type FaceName = (typeof FACE_NAMES)[number];
export const DIRS: readonly Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export function dirIndex(v: Vec3): number {
  for (let i = 0; i < 6; i++) if (DIRS[i][0] === v[0] && DIRS[i][1] === v[1] && DIRS[i][2] === v[2]) return i;
  throw new Error(`not a unit axis vector: ${v}`);
}

/** ROT_DIR[r * 6 + d] = direction index of DIRS[d] rotated by ROTATIONS[r]. */
export const ROT_DIR: Uint8Array = (() => {
  const t = new Uint8Array(NUM_ROT * 6);
  for (let r = 0; r < NUM_ROT; r++) for (let d = 0; d < 6; d++) t[r * 6 + d] = dirIndex(matVec(ROTATIONS[r], DIRS[d]));
  return t;
})();
