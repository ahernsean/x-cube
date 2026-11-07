// Analysis: shape tests, solved test, effect of an algorithm, text views.

import { DIRS, FACE_NAMES, NUM_ROT, ROT_DIR, ROT_INV, ROT_MUL, ROTATIONS, matVec, type Vec3 } from "./geometry.ts";
import {
  CUBELETS,
  NUM_SLOTS,
  SLOT_NEIGHBOR,
  SLOT_POS,
  State,
  inHomeX,
  slotAt,
  slotName,
  type Color,
} from "./puzzle.ts";

// ---------------------------------------------------------------- shape

/** The three X shapes the lattice can hold, by which axis is the 3-thick ("X-face") axis. */
const X_MASKS: readonly string[] = [0, 1, 2].map((axis) => {
  let k = "";
  for (let s = 0; s < NUM_SLOTS; s++) {
    const p = SLOT_POS[s];
    // Rotate coordinates so that `axis` plays the role of y.
    const q: Vec3 = axis === 1 ? p : axis === 0 ? [p[1], p[0], p[2]] : [p[0], p[2], p[1]];
    k += inHomeX(q) ? "1" : "0";
  }
  return k;
});

/** True when the puzzle is in the home X shape (X-faces up and down). */
export function isHomeX(st: State): boolean {
  return st.shapeKey() === X_MASKS[1];
}

/** True when the puzzle is an X in any orientation. */
export function isXShape(st: State): boolean {
  const k = st.shapeKey();
  return X_MASKS.includes(k);
}

/** Exposed faces: a face is visible when the neighboring slot is empty or outside the lattice. */
export function isExposed(st: State, s: number, d: number): boolean {
  const n = SLOT_NEIGHBOR[s * 6 + d];
  if (n === -2) return false; // the solid center of the puzzle
  return n === -1 || st.occ[n] < 0;
}

/**
 * Solved = X shape, and in each of the six directions every exposed face is
 * stickered and all of them are the same color.
 */
export function isSolved(st: State): boolean {
  if (!isXShape(st)) return false;
  const color: (Color | null | undefined)[] = new Array(6).fill(undefined);
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (st.occ[s] < 0) continue;
    for (let d = 0; d < 6; d++) {
      if (!isExposed(st, s, d)) continue;
      const c = st.colorAt(s, d);
      if (c === null) return false;
      if (color[d] === undefined) color[d] = c;
      else if (color[d] !== c) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- effect

export interface PieceMove {
  id: number;
  name: string;
  kind: string;
  from: string;
  to: string;
  /** True if the cubelet ends up rotated relative to how it started (only meaningful when from === to). */
  rotated: boolean;
}

export interface Effect {
  /** Cycles of slots, following where each cubelet went. */
  cycles: string[];
  /** Cubelets that stay in place but are rotated (and whose rotation is visible). */
  twisted: string[];
  /** Number of exposed faces whose color differs between the two states. */
  visibleChanges: number;
  shapeSame: boolean;
  moved: PieceMove[];
}

/** True if cubelet `id` shows any sticker facing a different direction under orientation oa vs ob. */
function stickerDirsDiffer(id: number, oa: number, ob: number): boolean {
  const st = CUBELETS[id].stickers;
  for (let d = 0; d < 6; d++) if (st[d] !== null && ROT_DIR[oa * 6 + d] !== ROT_DIR[ob * 6 + d]) return true;
  return false;
}

/** Describe how state `b` differs from state `a`, in terms of cubelet movements. */
export function effect(a: State, b: State): Effect {
  const slotOfA = new Int16Array(CUBELETS.length).fill(-1);
  const slotOfB = new Int16Array(CUBELETS.length).fill(-1);
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (a.occ[s] >= 0) slotOfA[a.occ[s]] = s;
    if (b.occ[s] >= 0) slotOfB[b.occ[s]] = s;
  }
  const moved: PieceMove[] = [];
  const twisted: string[] = [];
  const next = new Map<number, number>();
  for (const c of CUBELETS) {
    const sa = slotOfA[c.id];
    const sb = slotOfB[c.id];
    // relative rotation from a to b
    const rel = ROT_MUL[b.ori[sb] * NUM_ROT + ROT_INV[a.ori[sa]]];
    if (sa !== sb) {
      next.set(sa, sb);
      moved.push({ id: c.id, name: c.name, kind: c.kind, from: slotName(sa), to: slotName(sb), rotated: rel !== 0 });
    } else if (stickerDirsDiffer(c.id, a.ori[sa], b.ori[sb])) {
      twisted.push(slotName(sa));
    }
  }
  // cycles over slots (only through occupied slots; a cubelet moving into an empty slot shows as a path)
  const cycles: string[] = [];
  const done = new Set<number>();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const path = [start];
    done.add(start);
    let cur = next.get(start)!;
    while (cur !== start && next.has(cur) && !done.has(cur)) {
      path.push(cur);
      done.add(cur);
      cur = next.get(cur)!;
    }
    const closed = cur === start;
    if (!closed) path.push(cur);
    cycles.push(path.map(slotName).join(" -> ") + (closed ? " -> (back)" : ""));
  }
  let visibleChanges = 0;
  for (let s = 0; s < NUM_SLOTS; s++)
    for (let d = 0; d < 6; d++) {
      const ea = a.occ[s] >= 0 && isExposed(a, s, d);
      const eb = b.occ[s] >= 0 && isExposed(b, s, d);
      if (ea !== eb || (ea && a.colorAt(s, d) !== b.colorAt(s, d))) visibleChanges++;
    }
  return { cycles, twisted, visibleChanges, shapeSame: a.shapeKey() === b.shapeKey(), moved };
}

// ---------------------------------------------------------------- text views

/**
 * A view of the puzzle from one face direction, as a 5x5 grid of characters.
 * For each line of sight, shows the color of the first face you'd see:
 *   W Y G B R O = sticker color, # = black (unstickered) face, . = nothing there.
 * Rows run top-to-bottom and columns left-to-right as you'd see them looking at that face,
 * with the D view seen from below with F at the top.
 */
export function faceView(st: State, face: number): string[] {
  // For each face: [rowAxisVector(down the page), colAxisVector(right), viewDir(toward viewer)]
  const frames: Record<string, [Vec3, Vec3, Vec3]> = {
    U: [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    D: [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
    F: [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    B: [[0, -1, 0], [-1, 0, 0], [0, 0, -1]],
    R: [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    L: [[0, -1, 0], [0, 0, 1], [-1, 0, 0]],
  };
  const [rowV, colV, view] = frames[FACE_NAMES[face]];
  const rows: string[] = [];
  for (let r = -2; r <= 2; r++) {
    let line = "";
    for (let c = -2; c <= 2; c++) {
      let ch = ".";
      for (let depth = 2; depth >= -2; depth--) {
        const p: Vec3 = [
          rowV[0] * r + colV[0] * c + view[0] * depth,
          rowV[1] * r + colV[1] * c + view[1] * depth,
          rowV[2] * r + colV[2] * c + view[2] * depth,
        ];
        const s = slotAt(p);
        if (s >= 0 && st.occ[s] >= 0) {
          ch = st.colorAt(s, face) ?? "#";
          break;
        }
      }
      line += ch;
    }
    rows.push(line);
  }
  return rows;
}

/** All six face views laid out as a net:
 *        U
 *     L  F  R  B
 *        D
 */
export function netView(st: State): string {
  const v = (f: string) => faceView(st, FACE_NAMES.indexOf(f as never)).map((r) => r.split("").join(" "));
  const U = v("U"), D = v("D"), F = v("F"), R = v("R"), B = v("B"), L = v("L");
  const pad = " ".repeat(11);
  const lines: string[] = [];
  lines.push(pad + "    U");
  for (const r of U) lines.push(pad + r);
  lines.push("    L          F          R          B");
  for (let i = 0; i < 5; i++) lines.push([L[i], F[i], R[i], B[i]].join("  "));
  lines.push(pad + "    D");
  for (const r of D) lines.push(pad + r);
  return lines.join("\n");
}

/** Status line: shape, solved, which outer turns are currently allowed. */
export function statusLine(st: State): string {
  const parts: string[] = [];
  parts.push(isHomeX(st) ? "X shape" : isXShape(st) ? "X shape (rotated)" : "not X shape");
  if (isSolved(st)) parts.push("SOLVED");
  const free = outerAvailability(st);
  parts.push("outer turns: " + free.map(([n, c]) => (c === 9 ? n : `${n}(${c}/9)`)).join(" "));
  return parts.join(" | ");
}

/** For each extension layer, how many of its 9 slots are filled. */
export function outerAvailability(st: State): [string, number][] {
  const out: [string, number][] = [];
  const names: [string, number, number][] = [
    ["r", 0, 2],
    ["l", 0, -2],
    ["u", 1, 2],
    ["d", 1, -2],
    ["f", 2, 2],
    ["b", 2, -2],
  ];
  for (const [n, axis, v] of names) {
    let c = 0;
    for (let s = 0; s < NUM_SLOTS; s++) if (SLOT_POS[s][axis] === v && st.occ[s] >= 0) c++;
    out.push([n, c]);
  }
  return out;
}

export { DIRS, ROTATIONS, matVec };
