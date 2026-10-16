// Web clipper note building. Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipFileName, clipNote, uniquePath } from "../src/lib/clipper.ts";
import { readProps } from "../src/lib/frontmatter.ts";

test("file names drop characters no OS allows, and fall back to the site", () => {
  assert.equal(clipFileName('Why "C:\\" paths? A <guide> | part 1/2', "https://x.org"), "Why C paths A guide part 1 2");
  assert.equal(clipFileName("  ...hidden.  ", "https://x.org"), "hidden");
  assert.equal(clipFileName("", "https://blog.example.com/post"), "blog.example.com");
  assert.equal(clipFileName("a".repeat(300), "https://x.org").length, 120);
});

test("the note carries the page's metadata as properties, safely quoted", () => {
  const note = clipNote(
    { title: "Rust: the good parts", author: "Ann #1", published: "2026-09-30T12:00:00Z", description: "Line one\n  line two" },
    "Body **text**.",
    "https://example.com/rust?x=1#y",
    new Date(2026, 9, 15),
  );
  const props = Object.fromEntries(readProps(note).map((p) => [p.key, p.value]));
  assert.deepEqual(props, {
    title: "Rust: the good parts",
    source: "https://example.com/rust?x=1#y",
    author: "Ann #1",
    published: "2026-09-30",
    description: "Line one line two",
    clipped: "2026-10-15",
    tags: ["clipping"],
  });
  assert.ok(note.endsWith("# Rust: the good parts\n\nBody **text**.\n"));
});

test("missing metadata is left out rather than written empty", () => {
  const props = readProps(clipNote({}, "x", "https://site.org/a")).map((p) => p.key);
  assert.deepEqual(props, ["title", "source", "clipped", "tags"]);
});

test("clips never overwrite an existing note", () => {
  const taken = new Set(["clippings/post.md", "clippings/post 2.md"]);
  assert.equal(uniquePath("Clippings", "Post", (p) => taken.has(p)), "Clippings/Post 3.md");
  assert.equal(uniquePath("", "New", () => false), "New.md");
});
