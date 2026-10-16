// Quick-switcher budget (the plan's "results under 50 ms") on 10,000 note paths, ranked the way
// Palette.svelte ranks them. Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzy } from "../src/lib/api.ts";

const words = "note vault index search graph link tag project meeting idea draft review plan design research".split(" ");
const paths = Array.from({ length: 10_000 }, (_, i) => `${words[i % 7]}/${words[(i * 7) % words.length]} ${i} ${words[(i * 3) % words.length]}.md`);

const rank = (q: string) =>
  paths
    .map((p) => [fuzzy(q, p), p] as const)
    .filter(([s]) => s >= 0)
    .sort((a, b) => b[0] - a[0]);

test("quick switcher ranks 10,000 notes within 50 ms", () => {
  rank("warm up");
  let slowest = 0;
  for (const q of ["n", "meet", "proj plan", "research 42", "zzz", "index search 9999"]) {
    const t = performance.now();
    rank(q);
    slowest = Math.max(slowest, performance.now() - t);
  }
  assert.ok(slowest < 50, `slowest query took ${slowest.toFixed(1)} ms`);
});
