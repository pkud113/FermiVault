<script lang="ts">
  import { t } from "./i18n.svelte";
  import { onDestroy } from "svelte";
  import { api, basename } from "./api";
  import { app } from "./store.svelte";
  import Icon from "./Icon.svelte";
  import { arrowIndex } from "./ui";

  /** `local`: only the active note and its direct neighbours (right sidebar). */
  let { local = false }: { local?: boolean } = $props();

  type Camera = { animatedZoom(o?: object): void; animatedUnzoom(o?: object): void; animatedReset(o?: object): void };
  let container: HTMLDivElement;
  let renderer: { kill(): void; refresh(): void; getCamera(): Camera } | null = null;
  let worker: { kill(): void } | null = null;
  let hovered: string | null = null;
  /** Loading until the first draw finishes, so a populated vault never flashes "No notes yet". */
  let status = $state<"loading" | "ready">("loading");
  /** What's drawn, for the screen-reader summary and the keyboard list: each note and its links. */
  let nodes = $state<{ path: string; links: string[] }[]>([]);
  let edges = $state(0);
  let listOpen = $state(false);
  /** Positions survive redraws so the graph doesn't jump every time a file changes. */
  const positions = new Map<string, { x: number; y: number }>();
  let timer: ReturnType<typeof setTimeout>;

  function kill() {
    worker?.kill();
    renderer?.kill();
    worker = renderer = null;
  }

  /** Highlights a note and its links (pointer hover, or keyboard focus in the list). */
  function highlight(n: string | null) {
    hovered = n;
    renderer?.refresh();
  }

  async function draw(focus: string | null) {
    // Loaded on first use only: none of this is in the startup bundle.
    const [{ default: Graph }, { default: Sigma }, { default: fa2 }, data] = await Promise.all([
      import("graphology"),
      import("sigma"),
      import("graphology-layout-forceatlas2"),
      api.graph(),
    ]);
    if (!container) return;
    let keep = new Set(data.nodes);
    if (local) {
      keep = new Set(focus ? [focus] : []);
      for (const [a, b] of data.edges) {
        if (a === focus) keep.add(b);
        if (b === focus) keep.add(a);
      }
    }
    const g = new Graph({ type: "undirected" });
    let fresh = 0;
    for (const n of keep) {
      const p = positions.get(n) ?? (fresh++, { x: Math.random() * 100, y: Math.random() * 100 });
      g.addNode(n, { label: basename(n), ...p });
    }
    for (const [a, b] of data.edges) if (keep.has(a) && keep.has(b)) g.mergeEdge(a, b);

    const css = getComputedStyle(document.documentElement);
    const color = (v: string) => css.getPropertyValue(v).trim();
    const [accent, node, edge, dim, text] = ["--fv-accent", "--fv-faint", "--fv-graph-edge", "--fv-border", "--fv-text"].map(color);
    g.forEachNode((n) =>
      g.mergeNodeAttributes(n, { size: 4 + Math.sqrt(g.degree(n)) * 2.5, color: n === app.activePath ? accent : node }),
    );
    g.forEachEdge((e) => g.mergeEdgeAttributes(e, { color: edge, size: 1 }));

    kill();
    nodes = g
      .nodes()
      .map((path) => ({ path, links: g.neighbors(path).sort((a, b) => basename(a).localeCompare(basename(b))) }))
      .sort((a, b) => b.links.length - a.links.length || basename(a.path).localeCompare(basename(b.path)));
    edges = g.size;
    status = "ready";
    if (!g.order) return;
    const settings = { ...fa2.inferSettings(g), barnesHutOptimize: g.order > 500 };
    if (fresh && g.order <= 400) fa2.assign(g, { iterations: 250, settings });
    renderer = new Sigma(g, container, {
      // Sizes in screen pixels (sigma 4 defaults to graph units: huge nodes in small vaults); every label in small graphs.
      settings: { labelRenderedSizeThreshold: local || g.order < 200 ? 0 : 7, renderEdgeLabels: false, stagePadding: 40, itemSizesReference: "screen", allowInvalidContainer: true },
      nodeReducer: (n, d) => {
        const near = !hovered || n === hovered || g.areNeighbors(n, hovered);
        return { ...d, labelColor: text, color: near ? d.color : dim, label: near ? d.label : "", highlighted: n === hovered };
      },
      edgeReducer: (e, d) =>
        !hovered || g.hasExtremity(e, hovered) ? { ...d, color: hovered ? accent : d.color } : { ...d, visibility: "hidden" },
    }) as unknown as typeof renderer;
    const r = renderer as any;
    r.on("clickNode", ({ node: n, event }: any) => app.open(n, !!(event?.original?.ctrlKey || event?.original?.metaKey)));
    r.on("enterNode", ({ node: n }: any) => highlight(n));
    r.on("leaveNode", () => highlight(null));
    if (fresh && g.order > 400) {
      // Big vaults: lay out in a Web Worker for a few seconds, never on the UI thread.
      const { default: FA2Layout } = await import("graphology-layout-forceatlas2/worker");
      const w = new FA2Layout(g, { settings });
      w.start();
      worker = w;
      setTimeout(() => w === worker && (w.stop(), g.forEachNode((n, a) => positions.set(n, { x: a.x, y: a.y }))), 4000);
    }
    g.forEachNode((n, a) => positions.set(n, { x: a.x, y: a.y }));
  }

  $effect(() => {
    const focus = local ? app.activePath : null;
    app.version;
    app.settings.theme;
    clearTimeout(timer);
    timer = setTimeout(() => draw(focus).catch((e) => ((status = "ready"), (app.error = `Graph: ${e}`))), local ? 150 : 400);
  });

  // The drawing follows its surface, not just the window: splitting a pane, resizing a sidebar or
  // closing a neighbour changes the size without any window resize.
  $effect(() => {
    const ro = new ResizeObserver(() => renderer?.refresh());
    ro.observe(container);
    return () => ro.disconnect();
  });

  onDestroy(() => {
    clearTimeout(timer);
    kill();
  });

  const zoom = (how: "in" | "out" | "fit") => {
    const c = renderer?.getCamera();
    if (!c) return;
    if (how === "in") c.animatedZoom({ duration: 200 });
    else if (how === "out") c.animatedUnzoom({ duration: 200 });
    else c.animatedReset({ duration: 200 });
  };

  /** Up/Down/Home/End between notes in the list. */
  function listKey(e: KeyboardEvent) {
    const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-note]")];
    const i = arrowIndex(e.key, items.indexOf(e.target as HTMLElement), items.length, false, "ArrowUp", "ArrowDown");
    if (i < 0) return;
    e.preventDefault();
    items[i].focus();
  }

  const summary = $derived(
    t(local ? "Local graph: {notes} notes, {links} links" : "Graph: {notes} notes, {links} links", { notes: nodes.length, links: edges }),
  );
</script>

<div class="graph" class:local>
  <div class="surface" bind:this={container} role="img" aria-label={summary}></div>
  {#if status === "loading"}
    <div class="empty" role="status">{t("Loading graph…")}</div>
  {:else if nodes.length === 0}
    <div class="empty">{local ? t("No links to or from this note yet.") : t("No notes yet.")}</div>
  {:else}
    <div class="tools" role="toolbar" aria-label={t("Graph controls")}>
      <button title={t("Zoom in")} aria-label={t("Zoom in")} onclick={() => zoom("in")}><Icon name="plus" size={14} /></button>
      <button title={t("Zoom out")} aria-label={t("Zoom out")} onclick={() => zoom("out")}><Icon name="minus" size={14} /></button>
      <button title={t("Fit to view")} aria-label={t("Fit to view")} onclick={() => zoom("fit")}><Icon name="fit" size={14} /></button>
      <button title={t("List notes and links")} aria-label={t("List notes and links")} aria-expanded={listOpen} class:on={listOpen} onclick={() => (listOpen = !listOpen)}>
        <Icon name="menu" size={14} />
      </button>
    </div>
    {#if !local && !listOpen}
      <div class="hint" aria-hidden="true">{t("Scroll to zoom · drag to move · click a note to open it")}</div>
    {/if}
    {#if listOpen}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <ul class="list" aria-label={t("Notes and links")} onkeydown={listKey} onfocusout={() => highlight(null)}>
        {#each nodes as n (n.path)}
          <li>
            <button data-note class="note" onfocus={() => highlight(n.path)} onclick={(e) => app.open(n.path, e.ctrlKey || e.metaKey)}>
              {basename(n.path)}
            </button>
            {#if n.links.length}
              <span class="links">
                {t("links:")}
                {#each n.links as l, i (l)}<button class="link" onfocus={() => highlight(l)} onclick={(e) => app.open(l, e.ctrlKey || e.metaKey)}>{basename(l)}</button>{i < n.links.length - 1 ? ", " : ""}{/each}
              </span>
            {:else}
              <span class="links">{t("no links")}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .graph {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 200px;
    overflow: hidden; /* never draw over a neighbouring pane */
  }
  .graph.local {
    flex: 1;
  }
  .surface {
    position: absolute;
    inset: 0;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--fv-faint);
    font-size: 12.5px;
    padding: 12px;
    text-align: center;
  }
  .tools {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 2px;
    padding: 2px;
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-border);
    border-radius: 8px;
    z-index: 2;
  }
  .tools button {
    border: none;
    background: none;
    padding: 5px;
    display: grid;
    place-items: center;
    color: var(--fv-muted);
  }
  .tools button:hover,
  .tools .on {
    background: var(--fv-hover);
    color: var(--fv-text);
  }
  .hint {
    position: absolute;
    left: 12px;
    bottom: 10px;
    font-size: 12px;
    color: var(--fv-faint);
    pointer-events: none;
  }
  .list {
    position: absolute;
    top: 44px;
    right: 8px;
    bottom: 8px;
    width: min(320px, calc(100% - 16px));
    margin: 0;
    padding: 6px;
    list-style: none;
    overflow: auto;
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-border);
    border-radius: 8px;
    box-shadow: var(--fv-shadow);
    z-index: 2;
    font-size: 13px;
  }
  .list li {
    padding: 4px 2px;
  }
  .list button {
    border: none;
    background: none;
    padding: 1px 3px;
    font-size: 13px;
  }
  .note {
    font-weight: 600;
  }
  .links {
    display: block;
    padding-left: 10px;
    color: var(--fv-faint);
    font-size: 12px;
  }
  .list .link {
    padding: 1px 0;
    color: var(--fv-accent);
  }
  .list button:hover {
    text-decoration: underline;
  }
</style>
