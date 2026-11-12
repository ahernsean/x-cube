// Algorithms found or verified with this engine, each with a position it applies to.
// The Lab lists them so one can be loaded (its position becomes the start, its turns are
// ready to play); ALGORITHMS.md describes them in full; test/algorithms.test.ts checks
// that each one, from its position, gives the stated result.

import { parseAlg } from "./notation.ts";
import { State, applyTurns } from "./puzzle.ts";
import { decodeState } from "./serialize.ts";

export interface KnownAlgorithm {
  id: string;
  name: string;
  /** When to use it, in the owner's terms. */
  situation: string;
  alg: string;
  /** A position it applies to. */
  start: () => State;
  /** What it must achieve from `start` (checked by the tests). */
  result: "x-shape" | "x-shape, white top kept" | "3-cycle";
}

const after = (setup: string) => () => {
  const st = State.solved();
  applyTurns(st, parseAlg(setup));
  return st;
};

export const KNOWN_ALGORITHMS: readonly KnownAlgorithm[] = [
  {
    id: "flip-uf",
    name: "Flipped edge at top front",
    situation: "In shape except one core edge at top front (UF), flipped: it stands up above the top.",
    alg: "R F D R2 D' R' F'",
    start: after("(R F D R2 D' R' F')'"),
    result: "x-shape",
  },
  {
    id: "flip-dr",
    name: "Flipped edge at bottom right",
    situation: "In shape except one core edge at bottom right (DR), flipped.",
    alg: "F R U F2 U' F' R'",
    // The owner's saved position "One edge flipped" (first version).
    start: () =>
      decodeState(
        "X1:7k4qIb6h5hYwwc2kTc......qhphZcMaNalsskthukFm0hzhkrWaXa............chbhaaor8pgefeendsDjVrjcihhh........vb..GvnaLdKh1rOkPkQqRcHfAjUryaxr3p......9e..CoBqEhScmmruJm",
      ),
    result: "x-shape",
  },
  {
    id: "flip-df-white-top",
    name: "Flipped bottom edge, white top solved",
    situation:
      "The white top is solved and one core edge at bottom front (DF) is flipped: its yellow faces you. Keeps the white top. Hold as the hold line says, and don't regrip by a center mid-way: the H turns move the side centers.",
    alg: "R F H2 F2 H F R'",
    // The owner's saved position "Confusing edge", reached on the real cube.
    start: () => decodeState("DSJA IIRV YOOL JKWR JHSF JKCF UPIK VOSU AIVY ZFOB UFZC"),
    result: "x-shape, white top kept",
  },
  {
    id: "baum-edge",
    name: "Edge 3-cycle (Baum)",
    situation: "Cycles three outer edges and keeps the X shape.",
    alg: "R' S' R b R' S R b'",
    start: () => State.solved(),
    result: "3-cycle",
  },
  {
    id: "baum-corner",
    name: "Corner 3-cycle (Baum)",
    situation: "Cycles three X-face corners and keeps the X shape.",
    alg: "R' F' R b R' F R b'",
    start: () => State.solved(),
    result: "3-cycle",
  },
  {
    id: "corner-cycle",
    name: "Corner 3-cycle",
    situation: "Cycles three X-face corners (Fx.UL, Rx.UF, Rx.DF) and keeps the X shape. Baum's, turned a quarter around: no back turns.",
    alg: "(F' L' F) r (F' L F) r'",
    start: () => State.solved(),
    result: "3-cycle",
  },
  {
    id: "corner-cycle-mirror",
    name: "Corner 3-cycle, mirrored",
    situation: "Cycles three X-face corners (Lx.DF, Fx.UR, Lx.UF) and keeps the X shape. The one above, left for right: R inside, for a right hand.",
    alg: "(F R F') l' (F R' F') l",
    start: () => State.solved(),
    result: "3-cycle",
  },
  {
    id: "edge-cycle",
    name: "Edge 3-cycle",
    situation: "Cycles three extension edges (Fx.L, Rx.F, Rx.D) and keeps the X shape. Baum's, turned a quarter around: no back or S turns.",
    alg: "(F' M' F) r (F' M F) r'",
    start: () => State.solved(),
    result: "3-cycle",
  },
  {
    id: "edge-cycle-mirror",
    name: "Edge 3-cycle, mirrored",
    situation: "Cycles three extension edges (Lx.D, Fx.R, Lx.F) and keeps the X shape. The one above, left for right.",
    alg: "(F M' F') l' (F M F') l",
    start: () => State.solved(),
    result: "3-cycle",
  },
];

