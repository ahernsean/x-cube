// Analysis: shape tests, solved test, effect of an algorithm, text views.

import { DIRS, FACE_NAMES, NUM_ROT, ROT_DIR, ROT_INV, ROT_MUL, ROTATIONS, matVec, type Vec3 } from "./geometry.ts";
import { State, type Color } from "./puzzle.ts";

// ---------------------------------------------------------------- shape

/** True when the puzzle is in its solved shape held the solved way (on the X-Cube: the X shape, X-faces up and down). */
export function isHomeShape(st: State): boolean {
  return st.shapeKey() === st.puzzle.homeShapes[0];
}

/** True when the puzzle is in its solved shape, held any way (on the X-Cube: an X in any orientation). */
export function isInShape(st: State): boolean {
  return st.puzzle.homeShapes.includes(st.shapeKey());
}

/** The X-Cube's names: the X shape, held X-faces up and down, and in any orientation. */
export const isHomeX = isHomeShape;
export const isXShape = isInShape;

/** Exposed faces: a face is visible when the neighboring slot is empty or outside the lattice. */
export function isExposed(st: State, s: number, d: number): boolean {
  const n = st.puzzle.slotNeighbor[s * 6 + d];
  if (n === -2) return false; // the solid center of the puzzle
  return n === -1 || st.occ[n] < 0;
}

/**
 * Solved = in shape (the X shape, on the X-Cube), and in each of the six directions every exposed face is
 * stickered and all of them are the same color.
 */
export function isSolved(st: State): boolean {
  if (!isInShape(st)) return false;
  const color: (Color | null | undefined)[] = new Array(6).fill(undefined);
  for (let s = 0; s < st.puzzle.numSlots; s++) {
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
  /** True if the piece ends up rotated relative to how it started (only meaningful when from === to). */
  rotated: boolean;
}

export interface Effect {
  /** Cycles of slots, following where each piece went. */
  cycles: string[];
  /** Pieces that stay in place but are rotated (and whose rotation is visible). */
  twisted: string[];
  /** Number of exposed faces whose color differs between the two states. */
  visibleChanges: number;
  shapeSame: boolean;
  moved: PieceMove[];
}

/** True if piece `id` shows any sticker facing a different direction under orientation oa vs ob. */
function stickerDirsDiffer(stickers: readonly (Color | null)[], oa: number, ob: number): boolean {
  const st = stickers;
  for (let d = 0; d < 6; d++) if (st[d] !== null && ROT_DIR[oa * 6 + d] !== ROT_DIR[ob * 6 + d]) return true;
  return false;
}

/** Describe how state `b` differs from state `a`, in terms of piece movements. */
export function effect(a: State, b: State): Effect {
  const P = a.puzzle;
  const slotName = P.slotName;
  const slotOfA = new Int16Array(P.numPieces).fill(-1);
  const slotOfB = new Int16Array(P.numPieces).fill(-1);
  for (let s = 0; s < P.numSlots; s++) {
    if (a.occ[s] >= 0) slotOfA[a.occ[s]] = s;
    if (b.occ[s] >= 0) slotOfB[b.occ[s]] = s;
  }
  const moved: PieceMove[] = [];
  const twisted: string[] = [];
  const next = new Map<number, number>();
  for (const c of P.pieces) {
    const sa = slotOfA[c.id];
    const sb = slotOfB[c.id];
    // relative rotation from a to b
    const rel = ROT_MUL[b.ori[sb] * NUM_ROT + ROT_INV[a.ori[sa]]];
    if (sa !== sb) {
      next.set(sa, sb);
      moved.push({ id: c.id, name: c.name, kind: c.kind, from: slotName(sa), to: slotName(sb), rotated: rel !== 0 });
    } else if (stickerDirsDiffer(c.stickers, a.ori[sa], b.ori[sb])) {
      twisted.push(slotName(sa));
    }
  }
  // cycles over slots (only through occupied slots; a piece moving into an empty slot shows as a path)
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
  for (let s = 0; s < P.numSlots; s++)
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
const VIEW_FRAMES: Record<string, [Vec3, Vec3, Vec3]> = {
  // [row axis (down the page), column axis (to the right), view direction (toward the viewer)]
  U: [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  D: [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
  F: [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  B: [[0, -1, 0], [-1, 0, 0], [0, 0, -1]],
  R: [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
  L: [[0, -1, 0], [0, 0, 1], [-1, 0, 0]],
};

/** The number of slots across the puzzle's grid (5 on the X-Cube, 3 on a 3x3x3). */
export const gridWidth = (st: State) => (2 * st.puzzle.range) / st.puzzle.step + 1;

/** Slot of the first piece seen along each line of sight (gridWidth squared, row-major), or -1. */
function frontSlots(st: State, face: number): Int16Array {
  const [rowV, colV, view] = VIEW_FRAMES[FACE_NAMES[face]];
  const { range: R, step } = st.puzzle;
  const n = gridWidth(st);
  const out = new Int16Array(n * n).fill(-1);
  for (let r = -R; r <= R; r += step)
    for (let c = -R; c <= R; c += step)
      for (let depth = R; depth >= -R; depth -= step) {
        const p: Vec3 = [
          rowV[0] * r + colV[0] * c + view[0] * depth,
          rowV[1] * r + colV[1] * c + view[1] * depth,
          rowV[2] * r + colV[2] * c + view[2] * depth,
        ];
        const s = st.puzzle.slotAt(p);
        if (s >= 0 && st.occ[s] >= 0) {
          out[((r + R) / step) * n + (c + R) / step] = s;
          break;
        }
      }
  return out;
}

/**
 * A view of the puzzle from one face direction, as a 5x5 grid of characters.
 * For each line of sight, shows the color of the first face you'd see:
 *   W Y G B R O = sticker color, # = black (unstickered) face, . = nothing there.
 * Rows run top-to-bottom and columns left-to-right as you'd see them looking at that face,
 * with the D view seen from below with F at the top.
 */
export function faceView(st: State, face: number): string[] {
  const slots = frontSlots(st, face);
  const n = gridWidth(st);
  const rows: string[] = [];
  for (let r = 0; r < n; r++) {
    let line = "";
    for (let c = 0; c < n; c++) {
      const s = slots[r * n + c];
      line += s < 0 ? "." : (st.colorAt(s, face) ?? "#");
    }
    rows.push(line);
  }
  return rows;
}

/** Color of a side face shown in the rim: a sticker color, or "#" for black. */
export type RimColor = Color | "#";

export interface RimCell {
  /** Sticker color seen straight on, "#" for an unstickered face, or null if nothing is there. */
  face: RimColor | null;
  /**
   * For empty cells: side faces of neighboring pieces that face into this cell.
   * `top` is the side of the piece just above this cell (its face pointing down the page), etc.
   */
  top?: RimColor;
  bottom?: RimColor;
  left?: RimColor;
  right?: RimColor;
}

/**
 * The face view with a rim: a 7x7 grid (the 5x5 view plus a ring around it).
 * Wherever a seen piece borders an empty cell, that empty cell records the color
 * on the piece's side facing it, so you can tell how this face connects to its neighbors.
 * The side faces shown are always exposed: the empty cell's whole line of sight is empty.
 */
export function faceRimView(st: State, face: number): RimCell[][] {
  const [rowV, colV] = VIEW_FRAMES[FACE_NAMES[face]];
  const slots = frontSlots(st, face);
  const n = gridWidth(st);
  const at = (r: number, c: number) => (r < 0 || r >= n || c < 0 || c >= n ? -1 : slots[r * n + c]);
  const side = (s: number, v: Vec3): RimColor => st.colorAt(s, dirIndexOf(v)) ?? "#";
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
  const grid: RimCell[][] = [];
  for (let R = 0; R < n + 2; R++) {
    const row: RimCell[] = [];
    for (let C = 0; C < n + 2; C++) {
      const r = R - 1, c = C - 1;
      const s = at(r, c);
      if (s >= 0) {
        row.push({ face: st.colorAt(s, face) ?? "#" });
        continue;
      }
      const cell: RimCell = { face: null };
      const up = at(r - 1, c), down = at(r + 1, c), left = at(r, c - 1), right = at(r, c + 1);
      if (up >= 0) cell.top = side(up, rowV); // the piece above, its face pointing down the page
      if (down >= 0) cell.bottom = side(down, neg(rowV));
      if (left >= 0) cell.left = side(left, colV);
      if (right >= 0) cell.right = side(right, neg(colV));
      row.push(cell);
    }
    grid.push(row);
  }
  return grid;
}

function dirIndexOf(v: Vec3): number {
  for (let d = 0; d < 6; d++) if (DIRS[d][0] === v[0] && DIRS[d][1] === v[1] && DIRS[d][2] === v[2]) return d;
  throw new Error("not an axis direction");
}

/** All six face views laid out as a net:
 *        U
 *     L  F  R  B
 *        D
 */
export function netView(st: State): string {
  const v = (f: string) => faceView(st, FACE_NAMES.indexOf(f as never)).map((r) => r.split("").join(" "));
  const U = v("U"), D = v("D"), F = v("F"), R = v("R"), B = v("B"), L = v("L");
  const n = U.length;
  const w = 2 * n - 1; // a row's width, its letters spaced
  const pad = " ".repeat(w + 2);
  const label = (f: string) => " ".repeat(n - 1) + f + " ".repeat(n - 1);
  const lines: string[] = [];
  lines.push(pad + label("U").trimEnd());
  for (const r of U) lines.push(pad + r);
  lines.push(["L", "F", "R", "B"].map(label).join("  ").trimEnd());
  for (let i = 0; i < n; i++) lines.push([L[i], F[i], R[i], B[i]].join("  "));
  lines.push(pad + label("D").trimEnd());
  for (const r of D) lines.push(pad + r);
  return lines.join("\n");
}

/** Status line: shape, solved, which outer turns are currently allowed. */
export function statusLine(st: State): string {
  const parts: string[] = [];
  if (st.puzzle.homeShapes[0].includes("0")) parts.push(isHomeX(st) ? "X shape" : isXShape(st) ? "X shape (rotated)" : "not X shape");
  if (isSolved(st)) parts.push("SOLVED");
  if (!st.puzzle.moves.some((d) => d.needsFull)) return parts.join(" | ") || "not solved";
  const free = outerAvailability(st);
  parts.push("outer turns: " + free.map(([n, c]) => (c === 9 ? n : `${n}(${c}/9)`)).join(" "));
  return parts.join(" | ");
}

/** For each turn that needs its layer full (the X-Cube's extension layers), how many of the layer's slots are filled (of 9 on the X-Cube). */
export function outerAvailability(st: State): [string, number][] {
  return st.puzzle.moves.filter((d) => d.needsFull).map((d) => [d.name, d.slots.filter((s) => st.occ[s] >= 0).length]);
}

export { DIRS, ROTATIONS, matVec };
