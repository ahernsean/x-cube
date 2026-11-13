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
  // cubelet, whose mesh gives the slot and facing it is drawn at. The model must have
  // that cubelet in that slot, and the flat-color pass must match the model's color. And
  // the other way round: every sticker the model turns toward the camera must be drawn.
  const sweep3d = () =>
    page.evaluate(() => {
      const P = window.xcubeProbe;
      const hits = P.scan3d(6);
      const wrong = hits
        .filter((h) => h.slot === "?" || h.cubelet !== h.modelCubelet || h.color !== P.model(h.slot, h.face))
        .map((h) => `${h.slot}/${h.face}: drawn cubelet ${h.cubelet} in ${h.color}, model has cubelet ${h.modelCubelet} in ${h.slot === "?" ? "?" : P.model(h.slot, h.face)}`);
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
            if (h.face !== face || h.cubelet !== h.modelCubelet || h.color !== want) wrong.push(`${face}[${row},${col}] = cubelet ${h.cubelet} at ${h.slot}/${h.face} in ${h.color}; model has cubelet ${h.modelCubelet} in ${want}`);
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
    // drawing buffer is not preserved, so it must be read in the same frame).
    const drawn = await page.evaluate(
      () =>
        new Promise((done) =>
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
    await page.evaluate(() => document.getElementById("copy-code").click()); // only a message changes
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
    check(await inOrder("panel-start", ["#shuffle", "#reset", "#edit-start", "#clear", "#saved-list", "details.code-box"]), "the Start panel has Shuffle, Solved, Edit colors and Start from here, then saved positions and the state code");
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
  check(/f\)?: extension has 6\/9 cubelets/.test(msg), `outer turn after R is refused (message: "${msg}")`);

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

labTest("drawing: a misdrawn cubelet is caught in both views", async ({ page, check, sweep3d, sweepFlat }) => {
  // Draw two cubelets in each other's places, and turn another a quarter turn, and both
  // views must report exactly those cubelets.
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
  check(named(faulty3d.wrong).length === 3 && only(faulty3d.wrong), `a swapped pair and a twisted cubelet are caught in the 3D view, and nothing else (${named(faulty3d.wrong).join(", ") || "none"})`);
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
  const during = await page.evaluate(() => ({ list: document.getElementById("history").textContent, toks: document.querySelectorAll("#history .tok").length }));
  check(during.list === "Shuffling…" && during.toks === 0, `while the shuffle plays, the turn list doesn't show its turns ("${during.list}")`);
  await page.waitForFunction(() => /^Shuffled/.test(document.getElementById("message")?.textContent ?? ""), null, { timeout: 60000 });
  await settle();
  const shuffled = await page.evaluate(() => ({ msg: document.getElementById("message").textContent, state: window.xcubeProbe.state(), turns: window.xcubeProbe.turns() }));
  check(shuffled.msg === "Shuffled", `the message doesn't give the turns away ("${shuffled.msg}")`);
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
  check(imported.state === ruState && imported.msg === "Imported" && imported.counter === "0/0", `importing a state code makes it the start (${imported.msg})`);
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

labTest("edge glow: wraps around a cubelet's corner where two visible faces meet, and fades out elsewhere", async ({ check, probe }) => {
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
  check(wrap.every((w) => w.ok), `edge glow wraps around a cubelet's corner, rounded, without a gap or seam (${wrap.map((w) => `${w.out}: edges ${fmt(w.edges)}, around the corner ${fmt(w.corner)}, square corner ${w.square.toFixed(2)}`).join("; ")})`);
  const [closedMid, closedEnd] = await glowAt("Rx.B", "3d", [[["R", 0.47], ["B", 0.55]], [["R", 0.47], ["U", 0.45], ["B", 0.55]]]);
  const [flatMid, flatEnd] = await glowAt("Rx.UB", "U", [[["U", 0.47], ["B", 0.6]], [["U", 0.47], ["R", 0.45], ["B", 0.6]]]);
  check(closedEnd < 0.3 * closedMid && flatEnd < 0.3 * flatMid, `edge glow fades out at a corner with no glow around it (3D ${fmt([closedMid, closedEnd])}), and in the flat view (${fmt([flatMid, flatEnd])})`);
});

labTest("edge glow: follows the cubelets while a layer turns, from where they are right now", async ({ page, check, probe, swipe, settle }) => {
  // Solved, the front extension's bottom middle cubelet (Fx.D) has Fx.DR against its right
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

labTest("shading: the flat view's bands come from nearer neighbors, and live shading at a turn's start matches the rest shading", async ({ check, probe, startFresh, play }) => {
  // Each nearer neighbor casts a band along the shared edge, at full darkness at the edge
  // and gone past the ramp. Checked in a scrambled position, which has recesses between
  // two walls: those show two bands with a clean middle, and no overlap (an inner corner)
  // is darker than one band.
  await play("R U' F2 D B' L2 R' H S' M");
  const prof = await probe("flatShadeProfile");
  check(prof.shaded > 0 && prof.channels > 0 && prof.edgeErr < 1e-6 && prof.middle > 1 - 1e-6 && prof.darkest >= prof.oneBand - 1e-6, `flat view shading is bands from nearer neighbors (${prof.shaded} shaded tiles, ${prof.channels} between two walls; edge error ${prof.edgeErr}; lightest-middle check ${prof.middle.toFixed(6)}; darkest ${prof.darkest.toFixed(3)}, one band ${prof.oneBand.toFixed(3)})`);

  await startFresh();
  const restError = await probe("shadeRestError");
  check(restError < 1e-6, `live shading at the start of every turn matches the rest shading (largest difference ${restError})`);
});

// ---- Color editing.

labTest("color editing: painting stickers, the validity line, Done and Cancel", async ({ page, check, probe, settle, gesture, swipe, sweep3d, flip }) => {
  // Tap stickers to repaint them; the line says whether the colors are real cubelets that
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
  check(/^Not valid: Two extension edges are white and red, but there can be only one\. Show Hide$/.test(half.line) && half.off && half.drawn === "R", `painting one edge like another is not valid, Done is off, and the paint shows ("${half.line}")`);
  // The edge glow around a painted sticker shows the paint too (the glow is the only sign
  // of a sticker's color where that face is hidden).
  const paintedGlow = (await probe("glowColors", "Fx.U", "F")).join();
  check(paintedGlow === "R", `the edge glow of a painted sticker takes the paint (${paintedGlow})`);
  // A problem puts a purple halo on the cubelets it names by itself, in the 3D view and
  // on the flat view's faces where they show, without moving the view. Show (or tapping
  // the line) tumbles the 3D view to show all their stickers, again after any tumble;
  // Hide removes the halo.
  const seenBoth = async () => `${await probe("facesSeen", "Fx.U")},${await probe("facesSeen", "Rx.U")}`;
  await page.evaluate(() => document.querySelector('[data-view="bottom"]').click());
  await settle();
  const lit = { slots: (await probe("highlighted")).sort().join(), seen: await seenBoth(), px3d: await probe("haloPixels", "3d"), flatU: await probe("haloPixels", "U"), flatD: await probe("haloPixels", "D"), buttons: await page.$$eval("#edit-status .edit-show", (els) => els.map((e) => e.textContent).join()) };
  check(lit.slots === "Fx.U,Rx.U" && lit.seen === "0,0" && lit.px3d > 0 && lit.flatU > 0 && lit.flatD === 0 && lit.buttons === "Show,Hide", `a problem haloes the cubelets it names by itself, without turning the view (${JSON.stringify(lit)})`);
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
  check(appliedGlow === "R G", `after Done, the moved cubelets' glow shows their own colors (${appliedGlow})`);
  const applied = { model: [await probe("model", "Fx.U", "F"), await probe("model", "Rx.U", "R")], label: await page.$eval("#base-label", (e) => e.textContent), inert: await page.$eval("#stack-col", (e) => e.inert) };
  let sw = await sweep3d();
  check(applied.model.join() === "R,G" && applied.label === "Edited colors" && !applied.inert && sw.wrong.length === 0, `Done makes the edited position the start, drawn as the model has it (${applied.model.join(" ")}, "${applied.label}")`);
  const editedState = await probe("state");
  await page.locator("#scene").scrollIntoViewIfNeeded();
  await page.click("#edit-start");
  await paint("R", "Fx.U", "U"); // flip the white-red edge now at Fx.U in place
  await paint("W", "Fx.U", "F");
  const flipped = await editLine();
  check(/^Not valid: White can't point straight out from the core on an extension cubelet\. Show Hide$/.test(flipped), `an outer edge flipped in place is real, but not possible ("${flipped}")`);
  // With several problems, ‹ and › step through them, and the halo moves with the line
  // without turning the view.
  await paint("Y", "Rx.U", "R");
  await paint("Y", "Fx.UR", "F");
  const navLine = await editLine();
  const firstLit = (await probe("highlighted")).join();
  const viewBefore = JSON.stringify(await probe("view"));
  await page.click('[data-halo="next"]');
  const stepped = { line: await editLine(), lit: (await probe("highlighted")).join(), still: JSON.stringify(await probe("view")) === viewBefore };
  await page.click('[data-halo="next"]');
  const wrapped = (await probe("highlighted")).join();
  // The line stays on the problem it showed (Rx.U's) when the new one sorts ahead of it.
  const at = (line) => line.match(/‹(\d)\/(\d)›/)?.slice(1).join("/");
  check(firstLit === "Rx.U" && at(navLine) === "2/2" && at(stepped.line) === "1/2" && stepped.lit === "Fx.UR" && stepped.still && wrapped === firstLit, `the line stays on its problem when another appears; ‹ and › step through them, moving the halo, not the view (${at(navLine)} ${firstLit}, then ${at(stepped.line)} ${stepped.lit}, then ${wrapped})`);
  await page.click("#edit-cancel");
  sw = await sweep3d();
  const cancelGlow = [(await probe("glowColors", "Fx.U", "U")).join(), (await probe("glowColors", "Fx.U", "F")).join()].join(" ");
  check((await probe("state")) === editedState && sw.wrong.length === 0 && cancelGlow === "W R", `Cancel leaves the position, and its drawing and glow, as they were (glow ${cancelGlow})`);
});

labTest("color editing: colors that turns can't reach", async ({ page, check, probe, gesture }) => {
  // Valid means turns can reach some position showing the paint. Center colors arranged
  // as no turns arrange them are refused; a swap that look-alike cubelets can absorb is not.
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
    /^Not valid: Opposite centers must be red and orange, green and blue, or white and yellow\. Show Hide$/.test(centers.line) && centers.off && centers.lit === "Bx,Fx,Lx,Rx" && centers.level === "possible",
    `center colors no turns arrange are not valid, with a halo on the centers and Done off ("${centers.line}", halo ${centers.lit})`,
  );
  await paint("G", "Fx", "F");
  await paint("R", "Rx", "R");
  const restored = await editLine();
  // Two outer edges traded. With every other cubelet where it was, no turns make this;
  // with two look-alike core cubelets traded as well, turns do, and Done gives that position.
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

labTest("guide: Next step loads one step, grays what it leaves alone, and shows where cubelets go", async ({ page, check, probe, settle, play, status, counter, sweep3d, startFresh, turnList }) => {
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
  // darker, since a 3-cycle leaves every other cubelet alone. One arrow per corner.
  check(g?.focus.length === 3 && g.gray === 93 && g.darkGray === 0 && g.arrows === 3 && g.otherGlow === 0 && g.focusGlow > 0, `the cubelets the step applies to keep their colors, the rest are gray, and arrows show the cycle (${JSON.stringify(g)})`);
  // Each path follows one sticker, in its color, from the face it is on to the face it will
  // be on; all three of these cubelets end at home.
  const pathForm = /^[WYGBRO] [\w.]+\/[RLUDFB] > [\w.]+\/[RLUDFB] lands$/;
  check(g?.paths.length === 3 && g.pathMeshes === 24 && g.pathsThrough === 0 && g.pathsOut < 0.45 && g.headGap >= 0 && g.headGap < 0.05 && g.paths.every((t) => pathForm.test(t)) && new Set(g.paths.map((t) => t.split(" ")[1])).size === 3, `each moved cubelet has a path from one of its stickers to where that sticker will be, going around the puzzle, not through it, each shaft joined to its head (${g?.paths.join("; ")})`);
  // A small copy of each cubelet flies along its path (unless the device asks for less motion). Show turns the
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
    grayDrawn > 0 && played.wrong === 0 && played.g?.gray === 0 && played.g.arrows === 0 && /Solved/.test(played.status) && /^Step \d+ of \d+ — Corners \(done\)/.test(played.line),
    `playing the step solves the puzzle and returns every sticker's color (${grayDrawn} gray stickers seen before, ${played.wrong} wrong after; ${played.status}; "${played.line}")`,
  );
  // The step is boxed in the turn list behind a tag. Step start, and the tag, go back to
  // where the step begins, with its grays and arrows.
  const box = await page.$$eval("#history .step-box", (els) => els.map((e) => `${e.querySelector(".step-tag").textContent}:${e.querySelectorAll(".tok").length}:${e.classList.contains("on")}`).join());
  await page.click("#guide-start");
  await settle();
  const backAtStart = { counter: await counter(), g: await probe("guide"), off: await page.$eval("#guide-start", (b) => b.disabled) };
  await page.click("#last");
  await settle();
  await page.click("#history .step-tag");
  await settle();
  const byTag = { counter: await counter(), arrows: (await probe("guide")).arrows };
  check(
    box === "1. Corners:8:true" && backAtStart.counter === "8/16" && backAtStart.g.arrows === 3 && backAtStart.g.gray === 93 && backAtStart.off && byTag.counter === "8/16" && byTag.arrows === 3,
    `the step is boxed in the turn list (${box}); Step start and its tag go back to its start (${backAtStart.counter}, ${byTag.counter})`,
  );
  await page.click("#last");
  await settle();
  const solvedEnd = await page.evaluate(() => ({ next: document.getElementById("next-step").disabled, strip: document.getElementById("strip-next").hidden, play: document.getElementById("last").disabled }));
  check(solvedEnd.next && solvedEnd.strip && solvedEnd.play, `once solved, Next step is grayed out and ▶ (grayed out) doesn't give way to it (${JSON.stringify(solvedEnd)})`);
});

labTest("guide: a Regrip step, a shape step, the count, the marked parts, Stop, and an edit before the step", async ({ page, check, probe, settle, play, status, counter, sweep3d, startFresh, turnList }) => {
  const { line, next } = guideHelpers(page, settle);
  // A puzzle tipped over gets a Regrip step, which grays nothing: the center colors are what it goes by.
  await play("x");
  await next();
  const holdStep = { g: await probe("guide"), line: await line() };
  check(
    holdStep.g?.stage === "hold" && holdStep.g.gray === 0 && holdStep.g.darkGray === 0 && /^Step 1 of 1 — Regrip: Turn the whole puzzle so the white center is up \(now \w+ is up\)\. Nothing else moves\. Turns: x'$/.test(holdStep.line),
    `a Regrip step says to turn the whole puzzle, and keeps every color ("${holdStep.line}")`,
  );
  // Out of shape, the step applies to the core cubelets that are wrong; it may leave the
  // rest anywhere, so they are the darker gray. Those that move get plain paths. Their
  // stickers are often covered by neighbors that are about to move, so a path may graze
  // the puzzle near its ends, or pass behind it, faintly drawn: staying in view comes first.
  await startFresh();
  await play("R U");
  await next();
  const shape = await probe("guide");
  check(shape?.stage === "shape" && shape.focus.length > 0 && shape.darkGray > 0 && shape.otherNoGlow > 0 && shape.otherGlow === 0 && shape.focusGlow > 0 && shape.arrows > 0 && shape.paths.every((t) => !/ (lands|dashed)/.test(t)) && shape.pathsOut < 0.45 && shape.after > 0, `a shape step darkens the cubelets it may leave anywhere, only the cubelets it applies to glow, and those that move have plain paths (${JSON.stringify(shape)})`);
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

labTest("guide: dashed paths, the order switch, a layered core step, and a turn by hand", async ({ page, check, probe, settle, play, status, counter, sweep3d, startFresh, turnList }) => {
  const { line, next } = guideHelpers(page, settle);
  // A cubelet only passing through has a dashed path, in several pieces, and no ring.
  await play("(F' L' F) r (F' L F) r' f (F' L' F) r (F' L F) r' f'");
  await next();
  const passing = await probe("guide");
  const throughOnly = passing.paths.filter((t) => t.endsWith(" dashed")).length;
  check(passing.stage === "corners" && throughOnly === 2 && passing.pathMeshes === 8 + 2 * (2 * 9 + 4) && passing.pathsThrough === 0 && /One ends up solved\./.test(await line()), `two cubelets only passing through get dashed paths (${passing.paths.join("; ")}; ${passing.pathMeshes} meshes)`);
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
  check(byKind === "corners" && byLayer.stage === "topCorners" && byLayer.mode === "layers" && kept === "layers" && /^Step \d+ of \d+ — Top corners: For the white X-face's corners: cycle three X-face corners\. All three end up solved\./.test(await line()), `the order can be switched to top to bottom (${byKind}, then ${byLayer.stage}; "${await line()}")`);
  // Out of shape, top to bottom starts with the core, a cubelet at a time: a short step,
  // one or two paths, and the line counts the cubelets placed.
  await startFresh();
  await play("R U F' L2");
  await next();
  const core = await probe("guide");
  check(core?.stage.startsWith("core") && core.turns <= 9 && core.arrows >= 1 && core.arrows <= 3 && /^Step \d+ of \d+ — Top core edges: Put a white core edge in the top layer, white up \([1-4] of 4\)\./.test(await line()), `top to bottom places the core a cubelet at a time (${core?.alg}, ${core?.arrows} paths; "${await line()}")`);
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
  // sticker will be is filled until the turn takes that cubelet away.
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
  check(g.alg === "R2" && k >= 0 && pts.length === 25 && pts.every(([x, , z]) => x > 0.9 && Math.abs(z) < 0.2) && g.pathsThrough === 0, `the path from the bottom of the right side to its top goes around the right side, through nothing but the cubelet the turn takes away (${g.alg}; ${g.paths.join("; ")}; ${JSON.stringify(pts)})`);
  // The flying copies' places at equal times are equally far apart (a chord across a
  // bend is a little shorter than the path), on every path; and no path leaves the view.
  const gaps = g.pathPoints.map((path) => path.slice(1).map((q, i) => Math.hypot(q[0] - path[i][0], q[1] - path[i][1], q[2] - path[i][2])));
  const uneven = Math.max(...gaps.map((d) => Math.max(...d) / Math.min(...d)));
  check(gaps.length === g.arrows && uneven < 1.35 && g.pathsOut < 0.45, `a flying copy neither lingers nor rushes (its longest stride is ${uneven.toFixed(2)} of its shortest), and leaves the view by little if at all (${g.pathsOut.toFixed(2)} out)`);
  check(sharpest(g) < 50, `no path bends sharply (${sharpest(g).toFixed(0)} degrees at most between one stride and the next)`);
  // A cubelet with several stickers is followed by the one that needs no bend to get
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
  const steps = [];
  for (let i = 0; i < 7; i++) {
    await page.click("#next-step");
    await settle();
    steps.push(await probe("guide"));
    await page.click("#last");
    await settle();
  }
  const first = steps[0], corner = steps[4], unit = steps[6];
  check(first.alg === "R2" && lean(first) < 47 && bowIn(first) < 0.03, `a path leaves its sticker and comes onto its face within 45 degrees of straight out (${lean(first).toFixed(0)} at most, sampled a twenty-fourth of the way in), and never bows in toward the puzzle (${bowIn(first).toFixed(3)})`);
  check(steps.every((g) => g.arrows === 0 || (lean(g) < 47 && bowIn(g) < 0.03)), `so does every path of the first seven steps (${steps.map((g) => `${g.alg}: ${g.arrows ? `${lean(g).toFixed(0)} degrees, ${bowIn(g).toFixed(3)} in` : "no paths"}`).join("; ")})`);
  // A core double edge has no sticker: it and the two extension cubelets against it move
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
  check(unit.stage === "coreMiddle" && unit.arrows >= 1 && unit.paths.every((t) => /^null /.test(t)) && unit.focus.length >= 3 * unit.arrows && unit.runners === unit.arrows, `each core double edge moves as a unit with the cubelets against it, on a neutral path (${unit.alg}; ${unit.paths.join("; ")}; focus ${unit.focus.join(" ")})`);
});

labTest("guide: a flying cubelet turns only about the axis its sticker turns about", async ({ page, check, probe, settle }) => {
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

labTest("guide: a cubelet turning in place has a disc, and its unit rises past it, turns, and drops back", async ({ page, check, probe, settle }) => {
  // Top to bottom's next step here turns one white core corner a third of a turn in place,
  // with its two extension cubelets.
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
  check(Math.abs(tw.angle) === 120 && Math.sign(tw.half) === Math.sign(tw.angle) && Math.abs(Math.abs(tw.half) - 60) < 3, `the disc shows a third of a turn, and the flying cubelet turns the same way (${tw.angle}, halfway ${tw.half})`);
  check(g.units.every((n) => n === 3), `every core corner of the step flies with its two extension cubelets (${g.units.join(" ")})`);
  check(g.flyersLit, "the flying cubelets are made and lit like the puzzle's own, with shadows");
  // Out, hold past the disc while turning, back; each part eased, so the rise comes to rest at the disc.
  const lift = tw.lift, top = Math.max(...lift);
  const rise = lift.slice(0, 8), fall = lift.slice(17);
  check(lift[0] === 0 && lift[24] === 0 && top > 1 && lift.slice(8, 17).every((v) => v === top), `the unit rises along the stem to past the disc, stays there, and drops back (${lift.join(" ")})`);
  check(rise.every((v, k) => k === 0 || v >= rise[k - 1]) && fall.every((v, k) => k === 0 || v <= fall[k - 1]) && top - lift[7] < 0.06 * top && lift[1] < 0.06 * top, `it eases into and out of the spot past the disc, as at the start and end (${lift.join(" ")})`);
});

labTest("guide: only the cubelets a step moves or turns keep their colors", async ({ page, check, probe, settle }) => {
  // The owner's position: Top to bottom's next step (R' D2 R) moves the white core corners
  // at DBL and DFL, each with its two extension cubelets. The white core corners at UBL and
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
  check(g.alg === "R' D2 R" && g.focus.length === 6 && ["DBL", "DFL"].every((s) => g.focus.includes(s)) && !g.focus.some((s) => ["UBL", "UFL"].includes(s)), `only the moved corners and their extension cubelets keep their colors (${g.focus.join(" ")})`);
  check(g.darkGray > 0 && g.gray > 0, `what else the turns move is darker gray, and what they leave alone lighter (${g.darkGray} darker, ${g.gray} lighter)`);
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
  check(solving.next && !solving.show && /^1 step, \d+ turns?$/.test(solving.head) && solving.rows.length === 1, `with a step's turns still to play, Next step is grayed out and Show step applies; the step list has it (${JSON.stringify(solving)})`);
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
  const two = await page.evaluate(() => ({ head: document.getElementById("steps-head").textContent, rows: [...document.querySelectorAll("#steps-list .step-row")].map((r) => r.textContent) }));
  check(/^2 steps, \d+ turns$/.test(two.head) && /^2\./.test(two.rows[0]) && /^1\..*✓/.test(two.rows[1]), `the step list shows the newest first, the played one ticked, and the total (${JSON.stringify(two)})`);
  await page.click("#steps-list .step-row:last-child");
  // Axis marks on x, y and z, and a Display panel no wider than its switches.
  const marks = await page.evaluate(() => ["x", "y", "z"].map((m) => getComputedStyle(document.querySelector(`[data-move="${m}"]`)).backgroundImage.slice(0, 15)));
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
