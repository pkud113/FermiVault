// Runs enabled plugins, each in its own Web Worker. A worker has no DOM and no access to the
// app's IPC (that needs a per-launch key only the main window has), and the page's CSP blocks
// network requests and remote scripts. So a plugin can only post messages; `dispatch` answers
// them within the permissions the user granted when enabling it.

import { api, basename, type VaultConfig } from "./api";
import { dispatch, knownPermission, prelude, type Impl } from "./pluginApi";
import { serial } from "./docs";
import { app, type Command } from "./store.svelte";

type Running = { worker: Worker; name: string; granted: string[] };
const running = new Map<string, Running>();

export type PluginGrant = NonNullable<VaultConfig["plugins"]>[string];

/** The app side of every API call. Writes go through the same queue and lock as everything else. */
const impl: Impl = {
  notice: (text) => void (app.notice = text),
  prompt: (title, value) => app.ask(title || "Plugin", value),
  "vault.list": () => app.files.filter((f) => !f.dir).map((f) => f.path),
  "vault.read": (path) => api.read(path),
  "vault.search": (q) => api.search(q),
  "vault.query": (text) => api.query(text),
  "vault.backlinks": (path) => api.backlinks(path),
  "vault.create": async (path, text) => {
    await serial(() => api.pluginWrite(path, text, true));
    await app.refreshFiles();
  },
  "vault.write": async (path, text) => {
    await serial(() => api.pluginWrite(path, text, false));
    app.version++;
  },
  "vault.append": async (path, text) => {
    const old = await api.read(path);
    await serial(() => api.pluginWrite(path, old + (old && !old.endsWith("\n") ? "\n" : "") + text, false));
    app.version++;
  },
  "editor.selection": () => {
    const doc = app.focusedEditor()?.doc();
    if (!doc) return null;
    const s = doc.state.selection.main;
    return { path: doc.path, text: doc.state.sliceDoc(s.from, s.to) };
  },
  "editor.replaceSelection": (text) => {
    const ed = app.focusedEditor(), doc = ed?.doc();
    if (!ed || !doc) throw new Error("no note is open");
    ed.apply(doc, doc.state.replaceSelection(text));
  },
  "editor.insert": (text) => {
    const ed = app.focusedEditor(), doc = ed?.doc();
    if (!ed || !doc) throw new Error("no note is open");
    ed.apply(doc, { changes: { from: doc.state.selection.main.head, insert: text } });
  },
};

function start(id: string, manifest: Record<string, unknown>, source: string, granted: string[]) {
  const name = typeof manifest.name === "string" ? manifest.name : id;
  const url = URL.createObjectURL(new Blob([prelude({ ...manifest, id }), "\n", source], { type: "text/javascript" }));
  const worker = new Worker(url, { name: `plugin:${id}` });
  URL.revokeObjectURL(url);
  running.set(id, { worker, name, granted });
  worker.onmessage = async (e) => {
    const m = e.data ?? {};
    if (m.t === "command" && typeof m.id === "string") {
      const cmd: Command = { id: `plugin:${id}:${m.id}`, name: `${name}: ${String(m.name).slice(0, 80)}`, run: () => worker.postMessage({ t: "run", id: m.id }) };
      app.pluginCommands = [...app.pluginCommands.filter((c) => c.id !== cmd.id), cmd];
    } else if (m.t === "call") {
      try {
        const value = await dispatch(String(m.method), Array.isArray(m.args) ? m.args : [], granted, impl);
        worker.postMessage({ t: "result", id: m.id, ok: true, value });
      } catch (err) {
        worker.postMessage({ t: "result", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (m.t === "error") app.error = `Plugin ${name}: ${String(m.message).slice(0, 300)}`;
  };
  worker.onerror = (e) => {
    e.preventDefault();
    app.error = `Plugin ${name}: ${e.message}`;
  };
}

/** Stops every plugin (the vault is closing or switching). */
export function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

function stop(id: string) {
  running.get(id)?.worker.terminate();
  running.delete(id);
  app.pluginCommands = app.pluginCommands.filter((c) => !c.id.startsWith(`plugin:${id}:`));
}

let syncing: Promise<void> = Promise.resolve();

/** Starts the plugins enabled for this vault and stops the rest (call after opening a vault or
 *  changing plugin settings). Grants are re-read, so a changed grant restarts the plugin.
 *  Calls run one after another, so a plugin is never started twice. */
export function syncPlugins() {
  return (syncing = syncing.then(syncNow, syncNow));
}

async function syncNow() {
  const grants = app.root ? (app.config.plugins ?? {}) : {};
  const installed = app.root ? await api.pluginsList().catch(() => []) : [];
  const wanted = new Map(installed.filter((p) => !p.error && grants[p.id]?.enabled).map((p) => [p.id, p]));
  for (const [id, r] of running) {
    const g = grants[id];
    if (!wanted.has(id) || !g || g.permissions.join() !== r.granted.join()) stop(id);
  }
  for (const [id, p] of wanted) {
    if (running.has(id)) continue;
    try {
      const source = await api.pluginSource(id);
      start(id, p.manifest as Record<string, unknown>, source, grants[id].permissions.filter(knownPermission));
    } catch (e) {
      app.error = `Plugin ${id}: ${e}`;
    }
  }
}

/** Tells running plugins about something that happened (`file-open`, `vault-change`). */
export function emit(name: string, data: unknown) {
  for (const r of running.values()) r.worker.postMessage({ t: "event", name, data });
}

export const pluginName = (p: { id: string; manifest: unknown }) => {
  const m = p.manifest as Record<string, unknown> | null;
  return typeof m?.name === "string" ? m.name : basename(p.id);
};
