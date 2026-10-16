// Graph view as rendered: the drawing stays inside its pane through splits, resizes and closes;
// it shows a truthful loading state; it has visible controls and a keyboard-usable list.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

/** Every graph's drawing layers match its own (visible) surface. */
async function contained(page, what) {
  const r = await page.js(`[...document.querySelectorAll(".graph")].map((g) => {
    const box = g.getBoundingClientRect(), pane = g.closest(".pane, aside")?.getBoundingClientRect();
    const layers = [...g.querySelectorAll("canvas")].map((c) => parseFloat(c.style.width));
    return { w: box.width, right: box.right, paneRight: pane?.right ?? box.right, layers };
  })`);
  assert.ok(r.length, `${what}: a graph is on screen`);
  for (const g of r) {
    assert.ok(g.layers.length > 0, `${what}: graph drawn`);
    assert.ok(g.right <= g.paneRight + 1, `${what}: graph surface ends at ${g.right}, its pane at ${g.paneRight}`);
    for (const w of g.layers) assert.ok(Math.abs(w - g.w) <= 1, `${what}: a drawing layer is ${w}px wide in a ${g.w}px surface`);
  }
}

const graphDrawn = (page) => page.until(`document.querySelectorAll(".graph canvas").length > 0`, "the graph to draw");

test("the graph redraws to its pane when panes split, sidebars resize and panes close", async () => {
  const page = await open({ width: 1600, height: 900 });
  await page.key("Alt+g");
  await graphDrawn(page);
  await contained(page, "full width");
  await page.key("Ctrl+\\");
  await page.openFile("Welcome");
  await page.settle(300);
  await contained(page, "after split");
  await page.shot("graph-split-1600");
  // Wider right sidebar: the graph pane shrinks without a window resize.
  await page.js(`document.querySelector('aside.right .grip').focus()`);
  for (let i = 0; i < 6; i++) await page.key("ArrowLeft");
  await page.settle(200);
  await contained(page, "after sidebar resize");
  // Close the Welcome pane's only tab: the graph pane gets the room back.
  await page.click(`main .pane:last-child .tab .x`);
  await page.settle(300);
  await contained(page, "after closing the neighbour");
  await page.close();
});

test("a populated vault shows a loading state, never \"No notes yet\", until the graph is drawn", async () => {
  const page = await open();
  await page.js(`__fv.hold("graph")`);
  await page.key("Alt+g");
  await page.settle(600); // past the draw debounce
  const text = await page.text(".graph");
  assert.match(text, /Loading graph/);
  assert.doesNotMatch(text, /No notes yet/);
  await page.js(`__fv.unhold("graph"); __fv.release("graph", 0)`);
  await graphDrawn(page);
  assert.doesNotMatch(await page.text(".graph"), /Loading graph|No notes yet/);
  await page.close();
});

test("graph controls and the note list work from the keyboard", async () => {
  const page = await open({ width: 1400, settings: { theme: "dark" } });
  await page.key("Alt+g");
  await graphDrawn(page);
  const label = await page.js(`document.querySelector(".graph [role=img]").getAttribute("aria-label")`);
  assert.match(label, /^Graph: \d+ notes, \d+ links$/);
  for (const name of ["Zoom in", "Zoom out", "Fit to view"]) await page.click(".graph .tools button", name);
  await page.click(".graph .tools button", "List notes and links");
  await page.until(`!!document.querySelector(".graph .list [data-note]")`, "the note list");
  await page.shot("graph-list-dark");
  // Arrow keys move between notes; Enter opens one.
  await page.js(`document.querySelector(".graph .list [data-note]").focus()`);
  await page.key("ArrowDown");
  const focused = await page.js(`document.activeElement.textContent.trim()`);
  const second = await page.js(`document.querySelectorAll(".graph .list [data-note]")[1].textContent.trim()`);
  assert.equal(focused, second);
  await page.key("Enter");
  await page.until(`[...document.querySelectorAll("main .tab span")].some((s) => s.textContent.trim() === ${JSON.stringify(second)})`, "the note to open");
  await page.close();
});
