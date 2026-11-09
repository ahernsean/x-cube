// Browser smoke test for the built X-Cube Lab (dist/x-cube-lab.html).
// Opens it in a headless browser and checks that it loads without errors and that the
// core interactions work. Run after `node scripts/build-web.ts`.
//
//   node scripts/smoke-web.mjs            # Chromium
//   node scripts/smoke-web.mjs webkit     # WebKit, the engine of Safari on iPhone and iPad
//
// Needs the `playwright` package and the browser for it (CI installs both). WebKit runs
// with iPhone-like settings (touch, device pixel ratio 3) because the Lab is used mostly on
// an iPhone and iPad. It is not given `isMobile`: the built page has no viewport meta tag
// (claude.ai adds one when it publishes the artifact), so a mobile layout would be 980 px wide.

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

// require() also finds a globally installed Playwright (as in some dev containers);
// in CI it is installed into node_modules.
const playwright = createRequire(import.meta.url)("playwright");

const engine = process.argv[2] ?? "chromium";
if (!["chromium", "webkit"].includes(engine)) {
  console.error(`unknown browser "${engine}" (use chromium or webkit)`);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(resolve(here, "../dist/x-cube-lab.html")).href;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await playwright[engine].launch();
try {
  const context =
    engine === "webkit"
      ? await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 3, hasTouch: true })
      : await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  console.log(`${engine} ${browser.version()}`);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // Software-rendering GPU chatter is not a page error.
    if (m.type() === "error" && !/GPU stall|GL Driver|WebGL/.test(m.text())) errors.push(m.text());
  });

  await page.goto(pageUrl);
  await page.waitForFunction(() => window.THREE && window.THREE.REVISION, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  check(true, `three.js r${await page.evaluate(() => window.THREE.REVISION)} loaded`);

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

  const status = () => page.$eval("#status", (s) => s.textContent ?? "");
  check((await status()).includes("Solved"), "starts solved and in X shape");

  // Run an algorithm and wait for it to finish playing.
  await page.fill("#alg", "R U");
  await page.click("#run");
  await page.waitForFunction(() => document.getElementById("counter")?.textContent?.replace(/\s/g, "") === "2/2", null, { timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("last")?.textContent === "▶", null, { timeout: 30000 });
  const tokens = await page.$$eval("#history .tok", (els) => els.map((e) => e.textContent).join(" "));
  check(tokens === "R U", `turn list shows "R U" (got "${tokens}")`);
  check((await status()).includes("Out of shape"), "R U leaves the puzzle out of shape");

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

  // Undo takes back the last turn.
  await page.click("#reset");
  await page.evaluate(() => document.querySelector('[data-move="R"]').click());
  await page.waitForFunction(() => document.getElementById("counter")?.textContent?.replace(/\s/g, "") === "1/1", null, { timeout: 30000 });
  await page.click("#undo");
  await page.waitForFunction(() => document.getElementById("counter")?.textContent?.replace(/\s/g, "") === "0/0", null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  check((await status()).includes("Solved"), "undo takes back the last turn");

  // A turn pressed while an undo is still waiting to animate: both take effect.
  await page.evaluate(() => document.querySelector('[data-move="R"]').click());
  await page.waitForFunction(() => document.getElementById("counter")?.textContent?.replace(/\s/g, "") === "1/1", null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    document.getElementById("undo").click();
    document.querySelector('[data-move="F"]').click();
  });
  await page.waitForTimeout(1500);
  const afterRace = await page.$$eval("#history .tok", (els) => els.map((e) => e.textContent).join(" "));
  const raceStatus = await status();
  check(afterRace === "F" && /l 6\/9/.test(raceStatus) && /r 6\/9/.test(raceStatus), `undo then an immediate F leaves just F (turns "${afterRace}")`);

  // Every section collapses from its heading.
  const sections = await page.$$eval("[data-sec]", (els) => els.map((e) => e.getAttribute("data-sec")));
  for (const s of sections) await page.click(`[data-sec=${s}] h2`);
  const collapsed = await page.$$eval("[data-sec].collapsed", (els) => els.length);
  check(collapsed === sections.length && sections.length > 0, `all ${sections.length} sections collapse`);

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);

  // The standalone page (published to GitHub Pages) as a phone sees it: with the phone's
  // own layout rules, the viewport tag must give a 390 px wide page that draws the cube.
  {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const p = await phone.newPage();
    const phoneErrors = [];
    p.on("pageerror", (e) => phoneErrors.push(String(e)));
    await p.goto(pathToFileURL(resolve(here, "../dist/index.html")).href);
    await p.waitForFunction(() => window.THREE && window.THREE.REVISION, null, { timeout: 30000 });
    await p.waitForTimeout(1000);
    const [sw, cw, standards] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth, document.compatMode]);
    check(cw === 390 && sw <= cw && standards === "CSS1Compat", `standalone page lays out at phone width (${cw} px wide, ${sw} px of content, ${standards})`);
    check((await p.$eval("#status", (e) => e.textContent ?? "")).includes("Solved") && phoneErrors.length === 0, "standalone page starts solved, without page errors");
    await phone.close();
  }

  // Opened as a file there is no shared database, so saved states go to this device.
  // A save is confirmed only when it was stored; a storage failure is reported.
  // Each check gets its own context, so it starts with empty storage.
  const savePage = async (storageFails) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const p = await ctx.newPage();
    if (storageFails)
      await p.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("full", "QuotaExceededError");
        };
      });
    await p.goto(pageUrl);
    await p.waitForFunction(() => document.getElementById("store-kind")?.textContent === "This device only", null, { timeout: 30000 });
    await p.evaluate(() => document.querySelector("[data-sec=saved]")?.classList.remove("collapsed"));
    await p.fill("#save-name", "Smoke save");
    await p.click("#save");
    await p.waitForFunction(() => !document.getElementById("message")?.hidden, null, { timeout: 10000 });
    const result = {
      message: await p.$eval("#message", (m) => m.textContent ?? ""),
      listed: await p.$eval("#saved-list", (l) => (l.textContent ?? "").includes("Smoke save")),
    };
    await ctx.close();
    return result;
  };
  const good = await savePage(false);
  check(good.listed && good.message.startsWith('Saved "Smoke save"'), `a device save is listed and confirmed ("${good.message}")`);
  const full = await savePage(true);
  check(!full.listed && full.message.startsWith("Could not save"), `a failed device save is reported, not listed ("${full.message}")`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
