# X-Cube algorithms

Algorithms found or verified with this project's engine. Notation and terms are in
`AGENTS.md`. Hold: white up, and the front is whichever side the Lab's hold line names for
the position. On a solved puzzle that is green, but slice turns (H, M, S) move the side
centers, so on a scrambled puzzle it can be another color. Every entry here is checked by a
test in `test/puzzle.test.ts` or `test/algorithms.test.ts`.

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

## Shape stage: one flipped bottom edge, white top already solved

**Situation.** The white top is solved (all 21 white stickers up), but the puzzle is out of
shape because one core single edge in the bottom layer is flipped: its yellow sticker faces
sideways instead of down, the cubelet below it sticks out, and the extension beside it is
short one cubelet (for example "f 8/9"). This is the same lone flip as above (its partner is
a hidden double edge), found after solving the top.

**Fix.** Hold the cube so the flipped edge is at **bottom front (DF)**, its yellow facing you,
white up. Then do **R F H2 F2 H F R'** (7 turns; H is the middle slice, turned like U).

The result is the X shape with the white top still all white. The other faces' colors are
rearranged. Found by search on the owner's saved position "Confusing edge"; the shorter
fixes above work too but scramble part of the white top.

**Holding the cube.** The H turns move the side centers, so after a sequence with H in it a
side center no longer marks the side it marked before. Hold the cube as the Lab's hold line
says for the position (its colors come from the centers where they are now), and never
regrip by a center between steps. Holding the cube turned half around (y2) instead turns
the opposite layers: on "Confusing edge" that makes a second flipped edge at bottom back.

The Lab lists this algorithm under Algorithms, with "Confusing edge" as its position. `test/algorithms.test.ts` checks every listed algorithm from its position.
