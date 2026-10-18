<script lang="ts">
  import { keys, setLanguage, t } from "$lib/i18n.svelte";
  import { tk } from "$lib/tk";
  import { onMount, tick } from "svelte";
  import { startup } from "$lib/startup";
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
  import FileTree from "$lib/FileTree.svelte";
  import SearchPane from "$lib/SearchPane.svelte";
  import RightPanel from "$lib/RightPanel.svelte";
  import Connections from "$lib/Connections.svelte";
  import Palette from "$lib/Palette.svelte";
  import Settings from "$lib/Settings.svelte";
  import { MAX_PANEL, MIN_PANEL, clampPanel, sidebars } from "$lib/ui";
  import { tabKeys } from "$lib/modal";
  import { loadEditor, refreshTables } from "$lib/host";
  import { emit, stopAll, syncPlugins } from "$lib/plugins";

  let ready = $state(false);
  /** Loaded after the first frame (see `loadEditor`); a note opened before that shows once it's in. */
  let Editor = $state<typeof import("$lib/Editor.svelte").default | null>(null);
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
    const dir = await pickFolder({ directory: true, title: t("Open a folder as a vault") });
    if (typeof dir === "string") await app.openVault(dir);
  }

  async function clipPage() {
    const url = (await app.ask(t("Web page to clip (https://…)")))?.trim();
    if (url) app.clip(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
  }

  /** Inserts a starter ```table``` block at the cursor. */
  function insertTable() {
    const ed = app.focusedEditor();
    const doc = ed?.doc();
    if (!ed || !doc) return void (app.error = t("Open a note first."));
    const block = "```table\nfrom: #project\nwhere: status != done\nsort: due\ncolumns: file, status, due\n```\n";
    ed.apply(doc, doc.state.replaceSelection(block));
  }

  function cycleTab(step: number) {
    const p = app.panes[app.focus];
    if (p?.tabs.length) p.active = (p.active + step + p.tabs.length) % p.tabs.length;
  }

  const commands: Command[] = [
    { id: "switcher", name: tk("Quick switcher: open or create a note"), keys: "Ctrl+O", run: () => (app.palette = { kind: "switcher" }) },
    { id: "new", name: tk("New note"), keys: "Ctrl+N", run: () => app.newNote(dirname(app.activePath ?? "")) },
    { id: "new-canvas", name: tk("New canvas"), run: () => app.newCanvas(dirname(app.activePath ?? "")) },
    { id: "clip", name: tk("Clip web page as a note…"), run: clipPage },
    { id: "sync", name: tk("Git: Sync vault now"), run: () => app.syncNow() },
    { id: "search", name: tk("Search vault"), keys: "Ctrl+Shift+F", run: () => (app.reveal("left"), (app.left = "search")) },
    { id: "rename", name: tk("Rename current note"), keys: "F2", run: () => app.activePath && app.rename(app.activePath) },
    { id: "delete", name: tk("Delete current note"), run: () => app.activePath && app.remove(app.activePath) },
    { id: "close", name: tk("Close tab"), keys: "Ctrl+W", run: () => app.closeTab() },
    { id: "next", name: tk("Next tab"), keys: "Ctrl+Tab", run: () => cycleTab(1) },
    { id: "prev", name: tk("Previous tab"), keys: "Ctrl+Shift+Tab", run: () => cycleTab(-1) },
    { id: "split", name: tk("Split right"), keys: "Ctrl+\\", run: () => app.splitRight() },
    { id: "live", name: tk("Toggle live preview / source mode"), keys: "Ctrl+E", run: () => (app.settings.livePreview = !app.settings.livePreview) },
    { id: "daily", name: tk("Open today's daily note"), keys: "Ctrl+Shift+D", run: () => app.dailyNote() },
    { id: "template", name: tk("Insert template"), keys: "Ctrl+Shift+T", run: () => app.insertTemplate() },
    { id: "graph", name: tk("Open graph view"), keys: "Alt+G", run: () => app.open(GRAPH, true) },
    { id: "local-graph", name: tk("Show local graph"), run: () => (app.reveal("right"), (app.right = "graph")) },
    { id: "bookmark", name: tk("Bookmark / unbookmark current note"), run: () => app.toggleBookmark(app.activePath) },
    {
      id: "recovery",
      name: tk("File recovery: restore an earlier version of this note"),
      run: () => (app.activePath?.endsWith(".md") ? (app.recovery = app.activePath) : (app.error = t("Open a note first."))),
    },
    { id: "chat", name: tk("AI: Chat with your notes"), keys: "Ctrl+J", run: () => (app.reveal("right"), (app.right = "chat")) },
    { id: "ai-improve", name: tk("AI: Improve writing (selection)"), run: () => inlineAI("improve") },
    { id: "ai-fix", name: tk("AI: Fix spelling and grammar (selection)"), run: () => inlineAI("fix") },
    { id: "ai-summarize", name: tk("AI: Summarize selection"), run: () => inlineAI("summarize") },
    { id: "ai-continue", name: tk("AI: Continue writing at cursor"), keys: "Ctrl+Shift+Enter", run: () => inlineAI("continue") },
    { id: "ai-stop", name: tk("AI: Stop generating"), run: () => ai.stop() },
    { id: "files", name: tk("Show file explorer"), run: () => (app.reveal("left"), (app.left = "files")) },
    { id: "tags", name: tk("Show tags"), run: () => (app.reveal("left"), (app.left = "tags")) },
    { id: "bookmarks", name: tk("Show bookmarks"), run: () => (app.reveal("left"), (app.left = "bookmarks")) },
    { id: "ai", name: tk("Connect AI apps (Claude, Codex, Cursor…)"), run: () => (app.reveal("left"), (app.left = "ai")) },
    { id: "backlinks", name: tk("Show backlinks"), run: () => (app.reveal("right"), (app.right = "backlinks")) },
    { id: "outline", name: tk("Show outline"), run: () => (app.reveal("right"), (app.right = "outline")) },
    { id: "properties", name: tk("Show properties of this note"), run: () => (app.reveal("right"), (app.right = "properties")) },
    { id: "table", name: tk("Insert table of notes (by properties)"), run: insertTable },
    { id: "left", name: tk("Toggle left sidebar"), run: () => app.toggleSide("left", lw > 0) },
    { id: "right", name: tk("Toggle right sidebar"), run: () => app.toggleSide("right", rw > 0) },
    { id: "vim", name: tk("Toggle Vim key bindings"), run: () => (app.settings.vim = !app.settings.vim) },
    { id: "theme", name: tk("Toggle dark mode"), run: () => (app.settings.theme = dark ? "light" : "dark") },
    { id: "settings", name: tk("Settings"), keys: "Ctrl+,", run: () => (app.showSettings = true) },
    { id: "vault", name: tk("Open another vault…"), run: chooseVault },
    { id: "palette", name: tk("Command palette"), keys: "Ctrl+P", run: () => (app.palette = { kind: "commands" }) },
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
  // Translations load on demand; English needs nothing.
  $effect(() => {
    setLanguage(app.settings.language);
  });
  // Git auto-sync, if turned on for this vault (Settings → Sync).
  $effect(() => {
    const minutes = app.root ? (app.config.gitAutoSync ?? 0) : 0;
    if (!minutes) return;
    const t = setInterval(() => app.syncNow(true), minutes * 60_000);
    return () => clearInterval(t);
  });
  /** "3 min ago" for the footer. */
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });
  const ago = (at: number) => {
    const m = Math.round((now - at) / 60_000);
    return m < 1 ? t("just now") : m < 60 ? t("{n} min ago", { n: m }) : t("{n} h ago", { n: Math.round(m / 60) });
  };

  // Plugins start once the app is idle, so they never slow startup. A new vault stops the old
  // vault's plugins; changing plugin settings starts or stops them.
  let pluginRoot: string | null = null;
  $effect(() => {
    const root = app.root;
    $state.snapshot(app.config.plugins);
    if (root !== pluginRoot) (stopAll(), (pluginRoot = root));
    if (!root) return;
    const idle = requestIdleCallback(() => syncPlugins(), { timeout: 3000 });
    return () => cancelIdleCallback(idle);
  });
  $effect(() => {
    const path = app.activePath;
    if (path) emit("file-open", { path });
  });
  $effect(() => {
    if (app.notice) {
      const t = setTimeout(() => (app.notice = null), 6000);
      return () => clearTimeout(t);
    }
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
      listen<string[]>("vault-changed", (e) => {
        emit("vault-change", { paths: e.payload });
        clearTimeout(refresh);
        refresh = setTimeout(() => app.refreshFiles(), 200);
      }),
      listen("index-ready", () => app.version++),
      // Write any edits still waiting on the save debounce before the window goes away.
      getCurrentWindow().onCloseRequested(async (e) => {
        if (await app.flush()) return;
        if (!(await ask(t("Some notes couldn't be saved. Close anyway and lose those edits?"), { title: t("Unsaved changes"), kind: "warning" }))) {
          e.preventDefault();
        }
      }),
    ];
    performance.mark("mounted");
    startup.then(async () => {
      ready = true;
      await tick();
      performance.mark("rendered");
      requestAnimationFrame(() => {
        api.benchReady(); // marks "ready" for the startup budget in CI
        loadEditor().then((m) => (Editor = m.default));
      });
    });
    return () => unlisten.forEach((u) => u.then((f) => f()));
  });

  /** Local save state of the active note or canvas (Git sync is separate, further right). */
  const savable = $derived(!!app.activePath && ["note", "canvas"].includes(kind(app.activePath)));
  const activeSave = $derived(app.activePath ? app.saves[app.activePath] : undefined);
  const failedElsewhere = $derived(Object.entries(app.saves).filter(([p, s]) => s.state === "failed" && p !== app.activePath).length);

  const words = $derived(app.activeDoc?.text.match(/\S+/g)?.length ?? 0);
</script>

<svelte:window onkeydown={keydown} bind:innerWidth={vw} />

{#if !ready}
  <div class="splash"></div>
{:else if !app.root}
  <div class="welcome">
    <img class="logo" src="/favicon.png" alt="" width="88" height="88" />
    <h1>FermiVault</h1>
    <p>{t("Fast, local-first notes that your AI apps can read and edit too.")}</p>
    <button class="primary big" onclick={chooseVault}>{t("Open folder as vault")}</button>
    <p class="hint">{t("Pick any folder, empty or full of Markdown. Your notes stay plain")} <code>.md</code> {t("files.")}</p>
  </div>
{:else}
  <div class="shell" style="--left:{lw}px; --right:{rw}px">
    {#if lw > 0}
      <aside class="left">
        <div class="switch">
          <div class="views" role="tablist" aria-label={t("Sidebar")} use:tabKeys>
            {#each [["files", tk("Files"), ""], ["search", tk("Search"), "Ctrl+Shift+F"], ["tags", tk("Tags"), ""], ["bookmarks", tk("Bookmarks"), ""], ["ai", tk("AI apps"), ""]] as const as [id, label, combo]}
              <button
                role="tab"
                aria-selected={app.left === id}
                tabindex={app.left === id ? 0 : -1}
                class:on={app.left === id}
                onclick={() => (app.left = id)}
                title={combo ? `${t(label)} (${keys(combo)})` : t(label)}
                aria-label={t(label)}
              >
                <Icon name={id} />
              </button>
            {/each}
          </div>
          <span class="spacer"></span>
          <button title={`${t("Today's daily note")} (${keys("Ctrl+Shift+D")})`} aria-label={t("Daily note")} onclick={() => app.dailyNote()}><Icon name="calendar" /></button>
          <button title={`${t("Graph view")} (${keys("Alt+G")})`} aria-label={t("Graph view")} onclick={() => app.open(GRAPH, true)}><Icon name="graph" /></button>
        </div>
        {#if app.left === "files"}<FileTree />
        {:else if app.left === "search"}<SearchPane />
        {:else if app.left === "tags"}<TagsPane />
        {:else if app.left === "bookmarks"}<Bookmarks />
        {:else}<Connections />{/if}
        <button class="vaultname" title={t("Switch vault ({path})", { path: app.root })} onclick={chooseVault}>
          <span>{basename(app.root.replaceAll("\\", "/"))}</span><Icon name="swap" size={14} />
        </button>
        <!-- A focusable separator is ARIA's resize control: arrow keys move it. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div class="grip" role="separator" aria-orientation="vertical" aria-label={t("Resize left sidebar")} aria-valuemin={MIN_PANEL} aria-valuemax={MAX_PANEL} aria-valuenow={lw} tabindex="0" onpointerdown={resize("left")} onkeydown={gripKey("left")}></div>
      </aside>
    {/if}

    <main class="panes">
      {#each app.panes as pane, pi (pane)}
        <section class="pane" class:focused={app.focus === pi && app.panes.length > 1}>
          <div class="tabs" role="tablist" aria-label={t("Open notes")} use:tabKeys>
            <button class="icon" title={t("Toggle left sidebar")} aria-label={t("Toggle left sidebar")} aria-pressed={lw > 0} onclick={() => app.toggleSide("left", lw > 0)}><Icon name="sidebarLeft" /></button>
            {#each pane.tabs as tab, ti}
              <div
                class="tab"
                class:on={ti === pane.active}
                role="tab"
                tabindex={ti === pane.active ? 0 : -1}
                aria-selected={ti === pane.active}
                title={tab}
                onclick={() => ((pane.active = ti), (app.focus = pi))}
                onkeydown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), (pane.active = ti), (app.focus = pi))}
                onauxclick={(e) => e.button === 1 && app.closeTab(pi, ti)}
              >
                <span>{tab === GRAPH ? t("Graph") : basename(tab)}</span>
                {#if app.saves[tab]}
                  {@const s = app.saves[tab]}
                  <span class="dirty" class:bad={s.state === "failed"} role="img" aria-label={s.state === "failed" ? t("Not saved") : t("Unsaved changes")} title={s.state === "failed" ? t("Not saved: {error}", { error: s.error ?? "" }) : t("Unsaved changes")}>●</span>
                {/if}
                <button class="x" aria-label={t("Close {tab}", { tab: tab === GRAPH ? t("Graph") : basename(tab) })} tabindex={ti === pane.active ? 0 : -1} onclick={(e) => (e.stopPropagation(), app.closeTab(pi, ti))}>✕</button>
              </div>
            {/each}
            <div class="spacer"></div>
            <button class="icon" title={t("Toggle right sidebar")} aria-label={t("Toggle right sidebar")} aria-pressed={rw > 0} onclick={() => app.toggleSide("right", rw > 0)}><Icon name="sidebarRight" /></button>
          </div>
          <div class="body">
            {#if pane.tabs.length}
              {@const tab = pane.tabs[pane.active]}
              {#if tab === GRAPH}<Graph />
              {:else if kind(tab) === "note"}{#if Editor}<Editor pane={pi} path={tab} />{/if}
              {:else if kind(tab) === "canvas"}
                <!-- Canvas code loads the first time a canvas is opened. -->
                {#await import("$lib/Canvas.svelte") then m}{#key tab}<m.default path={tab} />{/key}{/await}
              {:else}<Viewer path={tab} />{/if}
            {:else}
              <div class="empty">
                <button onclick={() => (app.palette = { kind: "switcher" })}>{t("Open a note")} <kbd>{keys("Ctrl+O")}</kbd></button>
                <button onclick={() => app.newNote()}>{t("New note")} <kbd>{keys("Ctrl+N")}</kbd></button>
                <button onclick={() => app.dailyNote()}>{t("Today's daily note")} <kbd>{keys("Ctrl+Shift+D")}</kbd></button>
                <button onclick={() => app.open(GRAPH, true)}>{t("Graph view")} <kbd>{keys("Alt+G")}</kbd></button>
                <button onclick={() => (app.palette = { kind: "commands" })}>{t("All commands")} <kbd>{keys("Ctrl+P")}</kbd></button>
                <button onclick={() => (app.showSettings = true)}>{t("Settings")} <kbd>{keys("Ctrl+,")}</kbd></button>
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
        <div class="grip" role="separator" aria-orientation="vertical" aria-label={t("Resize right sidebar")} aria-valuemin={MIN_PANEL} aria-valuemax={MAX_PANEL} aria-valuenow={rw} tabindex="0" onpointerdown={resize("right")} onkeydown={gripKey("right")}></div>
        <RightPanel />
      </aside>
    {/if}

    <footer>
      <button class="mode gear" title={`${t("Settings")} (${keys("Ctrl+,")})`} aria-label={t("Settings")} onclick={() => (app.showSettings = true)}><Icon name="settings" size={14} /></button>
      <span class="path">{app.activePath === GRAPH ? t("Graph") : (app.activePath ?? "")}</span>
      <span class="spacer"></span>
      {#if failedElsewhere}
        <button class="mode bad" onclick={() => app.flush()} title={t("Retry saving")}>
          {t(failedElsewhere === 1 ? "1 other file not saved · Retry" : "{n} other files not saved · Retry", { n: failedElsewhere })}
        </button>
      {/if}
      {#if savable}
        {#if activeSave?.state === "failed"}
          <button class="mode bad" onclick={() => app.flush()} title={t("Not saved: {error}", { error: activeSave.error ?? "" })}>{t("Not saved · Retry")}</button>
        {:else if activeSave?.state === "saving"}
          <span class="save">{t("Saving…")}</span>
        {:else if activeSave}
          <span class="save">{t("Unsaved changes")}</span>
        {:else}
          <span class="save">{t("Saved")}</span>
        {/if}
      {/if}
      {#if app.sync.busy || app.sync.last || app.sync.error || app.config.gitAutoSync}
        <button class="mode" class:bad={!!app.sync.error} title={app.sync.error ?? t("Sync with Git now")} onclick={() => app.syncNow()}>
          {app.sync.busy ? t("Git: syncing…") : app.sync.error ? t("Git: sync failed") : app.sync.last ? t("Git: synced {when}", { when: ago(app.sync.last) }) : t("Git: sync")}
        </button>
      {/if}
      {#if ai.busy}
        <span class="busy">{t(ai.busy.label)}…</span>
        <button class="mode" onclick={() => ai.stop()}>{t("Stop")}</button>
      {/if}
      {#if app.activePath?.endsWith(".md")}
        <button class="mode" onclick={() => app.toggleBookmark(app.activePath)} title={t("Bookmark this note")} aria-pressed={app.isBookmarked(app.activePath)}>
          <span aria-hidden="true">{app.isBookmarked(app.activePath) ? "★" : "☆"}</span>
          {app.isBookmarked(app.activePath) ? t("Bookmarked") : t("Bookmark")}
        </button>
        <span>{t("{words} words · {chars} chars", { words: words.toLocaleString(), chars: (app.activeDoc?.text.length ?? 0).toLocaleString() })}</span>
      {/if}
      {#if app.activePath && kind(app.activePath) === "note"}
        <!-- Only notes have a live preview / source mode. -->
        <button class="mode" onclick={() => (app.settings.livePreview = !app.settings.livePreview)} title={`${t("Switch between live preview and source")} (${keys("Ctrl+E")})`}>
          {app.settings.livePreview ? t("Live preview") : t("Source")}
        </button>
      {/if}
    </footer>
  </div>
{/if}

{#if app.palette}
  {#key app.palette}<Palette commands={[...commands, ...app.pluginCommands]} />{/key}
{/if}
{#if app.showSettings}<Settings />{/if}
{#if app.recovery}<Recovery />{/if}
{#if app.notice && !app.error}
  <div class="toast info" role="status">
    {app.notice}
    <button aria-label={t("Dismiss")} onclick={() => (app.notice = null)}>✕</button>
  </div>
{/if}
{#if app.error}
  <div class="toast" role="alert">
    {app.error}
    <button aria-label={t("Dismiss")} onclick={() => (app.error = null)}>✕</button>
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
  .welcome .logo {
    margin-bottom: 4px;
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
    grid-row: 1;
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--fv-bg-2);
  }
  /* Explicit columns: a hidden sidebar isn't rendered, and auto-placement would then move
     the panes into its zero-width column. */
  .left {
    grid-column: 1;
    border-right: 1px solid var(--fv-border);
  }
  .right {
    grid-column: 3;
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
    gap: 2px;
    padding: 8px 8px 0;
  }
  .views {
    display: flex;
    gap: 2px;
  }
  .switch button {
    border: none;
    background: none;
    padding: 5px 4px;
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
    grid-column: 2;
    grid-row: 1;
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
  .dirty {
    font-size: 9px;
    color: var(--fv-faint);
    margin-right: -2px;
  }
  .dirty.bad {
    color: var(--fv-danger);
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
  .mode.bad {
    color: var(--fv-danger);
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
  .toast.info {
    border-color: var(--fv-border);
  }
  .toast button {
    border: none;
    background: none;
    padding: 0 4px;
  }
</style>
