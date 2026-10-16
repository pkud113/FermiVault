// Workspace layout, keyboard navigation and colour contrast (UI-01 to UI-05). Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIN_EDITOR, MIN_PANEL, arrowIndex, clampPanel, sidebars } from "../src/lib/ui.ts";

const both = { show: true, width: 260 };
const right = { show: true, width: 280 };

test("narrow windows keep the editor usable; sidebars come back when there's room (UI-03)", () => {
  for (const vw of [640, 800, 1024, 1280]) {
    const s = sidebars(vw, 1, both, right, "left");
    assert.ok(vw - s.left - s.right >= MIN_EDITOR, `editor too narrow at ${vw}px`);
  }
  assert.deepEqual(sidebars(640, 1, both, right, "left"), { left: 260, right: 0 }, "minimum window: one sidebar");
  assert.deepEqual(sidebars(1280, 1, both, right, "left"), { left: 260, right: 280 }, "default window: both");
  assert.deepEqual(sidebars(500, 1, both, right, "left"), { left: 0, right: 0 }, "no room: both yield");
});

test("the sidebar opened last gets the space when only one fits (UI-03)", () => {
  assert.deepEqual(sidebars(700, 1, both, right, "right"), { left: 0, right: 280 });
  assert.deepEqual(sidebars(700, 1, both, right, "left"), { left: 260, right: 0 });
});

test("split panes each keep a usable width before sidebars do (UI-03)", () => {
  const s = sidebars(1100, 3, both, right, "left");
  assert.ok(1100 - s.left - s.right >= 900, "three panes need 900px");
  assert.equal(s.right, 0);
});

test("resizing a sidebar never squeezes the editor or goes below the minimum (UI-03, UI-05)", () => {
  assert.equal(clampPanel(9999, 1000, 1, 280), 1000 - MIN_EDITOR - 280);
  assert.equal(clampPanel(10, 1280, 1, 0), MIN_PANEL);
  assert.equal(clampPanel(9999, 4000, 1, 0), 560);
});

test("arrow, Home and End move between tabs and rows (UI-05)", () => {
  assert.equal(arrowIndex("ArrowRight", 2, 3, true), 0, "tabs wrap");
  assert.equal(arrowIndex("ArrowLeft", 0, 3, true), 2);
  assert.equal(arrowIndex("ArrowDown", 2, 3, false, "ArrowUp", "ArrowDown"), 2, "trees stop at the end");
  assert.equal(arrowIndex("ArrowUp", 0, 3, false, "ArrowUp", "ArrowDown"), 0);
  assert.equal(arrowIndex("Home", 2, 3, true), 0);
  assert.equal(arrowIndex("End", 0, 3, true), 2);
  assert.equal(arrowIndex("a", 1, 3, true), -1);
  assert.equal(arrowIndex("ArrowRight", 0, 0, true), -1, "empty strip");
});

// ---- Contrast, computed from the real stylesheet (WCAG 2.x relative luminance). ----

const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
/** Opaque colour tokens (#rgb or #rrggbb) of one theme block, as #rrggbb. */
const tokens = (sel: string) =>
  Object.fromEntries(
    [...block(sel).matchAll(/--fv-([\w-]+):\s*#([0-9a-f]{6}|[0-9a-f]{3});/gi)].map((m) => [
      m[1],
      "#" + (m[2].length === 3 ? [...m[2]].map((c) => c + c).join("") : m[2]),
    ]),
  );
const light = tokens(":root {");
const dark = { ...light, ...tokens(':root[data-theme="dark"]') };

type RGB = [number, number, number];
const rgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const lum = (c: RGB) => {
  const [r, g, b] = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** `color-mix(in srgb, a p, b)` */
const mix = (a: RGB, b: RGB, p: number) => a.map((v, i) => Math.round(v * p + b[i] * (1 - p))) as RGB;

test("text, secondary text, links and errors are readable on every surface, both themes (UI-01)", () => {
  for (const [name, t] of [["light", light], ["dark", dark]] as const) {
    for (const fg of ["text", "muted", "faint", "accent", "danger"]) {
      for (const bg of ["bg", "bg-2", "hover", "active"]) {
        const r = ratio(rgb(t[fg]), rgb(t[bg]));
        assert.ok(r >= 4.5, `${name}: --fv-${fg} on --fv-${bg} is ${r.toFixed(2)}:1`);
      }
    }
    assert.ok(ratio(rgb(t["muted"]), rgb(t["bg"])) > ratio(rgb(t["faint"]), rgb(t["bg"])) + 1, `${name}: faint must stay visibly lighter than muted`);
    assert.ok(ratio(rgb(t["on-accent"]), rgb(t["accent"])) >= 4.5, `${name}: button text on accent`);
  }
});

test("graph links stand out from the graph's background, both themes", () => {
  for (const [name, t] of [["light", light], ["dark", dark]] as const) {
    for (const bg of ["bg", "bg-2"]) {
      const r = ratio(rgb(t["graph-edge"]), rgb(t[bg]));
      assert.ok(r >= 3, `${name}: --fv-graph-edge on --fv-${bg} is ${r.toFixed(2)}:1`);
    }
  }
});

test("callout titles are readable on their tinted surface, both themes (UI-02)", () => {
  const title = /\.cm-callout-title\s*{[^}]*color:\s*color-mix\(in srgb, var\(--c\) (\d+)%, var\(--fv-heading\)\)/.exec(css);
  assert.ok(title, "callout titles mix their colour toward the heading colour");
  const p = Number(title[1]) / 100;
  const kinds = [...css.matchAll(/\.cm-callout-(\w+)[^{]*{\s*--c:\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]] as const);
  assert.ok(kinds.length >= 5);
  for (const [name, t] of [["light", light], ["dark", dark]] as const) {
    for (const [kind, c] of [...kinds, ["note", t["accent"]] as const]) {
      const surface = mix(rgb(c), rgb(t["bg"]), 0.1);
      const r = ratio(mix(rgb(c), rgb(t["heading"]), p), surface);
      assert.ok(r >= 4.5, `${name} ${kind} callout title is ${r.toFixed(2)}:1`);
      assert.ok(ratio(rgb(t["text"]), surface) >= 4.5, `${name} ${kind} callout body`);
    }
  }
});
