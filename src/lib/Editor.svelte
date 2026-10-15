<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import type { EditorState, Transaction } from "@codemirror/state";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { createState, modeExtension, previewMode, type LinkHandler } from "./editor";
  import { api, dirname } from "./api";
  import { PaneDocs, saveDoc, type Doc } from "./docs";
  import { app, type EditorHandle } from "./store.svelte";

  let { pane, path }: { pane: number; path: string } = $props();

  let host: HTMLDivElement;
  let view: EditorView;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const text = (s: EditorState) => s.doc.toString();
  const options = () => ({ live: app.settings.livePreview, onLink: () => onLink });

  /** Notes open in this pane; each keeps its undo history, cursor and unsaved edits across tab switches. */
  const docs = new PaneDocs<EditorState>({
    read: api.read,
    create: (t) => createState(t, options()),
    text,
    vault: () => app.root ?? "",
    save: (d) => persist(d),
  });

  const onLink: LinkHandler = (target, kind, newTab) => {
    if (kind === "url") return void openUrl(target);
    if (kind === "md") {
      // Relative to this note's folder.
      const parts = (dirname(docs.doc?.path ?? "") + "/" + target).split("/");
      const out: string[] = [];
      for (const p of parts) p === ".." ? out.pop() : p && p !== "." && out.push(p);
      target = out.join("/");
    }
    const note = target.split("#")[0].trim();
    if (note) app.openLink(note, newTab);
  };

  function publish() {
    if (app.focus === pane) app.docText = view.state.doc.toString();
  }

  /** Queues a save of `d`. On failure the edits stay in the doc and are retried every few seconds. */
  function persist(d: Doc<EditorState>): Promise<boolean> {
    clearTimeout(d.retry);
    return saveDoc(d, text, api.write).then(
      (conflict) => {
        if (conflict) app.error = `${d.path} was also changed outside FermiVault. Your version is saved; the other one is in File recovery.`;
        return true;
      },
      (e) => {
        if (d.closed) return false;
        app.error = `Couldn't save ${d.path}: ${e}. Your changes are kept and FermiVault keeps retrying.`;
        d.retry = setTimeout(() => persist(d), 5000);
        return false;
      },
    );
  }

  function save() {
    clearTimeout(timer);
    timer = undefined;
    return docs.doc ? persist(docs.doc) : Promise.resolve(true);
  }

  const handle: EditorHandle = {
    get view() {
      return view;
    },
    async flush() {
      clearTimeout(timer);
      timer = undefined;
      return (await Promise.all(docs.docs.map(persist))).every(Boolean);
    },
    renamed(from, to) {
      const reload = docs.renamed(from, to);
      if (reload) load(reload); // a read of the old path was still in flight
    },
    closed(path) {
      docs.closed(path);
    },
  };

  function applyJump() {
    const j = app.jump;
    if (!j || !docs.doc || j.path !== docs.doc.path || app.focus !== pane) return;
    app.jump = null;
    const line = view.state.doc.line(Math.min(Math.max(j.line, 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    view.focus();
  }

  async function load(p: string) {
    clearTimeout(timer);
    timer = undefined;
    const r = await docs.open(p);
    if (!r) return; // superseded by a later switch
    if ("error" in r) {
      app.error = String(r.error);
      view.setState(createState("", options())); // don't leave the previous note's text under this tab
      return;
    }
    if (docs.doc !== r.doc) return;
    view.setState(r.doc.state);
    view.dispatch({ effects: previewMode.reconfigure(modeExtension(app.settings.livePreview)) });
    publish();
    if (app.focus === pane) view.focus();
    applyJump();
  }

  /** Disk changed (agent, sync tool, other pane): adopt it unless we have unsaved edits. */
  async function reloadIfChanged() {
    const d = docs.doc;
    if (!d || timer) return;
    const disk = await api.read(d.path).catch(() => null);
    if (disk === null || d !== docs.doc || timer || disk === d.saved || text(d.state) !== d.saved) return;
    d.saved = disk;
    const head = Math.min(view.state.selection.main.head, disk.length);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: disk }, selection: { anchor: head } });
    publish();
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: createState("", options()),
      dispatchTransactions(trs: readonly Transaction[], v: EditorView) {
        const d = docs.doc;
        // While a note loads, the view still shows the previous one: edits would land in no file.
        if (!d && trs.some((t) => t.docChanged)) return;
        v.update(trs);
        if (d) d.state = v.state;
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
    app.editors.add(handle);
    load(path);
  });

  onDestroy(() => {
    clearTimeout(timer);
    for (const d of docs.docs) persist(d); // pane closing: queue every unsaved note (saves use the doc, not the view)
    app.editors.delete(handle);
    view?.destroy();
  });

  $effect(() => {
    if (view && path !== docs.target) load(path);
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
