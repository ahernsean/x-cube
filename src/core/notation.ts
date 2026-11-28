// Move notation parser.
//
//   R U R' U2         face turns; ' = counterclockwise (’ and ′ too), 2 = half turn (2' is accepted too)
//   r l f b (u d)     outer turns of an extension alone
//   M E S             slices, turned like L, D and F
//   x y z             whole-puzzle rotations
//   (R U2)5           repeat a group: also (R U2)x5, (R U2)*5, (R U2) x 5
//   (R U)'            inverse of a group
//   [A, B]            commutator  = A B A' B'
//   [A: B]            conjugate   = A B A'
// Commas and periods outside brackets are treated as spaces.
//
// Move names are each puzzle's own (PuzzleDef.moves): on the X-Cube r is an outer turn; the
// 3x3x3 has no r, and writes a wide turn Rw or 2Rw. A name is matched longest first, so Rw
// is one turn. A name may start with a digit (2Rw): a count is read only right after a turn.

import { XCUBE, invertTurns, turnName, type PuzzleDef, type Turn } from "./puzzle.ts";

export class ParseError extends Error {
  pos: number;
  constructor(msg: string, pos: number) {
    super(`${msg} (at position ${pos + 1})`);
    this.pos = pos;
  }
}

/** Move names longest first, per puzzle, for matching. */
const NAMES_BY_LENGTH = new WeakMap<PuzzleDef, string[]>();
function namesByLength(puzzle: PuzzleDef): string[] {
  let names = NAMES_BY_LENGTH.get(puzzle);
  if (!names) {
    names = [...puzzle.moveByName.keys()].sort((a, b) => b.length - a.length);
    NAMES_BY_LENGTH.set(puzzle, names);
  }
  return names;
}

export function parseAlg(src: string, puzzle: PuzzleDef = XCUBE): Turn[] {
  let i = 0;
  const peek = () => src[i];
  const skipWs = (allowSeparators: boolean) => {
    while (i < src.length && (/\s/.test(src[i]) || (allowSeparators && (src[i] === "." || src[i] === ",")))) i++;
  };

  const readCount = (): number | null => {
    const m = /^\d+/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseInt(m[0], 10);
  };

  // Suffix after a single move: digits then optional prime, or prime.
  const readAmount = (): number => {
    let n = 1;
    const c = readCount();
    if (c !== null) n = c;
    if (peek() === "'" || peek() === "’" || peek() === "′") {
      i++;
      n = -n;
    }
    return n;
  };

  // Suffix after a group: optional prime, optional repeat count.
  const groupSuffix = (seq: Turn[]): Turn[] => {
    let out = seq;
    if (peek() === "'" || peek() === "’" || peek() === "′") {
      i++;
      out = invertTurns(out);
    }
    const save = i;
    skipWs(false);
    let marker = false;
    if (peek() === "*" || peek() === "x" || peek() === "×") {
      const save2 = i;
      i++;
      skipWs(false);
      if (/\d/.test(peek() ?? "")) marker = true;
      else i = save2;
    }
    if (marker || /\d/.test(peek() ?? "")) {
      const n = readCount();
      if (n === null) throw new ParseError("expected repeat count", i);
      const rep: Turn[] = [];
      for (let k = 0; k < n; k++) rep.push(...out);
      out = rep;
    } else {
      i = save;
    }
    return out;
  };

  // sequence := item*   ; stops at one of the terminator characters
  const parseSeq = (terminators: string, separatorsAreSpace: boolean): Turn[] => {
    const out: Turn[] = [];
    for (;;) {
      skipWs(separatorsAreSpace);
      if (i >= src.length || terminators.includes(src[i])) return out;
      const c = src[i];
      if (c === "(") {
        i++;
        const inner = parseSeq(")", true);
        if (peek() !== ")") throw new ParseError("missing ')'", i);
        i++;
        out.push(...groupSuffix(inner));
      } else if (c === "[") {
        const start = i;
        i++;
        const a = parseSeq(",:]", false);
        const sep = peek();
        if (sep !== "," && sep !== ":") throw new ParseError("expected ',' or ':' inside [ ]", i);
        i++;
        const b = parseSeq("]", false);
        if (peek() !== "]") throw new ParseError("missing ']'", start);
        i++;
        const ai = invertTurns(a);
        const expanded = sep === "," ? [...a, ...b, ...ai, ...invertTurns(b)] : [...a, ...b, ...ai];
        out.push(...groupSuffix(expanded));
      } else {
        const name = namesByLength(puzzle).find((n) => src.startsWith(n, i));
        if (name === undefined) throw new ParseError(/[A-Za-z]/.test(c) ? `unknown move '${c}'` : `unexpected character '${c}'`, i);
        const def = puzzle.moveByName.get(name)!;
        i += name.length;
        const n = readAmount();
        const amount = (((n % 4) + 4) % 4) as 0 | 1 | 2 | 3;
        if (amount !== 0) out.push({ def, amount });
      }
    }
  };

  const result = parseSeq("", true);
  if (i < src.length) throw new ParseError(`unexpected '${src[i]}'`, i);
  return result;
}

export function formatAlg(turns: readonly Turn[], puzzle: PuzzleDef = XCUBE): string {
  return turns.map((t) => turnName(t, puzzle)).join(" ");
}

/** Merge adjacent turns of the same move and drop the ones that cancel. */
export function simplify(turns: readonly Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.def === t.def) {
      const a = (last.amount + t.amount) % 4;
      out.pop();
      if (a !== 0) out.push({ def: t.def, amount: a as 1 | 2 | 3 });
    } else out.push({ ...t });
  }
  return out;
}

/** One line of a puzzle's notation help: how it is written, and what it does. */
export interface NotationRow {
  notation: string;
  meaning: string;
}

/**
 * The notation a puzzle offers, for the Lab's help (moves read only when typed, as the
 * 3x3x3's wide turns, are left out) (user-facing wording, WORDING.md), and a
 * note on which of it is the WCA's standard (WCA Regulations, Article 12) and which isn't.
 */
export function notationHelp(puzzle: PuzzleDef): { rows: NotationRow[]; note: string } {
  const has = (n: string) => puzzle.moveByName.has(n);
  const rows: NotationRow[] = [];
  if (has("r") && puzzle.moves[puzzle.moveByName.get("r")!].kind === "outer") {
    rows.push({ notation: "R L U D F B", meaning: "A side's layer of the 3x3x3 inside, with everything beyond it on that side. Clockwise, looking at that side." });
    rows.push({ notation: "r l u d f b", meaning: "An extension alone. Only when it has all 9 pieces." });
  } else {
    rows.push({ notation: "R L U D F B", meaning: "One side's layer, clockwise, looking at that side." });
  }
  if (has("E")) rows.push({ notation: "E", meaning: "The horizontal middle slice, turned like D." });
  if (has("M")) rows.push({ notation: "M", meaning: "The middle slice between L and R, turned like L." });
  if (has("S")) rows.push({ notation: "S", meaning: "The middle slice between F and B, turned like F." });
  rows.push({ notation: "x y z", meaning: "The whole puzzle, rotated like R, U and F." });
  rows.push({ notation: "R′  R2", meaning: "′ is counterclockwise, 2 a half turn." });
  rows.push({ notation: "(R U)3  (R U)′", meaning: "A group repeated, or undone: its turns in reverse order, each the other way." });
  rows.push({ notation: "[A, B]  [A: B]", meaning: "A B A′ B′, and A B A′." });
  const outer = puzzle.moves.some((m) => m.needsFull);
  const wca =
    "R L U D F B, x y z, ′ and 2 are the WCA's notation (WCA Regulations, Article 12). M, E and S are not in the Regulations; they are the usual names for the middle slices." +
    (outer ? " No standard covers the X-Cube's extensions, so r l u d f b are the Lab's own." : "");
  return { rows, note: wca };
}
