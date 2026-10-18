// Read and edit note properties (YAML frontmatter). Same flat subset as the index
// (`parse::properties` in Rust): `key: value`, `key: [a, b]` and `- item` lists. Edits touch
// only the lines of the property they change, so anything else in the frontmatter (comments,
// nested maps) is kept as written. No Svelte/DOM: tested in tests/frontmatter.test.ts.

export type PropValue = string | string[];
export type Prop = { key: string; value: PropValue };

/** [start of first line, end of the closing `---` line incl. newline], or null. */
function block(text: string): [number, number] | null {
  if (!/^---\r?\n/.test(text)) return null;
  let pos = text.indexOf("\n") + 1;
  while (pos < text.length) {
    const end = text.indexOf("\n", pos);
    const line = text.slice(pos, end < 0 ? text.length : end);
    const next = end < 0 ? text.length : end + 1;
    if (line.trimEnd() === "---") return [0, next];
    pos = next;
  }
  return null;
}

/** Where the note body starts: just after the properties block (0 without one). */
export const bodyStart = (text: string) => block(text)?.[1] ?? 0;

/** The note without its properties block, for previews and embeds. */
export const body = (text: string) => text.slice(bodyStart(text));

type Entry = Prop & { from: number; to: number };

const unquote = (s: string) => {
  s = s.trim();
  if (!/^["']/.test(s)) s = s.replace(/\s+#.*$/, "");
  const m = /^"(.*)"$/.exec(s) ?? /^'(.*)'$/.exec(s);
  return m ? m[1] : s;
};

/** Properties with the text range of their lines (key line plus any `- item` lines). */
function entries(text: string): Entry[] {
  const b = block(text);
  if (!b) return [];
  const out: Entry[] = [];
  let pos = text.indexOf("\n") + 1;
  let cur: Entry | null = null;
  while (pos < b[1]) {
    const end = text.indexOf("\n", pos);
    const next = end < 0 ? text.length : end + 1;
    const line = text.slice(pos, next).replace(/\r?\n$/, "");
    if (line.trimEnd() === "---") break;
    const item = /^(\s+|)- (.*)$/.exec(line);
    if (cur && (item || /^\s/.test(line) || !line.trim())) {
      if (item && Array.isArray(cur.value)) cur.value.push(unquote(item[2]));
      if (line.trim()) cur.to = next; // nested lines belong to the key above
    } else {
      cur = null;
      const m = /^([^\s#:][^:]*):(.*)$/.exec(line);
      if (m) {
        const v = m[2].trim().replace(/^([^"'].*?)\s+#.*$/, "$1");
        const list = /^\[(.*)\]$/.exec(v);
        const value: PropValue = list ? list[1].split(",").map(unquote).filter(Boolean) : v === "" ? [] : unquote(v);
        cur = { key: unquote(m[1]), value, from: pos, to: next };
        out.push(cur);
      }
    }
    pos = next;
  }
  return out;
}

/** Properties in order. An empty `key:` reads as an empty list. */
export function readProps(text: string): Prop[] {
  return entries(text).map(({ key, value }) => ({ key, value }));
}

/** A YAML scalar, quoted only when plain YAML would misread it. */
function scalar(v: string): string {
  return v === "" || /^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|: | #|^(null|~)$/i.test(v) ? JSON.stringify(v) : v;
}

function serialize(key: string, value: PropValue): string {
  const k = /[:#]|^\s|\s$/.test(key) ? JSON.stringify(key) : key;
  return `${k}: ${Array.isArray(value) ? `[${value.map(scalar).join(", ")}]` : scalar(value)}\n`;
}

/** Sets (or adds) a property, keeping everything else as written. */
export function setProp(text: string, key: string, value: PropValue): string {
  const b = block(text);
  if (!b) return `---\n${serialize(key, value)}---\n${text}`;
  const e = entries(text).find((x) => x.key === key);
  if (e) return text.slice(0, e.from) + serialize(key, value) + text.slice(e.to);
  const close = text.lastIndexOf("---", b[1] - 1); // the closing fence
  return text.slice(0, close) + serialize(key, value) + text.slice(close);
}

/** Removes a property; drops the frontmatter block if nothing is left in it. */
export function removeProp(text: string, key: string): string {
  const e = entries(text).find((x) => x.key === key);
  if (!e) return text;
  const out = text.slice(0, e.from) + text.slice(e.to);
  const b = block(out);
  return b && !out.slice(text.indexOf("\n") + 1, b[1]).replace(/^---\s*$/m, "").trim() ? out.slice(b[1]) : out;
}

/** The single change turning `a` into `b` (common prefix and suffix kept), for editor transactions. */
export function diffChange(a: string, b: string): { from: number; to: number; insert: string } {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}
