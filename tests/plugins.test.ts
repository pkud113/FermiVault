// Plugin API: the worker-side code and the app's permission checks. Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { dispatch, knownPermission, prelude, type Impl } from "../src/lib/pluginApi.ts";

const impl: Impl = {
  notice: (t) => `noticed ${t}`,
  prompt: () => "answer",
  "vault.list": () => ["a.md", "b.md"],
  "vault.read": (p) => `text of ${p}`,
  "vault.search": () => [],
  "vault.query": () => ({}),
  "vault.backlinks": () => [],
  "vault.create": (p) => `created ${p}`,
  "vault.write": (p) => `wrote ${p}`,
  "vault.append": (p) => `appended ${p}`,
  "editor.selection": () => ({ path: "a.md", text: "sel" }),
  "editor.replaceSelection": (t) => `replaced with ${t}`,
  "editor.insert": (t) => `inserted ${t}`,
};

test("calls need the permission the user granted", async () => {
  assert.deepEqual(await dispatch("vault.list", [], ["read"], impl), ["a.md", "b.md"]);
  await assert.rejects(dispatch("vault.read", ["a.md"], [], impl), /needs the "read" permission/);
  await assert.rejects(dispatch("vault.write", ["a.md", "x"], ["read"], impl), /"write"/);
  await assert.rejects(dispatch("editor.selection", [], ["read", "write"], impl), /"editor"/);
  assert.equal(await dispatch("notice", ["hi"], [], impl), "noticed hi", "notices need no permission");
});

test("unknown calls are refused and arguments arrive as plain text", async () => {
  await assert.rejects(dispatch("invoke", ["read_note"], ["read", "write", "editor"], impl), /unknown API call/);
  await assert.rejects(dispatch("__proto__", [], ["read"], impl), /unknown API call/);
  assert.equal(await dispatch("vault.read", [{ toString: () => "x.md" }], ["read"], impl), "text of x.md");
  assert.equal(await dispatch("vault.read", [undefined], ["read"], impl), "text of ");
  assert.ok(knownPermission("read") && !knownPermission("network"));
});

/** Runs the real worker prelude plus `source` in a sandbox, wired to `dispatch` like the app does. */
function worker(source: string, granted: string[]) {
  const sent: any[] = [];
  const ctx: any = { postMessage: (m: any) => (sent.push(m), deliver(m)), console };
  ctx.self = ctx;
  vm.createContext(ctx);
  async function deliver(m: any) {
    if (m.t !== "call") return;
    try {
      const value = await dispatch(m.method, m.args, granted, impl);
      ctx.onmessage({ data: { t: "result", id: m.id, ok: true, value } });
    } catch (e) {
      ctx.onmessage({ data: { t: "result", id: m.id, ok: false, error: (e as Error).message } });
    }
  }
  vm.runInContext(prelude({ id: "demo", name: "Demo" }) + "\n" + source, ctx);
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return { ctx, sent, tick, run: async (id: string) => (ctx.onmessage({ data: { t: "run", id } }), await tick()) };
}

test("a plugin registers commands and calls the API through messages only", async () => {
  const w = worker(
    `fermi.commands.add({ id: "count", name: "Count notes" }, async () => {
       const notes = await fermi.vault.list();
       await fermi.notice(notes.length + " notes; manifest " + fermi.manifest.name);
     });`,
    ["read"],
  );
  const plain = (x: unknown) => JSON.parse(JSON.stringify(x)); // objects from the sandbox have its own prototypes
  assert.deepEqual(plain(w.sent[0]), { t: "command", id: "count", name: "Count notes" });
  await w.run("count");
  const calls = plain(w.sent.filter((m) => m.t === "call").map((m) => [m.method, ...m.args]));
  assert.deepEqual(calls, [["vault.list"], ["notice", "2 notes; manifest Demo"]]);
});

test("a refused call becomes an error inside the plugin, reported to the app", async () => {
  const w = worker(
    `fermi.commands.add({ id: "x", name: "X" }, async () => { await fermi.vault.write("a.md", "pwned"); });`,
    ["read"],
  );
  await w.run("x");
  assert.ok(!w.sent.some((m) => m.method === "vault.write" && m.ok), "the write never ran");
  assert.match(w.sent.find((m) => m.t === "error").message, /needs the "write" permission/);
});

test("the API object can't be tampered with by the plugin", async () => {
  const w = worker(`const real = fermi.vault.read; try { fermi.vault.read = () => "fake"; fermi.vault = {}; } catch {} self.same = fermi.vault.read === real;`, []);
  assert.equal(w.ctx.same, true);
});

test("the example plugin in docs/plugins works against the real API", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../docs/plugins/word-stats/main.js", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../docs/plugins/word-stats/manifest.json", import.meta.url), "utf8"));
  const w = worker(source, manifest.permissions);
  assert.deepEqual(
    w.sent.filter((m) => m.t === "command").map((m) => m.name),
    ["Count words in vault", "Insert date and time"],
  );
  await w.run("count");
  assert.ok(w.sent.some((m) => m.method === "notice" && /^\d+ words in 2 notes$/.test(m.args[0])), JSON.stringify(w.sent.at(-1)));
  await w.run("date");
  assert.ok(w.sent.some((m) => m.method === "editor.insert" && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(m.args[0])));
  assert.ok(!w.sent.some((m) => m.t === "error"));
});
