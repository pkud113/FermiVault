// Settings as rendered: sections, a header that never scrolls away, keyboard use, Escape, and
// short, narrow and German-language windows.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

const openSettings = async (page, label = "Settings") => {
  await page.click("footer button", label);
  await page.until(`!!document.querySelector("[role=dialog] .panel")`, "settings");
};
const inWindow = (b, page) => b && b.y >= 0 && b.x >= 0 && b.bottom <= page.height + 0.5 && b.right <= page.width + 0.5;

test("in a short window the title and Close stay visible while a long section scrolls", async () => {
  const page = await open({ width: 1100, height: 440 });
  await openSettings(page);
  for (const section of ["AI", "Sync", "Plugins", "Vault"]) {
    await page.click("[role=dialog] [role=tab]", section);
    await page.js(`document.querySelector("[role=dialog] .panel").scrollTop = 1e6`);
    await page.settle(80);
    assert.ok(inWindow(await page.box("[role=dialog] .head button"), page), `${section}: Close is on screen`);
    assert.ok(inWindow(await page.box("[role=dialog]"), page), `${section}: the dialog fits the window`);
  }
  await page.shot("settings-short-vault");
  await page.close();
});

test("sections work from the keyboard, Escape closes and focus goes back", async () => {
  const page = await open();
  await page.js(`document.querySelector('footer .gear').focus()`);
  await page.key("Enter");
  await page.until(`!!document.querySelector("[role=dialog]")`, "settings");
  assert.equal(await page.js(`document.querySelector("[role=dialog]").contains(document.activeElement)`), true, "focus moves into the dialog");
  await page.js(`document.querySelector("[role=dialog] [role=tab][aria-selected=true]").focus()`);
  await page.key("ArrowDown");
  assert.equal(await page.js(`document.activeElement.textContent.trim()`), "Editor");
  assert.match(await page.text("[role=dialog] [role=tabpanel]"), /Vim key bindings/);
  await page.key("ArrowDown");
  assert.equal(await page.js(`document.activeElement.textContent.trim()`), "AI");
  await page.key("Escape");
  assert.equal(await page.js(`!!document.querySelector("[role=dialog]")`), false);
  assert.equal(await page.js(`document.activeElement.classList.contains("gear")`), true, "focus returns to the Settings button");
  await page.close();
});

test("narrow window and German text: sections become a row, nothing overflows", async () => {
  const page = await open({ width: 600, height: 700, settings: { language: "de", theme: "dark" } });
  await page.until(`document.querySelector("footer .gear")?.getAttribute("aria-label") === "Einstellungen"`, "German UI");
  await openSettings(page, "Einstellungen");
  const nav = await page.box("[role=dialog] .nav");
  const panel = await page.box("[role=dialog] .panel");
  assert.ok(nav.bottom <= panel.y + 1, "sections sit above the panel");
  assert.ok(inWindow(await page.box("[role=dialog]"), page), "dialog fits");
  for (const section of ["Allgemein", "Editor", "KI", "Tresor", "Synchronisierung", "Plugins"]) {
    await page.click("[role=dialog] [role=tab]", section);
    const overflow = await page.js(`(() => { const p = document.querySelector("[role=dialog] .panel"); return p.scrollWidth - p.clientWidth; })()`);
    assert.ok(overflow <= 1, `${section}: panel overflows sideways by ${overflow}px`);
  }
  await page.click("[role=dialog] [role=tab]", "Tresor");
  await page.shot("settings-narrow-de-dark");
  await page.close();
});
