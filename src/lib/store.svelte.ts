import type { EditorView } from "@codemirror/view";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, basename, dirname, fillTemplate, join, type Entry, type VaultConfig } from "./api";
import { host } from "./widgets";

export type Settings = {
  theme: "system" | "light" | "dark";
  fontSize: number;
  livePreview: boolean;
  readableWidth: boolean;
  /** OpenAI-compatible endpoint for in-app AI (local server by default) and the chosen model. */
  aiBaseUrl: string;
  aiModel: string;
};
export type Pane = { tabs: string[]; active: number };
export type Command = { id: string; name: string; keys?: string; run: () => unknown };
export type PickItem = { label: string; detail?: string; run: (newTab: boolean) => unknown };
export type PaletteMode =
  | { kind: "switcher" }
  | { kind: "commands" }
  | { kind: "pick"; placeholder: string; items: PickItem[] }
  | { kind: "prompt"; title: string; value: string; resolve: (v: string | null) => void };

/** Tab "path" for the global graph view. */
export const GRAPH = "fermi:graph";

const DEFAULTS: Settings = { theme: "system", fontSize: 16, livePreview: true, readableWidth: true, aiBaseUrl: "", aiModel: "" };

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("fv-settings") ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

class App {
  root = $state<string | null>(null);
  files = $state<Entry[]>([]);
  panes = $state<Pane[]>([{ tabs: [], active: 0 }]);
  focus = $state(0);
  left = $state<"files" | "search" | "tags" | "bookmarks" | "ai">("files");
  right = $state<"backlinks" | "outline" | "graph" | "chat">("backlinks");
  /** Per-vault settings stored in `.fermi/config.json`. */
  config = $state<VaultConfig>({});
  /** Note whose snapshots the file-recovery dialog is showing. */
  recovery = $state<string | null>(null);
  showLeft = $state(true);
  showRight = $state(true);
  palette = $state<PaletteMode | null>(null);
  showSettings = $state(false);
  settings = $state<Settings>(loadSettings());
  /** Text of the focused editor (outline, word count). */
  docText = $state("");
  /** Bumped whenever files change on disk; panels re-query on change. */
  version = $state(0);
  error = $state<string | null>(null);
  /** Pending cursor jump, consumed by the editor showing that note. */
  jump = $state<{ path: string; line: number } | null>(null);
  /** Live editor per pane, for commands like outline jump. */
  views: (EditorView | undefined)[] = [];

  notes = $derived(this.files.filter((f) => !f.dir && f.path.endsWith(".md")).map((f) => f.path));

  get activePath(): string | null {
    const p = this.panes[this.focus];
    return p?.tabs[p.active] ?? null;
  }

  saveSettings() {
    try {
      localStorage.setItem("fv-settings", JSON.stringify(this.settings));
    } catch {}
  }

  async openVault(path: string) {
    try {
      this.root = await api.openVault(path);
      this.panes = [{ tabs: [], active: 0 }];
      this.focus = 0;
      this.config = await api.config();
      await this.refreshFiles();
    } catch (e) {
      this.error = String(e);
    }
  }

  async refreshFiles() {
    this.files = await api.listFiles();
    this.version++;
  }

  /** Opens `path` in the focused pane, reusing its tab if already open. */
  open(path: string, newTab = false) {
    const pane = this.panes[this.focus];
    const i = pane.tabs.indexOf(path);
    if (i >= 0) pane.active = i;
    else if (newTab || pane.tabs.length === 0) {
      pane.tabs.push(path);
      pane.active = pane.tabs.length - 1;
    } else pane.tabs[pane.active] = path;
  }

  /** Opens `path` and puts the cursor on `line` (1-based) once it's loaded. */
  goto(path: string, line: number) {
    this.jump = { path, line };
    this.open(path);
  }

  /** Opens a link target, creating the note if it doesn't exist yet. */
  async openLink(target: string, newTab = false) {
    const resolved = await api.resolve(target);
    if (resolved) return this.open(resolved, newTab);
    const path = target.endsWith(".md") ? target : `${target}.md`;
    await api.create(path, "");
    await this.refreshFiles();
    this.open(path, newTab);
  }

  closeTab(pi = this.focus, ti = this.panes[pi]?.active ?? 0) {
    const pane = this.panes[pi];
    if (!pane) return;
    pane.tabs.splice(ti, 1);
    pane.active = Math.max(0, Math.min(pane.active, pane.tabs.length - 1));
    if (pane.tabs.length === 0 && this.panes.length > 1) {
      this.panes.splice(pi, 1);
      this.views.splice(pi, 1);
      this.focus = 0;
    }
  }

  splitRight() {
    const path = this.activePath;
    this.panes.push({ tabs: path ? [path] : [], active: 0 });
    this.focus = this.panes.length - 1;
  }

  /** Keeps tabs and bookmarks pointing at the right file after a rename/move. */
  renamed(from: string, to: string) {
    const move = (t: string) => (t === from ? to : t.startsWith(from + "/") ? to + t.slice(from.length) : t);
    for (const p of this.panes) p.tabs = p.tabs.map(move);
    if (this.config.bookmarks?.some((b) => move(b) !== b)) this.saveConfig({ bookmarks: this.config.bookmarks.map(move) });
  }

  async saveConfig(patch: Partial<VaultConfig>) {
    this.config = { ...this.config, ...patch };
    await api.setConfig($state.snapshot(this.config)).catch((e) => (this.error = String(e)));
  }

  isBookmarked(path: string | null) {
    return !!path && !!this.config.bookmarks?.includes(path);
  }

  toggleBookmark(path: string | null) {
    if (!path) return;
    const list = this.config.bookmarks ?? [];
    this.saveConfig({ bookmarks: list.includes(path) ? list.filter((b) => b !== path) : [...list, path] });
  }

  /** Opens today's daily note, creating it (from the daily template, if set) when missing. */
  async dailyNote() {
    const title = fillTemplate("{{date}}", "");
    const path = join(this.config.dailyFolder ?? "daily", `${title}.md`);
    if (!this.notes.includes(path)) {
      const tpl = this.config.dailyTemplate ? await api.read(this.config.dailyTemplate).catch(() => "") : `# ${title}\n\n`;
      await api.create(path, fillTemplate(tpl, title)).catch((e) => (this.error = String(e)));
      await this.refreshFiles();
    }
    this.open(path);
  }

  /** Lets the user pick a note from the templates folder and inserts it at the cursor. */
  insertTemplate() {
    const folder = (this.config.templatesFolder ?? "templates") + "/";
    const view = this.views[this.focus];
    const target = this.activePath;
    const templates = this.notes.filter((n) => n.startsWith(folder));
    if (!view || !target?.endsWith(".md")) return void (this.error = "Open a note first, then insert a template.");
    if (!templates.length) return void (this.error = `No templates yet. Add notes to the “${folder}” folder.`);
    this.palette = {
      kind: "pick",
      placeholder: "Insert template…",
      items: templates.map((t) => ({
        label: basename(t),
        detail: dirname(t),
        run: async () => {
          const text = fillTemplate(await api.read(t), basename(target));
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
        },
      })),
    };
  }

  removed(path: string) {
    this.panes.forEach((p, pi) => {
      for (let ti = p.tabs.length - 1; ti >= 0; ti--) if (p.tabs[ti] === path || p.tabs[ti].startsWith(path + "/")) this.closeTab(pi, ti);
    });
  }

  async newNote(dir = "") {
    const path = this.untitled(dir);
    await api.create(path);
    await this.refreshFiles();
    this.open(path, true);
  }

  async move(from: string, to: string) {
    try {
      await api.rename(from, to);
      this.renamed(from, to);
      await this.refreshFiles();
    } catch (e) {
      this.error = String(e);
    }
  }

  /** Prompts for a new name; notes keep their `.md` and links to them are rewritten. */
  async rename(path: string, dir = false) {
    const old = path.split("/").pop()!;
    const name = await this.ask("Rename to", dir ? old : old.replace(/\.md$/, ""));
    if (!name || name === old) return;
    const md = !dir && path.endsWith(".md") && !name.endsWith(".md");
    await this.move(path, join(dirname(path), md ? name + ".md" : name));
  }

  async remove(path: string) {
    if (!(await ask(`Move "${path}" to the vault trash (.fermi/trash)?`, { title: "Delete", kind: "warning" }))) return;
    try {
      await api.trash(path);
      this.removed(path);
      await this.refreshFiles();
    } catch (e) {
      this.error = String(e);
    }
  }

  ask(title: string, value = ""): Promise<string | null> {
    return new Promise((resolve) => (this.palette = { kind: "prompt", title, value, resolve }));
  }

  /** A fresh "Untitled N.md" path in `dir`. */
  untitled(dir = ""): string {
    const taken = new Set(this.notes.map((n) => n.toLowerCase()));
    for (let i = 0; ; i++) {
      const name = `${dir ? dir + "/" : ""}Untitled${i ? " " + i : ""}.md`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }
}

export const app = new App();

// Services the editor widgets (embeds, images, transclusion) need from the app.
Object.assign(host, {
  root: () => app.root ?? "",
  files: () => app.files.filter((f) => !f.dir).map((f) => f.path),
  read: (path: string) => api.read(path),
  open: (path: string, newTab: boolean) => app.open(path, newTab),
  dark: () => document.documentElement.dataset.theme === "dark",
});
