// Web clipper: turns a page into a note. The page is downloaded by Rust (`fetch_page`), parsed
// into an inert document (DOMParser: no scripts run, nothing loads) and cleaned up by defuddle,
// which is imported on the first clip only. The note-building parts at the top are pure and
// tested in tests/clipper.test.ts.

import { setProp } from "./frontmatter.ts";

export type ClipMeta = { title?: string; author?: string; published?: string; description?: string; site?: string; domain?: string };

/** A file name for the clipped note: the title, minus characters no OS allows in names. */
export function clipFileName(title: string | undefined, url: string): string {
  const fallback = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "Clipping";
    }
  })();
  const name = (title ?? "")
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  return name || fallback;
}

/** The note: frontmatter (title, source, author, published, description, clipped, tags) and the article. */
export function clipNote(meta: ClipMeta, markdown: string, url: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const clipped = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const title = meta.title?.trim() || clipFileName(undefined, url);
  let text = `# ${title}\n\n${markdown.trim()}\n`;
  const props: [string, string | string[] | undefined][] = [
    ["title", title],
    ["source", url],
    ["author", meta.author?.trim()],
    ["published", meta.published?.trim().slice(0, 10)],
    ["description", meta.description?.trim().replace(/\s+/g, " ").slice(0, 300)],
    ["clipped", clipped],
    ["tags", ["clipping"]],
  ];
  for (const [k, v] of props) if (v && v.length) text = setProp(text, k, v);
  return text;
}

/** `dir/name.md`, or `dir/name 2.md` etc. if taken. */
export function uniquePath(dir: string, name: string, taken: (path: string) => boolean): string {
  for (let i = 1; ; i++) {
    const p = `${dir ? dir + "/" : ""}${name}${i > 1 ? ` ${i}` : ""}.md`;
    if (!taken(p.toLowerCase())) return p;
  }
}

/** Downloads `url` and returns the cleaned-up article as Markdown plus its metadata. */
export async function extract(fetchPage: (url: string) => Promise<{ url: string; html: string }>, url: string) {
  const page = await fetchPage(url);
  const doc = new DOMParser().parseFromString(page.html, "text/html");
  // Relative links and images resolve against the page's real address.
  const base = doc.createElement("base");
  base.href = page.url;
  doc.head.prepend(base);
  const { default: Defuddle } = await import("defuddle/full");
  const r = new Defuddle(doc, { url: page.url, markdown: true }).parse();
  if (!r.content?.trim()) throw new Error("Couldn't find an article on that page.");
  return { url: page.url, markdown: r.content, meta: r as ClipMeta };
}
