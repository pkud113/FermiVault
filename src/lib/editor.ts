import { Compartment, EditorSelection, EditorState, type Range } from "@codemirror/state";
import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType,
  drawSelection, dropCursor, highlightActiveLine, keymap, rectangularSelection,
} from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { basename, dirname } from "./api";
import { embedDepth, host, resolveFile, widgetField } from "./widgets";

export type LinkHandler = (target: string, kind: "wiki" | "md" | "url", newTab: boolean) => void;

/** Swapped at runtime to toggle live preview / source mode without rebuilding state. */
export const previewMode = new Compartment();

const WIKI = /(!?)\[\[([^[\]|]+?)(?:\|([^[\]]+?))?\]\]/g;
const HIDDEN = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "LinkMark", "URL", "StrikethroughMark", "QuoteMark"]);
const CALLOUT = /^\s*>\s*\[!([\w-]+)\][+-]?\s*(.*)$/;
// Same rule as the Rust indexer: `#` after start/space, not purely numeric.
const TAG = /(^|[\s(])#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/gmu;
const hide = Decoration.replace({});
const tagMark = Decoration.mark({ class: "cm-tag" });

/** `[!note]` -> a styled label (shown alone when the callout has no title). */
class CalloutLabel extends WidgetType {
  constructor(readonly type: string, readonly titled: boolean) {
    super();
  }
  eq(o: CalloutLabel) {
    return o.type === this.type && o.titled === this.titled;
  }
  toDOM() {
    const name = this.type.charAt(0).toUpperCase() + this.type.slice(1);
    return Object.assign(document.createElement("span"), { className: "cm-callout-label", textContent: this.titled ? "" : name });
  }
}

/** Line numbers touched by any selection range: markup there stays visible for editing.
 *  Transclusions (read-only, no cursor) never reveal markup. */
function activeLines(state: EditorState) {
  const lines = new Set<number>();
  if (state.facet(embedDepth) > 0) return lines;
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) lines.add(l);
  }
  return lines;
}

function touches(state: EditorState, active: Set<number> | null, from: number, to: number) {
  if (!active) return true;
  for (let l = state.doc.lineAt(from).number; l <= state.doc.lineAt(to).number; l++) if (active.has(l)) return true;
  return false;
}

function inCode(state: EditorState, pos: number) {
  for (let n: any = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (/Code|HTML/.test(n.name)) return true;
  }
  return false;
}

function decorations(view: EditorView, live: boolean): DecorationSet {
  const { state } = view;
  const active = live ? activeLines(state) : null;
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    // Wikilinks first; syntax-tree marks inside them are skipped below.
    const spans: [number, number][] = [];
    for (const m of state.sliceDoc(from, to).matchAll(WIKI)) {
      const a = from + m.index!, b = a + m[0].length;
      if (inCode(state, a)) continue;
      spans.push([a, b]);
      if (m[1] && live) continue; // `![[embed]]`: rendered by the widget field
      const rendered = !touches(state, active, a, b);
      const textFrom = m[3] ? b - 2 - m[3].length : a + m[1].length + 2;
      const attrs = { class: `cm-wikilink${rendered ? " cm-rendered" : ""}`, attributes: { "data-target": m[2].trim() } };
      if (rendered) out.push(hide.range(a, textFrom));
      out.push(Decoration.mark(attrs).range(textFrom, b - 2));
      if (rendered) out.push(hide.range(b - 2, b));
    }
    const inSpan = (p: number) => spans.some(([a, b]) => p >= a && p < b);
    for (const m of state.sliceDoc(from, to).matchAll(TAG)) {
      const a = from + m.index! + m[1].length;
      if (!inCode(state, a) && !inSpan(a)) out.push(tagMark.range(a, a + m[0].length - m[1].length));
    }

    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const heading = /^ATXHeading(\d)$/.exec(node.name);
        if (heading) out.push(Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
        if (inSpan(node.from)) return;
        if (node.name === "Blockquote") {
          const first = state.doc.lineAt(node.from);
          const callout = CALLOUT.exec(first.text);
          const shown = !touches(state, active, node.from, node.to);
          for (let l = first.number; l <= state.doc.lineAt(node.to).number; l++) {
            const cls = callout
              ? `cm-callout cm-callout-${callout[1].toLowerCase()}${l === first.number ? " cm-callout-title" : ""}`
              : "cm-quote";
            out.push(Decoration.line({ class: cls }).range(state.doc.line(l).from));
          }
          if (callout && live && shown) {
            const at = first.from + first.text.indexOf("[!");
            const end = first.from + first.text.indexOf("]", at - first.from) + 1;
            out.push(Decoration.replace({ widget: new CalloutLabel(callout[1].toLowerCase(), !!callout[2]) }).range(at, end));
          }
        }
        if (node.name === "Link") {
          const url = node.node.getChild("URL");
          const marks = node.node.getChildren("LinkMark");
          if (url && marks.length >= 2) {
            const rendered = !touches(state, active, node.from, node.to);
            out.push(Decoration.mark({
              class: `cm-mdlink${rendered ? " cm-rendered" : ""}`,
              attributes: { "data-href": state.sliceDoc(url.from, url.to) },
            }).range(marks[0].to, marks[1].from));
          }
        }
        if (!live || !HIDDEN.has(node.name)) return;
        const parent = node.node.parent!;
        if (node.name === "CodeMark" && parent.name !== "InlineCode") return;
        if ((node.name === "URL" || node.name === "LinkMark") && parent.name !== "Link") return;
        if (touches(state, active, parent.from, parent.to)) return;
        let end = node.to;
        if ((node.name === "HeaderMark" || node.name === "QuoteMark") && state.sliceDoc(end, end + 1) === " ") end++;
        if (end > node.from) out.push(hide.range(node.from, end));
      },
    });
  }
  return Decoration.set(out, true);
}

/** Live preview hides markup off the cursor line and renders widgets; source mode only styles it. */
export const modeExtension = (live: boolean) => (live ? [markupPlugin(true), widgetField] : markupPlugin(false));

const markupPlugin = (live: boolean) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorations(view, live);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = decorations(u.view, live);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

function linkClicks(onLink: () => LinkHandler) {
  return EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink, .cm-mdlink");
      if (!el || !(el.classList.contains("cm-rendered") || e.ctrlKey || e.metaKey) || e.button !== 0) return false;
      e.preventDefault();
      const href = el.dataset.href;
      const newTab = e.ctrlKey || e.metaKey;
      if (el.dataset.target) onLink()(el.dataset.target, "wiki", newTab);
      else if (href) {
        const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
        onLink()(external ? href : decodeURI(href.split("#")[0]), external ? "url" : "md", newTab);
      }
      return true;
    },
  });
}

/** `[[` autocompletion over every note; uses folder paths only when names collide. */
function wikiCompletion() {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/\[\[[^[\]|#]*/);
    if (!m) return null;
    const notes = host.files().filter((f) => f.endsWith(".md"));
    const count = new Map<string, number>();
    for (const n of notes) count.set(basename(n).toLowerCase(), (count.get(basename(n).toLowerCase()) ?? 0) + 1);
    return {
      from: m.from + 2,
      validFor: /^[^[\]|#]*$/,
      options: notes.map((p) => {
        const label = count.get(basename(p).toLowerCase())! > 1 ? p.replace(/\.md$/, "") : basename(p);
        return {
          label,
          detail: dirname(p),
          apply: (view: EditorView, _c: unknown, from: number, to: number) => {
            const closed = view.state.sliceDoc(to, to + 2) === "]]";
            view.dispatch({
              changes: { from, to, insert: closed ? label : label + "]]" },
              selection: { anchor: from + label.length + 2 },
            });
          },
        };
      }),
    };
  };
}

/** Ctrl+L: list item -> task -> done task -> open task, on every selected line. */
function toggleTask(view: EditorView) {
  const changes: { from: number; to?: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const r of view.state.selection.ranges) {
    for (let n = view.state.doc.lineAt(r.from).number; n <= view.state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = view.state.doc.line(n);
      const m = /^(\s*)([-*+] |\d+[.)] )?(\[([ xX])\] )?/.exec(line.text)!;
      const at = line.from + m[1].length + (m[2]?.length ?? 0);
      if (!m[2]) changes.push({ from: line.from + m[1].length, insert: "- [ ] " });
      else if (!m[3]) changes.push({ from: at, insert: "[ ] " });
      else changes.push({ from: at + 1, to: at + 2, insert: m[4] === " " ? "x" : " " });
    }
  }
  view.dispatch({ changes });
  return true;
}

/** Wraps/unwraps each selection in `mark` (bold, italic, code...). */
function toggleWrap(mark: string) {
  return (view: EditorView) => {
    view.dispatch(view.state.changeByRange((r) => {
      const n = mark.length;
      const before = view.state.sliceDoc(r.from - n, r.from), after = view.state.sliceDoc(r.to, r.to + n);
      if (before === mark && after === mark) {
        return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) };
      }
      return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + n, r.to + n) };
    }));
    return true;
  };
}

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700", color: "var(--fv-heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--fv-accent)" },
  { tag: t.monospace, fontFamily: "var(--fv-mono)", color: "var(--fv-code)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--fv-faint)" },
  { tag: t.quote, color: "var(--fv-muted)" },
  { tag: [t.keyword, t.modifier], color: "var(--fv-syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--fv-syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--fv-syn-number)" },
  { tag: [t.comment], color: "var(--fv-faint)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.typeName, t.className], color: "var(--fv-syn-fn)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--fv-syn-prop)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--fv-font-size)", color: "var(--fv-text)", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "var(--fv-font)", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "28px 0 40vh", caretColor: "var(--fv-accent)" },
  ".cm-line": { padding: "0 4px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--fv-accent)", borderLeftWidth: "2px" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--fv-selection) !important" },
  ".cm-tooltip": { background: "var(--fv-bg-2)", border: "1px solid var(--fv-border)", borderRadius: "8px", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--fv-accent)", color: "var(--fv-on-accent)" },
  ".cm-completionDetail": { opacity: 0.6, marginLeft: "8px", fontStyle: "normal" },
  ".cm-panels": { background: "var(--fv-bg-2)", color: "var(--fv-text)", borderColor: "var(--fv-border)" },
  ".cm-searchMatch": { backgroundColor: "var(--fv-match)" },
});

export type EditorOptions = { live: boolean; onLink: () => LinkHandler; readOnly?: boolean; depth?: number };

/** Links clicked inside a transclusion open their target directly. */
const nestedLinks: LinkHandler = (target, kind, newTab) => {
  if (kind === "url") return void openUrl(target);
  const path = resolveFile(target.split("#")[0]);
  if (path) host.open(path, newTab);
};

host.nested = (doc, depth) =>
  new EditorView({ state: createState(doc, { live: true, readOnly: true, depth, onLink: () => nestedLinks }) });

export function createState(doc: string, o: EditorOptions): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      embedDepth.of(o.depth ?? 0),
      EditorState.readOnly.of(!!o.readOnly),
      EditorView.editable.of(!o.readOnly),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }) }),
      syntaxHighlighting(highlight),
      theme,
      previewMode.of(modeExtension(o.live)),
      linkClicks(o.onLink),
      autocompletion({ override: [wikiCompletion()], icons: false }),
      keymap.of([
        { key: "Mod-b", run: toggleWrap("**") },
        { key: "Mod-i", run: toggleWrap("*") },
        { key: "Mod-Shift-x", run: toggleWrap("~~") },
        { key: "Mod-`", run: toggleWrap("`") },
        { key: "Mod-l", run: toggleTask },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab,
      ]),
    ],
  });
}
