// Rendered UI tests: the production build (`pnpm build`) in headless Chrome/Edge, with the Rust
// backend replaced by backend.js and the vault by fixtures/test-vault. Pages are driven through
// the DevTools protocol (no extra dependencies). `pnpm test:ui`; screenshots land in tests/ui/out/.
// Set FV_BROWSER to a Chrome/Chromium/Edge binary if it isn't found.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const BUILD = join(repo, "build");
const VAULT = join(repo, "fixtures", "test-vault");
export const OUT = join(repo, "tests", "ui", "out");
const ROOT = "C:\\Vaults\\test-vault"; // what the app is told the vault path is

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".pdf": "application/pdf", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
const TEXT = new Set([".md", ".canvas", ".json", ".txt"]);

/** The fixture vault as the backend mock sees it (binary files are served over http instead). */
function fixture(extra = {}) {
  const files = {}, dirs = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const p = join(d, name), rel = relative(VAULT, p).split("\\").join("/");
      if (statSync(p).isDirectory()) (dirs.push(rel), walk(p));
      else files[rel] = TEXT.has(extname(name)) ? readFileSync(p, "utf8") : null;
    }
  };
  walk(VAULT);
  return { root: ROOT, files: { ...files, ...extra }, dirs };
}

function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = url.startsWith("/__vault/") ? join(VAULT, url.slice(9)) : join(BUILD, url);
    if (!url.startsWith("/__vault/") && (!existsSync(file) || statSync(file).isDirectory())) file = join(BUILD, "index.html");
    if (!existsSync(file)) return void (res.writeHead(404), res.end());
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function findBrowser() {
  const candidates = [
    process.env.FV_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error("No Chrome, Chromium or Edge found; set FV_BROWSER");
  return found;
}

/** A DevTools connection; `session` targets one page when given. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    this.events = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject, method } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

let shared = null;

/** Starts the server and browser once per test file; `close()` stops both. */
export async function browser() {
  if (shared) return shared;
  if (!existsSync(join(BUILD, "index.html"))) throw new Error("Run `pnpm build` first");
  mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const profile = mkdtempSync(join(tmpdir(), "fv-ui-"));
  const proc = spawn(findBrowser(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb", "--disable-lcd-text", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    proc.stderr.on("data", (d) => {
      err += d;
      const m = /DevTools listening on (ws:\S+)/.exec(err);
      if (m) resolve(m[1]);
    });
    proc.on("exit", () => reject(new Error(`browser exited: ${err.slice(-500)}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const cdp = new Cdp(ws);
  const port = server.address().port;
  shared = {
    cdp,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      ws.close();
      proc.kill();
      server.close();
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
      shared = null;
    },
  };
  return shared;
}

const KEYS = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Backspace: 8, "\\": 220, F2: 113 };

/** Opens the app in a fresh, isolated page.
 *  opts: width/height, settings (fv-settings), files (extra or replaced vault files), theme. */
export async function open(opts = {}) {
  const b = await browser();
  const { cdp } = b;
  const { browserContextId } = await cdp.send("Target.createBrowserContext");
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  const width = opts.width ?? 1280, height = opts.height ?? 820;
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("Runtime.enable");
  const settings = { theme: "light", ...opts.settings };
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__FV_FIXTURE__ = ${JSON.stringify(fixture(opts.files))};
      try { if (!sessionStorage.getItem("fv-init")) { localStorage.setItem("fv-settings", ${JSON.stringify(JSON.stringify(settings))}); sessionStorage.setItem("fv-init", "1"); } } catch {}
      ${readFileSync(new URL("./backend.js", import.meta.url), "utf8")}`,
  });
  await send("Page.navigate", { url: b.origin + "/" });

  const page = {
    width,
    height,
    async js(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    /** Waits until `expr` is truthy (returns its value). */
    async until(expr, what = expr, ms = 8000) {
      const end = Date.now() + ms;
      for (;;) {
        const v = await page.js(expr).catch(() => null);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
      }
    },
    async settle(ms = 250) {
      await sleep(ms);
      await page.js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    },
    /** Bounding box of the first element matching `sel` (null if none or not rendered). */
    box(sel) {
      return page.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
        const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; })()`);
    },
    text(sel) {
      return page.js(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
    },
    /** Clicks the innermost element matching `sel` whose text or aria-label is `label` (or the first match). */
    async click(sel, label, opts = {}) {
      const pos = await page.js(`(() => {
        const want = ${JSON.stringify(label ?? null)};
        const hit = (e) => want === null || e.getAttribute("aria-label") === want || e.textContent.trim() === want;
        const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => hit(e) && ![...e.children].some((c) => c.matches(${JSON.stringify(sel)}) && hit(c)));
        if (!el) return null;
        el.scrollIntoView({ block: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!pos) throw new Error(`nothing to click: ${sel} ${label ?? ""}`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pos.x, y: pos.y, button: "left", clickCount: 1, modifiers: opts.ctrl ? 2 : 0 });
      await page.settle(120);
    },
    /** A key or combo like "Ctrl+\\", "Escape", "Ctrl+Shift+F". */
    async key(combo) {
      const parts = combo.split("+");
      const key = parts.pop();
      const mod = (parts.includes("Alt") ? 1 : 0) | (parts.includes("Ctrl") ? 2 : 0) | (parts.includes("Shift") ? 8 : 0);
      const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
      const ch = key.length === 1 ? key : undefined;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch && parts.includes("Shift") ? ch.toUpperCase() : key, windowsVirtualKeyCode: code, modifiers: mod, text: key === "Enter" ? "\r" : !mod && ch ? ch : undefined });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, modifiers: mod });
      await page.settle(80);
    },
    async type(text) {
      await send("Input.insertText", { text });
      await page.settle(80);
    },
    async resize(w, h = height) {
      page.width = w;
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.settle(200);
    },
    async shot(name) {
      await page.settle(150);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    },
    async reload() {
      await send("Page.reload");
      await page.until(`!!document.querySelector(".shell")`, "the vault to open");
    },
    /** Opens a vault file from the file tree (top-level names, or "folder/name"). */
    async openFile(name, opts = {}) {
      const label = name.split("/").pop();
      if (name.includes("/")) {
        const dir = name.split("/")[0];
        await page.js(`(() => { const r = [...document.querySelectorAll(".tree .row, [data-i]")].find((e) => e.textContent.trim() === ${JSON.stringify(dir)}); r && r.textContent.includes("▸") && r.click(); })()`);
        await page.settle(100);
      }
      await page.click("[data-i]", label, opts);
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId });
      await cdp.send("Target.disposeBrowserContext", { browserContextId });
    },
  };
  await page.until(`!!document.querySelector(".shell")`, "the vault to open", 15000);
  await page.settle(300);
  return page;
}

/** Fails if `a` and `b` overlap horizontally by more than 1px. */
export function noOverlap(a, b, what) {
  if (a && b && a.x < b.right - 1 && b.x < a.right - 1) throw new Error(`${what}: ${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`);
}
