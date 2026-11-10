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
// with iPhone-like settings (touch, device pixel ratio 3) because the Lab is used mostly on
// an iPhone and iPad. It is not given `isMobile`: the built page has no viewport meta tag
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
// times slower than Mesa's llvmpipe (the CPU renderer WebKit uses on Linux). These flags
// send Chromium's ANGLE to Mesa through EGL instead. Where Mesa's EGL is missing, Chromium
// quietly keeps SwiftShader, so the startup test prints the renderer in use, and with
// EXPECT_RENDERER set (CI sets it to llvmpipe) a different renderer fails it.
const launchArgs = engine === "chromium" && process.platform === "linux" ? ["--ignore-gpu-blocklist", "--use-angle=gl-egl"] : [];
let browser;
before(async () => {
  browser = await playwright[engine].launch({ args: launchArgs });
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
    ? { viewport: { width: 390, height: 900 }, deviceScaleFactor: 3, hasTouch: true }
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
    await page.click("#reset");
    await page.click('[data-view="home"]');
    await page.locator("#scene").scrollIntoViewIfNeeded();
    await settle();
  };
  const status = () => page.$eval("#status", (s) => s.textContent ?? "");
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
    console.log(`     WebGL renderer: ${renderer}`);
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
    const renderOpen = { shown: await isShown("render-pop"), boxes: await page.$$eval("#render-pop input[type=checkbox]", (els) => els.length), height: await pageHeight() };
    await page.click("#info-btn");
    const infoOpen = { shown: await isShown("info-pop"), renderClosed: !(await isShown("render-pop")), height: await pageHeight() };
    await page.click("#flat-info-btn");
    const flatOpen = { shown: await isShown("flat-info-pop"), infoClosed: !(await isShown("info-pop")), height: await pageHeight(), text: await page.$eval("#flat-info-pop", (e) => e.textContent) };
    await page.mouse.click(5, h0 - 5 > 600 ? 600 : 300);
    const allClosed = !(await isShown("info-pop")) && !(await isShown("render-pop")) && !(await isShown("flat-info-pop"));
    const flatLegendInFlow = await page.$$eval("[data-sec=flat] .legend", (els) => els.length);
    check(
      renderOpen.shown && renderOpen.boxes === 4 && infoOpen.shown && infoOpen.renderClosed && flatOpen.shown && flatOpen.infoClosed && /no sticker/.test(flatOpen.text) && flatLegendInFlow === 0 && allClosed && renderOpen.height === h0 && infoOpen.height === h0 && flatOpen.height === h0,
      `the Display panel and both ⓘ panels (3D and flat view) open over the views without moving the page (height ${h0} px), one at a time, and close on a tap elsewhere`,
    );
    await page.fill("#alg", "");
    await page.click("#load"); // nothing to load: only a message changes
    const floating = { shown: await isShown("message"), fixed: await page.$eval("#message", (e) => getComputedStyle(e).position), height: await pageHeight() };
    await page.click("#message");
    const msgGone = !(await isShown("message"));
    check(floating.shown && floating.fixed === "fixed" && floating.height === h0 && msgGone, `a message floats over the page (${floating.fixed}) without moving it, and a tap dismisses it`);
  },
  { expand: false },
);

labTest(
  "layout: the algorithm and turn panels' order, notes and buttons",
  async ({ page, check }) => {
    // The algorithm panel reads top to bottom: the turn list and playback, then Clear, Reset
    // and Shuffle, then the ways to add turns (typing, and the algorithms list).
    const runOrder = await page.evaluate(() => {
      const sec = document.querySelector("[data-sec=run]");
      const ids = ["#history", ".transport", ".base-actions", "#alg", "details.known"];
      const els = ids.map((q) => sec.querySelector(q));
      return els.every(Boolean) && els.every((el, i) => i === 0 || els[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
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
    check(infoLook.length === 2 && infoLook.every((v) => v === "rgba(0, 0, 0, 0)/rgba(0, 0, 0, 0)"), "both ⓘ buttons show just the ⓘ, with no button edge or fill");
    check(unitsWhole, "the notes break lines only between units like \"M like L,\", never inside one");
    check(notes.every(Boolean) && (await page.$$eval("[data-sec=turn] .legend", (els) => els.length)) === 0, `the H/M/S and x/y/z notes sit beside their buttons (${notes})`);
    check(runOrder, "the algorithm panel shows the turn list and playback first, then Clear/Reset/Shuffle, then typing and the algorithms list");

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

labTest("layout: every section collapses from its heading", async ({ page, check }) => {
  const sections = await page.$$eval("[data-sec]", (els) => els.map((e) => e.getAttribute("data-sec")));
  for (const s of sections) await page.click(`[data-sec=${s}] h2`);
  const collapsed = await page.$$eval("[data-sec].collapsed", (els) => els.length);
  check(collapsed === sections.length && sections.length > 0, `all ${sections.length} sections collapse`);
});

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
  await page.click("#reset");
  await page.fill("#alg", "R f");
  await page.click("#load");
  const msg = await page.$eval("#message", (m) => m.textContent ?? "");
  check(/f\)?: extension has 6\/9 cubelets/.test(msg), `outer turn after R is refused (message: "${msg}")`);

  // Baum's edge 3-cycle (white-up grip) returns to the X shape.
  await page.click("#reset");
  await page.fill("#alg", "R' S' R b R' S R b'");
  await page.click("#load");
  await page.click("#last");
  await page.waitForFunction(() => document.getElementById("last")?.textContent === "▶", null, { timeout: 60000 });
  check((await status()).includes("X shape"), "edge 3-cycle keeps the X shape");
});

labTest("undo: takes back the last turn, and a turn pressed while an undo waits also takes effect", async ({ page, check, status, waitForCounter }) => {
  await page.evaluate(() => document.querySelector('[data-move="R"]').click());
  await waitForCounter("1/1", 30000);
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
  const raceStatus = await status();
  check(afterRace === "F" && /l 6\/9/.test(raceStatus) && /r 6\/9/.test(raceStatus), `undo then an immediate F leaves just F (turns "${afterRace}")`);
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
      return { text: el.textContent, shown: Number(getComputedStyle(el).opacity) > 0.05, inside: b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1 };
    });
  });
  const letters = labels.map((l) => l.text).sort().join("");
  check(letters === "BDFLRU" && labels.filter((l) => l.shown).every((l) => l.inside) && labels.filter((l) => l.shown).length >= 3, `edge labels: ${letters}, ${labels.filter((l) => l.shown).length} shown, all inside the view`);
  await page.click('[data-view="front"]');
  await settle();
  const frontView = await probe("view");
  await page.click('[data-view="home"]');
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
  await page.waitForFunction(() => /^Shuffled with/.test(document.getElementById("message")?.textContent ?? ""), null, { timeout: 60000 });
  await settle();
  const shuffled = await page.evaluate(() => ({ msg: document.getElementById("message").textContent, state: window.xcubeProbe.state(), turns: window.xcubeProbe.turns() }));
  const scramble = shuffled.msg.replace(/^Shuffled with 30 turns: /, "");
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
  await page.locator("summary", { hasText: "Algorithms" }).click();
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
  await page.locator("summary", { hasText: "Algorithms" }).click();
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
  await page.click("#reset");
  const mine = await page.evaluate(() => [...document.querySelectorAll("#known-list li")].find((li) => li.textContent.includes("Sexy move"))?.querySelector("[data-alg-load]")?.dataset.algLoad);
  await page.click(`[data-alg-load="${mine}"]`);
  const loadedMine = { base: await page.$eval("#base-label", (e) => e.textContent), alg: await turnList(), counter: await counter() };
  check(
    algsBefore.length === 5 && algsBefore.includes("Corner 3-cycle (Baum)") && !afterDelete.includes("Corner 3-cycle (Baum)") && afterDelete.length === 4 && fieldAfterLoad === "" && afterSave.at(-1) === "Sexy move" && loadedMine.base === "Sexy move" && loadedMine.alg === "R U R' U'" && loadedMine.counter === "0/4",
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
  check(cleared.counter === "0/0" && cleared.state === ruState && /^Turns cleared/.test(cleared.msg) && (await page.$eval("#clear", (b) => b.textContent)) === "Clear", `Clear empties the turn list and keeps the position shown as the start (${cleared.counter})`);
});

labTest("state codes: the current position's code is shown and copied, and a code imports as the start", async ({ page, check, probe, startFresh, counter, play, sweep3d }) => {
  await play("R U");
  const ruState = await probe("state");
  await page.locator("summary", { hasText: "State code" }).click(); // the codes sit in a closed disclosure
  const shown = await page.$eval("#code-out", (t) => t.value);
  check(shown === ruState, "the state code shown is the current position's");
  check(/^[A-Z]{4}( [A-Z]{4}){10}$/.test(shown) && (await page.$eval("#code-note", (n) => n.textContent === "")), `the code is 44 letters in groups of 4, with no note (${shown})`);
  await page.click("#copy-code");
  // Copying is asynchronous (the clipboard may ask for permission); wait for its message.
  const copyMsg = await page
    .waitForFunction(() => /State code copied|Select and copy the code below/.test(document.getElementById("message").textContent), null, { timeout: 10000 })
    .then(() => page.$eval("#message", (m) => m.textContent))
    .catch(() => page.$eval("#message", (m) => m.textContent));
  check(/State code copied|Select and copy the code below/.test(copyMsg), `Copy confirms, or asks to copy by hand where the clipboard is not allowed ("${copyMsg}")`);
  await startFresh();
  await page.fill("#code-in", "  " + ruState + "\n");
  await page.click("#import");
  const imported = { state: await probe("state"), msg: await page.$eval("#message", (m) => m.textContent), counter: await counter() };
  check(imported.state === ruState && imported.msg === "Imported" && imported.counter === "0/0", `importing a state code makes it the start (${imported.msg})`);
  await page.fill("#code-in", "X1:not a code");
  await page.click("#import");
  const refused = { state: await probe("state"), msg: await page.$eval("#message", (m) => m.textContent) };
  check(refused.state === ruState && /^Couldn't import: /.test(refused.msg), `a malformed code is refused and changes nothing ("${refused.msg}")`);
  await startFresh();
  await page.fill("#code-in", ruState.toLowerCase().replace(/ /g, "-"));
  await page.click("#import");
  check((await probe("state")) === ruState, "a code typed in lower case with dashes imports the same position");
  const typo = (ruState[0] === "A" ? "B" : "A") + ruState.slice(1);
  await page.fill("#code-in", typo);
  await page.click("#import");
  const typoMsg = await page.$eval("#message", (m) => m.textContent);
  check((await probe("state")) === ruState && /typo/.test(typoMsg), `a code with a typo is refused and changes nothing ("${typoMsg}")`);
  // A position turns can't reach (solved, with the right extension center turned a quarter
  // by hand) has no letter code: it keeps its X1 code, with a note saying why.
  const turnedCenter =
    "X1:AaBaCaDaEaFaGaHaIa......JaKaLaMaNaOaPaQaRaSaTaUaVaWaXa............YaZaaabacadaeafagahaiajakala............manaoapaqarasatauavawaxayaza0a......1a2a3a4a5b6a7a8a9a";
  await page.fill("#code-in", turnedCenter);
  await page.click("#import");
  const kept = { code: await page.$eval("#code-out", (t) => t.value), note: await page.$eval("#code-note", (n) => n.textContent + " (" + n.title + ")") };
  check(kept.code === turnedCenter && /extension center is turned/.test(kept.note), `a position turns can't reach keeps its X1 code, with a note ("${kept.note}")`);
  await page.fill("#code-in", ruState);
  await page.click("#import");
  const sw = await sweep3d();
  check(sw.wrong.length === 0, `the imported position is drawn as the model has it${sw.wrong.length ? ": " + sw.wrong.slice(0, 3).join("; ") : ""}`);
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
  check(/^Not valid: Two cubelets of this type are white and red, but only one can be colored this way\. Show Hide$/.test(half.line) && half.off && half.drawn === "R", `painting one edge like another is not valid, Done is off, and the paint shows ("${half.line}")`);
  // The edge glow around a painted sticker shows the paint too (the glow is the only sign
  // of a sticker's color where that face is hidden).
  const paintedGlow = (await probe("glowColors", "Fx.U", "F")).join();
  check(paintedGlow === "R", `the edge glow of a painted sticker takes the paint (${paintedGlow})`);
  // A problem puts a purple halo on the cubelets it names by itself, in the 3D view and
  // on the flat view's faces where they show, without moving the view. Show (or tapping
  // the line) tumbles the 3D view to show all their stickers, again after any tumble;
  // Hide removes the halo.
  const seenBoth = async () => `${await probe("facesSeen", "Fx.U")},${await probe("facesSeen", "Rx.U")}`;
  await page.click('[data-view="bottom"]');
  await settle();
  const lit = { slots: (await probe("highlighted")).sort().join(), seen: await seenBoth(), px3d: await probe("haloPixels", "3d"), flatU: await probe("haloPixels", "U"), flatD: await probe("haloPixels", "D"), buttons: await page.$$eval("#edit-status .edit-show", (els) => els.map((e) => e.textContent).join()) };
  check(lit.slots === "Fx.U,Rx.U" && lit.seen === "0,0" && lit.px3d > 0 && lit.flatU > 0 && lit.flatD === 0 && lit.buttons === "Show,Hide", `a problem haloes the cubelets it names by itself, without turning the view (${JSON.stringify(lit)})`);
  await page.click("#edit-status");
  await settle();
  const shownAt = await seenBoth();
  await page.click('[data-view="bottom"]');
  await settle();
  await page.click('[data-halo="show"]');
  await settle();
  const back = await seenBoth();
  check(shownAt === "2,2" && back === "2,2", `tapping the line, or Show after a tumble, turns the view to show all their stickers (faces seen ${shownAt}, then ${back})`);
  await page.click('[data-halo="hide"]');
  const unlit = { slots: (await probe("highlighted")).length, px3d: await probe("haloPixels", "3d"), flatU: await probe("haloPixels", "U"), buttons: await page.$$eval("#edit-status .edit-show", (els) => els.map((e) => e.textContent).join()) };
  check(unlit.slots === 0 && unlit.px3d === 0 && unlit.flatU === 0 && unlit.buttons === "Show", `Hide removes the halo (${JSON.stringify(unlit)})`);
  await page.click('[data-view="home"]');
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
  await page.click('[data-view="home"]'); // the swipe tumbled the view
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
  check(/‹1\/2›/.test(navLine) && /‹2\/2›/.test(stepped.line) && stepped.lit !== firstLit && stepped.still && wrapped === firstLit, `‹ and › step through the problems, moving the halo, not the view (${firstLit}, then ${stepped.lit}, then ${wrapped})`);
  await page.click("#edit-cancel");
  sw = await sweep3d();
  const cancelGlow = [(await probe("glowColors", "Fx.U", "U")).join(), (await probe("glowColors", "Fx.U", "F")).join()].join(" ");
  check((await probe("state")) === editedState && sw.wrong.length === 0 && cancelGlow === "W R", `Cancel leaves the position, and its drawing and glow, as they were (glow ${cancelGlow})`);
});

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
