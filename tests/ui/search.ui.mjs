// Search pane as rendered: late results never overwrite newer ones or a cleared query, failures
// show as failures with Retry, and closing the pane mid-search is harmless.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

const status = (page) => page.js(`document.querySelector(".wrap [role=status]")?.innerText.trim() ?? ""`);
const hits = (page) => page.js(`document.querySelectorAll(".wrap .hit").length`);
const setQuery = (page, q) =>
  page.js(`(() => { const i = document.querySelector(".wrap input"); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const searchCalls = (page) => page.js(`(__fv.held.get("search") ?? []).length`);

async function searchPane(page) {
  await page.key("Ctrl+Shift+F");
  await page.until(`!!document.querySelector(".wrap input")`, "the search pane");
}

test("an older search finishing last doesn't replace the newer results", async () => {
  const page = await open();
  await searchPane(page);
  await page.js(`__fv.hold("search")`);
  await setQuery(page, "Roadmap");
  await page.until(`(__fv.held.get("search") ?? []).length === 1`, "first search sent");
  await setQuery(page, "Roadmap zzz");
  await page.until(`(__fv.held.get("search") ?? []).length === 2`, "second search sent");
  await page.js(`__fv.release("search", 1)`); // newer one first: no matches
  await page.until(`/No matches/.test(document.querySelector(".wrap [role=status]").innerText)`, "no matches");
  await page.js(`__fv.release("search", 0)`); // the stale one, with results
  await page.settle(200);
  assert.match(await status(page), /No matches for “Roadmap zzz”/);
  assert.equal(await hits(page), 0);
  await page.close();
});

test("clearing the query discards a search still in flight", async () => {
  const page = await open();
  await searchPane(page);
  await page.js(`__fv.hold("search")`);
  await setQuery(page, "Welcome");
  await page.until(`(__fv.held.get("search") ?? []).length === 1`, "search sent");
  await setQuery(page, "");
  await page.settle(300); // past the typing pause
  await page.js(`__fv.release("search", 0)`);
  await page.settle(200);
  assert.equal(await hits(page), 0);
  assert.equal(await status(page), "");
  await page.close();
});

test("a failed search says so and Retry recovers", async () => {
  const page = await open({ width: 1280 });
  await searchPane(page);
  await page.js(`__fv.hold("search")`);
  await setQuery(page, "Welcome");
  await page.until(`(__fv.held.get("search") ?? []).length === 1`, "search sent");
  assert.equal(await status(page), "Searching…");
  await page.js(`__fv.unhold("search"); __fv.release("search", 0, "the index is being rebuilt")`);
  await page.until(`!!document.querySelector(".wrap [role=alert]")`, "the failure");
  assert.match(await page.text(".wrap [role=alert]"), /Search failed: the index is being rebuilt/);
  assert.equal(await hits(page), 0);
  await page.shot("search-failed");
  await page.click(".wrap [role=alert] button", "Retry");
  await page.until(`document.querySelectorAll(".wrap .hit").length > 0`, "results after retry");
  assert.equal(await page.js(`!!document.querySelector(".wrap [role=alert]")`), false);
  await page.close();
});

test("closing the search pane mid-search leaves nothing behind", async () => {
  const page = await open();
  await searchPane(page);
  await page.js(`__fv.hold("search")`);
  await setQuery(page, "Welcome");
  await page.until(`(__fv.held.get("search") ?? []).length === 1`, "search sent");
  await page.click("aside.left [role=tab]", "Files");
  await page.js(`__fv.release("search", 0)`);
  await page.settle(200);
  assert.equal(await page.js(`!!document.querySelector(".wrap .hit, [role=alert]")`), false);
  assert.equal(await searchCalls(page), 1);
  await page.close();
});
