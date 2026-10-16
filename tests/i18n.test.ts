// Every interface string has a translation in every locale, with the same {placeholders}.
// Run with `pnpm test`. Lists what's missing, so translators can see what to add.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const src = new URL("../src/", import.meta.url);
const files = [
  ...readdirSync(new URL("lib/", src)).map((f) => new URL(`lib/${f}`, src)),
  ...readdirSync(new URL("routes/", src)).map((f) => new URL(`routes/${f}`, src)),
].filter((u) => /\.(svelte|ts)$/.test(u.pathname));

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
/** t("…"), tk("…") and t(cond ? "…" : "…", …). */
const PATTERNS = [new RegExp(String.raw`\bt[k]?\(\s*` + STR, "g"), new RegExp(String.raw`\bt\(\s*[^"()]*?\?\s*` + STR + String.raw`\s*:\s*` + STR, "g")];

function keys(): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const re of PATTERNS) for (const m of text.matchAll(re)) for (const raw of m.slice(1)) if (raw !== undefined) out.add(JSON.parse(`"${raw}"`));
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const locales = readdirSync(new URL("lib/locales/", src)).filter((f) => f.endsWith(".json"));
const used = keys();

test("the source has translatable strings", () => {
  assert.ok(used.size > 200, `found only ${used.size}`);
  assert.ok(used.has("Settings") && used.has("New note") && used.has("Read every note and search the vault"));
});

for (const file of locales) {
  test(`${file}: complete, placeholders match, nothing stale`, () => {
    const dict: Record<string, string> = JSON.parse(readFileSync(new URL(`lib/locales/${file}`, src), "utf8"));
    const missing = [...used].filter((k) => !dict[k]?.trim());
    assert.deepEqual(missing, [], `${missing.length} missing in ${file}`);
    const wrong = Object.entries(dict).filter(([k, v]) => placeholders(k) !== placeholders(v)).map(([k]) => k);
    assert.deepEqual(wrong, [], `placeholders differ in ${file}`);
    const stale = Object.keys(dict).filter((k) => !used.has(k));
    assert.deepEqual(stale, [], `strings no longer in the source, in ${file}`);
  });
}
