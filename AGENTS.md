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
- **Slot:** a place a piece can be. There are 80: every lattice point with at most one
  coordinate equal to +/-2, minus the solid center (0,0,0).
- **Slot names** (`slotName` in `src/core/puzzle.ts`):
  - core slots use standard cubie names: `UFR`, `UF`, `U`;
  - extension slots are `<face>x.<position>`: `Fx.UR` is the up-right piece of the
    front extension, `Fx` its center, `Ux.F` the front spot of the (normally empty) up extension.
- In cycle output, `A -> B` means the piece that was in slot A is now in slot B.

## Pieces

The owner says **piece**, the twisty-puzzle community's word for one of the movable parts
(not "piece" or "cubie", which fit only cubes). A piece is the unit the model tracks:
an extension center and the core center behind it are fused, one part in the hand, but two
pieces here. There are 62 in the model; 52 matter for solving. Kinds by connectivity (`Kind` in `src/core/puzzle.ts`):

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
pieces: an outer turn moves an outer edge between the two kinds of spot. Code uses the
kinds above for pieces and the owner's names for spots.

**Look-alike pieces:** only core pieces have identical twins (4 white core corners, 4
yellow, 4 white single edges, 4 yellow, 4 double edges). Outer pieces with the same
colors are **not** interchangeable, because of the outward-color rule below.

## Moves and notation

| Notation | Meaning |
|---|---|
| `R L U D F B` | **Inner turn**: the 3x3x3 layer plus everything beyond it, including that side's extension (for R: every slot with x >= 1). Clockwise as seen looking at that face. Always allowed. |
| `r l f b` (`u d`) | **Outer turn**: the extension layer alone (for r: x == 2). Allowed only when all 9 of its slots are filled ("complete"). An outer turn that isn't allowed is **blocked** or **refused** (UI wording: "f refused: extension has 6/9 pieces"). |
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
- **Outward-color rule:** an outer piece always shows the same color facing outward
  (away from the core). Inner turns carry it rigidly with the core piece it touches;
  outer turns spin it about its outward axis.
- **Fused centers** never separate.
- **No sticker is ever covered.** In every position, in or out of shape, the spot a
  sticker faces is empty or outside the puzzle. (The spot a sticker *will* face after some
  turns may be filled now.)
- **The shape depends only on the core.** Each core piece always has the same number of
  outer pieces against it (2 per corner, 1 per single edge, 2 per double edge). The X
  shape returns exactly when the core corners have white/yellow facing up or down, the
  single edges are oriented, and the double edges are in the middle layer. That is phase 1
  of Kociemba's two-phase method (at most 12 moves).
- **Shape-preserving inner turns:** U, D, R2, L2, F2, B2.
- **Legality depends only on the shape**, never on colors: a sequence legal from solved is
  legal from any state with the X shape.
- Owner-confirmed physical checks: after R, f and b refuse (6/9) and u and d have 3; after
  F, f and b turn and l and r refuse; U and R2 keep the X shape.

## State codes

`src/core/serialize.ts`. Two formats; `decodeState` reads both.

- **X2** (written for every position turns can reach): 44 letters A-Z in 11 groups of 4,
  e.g. solved is `VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS`. Case, spaces,
  dashes and an `X2:` prefix are ignored. Lossless: twins and center spins are kept. It is
  an index of the position (`positionIndex`, `positionAt`) times a check prime, so a typo
  is refused: any error within 6 neighboring letters, any swap of two letters, and all but
  about 1 in 3 billion others.
- **X1** (written only for positions turns can't reach, which X2 can't hold;
  `unreachableReason` says why): `X1:` followed by 80 pairs of characters, one pair per
  slot in slot order: piece id (`A-Z a-z 0-9 - _`) or `.` for empty, then orientation
  `a..x` (index into the 24 cube rotations). Older saved states and test files hold X1 codes.

## Wording

`WORDING.md` says which words the Lab uses in anything a user sees or hears (color, never
paint; puzzle, never cube; no "outward"), and how to phrase messages and help. Follow it
for every user-facing string.

## Algorithms

`ALGORITHMS.md` collects algorithms found or verified with the engine, each with the
situation it solves, how to recognize it, and the test that checks it. Add new ones there,
and to `src/core/algorithms.ts` (with an example position) so the Lab lists them.

## Solving method

`src/core/solve.ts` solves any position turns can reach as a list of steps a person could
follow (`nextStep`, `solveSteps`; `xc solve` prints them). It is not the shortest solution
(about 175 turns on average, 242 at most in 200 sampled positions). Each step has a stage,
a goal in words, its turns, the pieces it applies to (`moved`: slot before, slot after) and
the pieces it may leave anywhere (`free`); every other piece looks the same after the
step. Stages, in order:

1. **hold**: turn the whole puzzle so white is up (outer steps may later flip it, below).
2. **shape**: back to the X shape with face turns. Free: every outer piece.
3. **core**: white core pieces up, yellow down, with the shape-keeping turns. Free: every
   outer piece.
4. **parity**: when the outer corners or the outer edges need an odd number of swaps, `r`
   (both odd), `U` (edges only: it moves the four edges in one ring and the eight corners
   in two) or `U r` (corners only) makes both even.
5. **corners**, 6. **edges**: three at a time. Each step is one of two fixed 3-cycles per kind (`CYCLES`,
   or its inverse) inside setup turns that keep the shape, written `[setup: cycle]`. An
   outer piece is turned one way in each spot, so placing it is all there is to do.

**Modes** (`Mode`). `kinds` is as above. `layers` goes top to bottom, as a 3x3x3 is often
solved. Its core comes first, a piece at a time, in place of the shape and core stages:
the white core single edges into the top layer, white up (`coreTop`), then the white core
corners (`coreTopC`), the double edges into the middle layer (`coreMiddle`), the yellow
single edges into the bottom layer, yellow down (`coreBottom`), and the yellow corners
(`coreBottomC`). Each step brings at least one more of its kind where it belongs and keeps
the earlier kinds; look-alikes are interchangeable, so each kind is tracked as a set of
four (slot, sticker axis) codes, with a table per kind and count of the fewest face
turns, and a step is the easiest of the shortest ways an iterative deepening search finds
(about 4.5 turns, 9 at most, over 60 sampled positions). When the five are done the
puzzle is in the X shape with its core solved. Then the outer pieces, with the same two
cycles as `kinds`, top to bottom: the white
X-face's edges (`topEdges`), its corners (`topCorners`), the extension side edges
(`sideEdges`), then the yellow X-face's corners and edges (`bottomCorners`,
`bottomEdges`). A cycle never moves a piece that is already home, in either mode; it
brings at least one piece of the current group home, and its third piece may be any
unsolved one. A step's `lands` says which of the three end up solved (in place and turned as solved; the goal says "Two end up solved", since "home" is the Home view). Sampled over 200
positions, the two modes come out about the same length (177 and 180 turns on average).

**Ease, the owner's priorities for turns** (`EASE` in `solve.ts`), most important first:
avoid the back (`B`, `b`); then the bottom (`D`); then `H` and `S`; `M` is fine (a person
does it as `L' R x'`); `R` is preferred to `F` (F costs 7 to R's 4, so `y' R U R' U R U2 R'`
beats `F U F' U F U2 F'`); the owner is right-handed, so `L` is a little harder than `R`;
an outer turn is as hard as its face's inner turn (`r` like `R`, `f` like `F`); and
regular, repeating patterns are easier to memorize. The weights are whole numbers (the
tables sort by them): `U R M r` 4, `L l` 5, `F f` 7, `D d u` 8, a rotation 8, `H S` 12,
`B b` 16. So:

- Turns are chosen by ease, not by number: setups and the core stage take the easiest
  way, and the shape stage weighs every way with the fewest turns, and with one more.
  In 200 sampled solves `B` was 0.1% of turns and `D` 1.1%, with no `b`, `S` or `H`.
- **Regrips.** A step may begin with a turn of the whole puzzle about its vertical axis
  (`y`, `y'`, `y2`) when that makes the rest easier; a regrip is never in the middle of a
  step. A cycle step or a layer core step (`layers`) may also begin by flipping the puzzle
  over, `x2`, alone or before a `y` turn (the owner flips with `x2` more often than `z2`),
  so the bottom comes on top; the steps after it go on from there, and the puzzle is
  turned back only if a later step is better off that way. So the **grip** is which of
  these eight holds the puzzle is in, from white up and green front (`GRIPS`), and each
  outer piece's home turns with it. A regrip is chosen with the step it is for, but
  `nextStep` gives it as a **regrip step** of its own first (stage `regrip`, its goal
  naming the center that ends up up or in front: "Flip the puzzle over, so yellow is up";
  "Rotate the puzzle, so blue is in front"), and the step after it is found again
  from the regripped position. So every other step's goal, turns and paths are for one
  way of holding the puzzle, and its `regrip` is "" (should that fresh step want a regrip
  of its own, the step keeps its regrip instead; no sampled solve has needed it). About
  11 regrip steps a solve top to bottom, 7 corners then edges, in 25 sampled shuffles;
  the turns are the same. With yellow
  up, a layer core step is found with the puzzle turned back white up and then named as
  it is held (`asFlipped`; ease by the names as held, and its goal says "top layer,
  yellow up"); a cycle step works with yellow up as it is, so its cycle keeps its front
  turns. A position held neither white nor yellow up, or yellow up before the shape and
  core are done in `kinds` (its shape and core steps need white up), starts with a hold step.
- **Seeing the pieces.** A cycle step's cost, and a layer core step's, also counts where
  the pieces it is for are while a person turns: after the regrip and after each turn,
  each one on the bottom (y below 0) costs `UNSEEN_DOWN` (4) and each on the back (z below
  0) `UNSEEN_BACK` (2), in ease units. In `layers`, a step that builds the white or the
  yellow layer (`coreTop`, `coreTopC`, `coreBottom`, `coreBottomC`, `topEdges`,
  `topCorners`, `bottomCorners`, `bottomEdges`) also costs `LAYER_DOWN` (6) for each of
  its turns while that layer is on the bottom: the owner flips the puzzle to work the layer
  being built on top. A flip costs `FLIP_COST` (16) on top of the `x2` turn's ease, so a
  solve doesn't flip back and forth for little gain. Each cycle reaches into the bottom
  layer (corners Fx.UL, Rx.UF, Rx.DF; edges Fx.L, Rx.F, Rx.D), so some time there is
  unavoidable. Over 40 Lab shuffles solved top to bottom: the steps' pieces spent 21%
  of their turns on the bottom (28% with no flips), 28 of 750 white or yellow layer steps
  were worked with that layer on the bottom (159 of 736 with no flips), about 3 flips per
  solve (typically at the yellow core, and back for the white X-face), and 227 turns
  instead of 222 (230 once `F` cost more than `R`; most `F` turns left are the cycles' own). Over 100 sampled `kinds` solves, the outer steps' pieces' share of
  turns on the bottom fell from 27% to 22%, with about 1.5 flips and the same turns.
- **The cycles are commutators, written grouped:** corners `(F' L' F) r (F' L F) r'`,
  edges `(F' M' F) r (F' M F) r'` (inverses: `r (F' L' F) r' (F' L F)` and likewise).
  They are Baum's two turned a quarter around the puzzle, which takes out `b` and `S`.
  Each has a mirror image, left for right, the owner's: corners `(F R F') l' (F R' F') l`
  (Lx.DF, Fx.UR, Lx.UF), edges `(F M' F') l' (F M F') l` (Lx.D, Fx.R, Lx.F). A step takes
  whichever of the two, with its setup and the rest of its cost, is easiest (the mirror on
  a tie); with two to choose from, setups are shorter (183 turns a solve in `kinds` instead
  of 191). The edge cycle's two `M` turns undo each other, but between them the side centers are moved.
  `ALGORITHMS.md` and the Lab's Algorithms list have all four.
- Setups reach every one of the 3,360 ordered triples of spots for each kind, which with
  the parity fixes makes the outer stages complete; `test/solve.test.ts` solves scrambled
  positions and positions from the editor, and checks each step changes only what
  it says.

## Code map

- `src/core/geometry.ts`: rotations, directions.
- `src/core/puzzle.ts`: slots, pieces, state, move definitions, applying turns.
- `src/core/notation.ts`: parser and formatter.
- `src/core/analyze.ts`: shape and solved tests, effect (cycles and twists), text face views,
  flat-view rim data (`faceRimView`).
- `src/core/algorithms.ts`: the known algorithms the Lab lists, each with an example position.
- `src/core/edit.ts`: the Lab's editor: fitting painted sticker colors to real pieces
  (`fitColors`), and editing the shape (`draftTap` and the other `draft` functions).
- `src/core/search.ts`, `src/core/goals.ts`: iterative-deepening search with goal masks
  based on appearance (look-alike twins compare equal).
- `src/core/solve.ts`: the step-by-step solver (see "Solving method" above).
- `src/web/planner.ts`, `src/web/plan-worker.ts`: the step guide's plan of the whole solve, made
  in a Web Worker.
- `src/core/lost.ts`: Lost? in the Lab: the positions one slip in followed turns gives, and the questions that tell them apart.
- `src/cli/xc.ts`: command-line driver (see `README.md`).
- `src/web/`: **X-Cube Lab**, the browser viewer, built by `scripts/build-web.ts` into
  `dist/x-cube-lab.html` (published as a claude.ai artifact, which supplies the document
  skeleton) and `dist/index.html` (a complete page, published to GitHub Pages at
  https://ahernsean.github.io/x-cube/ by `.github/workflows/pages.yml` on every change to
  `main`).

## X-Cube Lab vocabulary

- **3D view background:** in light mode a gray gradient (`--stage`), a step darker than
  white so a white sticker's edge glow shows against it.
- **3D view:** three.js r186, loaded as ES modules through an import map and a shim that
  exposes a global `THREE`. Color management is off and output is linear, to keep the
  original look; light intensities are scaled by pi for newer three.js light units.
- **Drawing on demand:** the views are drawn only when something in them may have changed
  (`requestDraw`): while something moves (a turn, a settle, a gesture, the view turning,
  the guide's flying pieces, the halo's arrow), when the view's orientation or size
  changes, after any input event, and when a function that changes what is shown asks
  (`render`, `syncMeshes`, `renderEdit`, `drawEdit`, the guide's, `applyShading`, any probe
  call). At rest nothing is drawn, which spares a phone's battery.
- **Views:** Home (three-quarter), Front, Back, Left, Right, Up, Down. The side views tip
  the top 16.6 degrees toward the viewer (from the owner's saved view).
- **Edge labels:** the six face letters, each placed where that face's axis, as projected on
  screen, meets the edge of the 3D view; tapping one turns the view to that face. Beside
  each letter, an arrow in the color of that face's center points the way the face's axis
  points on screen, shorter as the axis turns toward or away from the viewer; nearly
  head-on (its projection under `COMPASS_HEAD_ON`, 0.45) it is a disc with a dot (toward the
  viewer) or a cross (away), as on a diagram. The arrows have no dark outline, only the
  faint `--tile-edge` hairline, without which a white arrow vanished on the pale pill (a
  play-tester turning a tipped-over puzzle asked for arrows to tell which way each face
  points; arrows standing out of the puzzle itself were mocked up too, and set aside
  because they covered pieces). They are
  foreshortened: a label on an axis toward the viewer is drawn larger, one pointing away
  smaller (scale 0.85 to 1.5, `COMPASS_MIN`/`COMPASS_MAX`), nearer ones on top. A label
  slides along its edge only to clear another label or a corner button, so it stays near
  where its axis meets the edge.
- **Corner buttons** of the 3D view, round icons with no button edge (drawn as SVG, so the
  ⓘ and ◐ circles match): ⓘ (help) top right, ◐ (Display) bottom right, and ↶ (Undo, the
  last turn however it was made) top left, shown only while there is a turn to undo.
- **Color rule** for the page's controls: the accent blue (the highlight) marks a selected
  or active control (the turn amount, Order, an inverted turn button, the playing transport
  button), green a good state, and gray one that is off or doesn't apply. This file states
  the rule, not each element's color (the CSS has those); `scripts/browser-tests.mjs` checks
  the rule (`controls: the color rule`).
- **Disclosure triangles:** one shape for section headings and `details` summaries, drawn
  in CSS (the browser's own marker is hidden).
- **Gestures:** swipe on the cube turns the layer under the finger, live, settling to the
  nearest quarter turn; long press then drag, or drag the background, tumbles the view;
  two fingers spin it; double tap (cube or background) undoes the last turn. The ⓘ in the
  3D view's corner shows help for the mode the Lab is in (`infoHelp`), since taps and drags
  do different things in each: turning the puzzle (the gestures above), a solve (those,
  and how to read a step's grays and paths), and Edit puzzle (what a tap does with the
  color or the Shape tool picked; drags only tumble). Under the help, **Copy debug info**
  copies, as JSON, what the Lab is showing and doing (`debugInfo`): the start, the turns
  and the cursor, the view, the solve's steps, the device (user agent, touch points, size),
  and an edit in progress with
  its shape (a state code, X1 when turns can't reach it), pieces taken off and put in,
  paint and problems; once copied, the ⓘ panel closes so the message shows; where the browser won't let it write the clipboard, the text shows selected under the link, to copy by hand, and the panel stays open. It is for the owner to hand to a developer when something looks
  wrong, including an edit whose shape isn't valid, which has no state code of its own.
  With the shared database it also keeps a copy there, in the `debug` collection (`json`,
  `savedAt`, `source`; the newest 20, `DEBUG_KEEP`), where an agent reads it with the
  artifact's database tools: the owner can say "look at the latest debug info" instead of
  pasting it ("Debug info copied, and saved for Claude at Nov 20, 2026, 1:19:52 AM", the
  time as the saved copies' list gives it).
  **Paste debug info**, beside it, puts the position, the view and the edit back, and a
  solve in progress with its steps (`restoreSolve`: the solver is deterministic, so each
  step comes again from a plan made from where it starts, in the order it was solved in;
  a Back on track step, which no plan has, comes back from its own turns, going back to
  the plan step its turns end at (planned from there if need be); the
  message says "Solve restored: 10 steps", or how many of them came back), so Next step and
  Lost? go on from there. Debug info is a restart dump: saved during Lost?, it also holds
  the solve's own turn list, cursor and shown step (the list shown then is a guess at the
  person's) and every answer given, in order (`Lost.log`, the last turn named included),
  and whether Lost?'s Edit puzzle was open; Lost? is deterministic, so once the solve is
  back, `restoreLost` starts it again from the same step and replays the answers, which
  brings the interview to the same question with the same colors told, or opens its Edit
  puzzle, then set as it was, with Continue search ("Solve and Lost? restored: 10 steps,
  5 answers") (the probe's `restoreDebug` does the same for tests): from the clipboard, or where the browser
  won't read it, from text pasted into the field that opens. Beside it, a clock (shown
  with the shared database) opens a list of the saved copies, newest first, each by the
  date and time it was saved, to the second, in small type, and the device ("Nov 20, 2026,
  12:31:05 AM · iPhone"; an iPad's user agent names a Mac, so the debug info keeps
  `navigator.maxTouchPoints` as `device.touch`, and a Mac with touch points is listed as an
  iPad, `deviceName`); a
  tap on one puts it back, as an agent can with the database tools. While the list is open, a trash icon beside the clock turns red with "Clear?" (3 seconds); a second tap reads "Clearing…" (in the icon's place, as "Not cleared" is, so the row stays one line), sets the list aside and deletes every copy at once. The list closing is the confirmation; if the database refuses, "Not cleared" shows beside the clock and the list stays. Words around the debug info
  are left out (the first span from a "{" to the "}" closing it that parses), so a whole
  message holding it can be pasted; text that isn't debug info is
  refused ("That isn't debug info"), and during a solve it asks first, as setting a new
  start does. So the owner can come back to an invalid edit after the Lab is republished.
- **Hidden restart dump:** the same JSON as Copy debug info is kept on the device
  (`localStorage`, `xcube.session`) a moment after things settle (`SESSION_DELAY_MS`, 1.5 s),
  only when it has changed, at once when the page is hidden, and never while something
  turns; about 0.2 ms a save. iOS drops a page in the background when short of memory, and
  a play-tester's solve, Lost? and edit were lost that way. After a reload, a small dialog
  over the top of the 3D view offers it ("Pick up where you left off?", what it was and
  when: "Solving, step 10 · Nov 26, 2026, 3:46:46 AM"); **Pick up** restores it as Paste
  debug info does, **Start fresh** (or a tap anywhere else) drops it. Nothing worth keeping
  (no turns, a solved start, no solve, Lost? or edit) keeps nothing; kept for 7 days.
- **Display panel:** the ◐ in the 3D view's corner opens the Edge glow, Shading, Shadows
  and Gloss switches, over the view and over the edge labels.
- **Layout** (narrower than 900 px, a phone): one screen, and the page never scrolls. The
  root is padded by the safe-area insets (as the artifact host's skeleton also pads it; in
  the Claude app the top inset covers the app's own bar too) and the body fills the rest,
  so each inset is counted once. Vertical space is the scarce thing: an
  element earns a row only if it is used while solving. At the
  top, the 3D view (32% of the screen's height, with only the edge labels and the corner
  buttons over it), one row with Home (the other view buttons are left out: a tap on an
  edge label does the same) and the hold line, and the
  **playback strip**: the turn list on one row that scrolls sideways (kept so the current
  turn and the next two things after it show), the playback buttons with the counter beside
  them and the status chips at the right end, and the speed slider. Below, a row of **tabs** (Start, Turn, Algorithms, Solve, Flat) and the
  **panels**, side by side in a carousel that shows one at a time: a tap on a tab, a
  sideways swipe across the panels, or a finger slid along the tabs picks one (the tab
  marked follows a swipe as the panels move; during a tab's own scroll its tab stays marked); each panel
  scrolls up and down by itself, and the one shown is kept on the device. The panels' own
  headings are hidden (the tabs name them). On an iPhone every turn button shows without
  scrolling, and the flat view is sized to show whole, its ⓘ over its empty corner. Help and switches open in panels over the views; messages float
  over the top of the 3D view (on wide screens, near the bottom of the screen) and fade after
  4 seconds (8 for errors) or a tap. **Wide** (900 px and up, an iPad in landscape): the 3D
  view and the strip on the left, staying put, and the panels stacked in a column on the
  right, each collapsing from its heading; no tabs.
- **Panels:** **Start** (everything that sets the start: Shuffle, Reset to solved, Edit
  colors and Start from here, then saved positions and the state code), **Turn** (the turn
  amount, the turn buttons, and the turn field), **Algorithms**, **Solve** (the step
  guide), **Flat** (the flat view). The Lab opens on Start.
- **Playback:** the buttons form one strip (one rounded outline, faint lines between the
  buttons), and the counter ("7/9") sits right after it. **Every button is grayed out
  (disabled) when it can't do anything** right now: the backward buttons at the start, the
  forward ones at the end (▶ stays live as ■ while playing), Load with an empty turn field,
  Start from here and Save (algorithm) with no turns, Reset with the puzzle solved and no
  turns, Next step (and Start solving) while the step's turns are still to play or when the solver
  has nothing to do (solved and held as it wants; a solved puzzle tipped over still gets a
  Regrip step), Show step after
  the step's first turn (while the view already shows what it would show, it reads **Home**
  instead and turns the view home, so the two views can be toggled). When a step is
  loaded, or one is tapped in the step list, the turn list slides (animated) to show as much of it as fits, with the current
  turn just before it; only if the step is too long does its right end go off the edge. The turn list ends in a ✕ (while there are turns): one tap turns
  it into "Clear?", a second within 3 seconds clears the list as Start from here does. ⏮ back to the start (drawn as a bar and the same ◀ as its neighbors, since iOS
  draws the ⏮ character as an emoji), ◀ play backward to the start, ◀1 back one turn, ▶1
  forward one, ▶ play to the end; the slider sets 1600 to 30 ms per quarter turn.
- **Start from here** (`#clear`, in the Start panel): empties the turn list; the position
  shown becomes the start ("Current position").
- **Shuffle:** 30 random legal turns (inner, slices, outer when complete; never the same
  layer twice in a row; no rotations) played at 70 ms per quarter turn; the result becomes
  the new start ("Shuffled"). Neither the message nor the turn list shows the turns (the
  list says "Shuffling…" while they play), which would give the way back away (the probe's
  `shuffleTurns` has them for the tests).
- **Turn buttons:** tap for the shown turn; long press flips it to the inverse (U to U');
  slide off to cancel. The rotations show their axes faintly behind the letter: a line
  across x, a line up and down y, and a ring around z (its axis points at you). The x and z
  letters are moved so their ink sits at the button's middle (`centerAxisLetters`): a
  lowercase letter's ink sits below its line box's middle by an amount that depends on
  the font, so it is measured, by canvas text metrics, from the font the button draws with.
- **Flat view:** the six faces as seen straight on, drawn from the same scene by
  orthographic cameras, so it animates, centered in its panel. Its ⓘ button explains how to read it.
  It is drawn only while some of it is on screen (`netOnScreen`, an IntersectionObserver):
  on a phone the Flat panel keeps its size beside the others in the carousel, and drawing it
  there was nine tenths of the Lab's drawing. Each of its six cameras draws only the
  squares and glow bands that face it.
- **State code** (a disclosure in Saved states): one single-line field, with Copy and Load
  beside the heading. It shows the current position's code as a read-out (no fill), drawn
  over the field at the size that fits it on one line, measured (13px at most, about 9.5px on an iPhone);
  tapping into it empties it for a code to be pasted or typed, and leaving it empty shows
  the code again. Typed text that isn't a code is outlined as an error and Load stays
  off. Copy copies the current position's code (putting it back in the field). If the
  position changes while typed text waits, the text is replaced by the new code, the field
  flashes and a message says so. Its ✕ puts the current code back.
- **Text fields** each have a ✕ at the right end while they hold text; it empties the field.
  Their text is 16px: iOS zooms the page into a focused field with smaller text.
- **Status chips**, in the playback row: one shape chip ("Solved", or "X shape", good in
  shape and off out of it), and a 3 by 2 grid of one-letter chips for the outer turns
  (r l u / d f b), good when that turn can be made and off when not (the color rule).
- **Edge glow:** a soft band at a depth discontinuity, in the color of the sticker around
  the edge. No glow means that side has no sticker. Only shown where the side face points
  away from the viewer or is edge-on. Where two visible faces of one piece meet, the
  hidden sticker's glow continues around the corner between them, rounded like the
  sticker's corner; elsewhere a glow fades out at its ends, and always in the flat view,
  which sees only one side of a corner. Recomputed every frame during turns, from where
  the pieces are right then: a face between a turning layer and its neighbors is
  exposed, and glows, from just after the turn starts until just before it ends.
- **Shading:** grid-based ambient occlusion. Each face corner is darkened by filled grid
  spots in front of it (three near, five farther with less weight), blended across the
  face. Applied to stickers and plastic; recomputed every frame during turns. The flat
  view shades each tile from its neighbors in the view instead: each neighbor standing
  nearer casts a band along the shared edge (a patch, if it touches only a corner), dark
  at the edge and gone within 30% of the tile; where bands overlap the darker wins. Each
  square is two triangles carrying its eight darkness values, and its material works out the
  bands pixel by pixel (`shadeFlat`), so it needs no vertices inside it. A
  visible face at depth 0 or below has always been unstickered in sampled positions, so
  every drop seen on a sticker is one step.
- **Plastic:** each piece is a box with rounded edges (`roundedBox`), two segments across
  each rounding, with the normals set at each vertex: 300 triangles. At iPad resolution it
  looked the same as four segments (972 triangles); one made the corner glints blocky.
- **Shadows:** soft shadows from the single key light.
- **Lighting:** a studio-room environment map supplies most of the light; one key light gives
  corner glints and shadows. The plastic has boosted specular reflectance plus a clear coat,
  and its own dimmer copy of the environment so faces don't mirror the room. Neutral tone
  mapping (exposure 1.15) compresses bright values instead of clipping them, which keeps
  well-lit yellow distinct from white; stickers have a reduced sheen for the same reason.
- **Gloss:** the stickers' laminated film, as a clear coat over the color. Its surface
  comes from a small texture generated in code (broad soft crinkles, tiny nicks and
  dents, patches of more and less shine), turned and offset differently on each sticker. Only the
  coat carries the crinkles, so they show in reflections while the color stays smooth.
  The Gloss switch turns it off.
- **Editing the puzzle:** **Edit puzzle** in the Start panel sets the shape and paints the
  stickers to match the real puzzle, in either order. Its palette has the six colors and a
  **Shape** tool; drags tumble the view, and the other controls are set aside.
  - **Shape tool:** a tap changes only what it taps (`draftTap`), as the owner thinks of
    a stack of pieces rather than of the rules behind it: an extension piece goes away,
    and an empty spot gets a piece. Every empty spot next to the core is marked while
    Shape is selected: small gray glass boxes with white edges, unlit, so they show over
    white, over black and in shadow. While the halo marks some of them, the others are
    drawn fainter (`GHOST_DIM`), so the marked ones stand out; they can still be tapped. Nothing turns or swings: a tap only takes an
    extension piece away or puts one in.
  - **A wrong shape for a while:** as paint may be wrong, so may the shape. The line names
    what keeps it from being one the puzzle can have ("This core corner has only one
    extension, but it has to have two" or "has no extensions", "This core corner has three
    extensions, but it can have only two", "This core edge has no extensions, but it has to
    have one or two": one problem for each core piece, since each is fixed on its own; "Only three core edges have
    two extensions, but there must be four", "Five ... but there can be only four",
    "Only three centers have an extension center", "The two centers without an extension
    center must be opposite each other"). Each says what to tap (`shapeTaps`, `shapeHint`):
    the nearest shape the puzzle can have, by fewest taps, with the core corners' twists
    adding up to whole turns (so of a corner's two bare spots, the one that keeps them whole
    is the one to fill), and of the spots some such fewest taps change, those on the core
    pieces the problem names (or of its kind, when it names none), taking one away before
    putting one in, the halo on the core piece the problem names as well as on what the
    hint names ("this" always points at something marked; `WORDING.md`). A problem about one core
    corner or edge is fixed on that piece and nowhere else, so its hint says what to do
    plainly, with "probably" only for which of its spots, and only when the halo marks
    fewer than all the spots that could be ("Add an extension to this corner, probably
    here", "Remove an extension from this corner, probably the circled one": a corner with three
    extensions is hidden on every side, so its halo is on all three, and the one meant is
    circled as a whole piece, a ring standing at its middle, turned to the viewer, as big as
    the largest circle around its middle inside its outline on screen (`insetRadius`; the flat
    view rings each face of it that shows), "Add an extension to
    this edge in one of these spots", "Add two extensions to this corner, probably in these
    spots"); the count
    problems, where which piece to change is a guess, say "This extension should probably
    be removed" (the halo on it), "An
    extension should probably be added here" (the halo on the Shape tool's glass box in the
    empty spot, the control a tap fills it with; with another tool picked, the hint draws
    that one box itself, the same size: `hintGhosts`, `ghostBox`; the arrow, Show and the
    view's checks take the box for what is in that spot), or "One of these extensions ..." / "in
    one of these spots" when the taps tie; a core corner with none must get two ("Add two
    extensions to this corner"). With a
    color picked, a tap on what the hint says to tap (`Problem.taps`: a glass box, or an
    extension to take away) colors nothing: "To add or remove an extension, pick Shape
    first", and the Shape button pulses until Shape is picked or for 8 seconds (`shapeFirst`,
    `SHAPE_FLASH_MS`; a play-tester missed a one-second flash while reading the message). A halo marks a piece or a spot for one (3D); a
    ring marks a sticker (2D), so shape hints have no rings. In the shape messages an
    extension piece is "an extension", as in "This core corner has only one extension". One tap at a time; the next problem goes on from there. Over 200 simulated
    edits of 2 to 6 random taps followed hint by hint, every one reached a valid shape in at
    most 6 taps (49 before), never back to a shape seen before (240 times before), and "needs
    to be rotated" came up 12 times (171). A piece put in is a blank body meanwhile (drawn
    in the flat view too, with its stickers, as is every dashed outline). Once
    the shape is one the puzzle can have, real pieces take the blanks' places at once.
    The core corners' twists can still be wrong, as no turns leave them: "The core corners
    can't all be oriented as they are now. One of them needs to be rotated" (no halo: any
    of them may be the one).
  - **Paint stays on its spot**, not on a piece: what a tap turns (a core piece with
    the extension pieces on it) loses its paint. A piece that only comes or goes changes only its own spot
    and the faces it covers or bares: one put in takes, on each of its faces, the color of
    the face it covers behind it, seen from that side (a neighbor's), and one taken away
    leaves each of its colors on the face it bares behind it (`repaint`); a face with
    nothing behind it starts unpainted. Not between its face away from the core and the
    core piece's face behind it: the core's sticker there is white or yellow, which an
    extension piece never shows facing out, and its own is a side color, which a core
    piece never shows. Each keeps its own color, unseen while covered or empty, so a
    core face bared again shows the color it had, and a piece put back the color it had
    (the owner's choice, after the white and yellow carried out made a play-tester's edit
    unfixable). A sticker not painted yet (`UNPAINTED`) fits any color
    and is drawn as a dashed outline on the plastic, with no edge glow; the line counts
    them ("6 stickers have no color yet", with a halo on their pieces), and Done waits
    for them. Where a piece's stickers are follows from the shape around it alone
    (`draftColors`), so a sticker can be painted while the shape is still wrong. Until
    every center is painted, the center arrangement isn't checked.
  - **Painting:** pick a color, then tap stickers; a tap on a sticker that already shows the
    picked color clears it (no color yet). A painted sticker's edge glow takes the
    paint too. Each paint is refit to pieces
  (`fitColors` in `src/core/edit.ts`), and a line says "Valid", or "Not valid:" with what's
  wrong: no piece of that kind can have a color ("An X-face corner must be ...", or, on a
  piece with one sticker, about that sticker, circled, which Show turns to: "This core
  corner's sticker must be white or yellow, never blue"; a play-tester expected the
  sticker meant to be circled), two stickers of one color or opposite colors, a corner's colors going around it
  in mirrored order ("No piece has white, green, and red arranged this way", followed, where
  the counts can't say, by the trades of two of its stickers that make a real piece,
  `swapHint`: "Its white and red stickers should probably trade places"), more spots of a kind showing some colors than the puzzle has pieces for ("Three extension edges are green and orange, but there can be only two like that"; found among the spots whose stickers all have a color, since a spot still being colored fits many pieces and a group that takes one in can spread over most of a kind: a play-tester saw 13 X-face corners haloed, where two unfinished corners each needed the last red, white, and blue one; the halo marks every competing spot), or an outer
  piece turned against the outward-color rule (a sign of a sticker painted wrong; the
  physical cube can't do that). Outward-rule problems name only what the owner can check on
  the cube: "This piece's white sticker has the wrong color", or "This piece's circled
  white sticker ..." where another of its stickers is white too, always circled then (no
  extension piece's outward sticker is white or yellow; that needs no counting and says
  for certain which sticker is wrong, so it is told first, before any other problem, and
  other problems on that piece wait for it: a play-tester recolored the other sticker of
  an edge with yellow facing down through all six colors, told each time about the pair or
  a count; where the counts can't say what it should be, the hint names the side colors
  some piece could show there beside its other stickers, "Its yellow sticker must be
  green, blue, red, or orange" when that is all of them (`sideHint`); where none fits beside
  them, the white or yellow belongs on another side, and the hint offers the trades that make
  a real piece ("Its yellow and orange stickers should probably trade places. Or its yellow
  and blue stickers should", `swapHint`; a play-tester tried every color on the sticker), and
  where no trade fits either, another sticker is certainly wrong too, and the problem names
  the ones some fix recolors ("This piece's yellow sticker has the wrong color, and so does
  either its orange or blue sticker", `twoHint`; a sentence naming no sticker was no help,
  and spelling out each fix's colors, four sentences, was overwhelming); and circles the
  sticker, which Show turns to: the halo outlines the whole piece, and a play-tester
  saw only its uncolored other sticker), "No piece has green and red
  arranged this way. One of its stickers has the wrong color", or "Two X-face corners
  look the same, but the puzzle has only one like that. One of them has a sticker with the
  wrong color"; none of them says "outward" or which color points out, which the owner
  can't act on. Every problem that colors cause also says, where counting can tell, what a wrong spot should probably be (`missingColors`): once every sticker on the pieces of that kind has a color, the colors they show, piece by piece, must be exactly the puzzle's pieces of that kind, so a piece no spot shows is what a wrong one should be. The hint says which stickers to recolor to make a spot one of those pieces, turned as the outward-color rule allows (`fitAt`). Every spot of the kind must be a different piece of the kind, so the likeliest fixes are those that recolor the fewest stickers over all those spots together (two stickers trading places counts as one change), found as a least-cost assignment of spots to pieces (`assignCost`); a fix for the problem's spot is offered only if some such assignment uses it, so one that suits the spot alone but leaves another spot without the piece it needs is not: "Its red sticker should probably be orange", "Its blue and orange stickers should probably trade places", "Its white sticker should probably be yellow, and the green sticker should be blue". Options for one sticker merge ("should maybe be white or yellow"); other options get a sentence each, starting "Or". The halo marks only the spots the hint's options are for (`Hint.slots`): a fix that works on one look-alike spot may not on another, and a play-tester sim that picked any haloed spot went in circles. With one such spot it is "Its ..."; with several, "On one of these, ..." or, where they differ, "On the one that is blue and red, ...". Stickers of one color can't be told apart by color, so when the hint is sure which one it means it is "its circled yellow sticker", and the Lab circles that sticker as Lost? marks the sticker it asks about: a ring in the halo's purple with a dark casing (white was a color the puzzle has), drawn over everything, in the 3D view only while the sticker faces the viewer (so it never shows through the puzzle) and on its face in the flat view (`Problem.marks`, `markRing`); else "one of its yellow stickers" (or "its yellow stickers should be white and blue, one each"). A piece with one sticker (a core piece or a center) gets its color named, plainly when the counts leave one ("This sticker should be white", "One of these should be green"), and no hint when they leave every color its kind can have, which the problem already says ("must be white or yellow"). With nothing missing, a spot's own colors are right and only a swap is offered. A hint stays short: at most two stickers to recolor, and at most two ways, or three when each recolors one sticker (`HINT_STICKERS`, `HINT_OPTIONS`, `HINT_ONE_STICKER_OPTIONS`); a fix past that is more a guess than help, and the problem goes without one. Centers count by kind, each color on exactly one center: of the colors the spot's kind can have (white or yellow on a core center, a side color on an extension center), the ones no center of that kind shows, narrowed, when one center is wrong, to the one opposite the color across from a haloed center; when several are, each needs a different one, so all are named ("Three of these should be green, blue, and orange, one each") if the counts leave exactly that many ("This core center's sticker must be white or yellow, never red. This sticker should be yellow"; a play-tester was once told blue, a color only an extension center has). "Probably": the counts give the fewest stickers to change, and more may be wrong. No hint while a sticker of that kind has no color yet. Each names the problem
  itself ("Red and orange can never be on the same piece"), not "a piece" (the halo
  marks it), and says what, not where: words for a spot proved unreliable (center colors move with
  slices, extensions leave their sides, left depends on the viewpoint), so the Lab points
  the spot out instead. Lists of three colors use the serial comma. The line shows one
  problem at a time; with several, tiny ‹ and › buttons step through them ("‹2/4›"), and the
  choice is kept across paints while that problem remains. The shown problem's
  pieces get a **halo** by themselves, in purple. In the 3D view it is an outline: a band
  5 CSS pixels wide on screen, just outside the part of the piece the view shows, off its
  stickers (a mask of the pixels where a haloed piece is the nearest thing drawn, and
  the band drawn over the view around it). A sticker drawn over a piece (a color it
  doesn't have, or the dashed outline of one with no color yet) counts as part of it, or
  the band would ring that sticker too, as a play-tester saw. It is as bold beside a piece flush with its
  neighbors or set back among them as beside one standing out: a rim in the space around
  the piece was only a hairline in the seams there. A piece hidden behind the puzzle
  has none: a play-tester found a glow drawn through the puzzle covered the piece he
  was painting in front. In every frame in which a haloed piece isn't turned well toward the
  viewer (no face at least 0.4 toward the viewer with its middle unblocked; `hiddenHalos`),
  a purple **arrow** in the scene points to it, even while other haloed pieces can be
  seen, drawn as one would on a whiteboard to say "look here" (`HALO_ARROW`): a lit tube that
  starts thin on the side facing the viewer, off to one side, runs around the puzzle just
  inside the edge of the view, then turns in and ends in a head pointing straight at those
  pieces. It thickens toward the head and lighter chevrons run along it toward the head,
  so the way to follow it is plain even when the head is behind the puzzle (drawn faintly
  there); it casts a shadow, which shows its depth. It is rebuilt as the view turns, so it
  always starts on the near side; it fades out once every haloed piece is turned well
  toward the viewer and back in when one isn't; a tap on it turns the view to the one
  Show turns to (`highlightView`), so the two agree, unless that view still leaves a haloed
  piece out of sight (a halo spread around the puzzle), when it turns to those instead. The
  Hide pill keeps off it. The halo, Show, Hide and the arrow are there whichever tool is
  selected, Shape included (the outline doesn't cover what to tap). A named piece enclosed on every side (a
  core edge with extension pieces on both sides, which nothing shows) is haloed through
  the extension pieces around it (`haloSlots`), which can be seen, turned to with Show
  and pointed at; a piece put in that is still a blank carries the halo, and is pointed at and shown, like any other (`drawnAt`). The arrow points at one hidden piece at a time, the one nearest to
  coming into view, and goes on to the next once that one is turned toward the viewer. On each flat-view face where the piece shows, the halo is a
  soft glow around it, hidden only by a haloed piece in front (so many halos don't pile
  up over each other's stickers). A halo appearing never moves the view. **Show**
  (or tapping the line) tumbles the 3D view to show those pieces' stickers best (the
  most unblocked, then each as squarely as possible, from the preset views and the
  directions between the stickers; weighed on a box for each spot, `boxFaceView`, since
  rays against the drawn pieces took over a second for a halo on many pieces), again each time it is tapped. For a shape problem about
  one core piece it looks at that piece from its own direction, tilted along an edge
  by about 20 degrees (`EDGE_TILT`; a corner's own view shows its three sides): straight
  at its sticker showed the spots on it edge-on, and a corner view from below crowded them
  with other glass boxes, where a play-tester liked a slight angle best. Of the tilts up to
  40 degrees (`coreViews`), it takes the one showing the most of the halo (`haloShare`: of
  points over each haloed piece and spot, those a ray from the camera reaches first, a
  glass box in front counting as covering; each filled spot and glass box taken as a box,
  which weighs a corner's 25 views in a few milliseconds, where the drawn pieces, about
  62,000 triangles, froze the page for most of a second), each degree from the aim costing 1% of it; then
  from above, then nearest the view now. For other shape problems it counts every face of
  the pieces and spots, and first takes the view showing faces on the most sides. **Hide** removes the
  halo until the shown problem names other pieces; while the halo shows, a **Hide** pill in
  the halo's color in the 3D view does the same, placed clear of the puzzle as drawn, just past
  its edge on the haloed pieces' side (above it if they are at the middle; a play-tester
  found it too much beside them, and the halo and the arrow already mark them), following
  the view and kept inside it. Done, available only when valid, makes the fitted position the start
  ("Edited"). **Valid means turns can reach it:** some position showing the paint can
  be reached by turning, and Done gives that position (so it has an X2 code). Many positions
  show the same paint, because look-alike core pieces can trade places and core double
  edges are never seen; those choices absorb every swap and flip parity (the argument is at
  the top of `src/core/edit.ts`, and `test/edit.test.ts` samples it). So two outer pieces
  painted as each other are valid, and beyond the problems above the paint can be
  unreachable in only one way: the center colors arranged as no turns arrange them, either
  "Opposite centers must be red and orange, green and blue, or white and yellow" (halo on
  the centers that should be opposite) or "Wrong center color order"
  (halo on all six centers that show). Each has a hint (`centerHint`): a real puzzle's
  center colors are some rotation of solved's, with white and yellow on the two core centers
  that show, so the hint names the centers to change for the rotations that change fewest,
  each center by its color, which is its own ("The green and red centers should probably
  trade places", "The red center should probably be blue"), up to three ways, and the halo
  narrows to those centers. A cube painted as the real one shows is always
  valid, so any problem means a sticker painted wrong.
- **Step guide:** the Solve panel, in two modes. Between solves it shows **Order** and
  **Start solving**; during a solve (from Start solving until **Stop solving**, across the
  panel's foot) it shows Next step, Step start and Show step, the step's line, and the
  **steps so far**, newest at the top, each with its turn count (tap one to go to its
  start, or its **Save…** to save it as an algorithm: that goes to the Algorithms panel with
  a suggested name, selected and focused, and its Save then saves the step's turns from
  where the step starts), under the counts ("3 / 17 steps, 18 / 183 total turns": the newest step's number of
  the steps the solver planned when it was loaded, and the turns so far of the turns those
  steps add up to; until the plan is done the totals read … and the counts say what is
  being planned, "Planning: Yellow core corners…", named by the last step planned, as the
  step's line reads "Step 2 of …"); the list is top-aligned, the newest step always at its top, and when a
  step is added the older ones slide down to make room; on phones the list scrolls between
  the step's line and Stop solving. The order can't change during a solve. Anything that
  sets a new start (Shuffle, Reset, Edit puzzle, a code, a saved position, an algorithm,
  clearing the turn list) asks "End the solve in progress?" first, and ends it. In the
  playback strip, once a solve's turns have all played, ▶ gives way to a **Next step**
  button (two dots with an arrow from one to the other), which
  loads the next step; ▶ comes back with it. **Next
  step** asks the solver (`src/core/solve.ts`, "Solving method" above) for one step from
  the position shown, adds its turns at the current step, unplayed. The whole solve is
  planned at the first tap, a step at a time, in a Web Worker (`src/web/planner.ts`, the
  worker's script bundled into the page as a string; where no worker starts, on the page,
  a step per task), and a tap at a position the plan has loads its step at once; a tap
  anywhere else plans afresh from there (until the step loads, the button
  reads Working… and pulses, the line says "Working out the next step…", a second tap does
  nothing, and after 250 ms a message says so too; a turn made meanwhile drops it), and a line under the
  button gives "Step 2 of 9 —" (no "(done)" once played: the step list's ✓ says that; counted from when the guide was started; a step taken
  from anywhere but the end of the one before starts the count again), the stage and the goal,
  then on its own line "Turns:" with the turns as the solver writes them (`[setup: cycle]`). Until the step has
  been played through, its colors picture what its turns do (`stepColors`): the pieces it applies to that it moves or
  turns keep their colors (with the extension pieces moving with them as a unit), every other piece it moves or turns is
  darker gray (left for later steps), and every piece it leaves as it was is gray, even one it applies to that is not yet
  where it belongs (stickers and flat-view tiles; one gray for every color at each
  level, so a gray white can't be taken for a white). **Full color**, a small switch beside
  the counts and kept on the device, turns the grays off: every piece keeps its colors
  and its edge glow, for someone who wants to match the screen to the puzzle in hand
  rather than see what a step is for; the paths stay. Before the step's first turn, **paths** in the 3D view
  show where each piece it moves will go and how it will be turned: a path follows one of
  the piece's stickers, in that sticker's color with a dark casing, leaving the sticker and
  coming onto the face the sticker will be on within 45 degrees of straight out. A
  piece that ends up solved has a full path and a ring where its sticker lands;
  one only passing through has a dashed path. In a shape or core step, which solves no
  piece, each piece it applies to that moves or turns has a plain path (no ring), read
  from where it ends. Shape and core steps have only inner turns, which carry each core
  corner, single edge and double edge rigidly with the extension pieces against it (two,
  one and two; `attached`), so each moves as a unit: those pieces keep their colors and
  fly with it. A corner's or single edge's path follows its own sticker; a core double edge
  has no sticker and is never seen, so its unit's path, in a neutral gray, follows the
  outward sticker of one of the others. A piece that stays in its spot and only turns
  gets no path, which would show a move that isn't there (`twistPath`): a hairline stem
  runs straight out of its outermost corner or edge along the axis it turns about (always
  clear: nothing is beyond it), and on the stem's end a white disc, outlined dark, has the
  share of a whole turn it turns filled in the page's highlight blue, with a blue arrow
  just outside the rim from one end of that share to the other, the way it turns. Its
  flying piece (with its unit) rises along the stem to just past the disc, turns there
  the same way the disc shows, and drops back in, each of the three eased at both ends.
  A path goes
  around the puzzle, never through it (`route`). It starts as an arc well outside the
  puzzle (the short way around; for opposite sides, also by way of each of the six
  directions) and is pulled tight like an elastic band: each point moves toward the
  middle of its neighbors and back out of whatever it is pulled into, keeping a margin
  from every piece, so the path is straight where nothing is near and rounded where it
  bends around a piece. Near its ends it stays inside a 45 degree cone around straight
  out of the sticker and straight onto the new face. It is then let spring like a stiff rod, which spreads each bend
  over about a piece's width and keeps it convex (away from its ends it never bows in
  toward the puzzle). No sticker is ever covered, so the start is clear; the spot the
  new face looks into may be filled until the step takes that piece away, so that one
  piece doesn't count (the path is drawn faintly through it). Of the routes, the one
  costing least is taken: the length of it inside the puzzle costs most, then its length,
  how much it turns, and how far it leaves the room the 3D view shows (a sphere around
  the puzzle, whatever the view's angle). A route may leave that room by up to 0.4 of a
  piece, to round a piece near the edge of the view without a tight bend. A flying copy moves by distance along its path, so
  its speed is even (eased at the ends). It turns the way its path goes: the followed
  sticker faces out of its face at the start, away from the puzzle's center along the
  way (leaning out only within the plane of its turn, so whatever faces along the turn's
  axis keeps facing that way), and out of its new face at the end (a sticker facing the same way at both ends
  keeps facing that way), and any spin about that sticker still needed
  is spread evenly along the path. The sticker
  followed is the one whose route costs least, so a hop to a neighboring spot stays a
  short hop and the sticker facing the way the piece goes is preferred to one whose
  path would turn back on itself; one on the faces the Home view shows is favored a little. Each loop
  (`GUIDE_LOOP`): a small copy of each piece (a **flying piece**, made like the
  puzzle's own: the same rounded plastic and stickers, lit by the same room and key light,
  casting and taking shadows, its pieces hiding each other as solid ones do) flies along its path, turning as the piece will turn (it leaves showing its
  stickers as they are and arrives showing them as they will be), rests where it
  arrives, vanishes, and after a short gap the loop starts again; none of this moves
  where the device asks for reduced motion. Only the pieces the step applies to have
  edge glow. The ⓘ beside the 3D view explains how to read the paths.
  Where the puzzle is in the way, a path and its flying copy are drawn faintly (a second
  drawing that passes only behind what is already drawn, without the path's dark
  casing), so a path on the far side can't be taken for one on the near side.
  **Show** turns the 3D view to where the paths begin and end (as the editor's Show
  does for a problem). A parity step, which turns whole layers, has one neutral arrow for each turn instead:
  an arc around the outside of the layer, where a finger would swipe to turn it, as far
  around as the turn goes (`layerArrow`). **Order** switches between the solver's modes, "Corners,
  then edges" and "Top to bottom", and is kept on the device. A hold step and a regrip step
  gray nothing and have nothing for Show to show: they only turn the whole puzzle, by the
  center colors. The guide calls both **Regrip**; a hold step names the center that is up
  now ("now blue is up"). A regrip step may flip the puzzle over (`x2`); the Hold line then
  says yellow is up. Stages are named by color, not place ("Yellow core edges", "White
  corners"), since the puzzle may be held either way up.
  Each step the guide has loaded stays in the turn list in a rounded box behind a tag
  ("3. Corners"), the shown step's box outlined, a cycle step's setup turns underlined, their
  undoing underlined in italics, and a regrip ringed (the solver's `parts`); tapping a tag, or **Step start**, shows
  that step again at the position it begins from. At the step's start that button reads
  **Play step** and plays the step's turns (only its own, if later steps follow).
  **Stop** drops the step, its grays and its line and leaves
  the turn list alone; Next step starts again from the position shown. Playing the step returns the colors and the line reads "(done)". Any change that
  takes the step's turns out of the turn list (a turn by hand, Clear, Edit) drops the step,
  its grays and its line; so does Edit puzzle. Going to another panel keeps the step. With
  no step, the line says what Next step does (drawn by CSS, so it isn't in the line's text).
- **Lost?** (`#lost`, the fourth button of the Solve panel's row during a solve): for
  someone following a step on their own puzzle whose puzzle no longer matches the screen
  (a play-tester read a turn's ' wrong and couldn't get back). It asks about their puzzle
  instead of having them repaint it (`src/core/lost.ts`). It first asks which turn of the
  step shown (or the newest step) they made last, one button a turn, the last one
  highlighted (not asked for a step of one turn), and **I don't know** under them, which
  takes any turn of the step as the last (sampled: found every time, 6.5 questions on
  average and 10 at most against 5.3 and 9 with the turn named, 12 cases; about 0.25 s to
  build). The person may misremember it, so the
  candidates (`endCandidates`) are what one slip in the turns up to that one, or up to a
  turn or two either side of it, gives, and no slip up to any turn of the step; the slip
  anywhere in the step and in every step back to back before it, as far back as the solve
  goes: a turn made by another amount, left out, made twice,
  as the other layer's turn (r for R, and the reverse), or as another face's inner turn by
  the same amount (L for R); a turn the puzzle won't make is left out, as the person
  couldn't make it either; no slip at all is a candidate too, and candidates that look
  alike are one. Sampled with slips 1 to 5 turns before the last, over 6 to 12 steps, the
  right one is found every time in 5.2 questions on average and 6 at most (12 cases),
  besides the centers; 941 candidates for 20 steps take under 0.1 s. With the last turn
  really up to two either side of the one named, 5.3 on average and 9 at most (12 cases);
  a slip's words then also say which turn was made last. It then asks which center color is on top and which faces the
  person, and turns every candidate whole to be held that way, and the puzzle shown with
  them (the turns' result with no slip); then, one at a time, the
  question whose answers split the candidates left most evenly (then the spot easiest to
  look at: top, front and right before bottom and back), each saying where to look on the
  puzzle as the person holds it, by the side and its center (`lostSideWords`: "Look at your
  puzzle, not this screen: the right side, the one with the red center. What color is the
  sticker in the ring?"; the centers' colors are the same in every candidate held that way;
  a play-tester lost track of which way was up as the view turned to each spot): the color in a ring on one face
  (answers: the colors some candidate shows there, "No sticker", **No piece here** where
  the spot can be empty, which is an extension spot and never a core one (`canBeEmpty`),
  and **None of these**), or whether there is a piece at an extension spot ("Is there a piece here?", as Edit
  puzzle's hints say "here"), marked as Edit puzzle marks a piece: the halo's outline around
  the piece there, or around a glass box in the spot when it is empty (the Shape tool's,
  1.4 times as large, `LOST_GHOST_SCALE`), hidden where the puzzle is in front of it (a box
  drawn over everything confused a play-tester where it marked a piece already there). Meanwhile
  the puzzle shown is where the step should leave it, all gray (matte, as the step guide's
  grays are: the stickers' film made a gray seen face-on look white; so it can't be read for
  theirs) except what the person has told: the two centers in the colors named, and each
  sticker answered in its color, kept as the view turns (`lostKnown`); the view
  turns to each spot, the turn list and the tabs are set aside, and swipes on the cube
  tumble the view instead of turning. Sampled over 476 steps (two steps' slips), the
  right position is found every time, after 3.3 questions about spots on average and 6
  at most, besides the two about centers. Found, it shows that position in full color,
  says what the slip was ("Turn 4 of step 5, R', was made as R.") and asks whether their
  puzzle looks like this. **Yes**: the turn list takes the turns they made (and the
  regrip to how they hold it), then a **Back on track** step (stage `recover`, numbered
  as the step it goes back to, graying nothing, with no paths) that undoes them, back to
  where the step the slip was in began; Next step after it gives that step again with
  the same number. When there is nothing to undo (a step's only turn left out), no step
  is loaded: the message says so, and Next step gives the step again (an empty step in the
  turn list froze the page). With no slip, nothing is undone: held as the screen is, the turn list
  stays and the position goes to the turn they made last ("Your puzzle is where turn 6
  of step 10 leaves it"). **No**, No piece here or None of these:
  it **gives up** and says so, in the first person, as Lost? speaks to the person ("I can't
  find how your puzzle got this way", why, and what to do), with **Edit puzzle** (not "color": the editor changes the shape too), which opens Edit
  puzzle, starting from the position found nearest, while the solve stays (no "End the
  solve?"; `lostEdit`). There Done reads **Continue search** and Cancel **Cancel edit**; Continue search looks
  again from the puzzle edited, now known exactly, with every last turn from six before
  the one named to the end of the turns: a way Lost? knows that gives it loads
  the Back on track step as Yes does; with none, the message says so and the solve starts
  again from it. **Cancel** there, as in the interview, puts the turn list, the steps and
  the shown step back as they were. Each candidate's answers come from the model, so None
  of these means a slip it doesn't list (two slips, for one). Starting Lost? drops a
  question still waiting ("End the solve in progress?"), and Edit puzzle ends an
  interview: answered under one, it left the editor gray.
  **Two stacked mistakes:** asked from a Back on track step (a slip, then another while
  putting it right), the candidates also take two slips in that step's last 14 turns up to
  the one named (`twoSlipCandidates`, `LOST_TWO_SLIP_TURNS`; about 1,700 candidates, 0.1 s;
  sampled, found every time in 7.1 questions on average and 9 at most, 12 cases), and the
  words name both ("Two turns went another way: turn 26 of step 1, F', was made as F, and
  turn 28, R', was left out."). Continue search, knowing the puzzle exactly, tries two slips
  over the whole step asked from (a 30-turn step: about 13,000, 0.7 s) once one slip finds
  nothing. Elsewhere the interview takes one mistake, which keeps it short; more than that
  ends in Edit puzzle.
- **Hold line:** under the view buttons, "Hold: white up, blue front, orange right": the
  center colors up, toward you and on your right as they are now (slice turns move the side
  centers). Tell the owner how to hold the cube from it, never from the solved colors.
- **Turn field:** in the Turn panel, under the turn buttons. Load adds the typed turns at
  the current step (replacing any after it) and empties the field, so the turn list is the
  one record of the turns. Edit puts the whole turn list in the field and Load reads Update:
  it replaces the list, keeping the position where the old and new lists agree; Cancel
  leaves the list as it was.
- **Algorithms list:** the Algorithms panel. Load makes an algorithm's position
  the start, with its turns loaded and unplayed; Save keeps the turn list with the
  current start position; ✕ deletes (after Delete or Keep). Kept like saved states: the shared
  database's `algorithms` collection (`name`, `alg`, `code` for the start position, `note`,
  `savedAt`, `source`), seeded by Claude from the known algorithms, or this device, where it
  starts as them. The known algorithms (`src/core/algorithms.ts`) are each checked from their
  position by `test/algorithms.test.ts` and described in `ALGORITHMS.md`.
- **Saved states:** stored in the artifact's shared database, collection `states`, with
  fields `name`, `code` (a state code), `note`, `savedAt`, `source` (`page` or `claude`).

- **Probe:** `window.xcubeProbe` (end of `src/web/main.ts`) tells the browser tests what
  is drawn where: the screen position of a sticker's center, and, for a point of the 3D
  view or a cell of the flat view, the slot, face and color drawn there (the slot and face
  from the piece's mesh, so a misdrawn piece shows up), and the stickers the model
  turns toward the camera that are not drawn, and how strong one piece's edge glow is at
  a point in either view. It draws into its own offscreen buffer (an
  ID pass and a plain-color pass), so the views don't change. Its fault methods misdraw
  pieces on purpose, so a test can check that the drawing checks catch them. It also
  reports what the effect switches control, how far the shading and the glow computed
  during a turn are, at its start, from those at rest, and whether one glow band is drawn
  right now (also part-way through a turn).
  Gestures read event timestamps, not handler time, so a slow frame can't change what a
  gesture means.

Tried and removed: screen-space ambient occlusion (SAO, then GTAO). Both showed artifacts
on this scene that the grid shading does not have.

## Working conventions

These apply to every agent (Claude Code, Codex, or another), and most are adapted from
`ahernsean/wordle`.

### Respond to what's being asked

- A question ("what do you think", "what should I do", "how would I") gets an answer in
  words, not code. Stop there and wait for a decision.
- A bug report is not by itself permission to edit. Diagnose and propose a fix first,
  unless the wording already asks for the fix.
- An explicit request for a change is permission to make it. In a cloud session the owner
  can't see the container, so a change is done only when it is pushed to a pull request.

### Look at the repository before you start

Run `git status` and `git branch --show-current` first. Another agent may be working in the
same checkout. If the branch isn't `main`, the tree has changes you didn't make, or
`git log origin/main..HEAD` lists commits that aren't yours, work in your own worktree
(`git worktree add -b <branch> <path> origin/main`) instead of on top of theirs.

### Ask first, always

Never do any of these without an explicit instruction from the owner:

- merge a pull request ("CI is green" or "looks good" is not an instruction to merge);
- delete a branch;
- rewrite history (rebase, amend) or force push;
- commit to `main`. Work goes on a branch with a pull request for the owner to merge, with
  no exceptions.

### Commits and checks

- One commit per change, so the owner can back out any single step.
- Write or extend a test for every new or changed behavior.
- Name every test `<topic>: <what it checks>`, with a short lowercase topic shared by the
  tests of one area (`edit:`, `notation:`, `playback:`), so `--test-name-pattern="^topic:"`
  selects that area.
- **Test locally only what you changed; let CI test the rest.** The full browser run takes
  10 to 15 minutes for both engines, which stalls iterating with the owner. So:
  - Before committing, run `npx tsc --noEmit` (fast) and only the tests that cover the code
    you changed: one unit test file (`node --test test/edit.test.ts`), or one test by name
    (`node --test --test-name-pattern="^edit:" test/*.test.ts`). For a Lab change, build
    (`node scripts/build-web.ts`) and run the browser tests of the area you changed
    (`node --test --test-name-pattern="^playback:" scripts/browser-tests.mjs`, with
    `BROWSER=webkit` for WebKit), or check a behavior they don't cover yet with a short
    Playwright script in your scratch space, at phone width (390 px) where layout is involved.
  - Don't run the full `npm test` or `scripts/browser-tests.mjs` locally as a matter of
    course, and never for code you didn't change, or after a merge from `main` with no
    conflicts. Push, and let CI run everything.
  - Use CI as your test runner: after pushing, read the check results (the GitHub tools give
    the check runs and job logs) and fix what fails. Reproduce a CI failure locally with the
    narrowest run that shows it, then show that same run passing.
  - A push to a pull request cancels CI still running on its previous commit; that run's
    `all checks` is then skipped (it runs only if the run wasn't cancelled), not failed.
    A replaced run is part of the normal process, not a failure. When
    a check result or any other CI notice is for a commit that is no longer the pull
    request's head, say nothing about it to the owner: no report, no "nothing to act on",
    no mention in a later summary. Check which commit it is for, and if it is superseded,
    end the turn without comment. Only results on the current head are worth a message.
- CI (`.github/workflows/ci.yml`) runs the unit tests, the typecheck, and the build and
  browser tests in Chromium and WebKit, each as its own check, all on Node 24 (the version
  `package.json` requires). Keep it green. It reports coverage (unit tests, and browser
  tests in Chromium) on each run's summary page; no minimum is enforced. When you add
  a Lab behavior, test it in `scripts/browser-tests.mjs`, through the probe if it draws.
  Each browser test (`labTest`) opens the Lab in its own browser context, so it must set
  up everything it needs itself and can run alone. The `all checks` job is the
  one a branch rule on `main` requires; renaming it means changing the rule.
- **Publish the Lab early.** When your work includes publishing the Lab, publish as soon
  as the change builds and its focused check passes. Don't wait for a commit, a pull
  request or CI: the owner tries changes in the Lab before they are shared with others,
  and rapid feedback is the point. If CI then fails, fix it and publish again. This says
  when to publish, not that every change must be published: if the owner has said to hold
  off (for example while another agent is publishing), wait until they say go.
- Library versions must be at least two weeks old.

### Safari is the main browser

The owner uses the Lab mostly on an iPhone and iPad, where every browser is WebKit. A run
that covers only Chromium has not tested the main engine; CI's WebKit check covers it on
every push. Run WebKit locally only to reproduce a WebKit failure or to check a change
that touches something engines differ on (layout, gestures, WebGL): install it with
`npx playwright install --with-deps webkit`, then point your focused check at `webkit`.

In a container without a GPU, Mesa's EGL and llvmpipe must be installed before you run
the browser tests, as CI installs them: without them Chromium quietly draws with
SwiftShader, and every test runs about ten times slower. In Claude Code cloud sessions
`.claude/hooks/session-start.sh` installs them at the start of each session. Any other
agent installs them when its container is created:
`apt-get install -y --no-install-recommends libegl1 libegl-mesa0 libgl1-mesa-dri`.
Run Chromium tests with `EXPECT_RENDERER=llvmpipe`, so the startup test fails if Chromium
fell back anyway.

### A screenshot is not evidence about width

A full-page screenshot is as wide as the page, so a page that scrolls sideways looks fine
in it. Measure instead: `document.documentElement.scrollWidth` must not exceed
`clientWidth` at 390 px. The browser tests check this.

### Comments

Describe what the code is and its non-obvious rules, not how it got that way ("was renamed
from", "replaces the old"). Don't restate what the names already say, and don't refer to
context a cold reader doesn't have.

### Pull requests

- Open every pull request as a **draft**, and leave it a draft until the owner says it is
  ready. Only then mark it ready for review (which also starts the Codex review).
- The description has a **Summary** section only, describing what changed and why.
- Keep the title and description current with every push; never leave them describing
  only some of the commits.
- After opening a pull request, subscribe to its activity if you can, and handle review
  comments and CI failures.
- Codex and Claude may both review pull requests. Treat a review finding as a claim to
  check: reproduce it, then fix it with a test or reply with the evidence that it's wrong.
