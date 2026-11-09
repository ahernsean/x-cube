# X-Cube project: orientation for agents

Read this before working in this repository. It defines the vocabulary the owner and
previous agents use, the notation, and how the code is organized. `README.md` covers
commands. When a term here conflicts with your general Rubik's-cube knowledge, this file
wins for this project.

## The puzzle

The **X-Cube** (Moving Parts, 2013) is a 3x3x3 with a 3x3 **extension** attached to four
of its six faces. Solved, it is an **X shape**: 3 layers tall, and seen from above a 5x5
grid without its corners (21 cells). Turning layers moves extension pieces onto other
faces, so the puzzle changes shape.

- **Hold:** white up, green front. Red is right, orange left, blue back, yellow down.
  Colors are set in `FACE_COLOR` in `src/core/puzzle.ts`.
- **X-faces:** the white (up) and yellow (down) faces, each shaped like a 5x5 grid minus corners.
- **Side faces:** front, back, left and right, each 5 wide and 3 tall when solved. A side
  color covers its extension's outer face and the matching sides of the two neighboring extensions.
- **Extensions:** the 3x3x1 slabs on the front, back, left and right of the core. Solved,
  the up and down extension spots are empty.
- **Core:** the inner 3x3x3.
- **In shape / out of shape:** whether the puzzle is currently an X shape (in any orientation).
- **Solved:** X shape, and every visible face in each direction shows one color.

## Coordinates and slots

- Right-handed, same as three.js: **+x = R**, **+y = U**, **+z = F**. Integer coordinates -2..2.
- **Slot:** a place a cubelet can be. There are 80: every lattice point with at most one
  coordinate equal to +/-2, minus the solid center (0,0,0).
- **Slot names** (`slotName` in `src/core/puzzle.ts`):
  - core slots use standard cubie names: `UFR`, `UF`, `U`;
  - extension slots are `<face>x.<position>`: `Fx.UR` is the up-right cubelet of the
    front extension, `Fx` its center, `Ux.F` the front spot of the (normally empty) up extension.
- In cycle output, `A -> B` means the cubelet that was in slot A is now in slot B.

## Cubelets

The owner says **cubelet** (not "piece" or "cubie"). There are 62 in the model; 52 matter
for solving. Kinds by connectivity (`Kind` in `src/core/puzzle.ts`):

| Code name | Count | Owner's name / description | Stickers |
|---|---|---|---|
| `coreCorner` | 8 | Core corner | 1 (white or yellow) |
| `singleEdge` | 8 | Core single edge: core edge in the up or down layer | 1 (white or yellow) |
| `doubleEdge` | 4 | Core double edge: vertical core edge between two extensions; always hidden when solved | 0 |
| `outerCorner` | 16 | X-face corner (Baum: outer corner): corner of an extension | 3 |
| `outerEdge` | 16 | Edge of an extension: 8 **X-face edges** (white/yellow + a side color) and 8 **extension side edges** (two side colors) | 2 |
| `center` | 6 | Core face centers. U/D carry the X-face center sticker; L/R/F/B are hidden | 0 or 1 |
| `extCenter` | 4 | Extension centers, **fused** to the core center behind them | 1 |

"X-face edge" and "extension side edge" name **positions** in the X shape, not
cubelets: an outer turn moves an outer edge between the two kinds of spot. Code uses the
kinds above for cubelets and the owner's names for spots.

**Look-alike cubelets:** only core cubelets have identical twins (4 white core corners, 4
yellow, 4 white single edges, 4 yellow, 4 double edges). Outer cubelets with the same
colors are **not** interchangeable, because of the outward-color rule below.

## Moves and notation

| Notation | Meaning |
|---|---|
| `R L U D F B` | **Inner turn**: the 3x3x3 layer plus everything beyond it, including that side's extension (for R: every slot with x >= 1). Clockwise as seen looking at that face. Always allowed. |
| `r l f b` (`u d`) | **Outer turn**: the extension layer alone (for r: x == 2). Allowed only when all 9 of its slots are filled ("complete"). An outer turn that isn't allowed is **blocked** or **refused** (UI wording: "f refused: extension has 6/9 cubelets"). |
| `H` | The horizontal middle slice, turned like U (the owner's name). `E` is accepted as `H'`. |
| `M` | The slice between L and R, turned like L. |
| `S` | The slice between F and B, turned like F. |
| `x y z` | **Rotation** of the whole puzzle, turned like R, U, F. |
| `'` and `2` | Counterclockwise and half turn. `2'` is accepted. |
| `(A)5`, `(A)x5`, `(A)*5`, `(A) x 5` | Repeat a group. |
| `(A)'` | Inverse of a group: reversed order, each turn inverted. |
| `[A, B]` | **Commutator**: `A B A' B'`. |
| `[A: B]` | **Conjugate**: `A B A'` (set up, do, undo the setup). |

Commas and periods outside brackets are treated as spaces. Parser: `src/core/notation.ts`.

**Dave Baum's page** (a common online source) holds the X-faces at front and back, so his
letters differ. Translated to our grip: his `F U B D` are our `U B D F`; `L R` unchanged;
his `u` is our `b`; his `H` is our `S'`. His edge 3-cycle is `R' S' R b R' S R b'` and his
corner 3-cycle is `R' F' R b R' F R b'` (both verified by tests).

## Facts the engine relies on (all tested in `test/puzzle.test.ts`)

- **Outer turns never change the shape.**
- **Outward-color rule:** an outer cubelet always shows the same color facing outward
  (away from the core). Inner turns carry it rigidly with the core cubelet it touches;
  outer turns spin it about its outward axis.
- **Fused centers** never separate.
- **The shape depends only on the core.** Each core cubelet always has the same number of
  outer cubelets against it (2 per corner, 1 per single edge, 2 per double edge). The X
  shape returns exactly when the core corners have white/yellow facing up or down, the
  single edges are oriented, and the double edges are in the middle layer. That is phase 1
  of Kociemba's two-phase method (at most 12 moves).
- **Shape-preserving inner turns:** U, D, R2, L2, F2, B2.
- **Legality depends only on the shape**, never on colors: a sequence legal from solved is
  legal from any state with the X shape.
- Owner-confirmed physical checks: after R, f and b refuse (6/9) and u and d have 3; after
  F, f and b turn and l and r refuse; U and R2 keep the X shape.

## State codes

`X1:` followed by 80 pairs of characters, one pair per slot in slot order: cubelet id
(`A-Z a-z 0-9 - _`) or `.` for empty, then orientation `a..x` (index into the 24 cube
rotations). `src/core/serialize.ts`.

## Code map

- `src/core/geometry.ts`: rotations, directions.
- `src/core/puzzle.ts`: slots, cubelets, state, move definitions, applying turns.
- `src/core/notation.ts`: parser and formatter.
- `src/core/analyze.ts`: shape and solved tests, effect (cycles and twists), text face views,
  flat-view rim data (`faceRimView`).
- `src/core/search.ts`, `src/core/goals.ts`: iterative-deepening search with goal masks
  based on appearance (look-alike twins compare equal).
- `src/cli/xc.ts`: command-line driver (see `README.md`).
- `src/web/`: **X-Cube Lab**, the browser viewer, built into `dist/x-cube-lab.html` by
  `scripts/build-web.ts` and published as a claude.ai artifact.

## X-Cube Lab vocabulary

- **3D view:** three.js r186, loaded as ES modules through an import map and a shim that
  exposes a global `THREE`. Color management is off and output is linear, to keep the
  original look; light intensities are scaled by pi for newer three.js light units.
- **Views:** Home (three-quarter), Front, Back, Left, Right, Up, Down. The side views tip
  the top 16.6 degrees toward the viewer (from the owner's saved view).
- **Edge labels:** the six face letters, each placed where that face's axis, as projected on
  screen, meets the edge of the 3D view; tapping one turns the view to that face.
- **Gestures:** swipe on the cube turns the layer under the finger, live, settling to the
  nearest quarter turn; long press then drag, or drag the background, tumbles the view;
  two fingers spin it.
- **Turn buttons:** tap for the shown turn; long press flips it to the inverse (U to U');
  slide off to cancel.
- **Flat view:** the six faces as seen straight on, drawn from the same scene by
  orthographic cameras, so it animates.
- **Edge glow:** a soft band at a depth discontinuity, in the color of the sticker around
  the edge. No glow means that side has no sticker. Only shown where the side face points
  away from the viewer or is edge-on.
- **Shading:** grid-based ambient occlusion. Each face corner is darkened by filled grid
  spots in front of it (three near, five farther with less weight), blended across the
  face. Applied to stickers, flat tiles and plastic; recomputed every frame during turns.
- **Shadows:** soft shadows from the single key light.
- **Lighting:** a studio-room environment map supplies most of the light; one key light gives
  corner glints and shadows. The plastic has boosted specular reflectance plus a clear coat,
  and its own dimmer copy of the environment so faces don't mirror the room. Neutral tone
  mapping (exposure 1.15) compresses bright values instead of clipping them, which keeps
  well-lit yellow distinct from white; stickers have a reduced sheen for the same reason.
- **Saved states:** stored in the artifact's shared database, collection `states`, with
  fields `name`, `code` (a state code), `note`, `savedAt`, `source` (`page` or `claude`).

Tried and removed: screen-space ambient occlusion (SAO, then GTAO). Both showed artifacts
on this scene that the grid shading does not have.

## Working conventions

- One commit per change, so the owner can back out any single step.
- Run `npm test` and `npx tsc --noEmit` before committing. Check the Lab in headless
  Chromium (Playwright) at phone width (390 px). Publish the Lab after changes.
- Library versions must be at least two weeks old.
