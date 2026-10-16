import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Entry = { path: string; dir: boolean };
export type Hit = { path: string; snippet: string };
export type LinkRef = { path: string; line: number; context: string };
export type Snapshot = { id: string; time: number; size: number };
export type Graph = { nodes: string[]; edges: [string, string][] };
export type VaultConfig = { bookmarks?: string[]; dailyFolder?: string; templatesFolder?: string; dailyTemplate?: string; clipFolder?: string; gitAutoSync?: number };
export type ChunkRef = { path: string; heading: string; line: number; text: string };
export type EmbedStatus = { installed: boolean; running: boolean; pending: number; total: number; model: string };
export type Endpoint = { name: string; base_url: string; models: string[] };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
/** Result of a ```table``` query (see src-tauri/src/query.rs). */
export type Table = { columns: string[]; rows: { path: string; cells: string[] }[]; total: number };
export type GitStatus = { git: boolean; repo: boolean; branch: string | null; remote: string | null; changes: number };
export type GitSynced = { committed: number; pulled: boolean; pushed: boolean; conflicts: string[] };
export type AiApp = { id: string; name: string; file: string; detected: boolean; connected: boolean; vault: string | null };

export const api = {
  lastVault: () => invoke<string | null>("last_vault"),
  openVault: (path: string) => invoke<string>("open_vault", { path }),
  listFiles: () => invoke<Entry[]>("list_files"),
  read: (path: string) => invoke<string>("read_note", { path }),
  /** `vault` is the root the note was opened from; the backend refuses writes meant for another vault.
   *  `base` is the text last read or written; resolves true if disk had changed since (that version is kept as a snapshot). */
  write: (vault: string, path: string, content: string, base: string) => invoke<boolean>("write_note", { vault, path, content, base }),
  create: (path: string, content = "") => invoke<void>("create_note", { path, content }),
  mkdir: (path: string) => invoke<void>("create_folder", { path }),
  rename: (from: string, to: string) => invoke<number>("rename_path", { from, to }),
  trash: (path: string) => invoke<void>("trash_path", { path }),
  search: (query: string) => invoke<Hit[]>("search", { query }),
  query: (text: string) => invoke<Table>("query", { text }),
  gitStatus: () => invoke<GitStatus>("git_status"),
  gitInit: () => invoke<void>("git_init"),
  gitSetRemote: (url: string) => invoke<void>("git_set_remote", { url }),
  /** `interactive: false` for background syncs: never opens a sign-in window. */
  gitSync: (interactive: boolean) => invoke<GitSynced>("git_sync", { interactive }),
  fetchPage: (url: string) => invoke<{ url: string; html: string }>("fetch_page", { url }),
  backlinks: (path: string) => invoke<LinkRef[]>("backlinks", { path }),
  resolve: (target: string) => invoke<string | null>("resolve_link", { target }),
  graph: () => invoke<Graph>("graph"),
  tags: () => invoke<[string, number][]>("tags"),
  tagged: (tag: string) => invoke<string[]>("tagged", { tag }),
  config: () => invoke<VaultConfig>("vault_config"),
  setConfig: (value: VaultConfig) => invoke<void>("set_vault_config", { value }),
  snapshots: (path: string) => invoke<Snapshot[]>("snapshots", { path }),
  readSnapshot: (path: string, id: string) => invoke<string>("read_snapshot", { path, id }),
  restoreSnapshot: (path: string, id: string) => invoke<void>("restore_snapshot", { path, id }),
  aiContext: (query: string, k = 6) => invoke<ChunkRef[]>("ai_context", { query, k }),
  related: (path: string) => invoke<[string, number][]>("related", { path }),
  embedStatus: () => invoke<EmbedStatus>("embed_status"),
  embedInstall: () => invoke<void>("embed_install"),
  aiDetect: () => invoke<Endpoint[]>("ai_detect"),
  aiModels: (baseUrl: string) => invoke<string[]>("ai_models", { baseUrl }),
  aiSetKey: (baseUrl: string, key: string | null) => invoke<void>("ai_set_key", { baseUrl, key }),
  aiHasKey: (baseUrl: string) => invoke<boolean>("ai_has_key", { baseUrl }),
  aiApps: () => invoke<AiApp[]>("ai_apps"),
  aiPreview: (id: string) => invoke<string>("ai_preview", { id }),
  aiSet: (id: string, connected: boolean) => invoke<void>("ai_set", { id, connected }),
};

export const basename = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export type FileKind = "note" | "canvas" | "image" | "pdf" | "audio" | "video" | "other";
const KINDS: Record<string, FileKind> = {
  md: "note", canvas: "canvas", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", avif: "image", bmp: "image",
  pdf: "pdf", mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio", mp4: "video", webm: "video", mov: "video",
};
export const kind = (p: string): FileKind => KINDS[p.split(".").pop()!.toLowerCase()] ?? "other";

/** URL for a vault file through Tauri's asset protocol (scoped to the open vault). */
export function assetUrl(root: string, path: string) {
  const sep = root.includes("\\") ? "\\" : "/";
  return convertFileSrc(root + sep + path.split("/").join(sep));
}

/** What a Markdown image URL points at: a vault path, a web (http/https) image, or nothing we load
 *  (other schemes). A malformed %-escape is used as written instead of throwing. */
export function imageTarget(raw: string): { path: string } | { web: string } | null {
  let href = raw;
  try {
    href = decodeURI(raw);
  } catch {}
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) return { path: href };
  return URL.canParse(href) && /^https?:$/i.test(new URL(href).protocol) ? { web: href } : null;
}

/** Byte range of the section under `heading` (heading line up to the next heading of the same or higher level). */
export function sectionRange(text: string, heading: string): [number, number] | null {
  const want = heading.trim().replace(/^#+/, "").trim().toLowerCase();
  let start: [number, number] | null = null, pos = 0, fence = false;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trimEnd());
    if (m) {
      if (start && m[1].length <= start[1]) return [start[0], pos];
      if (!start && m[2].toLowerCase() === want) start = [pos, m[1].length];
    }
    pos += line.length;
  }
  return start ? [start[0], text.length] : null;
}

/** Fills `{{title}}`, `{{date}}` and `{{time}}` in template text. */
export function fillTemplate(text: string, title: string, now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return text.replaceAll("{{title}}", title).replaceAll("{{date}}", date).replaceAll("{{time}}", time);
}

/** Fuzzy subsequence score (higher is better), or -1 if `q` doesn't match. */
export function fuzzy(q: string, s: string): number {
  q = q.toLowerCase();
  const t = s.toLowerCase();
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    run = i === ti ? run + 1 : 0;
    const boundary = i === 0 || "/ -_".includes(t[i - 1]);
    score += 1 + run * 2 + (boundary ? 3 : 0);
    ti = i + 1;
  }
  return score - t.length * 0.01;
}

/** Streams a chat completion from the configured model. `onText` gets each fragment;
 *  `done` settles when the model finishes (rejects with the error message). */
export function streamChat(baseUrl: string, model: string, messages: ChatMessage[], onText: (t: string) => void) {
  const id = crypto.randomUUID();
  const done = new Promise<void>(async (resolve, reject) => {
    const offDelta = await listen<{ id: string; text: string }>("ai-delta", (e) => e.payload.id === id && onText(e.payload.text));
    const offDone = await listen<{ id: string; error: string | null }>("ai-done", (e) => {
      if (e.payload.id !== id) return;
      offDelta();
      offDone();
      e.payload.error ? reject(new Error(e.payload.error)) : resolve();
    });
    invoke("ai_chat", { id, baseUrl, model, messages }).catch((e) => (offDelta(), offDone(), reject(e)));
  });
  return { done, cancel: () => invoke("ai_cancel", { id }) };
}
