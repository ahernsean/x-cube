# X-Cube simulator

This file is for anyone using the puzzle, the Lab or the command line: how to hold the
puzzle, the notation, slot names, where the Lab runs and the commands. **Agents (and
anyone changing the code) also read [AGENTS.md](AGENTS.md)** for the vocabulary, the model,
the piece kinds and the code map. Solving algorithms are in [ALGORITHMS.md](ALGORITHMS.md).

A simulator and algorithm-search toolkit for the X-Cube (Moving Parts, 2013): a 3x3x3
with 3x3 extensions on four sides that turn on their own only when complete.

- `src/core/` is the engine (TypeScript, no dependencies). The CLI and the browser viewer share it.
- `src/cli/xc.ts` is the command-line driver.
- `src/web/` is the browser viewer ("X-Cube Lab"). It is built into one HTML file.
- `test/` holds the tests. They encode the behavior confirmed on the physical puzzle.

## Holding the puzzle

Hold the puzzle with the X-faces up and down: white up, green front. That leaves
red right, orange left and blue back. The colors are set in `FACE_COLOR` in
`src/core/puzzle.ts`, so change them there if your puzzle differs.

## Notation

| Notation | Meaning |
|---|---|
| `R L U D F B` | Inner turns: the 3x3x3 layer plus everything beyond it, including the extension. Clockwise looking at that face. Always allowed. |
| `r l f b` (`u d`) | Outer turns: the extension alone. Allowed only when all 9 of its pieces are present. |
| `E` | The horizontal middle layer, turned like `D`. |
| `H` | The X-Cube's name for `E'`: the horizontal middle layer, turned like `U`. |
| `M` | The middle layer between L and R, turned like `L`. |
| `S` | The middle layer between F and B, turned like `F`. |
| `x y z` | The whole puzzle, turned like `R`, `U` and `F`. |
| `'` and `2` | Counterclockwise and half turn. `2'` is read as `2`; `′` and `’` as `'`. |
| `(A)5`, `(A)x5`, `(A)*5`, `(A) x 5` | Repeat a group. |
| `(A)'` | Inverse of a group: its turns in reverse order, each the other way. |
| `[A, B]` | Commutator: `A B A' B'`. |
| `[A: B]` | Conjugate: `A B A'` (set up, do, undo the setup). |

Commas and periods outside brackets are read as spaces.

**Standard notation.** `R L U D F B`, `x y z`, `'` and `2` are the WCA's notation (WCA
Regulations, Article 12, version of April 1, 2026); `x` turns like `R`. `M`, `E` and `S` are
not in the Regulations; they are the usual names for the middle slices. `H` is not
standard: the standard name for that turn is `E'`. No standard covers the X-Cube's
extensions, so `r l u d f b` are this project's own.

On the 3x3x3 (`--puzzle cube3`), `H` and lowercase letters are refused. The WCA has no
lowercase wide turns (it reads `r` as `R`, Regulation E2c6+), and on the X-Cube `r` is an
outer turn. The WCA's wide turns `Rw` (`R M'`, or `L x`) and `2Rw` (the same turn on a
3x3x3, Regulation 12a2+) are accepted when typed, so standard algorithms paste as written;
the Lab never offers them.

**Grip difference from Dave Baum's page.** Baum holds the X-faces front and back, so his
letters name different layers. Translated to the white-up grip:
- his `F U B D` are our `U B D F`, and `L R` are unchanged;
- his `u` is our `b`;
- his `H` is our `S'`.

His edge 3-cycle becomes `R' S' R b R' S R b'`, and his corner 3-cycle becomes
`R' F' R b R' F R b'`. Both are verified in the tests.

## Slot names

A slot is a place a piece can be. Core slots use standard names: `UFR`, `UF`, `U`.
Extension slots are named `<face>x.<position>`: `Fx.UR` is the up-right piece of the front
extension, `Fx` its center, and `Ux.F` the front spot of the (normally empty) up extension.
In cycle output, `A -> B` means the piece that was in slot A is now in slot B.

## Where to run it

X-Cube Lab runs in three places. The command-line tools run wherever Node.js does.

| | Saved states | Best for |
|---|---|---|
| **claude.ai artifact** | Shared list, kept in the artifact's database | Working with Claude: it can read and add saved states |
| **GitHub Pages**: https://ahernsean.github.io/x-cube/ | In that browser only | Any browser or phone, nothing to install |
| **Your own copy** | In that browser only | Trying changes to the code |

Outside the artifact the Saved states badge reads "This device only". To move a position
between places, copy its state code (44 letters, short enough to type by hand) and paste
or type it where you need it.

### GitHub Pages

Open https://ahernsean.github.io/x-cube/ in any browser, including Safari on an iPhone or
iPad. It is rebuilt and published from `main` on every merge by
`.github/workflows/pages.yml`, so it shows the latest merged version. It needs the internet:
three.js comes from cdn.jsdelivr.net and the fonts from Google Fonts.

### Your own copy: one-time setup (Mac or Linux)

1. Install **Node.js 24 or newer** from [nodejs.org](https://nodejs.org). Check with `node -v`.
2. Get the code and its build tools:
   ```
   git clone https://github.com/ahernsean/x-cube.git
   cd x-cube
   npm ci
   ```
   `npm ci` installs exactly the versions in `package-lock.json`.

### Your own copy in a desktop browser

```
node scripts/build-web.ts        # builds dist/index.html (and the artifact's dist/x-cube-lab.html)
open dist/index.html             # Mac; on Linux, xdg-open
```

Open `dist/index.html`, the complete page. `dist/x-cube-lab.html` is only the page body
that claude.ai wraps when it publishes the artifact. After pulling new code, build again
and reload.

### Your own copy on an iPhone or iPad

To try unmerged changes on a phone, serve the page from a computer on the same Wi-Fi
network:

```
cd dist
python3 -m http.server 8000
```

Then open `http://<computer's IP address>:8000/` in Safari. On a Mac the IP address is under
System Settings → Wi-Fi → Details. The page is there only while the server runs. For the
merged version, use GitHub Pages instead.

### The command-line tools

From the `x-cube` folder (examples are under [Commands](#commands)):

```
node src/cli/xc.ts show "R U R' U'"
node src/cli/xc.ts show "U" --state "VLTM DWOP ..."   # start from a state code copied from the Lab
```

### The checks CI runs

```
npx tsc --noEmit                                   # typecheck
npm test                                           # unit tests
npm run test:coverage                              # unit tests, with a coverage table
npm install --no-save playwright@1.64.1            # browser tests need Playwright...
npx playwright install --with-deps chromium webkit # ...and its browsers
node scripts/build-web.ts                          # the browser tests test the build
node --test scripts/browser-tests.mjs              # browser tests in Chromium
BROWSER=webkit node --test scripts/browser-tests.mjs  # WebKit is Safari's engine
```

Every test, unit or browser, is named `<topic>: <what it checks>`, and each browser test
opens the Lab afresh, so any test or topic can run alone:

```
node --test --test-name-pattern="^notation:" test/*.test.ts
node --test --test-name-pattern="^playback:" scripts/browser-tests.mjs
BROWSER=webkit node --test --test-name-pattern="^gestures:" scripts/browser-tests.mjs
```

The browser tests check that the Lab loads; that turns, undo, playback, Shuffle, saving,
state codes, color editing and the effect switches work; that swipes, taps and long presses do what they
should; and that the 3D and flat views draw every sticker where the puzzle model puts it,
in its color.

CI also measures coverage: which lines of the code the tests ran. The unit tests' table
and the browser tests' summary (Chromium only) appear on each CI run's summary page, and
the browser tests' full report, line by line, is attached to the run as
`browser-coverage`. To produce it yourself:

```
node scripts/build-web.ts --sourcemap
npm install --no-save monocart-coverage-reports@2.13.2
COVERAGE_DIR=coverage/browser node --test scripts/browser-tests.mjs   # open coverage/browser/index.html
```

## Commands

```
npm install
npm test
node src/cli/xc.ts show   "R' S' R b R' S R b'"   # status, flat view, cycles
node src/cli/xc.ts steps  "R U R' U'"             # status after every turn
node src/cli/xc.ts effect "[R' F' R, b]"          # which pieces moved
node src/cli/xc.ts order  "R U"                   # repetitions until it looks the same
node src/cli/xc.ts solve  "R U F' l"              # steps from that position to solved
node src/cli/xc.ts solve  "R U F' l" --mode layers   # ... solving the outer pieces top to bottom
node src/cli/xc.ts show "U" --from "R"            # start from solved + setup
node src/cli/xc.ts show "U" --state "VLTM DWOP ..."        # start from a saved state code
node src/cli/xc.ts show "R U M'" --puzzle cube3             # a traditional 3x3x3 (turning only, so far)
node scripts/build-web.ts                         # build dist/index.html and dist/x-cube-lab.html
node --test scripts/browser-tests.mjs             # browser tests of the built Lab (needs Playwright;
                                                  # BROWSER=webkit for WebKit)
```

The notation and slot names are under [Notation](#notation) and [Slot names](#slot-names).

## Search

`src/core/search.ts` is an iterative-deepening search that only tries same-axis turns in
one order. Goals come from `src/core/goals.ts`, which compares how slots look, so you can
leave "don't care" regions out of the mask. It runs at roughly 2 to 3 million positions per
second in Node, which is practical to about 7 turns. Deeper searches will need distance
tables or meet-in-the-middle.
