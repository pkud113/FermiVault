// Search-as-you-type ordering, clearing, unmounting and failures (finding 4). Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Search, type SearchState } from "../src/lib/search.ts";

/** A backend whose calls settle only when the test says so, in any order. */
function controlled() {
  const calls: { query: string; resolve: (h: string[]) => void; reject: (e: unknown) => void }[] = [];
  const run = (query: string) => new Promise<string[]>((resolve, reject) => calls.push({ query, resolve, reject }));
  return { calls, run };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const backend = controlled();
  const seen: SearchState<string>[] = [];
  const s = new Search<string>(backend.run, (st) => seen.push(st), 0);
  return { backend, seen, s };
}

test("an older search finishing last never replaces newer results", async () => {
  const { backend, s } = setup();
  s.set("a");
  await tick();
  s.set("ab");
  await tick();
  assert.deepEqual(backend.calls.map((c) => c.query), ["a", "ab"]);
  backend.calls[1].resolve(["ab result"]);
  await tick();
  backend.calls[0].resolve(["a result", "another"]);
  await tick();
  assert.equal(s.state.status, "done");
  assert.equal(s.state.query, "ab");
  assert.deepEqual(s.state.hits, ["ab result"]);
});

test("clearing the query discards searches still in flight", async () => {
  const { backend, s } = setup();
  s.set("a");
  await tick();
  s.set("");
  assert.equal(s.state.status, "idle");
  backend.calls[0].resolve(["late"]);
  await tick();
  assert.deepEqual(s.state, { status: "idle", query: "", hits: [] });
});

test("typing faster than the pause sends only the last query", async () => {
  const backend = controlled();
  const s = new Search<string>(backend.run, () => {}, 20);
  for (const q of ["s", "se", "sea"]) s.set(q);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(backend.calls.map((c) => c.query), ["sea"]);
});

test("nothing updates after the pane is closed", async () => {
  const { backend, seen, s } = setup();
  s.set("a");
  await tick();
  s.dispose();
  const before = seen.length;
  backend.calls[0].resolve(["late"]);
  s.set("b");
  s.refresh();
  await tick();
  assert.equal(seen.length, before);
});

test("a failure is reported as a failure, and Retry recovers", async () => {
  const { backend, s } = setup();
  s.set("x");
  await tick();
  backend.calls[0].reject("index is busy");
  await tick();
  assert.equal(s.state.status, "error");
  assert.equal(s.state.error, "index is busy");
  s.refresh();
  assert.equal(s.state.status, "searching");
  backend.calls[1].resolve([]);
  await tick();
  assert.deepEqual(s.state, { status: "done", query: "x", hits: [] }, "no matches is its own state, not an error");
});

test("a stale failure doesn't hide newer results", async () => {
  const { backend, s } = setup();
  s.set("a");
  await tick();
  s.set("b");
  await tick();
  backend.calls[1].resolve(["b"]);
  await tick();
  backend.calls[0].reject("timeout");
  await tick();
  assert.equal(s.state.status, "done");
  assert.deepEqual(s.state.hits, ["b"]);
});
