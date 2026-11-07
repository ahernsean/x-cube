// Move notation parser.
//
//   R U R' U2         face turns; ' = counterclockwise, 2 = half turn (2' is accepted too)
//   r l f b (u d)     outer turns of an extension alone
//   M S H E           slices (H turns like U, E turns like D)
//   x y z             whole-puzzle rotations
//   (R U2)5           repeat a group: also (R U2)x5, (R U2)*5, (R U2) x 5
//   (R U)'            inverse of a group
//   [A, B]            commutator  = A B A' B'
//   [A: B]            conjugate   = A B A'
// Commas and periods outside brackets are treated as spaces.

import { MOVE_BY_NAME, invertTurns, turnName, type Turn } from "./puzzle.ts";

export class ParseError extends Error {
  pos: number;
  constructor(msg: string, pos: number) {
    super(`${msg} (at position ${pos + 1})`);
    this.pos = pos;
  }
}

export function parseAlg(src: string): Turn[] {
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
    if (peek() === "'" || peek() === "’") {
      i++;
      n = -n;
    }
    return n;
  };

  // Suffix after a group: optional prime, optional repeat count.
  const groupSuffix = (seq: Turn[]): Turn[] => {
    let out = seq;
    if (peek() === "'" || peek() === "’") {
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
        const m = /^[A-Za-z]/.exec(src.slice(i));
        if (!m) throw new ParseError(`unexpected character '${c}'`, i);
        const name = m[0];
        const def = MOVE_BY_NAME.get(name);
        if (def === undefined) throw new ParseError(`unknown move '${name}'`, i);
        i += 1;
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

export function formatAlg(turns: readonly Turn[]): string {
  return turns.map(turnName).join(" ");
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
