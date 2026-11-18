// The step guide's planning worker (see planner.ts): given a position's state code and the
// order, it posts each step of the solve as it is found, then the end or why it stopped.
import type { Mode } from "../core/solve.ts";
import { planMessages } from "./planner.ts";

const scope = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; code: string; mode: Mode }>) => void) | null; postMessage(m: unknown): void };
scope.onmessage = (e) => {
  for (const m of planMessages(e.data.id, e.data.code, e.data.mode)) scope.postMessage(m);
};
