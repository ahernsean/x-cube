// Puzzles as data (PuzzleDef: slots, pieces, moves), states, and applying turns.
// The X-Cube and the 3x3x3 are two definitions built the same way (buildPuzzle).

import { axisRotation, DIRS, FACE_NAMES, NUM_ROT, ROT_DIR, ROT_INV, ROT_MUL, ROTATIONS, matVec, type Vec3 } from "./geometry.ts";

// ---------------------------------------------------------------- puzzle definitions

export type Color = "W" | "Y" | "G" | "B" | "R" | "O";

/**
 * Sticker color of each face in the solved puzzle, indexed like FACE_NAMES
 * (R, L, U, D, F, B). Standard Western scheme; adjust if your cube differs.
 */
export const FACE_COLOR: readonly Color[] = ["R", "O", "W", "Y", "G", "B"];

export const COLOR_NAME: Record<Color, string> = {
  W: "white",
  Y: "yellow",
  G: "green",
  B: "blue",
  R: "red",
  O: "orange",
};

/**
 * The X-Cube's piece kinds, by connectivity in the solved puzzle (Baum's grouping):
 * - center: core face center (U/D carry the X-face center sticker; L/R/F/B are
 *   hidden and fused to their extension center)
 * - extCenter: extension center (fused to the core center behind it)
 * - coreCorner: 8, one white/yellow sticker
 * - singleEdge: 8 core edges in the U/D layers, one white/yellow sticker
 * - doubleEdge: 4 core edges in the middle layer, no stickers
 * - outerCorner: 16 ("X-face corners"), 3 stickers
 * - outerEdge: 16, 2 stickers (8 "X-face edges" + 8 "extension side edges")
 */
export type Kind = "center" | "extCenter" | "coreCorner" | "singleEdge" | "doubleEdge" | "outerCorner" | "outerEdge";

/** A 3x3x3's piece kinds. */
export type CubeKind = "corner" | "edge" | "center";

export interface Piece<K extends string = string> {
  id: number;
  home: number; // slot index in the solved puzzle
  kind: K;
  /** stickers[d] = color on the piece's face that points in direction d when solved, or null. */
  stickers: readonly (Color | null)[];
  /** For X-Cube outer pieces: direction (in the piece's own frame) of its outward face. */
  outward: number | null;
  name: string;
}

export type MoveKind = "inner" | "outer" | "wide" | "slice" | "rotation";

export interface MoveDef {
  name: string;
  kind: MoveKind;
  axis: 0 | 1 | 2;
  /** Counterclockwise quarter turns (about the +axis) for one clockwise turn of this move. */
  ccw: 1 | -1;
  /** Slots in the turning layer(s). */
  slots: readonly number[];
  /** For canonical move ordering in search: moves on the same axis commute. */
  layerOrder: number;
  description: string;
  /**
   * Set when the turn is allowed only with every slot of its layer filled (the X-Cube's
   * outer turns): the word for that layer in the message when it isn't ("extension").
   */
  needsFull?: string;
  /** Accepted when typed or pasted, but never offered: no turn button, help line, shuffle or solver step uses it (the 3x3x3's wide turns). */
  typedOnly?: boolean;
}

/** How one move is written in a puzzle's spec: its layer is the slots whose coordinate on `axis` passes `layer`. */
export interface MoveSpec {
  name: string;
  kind: MoveKind;
  axis: 0 | 1 | 2;
  ccw: 1 | -1;
  layer: (c: number) => boolean;
  layerOrder: number;
  description: string;
  needsFull?: string;
  typedOnly?: boolean;
}

/** What makes a puzzle: its grid of slots, which of them are filled when solved, and its moves. */
export interface PuzzleSpec<K extends string = string> {
  id: string;
  name: string;
  /** Slot coordinates are integers in -range..range, spaced `step` apart (2 on even cubes, whose slots are at odd coordinates). */
  range: number;
  step: number;
  isSlot: (p: Vec3) => boolean;
  /** Points inside the puzzle that no piece can occupy (a face there is never seen). */
  isInterior: (p: Vec3) => boolean;
  /** Is this slot filled in the solved puzzle? */
  isHome: (p: Vec3) => boolean;
  kindOf: (p: Vec3) => K;
  outwardOf?: (p: Vec3) => number | null;
  slotName: (p: Vec3) => string;
  moves: MoveSpec[];
}

interface TurnTable {
  from: Int16Array; // slots in layer
  to: Int16Array; // destination slot for each
  rot: number; // rotation index applied to pieces
}

/**
 * A puzzle as data: everything the engine reads about one kind of puzzle. Every State
 * carries the definition it belongs to, so code that has a state needs nothing else.
 */
export interface PuzzleDef<K extends string = string> {
  id: string;
  name: string;
  range: number;
  step: number;
  slotPos: readonly Vec3[];
  numSlots: number;
  /** slotNeighbor[s * 6 + d] = slot next to s in direction d, -1 if outside the grid, -2 for the puzzle's solid interior. */
  slotNeighbor: Int16Array;
  pieces: readonly Piece<K>[];
  numPieces: number;
  faceColor: readonly Color[];
  moves: readonly MoveDef[];
  moveByName: Map<string, number>;
  /** turnTables[def * 3 + amount - 1] */
  turnTables: readonly TurnTable[];
  /** Slot index at a position, or -1 if the position is not a slot. */
  slotAt(p: Vec3): number;
  /** Slot index at coordinates, or -1 (no allocation; for hot loops). */
  slotAtXYZ(x: number, y: number, z: number): number;
  slotName(s: number): string;
  /** The occupancy keys (State.shapeKey) of the solved shape turned every way: the puzzle is "in shape" in any of them. */
  homeShapes: readonly string[];
  /** Look-alike class per piece: pieces with identical stickers on identical faces share a class. */
  appearanceClass: Int16Array;
  /** canonOri[id * 24 + r] = smallest rotation index that makes piece `id` show its stickers in the same directions as rotation r does. */
  canonOri: Uint8Array;
  scratchOcc: Int16Array;
  scratchOri: Uint8Array;
}

export function buildPuzzle<K extends string>(spec: PuzzleSpec<K>): PuzzleDef<K> {
  const { range: R, step } = spec;
  const n = (2 * R) / step + 1;
  const onGrid = (c: number) => c >= -R && c <= R && (c + R) % step === 0;
  const key = (x: number, y: number, z: number) => (((x + R) / step) * n + (y + R) / step) * n + (z + R) / step;

  const slotPos: Vec3[] = [];
  for (let x = -R; x <= R; x += step)
    for (let y = -R; y <= R; y += step)
      for (let z = -R; z <= R; z += step) if (spec.isSlot([x, y, z])) slotPos.push([x, y, z]);
  const numSlots = slotPos.length;
  const at = new Int16Array(n * n * n).fill(-1);
  slotPos.forEach((p, i) => (at[key(p[0], p[1], p[2])] = i));
  const slotAtXYZ = (x: number, y: number, z: number) => (onGrid(x) && onGrid(y) && onGrid(z) ? at[key(x, y, z)] : -1);
  const slotAt = (p: Vec3) => slotAtXYZ(p[0], p[1], p[2]);
  const slotName = (s: number) => spec.slotName(slotPos[s]);

  const step3 = (p: Vec3, d: number): Vec3 => [p[0] + step * DIRS[d][0], p[1] + step * DIRS[d][1], p[2] + step * DIRS[d][2]];
  const slotNeighbor = new Int16Array(numSlots * 6);
  for (let s = 0; s < numSlots; s++)
    for (let d = 0; d < 6; d++) {
      const q = step3(slotPos[s], d);
      slotNeighbor[s * 6 + d] = spec.isInterior(q) ? -2 : slotAt(q);
    }

  const pieces: Piece<K>[] = [];
  for (let s = 0; s < numSlots; s++) {
    const p = slotPos[s];
    if (!spec.isHome(p)) continue;
    const stickers: (Color | null)[] = [];
    for (let d = 0; d < 6; d++) {
      const q = step3(p, d);
      const inside = spec.isInterior(q) || (spec.isSlot(q) && spec.isHome(q));
      stickers.push(inside ? null : FACE_COLOR[d]);
    }
    pieces.push({ id: pieces.length, home: s, kind: spec.kindOf(p), stickers, outward: spec.outwardOf?.(p) ?? null, name: slotName(s) });
  }

  const moves: MoveDef[] = spec.moves.map((m) => {
    const slots: number[] = [];
    for (let s = 0; s < numSlots; s++) if (m.layer(slotPos[s][m.axis])) slots.push(s);
    const def: MoveDef = { name: m.name, kind: m.kind, axis: m.axis, ccw: m.ccw, slots, layerOrder: m.layerOrder, description: m.description };
    if (m.needsFull) def.needsFull = m.needsFull;
    if (m.typedOnly) def.typedOnly = true;
    return def;
  });

  const turnTables: TurnTable[] = [];
  for (const d of moves)
    for (let a = 1; a <= 3; a++) {
      const rot = axisRotation(d.axis, d.ccw * a);
      const m = ROTATIONS[rot];
      const from = Int16Array.from(d.slots);
      const to = Int16Array.from(d.slots.map((s) => slotAt(matVec(m, slotPos[s]))));
      if (to.some((t) => t < 0)) throw new Error(`${spec.id}: move ${d.name} maps outside the grid`);
      turnTables.push({ from, to, rot });
    }

  const homeShapes = [
    ...new Set(
      ROTATIONS.map((m) => {
        let k = "";
        for (let s = 0; s < numSlots; s++) {
          const q = matVec(m, slotPos[s]);
          k += spec.isHome(q) ? "1" : "0";
        }
        return k;
      }),
    ),
  ];

  const appearanceClass = new Int16Array(pieces.length);
  const classes = new Map<string, number>();
  const canonOri = new Uint8Array(pieces.length * NUM_ROT);
  for (const c of pieces) {
    const k = c.stickers.map((x) => x ?? "-").join("");
    if (!classes.has(k)) classes.set(k, classes.size);
    appearanceClass[c.id] = classes.get(k)!;
    const first = new Map<string, number>();
    for (let r = 0; r < NUM_ROT; r++) {
      let sig = "";
      for (let d = 0; d < 6; d++) if (c.stickers[d]) sig += `${c.stickers[d]}${ROT_DIR[r * 6 + d]}`;
      if (!first.has(sig)) first.set(sig, r);
      canonOri[c.id * NUM_ROT + r] = first.get(sig)!;
    }
  }

  return {
    id: spec.id,
    name: spec.name,
    range: R,
    step,
    slotPos,
    numSlots,
    slotNeighbor,
    pieces,
    numPieces: pieces.length,
    faceColor: FACE_COLOR,
    moves,
    moveByName: new Map(moves.map((d, i) => [d.name, i])),
    turnTables,
    slotAt,
    slotAtXYZ,
    slotName,
    homeShapes,
    appearanceClass,
    canonOri,
    scratchOcc: new Int16Array(numSlots),
    scratchOri: new Uint8Array(numSlots),
  };
}

/** Name of a cube position by the faces it is on (UFR, UF, U), the standard cubie names. */
function facesName(cx: number, cy: number, cz: number): string {
  let n = "";
  if (cy) n += cy > 0 ? "U" : "D";
  if (cz) n += cz > 0 ? "F" : "B";
  if (cx) n += cx > 0 ? "R" : "L";
  return n;
}

const FACE_AXES: [string, 0 | 1 | 2, 1 | -1][] = [
  ["R", 0, 1],
  ["L", 0, -1],
  ["U", 1, 1],
  ["D", 1, -1],
  ["F", 2, 1],
  ["B", 2, -1],
];
/** Clockwise looking at the face = -90 degrees about its outward normal. */
const faceCcw = (sgn: 1 | -1) => (sgn > 0 ? -1 : 1) as 1 | -1;

/** The slices and rotations of a 3-layer puzzle (the 3x3x3 leaves out H, the X-Cube's name for E'). */
const MIDDLE_AND_ROTATIONS: MoveSpec[] = [
  { name: "M", kind: "slice", axis: 0, ccw: 1, layer: (c) => c === 0, layerOrder: 2, description: "middle slice between L and R, turned like L" },
  { name: "H", kind: "slice", axis: 1, ccw: -1, layer: (c) => c === 0, layerOrder: 2, description: "horizontal middle slice, turned like U (viewed from above)" },
  { name: "E", kind: "slice", axis: 1, ccw: 1, layer: (c) => c === 0, layerOrder: 2, description: "horizontal middle slice, turned like D (E = H')" },
  { name: "S", kind: "slice", axis: 2, ccw: -1, layer: (c) => c === 0, layerOrder: 2, description: "middle slice between F and B, turned like F" },
  { name: "x", kind: "rotation", axis: 0, ccw: -1, layer: () => true, layerOrder: 5, description: "whole puzzle, turned like R" },
  { name: "y", kind: "rotation", axis: 1, ccw: -1, layer: () => true, layerOrder: 5, description: "whole puzzle, turned like U" },
  { name: "z", kind: "rotation", axis: 2, ccw: -1, layer: () => true, layerOrder: 5, description: "whole puzzle, turned like F" },
];

// ---------------------------------------------------------------- the X-Cube

// Model (agreed with the puzzle owner):
// - The puzzle lives in an 80-slot lattice: every integer point in -2..2 with at
//   most one coordinate equal to +/-2, excluding the very center (0,0,0).
// - Solved, it is an X: 3 layers tall (y = -1..1), plus-shaped when viewed from
//   above. The 4 extensions are on L, R, F, B. The U and D extension slots are empty.
// - Inner turns (R L U D F B) turn the 3x3x3 core layer AND everything beyond it
//   (for R: every slot with x >= 1, including the R extension). Always allowed.
// - Outer turns (r l u d f b) turn only the extension layer (for r: x == 2).
//   Allowed only when all 9 of that layer's slots are filled.
// - Slices (M, S, H, E) turn a middle layer. Always allowed.
// - Each extension center is fused to the core face center behind it. No move
//   ever separates them (verified in tests), so the model needs no special case.

const twos = (p: Vec3) => p.filter((c) => Math.abs(c) === 2).length;
const nonzeros = (p: Vec3) => p.filter((c) => c !== 0).length;
const isOrigin = (p: Vec3) => p[0] === 0 && p[1] === 0 && p[2] === 0;

/** Is this position part of the solved X shape (home orientation)? */
export function inHomeX(p: Vec3): boolean {
  const [x, y, z] = p;
  return Math.abs(y) <= 1 && Math.abs(x) <= 2 && Math.abs(z) <= 2 && (Math.abs(x) <= 1 || Math.abs(z) <= 1);
}

export const XCUBE: PuzzleDef<Kind> = buildPuzzle<Kind>({
  id: "xcube",
  name: "X-Cube",
  range: 2,
  step: 1,
  isSlot: (p) => twos(p) <= 1 && !isOrigin(p) && p.every((c) => Math.abs(c) <= 2),
  isInterior: isOrigin,
  isHome: inHomeX,
  kindOf: (p) => {
    const nz = nonzeros(p);
    if (twos(p) === 1) return nz === 1 ? "extCenter" : nz === 2 ? "outerEdge" : "outerCorner";
    if (nz === 1) return "center";
    if (nz === 3) return "coreCorner";
    return p[1] === 0 ? "doubleEdge" : "singleEdge";
  },
  outwardOf: (p) => {
    const axis = p.findIndex((c) => Math.abs(c) === 2);
    return axis < 0 ? null : axis * 2 + (p[axis] > 0 ? 0 : 1);
  },
  /**
   * Core slots use standard cubie names (UFR, UF, U). Extension slots are named
   * "<face>x.<position within that extension>", e.g. "Fx.UR" is the up-right piece of the
   * front extension, "Fx" its center.
   */
  slotName: ([x, y, z]) => {
    if (Math.abs(x) === 2) return `${x > 0 ? "R" : "L"}x${y || z ? "." + facesName(0, y, z) : ""}`;
    if (Math.abs(y) === 2) return `${y > 0 ? "U" : "D"}x${x || z ? "." + facesName(x, 0, z) : ""}`;
    if (Math.abs(z) === 2) return `${z > 0 ? "F" : "B"}x${x || y ? "." + facesName(x, y, 0) : ""}`;
    return facesName(x, y, z);
  },
  moves: [
    ...FACE_AXES.flatMap(([n, axis, sgn]): MoveSpec[] => [
      { name: n, kind: "inner", axis, ccw: faceCcw(sgn), layer: (c) => c * sgn >= 1, layerOrder: sgn > 0 ? 0 : 4, description: `${n} face layer plus its extension (inner turn)` },
      {
        name: n.toLowerCase(),
        kind: "outer",
        axis,
        ccw: faceCcw(sgn),
        layer: (c) => c * sgn === 2,
        layerOrder: sgn > 0 ? 1 : 3,
        description: `${n} extension alone (outer turn; needs all 9 pieces)`,
        needsFull: "extension",
      },
    ]),
    ...MIDDLE_AND_ROTATIONS,
  ],
});

// ---------------------------------------------------------------- the 3x3x3

/**
 * A traditional 3x3x3, on the same grid as the X-Cube's core: 26 slots, every one filled.
 * Its notation is the WCA's (Regulations, Article 12): face turns, rotations, plus the
 * common slices M, E and S. Wide turns Rw (also written 2Rw, Article 12a2+) are read when
 * typed, so standard algorithms paste as written, but the Lab never offers them. Lowercase r
 * is refused: the WCA has no lowercase wide turns (it reads r as R, Regulation E2c6+), and
 * on the X-Cube r is an outer turn, so here it would mean something else in each place.
 */
export const CUBE3: PuzzleDef<CubeKind> = buildPuzzle<CubeKind>({
  id: "cube3",
  name: "3x3x3",
  range: 1,
  step: 1,
  isSlot: (p) => !isOrigin(p) && p.every((c) => Math.abs(c) <= 1),
  isInterior: isOrigin,
  isHome: () => true,
  kindOf: (p) => (["center", "edge", "corner"] as const)[nonzeros(p) - 1],
  slotName: ([x, y, z]) => facesName(x, y, z),
  moves: [
    ...FACE_AXES.flatMap(([n, axis, sgn]): MoveSpec[] => [
      { name: n, kind: "inner", axis, ccw: faceCcw(sgn), layer: (c) => c * sgn === 1, layerOrder: sgn > 0 ? 0 : 4, description: `${n} face layer` },
      { name: `${n}w`, kind: "wide", axis, ccw: faceCcw(sgn), layer: (c) => c * sgn >= 0, layerOrder: sgn > 0 ? 1 : 3, description: `${n} face layer and the middle slice with it (wide turn)`, typedOnly: true },
      { name: `2${n}w`, kind: "wide", axis, ccw: faceCcw(sgn), layer: (c) => c * sgn >= 0, layerOrder: sgn > 0 ? 1 : 3, description: `${n}w by its other name: two layers, the face and the middle slice`, typedOnly: true },
    ]),
    // H is the X-Cube's name for E'; a 3x3x3 writes it E'.
    ...MIDDLE_AND_ROTATIONS.filter((m) => m.name !== "H"),
  ],
});

export const PUZZLES: readonly PuzzleDef[] = [XCUBE, CUBE3];

// The X-Cube's tables by their own names, for code that is the X-Cube's alone (its state
// codes, its editor, its solver). Code for any puzzle reads them from a State's `puzzle`.
export const SLOT_POS = XCUBE.slotPos;
export const NUM_SLOTS = XCUBE.numSlots; // 80
export const SLOT_NEIGHBOR = XCUBE.slotNeighbor;
export const PIECES = XCUBE.pieces;
export const NUM_PIECES = XCUBE.numPieces; // 62 (52 that matter + 6 centers + 4 extension centers)
export const MOVE_DEFS = XCUBE.moves;
export const MOVE_BY_NAME = XCUBE.moveByName;
export const slotAt = XCUBE.slotAt;
export const slotAtXYZ = XCUBE.slotAtXYZ;
export const slotName = XCUBE.slotName;

// ---------------------------------------------------------------- state

/**
 * A puzzle state. occ[slot] is the piece id in that slot (-1 = empty);
 * ori[slot] is the rotation index (into ROTATIONS) of that piece relative to
 * its solved orientation.
 */
export class State {
  occ: Int16Array;
  ori: Uint8Array;
  puzzle: PuzzleDef;
  constructor(occ?: Int16Array, ori?: Uint8Array, puzzle: PuzzleDef = XCUBE) {
    this.puzzle = puzzle;
    this.occ = occ ?? new Int16Array(puzzle.numSlots).fill(-1);
    this.ori = ori ?? new Uint8Array(puzzle.numSlots);
  }
  static solved(puzzle: PuzzleDef = XCUBE): State {
    const st = new State(undefined, undefined, puzzle);
    for (const c of puzzle.pieces) st.occ[c.home] = c.id;
    return st;
  }
  clone(): State {
    return new State(this.occ.slice(), this.ori.slice(), this.puzzle);
  }
  copyFrom(o: State): void {
    this.occ.set(o.occ);
    this.ori.set(o.ori);
  }
  equals(o: State): boolean {
    if (this.puzzle !== o.puzzle) return false;
    for (let s = 0; s < this.occ.length; s++) {
      if (this.occ[s] !== o.occ[s]) return false;
      if (this.occ[s] >= 0 && this.ori[s] !== o.ori[s]) return false;
    }
    return true;
  }
  /** Color showing on the face of slot s pointing in world direction d (null = black/unstickered or empty). */
  colorAt(s: number, d: number): Color | null {
    const id = this.occ[s];
    if (id < 0) return null;
    const local = ROT_DIR[ROT_INV[this.ori[s]] * 6 + d];
    return this.puzzle.pieces[id].stickers[local];
  }
  filled(s: number): boolean {
    return this.occ[s] >= 0;
  }
  /** Bitmask-ish occupancy string, one char per slot. */
  shapeKey(): string {
    let k = "";
    for (let s = 0; s < this.occ.length; s++) k += this.occ[s] >= 0 ? "1" : "0";
    return k;
  }
  /**
   * Key that is equal for two states exactly when they look identical:
   * same occupancy, and every face of every slot shows the same color.
   * Identical twin pieces (e.g. the four white core corners) compare equal.
   */
  appearanceKey(): string {
    let k = "";
    for (let s = 0; s < this.occ.length; s++) {
      if (this.occ[s] < 0) {
        k += "_";
        continue;
      }
      for (let d = 0; d < 6; d++) k += this.colorAt(s, d) ?? "-";
    }
    return k;
  }
}

// ---------------------------------------------------------------- turns

/** A single turn: a move definition (an index into its puzzle's moves) and an amount (1 = clockwise, 2 = half, 3 = counterclockwise). */
export interface Turn {
  def: number;
  amount: 1 | 2 | 3;
}

export function turnName(t: Turn, puzzle: PuzzleDef = XCUBE): string {
  return puzzle.moves[t.def].name + (t.amount === 1 ? "" : t.amount === 2 ? "2" : "'");
}

/** Why a turn is not allowed in this state, or null if it is allowed. */
export function blockedReason(st: State, t: Turn): string | null {
  const d = st.puzzle.moves[t.def];
  if (!d.needsFull) return null;
  let n = 0;
  for (const s of d.slots) if (st.occ[s] >= 0) n++;
  return n === d.slots.length ? null : `${d.name} blocked: ${d.needsFull} has ${n}/${d.slots.length} pieces`;
}

/** Apply a turn in place. Returns false (and leaves the state unchanged) if the turn is blocked. */
export function applyTurn(st: State, t: Turn): boolean {
  const P = st.puzzle;
  const d = P.moves[t.def];
  if (d.needsFull) {
    for (const s of d.slots) if (st.occ[s] < 0) return false;
  }
  const tt = P.turnTables[t.def * 3 + t.amount - 1];
  const n = tt.from.length;
  const scratchOcc = P.scratchOcc, scratchOri = P.scratchOri;
  for (let i = 0; i < n; i++) {
    scratchOcc[i] = st.occ[tt.from[i]];
    scratchOri[i] = st.ori[tt.from[i]];
  }
  for (let i = 0; i < n; i++) {
    const to = tt.to[i];
    st.occ[to] = scratchOcc[i];
    st.ori[to] = scratchOcc[i] >= 0 ? ROT_MUL[tt.rot * NUM_ROT + scratchOri[i]] : 0;
  }
  return true;
}

export interface ApplyResult {
  ok: boolean;
  /** Number of turns applied before stopping. */
  applied: number;
  error?: string;
}

/** Apply a sequence of turns in place, stopping at the first blocked turn. */
export function applyTurns(st: State, turns: readonly Turn[]): ApplyResult {
  for (let i = 0; i < turns.length; i++) {
    const why = blockedReason(st, turns[i]);
    if (why) return { ok: false, applied: i, error: `turn ${i + 1} (${turnName(turns[i], st.puzzle)}): ${why}` };
    applyTurn(st, turns[i]);
  }
  return { ok: true, applied: turns.length };
}

export function invertTurns(turns: readonly Turn[]): Turn[] {
  return turns
    .slice()
    .reverse()
    .map((t) => ({ def: t.def, amount: (4 - t.amount) as 1 | 2 | 3 }));
}

export { FACE_NAMES, ROT_DIR, ROT_INV };
