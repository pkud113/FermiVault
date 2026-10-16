// README screenshots of the real app, taken in CI (.github/workflows/screenshots.yml):
//   node scripts/screenshots.mjs <fermivault.exe> <out-dir>
// Writes a small demo vault, launches the app with WebView2's DevTools port open, drives it
// through the DevTools protocol and saves PNGs. Windows only.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const [exe, out] = process.argv.slice(2);
if (!exe || !out) throw new Error("usage: node scripts/screenshots.mjs <fermivault.exe> <out-dir>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Demo vault -----------------------------------------------------------------------------
const vault = mkdtempSync(join(tmpdir(), "FermiVault demo-"));
const notes = {
  "Local-first software.md": `---
tags: [research, sync]
status: reading
source: https://www.inkandswitch.com/local-first/
---
# Local-first software

Apps where **your data lives on your device** and sync is optional. Notes here are plain Markdown files, so any editor, script or AI app can read them. See [[Sync options]] and [[Search that stays fast]].

> [!tip] Why it matters
> Nothing to export, nothing to lose when a service shuts down. The files *are* the database.

## Seven ideals
- [x] Fast: no spinners
- [x] Multi-device
- [x] Offline by default
- [ ] Collaboration, without a central server

## How a write flows
\`\`\`mermaid
graph LR
  Editor --> File[.md file] --> Index[(SQLite index)]
  Index --> Search
  Index --> MCP[AI apps over MCP]
\`\`\`

Sync conflicts resolve to the version with the newest clock, roughly $t_{merge} = \\max(t_a, t_b)$.

#local-first
`,
  "Sync options.md": `---
tags: [research, sync]
status: done
---
# Sync options

Compared for [[Local-first software]]: Git (history, any host), a folder sync service, or none.

| Option | History | Conflicts |
|---|---|---|
| Git | full | both versions kept |
| Folder sync | none | last write wins |
`,
  "Search that stays fast.md": `---
tags: [research, performance]
status: reading
---
# Search that stays fast

Full-text search over SQLite FTS5 with BM25 ranking, plus local embeddings for meaning. Budget: **under 30 ms** on 10,000 notes. Related: [[Local-first software]].
`,
  "Projects/Website relaunch.md": `---
tags: [project]
status: doing
due: 2026-11-20
priority: 1
owner: Sam
---
# Website relaunch

New docs site and download page. Depends on [[Projects/Release 1.0]].
`,
  "Projects/Release 1.0.md": `---
tags: [project]
status: doing
due: 2026-12-01
priority: 1
owner: Alex
---
# Release 1.0

Installers for Windows, macOS and Linux. See [[Search that stays fast]].
`,
  "Projects/Mobile companion.md": `---
tags: [project]
status: todo
due: 2027-02-15
priority: 2
owner: Kim
---
# Mobile companion

Read-only at first. Research: [[Local-first software]], [[Sync options]].
`,
  "Projects/Plugin gallery.md": `---
tags: [project]
status: done
due: 2026-09-30
priority: 3
owner: Sam
---
# Plugin gallery
`,
  "Project board.md": `# Project board

Every note tagged #project, live from their properties.

\`\`\`table
from: #project
sort: due
columns: file, status, due, owner, priority
\`\`\`
`,
  "Journal/2026-10-16.md": `# Friday, October 16

- Reviewed [[Projects/Release 1.0]]
- Read about [[Local-first software]]
`,
};
for (const [path, text] of Object.entries(notes)) {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(join(vault, path), text);
}
const card = (id, x, y, w, h, extra) => ({ id, x, y, width: w, height: h, ...extra });
writeFileSync(
  join(vault, "Release plan.canvas"),
  JSON.stringify({
    nodes: [
      card("g", -40, -60, 980, 420, { type: "group", label: "Release 1.0" }),
      card("a", 0, 0, 260, 120, { type: "text", text: "## Build\nInstallers for all three platforms", color: "5" }),
      card("b", 340, 0, 260, 120, { type: "text", text: "## Test\nBudgets checked on every push", color: "4" }),
      card("c", 680, 0, 220, 120, { type: "text", text: "## Ship\nPublish the release", color: "6" }),
      card("d", 0, 200, 300, 120, { type: "file", file: "Projects/Release 1.0.md" }),
      card("e", 380, 200, 300, 120, { type: "file", file: "Search that stays fast.md" }),
    ],
    edges: [
      { id: "1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" },
      { id: "2", fromNode: "b", fromSide: "right", toNode: "c", toSide: "left" },
      { id: "3", fromNode: "d", fromSide: "top", toNode: "a", toSide: "bottom" },
    ],
  }),
);

// The app reopens the last vault on launch.
const cfg = join(process.env.APPDATA, "dev.fermivault.app");
mkdirSync(cfg, { recursive: true });
writeFileSync(join(cfg, "state.json"), JSON.stringify({ vault }));

// --- Drive the app ---------------------------------------------------------------------------
const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  stdio: "ignore",
});

let target, last;
for (let i = 0; i < 120 && !target; i++) {
  await sleep(500);
  target = await fetch("http://127.0.0.1:9222/json")
    .then((r) => r.json())
    .then((l) => ((last = l), l.find((t) => t.type === "page")))
    .catch((e) => void (last = e.message));
}
if (!target) throw new Error(`no DevTools target: ${JSON.stringify(last)}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id));
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.text}`);
  return r.result.value;
};
const until = async (expr, what) => {
  for (let i = 0; i < 60; i++) {
    if (await js(expr)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
};
/** Clicks the innermost element matching `sel` whose text or aria-label is `label`. */
const click = async (sel, label) => {
  const ok = await js(`(() => {
    const hit = (e) => e.getAttribute("aria-label") === ${JSON.stringify(label)} || e.textContent.trim() === ${JSON.stringify(label)};
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => hit(e) && ![...e.children].some(hit));
    el?.click();
    return !!el;
  })()`);
  if (!ok) throw new Error(`nothing to click: ${sel} "${label}"`);
  await sleep(700);
};
const theme = async (t) => {
  await js(`localStorage.setItem("fv-settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("fv-settings") ?? "{}"), theme: "${t}" })), location.reload()`).catch(() => {});
  await sleep(1500);
  await until(`!!document.querySelector(".shell")`, "the vault to open");
};
mkdirSync(out, { recursive: true });
const shot = async (name) => {
  await sleep(1200);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`saved ${name}.png`);
};
const openNote = async (name) => {
  await click(".shell *", name);
  await until(`!!document.querySelector(".cm-content")`, name);
};

try {
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await until(`!!document.querySelector(".shell")`, "the vault to open");

  await theme("light");
  await openNote("Local-first software");
  await click("button", "Outline");
  await shot("editor");

  await openNote("Project board");
  await click("button", "Properties");
  await shot("tables");

  await theme("dark");
  await click(".shell *", "Release plan.canvas");
  await until(`!!document.querySelector(".canvas .world")`, "the canvas");
  await shot("canvas");

  await click("button", "Graph view");
  await sleep(4000); // layout settles
  await shot("graph");
} finally {
  ws.close();
  spawn("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
}
