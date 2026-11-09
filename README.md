# X-Cube simulator

**New here (person or agent)? Start with [AGENTS.md](AGENTS.md)** for the terminology,
notation, cubelet names and code map.

A simulator and algorithm-search toolkit for the X-Cube (Moving Parts, 2013): a 3x3x3
with 3x3 extensions on four sides that turn on their own only when complete.

- `src/core/` is the engine (TypeScript, no dependencies). The CLI and the browser viewer share it.
- `src/cli/xc.ts` is the command-line driver.
- `src/web/` is the browser viewer ("X-Cube Lab"). It is built into one HTML file.
- `test/` holds the tests. They encode the behavior confirmed on the physical puzzle.

## Orientation and colors

Hold the puzzle with the X-faces up and down: white up, green front. That leaves
red right, orange left and blue back. The colors are set in `FACE_COLOR` in
`src/core/puzzle.ts`, so change them there if your cube differs.

## Notation

| Notation | Meaning |
|---|---|
| `R L U D F B` | Inner turns: the 3x3x3 layer plus everything beyond it, including the extension. Clockwise looking at that face. Always allowed. |
| `r l f b` (`u d`) | Outer turns: the extension alone. Allowed only when all 9 of its cubelets are present. |
| `H` | The horizontal middle layer, turned like `U`. `E` is accepted as `H'`. |
| `M` | The middle layer between L and R, turned like `L`. |
| `S` | The middle layer between F and B, turned like `F`. |
| `x y z` | The whole puzzle, turned like `R`, `U` and `F`. |
| `'` and `2` | Counterclockwise and half turn. |
| `(A)5`, `(A)x5`, `(A)*5` | Repeat a group. |
| `(A)'` | Inverse of a group. |
| `[A, B]` | Commutator: `A B A' B'`. |
| `[A: B]` | Conjugate: `A B A'`. |

**Grip difference from Dave Baum's page.** Baum holds the X-faces front and back, so his
letters name different layers. Translated to the white-up grip:
- his `F U B D` are our `U B D F`, and `L R` are unchanged;
- his `u` is our `b`;
- his `H` is our `S'`.

His edge 3-cycle becomes `R' S' R b R' S R b'`, and his corner 3-cycle becomes
`R' F' R b R' F R b'`. Both are verified in the tests.

## Model

- **Slots.** There are 80 slots: every lattice point in -2..2 with at most one coordinate equal to ±2, minus the solid center.
- **Cubelets.** There are 62:
  - 8 core corners and 8 core single edges, each with one white or yellow sticker;
  - 4 core double edges, with no stickers;
  - 16 outer corners and 16 outer edges;
  - 6 core centers and 4 extension centers. Each extension center is fused to the core center behind it.
- **Solved.** The puzzle is in an X shape, and every exposed face in each direction shows one color.

The tests check these invariants:
- An outer cubelet's outward color never changes. That's why two outer cubelets with the same three colors are not interchangeable.
- Outer turns never change the shape.
- Fused centers never separate.

## Commands

```
npm install
npm test
node src/cli/xc.ts show   "R' S' R b R' S R b'"   # status, flat view, cycles
node src/cli/xc.ts steps  "R U R' U'"             # status after every turn
node src/cli/xc.ts effect "[R' F' R, b]"          # which cubelets moved
node src/cli/xc.ts order  "R U"                   # repetitions until it looks the same
node src/cli/xc.ts show "U" --from "R"            # start from solved + setup
node src/cli/xc.ts show "U" --state X1:...        # start from a saved state code
node scripts/build-web.ts                         # build dist/x-cube-lab.html
node scripts/smoke-web.mjs                        # browser smoke test of the built Lab (needs Playwright)
```

In cycle output, `A -> B` means the cubelet that was in slot A is now in slot B. Slot names:
- Core slots use standard names: `UFR`, `UF`, `U`.
- Extension slots are named `<face>x.<position>`. For example, `Fx.UR` is the up-right cubelet of the front extension, and `Ux.F` is the front spot of the (normally empty) top extension.

## Search

`src/core/search.ts` is an iterative-deepening search that only tries same-axis turns in
one order. Goals come from `src/core/goals.ts`, which compares how slots look, so you can
leave "don't care" regions out of the mask. It runs at roughly 2 to 3 million positions per
second in Node, which is practical to about 7 turns. Deeper searches will need distance
tables or meet-in-the-middle.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- **Typecheck, unit tests, build** on Node 22 and 24.
- **Browser smoke test:** builds the Lab, opens it in headless Chromium (Playwright
  1.64.1, installed only in CI) and checks that it loads without page errors, that turns
  play, that a blocked outer turn is refused, that Baum's 3-cycle keeps the X shape, and
  that every section collapses.
