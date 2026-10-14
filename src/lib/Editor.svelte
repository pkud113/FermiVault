<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import type { EditorState, Transaction } from "@codemirror/state";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { createState, modeExtension, previewMode, type LinkHandler } from "./editor";
  import { api, dirname } from "./api";
  import { app } from "./store.svelte";

  let { pane, path }: { pane: number; path: string } = $props();

  let host: HTMLDivElement;
  let view: EditorView;
  /** Per-pane state cache keeps undo history and cursor across tab switches. */
  const cache = new Map<string, EditorState>();
  let current: string | null = null;
  let saved = ""; // what we last read from / wrote to disk
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;

  const onLink: LinkHandler = (target, kind, newTab) => {
    if (kind === "url") return void openUrl(target);
    if (kind === "md") {
      // Relative to this note's folder.
      const parts = (dirname(current ?? "") + "/" + target).split("/");
      const out: string[] = [];
      for (const p of parts) p === ".." ? out.pop() : p && p !== "." && out.push(p);
      target = out.join("/");
    }
    const note = target.split("#")[0].trim();
    if (note) app.openLink(note, newTab);
  };

  const options = () => ({ live: app.settings.livePreview, onLink: () => onLink });

  function publish() {
    if (app.focus === pane) app.docText = view.state.doc.toString();
  }

  function save() {
    clearTimeout(timer);
    timer = undefined;
    if (!current) return;
    const text = view.state.doc.toString();
    if (text === saved) return;
    saved = text;
    api.write(current, text).catch((e) => (app.error = `Save failed: ${e}`));
  }

  function applyJump() {
    const j = app.jump;
    if (!j || loading || j.path !== current || app.focus !== pane) return;
    app.jump = null;
    const line = view.state.doc.line(Math.min(Math.max(j.line, 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    view.focus();
  }

  async function load(p: string) {
    save();
    if (current) cache.set(current, view.state);
    current = p;
    loading = true;
    let text: string;
    try {
      text = await api.read(p);
    } catch (e) {
      app.error = String(e);
      return;
    } finally {
      if (current === p) loading = false;
    }
    if (current !== p) return; // user switched again while reading
    const cached = cache.get(p);
    view.setState(cached && cached.doc.toString() === text ? cached : createState(text, options()));
    view.dispatch({ effects: previewMode.reconfigure(modeExtension(app.settings.livePreview)) });
    saved = text;
    publish();
    if (app.focus === pane) view.focus();
    applyJump();
  }

  /** Disk changed (agent, sync tool, other pane): adopt it unless we have unsaved edits. */
  async function reloadIfChanged() {
    if (!current || timer) return;
    const p = current;
    const text = await api.read(p).catch(() => null);
    if (text === null || p !== current || timer || text === saved || view.state.doc.toString() !== saved) return;
    saved = text;
    const head = Math.min(view.state.selection.main.head, text.length);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
    publish();
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: createState("", options()),
      dispatchTransactions(trs: readonly Transaction[], v: EditorView) {
        v.update(trs);
        if (trs.some((t) => t.docChanged)) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            save();
            publish();
          }, 400);
        }
      },
    });
    app.views[pane] = view;
    load(path);
  });

  onDestroy(() => {
    save();
    view?.destroy();
  });

  $effect(() => {
    if (view && path !== current) load(path);
  });
  $effect(() => {
    app.version;
    if (view) reloadIfChanged();
  });
  $effect(() => {
    const live = app.settings.livePreview;
    view?.dispatch({ effects: previewMode.reconfigure(modeExtension(live)) });
  });
  $effect(() => {
    if (app.focus === pane && view) publish();
  });
  $effect(() => {
    if (app.jump && view) applyJump();
  });
</script>

<div
  class="editor"
  class:readable={app.settings.readableWidth}
  bind:this={host}
  onfocusin={() => (app.focus = pane)}
></div>

<style>
  .editor {
    height: 100%;
    overflow: hidden;
  }
  .editor.readable :global(.cm-content) {
    max-width: 760px;
    margin: 0 auto;
  }
  .editor :global(.cm-content) {
    padding-left: 32px;
    padding-right: 32px;
  }
</style>
