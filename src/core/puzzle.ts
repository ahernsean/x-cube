// The X-Cube model: slots, cubelets, state, and moves.
//
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

import {
  axisRotation,
  DIRS,
  FACE_NAMES,
  NUM_ROT,
  ROT_DIR,
  ROT_INV,
  ROT_MUL,
  ROTATIONS,
  matVec,
  type Vec3,
} from "./geometry.ts";

// ---------------------------------------------------------------- slots

const posKey = (x: number, y: number, z: number) => (x + 2) * 25 + (y + 2) * 5 + (z + 2);

export const SLOT_POS: readonly Vec3[] = (() => {
  const out: Vec3[] = [];
  for (let x = -2; x <= 2; x++)
    for (let y = -2; y <= 2; y++)
      for (let z = -2; z <= 2; z++) {
        const twos = [x, y, z].filter((c) => Math.abs(c) === 2).length;
        if (twos > 1 || (x === 0 && y === 0 && z === 0)) continue;
        out.push([x, y, z]);
      }
  return out;
})();
export const NUM_SLOTS = SLOT_POS.length; // 80

const SLOT_AT = new Int16Array(125).fill(-1);
SLOT_POS.forEach((p, i) => (SLOT_AT[posKey(p[0], p[1], p[2])] = i));

/** Slot index at a position, or -1 if the position is not in the lattice. */
export function slotAt(p: Vec3): number {
  if (Math.abs(p[0]) > 2 || Math.abs(p[1]) > 2 || Math.abs(p[2]) > 2) return -1;
  return SLOT_AT[posKey(p[0], p[1], p[2])];
}

/** SLOT_NEIGHBOR[s * 6 + d] = slot adjacent to s in direction d, -1 if outside the lattice, -2 for the solid center. */
export const SLOT_NEIGHBOR: Int16Array = (() => {
  const t = new Int16Array(NUM_SLOTS * 6);
  for (let s = 0; s < NUM_SLOTS; s++)
    for (let d = 0; d < 6; d++) {
      const p = SLOT_POS[s];
      const q: Vec3 = [p[0] + DIRS[d][0], p[1] + DIRS[d][1], p[2] + DIRS[d][2]];
      t[s * 6 + d] = q[0] === 0 && q[1] === 0 && q[2] === 0 ? -2 : slotAt(q);
    }
  return t;
})();

/** Is this position part of the solved X shape (home orientation)? */
export function inHomeX(p: Vec3): boolean {
  const [x, y, z] = p;
  return Math.abs(y) <= 1 && Math.abs(x) <= 2 && Math.abs(z) <= 2 && (Math.abs(x) <= 1 || Math.abs(z) <= 1);
}

/**
 * Human-readable slot name. Core slots use standard cubie names (UFR, UF, U).
 * Extension slots are named "<face>x.<position within that extension>", e.g.
 * "Fx.UR" is the up-right cubelet of the front extension, "Fx" its center.
 */
export function slotName(s: number): string {
  const [x, y, z] = SLOT_POS[s];
  const parts = (cx: number, cy: number, cz: number) => {
    let n = "";
    if (cy) n += cy > 0 ? "U" : "D";
    if (cz) n += cz > 0 ? "F" : "B";
    if (cx) n += cx > 0 ? "R" : "L";
    return n;
  };
  if (Math.abs(x) === 2) return `${x > 0 ? "R" : "L"}x${y || z ? "." + parts(0, y, z) : ""}`;
  if (Math.abs(y) === 2) return `${y > 0 ? "U" : "D"}x${x || z ? "." + parts(x, 0, z) : ""}`;
  if (Math.abs(z) === 2) return `${z > 0 ? "F" : "B"}x${x || y ? "." + parts(x, y, 0) : ""}`;
  return parts(x, y, z);
}

// ---------------------------------------------------------------- cubelets

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
 * Cubelet kinds, by connectivity in the solved puzzle (Baum's grouping):
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

export interface Cubelet {
  id: number;
  home: number; // slot index in the solved puzzle
  kind: Kind;
  /** stickers[d] = color on the cubelet's face that points in direction d when solved, or null. */
  stickers: readonly (Color | null)[];
  /** For outer cubelets: direction (in the cubelet's own frame) of its outward face. */
  outward: number | null;
  name: string;
}

function classify(p: Vec3): Kind {
  const twos = p.filter((c) => Math.abs(c) === 2).length;
  const nonzero = p.filter((c) => c !== 0).length;
  if (twos === 1) return nonzero === 1 ? "extCenter" : nonzero === 2 ? "outerEdge" : "outerCorner";
  if (nonzero === 1) return "center";
  if (nonzero === 3) return "coreCorner";
  return p[1] === 0 ? "doubleEdge" : "singleEdge";
}

export const CUBELETS: readonly Cubelet[] = (() => {
  const out: Cubelet[] = [];
  for (let s = 0; s < NUM_SLOTS; s++) {
    const p = SLOT_POS[s];
    if (!inHomeX(p)) continue;
    const stickers: (Color | null)[] = [];
    for (let d = 0; d < 6; d++) {
      const n: Vec3 = [p[0] + DIRS[d][0], p[1] + DIRS[d][1], p[2] + DIRS[d][2]];
      const inside = inHomeX(n) || (n[0] === 0 && n[1] === 0 && n[2] === 0);
      stickers.push(inside ? null : FACE_COLOR[d]);
    }
    const kind = classify(p);
    let outward: number | null = null;
    if (kind === "outerCorner" || kind === "outerEdge" || kind === "extCenter") {
      const axis = p.findIndex((c) => Math.abs(c) === 2);
      outward = axis * 2 + (p[axis] > 0 ? 0 : 1);
    }
    out.push({ id: out.length, home: s, kind, stickers, outward, name: slotName(s) });
  }
  return out;
})();
export const NUM_CUBELETS = CUBELETS.length; // 62 (52 that matter + 6 centers + 4 extension centers)

// ---------------------------------------------------------------- state

/**
 * A puzzle state. occ[slot] is the cubelet id in that slot (-1 = empty);
 * ori[slot] is the rotation index (into ROTATIONS) of that cubelet relative to
 * its solved orientation.
 */
export class State {
  occ: Int8Array;
  ori: Uint8Array;
  constructor(occ?: Int8Array, ori?: Uint8Array) {
    this.occ = occ ?? new Int8Array(NUM_SLOTS).fill(-1);
    this.ori = ori ?? new Uint8Array(NUM_SLOTS);
  }
  static solved(): State {
    const st = new State();
    for (const c of CUBELETS) st.occ[c.home] = c.id;
    return st;
  }
  clone(): State {
    return new State(this.occ.slice(), this.ori.slice());
  }
  copyFrom(o: State): void {
    this.occ.set(o.occ);
    this.ori.set(o.ori);
  }
  equals(o: State): boolean {
    for (let s = 0; s < NUM_SLOTS; s++) {
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
    return CUBELETS[id].stickers[local];
  }
  filled(s: number): boolean {
    return this.occ[s] >= 0;
  }
  /** Bitmask-ish occupancy string, one char per slot. */
  shapeKey(): string {
    let k = "";
    for (let s = 0; s < NUM_SLOTS; s++) k += this.occ[s] >= 0 ? "1" : "0";
    return k;
  }
  /**
   * Key that is equal for two states exactly when they look identical:
   * same occupancy, and every face of every slot shows the same color.
   * Identical twin cubelets (e.g. the four white core corners) compare equal.
   */
  appearanceKey(): string {
    let k = "";
    for (let s = 0; s < NUM_SLOTS; s++) {
      if (this.occ[s] < 0) {
        k += "_";
        continue;
      }
      for (let d = 0; d < 6; d++) k += this.colorAt(s, d) ?? "-";
    }
    return k;
  }
}

// ---------------------------------------------------------------- moves

export type MoveKind = "inner" | "outer" | "slice" | "rotation";

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
}

function defineMoves(): MoveDef[] {
  const defs: MoveDef[] = [];
  const add = (
    name: string,
    kind: MoveKind,
    axis: 0 | 1 | 2,
    ccw: 1 | -1,
    pred: (c: number) => boolean,
    layerOrder: number,
    description: string,
  ) => {
    const slots: number[] = [];
    for (let s = 0; s < NUM_SLOTS; s++) if (pred(SLOT_POS[s][axis])) slots.push(s);
    defs.push({ name, kind, axis, ccw, slots, layerOrder, description });
  };
  const faces: [string, 0 | 1 | 2, 1 | -1][] = [
    ["R", 0, 1],
    ["L", 0, -1],
    ["U", 1, 1],
    ["D", 1, -1],
    ["F", 2, 1],
    ["B", 2, -1],
  ];
  for (const [n, axis, sgn] of faces) {
    // Clockwise looking at the face = -90 degrees about its outward normal.
    const ccw = (sgn > 0 ? -1 : 1) as 1 | -1;
    add(n, "inner", axis, ccw, (c) => c * sgn >= 1, sgn > 0 ? 0 : 4, `${n} face layer plus its extension (inner turn)`);
    add(n.toLowerCase(), "outer", axis, ccw, (c) => c * sgn === 2, sgn > 0 ? 1 : 3, `${n} extension alone (outer turn; needs all 9 cubelets)`);
  }
  add("M", "slice", 0, 1, (c) => c === 0, 2, "middle slice between L and R, turned like L");
  add("H", "slice", 1, -1, (c) => c === 0, 2, "horizontal middle slice, turned like U (viewed from above)");
  add("E", "slice", 1, 1, (c) => c === 0, 2, "horizontal middle slice, turned like D (E = H')");
  add("S", "slice", 2, -1, (c) => c === 0, 2, "middle slice between F and B, turned like F");
  add("x", "rotation", 0, -1, () => true, 5, "whole puzzle, turned like R");
  add("y", "rotation", 1, -1, () => true, 5, "whole puzzle, turned like U");
  add("z", "rotation", 2, -1, () => true, 5, "whole puzzle, turned like F");
  return defs;
}

export const MOVE_DEFS: readonly MoveDef[] = defineMoves();
export const MOVE_BY_NAME = new Map(MOVE_DEFS.map((d, i) => [d.name, i]));

/** A single turn: a move definition and an amount (1 = clockwise, 2 = half, 3 = counterclockwise). */
export interface Turn {
  def: number;
  amount: 1 | 2 | 3;
}

interface TurnTable {
  from: Int16Array; // slots in layer
  to: Int16Array; // destination slot for each
  rot: number; // rotation index applied to cubelets
}

/** TURN_TABLES[def * 3 + amount - 1] */
const TURN_TABLES: readonly TurnTable[] = (() => {
  const out: TurnTable[] = [];
  for (const d of MOVE_DEFS)
    for (let a = 1; a <= 3; a++) {
      const rot = axisRotation(d.axis, d.ccw * a);
      const m = ROTATIONS[rot];
      const from = Int16Array.from(d.slots);
      const to = Int16Array.from(d.slots.map((s) => slotAt(matVec(m, SLOT_POS[s]))));
      if (to.some((t) => t < 0)) throw new Error("move maps outside lattice");
      out.push({ from, to, rot });
    }
  return out;
})();

export function turnName(t: Turn): string {
  return MOVE_DEFS[t.def].name + (t.amount === 1 ? "" : t.amount === 2 ? "2" : "'");
}

/** Why a turn is not allowed in this state, or null if it is allowed. */
export function blockedReason(st: State, t: Turn): string | null {
  const d = MOVE_DEFS[t.def];
  if (d.kind !== "outer") return null;
  let n = 0;
  for (const s of d.slots) if (st.occ[s] >= 0) n++;
  return n === 9 ? null : `${d.name} blocked: extension has ${n}/9 cubelets`;
}

const scratchOcc = new Int8Array(NUM_SLOTS);
const scratchOri = new Uint8Array(NUM_SLOTS);

/** Apply a turn in place. Returns false (and leaves the state unchanged) if the turn is blocked. */
export function applyTurn(st: State, t: Turn): boolean {
  const d = MOVE_DEFS[t.def];
  if (d.kind === "outer") {
    for (const s of d.slots) if (st.occ[s] < 0) return false;
  }
  const tt = TURN_TABLES[t.def * 3 + t.amount - 1];
  const n = tt.from.length;
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
    if (why) return { ok: false, applied: i, error: `turn ${i + 1} (${turnName(turns[i])}): ${why}` };
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
