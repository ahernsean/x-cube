// Command-line driver.
//
//   node src/cli/xc.ts show  "<alg>" [--from "<setup alg>"] [--state <code>]
//   node src/cli/xc.ts steps "<alg>" [--from ...]      show status after each turn
//   node src/cli/xc.ts effect "<alg>" [--from ...]     cycles / twists caused by alg
//   node src/cli/xc.ts order "<alg>" [--from ...]      repeats until the start state looks the same
//   node src/cli/xc.ts encode "<alg>"                  print a state code for solved + alg
//   node src/cli/xc.ts solve "<alg>" [--state <code>] [--mode kinds|layers]
//                                                      steps from the position after alg to solved

import { effect, isHomeX, netView, statusLine } from "../core/analyze.ts";
import { formatAlg, parseAlg } from "../core/notation.ts";
import { State, applyTurns, turnName } from "../core/puzzle.ts";
import { decodeState, encodeState } from "../core/serialize.ts";
import { solveSteps } from "../core/solve.ts";

function startState(args: Map<string, string>): State {
  const st = args.has("--state") ? decodeState(args.get("--state")!) : State.solved();
  if (args.has("--from")) {
    const r = applyTurns(st, parseAlg(args.get("--from")!));
    if (!r.ok) fail(`setup failed: ${r.error}`);
  }
  return st;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function main(argv: string[]) {
  const [cmd, alg = "", ...rest] = argv;
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) args.set(rest[i], rest[i + 1]);
  if (!cmd) fail("usage: xc <show|steps|effect|order|encode|solve> \"<alg>\" [--from \"<alg>\"] [--state <code>]");
  const turns = parseAlg(alg);
  const start = startState(args);
  const st = start.clone();

  switch (cmd) {
    case "show":
    case "effect": {
      const r = applyTurns(st, turns);
      console.log(`alg: ${formatAlg(turns)}  (${turns.length} turns)`);
      if (!r.ok) console.log(`STOPPED: ${r.error}`);
      console.log(statusLine(st));
      if (cmd === "show") console.log("\n" + netView(st) + "\n");
      const e = effect(start, st);
      console.log(`shape unchanged: ${e.shapeSame}; visible face changes: ${e.visibleChanges}`);
      console.log(`cubelets moved: ${e.moved.length}`);
      for (const c of e.cycles) console.log("  cycle: " + c);
      for (const t of e.twisted) console.log("  twisted in place: " + t);
      break;
    }
    case "steps": {
      for (let i = 0; i < turns.length; i++) {
        const r = applyTurns(st, [turns[i]]);
        console.log(`${String(i + 1).padStart(3)} ${turnName(turns[i]).padEnd(3)} ${r.ok ? statusLine(st) : "BLOCKED: " + r.error}`);
        if (!r.ok) break;
      }
      break;
    }
    case "order": {
      const target = start.appearanceKey();
      for (let n = 1; n <= 5000; n++) {
        const r = applyTurns(st, turns);
        if (!r.ok) fail(`repeat ${n}: ${r.error}`);
        if (st.appearanceKey() === target) {
          console.log(`looks identical to the start after ${n} repetitions`);
          return;
        }
      }
      console.log("no return within 5000 repetitions");
      break;
    }
    case "encode": {
      const r = applyTurns(st, turns);
      if (!r.ok) fail(r.error!);
      console.log(encodeState(st));
      console.log(isHomeX(st) ? "(X shape)" : "(not X shape)");
      break;
    }
    case "solve": {
      const r = applyTurns(st, turns);
      if (!r.ok) fail(r.error!);
      let steps;
      try {
        const mode = args.get("--mode") ?? "kinds";
        if (mode !== "kinds" && mode !== "layers") fail(`unknown mode ${mode} (use kinds or layers)`);
        steps = solveSteps(st, mode);
      } catch (e) {
        fail((e as Error).message);
      }
      if (!steps.length) console.log("already solved");
      steps.forEach((step, i) => console.log(`${String(i + 1).padStart(2)} ${step.stage.padEnd(13)} ${step.alg}\n                 ${step.goal}`));
      if (steps.length) console.log(`${steps.reduce((n, step) => n + step.turns.length, 0)} turns in ${steps.length} ${steps.length === 1 ? "step" : "steps"}`);
      break;
    }
    default:
      fail(`unknown command ${cmd}`);
  }
}

main(process.argv.slice(2));
