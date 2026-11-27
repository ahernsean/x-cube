// "Lost?": finding the position a person reached when they followed turns on their own
// puzzle and slipped once, by asking about a few stickers.
//
// The person was following `turns` from `start`, up to the turn they say they made last.
// Each candidate is what one slip gives: a turn made by another amount (the other way, or a
// half turn for a quarter), a turn left out, a turn made twice, an inner turn made as the
// outer one or the reverse (R for r), or as another face's (F for R).
// A turn the puzzle won't make (an outer turn on an incomplete extension) is left out, as
// the person couldn't make it either. With no slip at all among them, an answer can also
// say the puzzle is where it should be. Candidates that look the same are one candidate.
//
// The person may hold the puzzle any way, so the interview first asks which center color is
// up and which is in front, and every candidate is turned whole to be held that way. Then
// each question is about one spot of the puzzle as held: the color on one face of one
// piece, or whether a spot of an extension holds a piece at all. The question asked is
// the one whose answers split the candidates left most evenly.

import { DIRS } from "./geometry.ts";
import { parseAlg, simplify } from "./notation.ts";
import { isExposed } from "./analyze.ts";
import { MOVE_BY_NAME, MOVE_DEFS, NUM_SLOTS, SLOT_POS, State, applyTurn, slotAt, type Color, type Turn } from "./puzzle.ts";

/** One way the turns may have gone. */
export interface Candidate {
  /** The turns the person made, as far as this candidate goes: only those the puzzle took (a slip can leave a later outer turn refused). */
  made: Turn[];
  /** What the slipped turn was made as (nothing for a turn left out or no slip). */
  as: Turn[];
  /** A second slip, later in the turns (two stacked mistakes), if this candidate has one. */
  second?: { at: number; slip: Exclude<Candidate["slip"], "none">; as: Turn[] };
  /** Which turn slipped (an index into the turns followed), or -1 for none. */
  at: number;
  /** What happened to that turn. */
  slip: "none" | "amount" | "skipped" | "twice" | "layer" | "face";
  /** The position the made turns give, turned whole to the grip the person holds (once the grip is known). */
  state: State;
  /** The whole-puzzle turns that took `state` from the made turns' position to that grip. */
  grip: Turn[];
  /** The turn followed that the person made last (an index into the turns followed). */
  last: number;
}

/** A question about one spot of the puzzle as held: a face's color, or whether a spot holds a piece. */
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

/** The other faces' inner turns, by the same amount (F for R): a turn made on the wrong face. Empty for any other kind of turn. */
function otherFaces(t: Turn): Turn[] {
  if (MOVE_DEFS[t.def].kind !== "inner") return [];
  return MOVE_DEFS.flatMap((d, def) => (d.kind === "inner" && def !== t.def ? [{ def, amount: t.amount }] : []));
}

/**
 * Every distinct-looking position one slip (or none) in `turns` from `start` gives, the
 * right one first. Slips are looked for in the turns from index `from` on.
 */
/** Every way turn t can slip: what it is made as instead (nothing for left out). */
function slipsOf(t: Turn): { slip: Exclude<Candidate["slip"], "none">; as: Turn[] }[] {
  const out: { slip: Exclude<Candidate["slip"], "none">; as: Turn[] }[] = [];
  for (const a of [1, 2, 3] as const) if (a !== t.amount) out.push({ slip: "amount", as: [{ def: t.def, amount: a }] });
  out.push({ slip: "skipped", as: [] });
  out.push({ slip: "twice", as: [t, t] });
  const o = otherLayer(t);
  if (o) out.push({ slip: "layer", as: [o] });
  for (const f of otherFaces(t)) out.push({ slip: "face", as: [f] });
  return out;
}

export function slipCandidates(start: State, turns: readonly Turn[], from = 0, seen = new Set<string>()): Candidate[] {
  const out: Candidate[] = [];
  const add = (tried: Turn[], at: number, slip: Candidate["slip"], as: Turn[], second?: Candidate["second"]) => {
    const state = start.clone();
    const made = tried.filter((t) => applyTurn(state, t));
    const key = state.appearanceKey();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ made, as, at, slip, state, grip: [], last: turns.length - 1, ...(second ? { second } : {}) });
  };
  add([...turns], -1, "none", []);
  turns.forEach((t, i) => {
    if (i < from) return;
    for (const v of slipsOf(t)) add([...turns.slice(0, i), ...v.as, ...turns.slice(i + 1)], i, v.slip, v.as);
  });
  return out;
}

/**
 * Two slips in the turns from index `from` on (two stacked mistakes: a slip, then another
 * while putting it right), the person stopping after each of `ends` (indices into `turns`;
 * the last turn if none are given), with both slips within `window` turns up to where they
 * stopped. Looks already in `seen` (from one slip, say) are left out.
 */
export function twoSlipCandidates(start: State, turns: readonly Turn[], from = 0, seen = new Set<string>(), ends: readonly number[] = [turns.length - 1], window = Infinity): Candidate[] {
  return [...twoSlips(start, turns, from, seen, ends, window)];
}

/** `twoSlipCandidates` one at a time, so a search for one of them can stop when it finds it (`seen` null: no looks left out). */
export function* twoSlips(start: State, turns: readonly Turn[], from = 0, seen: Set<string> | null = new Set<string>(), ends: readonly number[] = [turns.length - 1], window = Infinity): Generator<Candidate> {
  const stops = [...new Set(ends)].filter((e) => e >= 0 && e < turns.length).sort((x, y) => x - y);
  if (!stops.length) return;
  const last = stops[stops.length - 1];
  for (let i = Math.max(0, from, stops[0] + 1 - window); i < last; i++) {
    // The position before turn i, once: the second slip's variants share it.
    const before = start.clone();
    for (const t of turns.slice(0, i)) applyTurn(before, t);
    // The stops this first slip is within `window` turns of.
    const far = Math.min(last, i + window - 1);
    for (const a of slipsOf(turns[i])) {
      for (let j = i + 1; j <= far; j++) {
        for (const b of slipsOf(turns[j])) {
          // Turn by turn after the second slip, a candidate at each stop it may have been.
          const state = before.clone();
          const made = [...turns.slice(0, i), ...[...a.as, ...turns.slice(i + 1, j), ...b.as].filter((t) => applyTurn(state, t))];
          for (let e = j; e <= far; e++) {
            if (e > j && applyTurn(state, turns[e])) made.push(turns[e]);
            if (!stops.includes(e) || i < e + 1 - window) continue;
            // Looks seen before are left out (`seen` null: every one, for a search that stops at the first it wants).
            if (seen) {
              const key = state.appearanceKey();
              if (seen.has(key)) continue;
              seen.add(key);
            }
            yield { made: [...made], as: a.as, at: i, slip: a.slip, second: { at: j, slip: b.slip, as: b.as }, state: state.clone(), grip: [], last: e };
          }
        }
      }
    }
  }
}

/**
 * The first of `cands` that looks like `target` held some way, turned to be held as the
 * target is (by its up and front centers): one search, without turning every candidate.
 */
export function findAsHeld(cands: Iterable<Candidate>, target: State): Candidate | undefined {
  const up = centerColor(target, UP), front = centerColor(target, FRONT);
  if (!up || !front) return undefined;
  const held = HOLDS.map((h) => run(target, h));
  // A cheap first look (the colors facing away on the extension spots) before the full one.
  const prints = new Set(held.map(outerPrint));
  const keys = new Set(held.map((st) => st.appearanceKey()));
  const want = target.appearanceKey();
  for (const c of cands) if (prints.has(outerPrint(c.state)) && keys.has(c.state.appearanceKey())) return holdAs([c], up, front).find((h) => h.state.appearanceKey() === want);
  return undefined;
}

/** Each extension spot and the direction its face away from the core points. */
const OUTER_FACES: [number, number][] = [...Array(NUM_SLOTS).keys()].flatMap((s) => {
  const p = SLOT_POS[s];
  const axis = p.findIndex((c) => Math.abs(c) === 2);
  return axis < 0 ? [] : [[s, axis * 2 + (p[axis] < 0 ? 1 : 0)] as [number, number]];
});
/** What the extension spots show facing away from the core: equal for positions that look alike. */
function outerPrint(st: State): string {
  let k = "";
  for (const [s, d] of OUTER_FACES) k += st.occ[s] < 0 ? "_" : (st.colorAt(s, d) ?? "-");
  return k;
}

/**
 * The candidates when the person may misremember which turn they made last: one slip (or
 * none) in the turns up to each of `ends`, in that order (the turn they named first), and
 * no slip up to each of `stops` (stopping anywhere in a step is easy to misremember).
 * Candidates that look alike are one, the earlier kept.
 */
export function endCandidates(start: State, turns: readonly Turn[], ends: readonly number[], stops: readonly number[] = []): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const keep = (c: Candidate) => {
    const key = c.state.appearanceKey();
    if (!seen.has(key)) seen.add(key), out.push(c);
  };
  for (const j of ends) if (j >= 0 && j < turns.length) slipCandidates(start, turns.slice(0, j + 1)).forEach(keep);
  for (const j of stops) if (j >= 0 && j < turns.length) keep({ made: turns.slice(0, j + 1), as: [], at: -1, slip: "none", state: run(start, turns.slice(0, j + 1)), grip: [], last: j });
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
/** Whether a spot can be empty in some shape: an extension spot can, a core spot never. */
export const canBeEmpty = outerSlot;

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

/**
 * The turns that take a candidate's position, held as the person holds it, back to where
 * its made turns from index `from` began (back to `start`, as it was held, by default).
 */
export function wayBack(c: Candidate, from = 0): Turn[] {
  return simplify(invert([...c.made.slice(from), ...c.grip]));
}
