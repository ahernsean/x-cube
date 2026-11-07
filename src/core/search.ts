// Algorithm search.
//
// Iterative-deepening depth-first search over turn sequences, with:
// - canonical ordering: turns on the same axis commute (they are rotations about
//   the same axis, and none of them changes whether another same-axis outer turn
//   is allowed), so consecutive same-axis turns are only tried in one order;
// - optional pruning by a lower-bound function (admissible heuristic);
// - a goal predicate, so sub-problems can be posed with "don't care" parts.

import { MOVE_DEFS, State, applyTurn, blockedReason, type Turn } from "./puzzle.ts";

export interface SearchOptions {
  /** Which moves to use (names like "R", "r", "H"). Default: all inner, outer and H/M/S slices. */
  moves?: string[];
  /** Amounts to allow per move (1 = clockwise, 2 = half, 3 = counterclockwise). */
  amounts?: (1 | 2 | 3)[];
  maxDepth: number;
  /** Stop after this many solutions (default 1). Solutions are reported in order of length. */
  maxSolutions?: number;
  /** Keep searching this many extra depths after the first solution length (default 0). */
  extraDepth?: number;
  /** Lower bound on remaining turns; return 0 when unknown. Must never overestimate. */
  heuristic?: (st: State) => number;
  /** Give up after this many nodes (default 2e8). */
  nodeLimit?: number;
  /** Called with progress updates. */
  onDepth?: (depth: number, nodes: number) => void;
}

export interface SearchResult {
  solutions: Turn[][];
  nodes: number;
  complete: boolean; // false if stopped by nodeLimit
}

export const DEFAULT_SEARCH_MOVES = ["R", "L", "U", "D", "F", "B", "r", "l", "f", "b", "u", "d", "M", "H", "S"];

export function search(start: State, goal: (st: State) => boolean, opts: SearchOptions): SearchResult {
  const names = opts.moves ?? DEFAULT_SEARCH_MOVES;
  const amounts = opts.amounts ?? [1, 2, 3];
  const turns: Turn[] = [];
  for (const n of names) {
    const def = MOVE_DEFS.findIndex((d) => d.name === n);
    if (def < 0) throw new Error(`unknown move ${n}`);
    for (const a of amounts) turns.push({ def, amount: a });
  }
  const maxSolutions = opts.maxSolutions ?? 1;
  const nodeLimit = opts.nodeLimit ?? 2e8;
  const h = opts.heuristic ?? (() => 0);
  const stack: State[] = [];
  for (let i = 0; i <= opts.maxDepth; i++) stack.push(start.clone());
  const path: Turn[] = [];
  const solutions: Turn[][] = [];
  let nodes = 0;
  let stop = false;

  const dfs = (depth: number, remaining: number): void => {
    const st = stack[depth];
    if (remaining === 0) {
      if (goal(st)) {
        solutions.push(path.slice());
        if (solutions.length >= maxSolutions) stop = true;
      }
      return;
    }
    if (h(st) > remaining) return;
    const prev = depth > 0 ? MOVE_DEFS[path[depth - 1].def] : null;
    for (const t of turns) {
      const d = MOVE_DEFS[t.def];
      if (prev) {
        if (prev === d) continue;
        if (prev.axis === d.axis && prev.layerOrder >= d.layerOrder) continue;
      }
      if (blockedReason(st, t)) continue;
      const next = stack[depth + 1];
      next.copyFrom(st);
      applyTurn(next, t);
      nodes++;
      if (nodes > nodeLimit) {
        stop = true;
        return;
      }
      path.push(t);
      dfs(depth + 1, remaining - 1);
      path.pop();
      if (stop) return;
    }
  };

  let firstFound = -1;
  for (let depth = 0; depth <= opts.maxDepth && !stop; depth++) {
    if (firstFound >= 0 && depth > firstFound + (opts.extraDepth ?? 0)) break;
    dfs(0, depth);
    opts.onDepth?.(depth, nodes);
    if (solutions.length && firstFound < 0) firstFound = depth;
  }
  return { solutions, nodes, complete: nodes <= nodeLimit };
}
