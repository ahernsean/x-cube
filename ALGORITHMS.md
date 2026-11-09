# X-Cube algorithms

Algorithms found or verified with this project's engine. Notation and terms are in
`AGENTS.md`. Hold: white up, green front. Every entry here is checked by a test in
`test/puzzle.test.ts`.

## Shape stage: one flipped single edge

**Situation.** Everything is back in the X shape except one core single edge, which is
flipped: its white or yellow sticker faces sideways. On the cube you see one cubelet
standing up above the top (or below the bottom) layer, and the extension next to it is
missing a cubelet (for example "f 8/9"), so that outer turn refuses.

**Why it happens.** On a 3x3x3, edges can only be flipped in pairs. The second flipped
edge is one of the four hidden core double edges. A double edge has outer cubelets on both
of its faces, so flipping it doesn't change the shape and you can't see it. It looks like
a lone flip.

**Fix.** Flip the single edge together with a hidden double edge. Only the shape needs to
come out right (colors and positions are solved later), so the algorithm can be much
shorter than a 3x3x3 two-edge flip.

1. Hold the cube so the flipped edge is at **top front (UF)**. Use U turns or turn the whole
   cube about its vertical axis; if the flipped edge is in the bottom layer, turn the cube
   upside down (x2) first.
2. Do **R F D R2 D' R' F'** (7 face turns). The first R can also be R'.

The result is the X shape. Colors are scrambled by it, as by any shape-stage step.

- **Shortest possible:** 7 face turns, found by exhaustive search over shapes (meet in the
  middle, face turns only). There are 8 different 7-turn solutions for this case:
  `R F D R2 D' R' F'`, `R F' D' F2 D R F'`, `R' F D R2 D' R' F'`, `R' F' D' F2 D R F'`,
  `L F D B2 U' R' F'`, `L F' D' L2 D L F'`, `L' F D B2 U' R' F'`, `L' F' D' L2 D L F'`.
- **Works on any cube in this situation:** the shape depends only on which spots are filled,
  never on colors, so a sequence that fixes this shape fixes it for every cube. Checked on
  200 differently scrambled cubes.
- **Same case at bottom right (DR)** without regripping: `F R U F2 U' F' R'` (also 7 turns;
  verified on the owner's saved position "One edge flipped").
