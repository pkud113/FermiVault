// Live-preview widgets: embeds/transclusion, images, math, Mermaid, task checkboxes.
// Heavy renderers (KaTeX, Mermaid) are dynamic imports, loaded the first time a
// note actually uses them, so they never cost startup time.

import { t } from "./i18n.svelte";
import { Facet, StateField, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { assetUrl, imageTarget, kind, sectionRange, type Table } from "./api";
import { host, liveTables } from "./host";

export { host };

/** How deep inside transclusions this editor is (0 = a normal tab). */
export const embedDepth = Facet.define<number, number>({ combine: (v) => v[0] ?? 0 });
const MAX_DEPTH = 2;

/** Resolves a link/embed target to a vault file: exact path first, then shortest path ending in it. */
export function resolveFile(target: string): string | null {
  const t = target.trim().replace(/^\.\//, "").toLowerCase();
  const want = [t, t + ".md"];
  let best: string | null = null;
  for (const f of host.files()) {
    const l = f.toLowerCase();
    if (want.includes(l)) return f;
    if (want.some((w) => l.endsWith("/" + w)) && (!best || f.length < best.length)) best = f;
  }
  return best;
}

const url = (path: string) => assetUrl(host.root(), path);

function media(path: string, width?: number): HTMLElement {
  const k = kind(path);
  const el =
    k === "image" ? Object.assign(document.createElement("img"), { src: url(path), alt: path, loading: "lazy" })
    : k === "pdf" ? Object.assign(document.createElement("iframe"), { src: url(path), className: "cm-embed-pdf" })
    : k === "audio" || k === "video" ? Object.assign(document.createElement(k), { src: url(path), controls: true })
    : Object.assign(document.createElement("span"), { textContent: path, className: "cm-embed-file" });
  if (width && el instanceof HTMLImageElement) el.width = width;
  return el;
}

/** Web images the user clicked to load this session. */
const allowedImages = new Set<string>();

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly remote: boolean) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src;
  }
  toDOM(view: EditorView) {
    const img = () => {
      // No referrer: the image host doesn't learn anything about the note or app.
      const el = Object.assign(document.createElement("img"), { src: this.src, alt: this.alt, className: "cm-embed-img", referrerPolicy: "no-referrer" });
      el.onload = () => view.requestMeasure();
      return el;
    };
    if (!this.remote || host.remoteImages() || allowedImages.has(this.src)) return img();
    // Notes and AI answers can come from anywhere; loading a web image tells its host you opened them.
    const btn = Object.assign(document.createElement("button"), {
      className: "cm-embed-remote",
      textContent: t("Load image from {host}", { host: new URL(this.src).host }),
      title: this.src,
    });
    btn.onmousedown = (e) => {
      e.preventDefault();
      allowedImages.add(this.src);
      btn.replaceWith(img());
      view.requestMeasure();
    };
    return btn;
  }
}

/** `![[target#section|size]]`: images, PDFs, media, or another note rendered inline. */
class EmbedWidget extends WidgetType {
  constructor(readonly target: string, readonly depth: number, readonly block: boolean) {
    super();
  }
  eq(o: EmbedWidget) {
    return o.target === this.target && o.depth === this.depth && o.block === this.block;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement(this.block ? "div" : "span");
    wrap.className = "cm-embed";
    const [ref, size] = this.target.split("|");
    const [name, section] = ref.split("#");
    const path = resolveFile(name);
    if (!path) {
      wrap.classList.add("cm-embed-missing");
      wrap.textContent = `“${name}” not found`;
      return wrap;
    }
    if (kind(path) !== "note") {
      wrap.append(media(path, Number(size) || undefined));
      wrap.querySelector("img")?.addEventListener("load", () => view.requestMeasure());
      return wrap;
    }
    const title = Object.assign(document.createElement("div"), {
      className: "cm-embed-title",
      textContent: name + (section ? ` › ${section}` : ""),
    });
    title.onmousedown = (e) => {
      e.preventDefault();
      host.open(path, e.ctrlKey || e.metaKey);
    };
    wrap.append(title);
    if (this.depth >= MAX_DEPTH) return wrap; // stop runaway (or circular) transclusion
    host.read(path).then((text) => {
      const r = section ? sectionRange(text, section) : null;
      const inner = host.nested(r ? text.slice(r[0], r[1]) : text, this.depth + 1);
      (wrap as any).inner = inner;
      wrap.append(inner.dom);
      view.requestMeasure();
    });
    return wrap;
  }
  destroy(dom: HTMLElement) {
    (dom as any).inner?.destroy();
  }
}

let katex: Promise<typeof import("katex").default> | null = null;
function loadKatex() {
  return (katex ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => m.default));
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-block" : "cm-math";
    el.textContent = this.tex;
    loadKatex().then((k) => {
      k.render(this.tex, el, { displayMode: this.display, throwOnError: false });
      view.requestMeasure();
    });
    return el;
  }
}

let mermaid: Promise<typeof import("mermaid").default> | null = null;
let mermaidTheme = "";
let mermaidId = 0;

class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code;
  }
  toDOM(view: EditorView) {
    const el = Object.assign(document.createElement("div"), { className: "cm-mermaid", textContent: t("Rendering diagram…") });
    (mermaid ??= import("mermaid").then((m) => m.default)).then(async (m) => {
      const theme = host.dark() ? "dark" : "default";
      if (theme !== mermaidTheme) {
        // `strict` sanitizes diagram text: notes may come from anywhere (agents, web clips).
        m.initialize({ startOnLoad: false, securityLevel: "strict", theme });
        mermaidTheme = theme;
      }
      try {
        el.innerHTML = (await m.render(`fv-mermaid-${mermaidId++}`, this.code)).svg;
      } catch (e) {
        el.textContent = t("Mermaid error: {error}", { error: (e as Error).message });
        el.classList.add("cm-embed-missing");
      }
      view.requestMeasure();
    });
    return el;
  }
}

const byValue = (a: string, b: string) => {
  const [x, y] = [Number(a), Number(b)];
  return a !== "" && b !== "" && !isNaN(x) && !isNaN(y) ? x - y : a.localeCompare(b, undefined, { sensitivity: "base" });
};

/** A ```table``` block: a live, sortable table of notes chosen by their properties. */
class TableWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.code === this.code;
  }
  toDOM(view: EditorView) {
    const wrap = Object.assign(document.createElement("div"), { className: "cm-qtable" });
    let data: Table | null = null;
    let sort: { col: number; desc: boolean } | null = null;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") =>
      Object.assign(document.createElement(tag), { textContent: text, className: cls });
    const draw = () => {
      if (!data) return;
      const rows = [...data.rows];
      if (sort) rows.sort((a, b) => byValue(a.cells[sort!.col], b.cells[sort!.col]) * (sort!.desc ? -1 : 1));
      const table = el("table");
      const head = table.createTHead().insertRow();
      data.columns.forEach((c, i) => {
        const th = head.appendChild(el("th"));
        const b = th.appendChild(el("button", c + (sort?.col === i ? (sort.desc ? " ↓" : " ↑") : "")));
        th.ariaSort = sort?.col === i ? (sort.desc ? "descending" : "ascending") : "none";
        b.onclick = () => ((sort = { col: i, desc: sort?.col === i && !sort.desc }), draw());
      });
      const body = table.createTBody();
      for (const r of rows) {
        const tr = body.insertRow();
        r.cells.forEach((cell, i) => {
          const td = tr.appendChild(el("td"));
          if (data!.columns[i].toLowerCase() === "file") {
            const a = td.appendChild(el("button", cell, "cm-qtable-file"));
            a.title = r.path;
            a.onclick = (e) => host.open(r.path, e.ctrlKey || e.metaKey);
          } else td.textContent = cell;
        });
      }
      const foot =
        data.total > data.rows.length
          ? t("Showing {n} of {total}", { n: data.rows.length, total: data.total })
          : t(data.total === 1 ? "1 note" : "{n} notes", { n: data.total });
      wrap.replaceChildren(table, el("div", data.rows.length ? foot : t("No matching notes."), "cm-qtable-foot"));
      view.requestMeasure();
    };
    const run = () =>
      host.query(this.code).then(
        (t) => ((data = t), draw()),
        (e) => (wrap.replaceChildren(el("div", t("Table: {error}", { error: String(e) }), "cm-embed-missing")), view.requestMeasure()),
      );
    (wrap as any).run = run;
    liveTables.add(run);
    wrap.textContent = t("Loading table…");
    run();
    return wrap;
  }
  destroy(dom: HTMLElement) {
    liveTables.delete((dom as any).run);
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: this.checked, className: "cm-task" });
    box.onmousedown = (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? " " : "x" } });
    };
    return box;
  }
}

/** A widget plus the range whose lines, when the cursor is on them, show raw Markdown instead. */
type Candidate = { from: number; to: number; block: boolean; widget: WidgetType };

const EMBED = /!\[\[([^[\]]+?)\]\]/g;
const BLOCK_MATH = /^\$\$[^\S\n]*\n?([\s\S]+?)\n?\$\$[^\S\n]*$/gm;
const INLINE_MATH = /(?<![\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])/g;

function inCode(state: EditorState, pos: number) {
  for (let n: any = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (/Code|HTML|Comment/.test(n.name)) return true;
  return false;
}

// ponytail: scans the whole note on each edit (fast below ~10k lines); limit to the viewport if huge notes appear.
function candidates(state: EditorState): Candidate[] {
  const out: Candidate[] = [];
  const doc = state.doc;
  const text = doc.toString();
  const depth = state.facet(embedDepth);
  const lineSpan = (from: number, to: number) => [doc.lineAt(from).from, doc.lineAt(to).to] as const;

  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === "FencedCode") {
        const info = n.node.getChild("CodeInfo");
        const body = n.node.getChild("CodeText");
        const lang = info ? state.sliceDoc(info.from, info.to).trim().toLowerCase() : "";
        if (body && (lang === "mermaid" || lang === "table")) {
          const [a, b] = lineSpan(n.from, n.to);
          const code = state.sliceDoc(body.from, body.to);
          out.push({ from: a, to: b, block: true, widget: lang === "table" ? new TableWidget(code) : new MermaidWidget(code) });
        }
        return false;
      }
      if (/Code|HTML|Comment/.test(n.name)) return false;
      if (n.name === "Image") {
        const u = n.node.getChild("URL");
        const alt = state.sliceDoc(n.from + 2, (n.node.getChildren("LinkMark")[1]?.from ?? n.from + 2));
        if (!u) return;
        const t = imageTarget(state.sliceDoc(u.from, u.to));
        const local = t && "path" in t && resolveFile(t.path);
        if (local) out.push({ from: n.from, to: n.to, block: false, widget: new ImageWidget(url(local), alt, false) });
        else if (t && "web" in t) out.push({ from: n.from, to: n.to, block: false, widget: new ImageWidget(t.web, alt, true) });
      }
      if (n.name === "TaskMarker") {
        const checked = state.sliceDoc(n.from + 1, n.from + 2).toLowerCase() === "x";
        out.push({ from: n.from, to: n.to, block: false, widget: new CheckboxWidget(checked) });
      }
    },
  });

  for (const m of text.matchAll(EMBED)) {
    const a = m.index!, b = a + m[0].length;
    if (inCode(state, a)) continue;
    const line = doc.lineAt(a);
    const alone = line.text.trim() === m[0];
    const [from, to] = alone ? [line.from, line.to] : [a, b];
    out.push({ from, to, block: alone, widget: new EmbedWidget(m[1], depth, alone) });
  }

  const mathBlocks: [number, number][] = [];
  for (const m of text.matchAll(BLOCK_MATH)) {
    const a = m.index!, b = a + m[0].length;
    if (inCode(state, a)) continue;
    mathBlocks.push([a, b]);
    out.push({ from: a, to: b, block: true, widget: new MathWidget(m[1].trim(), true) });
  }
  for (const m of text.matchAll(INLINE_MATH)) {
    const a = m.index!;
    if (mathBlocks.some(([x, y]) => a >= x && a < y) || inCode(state, a)) continue;
    out.push({ from: a, to: a + m[0].length, block: false, widget: new MathWidget(m[1], false) });
  }
  return out;
}

function build(state: EditorState, cands: Candidate[]): DecorationSet {
  // Transclusions have no cursor to reveal markup for.
  const nested = state.facet(embedDepth) > 0;
  const active = new Set<number>();
  if (!nested) {
    for (const r of state.selection.ranges) {
      for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) active.add(l);
    }
  }
  const touched = (from: number, to: number) => {
    for (let l = state.doc.lineAt(from).number; l <= state.doc.lineAt(to).number; l++) if (active.has(l)) return true;
    return false;
  };
  const decos = cands
    .filter((c) => !touched(c.from, c.to))
    .map((c) => Decoration.replace({ widget: c.widget, block: c.block }).range(c.from, c.to));
  return Decoration.set(decos, true);
}

/** Block widgets must come from a state field. Candidates are recomputed only when the
 *  document or parse tree changes; cursor moves just re-filter them. */
export const widgetField = StateField.define<{ cands: Candidate[]; decos: DecorationSet }>({
  create(state) {
    const cands = candidates(state);
    return { cands, decos: build(state, cands) };
  },
  update(value, tr) {
    const reparsed = tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!reparsed && !tr.selection) return value;
    const cands = reparsed ? candidates(tr.state) : value.cands;
    return { cands, decos: build(tr.state, cands) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});
