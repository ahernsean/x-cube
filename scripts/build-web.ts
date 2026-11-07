// Bundle the browser viewer into one self-contained HTML file: dist/x-cube-lab.html
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
console.log(`dist/x-cube-lab.html: ${(page.length / 1024).toFixed(1)} KiB`);
