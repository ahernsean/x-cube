// "Lost?": finding the position a person reached when they followed turns on their own
// puzzle and slipped once, by asking about a few stickers.
//
// The person was following `turns` from `start`. Each candidate is what one slip gives: a
// turn made by another amount (the other way, or a half turn for a quarter), a turn left
// out, a turn made twice, or an inner turn made as the outer one or the reverse (R for r).
// A turn the puzzle won't make (an outer turn on an incomplete extension) is left out, as
// the person couldn't make it either. With no slip at all among them, an answer can also
// say the puzzle is where it should be. Candidates that look the same are one candidate.
//
// The person may hold the puzzle any way, so the interview first asks which center color is
// up and which is in front, and every candidate is turned whole to be held that way. Then
// each question is about one spot of the puzzle as held: the color on one face of one
// cubelet, or whether a spot of an extension holds a cubelet at all. The question asked is
// the one whose answers split the candidates left most evenly.

import { DIRS } from "./geometry.ts";
import { parseAlg, simplify } from "./notation.ts";
import { isExposed } from "./analyze.ts";
import { MOVE_BY_NAME, MOVE_DEFS, NUM_SLOTS, SLOT_POS, State, applyTurn, slotAt, type Color, type Turn } from "./puzzle.ts";

/** One way the turns may have gone. */
export interface Candidate {
  /** The turns the person made, as far as this candidate goes. */
  made: Turn[];
  /** Which turn slipped (an index into the turns followed), or -1 for none. */
  at: number;
  /** What happened to that turn. */
  slip: "none" | "amount" | "skipped" | "twice" | "layer";
  /** The position the made turns give, turned whole to the grip the person holds (once the grip is known). */
  state: State;
  /** The whole-puzzle turns that took `state` from the made turns' position to that grip. */
  grip: Turn[];
}

/** A question about one spot of the puzzle as held: a face's color, or whether a spot holds a cubelet. */
export type Question = { kind: "color"; slot: number; dir: number } | { kind: "filled"; slot: number };

/** What a candidate shows at a question's spot: a color, "black" for a face without a sticker, or "yes"/"no". */
export type Answer = Color | "black" | "yes" | "no";

const run = (start: State, turns: readonly Turn[]): State => {
  const st = start.clone();
  for (const t of turns) applyTurn(st, t); // a blocked turn is left out
  return st;
};

/** The same layer's inner turn for an outer one, and the reverse (r for R); null for slices and rotations. */
function otherLayer(t: Turn): Turn | null {
  const d = MOVE_DEFS[t.def];
  if (d.kind !== "inner" && d.kind !== "outer") return null;
  const name = d.kind === "inner" ? d.name.toLowerCase() : d.name.toUpperCase();
  const def = MOVE_BY_NAME.get(name);
  return def === undefined ? null : { def, amount: t.amount };
}

/** Every distinct-looking position one slip (or none) in `turns` from `start` gives, the right one first. */
export function slipCandidates(start: State, turns: readonly Turn[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (made: Turn[], at: number, slip: Candidate["slip"]) => {
    const state = run(start, made);
    const key = state.appearanceKey();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ made, at, slip, state, grip: [] });
  };
  add([...turns], -1, "none");
  turns.forEach((t, i) => {
    const put = (slip: Candidate["slip"], ...r: Turn[]) => add([...turns.slice(0, i), ...r, ...turns.slice(i + 1)], i, slip);
    for (const a of [1, 2, 3] as const) if (a !== t.amount) put("amount", { def: t.def, amount: a });
    put("skipped");
    put("twice", t, t);
    const o = otherLayer(t);
    if (o) put("layer", o);
  });
  return out;
}

/** The color of the center facing direction d (the core center's sticker, or its extension center's). */
export function centerColor(st: State, d: number): Color | null {
  const v = DIRS[d];
  for (const k of [2, 1]) {
    const s = slotAt([v[0] * k, v[1] * k, v[2] * k]);
    if (s >= 0 && st.occ[s] >= 0 && isExposed(st, s, d)) return st.colorAt(s, d);
  }
  return null;
}

const UP = 2, FRONT = 4;
/** The 24 ways to hold the puzzle, as whole-puzzle turns from the way it is held now. */
const HOLDS: Turn[][] = ["", "x", "x2", "x'", "z", "z'"].flatMap((a) => ["", "y", "y2", "y'"].map((b) => parseAlg(`${a} ${b}`)));

/** Turns each candidate whole so the given center colors are up and in front, as the person holds it. */
export function holdAs(cands: Candidate[], up: Color, front: Color): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    const from = c.grip.length ? run(c.state, invert(c.grip)) : c.state;
    for (const h of HOLDS) {
      const st = run(from, h);
      if (centerColor(st, UP) === up && centerColor(st, FRONT) === front) {
        // Held alike, two candidates that differ only in how the puzzle was turned whole look the same.
        const key = st.appearanceKey();
        if (!seen.has(key)) out.push({ ...c, state: st, grip: h });
        seen.add(key);
        break;
      }
    }
  }
  return out;
}

const invert = (turns: readonly Turn[]): Turn[] => [...turns].reverse().map((t) => ({ def: t.def, amount: (4 - t.amount) as 1 | 2 | 3 }));

/** What a candidate shows at a question's spot, or null where the person couldn't see it (the face is covered, or nothing is there). */
export function answerOf(st: State, q: Question): Answer | null {
  if (q.kind === "filled") return st.occ[q.slot] >= 0 ? "yes" : "no";
  if (st.occ[q.slot] < 0 || !isExposed(st, q.slot, q.dir)) return null;
  return st.colorAt(q.slot, q.dir) ?? "black";
}

const outerSlot = (s: number) => SLOT_POS[s].some((c) => Math.abs(c) === 2);

/**
 * How easy a spot is to look at, held as the person holds it: the top, the front and the
 * right are easiest, the bottom and the back hardest. Smaller is easier.
 */
function spotCost(q: Question): number {
  const p = SLOT_POS[q.slot];
  // The way the spot is looked at: the face's direction, or straight in at an extension spot.
  const v = q.kind === "color" ? DIRS[q.dir] : p.map((c) => (Math.abs(c) === 2 ? Math.sign(c) : 0));
  let cost = 0;
  if (v[1] < 0 || p[1] < 0) cost += 2; // the bottom
  if (v[2] < 0 || p[2] < 0) cost += 1; // the back
  if (v[0] < 0) cost += 0.5; // the left
  if (q.kind === "filled") cost += 3; // colors first: they are what the person reads easily
  return cost;
}

/** Every question worth asking: color spots every candidate shows, and extension spots some fill and some don't. */
function questions(cands: Candidate[]): Question[] {
  const out: Question[] = [];
  for (let s = 0; s < NUM_SLOTS; s++) {
    for (let d = 0; d < 6; d++) out.push({ kind: "color", slot: s, dir: d });
    if (outerSlot(s)) out.push({ kind: "filled", slot: s });
  }
  return out.filter((q) => cands.every((c) => answerOf(c.state, q) !== null));
}

/**
 * The question that splits the candidates best: the fewest left after the worst answer,
 * then the easiest spot to look at. Null when no question tells them apart (or one is left).
 */
export function bestQuestion(cands: Candidate[]): Question | null {
  if (cands.length < 2) return null;
  let best: Question | null = null, bestWorst = Infinity, bestCost = Infinity;
  for (const q of questions(cands)) {
    const groups = new Map<Answer, number>();
    for (const c of cands) {
      const a = answerOf(c.state, q)!;
      groups.set(a, (groups.get(a) ?? 0) + 1);
    }
    if (groups.size < 2) continue;
    const worst = Math.max(...groups.values());
    const cost = spotCost(q);
    if (worst < bestWorst || (worst === bestWorst && cost < bestCost)) (best = q), (bestWorst = worst), (bestCost = cost);
  }
  return best;
}

/** The answers the candidates give to q, each once, in a fixed order. */
export function answersTo(cands: Candidate[], q: Question): Answer[] {
  const order: Answer[] = ["W", "Y", "G", "B", "R", "O", "black", "yes", "no"];
  const set = new Set(cands.map((c) => answerOf(c.state, q)));
  return order.filter((a) => set.has(a));
}

/** The candidates that give answer a to q. */
export function narrow(cands: Candidate[], q: Question, a: Answer): Candidate[] {
  return cands.filter((c) => answerOf(c.state, q) === a);
}

/** The turns that take a candidate's position, held as the person holds it, back to `start` as it was held. */
export function wayBack(c: Candidate): Turn[] {
  return simplify(invert([...c.made, ...c.grip]));
}
