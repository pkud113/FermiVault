// The plugin API: what runs inside each plugin's Web Worker (PRELUDE) and the permission rules
// the app enforces on every request (`dispatch`). Pure, so tests/plugins.test.ts runs the real
// worker-side code in a sandbox. See docs/PLUGINS.md for the plugin author's view.

export type Permission = "read" | "write" | "editor";

/** What each permission lets a plugin do, as shown when the user enables it. */
export const PERMISSIONS: Record<Permission, string> = {
  read: "Read every note and search the vault",
  write: "Create and change notes (each change can be undone from File recovery)",
  editor: "Read and replace the text you have selected",
};

/** The permission each API call needs (`null`: always allowed). */
const NEEDS: Record<string, Permission | null> = {
  notice: null,
  prompt: null,
  "vault.list": "read",
  "vault.read": "read",
  "vault.search": "read",
  "vault.query": "read",
  "vault.backlinks": "read",
  "vault.create": "write",
  "vault.write": "write",
  "vault.append": "write",
  "editor.selection": "editor",
  "editor.replaceSelection": "editor",
  "editor.insert": "editor",
};

export const knownPermission = (p: unknown): p is Permission => p === "read" || p === "write" || p === "editor";

export type Impl = Record<string, (...args: string[]) => unknown>;

/** Answers one request from a plugin: unknown methods and missing permissions are refused, and
 *  arguments are coerced to strings so nothing but text crosses into the app. */
export async function dispatch(method: string, args: unknown[], granted: readonly string[], impl: Impl): Promise<unknown> {
  // Own properties only: `"__proto__" in NEEDS` would be true.
  if (!Object.hasOwn(NEEDS, method) || !Object.hasOwn(impl, method)) throw new Error(`unknown API call: ${method}`);
  const need = NEEDS[method];
  if (need && !granted.includes(need)) throw new Error(`${method} needs the "${need}" permission, which this plugin wasn't given`);
  return impl[method](...args.slice(0, 4).map((a) => (a === undefined ? "" : String(a))));
}

/** Prepended to a plugin's main.js inside its worker: defines the global `fermi`. */
export function prelude(manifest: unknown): string {
  return `"use strict";
const fermi = (() => {
  let seq = 0;
  const pending = new Map(), commands = new Map(), listeners = new Map();
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    postMessage({ t: "call", id, method, args });
  });
  const report = (err) => postMessage({ t: "error", message: String((err && err.message) || err) });
  self.onmessage = async (e) => {
    const m = e.data || {};
    if (m.t === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
    } else if (m.t === "run") {
      try { await commands.get(m.id)?.(); } catch (err) { report(err); }
    } else if (m.t === "event") {
      for (const f of listeners.get(m.name) || []) { try { await f(m.data); } catch (err) { report(err); } }
    }
  };
  const vault = {
    list: () => call("vault.list"),
    read: (path) => call("vault.read", path),
    search: (query) => call("vault.search", query),
    query: (table) => call("vault.query", table),
    backlinks: (path) => call("vault.backlinks", path),
    create: (path, text) => call("vault.create", path, text),
    write: (path, text) => call("vault.write", path, text),
    append: (path, text) => call("vault.append", path, text),
  };
  const editor = {
    selection: () => call("editor.selection"),
    replaceSelection: (text) => call("editor.replaceSelection", text),
    insert: (text) => call("editor.insert", text),
  };
  return Object.freeze({
    manifest: Object.freeze(${JSON.stringify(manifest ?? {})}),
    notice: (text) => call("notice", text),
    prompt: (title, value) => call("prompt", title, value),
    commands: Object.freeze({
      add(spec, run) {
        if (!spec || typeof run !== "function") throw new Error("commands.add({ id, name }, fn)");
        commands.set(String(spec.id), run);
        postMessage({ t: "command", id: String(spec.id), name: String(spec.name || spec.id) });
      },
    }),
    on(name, fn) { listeners.set(String(name), [...(listeners.get(String(name)) || []), fn]); },
    vault: Object.freeze(vault),
    editor: Object.freeze(editor),
  });
})();
self.fermi = fermi;
`;
}
