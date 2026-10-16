// Note properties: reading and editing frontmatter. Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { body, diffChange, readProps, removeProp, setProp } from "../src/lib/frontmatter.ts";

const note = `---
title: "Plan: v2"
status: active # set by hand
tags: [a, "b"]
aliases:
  - One
  - 'Two'
nested:
  child: x
# a comment
---
Body text.
`;

test("reads the same flat YAML subset the index uses", () => {
  assert.deepEqual(readProps(note), [
    { key: "title", value: "Plan: v2" },
    { key: "status", value: "active" },
    { key: "tags", value: ["a", "b"] },
    { key: "aliases", value: ["One", "Two"] },
    { key: "nested", value: [] },
  ]);
  assert.deepEqual(readProps("no frontmatter"), []);
});

test("setting a property rewrites only its own lines", () => {
  const out = setProp(note, "status", "done");
  assert.equal(out, note.replace("status: active # set by hand\n", "status: done\n"));
  const list = setProp(note, "aliases", ["Uno"]);
  assert.ok(list.includes("aliases: [Uno]\nnested:\n  child: x\n# a comment\n"), "the old - items go, the rest stays");
  assert.deepEqual(readProps(list).find((p) => p.key === "aliases"), { key: "aliases", value: ["Uno"] });
});

test("new properties go before the closing fence; notes without frontmatter get one", () => {
  const out = setProp(note, "due", "2026-11-01");
  assert.ok(out.includes("# a comment\ndue: 2026-11-01\n---\nBody text."));
  assert.equal(setProp("Just text", "status", "open"), "---\nstatus: open\n---\nJust text");
});

test("values YAML would misread are quoted, and read back unchanged", () => {
  for (const v of ["a: b", "#tag", "- dash", " padded", "", "[x]", "it's", 'say "hi"']) {
    const out = setProp(note, "v", v);
    assert.equal(readProps(out).find((p) => p.key === "v")!.value, v, `round-trip ${JSON.stringify(v)}`);
  }
  assert.ok(setProp(note, "done", "true").includes("done: true\n"), "booleans stay booleans");
});

test("removing the last property removes the frontmatter block", () => {
  assert.equal(removeProp("---\nstatus: open\n---\nBody", "status"), "Body");
  assert.ok(!removeProp(note, "aliases").includes("One"));
  assert.equal(removeProp(note, "missing"), note);
});

test("edits become one minimal change for the editor", () => {
  const a = note, b = setProp(note, "status", "done");
  const c = diffChange(a, b);
  assert.equal(a.slice(0, c.from) + c.insert + a.slice(c.to), b);
  assert.ok(c.to - c.from < 30, "only the edited line is replaced");
});

test("body leaves out the properties block", () => {
  assert.equal(body("---\ntags: [a]\n---\n# Title\n"), "# Title\n");
  assert.equal(body("# No properties\n"), "# No properties\n");
  assert.equal(body("---\nunclosed\n"), "---\nunclosed\n");
});
