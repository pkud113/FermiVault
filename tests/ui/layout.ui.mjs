// Workspace layout as rendered: sidebars, panes and the footer keep their places in every
// sidebar combination, at compact and maximized widths, with split panes and resizing.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

/** Measures the shell and checks that main sits between the sidebars with real width. */
async function layout(page, label) {
  const l = await page.box("aside.left");
  const r = await page.box("aside.right");
  const m = await page.box("main.panes");
  const f = await page.box("footer");
  const panes = await page.js(`[...document.querySelectorAll("main .pane")].map((p) => { const b = p.getBoundingClientRect(); return { x: b.x, w: b.width }; })`);
  const at = `${label} @${page.width}px`;
  assert.ok(m && m.w >= 300, `${at}: main is ${m?.w}px wide`);
  assert.ok(Math.abs(m.x - (l ? l.right : 0)) <= 1, `${at}: main starts at ${m.x}, left sidebar ends at ${l?.right ?? 0}`);
  assert.ok(Math.abs(m.right - (r ? r.x : page.width)) <= 1, `${at}: main ends at ${m.right}, right sidebar starts at ${r?.x ?? page.width}`);
  if (r) assert.ok(Math.abs(r.right - page.width) <= 1, `${at}: right sidebar ends at ${r.right}`);
  if (l) assert.ok(l.x <= 1, `${at}: left sidebar starts at ${l.x}`);
  assert.ok(f && f.x <= 1 && Math.abs(f.w - page.width) <= 1, `${at}: footer spans the window`);
  for (const p of panes) assert.ok(p.w >= 250 && p.x >= m.x - 1 && p.x + p.w <= m.right + 1, `${at}: pane ${JSON.stringify(p)} inside main`);
  // Every pane's tab strip and body is on screen.
  const tabs = await page.js(`[...document.querySelectorAll("main .pane .tabs")].every((t) => t.getBoundingClientRect().width > 200)`);
  assert.ok(tabs, `${at}: tab strips visible`);
  return { left: !!l, right: !!r };
}

const toggle = (page, side) => page.click(".tabs button", side === "left" ? "Toggle left sidebar" : "Toggle right sidebar");

test("all four sidebar combinations keep the workspace in place (maximized)", async () => {
  const page = await open({ width: 1600, height: 900 });
  await page.openFile("Welcome");
  assert.deepEqual(await layout(page, "both"), { left: true, right: true });
  await toggle(page, "left");
  assert.deepEqual(await layout(page, "right only"), { left: false, right: true });
  await page.shot("layout-right-only-1600");
  await toggle(page, "right");
  assert.deepEqual(await layout(page, "neither"), { left: false, right: false });
  await toggle(page, "left");
  assert.deepEqual(await layout(page, "left only"), { left: true, right: false });
  await toggle(page, "right");
  assert.deepEqual(await layout(page, "both again"), { left: true, right: true });
  await page.close();
});

test("compact window: the sidebar opened last wins, in both orders", async () => {
  const page = await open({ width: 812, height: 700 });
  await page.openFile("Welcome");
  // 812px fits one sidebar: left (opened first) by default.
  assert.deepEqual(await layout(page, "default"), { left: true, right: false });
  await toggle(page, "right"); // asks for the right one: it takes priority
  assert.deepEqual(await layout(page, "right requested"), { left: false, right: true });
  await page.shot("layout-compact-right-812");
  await toggle(page, "left"); // left is hidden for room, so this reveals it with priority
  assert.deepEqual(await layout(page, "left requested"), { left: true, right: false });
  await page.close();
});

test("split panes and sidebar resizing keep every pane inside the workspace", async () => {
  const page = await open({ width: 1280, height: 820 });
  await page.openFile("Welcome");
  await page.key("Ctrl+\\");
  await page.openFile("Getting Started");
  await layout(page, "two panes");
  await toggle(page, "left");
  await layout(page, "two panes, no left");
  await page.shot("layout-split-no-left-1280");
  // Resize the right sidebar from the keyboard.
  await page.js(`document.querySelector('aside.right .grip').focus()`);
  for (let i = 0; i < 5; i++) await page.key("ArrowLeft");
  await layout(page, "right widened");
  await page.resize(900);
  await layout(page, "two panes at 900px");
  await page.close();
});
