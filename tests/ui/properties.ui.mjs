// Properties as rendered: labelled fields that fit a narrow panel, adding a property round-trips
// through the YAML with undo, and live preview collapses the YAML block (source mode doesn't).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

/** Elements of the right panel that stick out of it, or inputs too narrow to use. */
const misfits = (page) =>
  page.js(`(() => {
    const panel = document.querySelector("aside.right .body").getBoundingClientRect();
    return [...document.querySelectorAll("aside.right .body input, aside.right .body button, aside.right .body label")]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.right > panel.right + 0.5 || (e.matches("input:not([type=checkbox])") && r.width < 120); })
      .map((e) => e.outerHTML.slice(0, 80));
  })()`);
const editorText = (page) => page.js(`document.querySelector(".cm-content").innerText`);

async function showProperties(page, note) {
  await page.openFile(note);
  await page.until(`!!document.querySelector(".cm-content")`, "the editor");
  await page.click("aside.right .tabs button", "Properties");
  await page.until(`document.querySelectorAll("aside.right .prop").length > 0`, "properties");
}

test("fields are labelled and fit the default and the narrowest panel", async () => {
  const page = await open({ width: 1280 });
  await showProperties(page, "Mobile app");
  assert.deepEqual(await page.js(`[...document.querySelectorAll("aside.right .prop .key")].map((k) => k.textContent)`), ["status", "due", "priority", "tags"]);
  // Every field has a label that names it.
  assert.equal(await page.js(`[...document.querySelectorAll("aside.right .prop input")].every((i) => i.labels?.[0]?.textContent)`), true);
  assert.equal(await page.js(`[...document.querySelectorAll("aside.right .add input")].every((i) => i.labels?.[0]?.textContent)`), true);
  assert.deepEqual(await misfits(page), []);
  await page.shot("properties-default");
  // Narrowest panel.
  await page.js(`document.querySelector('aside.right .grip').focus()`);
  for (let i = 0; i < 12; i++) await page.key("ArrowRight");
  assert.ok((await page.box("aside.right")).w <= 181);
  assert.deepEqual(await misfits(page), []);
  await page.shot("properties-narrow");
  await page.close();
});

test("adding a property writes YAML and undoes in one step", async () => {
  const page = await open();
  await showProperties(page, "Mobile app");
  await page.click("aside.right .add label", "Name");
  await page.type("owner");
  await page.click("aside.right .add label", "Value");
  await page.type("Kim");
  await page.click("aside.right .add button", "Add");
  await page.until(`[...document.querySelectorAll("aside.right .prop .key")].some((k) => k.textContent === "owner")`, "the new property");
  await page.until(`/owner: Kim/.test(__fv.files.get("projects/Mobile app.md"))`, "the YAML on disk");
  await page.js(`document.querySelector(".cm-content").focus()`);
  await page.key("Ctrl+z");
  await page.until(`![...document.querySelectorAll("aside.right .prop .key")].some((k) => k.textContent === "owner")`, "undo to remove it");
  await page.until(`!/owner:/.test(__fv.files.get("projects/Mobile app.md"))`, "the undo saved");
  await page.close();
});

test("live preview collapses the YAML; going into it or source mode shows it; the file is unchanged", async () => {
  const page = await open();
  await page.openFile("Mobile app");
  await page.until(`!!document.querySelector(".cm-props-summary")`, "the collapsed properties");
  assert.match(await page.text(".cm-props-summary"), /Properties: status, due, priority, tags/);
  assert.doesNotMatch(await editorText(page), /status: planned/);
  // Arrow up from the body goes into the block (at its top) and shows the YAML.
  await page.js(`document.querySelector(".cm-content").focus()`);
  await page.key("ArrowUp");
  await page.until(`/status: planned/.test(document.querySelector(".cm-content").innerText)`, "the YAML on going into it");
  await page.key("Ctrl+End");
  await page.until(`!!document.querySelector(".cm-props-summary")`, "collapsed again when leaving it");
  // Source mode always shows it.
  await page.key("Ctrl+e");
  await page.until(`!document.querySelector(".cm-props-summary") && /status: planned/.test(document.querySelector(".cm-content").innerText)`, "source mode");
  await page.key("Ctrl+e");
  const disk = await page.js(`__fv.files.get("projects/Mobile app.md")`);
  assert.match(disk, /^---\nstatus: planned\ndue: 2027-01-10\npriority: 3\ntags: \[project\]\n---\n# Mobile app/);
  await page.shot("properties-collapsed");
  await page.close();
});
