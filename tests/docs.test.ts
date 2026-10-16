// Save/load rules for open notes. Run with `pnpm test` (Node's built-in runner, no extra deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDocs, PaneDocs, renameDocs, saveDoc, serial, type Doc } from "../src/lib/docs.ts";

type S = { text: string };
const text = (s: S) => s.text;
const doc = (path: string, saved: string, vault = "V"): Doc<S> => ({ vault, path, saved, state: { text: saved } });

/** A fake disk: `fail` makes the next writes reject, `gate` holds writes until released. */
function disk() {
  const files = new Map<string, string>();
  const writes: string[] = [];
  let fail = 0;
  let gate: Promise<void> | null = null;
  const write = async (vault: string, path: string, t: string, base: string) => {
    if (gate) await gate;
    writes.push(`${vault}:${path}=${t}`);
    if (fail > 0 && fail--) throw new Error("disk full");
    const key = `${vault}:${path}`;
    const conflict = files.has(key) && files.get(key) !== base && files.get(key) !== t;
    files.set(key, t);
    return conflict;
  };
  return {
    files,
    writes,
    write,
    failNext: (n = 1) => void (fail = n),
    hold() {
      let open!: () => void;
      gate = new Promise((r) => (open = r));
      return () => ((gate = null), open());
    },
  };
}

test("a failed save stays dirty and is retried without more typing (R1)", async () => {
  const fs = disk();
  const d = doc("a.md", "old");
  d.state = { text: "new" };
  fs.failNext();
  await assert.rejects(saveDoc(d, text, fs.write));
  assert.equal(d.saved, "old", "baseline must not advance on failure");
  await saveDoc(d, text, fs.write);
  assert.equal(fs.files.get("V:a.md"), "new");
  assert.equal(fs.writes.length, 2, "the retry actually wrote");
});

test("saves run in order and the latest text wins (R1)", async () => {
  const fs = disk();
  const d = doc("a.md", "");
  const release = fs.hold();
  d.state = { text: "one" };
  const first = saveDoc(d, text, fs.write);
  d.state = { text: "two" };
  const second = saveDoc(d, text, fs.write);
  release();
  await Promise.all([first, second]);
  assert.equal(fs.files.get("V:a.md"), "two");
  assert.equal(d.saved, "two");
});

test("a save queued after a rename writes the new path, never the old one (R3)", async () => {
  const fs = disk();
  const d = doc("dir/a.md", "x");
  d.state = { text: "edited" };
  await serial(async () => renameDocs([d], "dir", "moved"));
  await saveDoc(d, text, fs.write);
  assert.deepEqual([...fs.files.keys()], ["V:moved/a.md"]);
});

test("trashed or closed-vault notes are never written again (R2, R3)", async () => {
  const fs = disk();
  const a = doc("a.md", "a"), b = doc("keep.md", "b");
  a.state = { text: "dirty" };
  b.state = { text: "dirty" };
  const rest = closeDocs([a, b], "a.md");
  assert.deepEqual(rest, [b]);
  await saveDoc(a, text, fs.write);
  assert.equal(fs.writes.length, 0);
  closeDocs(rest, null); // vault switch
  await saveDoc(b, text, fs.write);
  assert.equal(fs.writes.length, 0);
});

test("a save already queued when the vault switches doesn't write into it (R2)", async () => {
  const fs = disk();
  const d = doc("same.md", "A", "VaultA");
  d.state = { text: "PRIVATE A" };
  const release = fs.hold();
  const pending = saveDoc(d, text, fs.write); // queued before the switch...
  const switched = serial(async () => void closeDocs([d], null)); // ...the switch runs after it
  release();
  await Promise.all([pending, switched]);
  assert.deepEqual(fs.writes, ["VaultA:same.md=PRIVATE A"], "the old note went to its own vault, once");
  d.state = { text: "later" };
  await saveDoc(d, text, fs.write);
  assert.equal(fs.writes.length, 1);
});

function pane(files: Record<string, string>, saved: string[] = []) {
  const reads = new Map<string, () => void>();
  let slow = false;
  const p = new PaneDocs<S>({
    read: async (path) => {
      if (slow) await new Promise<void>((r) => reads.set(path, r));
      if (!(path in files)) throw new Error(`${path}: not found`);
      return files[path];
    },
    create: (t) => ({ text: t }),
    text,
    vault: () => "V",
    save: (d) => saved.push(`${d.path}=${d.state.text}`),
  });
  return { p, finish: (path: string) => reads.get(path)!(), slow: (on = true) => void (slow = on) };
}

test("nothing is bound to a note until it has loaded; a failed load binds nothing (R4)", async () => {
  const saved: string[] = [];
  const { p, finish, slow } = pane({ "a.md": "A" }, saved);
  await p.open("a.md");
  p.doc!.state = { text: "A edited" };
  slow();
  const loading = p.open("missing.md");
  assert.equal(p.doc, null, "while loading, edits have no doc to land in");
  assert.deepEqual(saved, ["a.md=A edited"], "the outgoing note is saved under its own path");
  finish("missing.md");
  assert.ok("error" in (await loading)!);
  assert.equal(p.doc, null);
  assert.ok(!p.docs.some((d) => d.path === "missing.md"));
});

test("rapid A -> B -> A keeps only the last load, and unsaved edits survive the round trip (R4)", async () => {
  const { p, finish, slow } = pane({ "a.md": "A", "b.md": "B" });
  await p.open("a.md");
  p.doc!.state = { text: "A unsaved" };
  slow();
  const toB = p.open("b.md");
  const backToA = p.open("a.md");
  finish("b.md");
  finish("a.md");
  assert.equal(await toB, null, "superseded");
  const r = await backToA;
  assert.ok(r && "doc" in r);
  assert.equal(r.doc.path, "a.md");
  assert.equal(r.doc.state.text, "A unsaved");
  assert.equal(p.doc, r.doc);
});

test("a clean note reloads from disk when disk changed while it was in the background", async () => {
  const files = { "a.md": "v1", "b.md": "B" };
  const { p } = pane(files);
  await p.open("a.md");
  await p.open("b.md");
  files["a.md"] = "v2";
  const r = await p.open("a.md");
  assert.ok(r && "doc" in r);
  assert.equal(r.doc.state.text, "v2");
});

test("renaming while a load is in flight restarts it at the new path (R3/R4)", async () => {
  const { p, finish, slow } = pane({ "old.md": "x" });
  slow();
  const loading = p.open("old.md");
  assert.equal(p.renamed("old.md", "new.md"), "new.md", "caller must reload");
  assert.equal(p.target, "new.md");
  finish("old.md");
  await loading;
  assert.ok(!p.docs.some((d) => d.path === "old.md"), "the old path is never bound");
});

test("a save reports when disk changed since the last sync, and passes the right base (R5)", async () => {
  const fs = disk();
  const d = doc("a.md", "v1");
  fs.files.set("V:a.md", "v1");
  d.state = { text: "mine" };
  assert.equal(await saveDoc(d, text, fs.write), false, "disk still had our base");
  fs.files.set("V:a.md", "agent edit"); // someone else writes
  d.state = { text: "mine 2" };
  assert.equal(await saveDoc(d, text, fs.write), true, "conflict reported");
});
