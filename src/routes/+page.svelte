<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ask, open as pickFolder } from "@tauri-apps/plugin-dialog";
  import { api, basename, dirname, kind } from "$lib/api";
  import { app, GRAPH, type Command } from "$lib/store.svelte";
  import { ai, inlineAI } from "$lib/ai.svelte";
  import Bookmarks from "$lib/Bookmarks.svelte";
  import Graph from "$lib/Graph.svelte";
  import Icon from "$lib/Icon.svelte";
  import Recovery from "$lib/Recovery.svelte";
  import TagsPane from "$lib/TagsPane.svelte";
  import Viewer from "$lib/Viewer.svelte";
  import Editor from "$lib/Editor.svelte";
  import FileTree from "$lib/FileTree.svelte";
  import SearchPane from "$lib/SearchPane.svelte";
  import RightPanel from "$lib/RightPanel.svelte";
  import Connections from "$lib/Connections.svelte";
  import Palette from "$lib/Palette.svelte";
  import Settings from "$lib/Settings.svelte";
  import { MAX_PANEL, MIN_PANEL, clampPanel, sidebars } from "$lib/ui";
  import { tabKeys } from "$lib/modal";
  import { refreshTables } from "$lib/widgets";

  let ready = $state(false);
  let leftW = $state(260);
  let rightW = $state(280);
  let vw = $state(1280);
  // Sidebars yield to the editor on narrow windows; show/hide settings are kept for when it widens.
  const side = $derived(
    sidebars(vw, app.panes.length, { show: app.showLeft, width: leftW }, { show: app.showRight, width: rightW }, app.firstSide),
  );
  const lw = $derived(side.left);
  const rw = $derived(side.right);
  let dark = $state(false);

  async function chooseVault() {
    const dir = await pickFolder({ directory: true, title: "Open a folder as a vault" });
    if (typeof dir === "string") await app.openVault(dir);
  }

  async function clipPage() {
    const url = (await app.ask("Web page to clip (https://…)"))?.trim();
    if (url) app.clip(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
  }

  /** Inserts a starter ```table``` block at the cursor. */
  function insertTable() {
    const ed = app.focusedEditor();
    const doc = ed?.doc();
    if (!ed || !doc) return void (app.error = "Open a note first.");
    const block = "```table\nfrom: #project\nwhere: status != done\nsort: due\ncolumns: file, status, due\n```\n";
    ed.apply(doc, doc.state.replaceSelection(block));
  }

  function cycleTab(step: number) {
    const p = app.panes[app.focus];
    if (p?.tabs.length) p.active = (p.active + step + p.tabs.length) % p.tabs.length;
  }

  const commands: Command[] = [
    { id: "switcher", name: "Quick switcher: open or create a note", keys: "Ctrl+O", run: () => (app.palette = { kind: "switcher" }) },
    { id: "new", name: "New note", keys: "Ctrl+N", run: () => app.newNote(dirname(app.activePath ?? "")) },
    { id: "new-canvas", name: "New canvas", run: () => app.newCanvas(dirname(app.activePath ?? "")) },
    { id: "clip", name: "Clip web page as a note…", run: clipPage },
    { id: "search", name: "Search vault", keys: "Ctrl+Shift+F", run: () => (app.reveal("left"), (app.left = "search")) },
    { id: "rename", name: "Rename current note", keys: "F2", run: () => app.activePath && app.rename(app.activePath) },
    { id: "delete", name: "Delete current note", run: () => app.activePath && app.remove(app.activePath) },
    { id: "close", name: "Close tab", keys: "Ctrl+W", run: () => app.closeTab() },
    { id: "next", name: "Next tab", keys: "Ctrl+Tab", run: () => cycleTab(1) },
    { id: "prev", name: "Previous tab", keys: "Ctrl+Shift+Tab", run: () => cycleTab(-1) },
    { id: "split", name: "Split right", keys: "Ctrl+\\", run: () => app.splitRight() },
    { id: "live", name: "Toggle live preview / source mode", keys: "Ctrl+E", run: () => (app.settings.livePreview = !app.settings.livePreview) },
    { id: "daily", name: "Open today's daily note", keys: "Ctrl+Shift+D", run: () => app.dailyNote() },
    { id: "template", name: "Insert template", keys: "Ctrl+Shift+T", run: () => app.insertTemplate() },
    { id: "graph", name: "Open graph view", keys: "Alt+G", run: () => app.open(GRAPH, true) },
    { id: "local-graph", name: "Show local graph", run: () => (app.reveal("right"), (app.right = "graph")) },
    { id: "bookmark", name: "Bookmark / unbookmark current note", run: () => app.toggleBookmark(app.activePath) },
    {
      id: "recovery",
      name: "File recovery: restore an earlier version of this note",
      run: () => (app.activePath?.endsWith(".md") ? (app.recovery = app.activePath) : (app.error = "Open a note first.")),
    },
    { id: "chat", name: "AI: Chat with your notes", keys: "Ctrl+J", run: () => (app.reveal("right"), (app.right = "chat")) },
    { id: "ai-improve", name: "AI: Improve writing (selection)", run: () => inlineAI("improve") },
    { id: "ai-fix", name: "AI: Fix spelling and grammar (selection)", run: () => inlineAI("fix") },
    { id: "ai-summarize", name: "AI: Summarize selection", run: () => inlineAI("summarize") },
    { id: "ai-continue", name: "AI: Continue writing at cursor", keys: "Ctrl+Shift+Enter", run: () => inlineAI("continue") },
    { id: "ai-stop", name: "AI: Stop generating", run: () => ai.stop() },
    { id: "files", name: "Show file explorer", run: () => (app.reveal("left"), (app.left = "files")) },
    { id: "tags", name: "Show tags", run: () => (app.reveal("left"), (app.left = "tags")) },
    { id: "bookmarks", name: "Show bookmarks", run: () => (app.reveal("left"), (app.left = "bookmarks")) },
    { id: "ai", name: "Connect AI apps (Claude, Codex, Cursor…)", run: () => (app.reveal("left"), (app.left = "ai")) },
    { id: "backlinks", name: "Show backlinks", run: () => (app.reveal("right"), (app.right = "backlinks")) },
    { id: "outline", name: "Show outline", run: () => (app.reveal("right"), (app.right = "outline")) },
    { id: "properties", name: "Show properties of this note", run: () => (app.reveal("right"), (app.right = "properties")) },
    { id: "table", name: "Insert table of notes (by properties)", run: insertTable },
    { id: "left", name: "Toggle left sidebar", run: () => app.toggleSide("left", lw > 0) },
    { id: "right", name: "Toggle right sidebar", run: () => app.toggleSide("right", rw > 0) },
    { id: "vim", name: "Toggle Vim key bindings", run: () => (app.settings.vim = !app.settings.vim) },
    { id: "theme", name: "Toggle dark mode", run: () => (app.settings.theme = dark ? "light" : "dark") },
    { id: "settings", name: "Settings", keys: "Ctrl+,", run: () => (app.showSettings = true) },
    { id: "vault", name: "Open another vault…", run: chooseVault },
    { id: "palette", name: "Command palette", keys: "Ctrl+P", run: () => (app.palette = { kind: "commands" }) },
  ];

  const shortcuts: Record<string, string> = {
    "ctrl+o": "switcher", "ctrl+p": "palette", "ctrl+n": "new", "ctrl+shift+f": "search", f2: "rename",
    "ctrl+w": "close", "ctrl+tab": "next", "ctrl+shift+tab": "prev", "ctrl+\\": "split", "ctrl+e": "live", "ctrl+,": "settings",
    "ctrl+shift+d": "daily", "ctrl+shift+t": "template", "alt+g": "graph", "ctrl+j": "chat", "ctrl+shift+enter": "ai-continue",
  };

  function keydown(e: KeyboardEvent) {
    // No workspace shortcuts behind an open dialog or palette.
    if (!app.root || app.palette || document.querySelector('[aria-modal="true"]')) return;
    const combo = [(e.ctrlKey || e.metaKey) && "ctrl", e.shiftKey && "shift", e.altKey && "alt", e.key.toLowerCase()].filter(Boolean).join("+");
    const id = shortcuts[combo];
    if (!id) return;
    e.preventDefault(); // also stops WebView defaults like Ctrl+P print
    commands.find((c) => c.id === id)!.run();
  }

  // Theme: explicit setting, or follow the OS.
  $effect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      dark = app.settings.theme === "dark" || (app.settings.theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });
  $effect(() => {
    document.documentElement.style.setProperty("--fv-font-size", `${app.settings.fontSize}px`);
  });
  // Tables in notes show live results: re-run them when files change.
  $effect(() => {
    app.version;
    refreshTables();
  });
  // Persist settings whenever any of them changes (palette toggles included).
  $effect(() => {
    $state.snapshot(app.settings);
    app.saveSettings();
  });
  $effect(() => {
    if (app.error) {
      const t = setTimeout(() => (app.error = null), 7000);
      return () => clearTimeout(t);
    }
  });

  function setWidth(side: "left" | "right", want: number) {
    const w = clampPanel(want, vw, app.panes.length, side === "left" ? rw : lw);
    side === "left" ? (leftW = w) : (rightW = w);
  }
  function gripKey(side: "left" | "right") {
    return (e: KeyboardEvent) => {
      const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
      if (!d) return;
      e.preventDefault();
      setWidth(side, (side === "left" ? lw : rw) + (side === "left" ? d : -d));
    };
  }

  function resize(side: "left" | "right") {
    return (e: PointerEvent) => {
      const start = e.clientX, w0 = side === "left" ? lw : rw; // the on-screen width, which may be clamped
      const move = (ev: PointerEvent) => {
        setWidth(side, w0 + (side === "left" ? 1 : -1) * (ev.clientX - start));
      };
      const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up));
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    };
  }

  onMount(() => {
    let refresh: ReturnType<typeof setTimeout>;
    const unlisten = [
      // Coalesce bursts (git checkout, agent batch edits) into one refresh.
      listen("vault-changed", () => {
        clearTimeout(refresh);
        refresh = setTimeout(() => app.refreshFiles(), 200);
      }),
      listen("index-ready", () => app.version++),
      // Write any edits still waiting on the save debounce before the window goes away.
      getCurrentWindow().onCloseRequested(async (e) => {
        if (await app.flush()) return;
        if (!(await ask("Some notes couldn't be saved. Close anyway and lose those edits?", { title: "Unsaved changes", kind: "warning" }))) {
          e.preventDefault();
        }
      }),
    ];
    api.lastVault().then(async (v) => {
      if (v) await app.openVault(v);
      ready = true;
    });
    return () => unlisten.forEach((u) => u.then((f) => f()));
  });

  const words = $derived(app.docText.match(/\S+/g)?.length ?? 0);
</script>

<svelte:window onkeydown={keydown} bind:innerWidth={vw} />

{#if !ready}
  <div class="splash"></div>
{:else if !app.root}
  <div class="welcome">
    <h1>FermiVault</h1>
    <p>Fast, local-first notes that your AI apps can read and edit too.</p>
    <button class="primary big" onclick={chooseVault}>Open folder as vault</button>
    <p class="hint">Pick any folder, empty or full of Markdown. Your notes stay plain <code>.md</code> files.</p>
  </div>
{:else}
  <div class="shell" style="--left:{lw}px; --right:{rw}px">
    {#if lw > 0}
      <aside class="left">
        <div class="switch">
          <div class="views" role="tablist" aria-label="Sidebar" use:tabKeys>
            {#each [["files", "Files"], ["search", "Search (Ctrl+Shift+F)"], ["tags", "Tags"], ["bookmarks", "Bookmarks"], ["ai", "AI apps"]] as const as [id, label]}
              <button
                role="tab"
                aria-selected={app.left === id}
                tabindex={app.left === id ? 0 : -1}
                class:on={app.left === id}
                onclick={() => (app.left = id)}
                title={label}
                aria-label={label}
              >
                <Icon name={id} />
              </button>
            {/each}
          </div>
          <span class="spacer"></span>
          <button title="Today's daily note (Ctrl+Shift+D)" aria-label="Daily note" onclick={() => app.dailyNote()}><Icon name="calendar" /></button>
          <button title="Graph view (Alt+G)" aria-label="Graph view" onclick={() => app.open(GRAPH, true)}><Icon name="graph" /></button>
        </div>
        {#if app.left === "files"}<FileTree />
        {:else if app.left === "search"}<SearchPane />
        {:else if app.left === "tags"}<TagsPane />
        {:else if app.left === "bookmarks"}<Bookmarks />
        {:else}<Connections />{/if}
        <button class="vaultname" title="Switch vault ({app.root})" onclick={chooseVault}>
          <span>{basename(app.root.replaceAll("\\", "/"))}</span><Icon name="swap" size={14} />
        </button>
        <!-- A focusable separator is ARIA's resize control: arrow keys move it. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div class="grip" role="separator" aria-orientation="vertical" aria-label="Resize left sidebar" aria-valuemin={MIN_PANEL} aria-valuemax={MAX_PANEL} aria-valuenow={lw} tabindex="0" onpointerdown={resize("left")} onkeydown={gripKey("left")}></div>
      </aside>
    {/if}

    <main class="panes">
      {#each app.panes as pane, pi (pane)}
        <section class="pane" class:focused={app.focus === pi && app.panes.length > 1}>
          <div class="tabs" role="tablist" aria-label="Open notes" use:tabKeys>
            <button class="icon" title="Toggle left sidebar" aria-label="Toggle left sidebar" aria-pressed={lw > 0} onclick={() => app.toggleSide("left", lw > 0)}><Icon name="sidebarLeft" /></button>
            {#each pane.tabs as t, ti}
              <div
                class="tab"
                class:on={ti === pane.active}
                role="tab"
                tabindex={ti === pane.active ? 0 : -1}
                aria-selected={ti === pane.active}
                title={t}
                onclick={() => ((pane.active = ti), (app.focus = pi))}
                onkeydown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), (pane.active = ti), (app.focus = pi))}
                onauxclick={(e) => e.button === 1 && app.closeTab(pi, ti)}
              >
                <span>{t === GRAPH ? "Graph" : basename(t)}</span>
                <button class="x" aria-label="Close {t === GRAPH ? 'Graph' : basename(t)}" tabindex={ti === pane.active ? 0 : -1} onclick={(e) => (e.stopPropagation(), app.closeTab(pi, ti))}>✕</button>
              </div>
            {/each}
            <div class="spacer"></div>
            <button class="icon" title="Toggle right sidebar" aria-label="Toggle right sidebar" aria-pressed={rw > 0} onclick={() => app.toggleSide("right", rw > 0)}><Icon name="sidebarRight" /></button>
          </div>
          <div class="body">
            {#if pane.tabs.length}
              {@const t = pane.tabs[pane.active]}
              {#if t === GRAPH}<Graph />
              {:else if kind(t) === "note"}<Editor pane={pi} path={t} />
              {:else if kind(t) === "canvas"}
                <!-- Canvas code loads the first time a canvas is opened. -->
                {#await import("$lib/Canvas.svelte") then m}{#key t}<m.default path={t} />{/key}{/await}
              {:else}<Viewer path={t} />{/if}
            {:else}
              <div class="empty">
                <button onclick={() => (app.palette = { kind: "switcher" })}>Open a note <kbd>Ctrl O</kbd></button>
                <button onclick={() => app.newNote()}>New note <kbd>Ctrl N</kbd></button>
                <button onclick={() => app.dailyNote()}>Today's daily note <kbd>Ctrl Shift D</kbd></button>
                <button onclick={() => app.open(GRAPH, true)}>Graph view <kbd>Alt G</kbd></button>
                <button onclick={() => (app.palette = { kind: "commands" })}>All commands <kbd>Ctrl P</kbd></button>
                <button onclick={() => (app.showSettings = true)}>Settings <kbd>Ctrl ,</kbd></button>
              </div>
            {/if}
          </div>
        </section>
      {/each}
    </main>

    {#if rw > 0}
      <aside class="right">
        <!-- A focusable separator is ARIA's resize control: arrow keys move it. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div class="grip" role="separator" aria-orientation="vertical" aria-label="Resize right sidebar" aria-valuemin={MIN_PANEL} aria-valuemax={MAX_PANEL} aria-valuenow={rw} tabindex="0" onpointerdown={resize("right")} onkeydown={gripKey("right")}></div>
        <RightPanel />
      </aside>
    {/if}

    <footer>
      <button class="mode gear" title="Settings (Ctrl+,)" aria-label="Settings" onclick={() => (app.showSettings = true)}><Icon name="settings" size={14} /></button>
      <span class="path">{app.activePath ?? ""}</span>
      <span class="spacer"></span>
      {#if ai.busy}
        <span class="busy">{ai.busy.label}…</span>
        <button class="mode" onclick={() => ai.stop()}>Stop</button>
      {/if}
      {#if app.activePath?.endsWith(".md")}
        <button class="mode" onclick={() => app.toggleBookmark(app.activePath)} title="Bookmark this note">
          {app.isBookmarked(app.activePath) ? "★ Bookmarked" : "☆ Bookmark"}
        </button>
        <span>{words.toLocaleString()} words · {app.docText.length.toLocaleString()} chars</span>
      {/if}
      <button class="mode" onclick={() => (app.settings.livePreview = !app.settings.livePreview)} title="Ctrl+E">
        {app.settings.livePreview ? "Live preview" : "Source"}
      </button>
    </footer>
  </div>
{/if}

{#if app.palette}
  {#key app.palette}<Palette {commands} />{/key}
{/if}
{#if app.showSettings}<Settings />{/if}
{#if app.recovery}<Recovery />{/if}
{#if app.error}
  <div class="toast" role="alert">
    {app.error}
    <button aria-label="Dismiss" onclick={() => (app.error = null)}>✕</button>
  </div>
{/if}

<style>
  .splash {
    height: 100%;
  }
  .welcome {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    text-align: center;
    padding: 16px;
  }
  .welcome h1 {
    font-size: 40px;
    margin: 0;
    letter-spacing: -0.02em;
  }
  .welcome p {
    color: var(--fv-muted);
    margin: 0 0 12px;
  }
  .welcome .hint {
    font-size: 13px;
    margin-top: 12px;
  }
  .big {
    font-size: 15px;
    padding: 10px 20px;
  }
  .shell {
    height: 100%;
    display: grid;
    grid-template-columns: var(--left) 1fr var(--right);
    grid-template-rows: minmax(0, 1fr) 26px;
    overflow: hidden;
  }
  aside {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--fv-bg-2);
  }
  .left {
    border-right: 1px solid var(--fv-border);
  }
  .right {
    border-left: 1px solid var(--fv-border);
  }
  .grip {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 5;
  }
  .left .grip {
    right: -3px;
  }
  .right .grip {
    left: -3px;
  }
  .grip:hover {
    background: var(--fv-accent);
    opacity: 0.4;
  }
  .switch {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px 8px 0;
  }
  .views {
    display: flex;
    gap: 4px;
  }
  .switch button {
    border: none;
    background: none;
    padding: 5px 7px;
    display: grid;
    place-items: center;
  }
  .switch .on {
    background: var(--fv-active);
    color: var(--fv-text);
  }
  .vaultname {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 8px 14px;
    border: none;
    border-top: 1px solid var(--fv-border);
    border-radius: 0;
    background: none;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--fv-muted);
    text-align: left;
  }
  .vaultname span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vaultname:hover {
    background: var(--fv-hover);
    color: var(--fv-text);
  }
  .panes {
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-right: 1px solid var(--fv-border);
  }
  .pane:last-child {
    border-right: none;
  }
  .pane.focused .tabs {
    box-shadow: inset 0 -2px 0 var(--fv-accent);
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 38px;
    padding: 0 6px;
    border-bottom: 1px solid var(--fv-border);
    overflow-x: auto;
    flex: none;
    scrollbar-width: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 12px;
    height: 28px;
    border-radius: 7px;
    font-size: 13px;
    color: var(--fv-muted);
    cursor: pointer;
    white-space: nowrap;
    max-width: 200px;
  }
  .tab span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab:hover {
    background: var(--fv-hover);
  }
  .tab.on {
    background: var(--fv-active);
    color: var(--fv-text);
  }
  .x {
    border: none;
    background: none;
    padding: 2px 4px;
    font-size: 10px;
    opacity: 0.75;
  }
  .x:hover {
    opacity: 1;
  }
  .icon {
    border: none;
    background: none;
    padding: 4px 8px;
    color: var(--fv-muted);
    display: grid;
    place-items: center;
  }
  .grip:focus-visible {
    background: var(--fv-accent);
    opacity: 0.6;
  }
  .spacer {
    flex: 1;
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  .empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .empty button {
    width: 240px;
    display: flex;
    justify-content: space-between;
  }
  kbd {
    font-family: var(--fv-mono);
    font-size: 11px;
    color: var(--fv-faint);
  }
  footer {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    font-size: 12px;
    color: var(--fv-faint);
    border-top: 1px solid var(--fv-border);
    background: var(--fv-bg-2);
  }
  .busy {
    color: var(--fv-accent);
  }
  .mode {
    border: none;
    background: none;
    font-size: 12px;
    padding: 0 4px;
    color: var(--fv-faint);
    white-space: nowrap;
  }
  .mode:hover {
    color: var(--fv-text);
  }
  .gear {
    display: grid;
    place-items: center;
    margin-left: -6px;
  }
  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  footer > span:not(.path) {
    white-space: nowrap;
  }
  .toast {
    position: fixed;
    right: 16px;
    bottom: 40px;
    max-width: 420px;
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-danger);
    color: var(--fv-text);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    box-shadow: var(--fv-shadow);
    z-index: 200;
  }
  .toast button {
    border: none;
    background: none;
    padding: 0 4px;
  }
</style>
