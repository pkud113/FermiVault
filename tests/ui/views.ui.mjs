// Panels and controls follow the active view: the outline and properties never show another
// file's content, and view-specific controls only appear where they do something.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

const outline = (page) => page.js(`[...document.querySelectorAll("aside.right .heading")].map((b) => b.textContent.trim())`);
const panel = (page) => page.text("aside.right .body");
const tabNamed = (page, pane, name) =>
  page.click(`main .pane:nth-child(${pane}) .tab span`, name);

test("the outline belongs to the active document, across tab and pane switches", async () => {
  const page = await open({ width: 1400 });
  await page.openFile("Phase 2 Showcase");
  await page.click("aside.right .tabs button", "Outline");
  await page.until(`document.querySelectorAll("aside.right .heading").length > 0`, "headings");
  assert.ok((await outline(page)).includes("Math"));

  await page.openFile("Planning board.canvas", { ctrl: true });
  await page.settle(200);
  assert.deepEqual(await outline(page), [], "a canvas has no headings of its own");
  assert.match(await panel(page), /outline lists a note's headings/);
  await page.shot("views-outline-canvas");

  await page.openFile("sample.pdf", { ctrl: true });
  await page.settle(200);
  assert.deepEqual(await outline(page), [], "a PDF shows no note's headings");

  // Back to the note in the same pane: its headings return.
  await tabNamed(page, 1, "Phase 2 Showcase");
  await page.until(`[...document.querySelectorAll("aside.right .heading")].some((b) => b.textContent.trim() === "Math")`, "headings again");

  // Split: a canvas in the new pane, the note in the first; focus decides.
  await page.key("Ctrl+\\");
  await page.openFile("Planning board.canvas");
  await page.settle(200);
  assert.deepEqual(await outline(page), [], "focused pane shows the canvas");
  await tabNamed(page, 1, "Phase 2 Showcase");
  await page.until(`document.querySelectorAll("aside.right .heading").length > 0`, "the note's headings when its pane is focused");
  await tabNamed(page, 2, "Planning board.canvas");
  await page.settle(150);
  assert.deepEqual(await outline(page), [], "and gone again when the canvas pane is focused");

  // Properties follow the same rule.
  await page.click("aside.right .tabs button", "Properties");
  assert.match(await panel(page), /Properties belong to notes/);
  await page.close();
});

test("footer controls match the view: no word count or mode toggle on canvas, PDF or graph", async () => {
  const page = await open({ width: 1280 });
  const footer = () => page.text("footer");
  await page.openFile("Welcome");
  await page.until(`/words/.test(document.querySelector("footer").innerText)`, "word count");
  assert.match(await footer(), /Live preview/);
  await page.openFile("Planning board.canvas");
  await page.settle(200);
  assert.doesNotMatch(await footer(), /words|Live preview|Source/);
  await page.key("Alt+g");
  await page.settle(200);
  const f = await footer();
  assert.doesNotMatch(f, /fermi:graph|Live preview/);
  assert.match(f, /Graph/);
  await page.close();
});
