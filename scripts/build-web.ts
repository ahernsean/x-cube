// Bundle the browser viewer into one self-contained HTML file, in two forms:
// - dist/x-cube-lab.html: the page body for the claude.ai artifact, which supplies the
//   document skeleton (doctype, charset, viewport) when it is published;
// - dist/index.html: the same page as a complete document, for any other web server
//   (GitHub Pages). Without the viewport tag a phone would lay it out 980 px wide.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const out = await build({
  entryPoints: ["src/web/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  write: false,
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const page = readFileSync("src/web/page.html", "utf8").replace("/*__APP__*/", () => js);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/x-cube-lab.html", page);
const standalone =
  '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  page +
  "\n</html>\n";
writeFileSync("dist/index.html", standalone);
console.log(`dist/x-cube-lab.html: ${(page.length / 1024).toFixed(1)} KiB; dist/index.html: standalone copy`);
