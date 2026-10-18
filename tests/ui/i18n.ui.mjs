// German interface as rendered: no English left in labels, tooltips or accessible names across the
// main views, shortcuts in German key names, and longer German text still fits.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browser, open } from "./harness.mjs";

after(async () => (await browser()).close());

const de = JSON.parse(readFileSync(new URL("../../src/lib/locales/de.json", import.meta.url), "utf8"));
// English source strings whose German differs, as whole-string patterns ({name} matches anything).
const english = Object.entries(de)
  .filter(([k, v]) => k !== v && /[a-z]{2}/i.test(k))
  .map(([k]) => [k, new RegExp("^" + k.replace(/[.*+?^$()[\]\\|]/g, "\\$&").replace(/\{\w+\}/g, ".+") + "$")]);

/** Interface strings on screen: own text of elements, plus aria-label, title and placeholder.
 *  Vault content (note text, file names, graph labels) is left out. */
const strings = (page) =>
  page.js(`(() => {
    const skip = ".cm-content, [data-i], .graph .list, .palette .items, .tab span, footer .path, .vaultname span, aside.right .body .src, aside.right .body .ctx, .heading, .key, .prop input";
    const out = new Set();
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(skip) || el.closest("[hidden]")) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").replace(/\\s+/g, " ").trim();
      if (own) out.add(own);
      for (const a of ["aria-label", "title", "placeholder"]) if (el.getAttribute(a)) out.add(el.getAttribute(a).trim());
    }
    return [...out];
  })()`);

async function check(page, where) {
  const found = await strings(page);
  const leaks = found.filter((s) => english.some(([, re]) => re.test(s)) || /\b(Ctrl|Shift)\b/.test(s));
  assert.deepEqual(leaks, [], `${where}: English left in the German interface`);
}

test("German: workspace, panels, palette, settings, graph and search have no English left", async () => {
  const page = await open({ width: 1366, height: 820, settings: { language: "de" } });
  await page.until(`document.documentElement.lang === "de"`, "German");
  await check(page, "empty workspace");
  await page.shot("de-empty");
  await page.openFile("Mobile app");
  await page.until(`!!document.querySelector(".cm-content")`, "editor");
  await check(page, "note open");
  for (const tab of ["Gliederung", "Eigenschaften", "Rückverweise"]) {
    await page.click("aside.right .tabs button", tab);
    await check(page, `right panel: ${tab}`);
  }
  await page.shot("de-note-properties");
  await page.key("Ctrl+p");
  await page.until(`!!document.querySelector(".palette")`, "palette");
  await check(page, "command palette");
  const shown = await page.js(`[...document.querySelectorAll(".palette .detail")].map((d) => d.textContent)`);
  assert.ok(shown.includes("Strg+O") && shown.includes("Strg+Umschalt+D"), `palette shortcuts: ${shown.slice(0, 6)}`);
  await page.shot("de-palette");
  await page.key("Escape");
  await page.key("Ctrl+o");
  await page.until(`!!document.querySelector(".palette")`, "switcher");
  assert.equal(await page.js(`document.querySelector(".palette input").getAttribute("aria-label")`), "Notiz suchen oder erstellen");
  await page.key("Escape");
  await page.key("Alt+g");
  await page.until(`document.querySelectorAll(".graph canvas").length > 0`, "graph");
  await page.click(".graph .tools button", "Notizen und Verknüpfungen auflisten");
  await check(page, "graph");
  await page.key("Ctrl+Shift+F");
  await page.until(`!!document.querySelector(".wrap input")`, "search");
  await check(page, "search");
  for (const pane of ["Tags", "Lesezeichen", "KI-Apps"]) {
    await page.click("aside.left [role=tab]", pane).catch(() => {});
    await check(page, `left: ${pane}`);
  }
  await page.click("footer button", "Einstellungen");
  for (const section of ["Allgemein", "Editor", "KI", "Tresor", "Synchronisierung", "Plugins"]) {
    await page.click("[role=dialog] [role=tab]", section);
    await check(page, `settings: ${section}`);
  }
  await page.close();
});

test("German text fits: footer, tabs and sidebars don't overflow at a compact width", async () => {
  const page = await open({ width: 900, height: 700, settings: { language: "de", theme: "dark" } });
  await page.openFile("Welcome");
  await page.until(`!!document.querySelector(".cm-content")`, "editor");
  const over = await page.js(`[...document.querySelectorAll("footer, aside.left .switch, aside.right .tabs, main .tabs")]
    .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== "auto").map((e) => e.tagName + "." + e.className)`);
  assert.deepEqual(over, []);
  await page.shot("de-compact-dark");
  await page.close();
});
