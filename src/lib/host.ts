// What the editor's widgets need from the app, kept free of CodeMirror so the startup bundle
// doesn't include the editor. The editor (CodeMirror and its Markdown languages, the biggest part
// of the app) loads just after the first frame; see `loadEditor`.

import type { EditorView } from "@codemirror/view";
import type { Table } from "./api";

/** App services the widgets need; filled in by the app at startup. */
export const host = {
  root: () => "",
  files: (): string[] => [],
  read: async (_path: string) => "",
  open: (_path: string, _newTab: boolean) => {},
  dark: () => false,
  remoteImages: () => false,
  query: async (_text: string): Promise<Table> => ({ columns: [], rows: [], total: 0 }),
  /** Read-only live-preview editor for transclusions (set by editor.ts to avoid an import cycle). */
  nested: (_doc: string, _depth: number): EditorView => {
    throw new Error("nested editor not configured");
  },
};

/** ```table``` widgets on screen, re-run when files change. */
export const liveTables = new Set<() => void>();

/** Re-runs every table on screen; the app calls this when files change. */
export function refreshTables() {
  for (const run of liveTables) run();
}

let editor: Promise<typeof import("./Editor.svelte")> | undefined;

/** Loads the editor once (this also sets `host.nested`). */
export const loadEditor = () => (editor ??= import("./Editor.svelte"));
