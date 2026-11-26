// Browser tests for the built X-Cube Lab (dist/x-cube-lab.html).
// Opens it in a headless browser and checks that it loads without errors, that the core
// interactions and gestures work, and that the 3D and flat views draw each sticker where
// the puzzle model puts it, in its color (through window.xcubeProbe, defined at the end of
// src/web/main.ts). Run after `node scripts/build-web.ts`.
//
//   node --test scripts/browser-tests.mjs                     # Chromium
//   BROWSER=webkit node --test scripts/browser-tests.mjs      # WebKit, the engine of Safari
//   node --test --test-name-pattern="^playback:" scripts/browser-tests.mjs
//                                                             # only the playback tests
//   COVERAGE_DIR=coverage/browser node --test scripts/browser-tests.mjs
//                                           # Chromium, with a coverage report (build with
//                                           # --sourcemap; needs monocart-coverage-reports)
//
// Each test opens the Lab in a new browser context (empty storage, nothing left over from
// another test), so any test can run alone. Within a test, every check prints an ok/FAIL
// line, and the test fails at its end if any check did.
//
// Needs the `playwright` package and the browser for it (CI installs both). WebKit runs
// with touch because the Lab is used mostly on an iPhone and iPad, and both engines draw at
// device pixel ratio 1: every pixel is drawn on the CPU here, and nothing the tests check
// depends on the density (the standalone page's layout test alone runs as an iPhone, at
// ratio 3). WebKit is not given `isMobile`: the built page has no viewport meta tag
// (claude.ai adds one when it publishes the artifact), so a mobile layout would be 980 px wide.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

// require() also finds a globally installed Playwright (as in some dev containers);
// in CI it is installed into node_modules.
const playwright = createRequire(import.meta.url)("playwright");

if (process.argv[2]) throw new Error(`choose the browser with BROWSER=${process.argv[2]}, not an argument`);
const engine = process.env.BROWSER || "chromium";
if (!["chromium", "webkit"].includes(engine)) throw new Error(`unknown BROWSER "${engine}" (use chromium or webkit)`);

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(resolve(here, "../dist/x-cube-lab.html")).href;
const standaloneUrl = pathToFileURL(resolve(here, "../dist/index.html")).href;

// Coverage, Chromium only: with COVERAGE_DIR set, V8 records which code each page ran,
// and monocart-coverage-reports maps it to the TypeScript sources through the inline
// source map of a `node scripts/build-web.ts --sourcemap` build.
const coverageDir = engine === "chromium" ? process.env.COVERAGE_DIR : undefined;
if (process.env.COVERAGE_DIR && !coverageDir) console.log(`(coverage is recorded only in Chromium; ${engine} runs without it)`);
const coverage = [];

// Without a GPU, headless Chromium draws WebGL with SwiftShader, which here is about four
// times slower than Mesa's llvmpipe. These flags
// send Chromium's ANGLE to Mesa through EGL instead. Where Mesa's EGL is missing, Chromium
// quietly keeps SwiftShader, so the startup test reports the renderer in use (in either
// engine), and with EXPECT_RENDERER set (CI sets it to llvmpipe) a different one fails it
// in Chromium.
const launchArgs = engine === "chromium" && process.platform === "linux" ? ["--ignore-gpu-blocklist", "--use-angle=gl-egl"] : [];
// Where the network is reached through a proxy (HTTPS_PROXY, as in some cloud sandboxes),
// the browser and the CDN downloads below (route.fetch, made by Playwright, not the page)
// use it too; without this those downloads try to reach the CDN directly and fail.
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
const proxy = proxyServer ? { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } : undefined;
let browser;
before(async () => {
  browser = await playwright[engine].launch({ args: launchArgs, proxy });
  console.log(`${engine} ${browser.version()}`);
});

after(async () => {
  await browser?.close();
  if (!coverageDir) return;
  const MCR = createRequire(import.meta.url)("monocart-coverage-reports");
  const report = MCR({
    name: "X-Cube Lab: browser test coverage (Chromium)",
    outputDir: coverageDir,
    reports: ["v8", "console-details", "markdown-summary"],
    entryFilter: (entry) => entry.url.startsWith("file:") && entry.url.endsWith(".html"),
    sourceFilter: (path) => path.includes("src/"),
  });
  await report.add(coverage);
  await report.generate();
});

// The page loads three.js and its fonts from CDNs. A new context starts with an empty
// HTTP cache, so these are fetched once per run and served to every context from memory.
// Most of a page's start is the WebGL work of its first frames, which this doesn't touch;
// it saves the repeated downloads, and a slow or failing CDN can only affect the first.
const cdnFiles = new Map();
const serveCdnFromMemory = (context) =>
  context.route(/^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, async (route) => {
    const url = route.request().url();
    if (!cdnFiles.has(url))
      cdnFiles.set(
        url,
        route.fetch().then(async (r) => {
          const headers = { ...r.headers() };
          // The body comes back decoded, so it no longer matches these.
          delete headers["content-encoding"];
          delete headers["content-length"];
          return { status: r.status(), headers, body: await r.body() };
        }),
      );
    let file;
    try {
      file = await cdnFiles.get(url);
    } catch (e) {
      cdnFiles.delete(url); // let a later test try the download again
      throw e;
    }
    await route.fulfill(file);
  });

const labContext = () =>
  engine === "webkit"
    ? { viewport: { width: 390, height: 900 }, hasTouch: true }
    : { viewport: { width: 390, height: 900 } };

// Opens a page in a new context, ready to use: the Lab has drawn and is idle. `expand`
// opens every collapsed section and brings the 3D view into sight, as most tests need.
async function openLab({ url = pageUrl, context: contextOptions = labContext(), expand = true, initScript, ready = () => window.xcubeProbe?.idle() } = {}) {
  const context = await browser.newContext(contextOptions);
  await serveCdnFromMemory(context);
  const page = await context.newPage();
  if (coverageDir) await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // Software-rendering GPU chatter is not a page error.
    if (m.type() === "error" && !/GPU stall|GL Driver|WebGL/.test(m.text())) errors.push(m.text());
  });
  if (initScript) await page.addInitScript(initScript);
  await page.goto(url);
  await page.waitForFunction(ready, null, { timeout: 60000 });
  await page.waitForTimeout(100);
  const h = helpers(page);
  if (expand) {
    await page.evaluate(() => document.querySelectorAll("[data-sec].collapsed").forEach((s) => s.classList.remove("collapsed")));
    await page.locator("#scene").scrollIntoViewIfNeeded();
    await h.settle();
  }
  const close = async () => {
    if (coverageDir) coverage.push(...(await page.coverage.stopJSCoverage()));
    await context.close();
  };
  return { page, context, errors, close, ...h };
}

/** Reset to solved, if it applies (it is grayed out when solved with no turns), ending a solve if one is under way. */
async function resetToSolved(page) {
  if (await page.$eval("#reset", (b) => b.disabled)) return;
  await page.evaluate(() => document.getElementById("reset").click());
  if (!(await page.$eval("#confirm", (d) => d.hidden))) await page.click("#confirm-yes");
}

/** Picks the solve's order, stopping a solve under way first (the order is chosen between solves). */
async function setOrder(page, mode) {
  if (!(await page.$eval("#guide-stop", (b) => b.disabled))) await page.click("#guide-stop");
  await page.click(`[data-guide-mode="${mode}"]`);
}

/** The step guide's line, and Next step (opening the guide first if it is closed). */
function guideHelpers(page, settle) {
  const line = () => page.$eval("#guide-line", (e) => e.textContent);
  const next = async () => {
    await page.evaluate(() => (document.getElementById("guide").open = true));
    await page.click("#next-step");
    await settle();
  };
  return { line, next };
}

// A test of the Lab: `body` gets the open page, its helpers and `check`. Every test also
// checks that the page reported no errors.
function labTest(name, body, options = {}) {
  test(name, { timeout: 240000 }, async () => {
    const failures = [];
    const check = (ok, what) => {
      console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
      if (!ok) failures.push(what);
    };
    const lab = await openLab(options);
    try {
      await body({ ...lab, check });
      check(lab.errors.length === 0, `no page errors${lab.errors.length ? ": " + lab.errors.join(" | ") : ""}`);
    } finally {
      await lab.close();
    }
    assert.equal(failures.length, 0, `${failures.length} check(s) failed:\n${failures.join("\n")}`);
  });
}

// A legal sequence with inner and outer turns that leaves the puzzle out of shape. The
// checks that use it confirm all of it played (a refused turn would stop it short).
const MIXED = "F f R U r";
const moved = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 0.02);
const drag = (from, dx, dy) => [["pointerdown", from.x, from.y], ...[1, 2, 3, 4, 5, 6].map((i) => ["pointermove", from.x + (dx * i) / 6, from.y + (dy * i) / 6]), ["pointerup", from.x + dx, from.y + dy]];
const fmt = (v) => v.map((x) => x.toFixed(2)).join(" ");

function helpers(page) {
  const probe = (fn, ...args) => page.evaluate(([f, a]) => window.xcubeProbe[f](...a), [fn, args]);
  const settle = async () => {
    await page.waitForFunction(() => window.xcubeProbe.idle(), null, { timeout: 30000 });
    await page.waitForTimeout(100);
  };
  // Clicking a button scrolls the page to it, so bring the 3D view back before aiming at it.
  const startFresh = async () => {
    await resetToSolved(page);
    await page.evaluate(() => document.querySelector('[data-view="home"]').click());
    await page.locator("#scene").scrollIntoViewIfNeeded();
    await settle();
  };
  // The status chips in words: "Solved", "X shape" or "Out of shape", and the outer turns that can turn.
  const status = () =>
    page.$eval("#status", (s) => {
      const shape = s.dataset.solved === "true" ? "Solved X shape" : s.dataset.shape === "out" ? "Out of shape" : "X shape";
      const outer = [...s.querySelectorAll("[data-outer]")].filter((c) => c.classList.contains("on")).map((c) => c.dataset.outer).join("");
      return `${shape}; outer ${outer}`;
    });
  const counter = () => page.$eval("#counter", (c) => c.textContent.replace(/\s/g, ""));
  const hold = () => page.$eval("#hold", (e) => e.textContent);
  const turnList = () => page.$$eval("#history .tok", (els) => els.map((e) => e.textContent).join(" "));
  const waitForCounter = (text, timeout = 60000) =>
    page.waitForFunction((t) => document.getElementById("counter")?.textContent?.replace(/\s/g, "") === t, text, { timeout });
  // Types turns into the field, loads them and plays them to the end.
  const play = async (alg) => {
    await page.fill("#alg", alg);
    await page.click("#load");
    await page.click("#last");
    await settle();
  };

  // Every sticker visible in the 3D view is drawn where the model puts it, in its color:
  // sample a grid of points; for each one that lands on a sticker, the ID pass names its
  // piece, whose mesh gives the slot and facing it is drawn at. The model must have
  // that piece in that slot, and the flat-color pass must match the model's color. And
  // the other way round: every sticker the model turns toward the camera must be drawn.
  const sweep3d = () =>
    page.evaluate(() => {
      const P = window.xcubeProbe;
      const hits = P.scan3d(6);
      const wrong = hits
        .filter((h) => h.slot === "?" || h.piece !== h.modelPiece || h.color !== P.model(h.slot, h.face))
        .map((h) => `${h.slot}/${h.face}: drawn piece ${h.piece} in ${h.color}, model has piece ${h.modelPiece} in ${h.slot === "?" ? "?" : P.model(h.slot, h.face)}`);
      return { stickers: new Set(hits.map((h) => h.slot + "/" + h.face)).size, wrong: [...wrong, ...P.missing3d().map((m) => "missing " + m)] };
    });
  // The flat view: each face shows exactly the cells of that face, each in the model's color.
  const sweepFlat = () =>
    page.evaluate(() => {
      const P = window.xcubeProbe;
      const counts = {};
      const wrong = [];
      for (const face of ["U", "D", "F", "B", "R", "L"]) {
        counts[face] = 0;
        P.flatFace(face).forEach((cells, row) =>
          cells.forEach((h, col) => {
            if (!h || h.plastic) return;
            counts[face]++;
            const want = h.slot === "?" ? "?" : P.model(h.slot, h.face) ?? "unstickered";
            if (h.face !== face || h.piece !== h.modelPiece || h.color !== want) wrong.push(`${face}[${row},${col}] = piece ${h.piece} at ${h.slot}/${h.face} in ${h.color}; model has piece ${h.modelPiece} in ${want}`);
          }),
        );
      }
      return { counts, wrong };
    });

  // The pointer events are sent from inside the page, so a gesture keeps its pace however
  // slowly the browser draws: without a GPU a frame can take most of a second, and
  // Playwright's mouse waits for a frame after each event, which would make every swipe a
  // hold. A step is [type, x, y] or a pause in milliseconds.
  const gesture = async (steps) => {
    await page.evaluate(async (steps) => {
      const c = document.getElementById("scene");
      for (const st of steps) {
        if (typeof st === "number") {
          await new Promise((r) => setTimeout(r, st));
          continue;
        }
        const [type, x, y] = st;
        c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true }));
      }
    }, steps);
    await settle();
  };
  const swipe = (from, dx, dy) => gesture(drag(from, dx, dy));
  // Sets an effect switch the way a tap would.
  const flip = (id, on) =>
    page.evaluate(([id, on]) => {
      const el = document.getElementById(id);
      el.checked = on;
      el.dispatchEvent(new Event("change"));
    }, [id, on]);

  return { probe, settle, startFresh, status, counter, hold, turnList, waitForCounter, play, sweep3d, sweepFlat, gesture, swipe, flip };
}

// ---- Startup and layout.

labTest(
  "startup: three.js loads, the 3D view draws the cube, and the page fits 390 px",
  async ({ page, check }) => {
    check(true, `three.js r${await page.evaluate(() => window.THREE.REVISION)} loaded`);
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      return gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : "no WebGL 2";
    });
    check(true, `${engine} draws WebGL with: ${renderer}`);
    const expected = engine === "chromium" ? process.env.EXPECT_RENDERER : undefined;
    if (expected) check(renderer.includes(expected), `Chromium draws with ${expected}`);

    // The 3D view really draws: sample the canvas right after a frame renders (the
    // drawing buffer is not preserved, so it must be read in the same frame). At rest no
    // frame is drawn, so one is asked for (any probe call asks), and the Lab's own frame
    // callback, asked for first, runs before this one.
    const drawn = await page.evaluate(
      () =>
        new Promise((done) =>
          window.xcubeProbe.state() &&
          requestAnimationFrame(() => {
            const src = document.querySelector("canvas");
            const c = document.createElement("canvas");
            c.width = c.height = 64;
            const g = c.getContext("2d");
            g.drawImage(src, 0, 0, 64, 64);
            const d = g.getImageData(0, 0, 64, 64).data;
            const colors = new Set();
            for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) colors.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
            done(colors.size);
          }),
        ),
    );
    check(drawn >= 20, `3D view draws the cube (${drawn} distinct colors sampled)`);

    const [scrollW, clientW] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    check(scrollW <= clientW, `no sideways scrolling at 390 px (page ${scrollW} px wide)`);
  },
  { expand: false },
);

labTest(
  "layout: panels and messages open over the page without moving it",
  async ({ page, check }) => {
    // The ⓘ and Display buttons open panels over the view, and messages float over the page:
    // none of them changes the layout. A tap elsewhere closes a panel; a tap dismisses a message.
    const pageHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
    const isShown = (id) => page.$eval(`#${id}`, (e) => !e.hidden && getComputedStyle(e).display !== "none");
    const h0 = await pageHeight();
    await page.click("#render-btn");
    // Where an edge label lies under the Display panel, the panel is what shows.
    const covered = await page.evaluate(() => {
      const pop = document.getElementById("render-pop").getBoundingClientRect();
      return [...document.querySelectorAll(".cmp")].flatMap((c) => {
        const r = c.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < pop.left || x > pop.right || y < pop.top || y > pop.bottom || getComputedStyle(c).opacity === "0") return [];
        return [document.elementFromPoint(x, y)?.closest("#render-pop") ? "pop" : c.textContent];
      });
    });
    check(covered.every((c) => c === "pop"), `the Display panel draws over the edge labels (${covered.join() || "none under it"})`);
    const renderOpen = { shown: await isShown("render-pop"), boxes: await page.$$eval("#render-pop input[type=checkbox]", (els) => els.length), height: await pageHeight() };
    await page.click("#info-btn");
    const infoOpen = { shown: await isShown("info-pop"), renderClosed: !(await isShown("render-pop")), height: await pageHeight() };
    await page.mouse.click(5, 600); // a tap elsewhere closes the open panel
    await page.click(`[data-tab="flat"]`);
    await page.waitForTimeout(800);
    await page.click("#flat-info-btn");
    const flatOpen = { shown: await isShown("flat-info-pop"), infoClosed: !(await isShown("info-pop")), height: await pageHeight(), text: await page.$eval("#flat-info-pop", (e) => e.textContent) };
    await page.mouse.click(5, h0 - 5 > 600 ? 600 : 300);
    const allClosed = !(await isShown("info-pop")) && !(await isShown("render-pop")) && !(await isShown("flat-info-pop"));
    const flatLegendInFlow = await page.$$eval("[data-sec=flat] .legend", (els) => els.length);
    check(
      renderOpen.shown && renderOpen.boxes === 4 && infoOpen.shown && infoOpen.renderClosed && flatOpen.shown && flatOpen.infoClosed && /no sticker/.test(flatOpen.text) && flatLegendInFlow === 0 && allClosed && renderOpen.height === h0 && infoOpen.height === h0 && flatOpen.height === h0,
      `the Display panel and both ⓘ panels (3D and flat view) open over the views without moving the page (height ${h0} px), one at a time, and close on a tap elsewhere`,
    );
    // A message that shows at once (copying waits on the clipboard, which may never answer here).
    await page.evaluate(() => document.getElementById("shuffle").click());
    await page.waitForFunction(() => !document.getElementById("message").hidden, null, { timeout: 5000 }).catch(() => {});
    const floating = { shown: await isShown("message"), fixed: await page.$eval("#message", (e) => getComputedStyle(e).position), height: await pageHeight() };
    await page.click("#message");
    const msgGone = !(await isShown("message"));
    check(floating.shown && floating.fixed === "fixed" && floating.height === h0 && msgGone, `a message floats over the page (${floating.fixed}) without moving it, and a tap dismisses it`);
  },
  { expand: false },
);

labTest(
  "layout: the playback strip, the panels' order, notes and buttons",
  async ({ page, check }) => {
    // The strip under the 3D view holds the turn list, the playback buttons and the speed,
    // outside the panels. The tabs name the panels in their order.
    const strip = await page.evaluate(() => {
      const dock = document.getElementById("dock");
      const els = ["#history", ".transport", "#speed"].map((q) => dock.querySelector(q));
      const inOrder = els.every(Boolean) && els.every((el, i) => i === 0 || els[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      return inOrder && !document.getElementById("stack-col").contains(dock);
    });
    check(strip, "the strip holds the turn list, the playback buttons and the speed, outside the panels");
    const tabs = await page.$$eval("#tabs [data-tab]", (els) => els.map((t) => `${t.textContent}>${document.getElementById(t.getAttribute("aria-controls"))?.dataset.sec}`).join());
    const panels = await page.$$eval("#stack-col > .panel", (els) => els.map((e) => e.dataset.sec).join());
    check(tabs === "Start>start,Turn>turn,Algorithms>algs,Solve>solve,Flat>flat" && panels === "start,turn,algs,solve,flat", `the tabs name the panels in order (${tabs}; ${panels})`);
    // The Start panel: the ways to set the start, then saved positions and the state code. The
    // Solve panel: the order and Start solving, then the step's buttons and its text.
    const inOrder = (secId, qs) =>
      page.evaluate(([id, list]) => {
        const sec = document.getElementById(id);
        const els = list.map((q) => sec.querySelector(q));
        return els.every(Boolean) && els.every((el, i) => i === 0 || els[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, [secId, qs]);
    check(await inOrder("panel-start", ["#shuffle", "#reset", "#edit-start", "#clear", "#saved-list", "details.code-box"]), "the Start panel has Shuffle, Solved, Edit puzzle and Start from here, then saved positions and the state code");
    check(await inOrder("guide", [".guide-modes", "#next-step", "#guide-line"]), "the Solve panel has the order, Start solving, then the step's text");
    check(await page.$eval("#next-step", (b) => b.disabled), "with the puzzle solved, Start solving is grayed out");
    await page.fill("#alg", "R U");
    await page.click("#load");
    await page.click("#fwd");
    await page.click("#fwd");
    await page.click("#clear");
    await page.click("#next-step");
    await page.waitForFunction(() => window.xcubeProbe.idle(), null, { timeout: 30000 });
    const btnRows = await page.$$eval(".guide-btns .btn", (els) => new Set(els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => Math.round(e.getBoundingClientRect().top))).size);
    check(btnRows === 1, "while solving, the four step buttons share one row at phone width");
    // iOS zooms into a focused text field whose text is under 16px.
    const small = await page.$$eval('input[type="text"]', (els) => els.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id));
    check(small.length === 0, `every text field's text is at least 16px, so iOS doesn't zoom in (${small.join() || "none smaller"})`);
    // The turn list is one row that scrolls sideways, keeping the current turn in sight.
    await page.fill("#alg", "(R U R' U')6");
    await page.click("#load");
    await page.click("#fwd");
    for (let i = 0; i < 20; i++) await page.click("#fwd");
    await page.waitForFunction(() => window.xcubeProbe.idle(), null, { timeout: 30000 });
    const row = await page.evaluate(() => {
      const h = document.getElementById("history"), cur = h.querySelector(".tok.cur");
      const hr = h.getBoundingClientRect(), cr = cur.getBoundingClientRect();
      return { oneRow: h.scrollHeight <= h.clientHeight + 1 && hr.height < 44, scrolls: h.scrollWidth > h.clientWidth, curShown: cr.left >= hr.left - 1 && cr.right <= hr.right + 1 };
    });
    check(row.oneRow && row.scrolls && row.curShown, `the turn list is one row, scrolled to keep the current turn in sight (${JSON.stringify(row)})`);
    check((await page.$eval("[data-sec=turn] h2", (h) => h.textContent)) === "Turn the puzzle", 'the turn buttons\' panel is "Turn the puzzle"');
    // The slice and rotate notes sit to the right of their buttons, on the same row, no taller than it.
    const notes = await page.evaluate(() =>
      ["slice-note", "rotate-note"].map((id) => {
        const note = document.getElementById(id).getBoundingClientRect();
        const keys = [...document.getElementById(id).parentElement.querySelectorAll(".mv")].map((b) => b.getBoundingClientRect());
        const last = keys.at(-1);
        return note.left >= last.right && note.top >= last.top - 1 && note.bottom <= last.bottom + 1;
      }),
    );
    const unitsWhole = await page.$$eval(".pad-note > span", (els) => els.length === 6 && els.every((e) => e.getClientRects().length === 1));
    const infoLook = await page.$$eval(".tool-btn.info", (els) =>
      els.map((e) => { const cs = getComputedStyle(e); return [cs.borderTopColor, cs.backgroundColor].join("/"); }),
    );
    check(infoLook.length === 4 && infoLook.every((v) => v === "rgba(0, 0, 0, 0)/rgba(0, 0, 0, 0)"), "the ⓘ, Display and Undo buttons show just their icons, with no button edge or fill");
    check(unitsWhole, "the notes break lines only between units like \"M like L,\", never inside one");
    check(notes.every(Boolean) && (await page.$$eval("[data-sec=turn] .legend", (els) => els.length)) === 0, `the H/M/S and x/y/z notes sit beside their buttons (${notes})`);
    // The turn field's example text fits inside it at phone width.
    const hintFit = await page.evaluate(() => {
      const el = document.getElementById("alg");
      const cs = getComputedStyle(el);
      const g = document.createElement("canvas").getContext("2d");
      g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return [Math.ceil(g.measureText(el.placeholder).width), Math.floor(room)];
    });
    check(hintFit[0] <= hintFit[1], `the turn field's example fits (${hintFit[0]} of ${hintFit[1]} px)`);
  },
  { expand: false },
);

labTest(
  "layout: on a phone the page doesn't scroll; tabs, swipes and a slide along the tabs pick the panel; the 3D view stays put",
  async ({ page, check }) => {
    const fits = await page.evaluate(() => [document.documentElement.scrollHeight, innerHeight]);
    check(fits[0] <= fits[1], `the page is one screen tall (${fits[0]} of ${fits[1]} px)`);
    const scene0 = await page.$eval("#scene", (e) => JSON.stringify(e.getBoundingClientRect()));
    const state = () =>
      page.evaluate(() => {
        const stack = document.getElementById("stack-col").getBoundingClientRect();
        const sel = document.querySelector('#tabs [aria-selected="true"]')?.dataset.tab;
        const inView = [...document.querySelectorAll("#stack-col > .panel")].filter((p) => Math.abs(p.getBoundingClientRect().left - stack.left) < 3).map((p) => p.dataset.sec);
        return { sel, inView: inView.join() };
      });
    // Waits until the panel in view stops moving (a smooth scroll can take a while here).
    const landed = (tab) =>
      page
        .waitForFunction(
          (t) => {
            const stack = document.getElementById("stack-col");
            const p = document.querySelector(`#stack-col > [data-sec="${t}"]`);
            return Math.abs(p.getBoundingClientRect().left - stack.getBoundingClientRect().left) < 3 && document.querySelector('#tabs [aria-selected="true"]')?.dataset.tab === t;
          },
          tab,
          { timeout: 5000 },
        )
        .catch(() => {});
    const seen = [];
    for (const tab of ["turn", "algs", "solve", "flat", "start"]) {
      await page.click(`[data-tab="${tab}"]`);
      await landed(tab);
      const st = await state();
      seen.push(st.sel === tab && st.inView === tab);
    }
    const scene1 = await page.$eval("#scene", (e) => JSON.stringify(e.getBoundingClientRect()));
    check(seen.every(Boolean) && scene0 === scene1, `each tab brings its panel into view, and the 3D view stays put (${seen})`);
    // A swipe across the panels selects the tab of the panel it lands on.
    await page.evaluate(() => {
      const stack = document.getElementById("stack-col");
      stack.scrollLeft = document.getElementById("panel-flat").getBoundingClientRect().left - stack.getBoundingClientRect().left + stack.scrollLeft;
    });
    await landed("flat");
    const swiped = await state();
    check(swiped.sel === "flat" && swiped.inView === "flat", `scrolling the panels selects the tab of the one in view (${JSON.stringify(swiped)})`);
    // Sliding a finger along the tab row selects each tab it passes.
    const at = (tab) => page.$eval(`[data-tab="${tab}"]`, (b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const a = await at("start"), b = await at("algs");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 6, a.y);
    await page.mouse.up();
    await landed("algs");
    const slid = await state();
    check(slid.sel === "algs" && slid.inView === "algs", `a slide along the tabs selects the tab it ends on (${JSON.stringify(slid)})`);
    // The panel shown is kept on the device.
    await page.reload();
    await page.waitForFunction(() => window.xcubeProbe?.idle(), null, { timeout: 60000 });
    await landed("algs");
    const reloaded = await state();
    check(reloaded.sel === "algs" && reloaded.inView === "algs", `the panel shown is kept after a reload (${JSON.stringify(reloaded)})`);
  },
  { expand: false },
);

labTest(
  "layout: on an iPhone-sized screen the tab follows a swipe as it moves, every turn button shows, and the flat view shows whole",
  async ({ page, check }) => {
    // An iPhone in the Claude app: 844 px tall, less the app's bar and the home indicator.
    await page.addStyleTag({ content: ":root { padding-top: 100px !important; padding-bottom: 34px !important; }" });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(300);
    const views = await page.$$eval(".views .btn", (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent).join());
    check(views === "Home", `of the view buttons only Home shows; the edge labels give the rest (${views})`);
    // Over the 3D view: the edge labels, and small buttons in its corners (ⓘ, Display, and Undo
    // once there is a turn to undo); the edge labels keep clear of the buttons.
    const corners = await page.$$eval(".stage > .corner", (els) => els.map((e) => `${e.id}:${e.hidden ? "hidden" : "shown"}`).join());
    check(corners === "info-btn:shown,render-btn:shown,undo:hidden", `the ⓘ and Display buttons sit in the 3D view's corners, and Undo shows only with a turn to undo (${corners})`);
    // Part-way through a swipe to the next panel, its tab is already the marked one.
    const mid = await page.evaluate(async () => {
      const stack = document.getElementById("stack-col");
      stack.style.scrollSnapType = "none";
      const to = document.getElementById("panel-turn").getBoundingClientRect().left - stack.getBoundingClientRect().left + stack.scrollLeft;
      stack.dispatchEvent(new Event("touchstart"));
      stack.scrollLeft = to * 0.6;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = { sel: document.querySelector('#tabs [aria-selected="true"]').dataset.tab, at: Math.round((stack.scrollLeft / to) * 100) };
      stack.style.scrollSnapType = "";
      return out;
    });
    check(mid.sel === "turn" && mid.at > 50 && mid.at < 70, `60% of the way to the next panel its tab is marked (${JSON.stringify(mid)})`);
    await page.click(`[data-tab="turn"]`);
    await page.waitForTimeout(800);
    const turn = await page.evaluate(() => {
      const box = document.getElementById("stack-col").getBoundingClientRect();
      const keys = [...document.querySelectorAll("#panel-turn .mv, [data-mod]")].map((b) => b.getBoundingClientRect());
      return { n: keys.length, shown: keys.every((r) => r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left - 1 && r.right <= box.right + 1) };
    });
    check(turn.n === 21 && turn.shown, `the turn amount and all ${turn.n - 3} turn buttons show without scrolling`);
    await page.click(`[data-tab="flat"]`);
    await page.waitForTimeout(800);
    const flat = await page.evaluate(() => {
      const panel = document.getElementById("panel-flat"), pr = panel.getBoundingClientRect();
      const faces = [...document.querySelectorAll("#net .netface")].map((f) => f.getBoundingClientRect());
      const info = document.getElementById("flat-info-btn").getBoundingClientRect(), wrap = document.querySelector(".net-wrap").getBoundingClientRect();
      return {
        whole: panel.scrollHeight <= panel.clientHeight + 1 && faces.every((r) => r.top >= pr.top && r.bottom <= pr.bottom),
        infoInside: info.top >= wrap.top && info.bottom <= wrap.bottom && info.right <= wrap.right,
        clear: faces.every((r) => r.right <= info.left || r.top >= info.bottom || r.bottom <= info.top),
      };
    });
    check(flat.whole && flat.infoInside && flat.clear, `the flat view shows whole, with its ⓘ inside it and clear of the faces (${JSON.stringify(flat)})`);
  },
  { expand: false, context: { viewport: { width: 390, height: 844 } } },
);

labTest(
  "layout: on a phone the safe areas are kept clear once, and the page still fits one screen",
  async ({ page, check }) => {
    // Stand-ins for an iPhone's safe-area insets, as the artifact host's skeleton pads the
    // root by them (in the Claude app the top one also covers the app's own bar).
    await page.addStyleTag({ content: ":root { padding-top: 100px !important; padding-bottom: 34px !important; }" });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const stage = document.querySelector(".stage").getBoundingClientRect();
      const stack = document.getElementById("stack-col").getBoundingClientRect();
      return { stageTop: Math.round(stage.top), stackBottom: Math.round(stack.bottom), h: innerHeight, scroll: document.documentElement.scrollHeight };
    });
    check(m.stageTop >= 100 && m.stageTop <= 112, `the 3D view starts just below the top inset, not two insets down (${m.stageTop} px)`);
    check(m.stackBottom <= m.h - 34 && m.scroll <= m.h, `the panels end above the bottom inset and the page is one screen tall (${m.stackBottom} of ${m.h} px; page ${m.scroll} px)`);
  },
  { expand: false },
);

labTest(
  "layout: on a wide screen the panels stack beside the 3D view, with no tabs, and each collapses from its heading",
  async ({ page, check }) => {
    const wide = await page.evaluate(() => {
      const scene = document.getElementById("scene").getBoundingClientRect();
      const stack = document.getElementById("stack-col").getBoundingClientRect();
      const tabs = getComputedStyle(document.getElementById("tabs")).display;
      const panels = [...document.querySelectorAll("#stack-col > .panel")].map((p) => p.getBoundingClientRect());
      const stacked = panels.every((r, i) => i === 0 || r.top >= panels[i - 1].bottom - 1);
      return { beside: stack.left >= scene.right, tabs, stacked };
    });
    check(wide.beside && wide.tabs === "none" && wide.stacked, `the panels stack in a column right of the 3D view, and the tabs are hidden (${JSON.stringify(wide)})`);
    const sections = await page.$$eval("[data-sec]", (els) => els.map((e) => e.getAttribute("data-sec")));
    for (const s of sections) await page.click(`[data-sec=${s}] h2`);
    const collapsed = await page.$$eval("[data-sec].collapsed", (els) => els.length);
    check(collapsed === sections.length && sections.length > 0, `all ${sections.length} sections collapse`);
  },
  { expand: false, context: { viewport: { width: 1200, height: 900 } } },
);

// ---- Turns and undo.

labTest("turns: an algorithm plays and is listed; a blocked outer turn is refused; the edge 3-cycle keeps the X shape", async ({ page, check, status }) => {
  check((await status()).includes("Solved"), "starts solved and in X shape");

  // Run an algorithm and wait for it to finish playing.
  await page.fill("#alg", "R U");
  await page.click("#load");
  await page.click("#last"); // play
  await page.waitForFunction(() => document.getElementById("counter")?.textContent?.replace(/\s/g, "") === "2/2", null, { timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("last")?.textContent === "▶", null, { timeout: 30000 });
  const tokens = await page.$$eval("#history .tok", (els) => els.map((e) => e.textContent).join(" "));
  check(tokens === "R U", `turn list shows "R U" (got "${tokens}")`);
  check((await status()).includes("Out of shape"), "R U leaves the puzzle out of shape");
  const cur = await page.$eval("#history .tok.cur", (e) => {
    const c = getComputedStyle(e), h = document.getElementById("history").getBoundingClientRect(), r = e.getBoundingClientRect();
    return { outline: c.outlineStyle, shadow: c.boxShadow, inside: r.left >= h.left && r.right <= h.right && r.top >= h.top };
  });
  check(cur.outline === "none" && cur.shadow.includes("inset") && cur.inside, `current turn is marked inside its chip, so the list can't clip it (outline ${cur.outline}, shadow "${cur.shadow}")`);

  // A blocked outer turn is refused with a reason.
  await resetToSolved(page);
  await page.fill("#alg", "R f");
  await page.click("#load");
  const msg = await page.$eval("#message", (m) => m.textContent ?? "");
  check(/f\)?: extension has 6\/9 pieces/.test(msg), `outer turn after R is refused (message: "${msg}")`);

  // Baum's edge 3-cycle (white-up grip) returns to the X shape.
  await resetToSolved(page);
  await page.fill("#alg", "R' S' R b R' S R b'");
  await page.click("#load");
  await page.click("#last");
  await page.waitForFunction(() => document.getElementById("last")?.textContent === "▶", null, { timeout: 60000 });
  check((await status()).includes("X shape"), "edge 3-cycle keeps the X shape");
});

labTest("undo: takes back the last turn, and a turn pressed while an undo waits also takes effect", async ({ page, check, status, waitForCounter }) => {
  check(await page.$eval("#undo", (b) => b.hidden), "with no turn to undo, there is no Undo button");
  await page.evaluate(() => document.querySelector('[data-move="R"]').click());
  await waitForCounter("1/1", 30000);
  check(!(await page.$eval("#undo", (b) => b.hidden)), "after a turn, Undo shows in the 3D view's corner");
  await page.click("#undo");
  await waitForCounter("0/0", 30000);
  await page.waitForTimeout(1000);
  check((await status()).includes("Solved"), "undo takes back the last turn");

  // A turn pressed while an undo is still waiting to animate: both take effect.
  await page.evaluate(() => document.querySelector('[data-move="R"]').click());
  await waitForCounter("1/1", 30000);
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    document.getElementById("undo").click();
    document.querySelector('[data-move="F"]').click();
  });
  await page.waitForTimeout(1500);
  const afterRace = await page.$$eval("#history .tok", (els) => els.map((e) => e.textContent).join(" "));
  const raceStatus = await page.$$eval("#status [data-outer]", (els) => els.map((e) => e.title).join("; ")); // which outer turns are allowed
  check(afterRace === "F" && /l refuses: 6 of 9/.test(raceStatus) && /r refuses: 6 of 9/.test(raceStatus), `undo then an immediate F leaves just F (turns "${afterRace}"; ${raceStatus})`);
});

// ---- What is drawn where (window.xcubeProbe, see the end of src/web/main.ts).

labTest("drawing: the 3D view draws every sticker in place and in the model's color, and sticker positions point at their stickers", async ({ page, check, probe, settle, startFresh, sweep3d }) => {
  let sw = await sweep3d();
  check(sw.stickers >= 45 && sw.wrong.length === 0, `3D view, solved: ${sw.stickers} stickers each drawn in place and in the model's color${sw.wrong.length ? ": " + sw.wrong.slice(0, 4).join("; ") : ""}`);
  await page.fill("#alg", MIXED);
  await page.click("#load");
  await page.click("#last"); // play
  await settle();
  sw = await sweep3d();
  const mixedTurns = await probe("turns");
  check(mixedTurns === MIXED && sw.stickers >= 30 && sw.wrong.length === 0, `3D view after ${mixedTurns}: ${sw.stickers} stickers in place and in the model's color${sw.wrong.length ? ": " + sw.wrong.slice(0, 4).join("; ") : ""}`);

  // Aiming at a named sticker finds that sticker.
  await startFresh();
  const aimed = await page.evaluate(() => {
    const P = window.xcubeProbe;
    const out = [];
    for (const [slot, face] of [["Fx", "F"], ["UFR", "U"], ["Rx", "R"], ["Fx.UR", "U"], ["Rx.F", "F"]]) {
      const p = P.sticker(slot, face);
      const h = p && P.at3d(p.x, p.y);
      if (!h || h.slot !== slot || h.face !== face) out.push(`${slot}/${face} -> ${JSON.stringify(h)}`);
    }
    return out;
  });
  check(aimed.length === 0, `sticker positions point at their stickers${aimed.length ? ": " + aimed.join("; ") : ""}`);
});

labTest("drawing: the views are drawn only when something in them changes", async ({ page, check, probe, settle }) => {
  // At rest nothing is drawn; a turn draws until it settles, and the last frame shows it.
  await settle();
  const frames = async (ms) => {
    const a = await probe("drawCount");
    await page.waitForTimeout(ms);
    const b = await probe("drawCount");
    return { view: b.view - a.view, flat: b.flat - a.flat };
  };
  const rest = await frames(600);
  check(rest.view === 0 && rest.flat === 0, `at rest nothing is drawn (${JSON.stringify(rest)} frames in 0.6 s)`);
  await page.click(`[data-tab="turn"]`);
  await page.waitForTimeout(500);
  const before = (await probe("drawCount")).view;
  await page.click(`.mv[data-move="R"]`);
  await settle();
  const turned = (await probe("drawCount")).view - before;
  check(turned > 0, `a turn is drawn (${turned} frames)`);
  const after = await frames(600);
  check(after.view === 0, `once it has settled, nothing more is drawn (${after.view} frames in 0.6 s)`);
  // What was last drawn is what a fresh frame draws: nothing was left out of date.
  const shot = async () => (await page.locator("#scene").screenshot()).toString("base64");
  const last = await shot();
  await probe("state"); // any probe call asks for a frame
  await page.waitForTimeout(300);
  const fresh = await shot();
  // Compositing the labels over the view can differ by a level or two from one screenshot
  // to the next; a frame left out of date differs by far more.
  const differ = await page.evaluate(async ([a, b]) => {
    const pixels = async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, c.width, c.height).data;
    };
    const [p, q] = [await pixels(a), await pixels(b)];
    let n = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 30) n++;
    return n;
  }, [last, fresh]);
  check(differ === 0, `the last frame drawn after the turn is the same as a fresh one (${differ} pixels differ)`);
});

labTest("drawing: the flat view is drawn only while it is on screen", async ({ page, check, probe, settle }) => {
  // On a phone the Flat panel sits beside the others in the carousel, keeping its size, so
  // only whether it is in sight can tell it is hidden. A turn draws the views, so it is
  // made with the Start panel showing.
  await settle();
  await page.evaluate(() => document.querySelector(`.mv[data-move="U"]`).click());
  await page.waitForTimeout(150);
  const flatFrames = async () => {
    const a = (await probe("drawCount")).flat;
    await page.waitForTimeout(500);
    return (await probe("drawCount")).flat - a;
  };
  const hidden = await flatFrames();
  check(hidden === 0, `with the Start panel showing, the flat view isn't drawn (${hidden} frames in half a second)`);
  const before = (await probe("drawCount")).flat;
  await page.click(`[data-tab="flat"]`);
  await page.waitForTimeout(800);
  const shown = (await probe("drawCount")).flat - before;
  check(shown > 0, `once the Flat panel shows, it is drawn (${shown} frames)`);
  // Each of the six cameras draws only the squares and glow bands facing it. Drawing all
  // 372 squares (62 pieces, six faces each) for each camera took 2,232 calls by itself.
  // A piece's plastic has two segments across each rounded edge: 5 by 5 on each side.
  const tris = await probe("bodyTriangles");
  check(tris === 300, `a piece's plastic is 300 triangles (${tris})`);
  const { flatCalls } = await probe("drawCount");
  check(flatCalls > 0 && flatCalls < 1200, `each camera draws only what faces it (${flatCalls} draw calls a frame)`);
});

labTest("drawing: a misdrawn piece is caught in both views", async ({ page, check, sweep3d, sweepFlat }) => {
  // Draw two pieces in each other's places, and turn another a quarter turn, and both
  // views must report exactly those pieces.
  await page.evaluate(() => {
    window.xcubeProbe.faultSwap("Fx.UR", "Rx.UF");
    window.xcubeProbe.faultTwist("Fx.UL", "F");
  });
  const faulty3d = await sweep3d();
  const faultyFlat = await sweepFlat();
  await page.evaluate(() => window.xcubeProbe.resync());
  const faulted = ["Fx.UR", "Rx.UF", "Fx.UL"];
  const named = (list) => faulted.filter((slot) => list.some((w) => w.includes(slot)));
  const only = (list) => list.every((w) => faulted.some((slot) => w.includes(slot)));
  check(named(faulty3d.wrong).length === 3 && only(faulty3d.wrong), `a swapped pair and a twisted piece are caught in the 3D view, and nothing else (${named(faulty3d.wrong).join(", ") || "none"})`);
  check(named(faultyFlat.wrong).length === 3 && only(faultyFlat.wrong), `...and in the flat view (${named(faultyFlat.wrong).join(", ") || "none"})`);
  const healed = await sweep3d();
  check(healed.wrong.length === 0, "after redrawing from the model, the 3D view is clean again");
});

labTest("drawing: the flat view shows each face's cells in the model's colors, laid out as the face is seen", async ({ page, check, probe, settle, sweepFlat }) => {
  let fl = await sweepFlat();
  const shapeOk = ["U", "D"].every((f) => fl.counts[f] === 21) && ["F", "B", "R", "L"].every((f) => fl.counts[f] === 15);
  check(shapeOk && fl.wrong.length === 0, `flat view, solved: X-faces show 21 cells, side faces 15, each in the model's color (${JSON.stringify(fl.counts)})${fl.wrong.length ? ": " + fl.wrong.slice(0, 4).join("; ") : ""}`);
  // Rows run top to bottom as the face is seen.
  const layout = await page.evaluate(() => {
    const P = window.xcubeProbe;
    const at = (f, r, c) => {
      const h = P.flatFace(f)[r][c];
      return h && !h.plastic ? h.slot : String(h && "plastic");
    };
    return [at("F", 1, 1), at("F", 2, 4), at("U", 0, 1), at("U", 4, 2), at("R", 1, 4), at("D", 0, 2)].join(" ");
  });
  check(layout === "Fx.UL Rx.F Bx.UL Fx.U Bx.UR Fx.D", `flat view layout (F up-left, F right edge, U top row from the back, U bottom edge, R right edge, D top edge: ${layout})`);
  await page.fill("#alg", MIXED);
  await page.click("#load");
  await page.click("#last"); // play
  await settle();
  fl = await sweepFlat();
  check((await probe("turns")) === MIXED && fl.wrong.length === 0, `flat view after ${MIXED}: every cell in the model's color (${JSON.stringify(fl.counts)})${fl.wrong.length ? ": " + fl.wrong.slice(0, 4).join("; ") : ""}`);
});

// ---- Gestures on the 3D view, and the turn buttons.

labTest("gestures: swipes turn the layer under the finger, and a double tap undoes", async ({ check, probe, startFresh, gesture, swipe }) => {
  await swipe(await probe("sticker", "Fx.R", "F"), 0, -70);
  check((await probe("turns")) === "R", `swiping up on the front face's right column turns R (got "${await probe("turns")}")`);
  await swipe(await probe("sticker", "Rx.F", "F"), 0, -70);
  check((await probe("turns")) === "R r", `swiping up on the extension's column turns the outer layer r (got "${await probe("turns")}")`);
  await startFresh();
  await swipe(await probe("sticker", "Fx.UL", "F"), 70, 0);
  check((await probe("turns")) === "U'", `swiping right on the front face's top row turns U' (got "${await probe("turns")}")`);
  await swipe(await probe("sticker", "Fx", "F"), -70, 0);
  check((await probe("turns")) === "U' H", `swiping left on the front face's middle row turns the slice H (got "${await probe("turns")}")`);

  const tapAt = await probe("sticker", "Fx", "F");
  const tap = [["pointerdown", tapAt.x, tapAt.y], ["pointerup", tapAt.x, tapAt.y]];
  await gesture([...tap, ...tap]);
  check((await probe("turns")) === "U'", `double tap undoes the last turn (turns "${await probe("turns")}")`);
});

labTest("gestures: dragging the background, or holding on the cube and then dragging, tumbles the view", async ({ page, check, probe, gesture, swipe }) => {
  // A point on the 3D view with nothing drawn and no edge label over it.
  const empty = await page.evaluate(() => {
    const c = document.getElementById("scene");
    const r = c.getBoundingClientRect();
    for (let y = r.top + 20; y < r.bottom - 60; y += 10)
      for (let x = r.left + 20; x < r.left + r.width / 3; x += 10)
        if (!window.xcubeProbe.at3d(x, y) && document.elementFromPoint(x, y) === c) return { x, y };
    return null;
  });
  const before = await probe("view");
  await swipe(empty, 60, 30);
  const afterBg = await probe("view");
  check(moved(before, afterBg) && (await probe("turns")) === "", "dragging the background tumbles the view without turning");
  const holdAt = await probe("sticker", "Fx", "F");
  const [down, ...rest] = drag(holdAt, 60, 0);
  await gesture([down, 600, ...rest]);
  check(moved(afterBg, await probe("view")) && (await probe("turns")) === "", "holding on the cube, then dragging, tumbles the view without turning");
});

labTest("turn buttons: a tap turns, a long press turns the inverse", async ({ page, check, probe, settle }) => {
  const uButton = page.locator('[data-move="U"]');
  await uButton.scrollIntoViewIfNeeded();
  let ub = await uButton.boundingBox();
  await page.mouse.click(ub.x + ub.width / 2, ub.y + ub.height / 2);
  await settle();
  await uButton.scrollIntoViewIfNeeded();
  ub = await uButton.boundingBox(); // the page can reflow after a turn (the message line)
  await page.mouse.move(ub.x + ub.width / 2, ub.y + ub.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await settle();
  check((await probe("turns")) === "U U'", `tap on U turns U, a long press turns U' (turns "${await probe("turns")}")`);
});

labTest("edge labels: each arrow, in its center's color, points out along its face's axis; head-on, a dot or a cross", async ({ page, check, probe, settle }) => {
  await page.waitForTimeout(200);
  // From Home, every label's arrow points from the middle of the view toward the label (the
  // label sits where the face's axis meets the edge), in the color of that face's center.
  const arrows = await page.evaluate(() => {
    const r = document.getElementById("scene").getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return [...document.querySelectorAll(".cmp")].map((el) => {
      const b = el.getBoundingClientRect();
      const svg = el.querySelector("svg");
      const arrow = svg.children[0];
      const m = /rotate\(([-\d.]+)\)/.exec(arrow.getAttribute("transform") ?? "");
      return { face: el.textContent, color: getComputedStyle(svg).color, shown: arrow.style.display !== "none", stroke: getComputedStyle(arrow).stroke, angle: m ? Number(m[1]) : null, toward: (Math.atan2(b.top + b.height / 2 - cy, b.left + b.width / 2 - cx) * 180) / Math.PI };
    });
  });
  const off = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const bad = arrows.filter((a) => a.shown && off(a.angle, a.toward) > 25);
  check(arrows.filter((a) => a.shown).length >= 4 && !bad.length, `each arrow points from the middle toward its label (${JSON.stringify(arrows.map((a) => [a.face, a.angle, Math.round(a.toward)]))})`);
  // No dark outline: only the faint edge today's squares had (so white shows on the pale pill).
  const faint = (c) => { const m = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/.exec(c); return !!m && Number(m[4] ?? 1) <= 0.3; };
  check(arrows.every((a) => faint(a.stroke)), `the arrows have only a faint edge, no dark outline (${arrows.map((a) => a.stroke)})`);
  const u = arrows.find((a) => a.face === "U");
  check(u && /243, 243, 238|f3f3ee/i.test(u.color), `U's arrow is white, as the up center (${u?.color})`);
  // Straight down at the top: U points at you (a dot), D away (a cross).
  await page.evaluate(() => document.querySelector('[data-view="top"]').click());
  await settle();
  const marks = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".cmp")].map((el) => {
    const g = el.querySelector("svg").children;
    return [el.textContent, g[0].style.display !== "none" ? "arrow" : g[1].style.display !== "none" ? "toward" : "away"];
  })));
  check(marks.U === "toward" && marks.D === "away" && marks.F === "arrow", `from the top, U shows a dot, D a cross, F an arrow (${JSON.stringify(marks)})`);
});

labTest("edge labels: one per face, inside the 3D view; tapping one turns that face to you", async ({ page, check, probe, settle }) => {
  await page.waitForTimeout(200);
  const labels = await page.evaluate(() => {
    const r = document.getElementById("scene").getBoundingClientRect();
    return [...document.querySelectorAll(".cmp")].map((el) => {
      const b = el.getBoundingClientRect();
      return { text: el.textContent, height: Math.round(b.height * 10) / 10, shown: Number(getComputedStyle(el).opacity) > 0.05, inside: b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1 };
    });
  });
  const letters = labels.map((l) => l.text).sort().join("");
  check(letters === "BDFLRU" && labels.filter((l) => l.shown).every((l) => l.inside) && labels.filter((l) => l.shown).length >= 3, `edge labels: ${letters}, ${labels.filter((l) => l.shown).length} shown, all inside the view`);
  // Foreshortened: from Home, F, R and U point toward you and are drawn larger than B, L and D.
  const size = Object.fromEntries(labels.map((l) => [l.text, l.height]));
  check(["F", "R", "U"].every((n) => ["B", "L", "D"].every((m) => size[n] > size[m] * 1.1)), `labels toward you are larger than those away (${JSON.stringify(size)})`);
  await page.evaluate(() => document.querySelector('[data-view="front"]').click());
  await settle();
  const frontView = await probe("view");
  await page.evaluate(() => document.querySelector('[data-view="home"]').click());
  await page.locator("#scene").scrollIntoViewIfNeeded();
  await settle();
  await page.evaluate(() => document.getElementById("compass-4").click()); // the F label
  await settle();
  const labelView = await probe("view");
  const fx = await probe("sticker", "Fx", "F");
  const fxHit = await probe("at3d", fx.x, fx.y);
  check(!moved(frontView, labelView) && fxHit?.slot === "Fx", "tapping the F label turns to the Front view, front center in sight");
});

// ---- Shuffle, playback and the hold line.

labTest("shuffle: plays 30 legal turns, and the result becomes the new start", async ({ page, check, settle, startFresh }) => {
  await page.click("#shuffle");
  const during = await page.evaluate(() => ({ list: document.getElementById("history").textContent, toks: document.querySelectorAll("#history .tok").length, solve: document.getElementById("next-step").disabled }));
  check(during.solve, "while the shuffle plays, Start solving is grayed out (a step loaded then would cut the shuffle short)");
  check(during.list === "Shuffling…" && during.toks === 0, `while the shuffle plays, the turn list doesn't show its turns ("${during.list}")`);
  await page.waitForFunction(() => /^Shuffled/.test(document.getElementById("message")?.textContent ?? ""), null, { timeout: 60000 });
  await settle();
  const shuffled = await page.evaluate(() => ({ msg: document.getElementById("message").textContent, state: window.xcubeProbe.state(), turns: window.xcubeProbe.turns() }));
  check(shuffled.msg === "Shuffled.", `the message doesn't give the turns away ("${shuffled.msg}")`);
  const scramble = await page.evaluate(() => window.xcubeProbe.shuffleTurns());
  await startFresh();
  await page.fill("#alg", scramble);
  await page.click("#load");
  await page.click("#last");
  await page.waitForFunction(() => document.getElementById("last")?.textContent === "▶", null, { timeout: 60000 });
  await settle();
  const replay = await page.evaluate(() => ({ state: window.xcubeProbe.state(), count: window.xcubeProbe.turns().split(" ").length, msg: document.getElementById("message").textContent }));
  check(scramble.split(" ").length === 30 && shuffled.turns === "" && replay.count === 30 && replay.state === shuffled.state, `Shuffle plays 30 legal turns and starts from the result (replayed: ${replay.count} turns, same state: ${replay.state === shuffled.state})`);
});

labTest("playback: load, step forward and back, and jump to the start", async ({ page, check, probe, settle, status, counter }) => {
  await page.fill("#alg", "R U F");
  await page.click("#load");
  const loaded = { counter: await counter(), turns: await probe("turns") };
  await page.click("#fwd");
  await settle();
  const afterOne = await probe("state");
  await page.click("#fwd");
  await settle();
  await page.click("#back");
  await settle();
  const stepped = { counter: await counter(), turns: await probe("turns"), same: (await probe("state")) === afterOne };
  await page.click("#first");
  await settle();
  const atStart = { counter: await counter(), solved: (await status()).includes("Solved") };
  check(
    loaded.counter === "0/3" && loaded.turns === "" && stepped.counter === "1/3" && stepped.turns === "R" && stepped.same && atStart.counter === "0/3" && atStart.solved,
    `load, forward, back and back to the start (${loaded.counter} -> ${stepped.counter} "${stepped.turns}" -> ${atStart.counter})`,
  );
});

labTest("playback: play then stop plays no queued turn; the speed slider's range", async ({ page, check, probe, settle, counter }) => {
  await page.fill("#alg", "R U F");
  await page.click("#load");
  // Play, then stop at once (both from inside the page, so slow frames can't separate
  // them): no queued turn may play afterward. The slowest speed gives a broken stop
  // plenty of time to show.
  await page.$eval("#speed", (el) => {
    el.value = "0"; // about 1600 ms a turn
    el.dispatchEvent(new Event("input"));
  });
  const slowest = await probe("speed");
  await page.evaluate(() => {
    document.getElementById("last").click(); // play
    document.getElementById("last").click(); // the same button stops
  });
  await page.waitForTimeout(3000);
  await settle();
  const stoppedAt = await counter();
  check(stoppedAt === "0/3", `play, then stop, plays none of the queued turns (${stoppedAt})`);
  await page.$eval("#speed", (el) => {
    el.value = "52";
    el.dispatchEvent(new Event("input"));
  });
  const usual = await probe("speed");
  const sliderWidth = await page.$eval("#speed", (el) => el.getBoundingClientRect().width);
  check(Math.round(slowest) === 1600 && Math.round(usual) === 202 && sliderWidth >= 150, `the speed slider runs from 1600 ms a turn, default 202 ms, and is ${Math.round(sliderWidth)} px wide`);
});

labTest("playback: ◀ plays the turns backward to the start and keeps them listed", async ({ page, check, probe, settle, status, waitForCounter }) => {
  await page.fill("#alg", "R U F");
  await page.click("#load");
  await page.click("#last");
  await waitForCounter("3/3");
  await settle();
  const playedState = await probe("state");
  await page.click("#rewind");
  const rewindLabel = await page.$eval("#rewind", (b) => b.textContent);
  await waitForCounter("0/3");
  await settle();
  const rewound = { solved: (await status()).includes("Solved"), label: await page.$eval("#rewind", (b) => b.textContent), turns: await page.$$eval("#history .tok", (els) => els.length) };
  await page.click("#last");
  await waitForCounter("3/3");
  await settle();
  check(
    rewindLabel === "■" && rewound.solved && rewound.label === "◀" && rewound.turns === 3 && (await probe("state")) === playedState,
    `◀ plays back to the start (shows ■ while playing), keeps the 3 turns, and ▶ plays them again`,
  );
});

labTest("hold line: names the centers up, toward you and on your right, as they are now", async ({ check, hold, play }) => {
  // The H slice carries the side centers around.
  const holdSolved = await hold();
  await play("H");
  const holdAfterH = await hold();
  check(holdSolved === "Hold: white up, green front, red right" && holdAfterH === "Hold: white up, red front, blue right", `the hold line follows the centers ("${holdSolved}", then after H "${holdAfterH}")`);
});

// ---- Algorithms, the turn field, Clear and state codes.

labTest("algorithms: a known algorithm loads its position and turns, and playing them does what it says", async ({ page, check, settle, status, counter, hold, turnList, waitForCounter }) => {
  await page.click(`[data-tab="algs"]`);
  await page.click('[data-alg-load="flip-df-white-top"]');
  const baseLine = await page.$eval(".base-line", (e) => [e.scrollHeight, e.clientHeight, Math.round(e.getBoundingClientRect().height)]);
  check(baseLine[2] <= 24 && baseLine[0] <= baseLine[1] + 1, `a long start name stays on one line (${baseLine[2]} px tall)`);
  const known = { base: await page.$eval("#base-label", (e) => e.textContent), alg: await turnList(), field: await page.$eval("#alg", (e) => e.value), counter: await counter(), hold: await hold(), shape: await status() };
  await page.click("#last");
  await waitForCounter("7/7");
  await settle();
  // This one ends back in shape with the white top kept.
  const played = { shape: await status(), top: (await page.evaluate(() => window.xcubeProbe.flatFace("U").flat().filter((h) => h && h.color === "W").length)) };
  check(
    known.base === "Flipped bottom edge, white top solved" && known.alg === "R F H2 F2 H F R'" && known.field === "" && known.counter === "0/7" && known.hold === "Hold: white up, blue front, orange right" && /Out of shape/.test(known.shape) && /X shape/.test(played.shape) && played.top === 21,
    `a known algorithm loads its position and turns, and playing them works (start "${known.base}", ${known.hold}; then ${played.top} white on top)`,
  );
});

labTest("algorithms: one can be deleted, and the turn list saved as one and loaded back", async ({ page, check, startFresh, counter, turnList }) => {
  // Saved like saved states; on this device the list starts as the known algorithms.
  await page.click(`[data-tab="algs"]`);
  const algNames = () => page.$$eval("#known-list .saved-name", (els) => els.map((e) => e.textContent));
  const algsBefore = await algNames();
  await page.click('[data-alg-del="baum-corner"]');
  await page.click("[data-alg-del-yes]");
  const afterDelete = await algNames();
  await startFresh();
  await page.fill("#alg", "R U R' U'");
  await page.click("#load");
  const fieldAfterLoad = await page.$eval("#alg", (e) => e.value);
  await page.fill("#alg-name", "Sexy move");
  await page.click("#alg-save");
  const afterSave = await algNames();
  await resetToSolved(page);
  const mine = await page.evaluate(() => [...document.querySelectorAll("#known-list li")].find((li) => li.textContent.includes("Sexy move"))?.querySelector("[data-alg-load]")?.dataset.algLoad);
  await page.click(`[data-alg-load="${mine}"]`);
  const loadedMine = { base: await page.$eval("#base-label", (e) => e.textContent), alg: await turnList(), counter: await counter() };
  check(
    algsBefore.length === 9 && algsBefore.includes("Corner 3-cycle (Baum)") && !afterDelete.includes("Corner 3-cycle (Baum)") && afterDelete.length === 8 && fieldAfterLoad === "" && afterSave.at(-1) === "Sexy move" && loadedMine.base === "Sexy move" && loadedMine.alg === "R U R' U'" && loadedMine.counter === "0/4",
    `algorithms: delete one (${algsBefore.length} -> ${afterDelete.length}), save one ("${afterSave.at(-1)}"), and load it back ("${loadedMine.alg}", ${loadedMine.counter})`,
  );
});

labTest("turn field: Edit puts the turn list in the field, Update replaces it, Cancel keeps it", async ({ page, check, settle, counter, turnList }) => {
  // The position stays where the old and new lists agree.
  await page.fill("#alg", "R U F");
  await page.click("#load");
  await page.click("#fwd");
  await page.click("#fwd");
  await settle();
  const editIdle = await page.$eval("#alg-edit", (b) => [b.textContent, b.disabled]);
  await page.click("#alg-edit");
  const editing = { field: await page.$eval("#alg", (e) => e.value), load: await page.$eval("#load", (b) => b.textContent), edit: await page.$eval("#alg-edit", (b) => b.textContent) };
  await page.fill("#alg", "R U2 F");
  await page.click("#load");
  await settle();
  const updated = { list: await turnList(), counter: await counter(), field: await page.$eval("#alg", (e) => e.value), load: await page.$eval("#load", (b) => b.textContent) };
  const atR = await page.evaluate(() => window.xcubeProbe.turns());
  await page.click("#alg-edit");
  await page.fill("#alg", "L");
  await page.click("#alg-edit"); // Cancel
  const cancelled = { list: await turnList(), field: await page.$eval("#alg", (e) => e.value), load: await page.$eval("#load", (b) => b.textContent) };
  await page.click("#clear");
  const editEmpty = await page.$eval("#alg-edit", (b) => b.disabled);
  check(
    editIdle[0] === "Edit" && !editIdle[1] && editing.field === "R U F" && editing.load === "Update" && editing.edit === "Cancel" &&
      updated.list === "R U2 F" && updated.counter === "1/3" && atR === "R" && updated.field === "" && updated.load === "Load" &&
      cancelled.list === "R U2 F" && cancelled.field === "" && cancelled.load === "Load" && editEmpty,
    `Edit: the list goes in the field ("${editing.field}"), Update replaces it ("${updated.list}", at ${updated.counter} where the lists agree), Cancel keeps it, and Edit needs turns`,
  );
});

labTest("clear: empties the turn list, and the position shown becomes the start", async ({ page, check, probe, counter, play }) => {
  await play("R U");
  const ruState = await probe("state");
  await page.click("#clear");
  const cleared = { counter: await counter(), state: await probe("state"), msg: await page.$eval("#message", (m) => m.textContent) };
  check(cleared.counter === "0/0" && cleared.state === ruState && /^Turns cleared/.test(cleared.msg) && (await page.$eval("#clear", (b) => b.textContent)) === "Start from here", `Clear empties the turn list and keeps the position shown as the start (${cleared.counter})`);
});

labTest("state codes: one field shows the current position's code and takes a code to import as the start", async ({ page, check, probe, startFresh, counter, play, sweep3d }) => {
  await play("R U");
  const ruState = await probe("state");
  await page.locator("summary", { hasText: "State code" }).click(); // the codes sit in a closed disclosure
  const shown = await page.$eval("#code", (t) => t.value);
  check(shown === ruState, "the state code shown is the current position's");
  check(/^[A-Z]{4}( [A-Z]{4}){10}$/.test(shown) && (await page.$eval("#code-note", (n) => n.textContent === "")), `the code is 44 letters in groups of 4, with no note (${shown})`);
  const fit = await page.$eval("#code-readout", (r) => ({ text: r.textContent, fits: r.scrollWidth <= r.clientWidth + 1, px: parseFloat(getComputedStyle(r).fontSize), sw: r.scrollWidth, cw: r.clientWidth }));
  check(fit.text === shown && fit.fits && fit.px >= 8, `the code shows whole on one line at phone width (${fit.px.toFixed(1)}px, ${fit.sw} of ${fit.cw} px)`);
  await page.click("#copy-code");
  // Copying is asynchronous (the clipboard may ask for permission); wait for its message.
  const copyMsg = await page
    .waitForFunction(() => /State code copied|Select and copy the code/.test(document.getElementById("message").textContent), null, { timeout: 10000 })
    .then(() => page.$eval("#message", (m) => m.textContent))
    .catch(() => page.$eval("#message", (m) => m.textContent));
  check(/State code copied|Select and copy the code/.test(copyMsg), `Copy confirms, or asks to copy by hand where the clipboard is not allowed ("${copyMsg}")`);
  await startFresh();
  await page.fill("#code", "  " + ruState + "\n");
  await page.click("#import");
  const imported = { state: await probe("state"), msg: await page.$eval("#message", (m) => m.textContent), counter: await counter() };
  check(imported.state === ruState && imported.msg === "Imported." && imported.counter === "0/0", `importing a state code makes it the start (${imported.msg})`);
  await page.fill("#code", "X1:not a code");
  await page.keyboard.press("Enter");
  const refused = { state: await probe("state"), off: await page.$eval("#import", (b) => b.disabled), bad: await page.$eval("#code", (t) => t.classList.contains("invalid")) };
  check(refused.state === ruState && refused.off && refused.bad, "a malformed code is outlined, can't be loaded, and changes nothing");
  check((await page.$eval("#code", (t) => t.value)) === "X1:not a code", "a refused code stays in the field to be fixed");
  await page.click("#copy-code");
  check((await page.$eval("#code", (t) => t.value)) === ruState, "Copy puts this position's code back in the field");
  await startFresh();
  await page.fill("#code", ruState.toLowerCase().replace(/ /g, "-"));
  await page.click("#import");
  check((await probe("state")) === ruState, "a code typed in lower case with dashes imports the same position");
  const typo = (ruState[0] === "A" ? "B" : "A") + ruState.slice(1);
  await page.fill("#code", typo);
  const typoOff = await page.$eval("#import", (b) => b.disabled);
  check((await probe("state")) === ruState && typoOff, "a code with a typo can't be loaded and changes nothing");
  // A position turns can't reach (solved, with the right extension center turned a quarter
  // by hand) has no letter code: it keeps its X1 code, with a note saying why.
  const turnedCenter =
    "X1:AaBaCaDaEaFaGaHaIa......JaKaLaMaNaOaPaQaRaSaTaUaVaWaXa............YaZaaabacadaeafagahaiajakala............manaoapaqarasatauavawaxayaza0a......1a2a3a4a5b6a7a8a9a";
  await page.fill("#code", turnedCenter);
  await page.click("#import");
  const kept = { code: await page.$eval("#code", (t) => t.value), note: await page.$eval("#code-note", (n) => n.textContent + " (" + n.title + ")") };
  check(kept.code === turnedCenter && /extension center is turned/.test(kept.note), `a position turns can't reach keeps its X1 code, with a note ("${kept.note}")`);
  await page.fill("#code", ruState);
  await page.click("#import");
  const sw = await sweep3d();
  check(sw.wrong.length === 0, `the imported position is drawn as the model has it${sw.wrong.length ? ": " + sw.wrong.slice(0, 3).join("; ") : ""}`);
});

labTest("state codes: tapping in empties the field; bad text is marked and can't load; turning replaces typed text; ✕ clears", async ({ page, check, probe, play }) => {
  await page.locator("summary", { hasText: "State code" }).click();
  const current = await probe("state");
  const look = () =>
    page.evaluate(() => ({
      value: document.getElementById("code").value,
      invalid: document.getElementById("code").classList.contains("invalid"),
      loadOff: document.getElementById("import").disabled,
      showing: document.getElementById("code-field").classList.contains("showing"),
    }));
  const shown = await look();
  check(shown.value === current && shown.showing && shown.loadOff, `the field shows this position's code, and Load is off (${JSON.stringify(shown)})`);
  await page.click("#code");
  const tapped = await look();
  check(tapped.value === "" && !tapped.showing && tapped.loadOff, `tapping in empties the field for a code (${JSON.stringify(tapped)})`);
  await page.keyboard.type("ABCD");
  const bad = await look();
  check(bad.invalid && bad.loadOff, `text that isn't a code is outlined and Load is off (${JSON.stringify(bad)})`);
  await page.click("#code-clear");
  const cleared = await look();
  check(cleared.value === current && cleared.showing && !cleared.invalid, `the field's ✕ puts this position's code back (${JSON.stringify(cleared)})`);
  // Typed text, then a turn: the text is replaced by the new position's code, and the page says so.
  await page.fill("#code", "ABCD");
  await page.locator("#scene").scrollIntoViewIfNeeded();
  await play("R");
  const moved = { ...(await look()), state: await probe("state"), msg: await page.$eval("#message", (m) => m.textContent), flash: await page.$eval("#code-field", (f) => f.classList.contains("replaced")) };
  check(moved.value === moved.state && moved.value !== current && moved.flash && /replaced/.test(moved.msg), `turning replaces typed text with the new code, flashes the field and says so ("${moved.msg}")`);
  // The other text fields' ✕ empties them.
  await page.fill("#alg", "R U");
  const algX = await page.isVisible("#alg + .field-clear");
  await page.click("#alg + .field-clear");
  check(algX && (await page.$eval("#alg", (i) => i.value)) === "" && !(await page.isVisible("#alg + .field-clear")), "the turn field's ✕ shows with text and empties it");
});

// ---- The effect switches, edge glow and shading.

labTest("effects: Gloss, Edge glow, Shading and Shadows switch off and on, and the drawing stays right", async ({ page, check, probe, sweep3d, flip }) => {
  // The Gloss switch turns the sticker film off and on without errors.
  await flip("gloss", false);
  await flip("gloss", true);
  await page.waitForTimeout(500);
  check(await page.$eval("#gloss", (g) => g.checked), "gloss switches off and back on");

  const effects = () => probe("effects");
  const initial = await page.evaluate(() => ["glow", "shade", "shadows"].map((id) => document.getElementById(id).checked));
  for (const id of ["glow", "shade", "shadows"]) await flip(id, false);
  const off = await effects();
  const sw = await sweep3d();
  const offOk = !off.glow3d && !off.glowFlat && !off.shadows && !off.shading && sw.wrong.length === 0;
  for (const id of ["glow", "shade", "shadows"]) await flip(id, true);
  const on = await effects();
  for (const [i, id] of ["glow", "shade", "shadows"].entries()) await flip(id, initial[i]);
  check(offOk && on.glow3d && on.glowFlat && on.shadows && on.shading, `Edge glow, Shading and Shadows switch their effects off and on (off: ${JSON.stringify(off)})`);
});

labTest("edge glow: wraps around a piece's corner where two visible faces meet, and fades out elsewhere", async ({ check, probe }) => {
  // Solved, from the Home view, Rx.UB shows its U and R faces and hides its blue B sticker.
  // Along the rounded corner the glow is about as strong as along either edge (no gap, and
  // no brighter seam where pieces meet), and it does not reach the square corner the two
  // bands would make if they met in a sharp fold. Rx.B, below it, has no exposed face
  // beside the R-B edge's ends, so its glow fades out at the corner. The flat view sees
  // only one side of a corner, so there it fades out too.
  const glowAt = (slot, view, pts) => probe("glowAt", slot, view, pts);
  const { depth, round } = await probe("glowShape");
  const arc = [0, 22.5, 45, 67.5, 90].map((deg) => (deg * Math.PI) / 180);
  const wrap = [];
  for (const out of [0.55, 0.65]) {
    const [u, r, square, ...corner] = await glowAt("Rx.UB", "3d", [
      [["U", depth], ["B", out]],
      [["R", depth], ["B", out]],
      [["U", 0.5], ["R", 0.5], ["B", out]],
      ...arc.map((t) => [["U", depth - round + round * Math.cos(t)], ["R", depth - round + round * Math.sin(t)], ["B", out]]),
    ]);
    const ok = Math.min(...corner) >= 0.6 * Math.min(u, r) && Math.max(...corner) <= 1.25 * Math.max(u, r) && square < 0.35 * Math.min(u, r);
    wrap.push({ out, edges: [u, r], corner, square, ok });
  }
  check(wrap.every((w) => w.ok), `edge glow wraps around a piece's corner, rounded, without a gap or seam (${wrap.map((w) => `${w.out}: edges ${fmt(w.edges)}, around the corner ${fmt(w.corner)}, square corner ${w.square.toFixed(2)}`).join("; ")})`);
  const [closedMid, closedEnd] = await glowAt("Rx.B", "3d", [[["R", 0.47], ["B", 0.55]], [["R", 0.47], ["U", 0.45], ["B", 0.55]]]);
  const [flatMid, flatEnd] = await glowAt("Rx.UB", "U", [[["U", 0.47], ["B", 0.6]], [["U", 0.47], ["R", 0.45], ["B", 0.6]]]);
  check(closedEnd < 0.3 * closedMid && flatEnd < 0.3 * flatMid, `edge glow fades out at a corner with no glow around it (3D ${fmt([closedMid, closedEnd])}), and in the flat view (${fmt([flatMid, flatEnd])})`);
});

labTest("edge glow: follows the pieces while a layer turns, from where they are right now", async ({ page, check, probe, swipe, settle }) => {
  // Solved, the front extension's bottom middle piece (Fx.D) has Fx.DR against its right
  // face, so no glow lies in that face's plane, and the glow under its front face ends
  // there. Part-way through R that face is exposed: its plane carries the yellow glow, and
  // the front glow's end opens to go around the corner. Turned back, both are as before.
  const band = async () => ({ side: await probe("glowBand", "Fx.D", "R", "D"), front: await probe("glowBand", "Fx.D", "F", "D") });
  const fire = (steps) =>
    page.evaluate((steps) => {
      const c = document.getElementById("scene");
      for (const [type, x, y] of steps) c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true }));
    }, steps);
  const show = (b) => `side ${b.side.shown ? "shown" : "hidden"}, front ends ${b.front.open}`;
  const rest = await band();
  const at = await probe("sticker", "Fx.R", "F");
  const [down, ...moves] = drag(at, 0, -30).slice(0, -1);
  await fire([down, ...moves]);
  const turning = await band();
  await fire([...moves.reverse().slice(1), ["pointermove", at.x, at.y]]);
  const back = await band();
  await fire([["pointerup", at.x, at.y]]);
  await settle();
  check(!rest.side.shown && rest.front.open === 0 && turning.side.shown && turning.front.open !== 0 && !back.side.shown && back.front.open === 0, `a face uncovered by a turning layer glows during the turn, not only after it (at rest: ${show(rest)}; part-way through R: ${show(turning)}; turned back: ${show(back)})`);
  check((await probe("turns")) === "", `turning the layer back leaves no turn (got "${await probe("turns")}")`);

  await swipe(at, 0, -70);
  const after = await band();
  check((await probe("turns")) === "R" && after.side.shown && after.front.open !== 0, `after R the face stays exposed and glows (${show(after)})`);
  const restError = await probe("glowRestError");
  check(restError === 0, `the glow at the start of every turn matches the glow at rest (${restError} bands differ)`);
});

labTest("shading: the flat view's bands come from nearer neighbors, and live shading at a turn's start matches the rest shading", async ({ page, check, probe, startFresh, play, flip }) => {
  // Each nearer neighbor casts a band along the shared edge, at full darkness at the edge
  // and gone past the ramp. Checked in a scrambled position, which has recesses between
  // two walls: those show two bands with a clean middle, and no overlap (an inner corner)
  // is darker than one band.
  await play("R U' F2 D B' L2 R' H S' M");
  const prof = await probe("flatShadeProfile");
  check(prof.shaded > 0 && prof.channels > 0 && prof.edgeErr < 1e-6 && prof.middle > 1 - 1e-6 && prof.darkest >= prof.oneBand - 1e-6, `flat view shading is bands from nearer neighbors (${prof.shaded} shaded tiles, ${prof.channels} between two walls; edge error ${prof.edgeErr}; lightest-middle check ${prof.middle.toFixed(6)}; darkest ${prof.darkest.toFixed(3)}, one band ${prof.oneBand.toFixed(3)})`);
  // The squares are two triangles each, so the bands are drawn pixel by pixel by their
  // material. The flat view as drawn, with Shading on and then off: on, pixels near the
  // shaded edges are darker; nowhere is it lighter.
  await page.click(`[data-tab="flat"]`);
  await page.waitForTimeout(800);
  const shot = async () => (await page.locator("#net-canvas").screenshot()).toString("base64");
  const on = await shot();
  await flip("shade", false);
  await page.waitForTimeout(300);
  const off = await shot();
  await flip("shade", true);
  const drawn = await page.evaluate(async ([a, b]) => {
    const pixels = async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, c.width, c.height).data;
    };
    const [p, q] = [await pixels(a), await pixels(b)];
    let darker = 0, lighter = 0;
    for (let i = 0; i < p.length; i += 4) {
      const d = p[i] + p[i + 1] + p[i + 2] - (q[i] + q[i + 1] + q[i + 2]);
      if (d < -45) darker++;
      if (d > 45) lighter++;
    }
    return { darker, lighter };
  }, [on, off]);
  check(drawn.darker > 500 && drawn.lighter === 0, `the flat view draws the shading (${drawn.darker} pixels darker with Shading on, ${drawn.lighter} lighter)`);

  await startFresh();
  const restError = await probe("shadeRestError");
  check(restError < 1e-6, `live shading at the start of every turn matches the rest shading (largest difference ${restError})`);
});

// ---- Color editing.

labTest("color editing: painting stickers, the validity line, Done and Cancel", async ({ page, check, probe, settle, gesture, swipe, sweep3d, flip }) => {
  // Tap stickers to repaint them; the line says whether the colors are real pieces that
  // can face those ways, and Done makes the result the start.
  const editLine = () => page.$eval("#edit-status", (e) => e.textContent);
  const doneOff = () => page.$eval("#edit-done", (e) => e.disabled);
  const paint = async (color, slot, face) => {
    await page.click(`[data-paint="${color}"]`);
    await page.locator("#scene").scrollIntoViewIfNeeded();
    const at = await probe("sticker", slot, face);
    // The tap must land on that sticker (it can be hidden after the view turns).
    const there = await probe("at3d", at.x, at.y);
    if (there?.slot !== slot || there?.face !== face) throw new Error(`can't tap ${slot}/${face}: ${JSON.stringify(there)} is drawn there`);
    await gesture([["pointerdown", at.x, at.y], ["pointerup", at.x, at.y]]);
  };
  await page.click("#edit-start");
  const entered = { line: await editLine(), done: !(await doneOff()), inert: await page.$eval("#stack-col", (e) => e.inert) };
  check(/^Valid/.test(entered.line) && entered.done && entered.inert, `edit mode starts valid, with the other controls set aside ("${entered.line}")`);
  await paint("R", "Fx.U", "F");
  const half = { line: await editLine(), off: await doneOff(), drawn: (await probe("at3d", ...Object.values(await probe("sticker", "Fx.U", "F"))))?.color };
  check(/^Not valid: Two extension edges are white and red, but there can be only one like that\. On one of these, the red sticker should probably be green\. Show Hide$/.test(half.line) && half.off && half.drawn === "R", `painting one edge like another is not valid, Done is off, and the paint shows ("${half.line}")`);
  // The edge glow around a painted sticker shows the paint too (the glow is the only sign
  // of a sticker's color where that face is hidden).
  const paintedGlow = (await probe("glowColors", "Fx.U", "F")).join();
  check(paintedGlow === "R", `the edge glow of a painted sticker takes the paint (${paintedGlow})`);
  // A problem puts a purple halo on the pieces it names by itself, in the 3D view and
  // on the flat view's faces where they show, without moving the view. In the 3D view it
  // is an outline around a piece that can be seen; one behind the puzzle draws nothing
  // over what is in front of it, and an arrow points around to it instead, which a tap follows.
  // Show (or tapping the line) tumbles the 3D view to show all their stickers, again
  // after any tumble; Hide removes the halo.
  const front = { px3d: await probe("haloPixels", "3d"), arrow: await probe("haloArrow") };
  check(front.px3d > 0 && front.arrow.at === null && front.arrow.behind.length === 0, `pieces that can be seen have an outline and no arrow (${JSON.stringify(front)})`);
  const seenBoth = async () => `${await probe("facesSeen", "Fx.U")},${await probe("facesSeen", "Rx.U")}`;
  await page.evaluate(() => document.querySelector('[data-view="bottom"]').click());
  await settle();
  const lit = { slots: (await probe("highlighted")).sort().join(), seen: await seenBoth(), px3d: await probe("haloPixels", "3d"), flatU: await probe("haloPixels", "U"), flatD: await probe("haloPixels", "D"), buttons: await page.$$eval("#edit-status .edit-show", (els) => els.map((e) => e.textContent).join()) };
  check(lit.slots === "Fx.U,Rx.U" && lit.seen === "0,0" && lit.flatU > 0 && lit.flatD === 0 && lit.buttons === "Show,Hide", `a problem haloes the pieces it names by itself, without turning the view (${JSON.stringify(lit)})`);
  const behind = await probe("haloArrow");
  const box = await page.locator("#scene").boundingBox();
  const inView = behind.at && behind.at.x > box.x && behind.at.x < box.x + box.width && behind.at.y > box.y && behind.at.y < box.y + box.height;
  check(lit.px3d === 0 && behind.behind.join() === "Fx.U,Rx.U" && inView, `behind the puzzle they draw nothing over it, and the arrow shows, inside the view (${lit.px3d} pixels, ${JSON.stringify(behind)})`);
  // The arrow is in the scene, starting on the side facing the viewer: tap its middle.
  await page.waitForFunction(() => window.xcubeProbe.haloArrow().opacity === 1);
  const mid = (await probe("haloArrow")).mid;
  await page.mouse.click(mid.x, mid.y);
  await settle();
  await page.waitForFunction(() => window.xcubeProbe.haloArrow().opacity === 0);
  const found = { seen: await seenBoth(), arrow: await probe("haloArrow"), px3d: await probe("haloPixels", "3d") };
  check(found.seen === "2,2" && found.arrow.at === null && found.px3d > 0, `a tap on the arrow turns the view to them, and the arrow goes (${JSON.stringify(found)})`);
  await page.click("#edit-status");
  await settle();
  const shownAt = await seenBoth();
  await page.evaluate(() => document.querySelector('[data-view="bottom"]').click());
  await settle();
  await page.click('[data-halo="show"]');
  await settle();
  const back = await seenBoth();
  check(shownAt === "2,2" && back === "2,2", `tapping the line, or Show after a tumble, turns the view to show all their stickers (faces seen ${shownAt}, then ${back})`);
  await page.click('[data-halo="hide"]');
  const unlit = { slots: (await probe("highlighted")).length, px3d: await probe("haloPixels", "3d"), flatU: await probe("haloPixels", "U"), buttons: await page.$$eval("#edit-status .edit-show", (els) => els.map((e) => e.textContent).join()) };
  check(unlit.slots === 0 && unlit.px3d === 0 && unlit.flatU === 0 && unlit.buttons === "Show", `Hide removes the halo (${JSON.stringify(unlit)})`);
  await page.evaluate(() => document.querySelector('[data-view="home"]').click());
  await settle();
  await paint("G", "Rx.U", "R");
  const swapped = { line: await editLine(), off: await doneOff() };
  check(swapped.line === "Valid" && !swapped.off && (await probe("highlighted")).length === 0, `painting the other edge to match makes it valid again, with no halo ("${swapped.line}")`);
  // Hide lasts only until the problem changes: painting back to the hidden problem shows its halo.
  await paint("R", "Rx.U", "R");
  const relit = (await probe("highlighted")).sort().join();
  await paint("G", "Rx.U", "R");
  check(relit === "Fx.U,Rx.U", `a hidden halo comes back when its problem returns after another (${relit})`);
  // The effect switches stay usable while editing; Shading must redraw the edited position.
  await flip("shade", false);
  await flip("shade", true);
  await page.locator("#scene").scrollIntoViewIfNeeded();
  const shadeHit = await probe("at3d", ...Object.values(await probe("sticker", "Fx.U", "F")));
  const afterShade = `${shadeHit?.slot}/${shadeHit?.face} ${shadeHit?.color}`;
  check(afterShade === "Fx.U/F R", `turning Shading off and on while editing keeps the edited drawing (drawn: ${afterShade})`);
  const swipeAt = await probe("sticker", "Fx", "F");
  await swipe(swipeAt, 0, -70);
  check((await probe("turns")) === "", "a swipe while editing doesn't turn a layer");
  await page.evaluate(() => document.querySelector('[data-view="home"]').click()); // the swipe tumbled the view
  await settle();
  await page.click("#edit-done");
  const appliedGlow = [(await probe("glowColors", "Fx.U", "F")).join(), (await probe("glowColors", "Rx.U", "R")).join()].join(" ");
  check(appliedGlow === "R G", `after Done, the moved pieces' glow shows their own colors (${appliedGlow})`);
  const applied = { model: [await probe("model", "Fx.U", "F"), await probe("model", "Rx.U", "R")], label: await page.$eval("#base-label", (e) => e.textContent), inert: await page.$eval("#stack-col", (e) => e.inert) };
  let sw = await sweep3d();
  check(applied.model.join() === "R,G" && applied.label === "Edited" && !applied.inert && sw.wrong.length === 0, `Done makes the edited position the start, drawn as the model has it (${applied.model.join(" ")}, "${applied.label}")`);
  const editedState = await probe("state");
  await page.locator("#scene").scrollIntoViewIfNeeded();
  await page.click("#edit-start");
  await paint("R", "Fx.U", "U"); // flip the white-red edge now at Fx.U in place
  await paint("W", "Fx.U", "F");
  const flipped = await editLine();
  check(/^Not valid: This piece's white sticker has the wrong color\. Its white and red stickers should probably trade places\. Show Hide$/.test(flipped), `an outer edge flipped in place is real, but not possible ("${flipped}")`);
  // With several problems, ‹ and › step through them, and the halo moves with the line
  // without turning the view. Yellow facing away from the core on Rx.U and Fx.UR is wrong
  // too; the line stays on the problem it shows (Rx.U's) when Fx.UR's sorts ahead of it.
  await paint("Y", "Rx.U", "R");
  await page.click('[data-halo="next"]');
  await paint("Y", "Fx.UR", "F");
  const navLine = await editLine();
  const firstLit = (await probe("highlighted")).join();
  const viewBefore = JSON.stringify(await probe("view"));
  await page.click('[data-halo="next"]');
  const stepped = { line: await editLine(), lit: (await probe("highlighted")).join(), still: JSON.stringify(await probe("view")) === viewBefore };
  await page.click('[data-halo="next"]');
  await page.click('[data-halo="next"]');
  const wrapped = (await probe("highlighted")).join();
  const at = (line) => line.match(/‹(\d)\/(\d)›/)?.slice(1).join("/");
  check(firstLit === "Rx.U" && at(navLine) === "3/3" && at(stepped.line) === "1/3" && stepped.lit === "Fx.U" && stepped.still && wrapped === firstLit, `the line stays on its problem when another appears; ‹ and › step through them, moving the halo, not the view (${at(navLine)} ${firstLit}, then ${at(stepped.line)} ${stepped.lit}, then ${wrapped})`);
  await page.click("#edit-cancel");
  sw = await sweep3d();
  const cancelGlow = [(await probe("glowColors", "Fx.U", "U")).join(), (await probe("glowColors", "Fx.U", "F")).join()].join(" ");
  check((await probe("state")) === editedState && sw.wrong.length === 0 && cancelGlow === "W R", `Cancel leaves the position, and its drawing and glow, as they were (glow ${cancelGlow})`);
});

labTest("shape editing: Show and the arrow reach a piece bared by taking an extension piece off", async ({ page, check, probe, gesture, settle }) => {
  // The owner's case: a core edge left with no extensions. The hint halos a glass box in
  // each spot an extension could go; the piece taken off is hidden, not gone, and must not
  // block the view of the box in its spot.
  const tapAt = async ({ x, y }) => {
    await gesture([["pointerdown", x, y], ["pointerup", x, y]]);
    await page.waitForFunction(() => window.xcubeProbe.idle());
  };
  await page.click("#edit-start");
  await page.click('[data-paint="shape"]');
  await tapAt(await probe("sticker", "Fx.U", "F"));
  const line = await page.$eval("#edit-status", (e) => e.textContent);
  const haloed = (await probe("haloed")).sort().join();
  check(/This core edge has no extensions, but it has to have one or two\. Add an extension to this edge/.test(line) && haloed === "Fx.U,UF,Ux.F", `taking the edge's only extension off halos the edge and the spots to fill (${line}, ${haloed})`);
  // From the front, the box where the piece taken off was shows: the hidden piece
  // doesn't block the view of it.
  await page.evaluate(() => document.querySelector('[data-view="front"]').click());
  await settle();
  check((await probe("facesSeen", "Fx.U")) >= 1, `the box in the spot it was taken from counts as seen (${await probe("facesSeen", "Fx.U")} faces)`);
  await page.evaluate(() => document.querySelector('[data-view="back"]').click());
  await settle();
  await page.waitForFunction(() => window.xcubeProbe.haloArrow().opacity === 1);
  await page.click('[data-halo="show"]');
  await settle();
  await page.waitForFunction(() => window.xcubeProbe.haloArrow().opacity === 0, null, { timeout: 5000 }).catch(() => {});
  const after = { seen: (await probe("facesSeen", "Fx.U")) + (await probe("facesSeen", "Ux.F")), arrow: await probe("haloArrow") };
  check(after.seen >= 1 && after.arrow.behind.length === 0 && after.arrow.opacity === 0, `Show turns the view to it, and the arrow goes (${JSON.stringify(after)})`);
});

labTest(
  "info: Copy debug info saves a copy for Claude, and the clock beside Paste lists them back",
  async ({ page, check, probe, settle, gesture }) => {
    // With the shared database (a stand-in here), a copy goes into its "debug" collection,
    // where Claude reads it; only the newest 20 are kept.
    await page.click("#edit-start");
    await page.click('[data-paint="shape"]');
    const at = await probe("sticker", "Fx.U", "F");
    await gesture([["pointerdown", at.x, at.y], ["pointerup", at.x, at.y]]);
    await settle();
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve(), readText: () => Promise.reject(new Error("denied")) }, configurable: true }));
    for (let k = 0; k < 22; k++) {
      await page.evaluate(() => (document.getElementById("message").textContent = ""));
      if (await page.$eval("#info-pop", (e) => e.hidden)) await page.click("#info-btn");
      await page.click("#copy-debug");
      await page.waitForFunction(() => /saved for Claude at \w{3} \d+, \d{4}, \d+:\d\d:\d\d/.test(document.getElementById("message").textContent), null, { timeout: 5000 });
    }
    const closed = await page.$eval("#info-pop", (e) => e.hidden);
    check(closed, "Copy debug info closes the ⓘ panel, so its message shows");
    const kept = await page.evaluate(() => [...window.__fakeDb.debug.values()].map((d) => ({ edit: JSON.parse(d.json).edit?.removed?.join(), source: d.source, at: typeof d.savedAt })));
    check(kept.length === 20 && kept.every((d) => d.edit === "Fx.U" && d.source === "page" && d.at === "number"), `copies are saved for Claude, the newest 20 kept (${kept.length}, ${JSON.stringify(kept[0])})`);
    await page.click("#edit-cancel");
    await settle();
    // The clock beside Paste debug info lists the saved copies by time, and one tap puts one back.
    if (await page.$eval("#info-pop", (e) => e.hidden)) await page.click("#info-btn");
    await page.click("#debug-history");
    await page.waitForSelector("#debug-list:not([hidden]) button", { timeout: 5000 });
    const items = await page.$$eval("#debug-list button", (bs) => bs.map((b) => b.textContent));
    await page.click("#debug-list button");
    await settle();
    const back = { removed: (await probe("shapeEdit"))?.removed.join(), open: !(await page.$eval("#info-pop", (e) => e.hidden)) };
    check(items.length === 20 && items.every((t) => /\d{4}/.test(t) && /\d:\d\d:\d\d/.test(t)) && back.removed === "Fx.U" && !back.open, `the clock lists the saved copies by date and time to the second, and a tap puts one back (${JSON.stringify({ items: items.length, first: items[0], back })})`);
    // An iPad names itself a Mac; its touch points, kept with the debug info, tell it apart.
    const touch = JSON.parse(await probe("debugInfo")).device.touch;
    await page.evaluate(() => {
      const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
      const add = (touch, at) => window.__fakeDb.debug.set(`t${at}`, { json: JSON.stringify({ lab: "x-cube debug 1", device: { agent: mac, touch } }), savedAt: at, source: "page" });
      add(5, Date.now() + 2000);
      add(0, Date.now() + 1000);
    });
    await page.click("#info-btn");
    await page.click("#debug-history");
    await page.waitForSelector("#debug-list:not([hidden]) button", { timeout: 5000 });
    const named = await page.$$eval("#debug-list button", (bs) => bs.slice(0, 2).map((b) => b.textContent.split(" · ")[1]));
    check(typeof touch === "number" && named.join() === "iPad,Mac", `debug info keeps the touch points, and a Mac with them is listed as an iPad (${JSON.stringify({ touch, named })})`);
    // Clear saved debug info: the first tap asks "Clear?"; the second reads "Clearing…",
    // with the list set aside, while every copy is deleted at once; the list closing says
    // it's done. If the database refuses, it says so beside the clock and keeps the list.
    await page.click("#debug-clear");
    const asked = await page.$eval("#debug-clear", (e) => ({ armed: e.classList.contains("armed"), text: e.textContent }));
    const before = await page.evaluate(() => window.__fakeDb.debug.size);
    await page.evaluate(() => { window.__deleteFail = true; window.__deleteDelay = 300; window.__maxInFlight = 0; });
    await page.click("#debug-clear");
    const during = await page.evaluate(() => ({ text: document.getElementById("debug-clear").textContent, faded: document.getElementById("debug-list").classList.contains("clearing") }));
    await page.waitForFunction(() => document.getElementById("debug-clear").classList.contains("failed"), null, { timeout: 5000 });
    const failed = await page.evaluate(() => ({ text: document.getElementById("debug-clear").textContent, list: !document.getElementById("debug-list").hidden, faded: document.getElementById("debug-list").classList.contains("clearing"), left: window.__fakeDb.debug.size }));
    check(asked.armed && asked.text === "Clear?" && during.text === "Clearing…" && during.faded && failed.text === "Not cleared" && failed.list && !failed.faded && failed.left === before, `if the database refuses, the clear says so beside the clock and keeps the list (${JSON.stringify({ asked, during, failed, before })})`);
    await page.evaluate(() => { window.__deleteFail = false; window.__maxInFlight = 0; });
    await page.click("#debug-clear");
    await page.click("#debug-clear");
    const clearing = await page.$eval("#debug-clear", (e) => e.textContent);
    await page.waitForFunction(() => window.__fakeDb.debug.size === 0 && document.getElementById("debug-list").hidden, null, { timeout: 5000 });
    const gone = await page.evaluate(() => ({ drawn: getComputedStyle(document.getElementById("debug-list")).display !== "none", btn: document.getElementById("debug-clear").hidden, msg: document.getElementById("message").textContent, atOnce: window.__maxInFlight }));
    check(clearing === "Clearing…" && !gone.drawn && gone.btn && !/clear/i.test(gone.msg) && gone.atOnce === before, `the clear deletes every copy at once, and the list closing is the confirmation (${JSON.stringify({ clearing, gone, before })})`);
  },
  {
    // A stand-in for the shared database: collections of documents in memory.
    initScript: () => {
      const cols = {};
      let n = 0;
      const col = (name) => (cols[name] ??= new Map());
      const snapOf = (entries) => ({ docs: entries.map(([id, data]) => ({ id, data: () => data })), metadata: { fromCache: false } });
      const query = (name, ord, lim) => ({
        orderBy: (f, dir = "asc") => query(name, [f, dir], lim),
        limit: (k) => query(name, ord, k),
        get: async () => {
          const e = [...col(name)].map(([id, d], i) => [id, d, i]);
          if (ord) e.sort((a, b) => (((a[1][ord[0]] ?? 0) - (b[1][ord[0]] ?? 0)) || a[2] - b[2]) * (ord[1] === "desc" ? -1 : 1));
          const out = e.map(([id, d]) => [id, d]);
          return snapOf(lim ? out.slice(0, lim) : out);
        },
        onSnapshot: (next) => {
          next(snapOf([...col(name)]));
          return () => {};
        },
      });
      const db = {
        collection: (name) => ({
          ...query(name),
          add: async (data) => {
            const id = `d${++n}`;
            col(name).set(id, data);
            return { id };
          },
          // Deletes can be made slow (__deleteDelay ms) or refused (__deleteFail); __inFlight
          // and __maxInFlight count how many run at once.
          doc: (id) => ({
            delete: async () => {
              window.__inFlight = (window.__inFlight ?? 0) + 1;
              window.__maxInFlight = Math.max(window.__maxInFlight ?? 0, window.__inFlight);
              try {
                await new Promise((r) => setTimeout(r, window.__deleteDelay ?? 0));
                if (window.__deleteFail) throw new Error("refused");
                col(name).delete(id);
              } finally {
                window.__inFlight--;
              }
            },
          }),
        }),
      };
      window.__fakeDb = cols;
      window.claude = { use: async (x) => (x === "db" ? db : null) };
    },
  },
);

labTest("info: Paste debug info puts back an edit that isn't valid", async ({ page, check, probe, settle, gesture }) => {
  // An edit whose shape isn't valid has no state code; its debug info is the way back to it.
  await page.click("#edit-start");
  await page.click('[data-paint="shape"]');
  const at = await probe("sticker", "Fx.U", "F");
  await gesture([["pointerdown", at.x, at.y], ["pointerup", at.x, at.y]]);
  await settle();
  const json = await probe("debugInfo");
  const line = await page.$eval("#edit-status", (e) => e.textContent);
  await page.click("#edit-cancel");
  await settle();
  const message = () => page.$eval("#message", (e) => e.textContent);
  const putBack = async () => ({ removed: (await probe("shapeEdit"))?.removed.join(), line: await page.$eval("#edit-status", (e) => e.textContent), message: await message(), open: !(await page.$eval("#info-pop", (e) => e.hidden)) });
  // From the clipboard.
  await page.evaluate((j) => Object.defineProperty(navigator, "clipboard", { value: { readText: () => Promise.resolve(j), writeText: () => Promise.resolve() }, configurable: true }), json);
  await page.click("#info-btn");
  await page.click("#paste-debug");
  await settle();
  const read = await putBack();
  check(read.removed === "Fx.U" && read.line === line && /Debug info put back/.test(read.message) && !read.open, `Paste debug info puts the edit back from the clipboard, and closes the panel (${JSON.stringify(read)})`);
  await page.click("#edit-cancel");
  await settle();
  // Where the clipboard can't be read, the field takes it, and refuses what isn't debug info.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { readText: () => Promise.reject(new Error("denied")) }, configurable: true }));
  await page.click("#info-btn");
  await page.click("#paste-debug");
  const field = await page.$eval("#debug-text", (f) => ({ shown: !f.hidden, editable: !f.readOnly }));
  await page.fill("#debug-text", "not debug info");
  const refused = await message();
  // Words around it, as in a message to a developer, are left out.
  await page.fill("#debug-text", `Here is what I saw {see below}:\n${json}\nWhat do you think?`);
  await settle();
  const typed = await putBack();
  check(field.shown && field.editable && /That isn't debug info/.test(refused) && typed.removed === "Fx.U" && typed.line === line, `without the clipboard the field takes it, refusing other text (${JSON.stringify({ field, refused, typed })})`);
});

labTest("info: Paste debug info puts a solve's steps back, so Next step and Lost? go on from there", async ({ page, check, probe, settle }) => {
  // A play-tester's solve, ten steps in (corners, then edges), with the last step shown.
  const debug = {"lab":"x-cube debug 1","base":"ZWWP GERE AWYC PYYQ PAJE XPAA NMEY ZLPZ PRKV ICYH NWOJ","turns":"U' D R U2 F L B R U' L2 U2 L2 U R2 U x2 l U l' F R F' l F R' F' U' l' y r' U' F' L' F r F' L F r' U r x2 r' U' F' L' F r F' L F r' U r l U l' F R F' l F R' F' U' l'","cursor":66,"current":"RGDF GHXZ IFKR BYGR HSGS CZWX UPAH UNSQ ZCXN SOYI NNXI","view":[0.23561,-0.29558,-0.07547,0.92273],"solving":true,"order":"kinds","steps":[{"index":1,"stage":"shape","start":0,"alg":"U' D R U2 F L B R","shown":false},{"index":2,"stage":"core","start":8,"alg":"U' L2 U2 L2 U R2","shown":false},{"index":3,"stage":"parity","start":14,"alg":"U","shown":false},{"index":4,"stage":"regrip","start":15,"alg":"x2","shown":false},{"index":5,"stage":"corners","start":16,"alg":"[l U: l' (F R F') l (F R' F')]","shown":false},{"index":6,"stage":"regrip","start":28,"alg":"y","shown":false},{"index":7,"stage":"corners","start":29,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":8,"stage":"regrip","start":41,"alg":"x2","shown":false},{"index":9,"stage":"corners","start":42,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":10,"stage":"corners","start":54,"alg":"[l U: l' (F R F') l (F R' F')]","shown":true}],"edit":null};
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify(debug));
  const back = await page.waitForFunction(() => {
    const steps = JSON.parse(window.xcubeProbe.debugInfo()).steps;
    return steps.length === 10 && steps;
  }, null, { timeout: 20000 }).then((h) => h.jsonValue(), () => null);
  await settle();
  const info = JSON.parse(await probe("debugInfo"));
  check(JSON.stringify(back) === JSON.stringify(debug.steps) && info.solving && info.cursor === 66 && info.current === debug.current, `the steps, the turns and the position come back (${JSON.stringify({ steps: back?.length, solving: info.solving, cursor: info.cursor })})`);
  const said = await page.$eval("#message", (e) => e.textContent);
  check(/Solve restored: 10 steps/.test(said), `a message says so ("${said}")`);
  await page.evaluate(() => (document.getElementById("guide").open = true));
  check(await page.$eval("#lost", (b) => !b.disabled && !b.hidden), "Lost? can be asked from there");
  await guideHelpers(page, settle).next();
  const next = await page.waitForFunction(() => {
    const steps = JSON.parse(window.xcubeProbe.debugInfo()).steps;
    return steps.length === 11 && steps[10];
  }, null, { timeout: 20000 }).then((h) => h.jsonValue(), () => null);
  check(next?.index === 11 && next.start === 66, `Next step goes on with step 11 (${JSON.stringify(next)})`);
});

labTest("info: the help says what taps and drags do in each mode, and Copy debug info puts an edit back", async ({ page, check, probe, play, settle, gesture }) => {
  const help = async () => {
    if (await page.$eval("#info-pop", (p) => p.hidden)) await page.click("#info-btn");
    const text = await page.$eval("#info-text", (e) => e.textContent);
    await page.keyboard.press("Escape");
    return text;
  };
  const plain = await help();
  await play("R U");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  const solve = await help();
  await page.click("#guide-stop");
  await page.click(`[data-tab="start"]`);
  await page.click("#edit-start");
  const paint = await help();
  await page.click('[data-paint="shape"]');
  const shape = await help();
  check(
    /Swipe on the puzzle to turn a layer/.test(plain) && !/During a solve step/.test(plain) && /During a solve step/.test(solve) && /Editing the puzzle\. Tap a sticker to give it the picked color/.test(paint) && !/Swipe on the puzzle/.test(paint) && /Tap a piece to remove it, or tap a gray box to add one/.test(shape),
    `the help follows the mode (${[plain, solve, paint, shape].map((t) => t.slice(0, 40)).join(" | ")})`,
  );
  // An edit whose shape isn't valid, copied and put back.
  const at = await probe("sticker", "Fx.U", "F");
  await gesture([["pointerdown", at.x, at.y], ["pointerup", at.x, at.y]]);
  await page.waitForFunction(() => window.xcubeProbe.idle());
  const before = await page.$eval("#edit-status", (e) => e.textContent);
  const json = await probe("debugInfo");
  const info = JSON.parse(json);
  check(info.edit?.removed.join() === "Fx.U" && info.edit.tool === "shape" && typeof info.turns === "string", `the debug info holds the edit (${JSON.stringify({ removed: info.edit?.removed, tool: info.edit?.tool, problems: info.edit?.problems.length })})`);
  await page.click("#edit-cancel");
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), json);
  await settle();
  const back = await probe("shapeEdit");
  const line = await page.$eval("#edit-status", (e) => e.textContent);
  check(back?.removed.join() === "Fx.U" && line === before, `restoring it puts the edit back as it was (${JSON.stringify(back?.removed)}, "${line}")`);
  await page.click("#info-btn");
  await page.click("#copy-debug");
  const said = await page.waitForFunction(() => /Debug info copied/.test(document.getElementById("message").textContent), null, { timeout: 5000 }).then(() => true, () => false);
  check(said, "Copy debug info says it copied");
  // With no clipboard at all, the text stays on screen, selected, to copy by hand.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
    document.execCommand = () => false;
  });
  await page.click("#info-btn");
  await page.click("#copy-debug");
  const shown = await page.waitForFunction(() => /Select and copy the debug info/.test(document.getElementById("message").textContent), null, { timeout: 5000 }).then(() => true, () => false);
  const field = await page.$eval("#debug-text", (f) => ({ hidden: f.hidden, edit: JSON.parse(f.value).edit?.removed?.join(), selected: f.selectionEnd - f.selectionStart === f.value.length }));
  const open = !(await page.$eval("#info-pop", (p) => p.hidden));
  check(shown && open && !field.hidden && field.edit === "Fx.U" && field.selected, `without a clipboard the panel stays open and the debug info stays shown and selected (${JSON.stringify({ shown, open, ...field })})`);
});

labTest("shape editing: a tap changes only what it taps, paint stays on its spot, and the shape may be wrong for a while", async ({ page, check, probe, gesture }) => {
  const editLine = () => page.$eval("#edit-status", (e) => e.textContent);
  const idle = () => page.waitForFunction(() => window.xcubeProbe.idle());
  const tapAt = async ({ x, y }) => {
    await gesture([["pointerdown", x, y], ["pointerup", x, y]]);
    await idle();
  };
  const tapSticker = async (slot, face) => {
    await page.locator("#scene").scrollIntoViewIfNeeded();
    const at = await probe("sticker", slot, face);
    const there = await probe("at3d", at.x, at.y);
    if (there?.slot !== slot || there?.face !== face) throw new Error(`can't tap ${slot}/${face}: ${JSON.stringify(there)} is drawn there`);
    await tapAt(at);
  };
  const tool = (t) => page.click(`[data-paint="${t}"]`);
  const start = await probe("state");
  const label = await page.$eval("#edit-start", (b) => b.textContent.trim());
  await page.click("#edit-start");
  await tool("shape");
  const fresh = await probe("shapeEdit");
  check(
    /Edit puzzle$/.test(label) && fresh.spots.length === 18 && fresh.spots.every((t) => /^[UD]x/.test(t)) && fresh.removed.length + fresh.added.length === 0 && /^Valid/.test(await editLine()),
    `Edit puzzle opens on the puzzle as it is, and the Shape tool marks the empty spots a tap can fill (${label}; ${fresh.spots})`,
  );
  // A piece put in where it makes a fifth double edge is a blank (the shape is wrong); the
  // flat view shows it, as the 3D view does. A tap on it takes it away again.
  const editorCells = async () => (await probe("flatFace", "U")).flat().filter((c) => c?.slot === "editor").length;
  const before = await editorCells();
  await tapAt(await probe("spot", "Ux.F"));
  const blank = { added: (await probe("shapeEdit")).added.join(), before, cells: await editorCells() };

  await tapAt(await probe("spot", "Ux.F"));
  check(blank.added === "Ux.F" && blank.cells > blank.before && (await probe("shapeEdit")).added.length === 0, `a piece put in while the shape is wrong shows in the flat view, and a tap takes it away (${JSON.stringify(blank)})`);
  // Two problems that name no pieces: › steps from one to the other and back.
  await tapAt(await probe("spot", "Ux")); // a fifth extension center
  await tapAt(await probe("spot", "Ux.F")); // and a fifth double edge
  const steps = [await editLine()];
  for (let k = 0; k < 2; k++) {
    await page.click('[data-halo="next"]');
    steps.push(await editLine());
  }
  check(
    steps[0] !== steps[1] && steps.slice(0, 2).every((t) => /^Not valid: Five (core edges|centers) .*‹[12]\/2›( Show Hide)?$/.test(t)) && steps[2] === steps[0],
    `› steps through problems that name no pieces (${steps.join(" | ")})`,
  );
  // Five core edges with two extensions each: the hint names the extension pieces one of
  // which should come off, the two over UF (enclosed on every side, with the piece just
  // put over it) among them, and halos them, never the core edge nothing shows.
  if (!/Five core edges/.test(await editLine())) await page.click('[data-halo="next"]');
  const edges = { named: await probe("highlighted"), haloed: await probe("haloed"), line: await editLine() };
  check(
    /One of these extensions should probably be removed/.test(edges.line) && !edges.haloed.includes("UF") && ["Fx.U", "Ux.F"].every((t) => edges.haloed.includes(t)),
    `the extension pieces to take off are haloed, not the core edge they hide (${JSON.stringify(edges)})`,
  );
  // The piece put in is a blank until the shape is right: it is outlined too, and from
  // below, where it can't be seen, the arrow counts it.
  const rimmed = await probe("outlined");
  await page.evaluate(() => document.querySelector('[data-view="bottom"]').click());
  await page.waitForFunction(() => window.xcubeProbe.idle());
  const below = (await probe("haloArrow")).behind;
  check(rimmed.includes("Ux.F") && below.includes("Ux.F"), `the blank put in is outlined, and the arrow points to it when it can't be seen (${JSON.stringify({ rimmed, below })})`);
  await page.evaluate(() => document.querySelector('[data-view="home"]').click());
  await page.waitForFunction(() => window.xcubeProbe.idle());
  await tapAt(await probe("spot", "Ux.F"));
  await tapAt(await probe("spot", "Ux"));
  check((await probe("shapeEdit")).added.length === 0, "a tap on each blank takes it away again");
  // One of two extension pieces on a core edge goes away alone, keeping the other's paint;
  // its color away from the core stays with its spot, and the core edge it bares shows its
  // own color, none here (no core piece shows green).
  await tapSticker("Fx.R", "F");
  const one = { e: await probe("shapeEdit"), line: await editLine(), kept: await probe("painted", "Rx.F", "R"), gone: await probe("painted", "Fx.R", "F"), fell: await probe("painted", "FR", "F") };
  check(
    one.e.removed.join() === "Fx.R" && one.e.spots.includes("Fx.R") && one.line.startsWith("Not valid: Only three core edges have two extensions, but there must be four. An extension should probably be added in one of these spots.") && one.kept === "R" && one.gone === "G" && one.fell === null,
    `a tap takes one piece away, its color stays with its spot, the core edge it bares shows its own (none), and the line says what the shape lacks (${JSON.stringify(one)})`,
  );
  // A tap on an empty spot puts a piece there; the shape is right again, made of real pieces, with stickers to paint.
  await tapAt(await probe("spot", "Ux.F"));
  const two = { e: await probe("shapeEdit"), line: await editLine(), done: await page.$eval("#edit-done", (b) => b.disabled), filled: [await probe("filled", "Ux.F"), await probe("filled", "Fx.R")].join(), took: await probe("painted", "Ux.F", "U") };
  check(
    two.e.removed.length + two.e.added.length === 0 && two.filled === "true,false" && two.took === null && /^Not valid: /.test(two.line) && two.e.unpainted > 0 && two.e.outlines === two.e.unpainted && two.done,
    `filling a spot makes the shape right, the piece put in has no color yet facing away from the core (not the white it covers); each sticker not painted yet is a dashed outline, and Done waits for them (${JSON.stringify(two)})`,
  );
  // An extension piece on a core corner comes and goes alone too; the line names the corner.
  await tapSticker("Fx.UR", "F");
  const corner = { removed: (await probe("shapeEdit")).removed.join(), line: await editLine(), stays: await probe("filled", "Rx.UF") };
  await tapAt(await probe("spot", "Fx.UR"));
  check(
    corner.removed === "Fx.UR" && corner.stays && /^Not valid: This core corner has only one extension, but it has to have two\./.test(corner.line) && (await probe("filled", "Fx.UR")),
    `a tap takes an extension piece off a core corner without turning anything, and a tap on its spot puts it back (${JSON.stringify(corner)})`,
  );
  // A sticker can be painted while the shape is wrong.
  await tapSticker("Fx.L", "F");
  await tool("R");
  await tapSticker("Ux.F", "U");
  const wrong = { e: await probe("shapeEdit"), painted: await probe("painted", "Ux.F", "U"), line: await editLine() };
  check(wrong.e.removed.join() === "Fx.L" && wrong.painted === "R" && /^Not valid: Only three core edges/.test(wrong.line), `a sticker takes paint while the shape is wrong (${JSON.stringify(wrong)})`);
  // The flat view shows what the editor draws over the puzzle too: a piece put in while
  // the shape is wrong, with its stickers.

  await page.click("#edit-cancel");
  await idle();
  check((await probe("state")) === start && (await probe("filled", "Fx.R")), "Cancel leaves the position as it was");
  // Taken away and put back, a piece gets all its colors back: its side colors fell onto
  // what it bared and it takes them from what it covers, and its color away from the core
  // stayed with its spot; the core corner's face it bared shows its own color, none here.
  await page.click("#edit-start");
  await tool("shape");
  await tapSticker("Fx.UR", "F");
  const fell = [await probe("painted", "UFR", "F"), await probe("painted", "Fx.R", "U"), await probe("painted", "Fx.U", "R")].join();
  await tapAt(await probe("spot", "Fx.UR"));
  const back = { fell, line: await editLine(), colors: [await probe("painted", "Fx.UR", "F"), await probe("painted", "Fx.UR", "U"), await probe("painted", "Fx.UR", "R")].join() };
  check(back.fell === ",W,R" && back.colors === "G,W,R" && back.line === "Valid", `a piece's side colors fall onto the faces it bares, and all its colors come back when it is put back (${JSON.stringify(back)})`);
  // Moved from the front of a core edge to its top, a piece has stickers to color, and so
  // has the core edge's front it bared: they have a halo and a Hide pill in the 3D view.
  const move = async (from, face, to) => {
    await tapSticker(from, face);
    await tapAt(await probe("spot", to));
  };
  await move("Fx.U", "F", "Ux.F");
  await tool("W");
  const box = await page.$eval("#scene", (c) => { const r = c.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
  const few = { line: await editLine(), halo: (await probe("highlighted")).join(), pill: (await probe("shapeEdit")).pill, took: await probe("painted", "Ux.F", "U") };
  check(
    /^Not valid: \d+ stickers have no color yet\./.test(few.line) && few.halo.split(",").includes("UF") && few.halo.split(",").includes("Ux.F") && few.took === null && few.pill && few.pill.x > box.l && few.pill.x < box.r && few.pill.y > box.t && few.pill.y < box.b,
    `a piece moved onto a core edge's bare side, and the core edge's front it bared, have stickers to color, with a halo and a Hide pill inside the 3D view (${JSON.stringify(few)})`,
  );
  // The pill sits clear of the puzzle as drawn, not on it.
  const under = await probe("at3d", few.pill.x, few.pill.y);
  check(!under?.slot, `the Hide pill sits off the puzzle (${JSON.stringify({ pill: few.pill, under })})`);
  await page.click("#halo-hide");
  const hidden = { halo: (await probe("highlighted")).length, pill: (await probe("shapeEdit")).pill, wide: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) };
  check(hidden.halo === 0 && hidden.pill === null && hidden.wide <= 0, `the pill hides the halo, and itself (${JSON.stringify(hidden)})`);
  // Many pieces with stickers to paint get halos: the three moved, and the core faces they bared.
  await tool("shape");
  await move("Rx.U", "R", "Ux.R");
  await move("Fx.UR", "F", "Ux.FR");
  await move("Fx.UL", "F", "Ux.FL");
  await tool("W");
  for (let k = 0; k < 12 && !/stickers have no color yet/.test(await editLine()); k++) await page.click('[data-halo="next"]');
  const many = { line: await editLine(), halo: (await probe("highlighted")).length, pill: !!(await probe("shapeEdit")).pill, px: await probe("haloPixels", "3d") };
  check(
    /^Not valid: \d+ stickers have no color yet\./.test(many.line) && many.halo >= 4 && many.pill && many.px > 0,
    `many pieces with stickers to paint get halos (${JSON.stringify(many)})`,
  );
  await page.click("#edit-cancel");
  await idle();
});

labTest("color editing: the halo's outline is bold whatever is around the piece", async ({ page, check, probe, settle }) => {
  // Two play-testers' edits: a core corner set back between extension pieces standing in
  // front of it, and a core edge flush with its neighbors, where only seams lie beside it.
  // The outline is a band on screen around the part the view shows, so both get a full one.
  for (const [name, debug] of [["set back", {"lab":"x-cube debug 1","base":"LPFF UPQE WAIR CZWC MYKV WRAT NOOA IIFW ANYV TTXT JMFF","turns":"","cursor":0,"current":"LPFF UPQE WAIR CZWC MYKV WRAT NOOA IIFW ANYV TTXT JMFF","view":[0.19084,-0.80226,0.45429,-0.33702],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"LPFF UPQE WAIR CZWC MYKV WRAT NOOA IIFW ANYV TTXT JMFF","removed":[],"added":[],"colors":".O.W.G.......R.WG..G...R.......G..O........GY....OG.Y........W.O.........B.Y.R...O...W.......R...R.YG..G...O.......Y...........B..R..YG..O.W......W.......W........YO..B.......BO.W..........G.....OB....Y.B...Y.................WY......G................G............Y........Y.....R.B...R..O..R.........B..R.GY..O........W..R.BG..............Y..Y..GR.W....YW.....W.........Y.......O.Y..B..G.....W.....Y...O.Y.O.........................R..G..B..RR.............G...W.B.R..OB.O...R.W.G.","tool":"R","problems":[],"selected":"A core corner must be white or yellow, never orange. This sticker should maybe be yellow or white|13","hidden":null}}], ["flush", {"lab":"x-cube debug 1","base":"LPFF UPQE WAIR CZWC MYKV WRAT NOOA IIFW ANYV TTXT JMFF","turns":"","cursor":0,"current":"LPFF UPQE WAIR CZWC MYKV WRAT NOOA IIFW ANYV TTXT JMFF","view":[0.35003,-0.51635,-0.24334,0.74273],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"LPFF UPQE WAIR CZWC MYKV WRAT NOOA IIFW ANYV TTXT JMFF","removed":[],"added":[],"colors":".R.W.G.......W.WG..G...O.......R..Y........GY....OB.R........W.O.........W.R.G...W...W.......Y...R.WG..G...B.......R...........B..W..YG..O.W......W.......W........YO..G.......BR.W..........O.....OB....Y.G...R.................WG......O................G............Y........O.....R.B...G..O..G.........B..R.YW..R........B..R.BW..............Y..Y..GG.W....BG.....W.........G.......O.Y..B..O.....G.....G...O.Y.G.........................R..G..B..YR.............G...R.B.W..OB.O...G.W.G.","tool":"B","problems":[],"selected":"x|65","hidden":null}}]]) {
    await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify(debug));
    await settle();
    const ring = await probe("outlineOver");
    check(ring.purple >= 120, `a piece ${name} among its neighbors has a bold outline (${JSON.stringify(ring)})`);
  }
});

labTest("color editing: a hint circles the sticker it means when its color can't say which", async ({ page, check, probe, settle }) => {
  // A front extension corner painted with two orange stickers: the hint means the one that
  // should be green, and circles it in the view.
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.2,0.3,0.05,0.93],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","removed":[],"added":[],"colors":".O.Y.B.O.Y...O.YG..O...B.O.....O..G..OW..B.OW....OW.G....................O.Y.B...Y.....Y.....Y...O.YG..O...B...................O..G..OW..B..W.....W.....W....OW.O........................................Y.B...Y.....Y.....Y.....YG......B................G...W..B..W.....W.....W.....W.G.....................................R..Y.B...Y.....Y.....Y..R..YG.R....B..................R...G.R.W..B..W.....W.....W...R.W.G...................R..Y.BR..Y..R..YG.R....BR.....R...G.R.W..BR.W...R.W.G.","tool":"W","problems":[],"selected":"","hidden":null}}));
  await settle();
  const line = await page.$eval("#edit-status", (e) => e.textContent);
  const marks = await probe("marks");
  check(/Its circled orange sticker should probably be green/.test(line) && marks.list.length === 1 && marks.list[0].slot === "Fx.UL" && marks.list[0].face === "F" && marks.px > 40, `the circled sticker has a ring (${JSON.stringify({ line, marks })})`);
  await page.click('[data-halo="hide"]');
  await settle();
  const hidden = await probe("marks");
  check(hidden.list.length === 0 && hidden.px === 0, `Hide takes the ring away with the halo (${JSON.stringify(hidden)})`);
});

labTest("shape editing: Show looks at a core edge and its spots at a slight angle", async ({ page, check, probe, settle }) => {
  // From play-testers' edits: a core edge with no extensions, at the top right and at the
  // bottom left among other empty spots. Straight at its sticker showed the spots on it
  // edge-on, and a corner view from below crowded them with other glass boxes; a slight
  // tilt along the edge shows how they sit on it.
  for (const [debug, sign] of [[{"lab":"x-cube debug 1","base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.13223,0.8614,0.28584,-0.3985],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"X1:AaBaCaDaEaFaGaHaIa......JaKaLaMaNaOaPaQaRaSaTaUaVaWaXa..........coYaZaaabo..daeafagahaiajaudla....vv......manaoapaqarasatakg..waxayaza0a......1a2a3a4a5a6a7a8a9a","removed":["Rx.U","Rx.D","Bx.R","Lx.DB","Bx.DL","Lx.UF"],"added":["Ux.L"],"colors":".......O.Y.B.O.YG..O.Y.B.O.....OW.G..OW..B.OW.G................................O.Y.B...Y.....Y...O.YG..O.Y.B...................O..G..OW..B..W..........OW....OW.G.........W............................O.Y.B...Y.....Y..............R....B............R...G...W..B..W.....W...........W.G...............W.....................R..Y.B...Y..R..Y.....Y..R..YG............B..........G.......R.W..B..W...R.W.....W...R.W.G...................R..Y.B......R..YG.R....BR.WY..R...G.R.W..B......R.W.G.","tool":"shape","problems":[],"selected":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots|65,69,78","hidden":null}}, 1], [{"lab":"x-cube debug 1","base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.27985,0.36471,-0.11592,0.88048],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"X1:AaBaCaDaEaFaGaHaIa......JaKaLaMaNaOaPaQaRaSaTaUaVaWaXa............YaZaaabacadaeafagahaiajakala..........3wmanaoapw..rasatauavawaxayaza0a......1a2aqw4a5a6a7a8a9a","removed":["Fx.R","Rx","Fx.L","Lx.UB","Lx.D","Bx","Bx.DL","Rx.DF"],"added":["Dx.R","Fx.DR","Dx.BL","Ux.BL"],"colors":".O.Y.B.......O.YG..OW..B.O.Y...O..G........OW..B.OW.G....Y.........................B.O.Y.....Y...O.YG..O.Y.B................G........OW..B.O......W.....W....OW.G...W..................................O.Y.B...Y.....Y.....Y.....YG............B......RO..G...W..B..W.....W.....W.....W.G............................Y........R..Y.B...Y....................R....B......R.........G.......R.W..B..W.....W.....W...R.W.G...................R..Y.BR..Y........R....B......R...G.R.W..BR.W...R.W.G.","tool":"shape","problems":[],"selected":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots|14,1,10","hidden":null}}, -1]]) {
    await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify(debug));
    await settle();
    const line = await page.$eval("#edit-status", (e) => e.textContent);
    await page.click("#edit-status");
    await settle();
    const [x, y, z, w] = JSON.parse(await probe("debugInfo")).view;
    // The direction the view looks from, in the puzzle's frame: the camera's axis turned back by the view.
    const v = [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
    const tilt = (Math.asin(Math.min(1, Math.abs(v[2]))) * 180) / Math.PI;
    check(/This core edge has no extensions/.test(line) && v[0] * sign > 0.5 && v[1] * sign > 0.5 && tilt > 5 && tilt < 30, `Show looks at the edge at a slight angle (${JSON.stringify({ line, from: v.map((c) => +c.toFixed(2)), tilt: Math.round(tilt) })})`);
  }
});

labTest("shape editing: Show weighs a core corner's views quickly", async ({ page, check, settle }) => {
  // From a play-tester's edit: a core corner short an extension. Show weighs 25 views of
  // it; tested against the drawn pieces (about 62,000 triangles) that froze the page for
  // most of a second, against a box for each spot it takes a few milliseconds.
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","at":"2026-11-20T01:19:52.795Z","device":{"agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Claude/1.261116.19","width":557,"height":1024,"ratio":2},"base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.11592,-0.88048,0.27985,0.36471],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"X1:JgBaCaDaEaFaGaHaIaAg......KgLaMaNaOaPaQaRaSaTaUaVaWaXa............YaZaaabacadaeafagahaiajakala............manaoapaqarasatauavawaxayaza0a......1a2a3a4a5a6a7a8a9a","removed":["Fx.R","Rx.U","Fx.DR","Bx.UR","Rx.D","Fx.DL","Bx.DR","Lx.UF","Bx.UL","Fx.U"],"added":["Ux.FR","Dx.R","Dx.FR","Dx.FL","Ux.BL","Ux.FL"],"colors":".......O.Y...O.YG..O...B.O.....OW.G..OW..B.OW.G..O.....................................Y.....Y......G..OW..B...................O.YG......B..W.....W.....W....OW.G.....................................R..Y.B...Y.....Y.....Y..RO.YG......B............R.W.G.ROW..B..W.....W.....W.......G..........................................B...Y.....Y.....Y......G.R.WY.B......................G......B..W.....W.....W...R.W.G...................R..Y.BR.....R..YG.R....BR.WY..R...G.R.W..BR.....R.W.G.","tool":"shape","problems":[{"text":"This core corner has only one extension, but it has to have two. Add an extension to this corner in one of these spots","slots":["DBR","Dx.BR","Bx.DR"]},{"text":"This core corner has only one extension, but it has to have two. Add an extension to this corner in one of these spots","slots":["UBR","Bx.UR","Ux.BR"]},{"text":"This core corner has three extensions, but it can have only two. Remove an extension from this corner","slots":["UFR","Fx.UR","Ux.FR","Rx.UF"]},{"text":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots","slots":["UF","Fx.U","Ux.F"]},{"text":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots","slots":["UR","Ux.R","Rx.U"]},{"text":"Only three core edges have two extensions, but there must be four. An extension should probably be added in one of these spots","slots":["Dx.L","Ux.L","Dx.B","Dx.F","Fx.U","Ux.B","Ux.F","Fx.R","Ux.R","Rx.D","Rx.U"]}],"selected":"This core corner has only one extension, but it has to have two. Add an extension to this corner in one of these spots|54,50,53","hidden":null}}));
  await settle();
  const ms = await page.evaluate(() => {
    const t = performance.now();
    for (let i = 0; i < 5; i++) window.xcubeProbe.coreViewShares("DBR");
    return (performance.now() - t) / 5;
  });
  check(ms < 150, `a corner's 25 views are weighed in well under the time a frozen page shows (${ms.toFixed(1)} ms)`);
});

labTest("shape editing: the extension a hint means, among a hidden corner's three, is circled", async ({ page, check, probe, settle }) => {
  // From a play-tester's edit: a core corner with three extensions is hidden on every side,
  // so its halo is on all three; the one the hint means to take away is circled, the ring
  // standing at its middle, turned to the viewer, inside its outline.
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","at":"2026-11-20T01:38:55.199Z","device":{"agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Claude/1.261116.19","touch":5,"width":557,"height":938,"ratio":2},"base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.11592,-0.88048,-0.27985,-0.36471],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","removed":["Fx.UR","Rx.DF","Rx.U","Fx.DL","Lx.B","Bx.D","Fx.UL","Rx.B","Bx.UR","Bx.U","Lx.U"],"added":["Ux.BL","Ux","Dx.B","Ux.BR","Dx.FR","Dx.FL","Ux.FL","Ux.FR"],"colors":".O...B.O.Y...O.YG..O.....OW..B.O..G..OWY.B.O.....OW.G....................O.Y.B...Y.....Y.....Y......G..O...B...................OWYG.ROW..B..W.....W.....W.......G..........................................B...Y.....Y.....Y...O.YG...WY.B................G......B..W.....W.....W...ROW.G.....................................R..Y.B...Y.....Y.....Y..R..YG.R.W..B..................R.W.G......B..W.....W.....W.......G...................R..Y.BR..YG.R.....R.....R.W..BR..YG.R.W..BR.....R.W.G.","tool":"shape","problems":[{"text":"This core corner has three extensions, but it can have only two. Remove an extension from this corner, probably this one","slots":["UBL","Lx.UB"]},{"text":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots","slots":["UL","Lx.U","Ux.L"]},{"text":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots","slots":["UB","Bx.U","Ux.B"]},{"text":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots","slots":["UR","Ux.R","Rx.U"]},{"text":"Only two core edges have two extensions, but there must be four. An extension should probably be added in one of these spots","slots":["Lx.B","Lx.U","Dx.L","Ux.L","Dx.F","Bx.D","Bx.U","Ux.B","Ux.F","Dx.R","Ux.R","Rx.B","Rx.U"]},{"text":"Five centers have an extension center, but there can be only four. This extension center should probably be removed","slots":["Ux"]}],"selected":"This core corner has three extensions, but it can have only two. Remove an extension from this corner, probably this one|23,6","hidden":null}}));
  await settle();
  const line = await page.$eval("#edit-status", (e) => e.textContent);
  const marks = await probe("marks");
  // The ring is drawn over the extension it means: its middle shows that piece.
  const at = await probe("spot", "Lx.UB");
  const under = at && (await probe("at3d", at.x, at.y));
  check(/Remove an extension from this corner, probably the circled one\./.test(line) && marks.list.map((m) => m.slot + "/" + m.face).join() === "Lx.UB/piece" && marks.px > 0 && under?.slot === "Lx.UB", `the extension the hint means is circled, as a whole piece (${JSON.stringify({ line, marks, under })})`);
});

labTest("shape editing: a tap on the arrow turns to the view Show turns to", async ({ page, check, probe, settle }) => {
  // From a play-tester's edit, its core edge with no extensions (the second problem), its
  // spots behind the puzzle as it is turned. The arrow's tap and Show went to different
  // views; they agree now.
  const debug = {"lab":"x-cube debug 1","at":"2026-11-20T01:38:55.199Z","device":{"agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Claude/1.261116.19","touch":5,"width":557,"height":938,"ratio":2},"base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.11592,-0.88048,-0.27985,-0.36471],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","removed":["Fx.UR","Rx.DF","Rx.U","Fx.DL","Lx.B","Bx.D","Fx.UL","Rx.B","Bx.UR","Bx.U","Lx.U"],"added":["Ux.BL","Ux","Dx.B","Ux.BR","Dx.FR","Dx.FL","Ux.FL","Ux.FR"],"colors":".O...B.O.Y...O.YG..O.....OW..B.O..G..OWY.B.O.....OW.G....................O.Y.B...Y.....Y.....Y......G..O...B...................OWYG.ROW..B..W.....W.....W.......G..........................................B...Y.....Y.....Y...O.YG...WY.B................G......B..W.....W.....W...ROW.G.....................................R..Y.B...Y.....Y.....Y..R..YG.R.W..B..................R.W.G......B..W.....W.....W.......G...................R..Y.BR..YG.R.....R.....R.W..BR..YG.R.W..BR.....R.W.G.","tool":"shape","problems":[{"text":"This core corner has three extensions, but it can have only two. Remove an extension from this corner, probably this one","slots":["UBL","Lx.UB"]},{"text":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots","slots":["UL","Lx.U","Ux.L"]},{"text":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots","slots":["UB","Bx.U","Ux.B"]},{"text":"This core edge has no extensions, but it has to have one or two. Add an extension to this edge in one of these spots","slots":["UR","Ux.R","Rx.U"]},{"text":"Only two core edges have two extensions, but there must be four. An extension should probably be added in one of these spots","slots":["Lx.B","Lx.U","Dx.L","Ux.L","Dx.F","Bx.D","Bx.U","Ux.B","Ux.F","Dx.R","Ux.R","Rx.B","Rx.U"]},{"text":"Five centers have an extension center, but there can be only four. This extension center should probably be removed","slots":["Ux"]}],"selected":"This core corner has three extensions, but it can have only two. Remove an extension from this corner, probably this one|23,6","hidden":null}};
  debug.edit.selected = "";
  const view = async () => JSON.parse(await probe("debugInfo")).view;
  const open = async () => {
    await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify(debug));
    await settle();
    await page.click('[data-halo="next"]');
    await settle();
  };
  await open();
  check(/This core edge has no extensions/.test(await page.$eval("#edit-status", (e) => e.textContent)), "the second problem is a core edge's");
  await page.waitForFunction(() => window.xcubeProbe.haloArrow().opacity === 1);
  const mid = (await probe("haloArrow")).mid;
  await page.mouse.click(mid.x, mid.y);
  await settle();
  const byArrow = await view();
  await open();
  await page.click("#edit-status");
  await settle();
  const byShow = await view();
  const dot = Math.abs(byArrow.reduce((a, v, i) => a + v * byShow[i], 0));
  check(dot > 0.999, `the arrow's tap and Show end at the same view (${JSON.stringify({ byArrow, byShow })})`);
});

labTest("shape editing: a shape problem halos the glass box where an extension should go", async ({ page, check, probe, settle, gesture }) => {
  // An extension taken off a corner: either bare spot gives the corner two again, but only
  // the one it came from keeps the corners' twists whole. A glass box fills that spot, with
  // the halo on it and on the corner the line names, and Show turns the view to them.
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.28,0.36,0.12,0.88],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","removed":["Rx.UF"],"added":[],"colors":".O.Y.B.O.Y...O.YG..O...B.O.....O..G..OW..B.OW....OW.G....................O.Y.B...Y.....Y.....Y...O.YG..O...B...................O..G..OW..B..W.....W.....W....OW.G........................................Y.B...Y.....Y.....Y.....YG......B................G...W..B..W.....W.....W.....W.G.....................................R..Y.B...Y.....Y.....Y..R..YG.R....B..................R...G.R.W..B..W.....W.....W...R.W.G...................R..Y.BR..Y..R..YG.R....BR.....R...G.R.W..BR.W...R.W.G.","tool":"W","problems":[],"selected":"","hidden":null}}));
  await settle();
  await page.click('[data-halo="show"]');
  await settle();
  const seen = { line: await page.$eval("#edit-status", (e) => e.textContent), outlined: await probe("outlined"), px3d: await probe("haloPixels", "3d"), behind: (await probe("haloArrow")).behind, faces: await probe("facesSeen", "Rx.UF") };
  check(/This core corner has only one extension, but it has to have two\. Add an extension to this corner/.test(seen.line) && seen.outlined.join() === "Rx.UF,UFR" && seen.px3d > 0 && seen.behind.length === 0 && seen.faces > 0 && (await probe("hintBoxes")) === 1, `the spot to fill has a haloed glass box, in view after Show (${JSON.stringify(seen)})`);
  // With a color picked, a tap on the box means a shape edit: it colors nothing, says to
  // pick Shape, and the Shape button flashes.
  const before = await probe("shapeEdit");
  const at = await probe("spot", "Rx.UF");
  await gesture([["pointerdown", at.x, at.y], ["pointerup", at.x, at.y]]);
  await page.waitForFunction(() => /pick Shape first/.test(document.getElementById("message").textContent), null, { timeout: 3000 }).catch(() => {});
  const tapped = { message: await page.$eval("#message", (e) => e.textContent), control: await page.$eval("#message", (e) => [...e.querySelectorAll(".ui-name")].map((n) => [n.textContent, getComputedStyle(n).fontWeight]).join()), flash: await page.$eval('[data-paint="shape"]', (b) => b.classList.contains("flash")), removed: (await probe("shapeEdit")).removed.join() };
  check(/To add or remove an extension, pick Shape first/.test(tapped.message) && tapped.control === "Shape,700" && tapped.flash && tapped.removed === before.removed.join(), `a tap on the box with a color picked says to pick Shape (${JSON.stringify(tapped)})`);
  // It keeps pulsing while the message is read, and stops once Shape is picked.
  await page.waitForTimeout(2500);
  const still = await page.$eval('[data-paint="shape"]', (b) => b.classList.contains("flash"));
  await page.click('[data-paint="shape"]');
  const stopped = !(await page.$eval('[data-paint="shape"]', (b) => b.classList.contains("flash")));
  check(still && stopped, `the Shape button pulses for a while, and stops when Shape is picked (${JSON.stringify({ still, stopped })})`);
  await page.click('[data-paint="W"]');
  await settle();
  // With the Shape tool, its own box in that spot carries the halo: no second box.
  await page.click('[data-paint="shape"]');
  await settle();
  const shape = { outlined: await probe("outlined"), boxes: await probe("hintBoxes"), px3d: await probe("haloPixels", "3d") };
  check(shape.outlined.join() === "Rx.UF,UFR" && shape.boxes === 0 && shape.px3d > 0, `with the Shape tool the halo is on its own box there (${JSON.stringify(shape)})`);
  // The other boxes are fainter while the halo marks one, and all are alike once it is hidden.
  const boxes = await probe("ghostBoxes");
  const lit = boxes.filter((b) => !b.dim).map((b) => b.slot);
  await page.click('[data-halo="hide"]');
  await settle();
  const hidden = await probe("ghostBoxes");
  check(boxes.length > 1 && lit.join() === "Rx.UF" && hidden.length === boxes.length && hidden.every((b) => !b.dim), `the other glass boxes are fainter while the halo marks one (${JSON.stringify({ boxes: boxes.length, lit, dimAfterHide: hidden.filter((b) => b.dim).length })})`);
});

labTest("color editing: a tap with a sticker's own color clears it", async ({ page, check, probe, gesture }) => {
  const idle = () => page.waitForFunction(() => window.xcubeProbe.idle());
  const tap = async (slot, face) => {
    await page.locator("#scene").scrollIntoViewIfNeeded();
    const at = await probe("sticker", slot, face);
    await gesture([["pointerdown", at.x, at.y], ["pointerup", at.x, at.y]]);
    await idle();
  };
  const line = () => page.$eval("#edit-status", (e) => e.textContent);
  await page.click("#edit-start");
  await page.click('[data-paint="W"]');
  await tap("Fx.U", "U");
  const cleared = { painted: await probe("painted", "Fx.U", "U"), line: await line() };
  await tap("Fx.U", "U");
  const back = { painted: await probe("painted", "Fx.U", "U"), line: await line() };
  check(cleared.painted === null && /One sticker has no color yet/.test(cleared.line) && back.painted === "W" && back.line === "Valid", `tapping a white sticker with white clears it, and again colors it (${JSON.stringify({ cleared, back })})`);
});

labTest("color editing: Show turns a white or yellow sticker facing away from the core into view, circled", async ({ page, check, probe, settle }) => {
  // From a play-tester's edit: an extension edge below the puzzle with yellow facing down
  // and its other sticker without a color. The halo outlines the piece, whose uncolored
  // sticker was all the view showed of it; the yellow one is circled, and Show turns to it.
  const debug = {"lab":"x-cube debug 1","base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.30345,0.48673,-0.18509,0.79797],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"X1:Aa..CaDaEaFaGaHa....Bn..JaKaLnMaNa..VlQaZw..TaUaPbWiIi..ObXiSj......ilaabacadaeafagahaRsjakalaYb....mi..3w1inioapw..rasatauava..xuyaza0a7u......2aqw4a5a6awu8a9a","removed":[],"added":[],"colors":".O.Y.B.......O.YG..O...B.O.Y...OW.G..OW..B.OW.G................Y.........O.Y.B...Y...O.......Y...O.YG............B..........G........OW..B..W..........O.....OW.G.........W.....W......Y.........................B...Y.....Y..R..YG..O.Y.B.............O..G...W..B........W.....W.....W.G...W..................Y...........Y..R..Y.BR........Y......G.......R....B..................R..YG...............W.....W...R.W.G.........................R..Y.BR..YG.R..Y.BR.....R...G.......R.W...R.W.G.","tool":"shape","problems":[],"selected":"","hidden":null}};
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify(debug));
  await settle();
  const line = await page.$eval("#edit-status", (e) => e.textContent);
  await page.click("#edit-status");
  await settle();
  const at = await probe("sticker", "Dx.L", "D");
  const drawn = at && (await probe("at3d", at.x, at.y));
  check(/^Not valid: This piece's yellow sticker has the wrong color\. Its yellow sticker must be green, blue, red, or orange\./.test(line) && drawn?.slot === "Dx.L" && drawn?.face === "D", `Show turns the circled yellow sticker into view (${JSON.stringify({ line, drawn })})`);
  // In the view the play-tester had, the piece's uncolored sticker, drawn as a dashed
  // outline over it, faces the viewer: it is part of the piece, not a hole in it for the
  // outline to ring too (a ring around it drew about 140 band pixels over the piece; its
  // own outline's soft inner edge draws about 20).
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify(debug));
  await settle();
  const ring = await probe("outlineOver");
  check(ring.purple > 0 && ring.inside < 60, `the outline doesn't ring a sticker drawn over the piece (${JSON.stringify({ purple: ring.purple, inside: ring.inside })})`);
});

labTest("color editing: Show weighs its views quickly for a halo on many pieces", async ({ page, check, settle }) => {
  // From a play-tester's edit: 43 stickers with no color yet, on many pieces. Show weighs
  // some 70 views; with rays against the drawn pieces that froze the page for over a
  // second (1,664 ms on a fast machine), against a box for each spot it takes about a
  // tenth of one. CI's runners, measuring coverage, take four times as long as that
  // machine (382 and 405 ms), so the limit sits between the two ways, clear of both.
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","at":"2026-11-20T02:14:22.174Z","device":{"agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Claude/1.261116.19","touch":5,"width":557,"height":938,"ratio":2},"base":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","turns":"","cursor":0,"current":"VLTM DWOP YLQZ OLPZ LVKX ZFBX TLFA QRRS EMBD BWPF EWUS","view":[-0.11592,-0.88048,-0.27985,-0.36471],"solving":false,"order":"kinds","steps":[],"edit":{"shape":"X1:AaBaNu..EaFa....Xx..DgCuJaKaPgMu..OaLvQaRaSaGjUjVsWx..TjHsIxYq......Zqaabacadaeafaga..iojakalaho......4xqjmanaslpj3jraoitauava..xuynzg..7u8n9g1a2a....5a6awu..0g","removed":[],"added":[],"colors":".O...B.O.Y...O.YG..O.....OW..B.O..G..O.....O.....OW.G....................O.Y.B...Y.....Y.....Y......G..O...B...................OWYG.ROW..B..W.....W.....W.......G..........................................B...Y.....Y.....Y...O.YG...WY.B................G......B..W.....W.....W...ROW.G.....................................R..Y.B...Y.....Y.....Y..R..YG.R.W..B..................R.W.G......B..W.....W.....W.......G...................R..Y.BR..YG.R.....R.....R.W..BR..YG.R.W..BR.....R.W.G.","tool":"shape","problems":[{"text":"43 stickers have no color yet","slots":["Lx.DB","Dx.L","Dx.FL","DFL","BL","UBL","UL","UFL","Ux.BL","Ux.L","Ux.FL","Dx.B","DB","UB","Ux.B","Dx.R","Dx.FR","DFR","BR","UBR","UR","UFR","Ux.BR","Ux.R","Ux.FR"]}],"selected":"43 stickers have no color yet|0,10,11,15,18,23,24,25,27,28,29,30,34,43,47,51,52,56,59,64,65,66,68,69,70","hidden":null}}));
  await settle();
  const ms = await page.evaluate(() => {
    const t = performance.now();
    document.getElementById("edit-status").click();
    return performance.now() - t;
  });
  check(ms < 1000, `Show on a halo over many pieces is quick (${Math.round(ms)} ms)`);
});

labTest("color editing: colors that turns can't reach", async ({ page, check, probe, gesture }) => {
  // Valid means turns can reach some position showing the paint. Center colors arranged
  // as no turns arrange them are refused; a swap that look-alike pieces can absorb is not.
  const editLine = () => page.$eval("#edit-status", (e) => e.textContent);
  const doneOff = () => page.$eval("#edit-done", (e) => e.disabled);
  const paint = async (color, slot, face) => {
    await page.click(`[data-paint="${color}"]`);
    await page.locator("#scene").scrollIntoViewIfNeeded();
    const at = await probe("sticker", slot, face);
    const there = await probe("at3d", at.x, at.y);
    if (there?.slot !== slot || there?.face !== face) throw new Error(`can't tap ${slot}/${face}: ${JSON.stringify(there)} is drawn there`);
    await gesture([["pointerdown", at.x, at.y], ["pointerup", at.x, at.y]]);
  };
  await page.click("#edit-start");
  await paint("R", "Fx", "F");
  await paint("G", "Rx", "R"); // the red and green centers traded: red is now opposite blue
  const centers = { line: await editLine(), off: await doneOff(), lit: (await probe("highlighted")).sort().join(), level: (await probe("editing")).level };
  check(
    /^Not valid: Opposite centers must be red and orange, green and blue, or white and yellow\. The green and red centers should probably trade places\. Show Hide$/.test(centers.line) && centers.off && centers.lit === "Fx,Rx" && centers.level === "possible",
    `center colors no turns arrange are not valid, with a halo on the two centers to trade and Done off ("${centers.line}", halo ${centers.lit})`,
  );
  await paint("G", "Fx", "F");
  await paint("R", "Rx", "R");
  const restored = await editLine();
  // Two outer edges traded. With every other piece where it was, no turns make this;
  // with two look-alike core pieces traded as well, turns do, and Done gives that position.
  await paint("R", "Fx.U", "F");
  await paint("G", "Rx.U", "R");
  const traded = { line: await editLine(), off: await doneOff(), level: (await probe("editing")).level };
  await page.click("#edit-done");
  const done = { code: await probe("state"), model: [await probe("model", "Fx.U", "F"), await probe("model", "Rx.U", "R")].join() };
  check(
    restored === "Valid" && traded.line === "Valid" && !traded.off && traded.level === "reachable" && done.model === "R,G" && /^([A-Z]{4} ){10}[A-Z]{4}$/.test(done.code),
    `two outer edges traded are valid, and Done gives a position turns can reach, which has a 44-letter code (${traded.line}, ${done.code})`,
  );
});

// ---- The step guide.

labTest("guide: Next step loads one step, grays what it leaves alone, and shows where pieces go", async ({ page, check, probe, settle, play, status, counter, sweep3d, startFresh, turnList }) => {
  const { line, next } = guideHelpers(page, settle);
  // One corner 3-cycle away from solved: the step is that cycle undone, written as a commutator.
  await play("(F' L' F) r (F' L F) r'");
  await next();
  const g = await probe("guide");
  const loaded = { counter: await counter(), line: await line(), wide: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) };
  check(
    g?.stage === "corners" && g.turns === 8 && g.after === 0 && loaded.counter === "8/16" && /^Step 1 of 1 — Corners: Cycle three X-face corners\. All three end up solved\. Turns: r \(F' L' F\) r' \(F' L F\)$/.test(loaded.line) && loaded.wide <= 0,
    `Next step loads the step's turns unplayed and says what it applies to ("${loaded.line}", ${loaded.counter})`,
  );
  // The three corners keep their colors (9 stickers); the other 93 stickers are gray, none
  // darker, since a 3-cycle leaves every other piece alone. One arrow per corner.
  check(g?.focus.length === 3 && g.gray === 93 && g.darkGray === 0 && g.arrows === 3 && g.otherGlow === 0 && g.focusGlow > 0, `the pieces the step applies to keep their colors, the rest are gray, and arrows show the cycle (${JSON.stringify(g)})`);
  // Each path follows one sticker, in its color, from the face it is on to the face it will
  // be on; all three of these pieces end at home.
  const pathForm = /^[WYGBRO] [\w.]+\/[RLUDFB] > [\w.]+\/[RLUDFB] lands$/;
  check(g?.paths.length === 3 && g.pathMeshes === 24 && g.pathsThrough === 0 && g.pathsOut < 0.45 && g.headGap >= 0 && g.headGap < 0.05 && g.paths.every((t) => pathForm.test(t)) && new Set(g.paths.map((t) => t.split(" ")[1])).size === 3, `each moved piece has a path from one of its stickers to where that sticker will be, going around the puzzle, not through it, each shaft joined to its head (${g?.paths.join("; ")})`);
  // A small copy of each piece flies along its path (unless the device asks for less motion). Show turns the
  // view so that every path's sticker, and the face it is going to, can be seen.
  const motion = await page.evaluate(() => !matchMedia("(prefers-reduced-motion: reduce)").matches);
  await page.evaluate(() => document.querySelector('[data-view="bottom"]').click());
  await settle();
  const seenPath = async (t) => {
    const [, from, to] = t.match(/^\w ([\w.]+\/\w) > ([\w.]+\/\w)/);
    const hits = [];
    for (const end of [from, to]) {
      const [slot, face] = end.split("/");
      const at = await probe("sticker", slot, face);
      const there = at && (await probe("at3d", at.x, at.y));
      hits.push(there?.slot === slot && there?.face === face);
    }
    return hits;
  };
  const hiddenBefore = (await Promise.all(g.paths.map(seenPath))).flat().filter((x) => !x).length;
  await page.click("#guide-show");
  await settle();
  const hiddenAfter = (await Promise.all(g.paths.map(seenPath))).flat().filter((x) => !x).length;
  check(g.runners === (motion ? 3 : 0) && hiddenBefore > 0 && hiddenAfter === 0, `Show turns the view to where the paths begin and end (${hiddenBefore} of 6 ends hidden from below, ${hiddenAfter} after Show; ${g.paths.join("; ")}); ${g.runners} copies fly`);
  await page.evaluate(() => document.querySelector('[data-view="home"]').click());
  await settle();
  // One turn forward hides the arrows; one turn back, to the step's start, shows them again.
  await page.click("#fwd");
  await settle();
  const stepped = (await probe("guide")).arrows;
  await page.click("#back");
  await settle();
  const returned = await probe("guide");
  check(stepped === 0 && returned.arrows === 3 && returned.gray === 93, `the arrows hide once the step is under way and return at its start (${stepped}, then ${returned.arrows})`);
  // The grays are really drawn: the 3D view no longer shows the model's colors everywhere.
  const grayDrawn = (await sweep3d()).wrong.length;
  await page.click("#last");
  await settle();
  const played = { g: await probe("guide"), status: await status(), line: await line(), wrong: (await sweep3d()).wrong.length };
  check(
    grayDrawn > 0 && played.wrong === 0 && played.g?.gray === 0 && played.g.arrows === 0 && /Solved/.test(played.status) && /^Step \d+ of \d+ — Corners: /.test(played.line) && !/done/.test(played.line),
    `playing the step solves the puzzle and returns every sticker's color (${grayDrawn} gray stickers seen before, ${played.wrong} wrong after; ${played.status}; "${played.line}")`,
  );
  // The step is boxed in the turn list behind a tag. Step start, and the tag, go back to
  // where the step begins, with its grays and arrows.
  const box = await page.$$eval("#history .step-box", (els) => els.map((e) => `${e.querySelector(".step-tag").textContent}:${e.querySelectorAll(".tok").length}:${e.classList.contains("on")}`).join());
  await page.click("#guide-start");
  await settle();
  const backAtStart = { counter: await counter(), g: await probe("guide"), label: await page.$eval("#guide-start", (b) => (b.disabled ? "off" : b.textContent + (b.classList.contains("primary") ? " (blue)" : ""))) };
  // At the step's start the same button plays the step.
  await page.click("#guide-start");
  await settle();
  const playedStep = { counter: await counter(), label: await page.$eval("#guide-start", (b) => b.textContent) };
  await page.click("#history .step-tag");
  await settle();
  const byTag = { counter: await counter(), arrows: (await probe("guide")).arrows };
  check(
    box === "1. Corners:8:true" && backAtStart.counter === "8/16" && backAtStart.g.arrows === 3 && backAtStart.g.gray === 93 && backAtStart.label === "Play step (blue)" && playedStep.counter === "16/16" && playedStep.label === "Step start" && byTag.counter === "8/16" && byTag.arrows === 3,
    `the step is boxed in the turn list (${box}); Step start and its tag go back to its start (${backAtStart.counter}, ${byTag.counter}); there it reads Play step and plays it (${JSON.stringify(playedStep)})`,
  );
  await page.click("#last");
  await settle();
  const solvedEnd = await page.evaluate(() => ({ next: document.getElementById("next-step").disabled, strip: document.getElementById("strip-next").hidden, play: document.getElementById("last").disabled }));
  check(solvedEnd.next && solvedEnd.strip && solvedEnd.play, `once solved, Next step is grayed out and ▶ (grayed out) doesn't give way to it (${JSON.stringify(solvedEnd)})`);
});

labTest("controls: the color rule: blue for a selected control, green for a good state, else neither", async ({ page, check, play }) => {
  const colors = () =>
    page.evaluate(() => {
      const resolve = (css) => {
        const p = document.createElement("span");
        p.style.cssText = css;
        document.body.append(p);
        const c = getComputedStyle(p);
        const out = { color: c.color, background: c.backgroundColor };
        p.remove();
        return out;
      };
      const accent = resolve("background: var(--accent)").background;
      const good = resolve("color: var(--good)").color;
      const picks = [...document.querySelectorAll(".mods button")].map((b) => ({ sel: b.classList.contains("sel"), blue: getComputedStyle(b).backgroundColor === accent }));
      const chips = [document.getElementById("shape-chip"), ...document.querySelectorAll("#outer-grid .chip")].map((c) => ({ name: c.textContent, good: c.classList.contains("good") || c.classList.contains("on"), green: getComputedStyle(c).color === good }));
      return { picks, chips };
    });
  const solved = await colors();
  check(solved.picks.length > 2 && solved.picks.some((p) => p.sel) && solved.picks.every((p) => p.sel === p.blue), `the selected turn amount and Order are blue, the others aren't (${JSON.stringify(solved.picks)})`);
  check(solved.chips.every((x) => x.good === x.green) && solved.chips[0].green && solved.chips.filter((x) => x.green).length === 5, `solved: the shape chip and the four outer turns that can turn are green, u and d aren't (${JSON.stringify(solved.chips)})`);
  await play("R");
  const out = await colors();
  check(out.chips.every((x) => x.good === x.green) && !out.chips[0].green && out.chips.slice(1).some((x) => x.green) && out.chips.slice(1).some((x) => !x.green), `out of shape: the shape chip and the refused outer turns aren't green, the others are (${JSON.stringify(out.chips)})`);
});

labTest("guide: a tapped Next step shows it is working until its step loads, and a second tap does nothing", async ({ page, check, probe, settle, play }) => {
  await play("R U");
  await page.evaluate(() => (document.getElementById("guide").open = true));
  // The tap and what shows right after it, before the solver has had a turn at the main thread.
  const tapped = await page.evaluate(() => {
    const btn = document.getElementById("next-step");
    btn.click();
    btn.click();
    return { line: document.getElementById("guide-line").textContent, text: btn.textContent, disabled: btn.disabled, working: btn.classList.contains("working"), idle: window.xcubeProbe.idle() };
  });
  check(tapped.line === "Working out the next step…" && tapped.text === "Working…" && tapped.disabled && tapped.working && !tapped.idle, `right after the tap, the line and the button say a step is being worked out (${JSON.stringify(tapped)})`);
  await settle();
  const loaded = await page.evaluate(() => ({ line: document.getElementById("guide-line").textContent, text: document.getElementById("next-step").textContent, working: document.querySelectorAll(".working").length, boxes: document.querySelectorAll("#history .step-box").length }));
  const g = await probe("guide");
  check(g?.index === 1 && /^Step 1 of \d+ — /.test(loaded.line) && loaded.text === "Next step" && loaded.working === 0 && loaded.boxes === 1, `then one step loads, from the two taps, and nothing says working any more (${JSON.stringify(loaded)})`);
  // A turn made while a step is being worked out leaves that step behind. (A turn by hand
  // first, so the plan doesn't have the step already.)
  await page.click("#last");
  await settle();
  await play("F");
  // Dropped as soon as the turn is queued, before it moves anything: a step arriving
  // before the turn starts must not take its place.
  const dropped = await page.evaluate(() => {
    document.getElementById("next-step").click();
    const waiting = document.getElementById("next-step").classList.contains("working");
    document.getElementById("back").click();
    return { waiting, after: document.getElementById("next-step").classList.contains("working"), line: document.getElementById("guide-line").textContent };
  });
  check(dropped.waiting && !dropped.after && dropped.line !== "Working out the next step…", `a turn queued while a step is worked out drops it at once (${JSON.stringify(dropped)})`);
  await settle();
  const after = await page.evaluate(() => ({ line: document.getElementById("guide-line").textContent, text: document.getElementById("next-step").textContent, boxes: document.querySelectorAll("#history .step-box").length }));
  check(after.line !== "Working out the next step…" && after.text === "Next step" && after.boxes === 1 && (await probe("guide")) === null, `and once the turn has played, no step loads (${JSON.stringify(after)})`);
});

labTest("guide: the solve is planned in a worker, and a step the plan has loads at once", async ({ page, check, probe, settle, play }) => {
  await play("R U F");
  await page.evaluate(() => (document.getElementById("guide").open = true));
  await page.click("#next-step");
  const where = await probe("planWhere");
  await settle();
  const first = await probe("guide");
  check(where === "worker" && first?.index === 1 && first.after > 0, `the plan is made in a worker, and the first step loads (${where}, ${JSON.stringify(first && { stage: first.stage, after: first.after })})`);
  await page.click("#last");
  await page.waitForFunction(() => !document.getElementById("strip-next").hidden, null, { timeout: 60000 });
  // Read in the same task as the tap: the step comes from the plan, with nothing to wait for.
  const second = await page.evaluate(() => {
    const t0 = performance.now();
    document.getElementById("strip-next").click();
    const ms = Math.round(performance.now() - t0);
    const g = window.xcubeProbe.guide();
    return { ms, index: g?.index, after: g?.after, working: document.querySelectorAll(".working").length, line: document.getElementById("guide-line").textContent };
  });
  check(second.index === 2 && second.after === first.after - 1 && second.working === 0 && /^Step 2 of /.test(second.line), `following the plan, the next step loads in the same moment as the tap (${JSON.stringify(second)})`);
});

labTest("guide: on the page, where no worker runs, the plan is made between frames, its counts shown once known", async ({ page, check, probe, settle, play }) => {
  await probe("planInPage");
  await page.click('[data-guide-mode="layers"]');
  await play("R U F r U' R2 f");
  await page.evaluate(() => (document.getElementById("guide").open = true));
  await page.click("#next-step");
  // The first step loads while later ones are still being found: its count waits for the plan.
  const early = await page.waitForFunction(() => /^Step 1 of … — /.test(document.getElementById("guide-line").textContent) && document.getElementById("steps-head").textContent, null, { timeout: 60000 }).then((h) => h.jsonValue());
  const where = await probe("planWhere");
  await settle();
  const line = await page.$eval("#guide-line", (e) => e.textContent);
  const head = await page.$eval("#steps-head", (e) => e.textContent);
  check(where === "page" && /^1 \/ … steps, \d+ \/ … total turns\. Planning(: [\w ]+)?…$/.test(early) && /^Step 1 of \d+ — /.test(line) && /^1 \/ \d+ steps, \d+ \/ \d+ total turns$/.test(head), `planned on the page, the counts read … with what is being planned, then the totals ("${early}", then "${head}"; ${where})`);
});

labTest("guide: a Regrip step, a shape step, the count, the marked parts, Stop, and an edit before the step", async ({ page, check, probe, settle, play, status, counter, sweep3d, startFresh, turnList }) => {
  const { line, next } = guideHelpers(page, settle);
  // A puzzle tipped over gets a Regrip step, which grays nothing: the center colors are what it goes by.
  await play("x");
  await next();
  const holdStep = { g: await probe("guide"), line: await line() };
  check(
    holdStep.g?.stage === "hold" && holdStep.g.gray === 0 && holdStep.g.darkGray === 0 && /^Step 1 of 1 — Regrip: Rotate the whole puzzle so the white center is up \(now \w+ is up\)\. Nothing else moves\. Turns: x'$/.test(holdStep.line),
    `a Regrip step says to turn the whole puzzle, and keeps every color ("${holdStep.line}")`,
  );
  // Out of shape, the step applies to the core pieces that are wrong; it may leave the
  // rest anywhere, so they are the darker gray. Those that move get plain paths. Their
  // stickers are often covered by neighbors that are about to move, so a path may graze
  // the puzzle near its ends, or pass behind it, faintly drawn: staying in view comes first.
  await startFresh();
  await play("R U");
  await next();
  const shape = await probe("guide");
  check(shape?.stage === "shape" && shape.focus.length > 0 && shape.darkGray > 0 && shape.otherNoGlow > 0 && shape.otherGlow === 0 && shape.focusGlow > 0 && shape.arrows > 0 && shape.paths.every((t) => !/ (lands|dashed)/.test(t)) && shape.pathsOut < 0.45 && shape.after > 0, `a shape step darkens the pieces it may leave anywhere, only the pieces it applies to glow, and those that move have plain paths (${JSON.stringify(shape)})`);
  // Playing the step and asking again carries the count on: step 2 of the same total, in its own box.
  const total = shape.after + 1;
  await page.click("#last");
  await settle();
  await next();
  const second = await probe("guide");
  const boxes = await page.$$eval("#history .step-box", (els) => els.map((e) => e.classList.contains("on")).join());
  check(second?.index === 2 && second.index + second.after === total && new RegExp(`^Step 2 of ${total} — `).test(await line()) && boxes === "false,true", `the next step after a played one is step 2 of the same ${total}, boxed after the first ("${await line()}", boxes ${boxes})`);
  // In the turn list a cycle step's setup turns, and their undoing, are marked.
  const marks = await page.$$eval("#history .step-box.on .tok", (els) => els.map((e) => (e.className.match(/part-(\w+)/) ?? [])[1]).join());
  const want = /\[(.+):/.exec(second.alg) ? /^(regrip,)*(setup,)+(cycle,){8}(undo,?)+$/ : /^(regrip,)*(cycle,?){8}$/;
  check((["corners", "edges"].includes(second.stage) ? want : /^(regrip,)*(turns,?)+$/).test(marks), `the step's turns are marked by part (${second.alg}: ${marks})`);
  // Stop drops the step's grays and line, and leaves the turn list and its boxes alone.
  // Next step starts again from the position shown, counting on. Going to another panel and
  // back keeps the step.
  const before = await turnList();
  await page.click("#guide-stop");
  const stopped = { g: await probe("guide"), line: await line(), list: await turnList(), off: await page.$eval("#guide-stop", (b) => b.disabled) };
  await next();
  const again = await probe("guide");
  await page.click(`[data-tab="turn"]`);
  await page.click(`[data-tab="solve"]`);
  await settle();
  const kept = await probe("guide");
  check(stopped.g === null && stopped.line === "" && stopped.list === before && stopped.off && again?.index === 2 && again.alg === second.alg && kept?.index === 2, `Stop ends the guide without touching the turn list; Next step starts it again; another panel and back keeps it (${JSON.stringify({ stopped: stopped.g, again: again?.index, kept: kept?.index })})`);
  // Editing a turn before a step changes the position it starts from, so the step no
  // longer applies, though its own turns are still in the list.
  await startFresh();
  await play("R U");
  await next();
  const listed = await turnList();
  await page.click("#alg-edit");
  await page.fill("#alg", listed.replace(/^R /, "R2 "));
  await page.click("#load");
  await settle();
  check(listed.startsWith("R U ") && (await probe("guide")) === null && (await line()) === "" && (await page.$$("#history .step-box")).length === 0, "editing a turn before the step drops the step and its box");
});

labTest("guide: a regrip is a step of its own, and the step after it is as the puzzle is then held", async ({ page, check, probe, settle }) => {
  const { line, next } = guideHelpers(page, settle);
  // Shape and core done; the first corners to cycle are on the bottom, so the solve turns the puzzle over first.
  await page.evaluate(() => (document.querySelector("details.code-box").open = true));
  await page.click("#code");
  await page.fill("#code", "GAQB MAQZ OPMU ADTJ BUGX BTTM REMC BKDW RYUV XEPY LUSB");
  await page.click("#import");
  await settle();
  await next();
  const flip = await probe("guide");
  const showOff = await page.$eval("#guide-show", (b) => b.disabled);
  check(
    flip?.stage === "regrip" && flip.alg === "x2" && flip.gray === 0 && flip.darkGray === 0 && flip.arrows === 0 && showOff && /^Step 1 of \d+ — Regrip: Flip the puzzle over, so yellow is up\. Nothing else moves\. Turns: x2$/.test(await line()),
    `turning the puzzle over is a step of its own, which grays nothing and has nothing to show (${JSON.stringify(flip)}; "${await line()}")`,
  );
  await page.click("#last");
  await settle();
  await next();
  const after = await probe("guide");
  check(after?.stage === "corners" && after.index === 2 && !/[xyz]/.test(after.alg) && after.arrows > 0, `the step after it turns no whole puzzle (${after?.stage}: ${after?.alg})`);
});

labTest("guide: dashed paths, the order switch, a layered core step, and a turn by hand", async ({ page, check, probe, settle, play, status, counter, sweep3d, startFresh, turnList }) => {
  const { line, next } = guideHelpers(page, settle);
  // A piece only passing through has a dashed path, in several pieces, and no ring.
  await play("(F' L' F) r (F' L F) r' f (F' L' F) r (F' L F) r' f'");
  await next();
  const passing = await probe("guide");
  const throughOnly = passing.paths.filter((t) => t.endsWith(" dashed")).length;
  check(passing.stage === "corners" && throughOnly === 2 && passing.pathMeshes === 8 + 2 * (2 * 9 + 4) && passing.pathsThrough === 0 && /One ends up solved\./.test(await line()), `two pieces only passing through get dashed paths (${passing.paths.join("; ")}; ${passing.pathMeshes} meshes)`);
  // The order: "Top to bottom" solves the white X-face first, so the same corner cycle is a
  // top-corners step there. The choice is kept on this device.
  await startFresh();
  await play("(F' L' F) r (F' L F) r'");
  await next();
  const byKind = (await probe("guide")).stage;
  await setOrder(page, "layers");
  await next();
  const byLayer = await probe("guide");
  const kept = await page.evaluate(() => localStorage.getItem("xcube.guideMode"));
  check(byKind === "corners" && byLayer.stage === "topCorners" && byLayer.mode === "layers" && kept === "layers" && /^Step \d+ of \d+ — White corners: For the white X-face's corners: cycle three X-face corners\. All three end up solved\./.test(await line()), `the order can be switched to top to bottom (${byKind}, then ${byLayer.stage}; "${await line()}")`);
  // Out of shape, top to bottom starts with the core, a piece at a time: a short step,
  // one or two paths, and the line counts the pieces placed.
  await startFresh();
  await play("R U F' L2");
  await next();
  const core = await probe("guide");
  check(core?.stage.startsWith("core") && core.turns <= 9 && core.arrows >= 1 && core.arrows <= 3 && /^Step \d+ of \d+ — White core edges: Put a white core edge in the top layer, white up \([1-4] of 4\)\./.test(await line()), `top to bottom places the core a piece at a time (${core?.alg}, ${core?.arrows} paths; "${await line()}")`);
  await setOrder(page, "kinds");
  await startFresh();
  await play("R U");
  await next();
  // Turning the puzzle by hand takes the step out of the turn list, and the guide goes with it.
  await page.click('[data-move="D"]');
  await settle();
  check((await probe("guide")) === null && (await line()) === "", "a turn made by hand drops the step and its grays");
});

labTest("guide: a path goes the short way around the puzzle, at an even speed", async ({ page, check, probe, settle }) => {
  // Out of shape, the first top-to-bottom step from here is R2, which takes a white core
  // edge from the bottom of the right side to its top. The spot above where its white
  // sticker will be is filled until the turn takes that piece away.
  await page.locator("summary", { hasText: "State code" }).click();
  await page.fill("#code", "QDUL LPPC IPNH GUJH BHFQ ITOS NYEX YSZU JMWD ZIHV DGEL");
  await page.click("#import");
  await settle();
  await page.click(`[data-tab="solve"]`);
  await setOrder(page, "layers");
  await page.click("#next-step");
  await settle();
  const g = await probe("guide");
  const k = g.paths.findIndex((t) => /DR\/D > UR\/U/.test(t));
  const pts = g.pathPoints[k] ?? [];
  check(g.alg === "R2" && k >= 0 && pts.length === 25 && pts.every(([x, , z]) => x > 0.9 && Math.abs(z) < 0.2) && g.pathsThrough === 0, `the path from the bottom of the right side to its top goes around the right side, through nothing but the piece the turn takes away (${g.alg}; ${g.paths.join("; ")}; ${JSON.stringify(pts)})`);
  // The flying copies' places at equal times are equally far apart (a chord across a
  // bend is a little shorter than the path), on every path; and no path leaves the view.
  const gaps = g.pathPoints.map((path) => path.slice(1).map((q, i) => Math.hypot(q[0] - path[i][0], q[1] - path[i][1], q[2] - path[i][2])));
  const uneven = Math.max(...gaps.map((d) => Math.max(...d) / Math.min(...d)));
  check(gaps.length === g.arrows && uneven < 1.35 && g.pathsOut < 0.45, `a flying copy neither lingers nor rushes (its longest stride is ${uneven.toFixed(2)} of its shortest), and leaves the view by little if at all (${g.pathsOut.toFixed(2)} out)`);
  check(sharpest(g) < 50, `no path bends sharply (${sharpest(g).toFixed(0)} degrees at most between one stride and the next)`);
  // A piece with several stickers is followed by the one that needs no bend to get
  // started: here a corner hops along the front face, and its front sticker is followed,
  // not the one on its side, whose path would have to turn back on itself.
  await page.click("#guide-stop");
  await setOrder(page, "kinds");
  for (let i = 0; i < 3; i++) {
    await page.click("#next-step");
    await settle();
    if (i < 2) (await page.click("#last"), await settle());
  }
  const c = await probe("guide");
  const hop = c.paths.find((t) => /Fx\.UR\/. > Fx\.DL\//.test(t));
  check(c.stage === "corners" && /Fx\.UR\/F > Fx\.DL\/F/.test(hop ?? "") && sharpest(c) < 50, `a corner moving across the front face is followed by its front sticker, with no hairpin (${c.alg}; ${c.paths.join("; ")}; ${sharpest(c).toFixed(0)} degrees)`);
});

labTest("guide: paths leave and arrive nearly straight out, never bow in, and copies keep a level sticker level", async ({ page, check, probe, settle }) => {
  // Top to bottom from the owner's position: the first step (R2), and later the third
  // white core corner (U R' D2 R) and a core double edge (R2 U2 L U2 R2).
  await page.locator("summary", { hasText: "State code" }).click();
  await page.fill("#code", "QDUL LPPC IPNH GUJH BHFQ ITOS NYEX YSZU JMWD ZIHV DGEL");
  await page.click("#import");
  await settle();
  await page.click(`[data-tab="solve"]`);
  await setOrder(page, "layers");
  const FACE = { R: [1, 0, 0], L: [-1, 0, 0], U: [0, 1, 0], D: [0, -1, 0], F: [0, 0, 1], B: [0, 0, -1] };
  const angle = (u, v) => (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v))))) * 180) / Math.PI;
  const sub = (a, b) => a.map((x, k) => x - b[k]);
  /** The most any path is off straight out of its sticker at its start, or straight onto its face at its end, in degrees. */
  const lean = (g) =>
    Math.max(...g.paths.map((t, i) => {
      if (/ twist$/.test(t)) return 0; // a turn in place has a stem straight out along its axis instead
      const [, f0, f1] = t.match(/\/(\w) > [\w.]+\/(\w)/);
      const pts = g.pathPoints[i];
      return Math.max(angle(sub(pts[1], pts[0]), FACE[f0]), angle(sub(pts[23], pts[24]), FACE[f1]));
    }));
  /** How far any path bows in toward the puzzle: a point nearer the center than the middle of its neighbors, away from its ends. */
  const bowIn = (g) =>
    Math.max(0, ...g.pathPoints.flatMap((pts) => pts.slice(4, -4).map((p, k) => {
      const mid = pts[k + 3].map((x, j) => (x + pts[k + 5][j]) / 2);
      return Math.hypot(...mid) - Math.hypot(...p);
    })));
  // The first seven steps that turn layers (a regrip step only turns the whole puzzle).
  const steps = [];
  for (let i = 0; i < 14 && steps.length < 7; i++) {
    await page.click("#next-step");
    await settle();
    const g = await probe("guide");
    if (g.stage !== "regrip") steps.push(g);
    await page.click("#last");
    await settle();
  }
  const first = steps[0], unit = steps[6];
  check(first.alg === "R2" && lean(first) < 47 && bowIn(first) < 0.03, `a path leaves its sticker and comes onto its face within 45 degrees of straight out (${lean(first).toFixed(0)} at most, sampled a twenty-fourth of the way in), and never bows in toward the puzzle (${bowIn(first).toFixed(3)})`);
  check(steps.every((g) => g.arrows === 0 || (lean(g) < 47 && bowIn(g) < 0.03)), `so does every path of the first seven steps (${steps.map((g) => `${g.alg}: ${g.arrows ? `${lean(g).toFixed(0)} degrees, ${bowIn(g).toFixed(3)} in` : "no paths"}`).join("; ")})`);
  // A core double edge has no sticker: it and the two extension pieces against it move
  // as one unit, on one neutral path, and all three keep their colors.
  // One corner cycle from solved: a white X-face corner hops along the top, white up at
  // both ends, and its flying copy keeps white up all the way.
  await page.click("#guide-stop");
  await resetToSolved(page);
  await settle();
  await setOrder(page, "kinds");
  await page.fill("#alg", "(F' L' F) r (F' L F) r'");
  await page.click("#load");
  await page.click("#last");
  await settle();
  await page.click("#next-step");
  await settle();
  const cycle = await probe("guide");
  const level = cycle.paths.findIndex((t) => /^W [\w.]+\/U > [\w.]+\/U/.test(t));
  const facing = cycle.runnerFacing[level] ?? [];
  check(cycle.stage === "corners" && level >= 0 && facing.length === 13 && facing.every((v) => angle(v, FACE.U) < 3) && lean(cycle) < 47, `a flying copy whose sticker faces up at both ends keeps it facing up all the way (${cycle.alg}; ${cycle.paths.join("; ")}; ${JSON.stringify(facing)})`);
  check(unit.stage === "coreMiddle" && unit.arrows >= 1 && unit.paths.every((t) => /^null /.test(t)) && unit.focus.length >= 3 * unit.arrows && unit.runners === unit.arrows, `each core double edge moves as a unit with the pieces against it, on a neutral path (${unit.alg}; ${unit.paths.join("; ")}; focus ${unit.focus.join(" ")})`);
});

labTest("guide: a flying piece turns only about the axis its sticker turns about", async ({ page, check, probe, settle }) => {
  // The owner's position: Top to bottom's next step is R', which carries the white core
  // single edge at BR (white facing back) to UR. Everything facing right keeps facing
  // right, so the white sticker, turning from back to up, must stay square to the right
  // all the way, rather than lean out toward it with the path.
  await page.locator("summary", { hasText: "State code" }).click();
  await page.fill("#code", "KLSM RMQS NGSD YZPP ELND KEFV WOPY KHDX CARB ZUAG LCMZ");
  await page.click("#import");
  await settle();
  await page.click(`[data-tab="solve"]`);
  await setOrder(page, "layers");
  await page.click("#next-step");
  await settle();
  const g = await probe("guide");
  const unit = g.paths.findIndex((t) => /^W BR\/B > UR\/U/.test(t));
  const facing = g.runnerFacing[unit] ?? [];
  check(g.alg === "R'" && unit >= 0 && facing.length === 13 && facing.every((v) => Math.abs(v[0]) < 0.03), `the edge turns only about the right's axis (${g.paths.join("; ")}; ${JSON.stringify(facing)})`);
});

labTest("guide: a piece turning in place has a disc, and its unit rises past it, turns, and drops back", async ({ page, check, probe, settle }) => {
  // Top to bottom's next step here turns one white core corner a third of a turn in place,
  // with its two extension pieces.
  await page.locator("summary", { hasText: "State code" }).click();
  await page.fill("#code", "MKCT OOXD PDQK ZTIX BSRG LFFL MBXH TUNQ CCAY TMCT GMUR");
  await page.click("#import");
  await settle();
  await page.click(`[data-tab="solve"]`);
  await setOrder(page, "layers");
  await page.click("#next-step");
  await settle();
  const g = await probe("guide");
  const tw = g.twists[0];
  check(g.stage === "coreTopC" && g.twists.length === 1 && g.paths.some((t) => new RegExp(`^W ${tw.slot}/\\w > ${tw.slot}/\\w twist$`).test(t)), `the corner turning in place gets a twist, not a path (${g.alg}: ${g.paths.join("; ")})`);
  check(Math.abs(tw.angle) === 120 && Math.sign(tw.half) === Math.sign(tw.angle) && Math.abs(Math.abs(tw.half) - 60) < 3, `the disc shows a third of a turn, and the flying piece turns the same way (${tw.angle}, halfway ${tw.half})`);
  check(g.units.every((n) => n === 3), `every core corner of the step flies with its two extension pieces (${g.units.join(" ")})`);
  check(g.flyersLit, "the flying pieces are made and lit like the puzzle's own, with shadows");
  // Out, hold past the disc while turning, back; each part eased, so the rise comes to rest at the disc.
  const lift = tw.lift, top = Math.max(...lift);
  const rise = lift.slice(0, 8), fall = lift.slice(17);
  check(lift[0] === 0 && lift[24] === 0 && top > 1 && lift.slice(8, 17).every((v) => v === top), `the unit rises along the stem to past the disc, stays there, and drops back (${lift.join(" ")})`);
  check(rise.every((v, k) => k === 0 || v >= rise[k - 1]) && fall.every((v, k) => k === 0 || v <= fall[k - 1]) && top - lift[7] < 0.06 * top && lift[1] < 0.06 * top, `it eases into and out of the spot past the disc, as at the start and end (${lift.join(" ")})`);
});

labTest("guide: only the pieces a step moves or turns keep their colors", async ({ page, check, probe, settle }) => {
  // The owner's position: Top to bottom's next step (R' D2 R) moves the white core corners
  // at DBL and DFL, each with its two extension pieces. The white core corners at UBL and
  // UFL are not yet white up either, but the step leaves them as they are: light gray.
  await page.locator("summary", { hasText: "State code" }).click();
  await page.fill("#code", "JOJT HKNW MEZE HNZG NDXA YKTH CBNN CGVJ JLAC BAPV SSXJ");
  await page.click("#import");
  await settle();
  await page.click(`[data-tab="solve"]`);
  await setOrder(page, "layers");
  await page.click("#next-step");
  await settle();
  const g = await probe("guide");
  check(g.alg === "R' D2 R" && g.focus.length === 6 && ["DBL", "DFL"].every((s) => g.focus.includes(s)) && !g.focus.some((s) => ["UBL", "UFL"].includes(s)), `only the moved corners and their extension pieces keep their colors (${g.focus.join(" ")})`);
  check(g.darkGray > 0 && g.gray > 0, `what else the turns move is darker gray, and what they leave alone lighter (${g.darkGray} darker, ${g.gray} lighter)`);
});

labTest("guide: Full color grays nothing and gives every piece its glow back, and is kept", async ({ page, check, probe, settle, play }) => {
  await play("R U R' U'");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  // Past any regrip, to a step that grays pieces.
  for (let i = 0; i < 6 && !(await probe("guide")).gray; i++) {
    await page.click("#guide-start");
    await page.waitForFunction(() => !document.getElementById("next-step").disabled, null, { timeout: 60000 });
    await page.click("#next-step");
    await settle();
  }
  const gray = await probe("guide");
  check(!gray.fullColor && gray.gray + gray.darkGray > 0 && gray.otherNoGlow > 0, `to begin with the step grays pieces and takes their glow (${gray.gray} + ${gray.darkGray} gray, ${gray.otherNoGlow} bands off)`);
  await page.click("#guide-colors");
  await settle();
  const full = await probe("guide");
  const pressed = await page.$eval("#guide-colors", (b) => b.getAttribute("aria-pressed") === "true" && b.classList.contains("sel"));
  check(full.fullColor && pressed && full.gray + full.darkGray === 0 && full.otherNoGlow === 0, `Full color: nothing is gray and no glow is off (${full.gray} + ${full.darkGray} gray, ${full.otherNoGlow} bands off)`);
  check(full.arrows === gray.arrows && full.arrows > 0, `the paths stay (${full.arrows} of ${gray.arrows})`);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check(fits, "the page is no wider than the screen");
  await page.reload();
  await page.waitForFunction(() => window.xcubeProbe);
  check(await page.$eval("#guide-colors", (b) => b.classList.contains("sel")), "the choice is kept on the device");
  // The switch shows only during a solve.
  await play("R U");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  await page.click("#guide-colors");
  check(!(await page.$eval("#guide-colors", (b) => b.classList.contains("sel"))), "a second tap turns it off");
});

labTest("lost: the interview finds a slip from a few answers, and Yes loads a step that undoes it", async ({ page, check, probe, settle, play }) => {
  await play("R U R' F");
  await page.click(`[data-tab="solve"]`);
  // Two steps, the second loaded and not played: as if followed on a puzzle in hand.
  await page.click("#next-step");
  await settle();
  await page.click("#guide-start");
  await page.waitForFunction(() => !document.getElementById("next-step").disabled, null, { timeout: 60000 });
  await page.click("#next-step");
  await settle();
  const before = { guide: await probe("guide"), lostOn: await page.$eval("#lost", (b) => !b.disabled) };
  check(before.lostOn && before.guide?.index === 2, `Lost? is there during a solve (step ${before.guide?.index})`);
  await page.click("#lost");
  await settle();
  const last = await probe("lost");
  const stepTurns = (await probe("guide")).turns;
  if (stepTurns > 1) {
    check(last.phase === "last" && last.answers.length === stepTurns && last.gray > 0 && /Which turn of step 2 did you make last\?/.test(last.text), `it first asks which turn of the step was made last, one button a turn (${JSON.stringify(last)})`);
    await page.click(`#lost-opts [data-lost="${last.answers[last.answers.length - 1]}"]`);
    await settle();
  } else check(last.phase === "up", `with a step of one turn, there is no asking which was last (${last.phase})`);
  const up = await probe("lost");
  check(up.phase === "up" && up.answers.length === 6 && up.gray > 0, `then which center is on top, with the puzzle shown gray (${JSON.stringify(up)})`);
  const inert = await page.evaluate(() => ["dock", "tabs", "panel-start", "panel-turn", "panel-algs", "undo"].every((id) => document.getElementById(id).inert));
  check(inert, "the turn list, the tabs, the other panels and Undo are set aside");
  const turnedBefore = await probe("debugInfo");
  // Inert stops a tap; a handler reached another way (a key, a script) must do nothing too.
  await page.evaluate(() => document.getElementById("undo").click());
  await settle();
  check(JSON.parse(await probe("debugInfo")).current === JSON.parse(turnedBefore).current, "Undo doesn't turn the puzzle shown while Lost? asks");
  // The person's puzzle: one of the slips (not the right result).
  const slip = await probe("lostPick", Math.max(1, Math.floor(up.answers.length / 2)));
  check(slip && slip !== "none", `a slipped puzzle is picked (${slip})`);
  let asked = 0;
  for (let k = 0; k < 12; k++) {
    const l = await probe("lost");
    if (l.phase === "confirm") break;
    if (l.phase === "ask") {
      if (l.question.endsWith("?")) check(/Is there a piece here\?/.test(l.text) && l.marked, `a question about a spot asks about "here", marked by the box (${l.text})`);
      asked++;
      check(l.marked, `question ${asked} marks its spot (${l.question})`);
    }
    const a = await probe("lostAnswer");
    await page.click(`#lost-opts [data-lost="${a}"]`);
    await settle();
  }
  const found = await probe("lost");
  check(found.phase === "confirm" && found.gray === 0 && !found.marked && (await probe("lostAnswer")) === "yes", `after ${asked} questions it shows the puzzle found, in color (${JSON.stringify(found)})`);
  await page.click(`#lost-opts [data-lost="yes"]`);
  await settle();
  const g = await probe("guide");
  check(!(await probe("lost")) && g.stage === "recover" && g.turns > 0 && g.gray === 0, `Yes loads a step that undoes the turns made (${g.stage}, ${g.turns} turns, ${g.alg})`);
  const notInert = await page.evaluate(() => !document.getElementById("dock").inert && !document.getElementById("tabs").inert);
  check(notInert, "the turn list and the tabs are back");
  await page.click("#guide-start");
  await page.waitForFunction(() => !document.getElementById("next-step").disabled, null, { timeout: 60000 });
  await page.click("#next-step");
  await settle();
  const again = await probe("guide");
  check(again.index === 1 && again.stage !== "recover", `once undone, Next step gives the first step again (step ${again.index}, ${again.stage})`);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check(fits, "the page is no wider than the screen");
});

labTest("lost: giving up says so, and Edit puzzle opens Edit puzzle in full color with the solve kept", async ({ page, check, probe, settle }) => {
  // A play-tester's solve, restored from debug info, then a sticker with a color no way gives.
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","base":"ZWWP GERE AWYC PYYQ PAJE XPAA NMEY ZLPZ PRKV ICYH NWOJ","turns":"U' D R U2 F L B R U' L2 U2 L2 U R2 U x2 l U l' F R F' l F R' F' U' l' y r' U' F' L' F r F' L F r' U r x2 r' U' F' L' F r F' L F r' U r l U l' F R F' l F R' F' U' l'","cursor":66,"current":"RGDF GHXZ IFKR BYGR HSGS CZWX UPAH UNSQ ZCXN SOYI NNXI","view":[0.23561,-0.29558,-0.07547,0.92273],"solving":true,"order":"kinds","steps":[{"index":1,"stage":"shape","start":0,"alg":"U' D R U2 F L B R","shown":false},{"index":2,"stage":"core","start":8,"alg":"U' L2 U2 L2 U R2","shown":false},{"index":3,"stage":"parity","start":14,"alg":"U","shown":false},{"index":4,"stage":"regrip","start":15,"alg":"x2","shown":false},{"index":5,"stage":"corners","start":16,"alg":"[l U: l' (F R F') l (F R' F')]","shown":false},{"index":6,"stage":"regrip","start":28,"alg":"y","shown":false},{"index":7,"stage":"corners","start":29,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":8,"stage":"regrip","start":41,"alg":"x2","shown":false},{"index":9,"stage":"corners","start":42,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":10,"stage":"corners","start":54,"alg":"[l U: l' (F R F') l (F R' F')]","shown":true}],"edit":null}));
  await page.waitForFunction(() => JSON.parse(window.xcubeProbe.debugInfo()).steps.length === 10, null, { timeout: 20000 });
  await page.click(`[data-tab="solve"]`);
  await settle();
  await page.click("#lost");
  await settle();
  const first = await probe("lost");
  check(first.phase === "last" && /Which turn of step 10 did you make last\?/.test(first.text) && first.answers.length === 12, `it first asks which turn of step 10 was made last (${JSON.stringify(first)})`);
  await probe("lostPick", 1);
  for (let k = 0; k < 10 && !(await probe("lost")).answers.includes("none"); k++) {
    await page.click(`#lost-opts [data-lost="${await probe("lostAnswer")}"]`);
    await settle();
  }
  const asking = await probe("lost");
  const extension = /^[UDFBLR]x/.test(asking.question);
  check(asking.phase === "ask" && asking.answers.includes("none") && asking.answers.includes("empty") === extension, `a color question offers None of these, and No piece here only at an extension spot, which can be empty (${asking.question}: ${asking.answers})`);
  check(asking.known >= 2, `the two centers told, and the stickers answered, show in their colors (${asking.known} stickers known)`);
  await page.click(`#lost-opts [data-lost="none"]`);
  await settle();
  const gave = await probe("lost");
  check(gave.phase === "giveup" && /^I can't find how your puzzle got this way/.test(gave.text) && gave.answers.join() === "color", `it says plainly that it gave up, and offers Edit puzzle (${JSON.stringify(gave)})`);
  await page.click(`#lost-opts [data-lost="color"]`);
  await settle();
  const confirm = !(await page.$eval("#confirm", (e) => e.hidden));
  const gray = await page.evaluate(() => window.xcubeProbe.grayStickers());
  const info = JSON.parse(await probe("debugInfo"));
  const done = await page.$eval("#edit-done", (b) => b.textContent);
  const cancelLabel = await page.$eval("#edit-cancel", (b) => b.textContent);
  check(cancelLabel === "Cancel edit", `its Cancel reads Cancel edit (${cancelLabel})`);
  check(!!(await probe("shapeEdit")) && gray === 0 && !confirm && info.solving && (await probe("lostEdit")) && done === "Continue search", `Edit puzzle opens in full color, without ending the solve, its Done reading Continue search (${JSON.stringify({ gray, confirm, solving: info.solving, done })})`);
  await page.click("#edit-cancel");
  await settle();
  const back = JSON.parse(await probe("debugInfo"));
  const label = await page.$eval("#edit-done", (b) => b.textContent);
  check(back.solving && back.steps.length === 10 && back.cursor === 66 && !(await probe("lostEdit")) && label === "Done", `Cancel puts the solve back as it was (${back.steps.length} steps, at ${back.cursor}; the editor's button reads ${label} again)`);
});

labTest("lost: after Edit puzzle, Continue search finds the slip from the puzzle edited and carries on with the solve", async ({ page, check, probe, settle, play }) => {
  await play("R U R' F");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  await page.click("#guide-start");
  await page.waitForFunction(() => !document.getElementById("next-step").disabled, null, { timeout: 60000 });
  await page.click("#next-step");
  await settle();
  await page.click("#lost");
  await settle();
  const slip = await probe("lostPick", 2);
  // Answers that lead to the person's puzzle, then No: so Edit puzzle opens on it, as if edited to match.
  for (let k = 0; k < 14; k++) {
    const l = await probe("lost");
    if (l.phase === "confirm") break;
    await page.click(`#lost-opts [data-lost="${await probe("lostAnswer")}"]`);
    await settle();
  }
  await page.click(`#lost-opts [data-lost="no"]`);
  await settle();
  check((await probe("lost"))?.phase === "giveup", "No gives up, saying so");
  await page.click(`#lost-opts [data-lost="color"]`);
  await settle();
  await page.click("#edit-done");
  await settle();
  const g = await probe("guide");
  const info = JSON.parse(await probe("debugInfo"));
  check(info.solving && !(await probe("lostEdit")) && g?.stage === "recover" && g.turns > 0, `Done finds the slip (${slip}) and loads a step back on track, in the same solve (${JSON.stringify({ stage: g?.stage, solving: info.solving, steps: info.steps.length })})`);
});

labTest("lost: Lost? asked while End the solve? waits takes that question away", async ({ page, check, probe, settle, play }) => {
  // A question left open ("End the solve in progress?", here from Reset), then Lost?: the
  // question goes, or answering it later would start something under the interview.
  await play("R U");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  await page.evaluate(() => document.getElementById("reset").click());
  const asked = !(await page.$eval("#confirm", (e) => e.hidden));
  await page.click("#lost");
  await settle();
  const state = { confirm: !(await page.$eval("#confirm", (e) => e.hidden)), lost: !!(await probe("lost")) };
  check(asked && !state.confirm && state.lost, `the old question goes away when Lost? starts (${JSON.stringify({ asked, ...state })})`);
});

labTest("lost: a puzzle stopped partway through a step, with no slip, carries on from the turn made last", async ({ page, check, probe, settle }) => {
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","base":"ZWWP GERE AWYC PYYQ PAJE XPAA NMEY ZLPZ PRKV ICYH NWOJ","turns":"U' D R U2 F L B R U' L2 U2 L2 U R2 U x2 l U l' F R F' l F R' F' U' l' y r' U' F' L' F r F' L F r' U r x2 r' U' F' L' F r F' L F r' U r l U l' F R F' l F R' F' U' l'","cursor":66,"current":"RGDF GHXZ IFKR BYGR HSGS CZWX UPAH UNSQ ZCXN SOYI NNXI","view":[0.23561,-0.29558,-0.07547,0.92273],"solving":true,"order":"kinds","steps":[{"index":1,"stage":"shape","start":0,"alg":"U' D R U2 F L B R","shown":false},{"index":2,"stage":"core","start":8,"alg":"U' L2 U2 L2 U R2","shown":false},{"index":3,"stage":"parity","start":14,"alg":"U","shown":false},{"index":4,"stage":"regrip","start":15,"alg":"x2","shown":false},{"index":5,"stage":"corners","start":16,"alg":"[l U: l' (F R F') l (F R' F')]","shown":false},{"index":6,"stage":"regrip","start":28,"alg":"y","shown":false},{"index":7,"stage":"corners","start":29,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":8,"stage":"regrip","start":41,"alg":"x2","shown":false},{"index":9,"stage":"corners","start":42,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":10,"stage":"corners","start":54,"alg":"[l U: l' (F R F') l (F R' F')]","shown":true}],"edit":null}));
  await page.waitForFunction(() => JSON.parse(window.xcubeProbe.debugInfo()).steps.length === 10, null, { timeout: 20000 });
  await page.click(`[data-tab="solve"]`);
  await settle();
  await page.click("#lost");
  await settle();
  const turns = (await probe("lost")).answers;
  // Step 10 starts at turn 54: the person made its first six turns.
  await page.click(`#lost-opts [data-lost="${turns[5]}"]`);
  await settle();
  await probe("lostPick", 0);
  for (let k = 0; k < 14 && (await probe("lost"))?.phase !== "confirm"; k++) {
    await page.click(`#lost-opts [data-lost="${await probe("lostAnswer")}"]`);
    await settle();
  }
  const found = await probe("lost");
  check(found?.phase === "confirm" && /turn 6 of step 10/.test(found.text), `it finds the puzzle where turn 6 of step 10 leaves it (${found?.text})`);
  await page.click(`#lost-opts [data-lost="yes"]`);
  await settle();
  const info = JSON.parse(await probe("debugInfo"));
  check(info.cursor === 60 && info.steps.length === 10 && info.solving, `Yes goes to that turn in the turn list, with the steps kept (${JSON.stringify({ cursor: info.cursor, steps: info.steps.length })})`);
});

labTest("lost: debug info saved during Lost? puts back the solve and the interview where they were", async ({ page, check, probe, settle }) => {
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","base":"ZWWP GERE AWYC PYYQ PAJE XPAA NMEY ZLPZ PRKV ICYH NWOJ","turns":"U' D R U2 F L B R U' L2 U2 L2 U R2 U x2 l U l' F R F' l F R' F' U' l' y r' U' F' L' F r F' L F r' U r x2 r' U' F' L' F r F' L F r' U r l U l' F R F' l F R' F' U' l'","cursor":66,"current":"RGDF GHXZ IFKR BYGR HSGS CZWX UPAH UNSQ ZCXN SOYI NNXI","view":[0.23561,-0.29558,-0.07547,0.92273],"solving":true,"order":"kinds","steps":[{"index":1,"stage":"shape","start":0,"alg":"U' D R U2 F L B R","shown":false},{"index":2,"stage":"core","start":8,"alg":"U' L2 U2 L2 U R2","shown":false},{"index":3,"stage":"parity","start":14,"alg":"U","shown":false},{"index":4,"stage":"regrip","start":15,"alg":"x2","shown":false},{"index":5,"stage":"corners","start":16,"alg":"[l U: l' (F R F') l (F R' F')]","shown":false},{"index":6,"stage":"regrip","start":28,"alg":"y","shown":false},{"index":7,"stage":"corners","start":29,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":8,"stage":"regrip","start":41,"alg":"x2","shown":false},{"index":9,"stage":"corners","start":42,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":10,"stage":"corners","start":54,"alg":"[l U: l' (F R F') l (F R' F')]","shown":true}],"edit":null}));
  await page.waitForFunction(() => JSON.parse(window.xcubeProbe.debugInfo()).steps.length === 10, null, { timeout: 20000 });
  await page.click(`[data-tab="solve"]`);
  await settle();
  await page.click("#lost");
  await settle();
  await probe("lostPick", 3);
  for (let k = 0; k < 5; k++) {
    await page.click(`#lost-opts [data-lost="${await probe("lostAnswer")}"]`);
    await settle();
  }
  const before = await probe("lost");
  const saved = await probe("debugInfo");
  await page.click(`#lost-box [data-lost="cancel"]`);
  await settle();
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), saved);
  await page.waitForFunction(() => !!window.xcubeProbe.lost(), null, { timeout: 30000 });
  await settle();
  const after = await probe("lost");
  const info = JSON.parse(await probe("debugInfo"));
  check(after.phase === before.phase && after.question === before.question && after.cands === before.cands && after.known === before.known && after.text === before.text, `the interview is back at the same question, with what was told (${JSON.stringify({ before, after })})`);
  check(info.solving && info.steps.length === 10 && info.lost.answers.length === 5, `the solve's 10 steps and the 5 answers are back (${info.steps.length} steps, ${info.lost?.answers.length} answers)`);

  // Saved again from Lost?'s Edit puzzle: the editor, its changes and Continue search come back over the solve.
  await page.click(`#lost-opts [data-lost="none"]`);
  await settle();
  await page.click(`#lost-opts [data-lost="color"]`);
  await settle();
  await page.click(`[data-paint="Y"]`);
  const editSaved = await probe("debugInfo");
  await page.click("#edit-cancel");
  await settle();
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), editSaved);
  await page.waitForFunction(() => window.xcubeProbe.lostEdit(), null, { timeout: 30000 });
  await settle();
  const e = { done: await page.$eval("#edit-done", (b) => b.textContent), cancel: await page.$eval("#edit-cancel", (b) => b.textContent), info: JSON.parse(await probe("debugInfo")) };
  check(e.done === "Continue search" && e.cancel === "Cancel edit" && e.info.solving && e.info.steps.length === 10 && e.info.edit && e.info.edit.tool === JSON.parse(editSaved).edit.tool, `Edit puzzle from Lost? is back over the solve, with Continue search (${JSON.stringify({ done: e.done, cancel: e.cancel, solving: e.info.solving, steps: e.info.steps.length, tool: e.info.edit?.tool })})`);
  await page.click("#edit-cancel");
  await settle();
  const back = JSON.parse(await probe("debugInfo"));
  check(back.solving && back.steps.length === 10 && back.cursor === 66 && !back.lost, `Cancel edit then puts the solve back as it was before Lost? (${back.steps.length} steps, at ${back.cursor})`);
});

/** Lost? on a one-turn step from solved followed by r (the solve's first step is that r), as if its turn went as candidate i (0 no slip, 1 r2, 3 left out), then Yes. */
async function lostOnOneTurn(page, probe, settle, play, i) {
  await play("r");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  await page.click("#lost");
  await settle();
  const slip = await probe("lostPick", i);
  for (let k = 0; k < 14 && (await probe("lost"))?.phase !== "confirm"; k++) {
    await page.click(`#lost-opts [data-lost="${await probe("lostAnswer")}"]`);
    await settle();
  }
  await page.click(`#lost-opts [data-lost="yes"]`);
  await settle();
  return slip;
}

labTest("lost: a step left out entirely loads no empty Back on track step, and Next step gives it again", async ({ page, check, probe, settle, play }) => {
  const slip = await lostOnOneTurn(page, probe, settle, play, 3);
  const after = JSON.parse(await probe("debugInfo"));
  check(slip === "skipped" && after.steps.every((s) => s.alg !== ""), `nothing to undo leaves no empty step (${slip}; ${JSON.stringify(after.steps)})`);
  await guideHelpers(page, settle).next();
  const alive = await Promise.race([page.evaluate(() => JSON.parse(window.xcubeProbe.debugInfo()).steps.length), new Promise((r) => setTimeout(() => r(-1), 10000))]);
  check(alive >= 1, `Next step then gives the step again, and the page answers (${alive} steps)`);
});

labTest("lost: debug info saved during Lost? after a Back on track step puts the interview back", async ({ page, check, probe, settle, play }) => {
  const slip = await lostOnOneTurn(page, probe, settle, play, 1);
  const g = await probe("guide");
  check(slip === "amount" && g?.stage === "recover", `the first Lost? loads a Back on track step (${slip}, ${g?.stage})`);
  await page.click("#lost");
  await settle();
  const before = await probe("lost");
  const saved = await probe("debugInfo");
  await page.click(`#lost-box [data-lost="cancel"]`);
  await settle();
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), saved);
  const back = await page.waitForFunction(() => !!window.xcubeProbe.lost(), null, { timeout: 30000 }).then(() => true, () => false);
  const after = await probe("lost");
  check(back && after?.phase === before.phase && after?.cands === before.cands, `Lost? asked from the Back on track step comes back from debug info (${JSON.stringify({ before, after })})`);
});

labTest("lost: Undo can't turn the puzzle under Edit puzzle, the ordinary one or Lost?'s", async ({ page, check, probe, settle, play }) => {
  await play("R");
  const before = JSON.parse(await probe("debugInfo")).current;
  await page.evaluate(() => document.getElementById("edit-start").click());
  await settle();
  const inert = await page.evaluate(() => document.getElementById("undo").inert);
  await page.evaluate(() => document.getElementById("undo").click());
  await settle();
  const after = JSON.parse(await probe("debugInfo"));
  check(inert && after.current === before && after.edit?.shape === before, `Undo is set aside and does nothing while editing (${JSON.stringify({ inert, same: after.current === before, shape: after.edit?.shape === before })})`);
  await page.click("#edit-cancel");
  await settle();
  check(!(await page.evaluate(() => document.getElementById("undo").inert)), "Undo is back once the editor closes");
});

labTest("session: after a reload the Lab offers to pick up where it left off, solve and all", async ({ page, check, probe, settle, play }) => {
  await play("R U R' F");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  const before = JSON.parse(await probe("debugInfo"));
  // Saved a moment after things settle; time how long building and keeping the dump takes.
  const ms = await page.evaluate(() => {
    const t = performance.now();
    for (let i = 0; i < 20; i++) window.xcubeProbe.saveSession();
    return (performance.now() - t) / 20;
  });
  check(ms < 8, `saving the restart dump takes ${ms.toFixed(2)} ms`);
  await page.waitForTimeout(1800);
  await page.reload();
  await page.waitForFunction(() => window.xcubeProbe?.idle(), null, { timeout: 60000 });
  const offer = await page.evaluate(() => ({ shown: !document.getElementById("resume").hidden, what: document.getElementById("resume-what").textContent }));
  check(offer.shown && /^Solving, step 1 · /.test(offer.what), `after the reload it offers to pick up (${JSON.stringify(offer)})`);
  await page.click("#resume-yes");
  await page.waitForFunction(() => JSON.parse(window.xcubeProbe.debugInfo()).steps.length === 1, null, { timeout: 30000 });
  await settle();
  const after = JSON.parse(await probe("debugInfo"));
  check(after.solving && after.turns === before.turns && after.cursor === before.cursor && JSON.stringify(after.steps) === JSON.stringify(before.steps), `Pick up puts back the turns and the solve (${after.steps.length} step, at ${after.cursor})`);
  // Start fresh drops it: the next reload offers nothing until something worth keeping happens again.
  await page.evaluate(() => document.getElementById("reset").click());
  await page.evaluate(() => document.getElementById("confirm-yes")?.click());
  await settle();
  await page.waitForTimeout(1800);
  await page.reload();
  await page.waitForFunction(() => window.xcubeProbe?.idle(), null, { timeout: 60000 });
  check(await page.$eval("#resume", (e) => e.hidden), "with nothing worth keeping (solved, no turns), a reload offers nothing");
});

labTest("lost: a slip, then two more while putting it right, is still found (two stacked mistakes)", async ({ page, check, probe, settle }) => {
  // A play-tester's solve: a slip in step 10, found; then, following the Back on track step, two more.
  await page.evaluate((j) => window.xcubeProbe.restoreDebug(j), JSON.stringify({"lab":"x-cube debug 1","base":"ZWWP GERE AWYC PYYQ PAJE XPAA NMEY ZLPZ PRKV ICYH NWOJ","turns":"U' D R U2 F L B R U' L2 U2 L2 U R2 U x2 l U l' F R F' l F R' F' U' l' y r' U' F' L' F r F' L F r' U r x2 r' U' F' L' F r F' L F r' U r l U l' F R F' l F R' F' U' l'","cursor":66,"current":"RGDF GHXZ IFKR BYGR HSGS CZWX UPAH UNSQ ZCXN SOYI NNXI","view":[0.23561,-0.29558,-0.07547,0.92273],"solving":true,"order":"kinds","steps":[{"index":1,"stage":"shape","start":0,"alg":"U' D R U2 F L B R","shown":false},{"index":2,"stage":"core","start":8,"alg":"U' L2 U2 L2 U R2","shown":false},{"index":3,"stage":"parity","start":14,"alg":"U","shown":false},{"index":4,"stage":"regrip","start":15,"alg":"x2","shown":false},{"index":5,"stage":"corners","start":16,"alg":"[l U: l' (F R F') l (F R' F')]","shown":false},{"index":6,"stage":"regrip","start":28,"alg":"y","shown":false},{"index":7,"stage":"corners","start":29,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":8,"stage":"regrip","start":41,"alg":"x2","shown":false},{"index":9,"stage":"corners","start":42,"alg":"[r' U': (F' L' F) r (F' L F) r']","shown":false},{"index":10,"stage":"corners","start":54,"alg":"[l U: l' (F R F') l (F R' F')]","shown":true}],"edit":null}));
  await page.waitForFunction(() => JSON.parse(window.xcubeProbe.debugInfo()).steps.length === 10, null, { timeout: 20000 });
  await page.click(`[data-tab="solve"]`);
  await settle();
  const answerAll = async () => {
    for (let k = 0; k < 20 && (await probe("lost"))?.phase !== "confirm"; k++) {
      await page.click(`#lost-opts [data-lost="${await probe("lostAnswer")}"]`);
      await settle();
    }
  };
  await page.click("#lost");
  await settle();
  await probe("lostPick", 5);
  await answerAll();
  await page.click(`#lost-opts [data-lost="yes"]`);
  await settle();
  const back = await probe("guide");
  check(back?.stage === "recover" && back.turns >= 4, `the first slip is found, and a Back on track step loaded (${back?.stage}, ${back?.turns} turns)`);
  await page.click("#lost");
  await settle();
  // Back on track's fifth turn from the end made the other way, and its third from the end left out.
  const n = back.turns;
  await page.click(`#lost-opts [data-lost="${(await probe("lost")).answers.at(-1)}"]`);
  await settle();
  await probe("lostTruthTwo", n - 5, n - 3);
  await answerAll();
  const found = await probe("lost");
  check(found?.phase === "confirm" && new RegExp(`^Two turns went another way: turn ${n - 4} of step \\d+, .*, and turn ${n - 2}, `).test(found.text), `both are found and named (${found?.text})`);
  await page.click(`#lost-opts [data-lost="yes"]`);
  await settle();
  const again = await probe("guide");
  check(again?.stage === "recover" && again.turns > 0, `Yes loads a Back on track step for them (${again?.stage}, ${again?.turns} turns)`);
});

labTest("lost: Cancel puts the turn list and the step back as they were", async ({ page, check, probe, settle, play, counter }) => {
  await play("R U");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  const before = { counter: await counter(), guide: (await probe("guide")).alg };
  await page.click("#lost");
  await settle();
  await page.click(`#lost-box [data-lost="cancel"]`);
  await settle();
  const after = { counter: await counter(), guide: (await probe("guide"))?.alg, lost: await probe("lost"), gray: (await probe("guide"))?.gray };
  check(after.counter === before.counter && after.guide === before.guide && !after.lost, `Cancel restores the turn list and the step (${JSON.stringify(before)} then ${JSON.stringify(after)})`);
});

labTest("guide: the order is chosen between solves; once a step has played, Next step takes ▶'s place in the strip", async ({ page, check, settle, play, counter }) => {
  await play("R U");
  await page.click(`[data-tab="solve"]`);
  const idle = await page.evaluate(() => ({ order: !!document.querySelector(".guide-modes").getClientRects().length, btn: document.getElementById("next-step").textContent, stop: !!document.getElementById("guide-stop").getClientRects().length }));
  check(idle.order && idle.btn === "Start solving" && !idle.stop, `before a solve: the order and Start solving show, Stop doesn't (${JSON.stringify(idle)})`);
  await page.click("#next-step");
  await settle();
  const solving = await page.evaluate(() => ({ order: !!document.querySelector(".guide-modes").getClientRects().length, btn: document.getElementById("next-step").textContent, stop: !!document.getElementById("guide-stop").getClientRects().length, play: !document.getElementById("last").hidden, next: !document.getElementById("strip-next").hidden }));
  check(!solving.order && solving.btn === "Next step" && solving.stop && solving.play && !solving.next, `while solving: no order, Next step and Stop show; with turns to play, ▶ is there (${JSON.stringify(solving)})`);
  const before = await counter();
  await page.click("#last");
  await page.waitForFunction(() => !document.getElementById("strip-next").hidden, null, { timeout: 60000 });
  await settle();
  const played = { play: await page.$eval("#last", (b) => b.hidden), counter: await counter() };
  await page.click("#strip-next");
  await settle();
  const next = { g: await page.evaluate(() => window.xcubeProbe.guide()?.index), counter: await counter(), play: !(await page.$eval("#last", (b) => b.hidden)) };
  check(played.play && next.g === 2 && next.counter !== played.counter && next.play, `the step played through (${before} to ${played.counter}), Next step took ▶'s place and loaded step 2 (${next.counter}), and ▶ is back`);
  await page.click("#guide-stop");
  const stopped = await page.evaluate(() => ({ order: !!document.querySelector(".guide-modes").getClientRects().length, btn: document.getElementById("next-step").textContent, next: !document.getElementById("strip-next").hidden }));
  check(stopped.order && stopped.btn === "Start solving" && !stopped.next, `Stop ends the solve: the order and Start solving are back (${JSON.stringify(stopped)})`);
});

labTest("controls: buttons gray out when they don't apply; the turn list's ✕ asks first; a new start asks before ending a solve; the solve lists its steps", async ({ page, check, settle, counter }) => {
  const off = () => page.evaluate(() => Object.fromEntries(["first", "rewind", "back", "fwd", "last", "load", "clear", "reset", "alg-save"].map((id) => [id, document.getElementById(id).disabled])));
  const fresh = await off();
  check(Object.values(fresh).every(Boolean), `solved with no turns, every playback button, Load, Start from here, Reset and Save are grayed out (${JSON.stringify(fresh)})`);
  await page.fill("#alg", "R U");
  check(!(await page.$eval("#load", (b) => b.disabled)), "typing turns makes Load available");
  await page.click("#load");
  const loaded = await off();
  check(loaded.first && loaded.back && !loaded.fwd && !loaded.last && !loaded.clear && !loaded.reset, `at the start of two loaded turns, only the forward buttons apply (${JSON.stringify(loaded)})`);
  await page.click("#last");
  await page.waitForFunction(() => document.getElementById("counter").textContent === "2/2" && window.xcubeProbe.idle(), null, { timeout: 30000 });
  const end = await off();
  check(!end.first && !end.back && end.fwd && end.last, `at the end, only the backward buttons apply (${JSON.stringify(end)})`);
  // The ✕ at the end of the turn list: one tap asks, a second clears.
  await page.click("#list-clear");
  const armed = { text: await page.$eval("#list-clear", (b) => b.textContent), counter: await counter() };
  await page.click("#list-clear");
  check(armed.text === "Clear?" && armed.counter === "2/2" && (await counter()) === "0/0" && (await page.$eval("#list-clear", (b) => b.hidden)), `the turn list's ✕ asks "Clear?" first, then clears it (${JSON.stringify(armed)})`);
  // During a solve, Shuffle asks before ending it; Keep solving keeps it, End solve ends it.
  await page.fill("#alg", "R U");
  await page.click("#load");
  await page.click("#last");
  await page.waitForFunction(() => document.getElementById("counter").textContent === "2/2" && window.xcubeProbe.idle(), null, { timeout: 30000 });
  await page.click("#clear");
  await page.click(`[data-tab="solve"]`);
  await page.click("#next-step");
  await settle();
  const solving = await page.evaluate(() => ({ next: document.getElementById("next-step").disabled, show: document.getElementById("guide-show").disabled, head: document.getElementById("steps-head").textContent, rows: [...document.querySelectorAll("#steps-list .step-row")].map((r) => r.textContent) }));
  check(solving.next && !solving.show && /^1 \/ \d+ steps, \d+ \/ \d+ total turns$/.test(solving.head) && solving.rows.length === 1, `with a step's turns still to play, Next step is grayed out and Show step applies; the step list has it (${JSON.stringify(solving)})`);
  await page.evaluate(() => document.getElementById("shuffle").click());
  const asked = await page.$eval("#confirm", (d) => !d.hidden);
  await page.click("#confirm-no");
  const kept = await page.evaluate(() => document.getElementById("guide").classList.contains("solving"));
  await page.evaluate(() => document.getElementById("shuffle").click());
  await page.click("#confirm-yes");
  await page.waitForFunction(() => /^Shuffled/.test(document.getElementById("message")?.textContent ?? ""), null, { timeout: 60000 });
  const ended = await page.evaluate(() => document.getElementById("guide").classList.contains("solving"));
  check(asked && kept && !ended, `Shuffle during a solve asks first; Keep solving keeps it, End solve ends it and shuffles (${JSON.stringify({ asked, kept, ended })})`);
  // Two steps: the newer is listed first, with the running total.
  await page.click("#next-step");
  await settle();
  await page.click("#last");
  await page.waitForFunction(() => !document.getElementById("strip-next").hidden, null, { timeout: 60000 });
  await page.click("#strip-next");
  await settle();
  await page.waitForTimeout(400); // the older rows slide down
  const two = await page.evaluate(() => ({ head: document.getElementById("steps-head").textContent, rows: [...document.querySelectorAll("#steps-list .step-row")].map((r) => r.textContent), topGap: Math.round(document.querySelector("#steps-list .step-row").getBoundingClientRect().top - document.getElementById("steps-list").getBoundingClientRect().top) }));
  // Show step turns the view to the step, and then reads Home, which turns it back to Home.
  const showLabel = () => page.$eval("#guide-show", (b) => (b.disabled ? "off" : b.textContent));
  const showBefore = await showLabel();
  if (showBefore === "Show step") {
    await page.click("#guide-show");
    await settle();
  }
  const showAfter = await showLabel();
  if (showAfter === "Home") {
    await page.click("#guide-show");
    await settle();
  }
  const showBack = await showLabel();
  check((showAfter === "Home" && showBack === "Show step") || showAfter === "off", `once the view shows the step, Show step reads Home, and Home goes back (${JSON.stringify({ showBefore, showAfter, showBack })})`);
  // Tapping an older step slides the turn list to it (not a jump), to show where in the turns it is.
  const slide = await page.evaluate(async () => {
    const list = document.getElementById("history");
    const rows = document.querySelectorAll("#steps-list .step-row");
    const from = list.scrollLeft;
    rows[rows.length - 1].click();
    const t0 = performance.now(), seen = [], at = [];
    while (performance.now() - t0 < 800) {
      await new Promise((r) => requestAnimationFrame(r));
      seen.push(Math.round(list.scrollLeft));
      at.push(Math.round(performance.now() - t0));
    }
    return { from: Math.round(from), seen, at };
  });
  // Timed, not counted in frames: a slow runner draws only a few frames during the slide.
  const slideEnd = slide.seen[slide.seen.length - 1];
  const arrived = slide.at[slide.seen.findIndex((x) => x === slideEnd)];
  const monotone = slide.seen.every((x, i) => i === 0 || Math.sign(x - slide.seen[i - 1]) !== -Math.sign(slideEnd - slide.from));
  check(slide.from === slideEnd || (slide.seen[0] !== slideEnd && arrived >= 250 && monotone), `tapping an older step slides the turn list there (${slide.from} then ${slide.seen.map((x, i) => `${x}@${slide.at[i]}`).join(" ")})`);
  check(/^2 \/ \d+ steps, \d+ \/ \d+ total turns$/.test(two.head) && /^2\./.test(two.rows[0]) && /^1\..*✓/.test(two.rows[1]) && two.topGap < 6, `the step list shows the newest first at its top, the played one ticked, and the counts of all planned (${JSON.stringify(two)})`);
  // A step's Save… goes to Algorithms with a suggested name, selected, and Save saves that step.
  await page.click("#steps-list li:first-child .step-save");
  await page.waitForTimeout(600);
  const saving = await page.evaluate(() => {
    const f = document.getElementById("alg-name");
    return { tab: document.querySelector('#tabs [aria-selected="true"]').dataset.tab, name: f.value, focused: document.activeElement === f, selected: f.selectionStart === 0 && f.selectionEnd === f.value.length, note: !document.getElementById("alg-save-note").hidden };
  });
  check(saving.tab === "algs" && /\(step 2\)$/.test(saving.name) && saving.focused && saving.selected && saving.note, `a step's Save… opens Algorithms with its name suggested and selected (${JSON.stringify(saving)})`);
  const listed = await page.$$eval("#known-list .saved-name", (els) => els.length);
  await page.click("#alg-save");
  const after = await page.$$eval("#known-list li", (els) => els.map((e) => e.textContent));
  check(after.length === listed + 1 && after.some((t) => /\(step 2\)/.test(t) && /step of a solve/.test(t)), `Save saves the step as an algorithm (${after.length - listed} added)`);
  await page.click(`[data-tab="solve"]`);
  await page.click("#steps-list li:last-child .step-row");
  // Axis marks on x, y and z, and a Display panel no wider than its switches.
  const marks = await page.evaluate(() => ["x", "y", "z"].map((m) => getComputedStyle(document.querySelector(`[data-move="${m}"]`)).backgroundImage.slice(0, 15)));
  // The z's ink is moved to the middle of its button, where the ring is, by the font's own measures.
  const zPad = await page.$eval('[data-move="z"]', (e) => e.style.paddingBottom || e.style.paddingTop);
  check(/^[\d.]+px$/.test(zPad), `the z is raised by its font's measured offset (${zPad})`);
  check(marks[0].startsWith("linear") && marks[1].startsWith("linear") && marks[2].startsWith("radial"), `x and y have a line drawn behind them, z a ring (${marks})`);
  await page.click("#render-btn");
  const w = await page.evaluate(() => [document.getElementById("render-pop").getBoundingClientRect().width, document.querySelector(".stage").getBoundingClientRect().width]);
  check(w[0] < w[1] * 0.6, `the Display panel fits its switches (${Math.round(w[0])} of ${Math.round(w[1])} px)`);
});

labTest("guide: a parity turn has one arc around the outside of its layer", async ({ page, check, probe, settle, play }) => {
  await page.click(`[data-tab="solve"]`);
  await play("U");
  await page.click("#next-step");
  await settle();
  const g = await probe("guide");
  const pts = g.pathPoints[0] ?? [];
  // A quarter turn of the top layer: level with it (y = 1), outside its rim (the extensions
  // reach 2.5 from the axis), and a quarter of the way around.
  const around = pts.length && (Math.acos((pts[0][0] * pts[24][0] + pts[0][2] * pts[24][2]) / (Math.hypot(pts[0][0], pts[0][2]) * Math.hypot(pts[24][0], pts[24][2]))) * 180) / Math.PI;
  check(g.stage === "parity" && g.alg === "U" && g.arrows === 1 && g.runners === 0 && pts.every(([x, y, z]) => Math.abs(y - 1) < 0.01 && Math.hypot(x, z) > 2.5) && Math.abs(around - 90) < 2, `the parity turn U has one arc, level with the top layer and outside it, a quarter of the way around, and no flying copy (${g.alg}; ${g.paths.join("; ")}; ${around?.toFixed(0)} degrees; ${JSON.stringify(pts.filter((_, k) => k % 6 === 0))})`);
});

labTest("guide: dropping a step frees its paths' graphics memory", async ({ page, check, probe, settle, play }) => {
  // Each Next step builds new paths and flying copies; Stop drops them. The renderer's count
  // of geometries is back where it was each time, so using the guide doesn't pile them up.
  const { next } = guideHelpers(page, settle);
  await play("(F' L' F) r (F' L F) r'");
  const counts = [];
  for (let i = 0; i < 4; i++) {
    await next();
    await page.waitForTimeout(200); // a few frames, so the paths are drawn and their geometry uploaded
    const shown = await probe("geometries");
    await page.click("#guide-stop");
    await settle();
    counts.push([shown, await probe("geometries")]);
  }
  const after = counts.map(([, a]) => a);
  check(counts.every(([shown, a]) => shown > a) && after.every((a) => a === after[0]), `each step's paths add geometries while shown and free them when dropped (shown, then dropped: ${counts.map((c) => c.join(" > ")).join("; ")})`);
});

/** The sharpest bend, in degrees, between one stride and the next of any path's 24 strides. */
function sharpest(g) {
  let worst = 0;
  for (const path of g.pathPoints) {
    const strides = path.slice(1).map((q, i) => q.map((v, k) => v - path[i][k]));
    for (let i = 1; i < strides.length; i++) {
      const [u, v] = [strides[i - 1], strides[i]];
      const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
      worst = Math.max(worst, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
    }
  }
  return worst;
}

// ---- The standalone page, and saving on this device.

// The standalone page (published to GitHub Pages) as a phone sees it: with the phone's
// own layout rules, the viewport tag must give a 390 px wide page that draws the cube.
labTest(
  "standalone page: lays out at phone width and starts solved",
  async ({ page, check, status }) => {
    const [sw, cw, standards] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth, document.compatMode]);
    check(cw === 390 && sw <= cw && standards === "CSS1Compat", `standalone page lays out at phone width (${cw} px wide, ${sw} px of content, ${standards})`);
    check((await status()).includes("Solved"), "standalone page starts solved");
  },
  { url: standaloneUrl, context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, expand: false },
);

// Opened as a file there is no shared database, so saved states go to this device.
// A save is confirmed only when it was stored; a storage failure is reported.
const deviceSave = async (page) => {
  await page.fill("#save-name", "Test save");
  await page.click("#save");
  await page.waitForFunction(() => !document.getElementById("message")?.hidden, null, { timeout: 10000 });
  return {
    message: await page.$eval("#message", (m) => m.textContent ?? ""),
    listed: await page.$eval("#saved-list", (l) => (l.textContent ?? "").includes("Test save")),
  };
};
const onThisDevice = { context: { viewport: { width: 390, height: 900 } }, ready: () => document.getElementById("store-kind")?.textContent === "This device only" };

labTest(
  "saved states: a device save is listed and confirmed, and its Load button makes it the start",
  async ({ page, check }) => {
    const good = await deviceSave(page);
    check(good.listed && good.message.startsWith('Saved "Test save"'), `a device save is listed and confirmed ("${good.message}")`);
    let button, base;
    if (good.listed) {
      button = await page.$eval("#saved-list [data-load]", (b) => b.textContent);
      await page.click("#saved-list [data-load]");
      base = await page.$eval("#base-label", (e) => e.textContent);
    }
    check(button === "Load" && base === "Test save", `a saved position's Load button makes it the start ("${button}", start "${base}")`);
    // During a solve, Load asks first; End solve then loads it (the end re-renders the list, so not by its old button).
    let during;
    if (good.listed) {
      await page.fill("#alg", "R U");
      await page.click("#load");
      await page.click("#last");
      await page.waitForFunction(() => document.getElementById("counter").textContent === "2/2" && window.xcubeProbe.idle(), null, { timeout: 30000 });
      await page.click("#clear");
      await page.click(`[data-tab="solve"]`);
      await page.click("#next-step");
      await page.click(`[data-tab="start"]`);
      await page.click("#saved-list [data-load]");
      const asked = await page.$eval("#confirm", (d) => !d.hidden);
      await page.click("#confirm-yes");
      during = { asked, base: await page.$eval("#base-label", (e) => e.textContent), solving: await page.evaluate(() => document.getElementById("guide").classList.contains("solving")) };
    }
    check(during?.asked && during.base === "Test save" && !during.solving, `during a solve, Load asks first, and End solve ends it and loads the position (${JSON.stringify(during)})`);
  },
  onThisDevice,
);

labTest(
  "saved states: a failed device save is reported, not listed",
  async ({ page, check }) => {
    const full = await deviceSave(page);
    check(!full.listed && full.message.startsWith("Could not save"), `a failed device save is reported, not listed ("${full.message}")`);
  },
  {
    ...onThisDevice,
    initScript: () => {
      Storage.prototype.setItem = () => {
        throw new DOMException("full", "QuotaExceededError");
      };
    },
  },
);
