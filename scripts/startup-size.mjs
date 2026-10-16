// Size of the JavaScript the app loads before its first frame (everything else is lazy):
// `node scripts/startup-size.mjs` after `pnpm build`. Fails over the limit, so a heavy static
// import can't slip into startup unnoticed.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const LIMIT_KB = 300;
const seen = new Map();
const walk = (file) => {
  if (seen.has(file)) return;
  const src = readFileSync(file, "utf8");
  seen.set(file, src.length);
  for (const m of src.matchAll(/(?:import|export)\s*(?:[^"'()]*?from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g)) walk(resolve(dirname(file), m[1]));
};
const html = readFileSync("build/index.html", "utf8");
for (const [, url] of html.matchAll(/import\("([^"]+)"\)/g)) walk(resolve("build" + url));
// The layout (0) and the page (2) load before the first render.
for (const n of readdirSync("build/_app/immutable/nodes")) if (/^[02]\./.test(n)) walk(resolve("build/_app/immutable/nodes", n));

const kb = Math.round([...seen.values()].reduce((a, b) => a + b, 0) / 1024);
console.log(`startup JavaScript: ${kb} KB in ${seen.size} files (limit ${LIMIT_KB} KB)`);
if (kb > LIMIT_KB) {
  console.log(`::error::Startup JavaScript is ${kb} KB (limit ${LIMIT_KB} KB). Load the new code lazily with import().`);
  process.exit(1);
}
