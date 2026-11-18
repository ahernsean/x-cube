// The step guide's plan: the whole solve from a position, found a step at a time, in a Web
// Worker where the page can start one, so the page stays responsive while the solver works
// (a step can take seconds). Where no worker starts, the steps are found on the page, one
// per task, so the page can draw between them.
import type { State } from "../core/puzzle.ts";
import { applyTurns } from "../core/puzzle.ts";
import { decodeState, encodeState } from "../core/serialize.ts";
import { planSteps, type Mode, type SolveStep } from "../core/solve.ts";

/** The worker's script, put in by scripts/build-web.ts. */
declare const PLAN_WORKER_JS: string;

export interface Plan {
  mode: Mode;
  /** The steps planned so far, in order. */
  steps: SolveStep[];
  /** The state code of the position each step starts from, then of the one after the last step planned. */
  at: string[];
  /** Every step is planned: the last one solves the puzzle. */
  done: boolean;
  /** Why the step from the last position in `at` can't be given, if it can't. */
  error: string;
}

/** What planning reports: a step and the position after it, the end, or why it stopped. */
export type PlanMessage = { id: number } & ({ step: SolveStep; at: string } | { done: true } | { error: string });

/** The plan from the position with this state code, one message per step found. */
export function* planMessages(id: number, code: string, mode: Mode): Generator<PlanMessage, void, void> {
  try {
    const st = decodeState(code);
    for (const step of planSteps(st, mode)) {
      applyTurns(st, step.turns);
      yield { id, step, at: encodeState(st) };
    }
    yield { id, done: true };
  } catch (e) {
    yield { id, error: (e as Error).message };
  }
}

export class Planner {
  plan: Plan | null = null;
  /** Called after each step planned, and when the plan ends. */
  onChange = () => {};
  /** Where the plan is being made: in a worker, on the page, or nowhere yet. */
  where: "worker" | "page" | "" = "";
  /** Plan on the page even where a worker could start (for the browser tests). */
  inPage = false;
  private id = 0;
  private worker: Worker | null = null;
  private workerUrl = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Planning is under way: there are steps still to find. */
  get running(): boolean {
    return !!this.plan && !this.plan.done && !this.plan.error;
  }

  /** Which step of the plan starts from the position with this state code, in this order: its index (the steps' count at the plan's end), or -1. */
  indexOf(code: string, mode: Mode): number {
    return this.plan?.mode === mode ? this.plan.at.indexOf(code) : -1;
  }

  /** Plans the solve from st, in place of any plan before. */
  start(st: State, mode: Mode) {
    this.stop();
    const code = encodeState(st);
    this.plan = { mode, steps: [], at: [code], done: false, error: "" };
    const id = this.id;
    if (!this.inPage && this.startWorker(id, code, mode)) return;
    this.planHere(id, code, mode);
  }

  /** Stops planning. A plan not yet done is dropped, so a later one starts afresh. */
  stop() {
    this.id++;
    this.worker?.terminate();
    this.worker = null;
    clearTimeout(this.timer);
    if (this.running) this.plan = null;
    this.where = "";
  }

  private take(m: PlanMessage) {
    const plan = this.plan;
    if (m.id !== this.id || !plan) return;
    if ("step" in m) {
      plan.steps.push(m.step);
      plan.at.push(m.at);
    } else if ("done" in m) plan.done = true;
    else plan.error = m.error;
    if (!this.running) {
      this.worker?.terminate();
      this.worker = null;
    }
    this.onChange();
  }

  private startWorker(id: number, code: string, mode: Mode): boolean {
    try {
      if (typeof Worker === "undefined" || !PLAN_WORKER_JS) return false;
      this.workerUrl ||= URL.createObjectURL(new Blob([PLAN_WORKER_JS], { type: "text/javascript" }));
      const worker = new Worker(this.workerUrl);
      worker.onmessage = (e: MessageEvent<PlanMessage>) => this.take(e.data);
      // A page that doesn't allow the worker (a content security policy) tells only by an
      // error event; the plan then goes on on the page from where it got to.
      worker.onerror = (e) => {
        e.preventDefault();
        if (id !== this.id || !this.plan) return;
        worker.terminate();
        this.worker = null;
        this.inPage = true;
        const plan = this.plan;
        this.planHere(id, plan.at[plan.at.length - 1], mode);
      };
      worker.postMessage({ id, code, mode });
      this.worker = worker;
      this.where = "worker";
      return true;
    } catch {
      this.inPage = true;
      return false;
    }
  }

  private planHere(id: number, code: string, mode: Mode) {
    this.where = "page";
    const messages = planMessages(id, code, mode);
    const next = () => {
      if (id !== this.id) return;
      const m = messages.next();
      if (m.done) return;
      this.take(m.value);
      if (this.running) this.timer = setTimeout(next);
    };
    // The page draws first: a step found on the page holds it until the step is found.
    requestAnimationFrame(() => (this.timer = setTimeout(next)));
  }
}
