// Rendering still works after the UI changes: tables populate and sort with visible feedback; math,
// Mermaid, callouts and embeds render; canvas and PDF open, in both themes.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

test("tables populate and sort, with the direction shown", async () => {
  const page = await open({ width: 1400 });
  await page.openFile("Project board");
  await page.until(`document.querySelectorAll(".cm-qtable tbody tr").length >= 3`, "table rows");
  const dues = () => page.js(`[...document.querySelector(".cm-qtable").querySelectorAll("tbody tr")].map((r) => r.cells[2].textContent)`);
  const header = () => page.js(`(() => { const th = document.querySelector(".cm-qtable thead th:nth-child(3)"); return [th.getAttribute("aria-sort"), th.textContent.trim()]; })()`);
  await page.click(".cm-qtable thead th:nth-child(3) button");
  assert.deepEqual(await header(), ["ascending", "due ↑"]);
  const up = await dues();
  assert.deepEqual(up, [...up].sort());
  await page.click(".cm-qtable thead th:nth-child(3) button");
  assert.deepEqual(await header(), ["descending", "due ↓"]);
  assert.deepEqual(await dues(), [...up].reverse());
  await page.shot("content-table-sorted");
  await page.close();
});

for (const theme of ["light", "dark"]) {
  test(`math, Mermaid, callouts and embeds render (${theme})`, async () => {
    const page = await open({ width: 1280, settings: { theme } });
    await page.openFile("Phase 2 Showcase");
    await page.until(`!!document.querySelector(".cm-content .katex")`, "KaTeX");
    await page.until(`!!document.querySelector(".cm-mermaid svg")`, "Mermaid", 15000);
    assert.ok(await page.js(`document.querySelectorAll(".cm-callout").length >= 2`), "callouts");
    await page.until(`!!document.querySelector(".cm-embed-img img, .cm-content img")`, "the embedded image");
    await page.shot(`content-showcase-${theme}`);
    await page.close();
  });
}

test("canvas and PDF open in their viewers", async () => {
  const page = await open({ width: 1280, settings: { theme: "dark" } });
  await page.openFile("Planning board.canvas");
  await page.until(`document.querySelectorAll(".canvas .node").length > 0`, "canvas cards");
  await page.shot("content-canvas-dark");
  await page.openFile("sample.pdf");
  await page.until(`!!document.querySelector("main iframe")`, "the PDF frame");
  const src = await page.js(`document.querySelector("main iframe").getAttribute("src")`);
  const status = await page.js(`fetch(${JSON.stringify("")} + document.querySelector("main iframe").src).then((r) => r.status)`);
  assert.match(src, /sample\.pdf$/);
  assert.equal(status, 200);
  await page.close();
});
