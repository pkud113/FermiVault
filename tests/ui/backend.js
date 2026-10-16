// @ts-nocheck -- injected into the test page as plain JS; not part of the app.
// A stand-in for FermiVault's Rust backend, injected into the page before the app loads so the
// real frontend build runs in a headless browser (see harness.mjs). Notes live in memory.
// `window.__fv` lets tests control it: hold or fail commands, emit backend events, inspect calls.
(() => {
  const fx = window.__FV_FIXTURE__;
  const root = fx.root;
  const files = new Map(Object.entries(fx.files)); // path -> text (null: binary, served over http)
  const dirs = new Set(fx.dirs);
  let config = {};

  const fv = (window.__fv = {
    calls: [],
    unknown: new Set(),
    held: new Map(), // cmd -> [{ args, release(), fail(msg) }]
    holding: new Set(),
    failing: new Map(), // cmd -> message
    hold(cmd) {
      this.holding.add(cmd);
    },
    unhold(cmd) {
      this.holding.delete(cmd);
    },
    /** Settles the n-th held call of `cmd` (in call order); `error` makes it fail. */
    release(cmd, n, error) {
      const h = this.held.get(cmd)?.[n];
      if (!h) throw new Error(`no held ${cmd} call #${n}`);
      error ? h.fail(error) : h.release();
    },
    fail(cmd, message) {
      message === null ? this.failing.delete(cmd) : this.failing.set(cmd, message);
    },
    emit(event, payload) {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
    },
    files,
  });

  // ---- callbacks and events (what @tauri-apps/api expects of window.__TAURI_INTERNALS__) ----
  const callbacks = new Map();
  let nextId = 1;
  const listeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_e, id) => callbacks.delete(id) };

  // ---- vault model ----
  const isMd = (p) => p.endsWith(".md");
  const base = (p) => p.split("/").pop().replace(/\.md$/, "");
  const notes = () => [...files.keys()].filter(isMd);
  const resolve = (target) => {
    const t = target.split("#")[0].split("|")[0].trim().replace(/\.md$/, "").toLowerCase();
    return notes().find((p) => p.replace(/\.md$/, "").toLowerCase() === t) ?? notes().find((p) => base(p).toLowerCase() === t) ?? null;
  };
  const links = (text) => [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  function entries() {
    const all = [...dirs].map((path) => ({ path, dir: true })).concat([...files.keys()].map((path) => ({ path, dir: false })));
    const kids = (dir) =>
      all
        .filter((e) => (e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "") === dir)
        .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.path.toLowerCase().localeCompare(b.path.toLowerCase())));
    const out = [];
    const walk = (dir) => kids(dir).forEach((e) => (out.push(e), e.dir && walk(e.path)));
    walk("");
    return out;
  }
  function props(text) {
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    const out = {};
    for (const line of m ? m[1].split("\n") : []) {
      const kv = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
      if (kv) out[kv[1].trim()] = kv[2].replace(/^\[(.*)\]$/, "$1").trim();
    }
    return out;
  }
  const tagsOf = (text) => [
    ...(props(text).tags ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...[...text.replace(/```[\s\S]*?```/g, "").matchAll(/(?:^|\s)#([\p{L}\d_/-]+)/gu)].map((m) => m[1]),
  ];
  /** Enough of the ```table``` language for the fixtures: `from: #tag`, `sort`, `columns`. */
  function query(text) {
    const opt = Object.fromEntries(text.split("\n").map((l) => l.split(/:(.*)/s).map((s) => s.trim())).filter((x) => x[0]));
    const tag = /#(\S+)/.exec(opt.from ?? "")?.[1];
    const columns = (opt.columns ?? "file").split(",").map((s) => s.trim());
    let rows = notes()
      .filter((p) => !tag || tagsOf(files.get(p)).includes(tag))
      .map((path) => ({ path, cells: columns.map((c) => (c === "file" ? base(path) : props(files.get(path))[c] ?? "")) }));
    const [key, dir] = (opt.sort ?? "").split(/\s+/);
    const i = columns.indexOf(key);
    if (i >= 0) rows.sort((a, b) => a.cells[i].localeCompare(b.cells[i]) * (dir === "desc" ? -1 : 1));
    return { columns, rows, total: rows.length };
  }

  const handlers = {
    last_vault: () => root,
    open_vault: () => root,
    bench_ready: () => null,
    list_files: () => entries(),
    read_note: ({ path }) => {
      if (!files.has(path) || files.get(path) === null) throw `${path}: not found`;
      return files.get(path);
    },
    write_note: ({ path, content }) => (files.set(path, content), false),
    create_note: ({ path, content }) => {
      if (files.has(path)) throw `${path} already exists`;
      files.set(path, content ?? "");
    },
    create_folder: ({ path }) => void dirs.add(path),
    rename_path: ({ from, to }) => {
      files.set(to, files.get(from));
      files.delete(from);
      return 0;
    },
    trash_path: ({ path }) => void files.delete(path),
    search: ({ query: q }) =>
      notes()
        .filter((p) => files.get(p).toLowerCase().includes(q.toLowerCase()))
        .slice(0, 50)
        .map((path) => ({ path, snippet: `…**${q}**…` })),
    query: ({ text }) => query(text),
    backlinks: ({ path }) =>
      notes().flatMap((p) =>
        files.get(p).split("\n").flatMap((line, i) => (links(line).some((l) => resolve(l) === path) ? [{ path: p, line: i + 1, context: line }] : [])),
      ),
    resolve_link: ({ target }) => resolve(target),
    graph: () => ({
      nodes: notes(),
      edges: notes().flatMap((p) => links(files.get(p)).map(resolve).filter((d) => d && d !== p).map((d) => [p, d])),
    }),
    tags: () => {
      const n = new Map();
      for (const p of notes()) for (const t of new Set(tagsOf(files.get(p)))) n.set(t, (n.get(t) ?? 0) + 1);
      return [...n];
    },
    tagged: ({ tag }) => notes().filter((p) => tagsOf(files.get(p)).includes(tag)),
    vault_config: () => config,
    set_vault_config: ({ value }) => void (config = value),
    snapshots: () => [],
    related: () => [],
    ai_context: () => [],
    embed_status: () => ({ installed: false, running: false, pending: 0, total: 0, model: "" }),
    ai_detect: () => [],
    ai_apps: () => [],
    ai_has_key: () => false,
    plugins_list: () => [],
    git_status: () => ({ git: true, repo: false, trusted: false, branch: null, remote: null, changes: 0 }),
    "plugin:event|listen": ({ event, handler }) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return handler;
    },
    "plugin:event|unlisten": () => null,
    "plugin:dialog|ask": () => true,
    "plugin:dialog|open": () => null,
  };

  async function invoke(cmd, args = {}) {
    fv.calls.push({ cmd, args });
    if (fv.holding.has(cmd)) {
      await new Promise((release, reject) => {
        const list = fv.held.get(cmd) ?? [];
        list.push({ args, release, fail: (m) => reject(m) });
        fv.held.set(cmd, list);
      });
    }
    if (fv.failing.has(cmd)) throw fv.failing.get(cmd);
    const h = handlers[cmd];
    if (!h) {
      if (!cmd.startsWith("plugin:")) fv.unknown.add(cmd);
      return null;
    }
    return h(args);
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(cb, once) {
      const id = nextId++;
      callbacks.set(id, (data) => (once && callbacks.delete(id), cb?.(data)));
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (path) => "/__vault/" + path.slice(root.length + 1).split(/[\\/]/).map(encodeURIComponent).join("/"),
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  };
})();
