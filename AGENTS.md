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

## Algorithms

`ALGORITHMS.md` collects algorithms found or verified with the engine, each with the
situation it solves, how to recognize it, and the test that checks it. Add new ones there,
and to `src/core/algorithms.ts` (with an example position) so the Lab lists them.

## Code map

- `src/core/geometry.ts`: rotations, directions.
- `src/core/puzzle.ts`: slots, cubelets, state, move definitions, applying turns.
- `src/core/notation.ts`: parser and formatter.
- `src/core/analyze.ts`: shape and solved tests, effect (cycles and twists), text face views,
  flat-view rim data (`faceRimView`).
- `src/core/algorithms.ts`: the known algorithms the Lab lists, each with an example position.
- `src/core/edit.ts`: fitting edited sticker colors to real cubelets (the Lab's color editor).
- `src/core/search.ts`, `src/core/goals.ts`: iterative-deepening search with goal masks
  based on appearance (look-alike twins compare equal).
- `src/cli/xc.ts`: command-line driver (see `README.md`).
- `src/web/`: **X-Cube Lab**, the browser viewer, built by `scripts/build-web.ts` into
  `dist/x-cube-lab.html` (published as a claude.ai artifact, which supplies the document
  skeleton) and `dist/index.html` (a complete page, published to GitHub Pages at
  https://ahernsean.github.io/x-cube/ by `.github/workflows/pages.yml` on every change to
  `main`).

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
  two fingers spin it; double tap (cube or background) undoes the last turn. The ⓘ button
  beside the 3D view's heading shows this help.
- **Display panel:** the Display button beside the 3D view's heading opens the Edge glow,
  Shading, Shadows and Gloss switches, over the view.
- **Layout rule:** on a phone, nothing appears or disappears in the page's flow except
  through a disclosure triangle (and the turn list, which grows with the turns). Help and
  switches open in panels over the views; messages float near the bottom of the screen and
  fade after 4 seconds (8 for errors) or a tap. The browser tests check the page height.
- **Playback:** ⏮ back to the start, ◀ play backward to the start, ◀1 back one turn, ▶1
  forward one, ▶ play to the end; the slider sets 1600 to 30 ms per quarter turn.
- **Clear:** empties the turn list; the position shown becomes the start ("Current position").
- **Shuffle:** 30 random legal turns (inner, slices, outer when complete; never the same
  layer twice in a row; no rotations) played at 70 ms per quarter turn; the result becomes
  the new start ("Shuffled") and the message shows the scramble.
- **Turn buttons:** tap for the shown turn; long press flips it to the inverse (U to U');
  slide off to cancel.
- **Flat view:** the six faces as seen straight on, drawn from the same scene by
  orthographic cameras, so it animates. Its ⓘ button explains how to read it.
- **Edge glow:** a soft band at a depth discontinuity, in the color of the sticker around
  the edge. No glow means that side has no sticker. Only shown where the side face points
  away from the viewer or is edge-on. Where two visible faces of one cubelet meet, the
  hidden sticker's glow continues around the corner between them, rounded like the
  sticker's corner; elsewhere a glow fades out at its ends, and always in the flat view,
  which sees only one side of a corner.
- **Shading:** grid-based ambient occlusion. Each face corner is darkened by filled grid
  spots in front of it (three near, five farther with less weight), blended across the
  face. Applied to stickers and plastic; recomputed every frame during turns. The flat
  view shades each tile from its neighbors in the view instead: each neighbor standing
  nearer casts a band along the shared edge (a patch, if it touches only a corner), dark
  at the edge and gone within 30% of the tile; where bands overlap the darker wins. A
  visible face at depth 0 or below has always been unstickered in sampled positions, so
  every drop seen on a sticker is one step.
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
- **Color editing:** Edit colors under the 3D view. Pick a color, then tap stickers to paint
  them; drags tumble the view, and the other controls are set aside. The shape stays as it
  is. A painted sticker's edge glow takes the paint too. Each paint is refit to cubelets
  (`fitColors` in `src/core/edit.ts`), and a line says "Valid", or "Not valid:" with what's
  wrong: no cubelet of that kind can have a color (core corners are only white or
  yellow), two stickers of one color or opposite colors, a corner's colors going around it
  in mirrored order ("Wrong color order"), one cubelet needed in two spots, or an outer
  cubelet turned against the outward-color rule (a sign of a sticker
  painted wrong; the physical cube can't do that). It says what, not where ("A
  cubelet shows yellow, red, and orange, but red and orange are opposite colors, never on
  one cubelet"), not where: words for a spot proved unreliable (center colors move with
  slices, extensions leave their sides, left depends on the viewpoint), so the Lab points
  the spot out instead. Lists of three colors use the serial comma. The first problem's
  cubelets get a **halo** by themselves: a purple glow around the whole cubelet, drawn
  over everything (so it shows a cubelet behind others), in the 3D view and on each
  flat-view face where the cubelet shows. A halo appearing never moves the view. **Show**
  (or tapping the line) tumbles the 3D view to show those cubelets' stickers best (the
  most unblocked, then each as squarely as possible, from the preset views and the
  directions between the stickers), again each time it is tapped. **Hide** removes the
  halo until the problem names other cubelets. Done, available only when valid, makes the fitted position the start
  ("Edited colors"). Whether a valid position can be reached by turning is not checked yet.
- **Hold line:** under the view buttons, "Hold: white up, blue front, orange right": the
  center colors up, toward you and on your right as they are now (slice turns move the side
  centers). Tell the owner how to hold the cube from it, never from the solved colors.
- **Turn field:** in the Run an algorithm panel, under Clear. Load adds the typed turns at
  the current step (replacing any after it) and empties the field, so the turn list is the
  one record of the turns. Edit puts the whole turn list in the field and Load reads Update:
  it replaces the list, keeping the position where the old and new lists agree; Cancel
  leaves the list as it was.
- **Algorithms list:** in the Run an algorithm panel. Load makes an algorithm's position
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
  from the cubelet's mesh, so a misdrawn cubelet shows up), and the stickers the model
  turns toward the camera that are not drawn, and how strong one cubelet's edge glow is at
  a point in either view. It draws into its own offscreen buffer (an
  ID pass and a plain-color pass), so the views don't change. Its fault methods misdraw
  cubelets on purpose, so a test can check that the drawing checks catch them. It also
  reports what the effect switches control, and how far the shading computed during a
  turn is, at its start, from the rest shading.
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
- **Test locally only what you changed; let CI test the rest.** The full browser run takes
  10 to 15 minutes for both engines, which stalls iterating with the owner. So:
  - Before committing, run `npx tsc --noEmit` (fast) and only the tests that cover the code
    you changed: one unit test file (`node --test test/edit.test.ts`), or one test by name
    (`node --test --test-name-pattern="^edit:" test/*.test.ts`). For a Lab change, build
    (`node scripts/build-web.ts`) and check the changed behavior with a short Playwright
    script in your scratch space, at phone width (390 px) where layout is involved.
  - Don't run the full `npm test` or `scripts/browser-tests.mjs` locally as a matter of
    course, and never for code you didn't change, or after a merge from `main` with no
    conflicts. Push, and let CI run everything.
  - Use CI as your test runner: after pushing, read the check results (the GitHub tools give
    the check runs and job logs) and fix what fails. Reproduce a CI failure locally with the
    narrowest run that shows it, then show that same run passing.
- CI (`.github/workflows/ci.yml`) runs the unit tests, the typecheck, and the build and
  browser tests in Chromium and WebKit, each as its own check, all on Node 24 (the version
  `package.json` requires). Keep it green. It reports coverage (unit tests, and browser
  tests in Chromium) on each run's summary page; no minimum is enforced. When you add
  a Lab behavior, test it in `scripts/browser-tests.mjs`, through the probe if it draws. The `all checks` job is the
  one a branch rule on `main` requires; renaming it means changing the rule.
- **Publish the Lab early**, as soon as a change builds and its focused check passes,
  without waiting for CI: the owner tries changes in the Lab while CI runs. If CI then
  fails, fix it and publish again.
- Library versions must be at least two weeks old.

### Safari is the main browser

The owner uses the Lab mostly on an iPhone and iPad, where every browser is WebKit. A run
that covers only Chromium has not tested the main engine; CI's WebKit check covers it on
every push. Run WebKit locally only to reproduce a WebKit failure or to check a change
that touches something engines differ on (layout, gestures, WebGL): install it with
`npx playwright install --with-deps webkit`, then point your focused check at `webkit`.

### A screenshot is not evidence about width

A full-page screenshot is as wide as the page, so a page that scrolls sideways looks fine
in it. Measure instead: `document.documentElement.scrollWidth` must not exceed
`clientWidth` at 390 px. The browser tests check this.

### Comments

Describe what the code is and its non-obvious rules, not how it got that way ("was renamed
from", "replaces the old"). Don't restate what the names already say, and don't refer to
context a cold reader doesn't have.

### Pull requests

- The description has a **Summary** section only, describing what changed and why.
- Keep the title and description current with every push; never leave them describing
  only some of the commits.
- After opening a pull request, subscribe to its activity if you can, and handle review
  comments and CI failures.
- Codex and Claude may both review pull requests. Treat a review finding as a claim to
  check: reproduce it, then fix it with a test or reply with the evidence that it's wrong.
