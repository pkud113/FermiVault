// Save feedback as rendered: pending/saving/saved for the active note, a failure that stays visible
// (tab marker and footer) until a save succeeds, background tabs, and edit → close → reopen.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

const footerSave = (page) => page.js(`[...document.querySelectorAll("footer .save, footer .mode.bad")].map((e) => e.innerText.trim()).join(" | ")`);
const marker = (page, name) =>
  page.js(`(() => { const tab = [...document.querySelectorAll("main .tab")].find((t) => t.querySelector("span").textContent.trim() === ${JSON.stringify(name)});
    const d = tab?.querySelector(".dirty"); return d ? (d.classList.contains("bad") ? "failed" : "unsaved") : "none"; })()`);
const disk = (page, path) => page.js(`__fv.files.get(${JSON.stringify(path)})`);

async function typeInNote(page, text) {
  await page.until(`!!document.querySelector(".cm-content")`, "the editor");
  await page.js(`document.querySelector(".cm-content").focus()`);
  await page.key("Ctrl+End");
  await page.type(text);
}

test("typing shows unsaved, then saving, then saved, without noise", async () => {
  const page = await open();
  await page.openFile("Welcome");
  await page.until(`/Saved/.test(document.querySelector("footer").innerText)`, "saved state");
  await page.js(`__fv.hold("write_note")`);
  await typeInNote(page, " edited");
  assert.equal(await footerSave(page), "Unsaved changes");
  assert.equal(await marker(page, "Welcome"), "unsaved");
  await page.until(`(__fv.held.get("write_note") ?? []).length === 1`, "the save to start");
  assert.equal(await footerSave(page), "Saving…");
  await page.js(`__fv.unhold("write_note"); __fv.release("write_note", 0)`);
  await page.until(`document.querySelector("footer .save")?.innerText.trim() === "Saved"`, "saved");
  assert.equal(await marker(page, "Welcome"), "none");
  assert.match(await disk(page, "Welcome.md"), / edited/);
  await page.close();
});

test("a failed save stays visible after the message fades, and Retry recovers", async () => {
  const page = await open();
  await page.openFile("Welcome");
  await page.js(`__fv.fail("write_note", "disk is full")`);
  await typeInNote(page, " kept");
  await page.until(`/Not saved/.test(document.querySelector("footer").innerText)`, "the failure");
  assert.equal(await marker(page, "Welcome"), "failed");
  await page.shot("save-failed");
  // The toast clears itself after 7 s; the indicators don't.
  await new Promise((r) => setTimeout(r, 7600));
  assert.equal(await page.js(`!!document.querySelector(".toast")`), false);
  assert.equal(await footerSave(page), "Not saved · Retry");
  assert.equal(await marker(page, "Welcome"), "failed");
  await page.js(`__fv.fail("write_note", null)`);
  await page.click("footer button", "Not saved · Retry");
  await page.until(`document.querySelector("footer .save")?.innerText.trim() === "Saved"`, "saved after retry");
  assert.equal(await marker(page, "Welcome"), "none");
  assert.match(await disk(page, "Welcome.md"), / kept/);
  await page.close();
});

test("a background tab that couldn't save keeps its marker and is reported in the footer", async () => {
  const page = await open();
  await page.openFile("Welcome");
  await page.js(`__fv.fail("write_note", "disk is full")`);
  await typeInNote(page, " background");
  await page.openFile("Getting Started", { ctrl: true }); // switching away saves Welcome, which fails
  await page.until(`/other file not saved/.test(document.querySelector("footer").innerText)`, "the background failure");
  assert.equal(await marker(page, "Welcome"), "failed");
  assert.equal(await marker(page, "Getting Started"), "none");
  await page.js(`__fv.fail("write_note", null)`);
  await page.click("footer button", "1 other file not saved · Retry");
  await page.until(`!document.querySelector("main .tab .dirty")`, "markers cleared");
  assert.match(await disk(page, "Welcome.md"), / background/);
  await page.close();
});

test("edit, close the tab, reopen: the edit is there", async () => {
  const page = await open();
  await page.openFile("Getting Started");
  await typeInNote(page, " reopened");
  await page.until(`document.querySelector("footer .save")?.innerText.trim() === "Saved"`, "saved");
  await page.click("main .tab .x");
  await page.openFile("Getting Started");
  await page.until(`document.querySelector(".cm-content")?.innerText.includes("reopened")`, "the edit after reopening");
  await page.close();
});
