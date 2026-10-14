<script lang="ts">
  import { onDestroy } from "svelte";
  import { api, basename } from "./api";
  import { app } from "./store.svelte";

  /** `local`: only the active note and its direct neighbours (right sidebar). */
  let { local = false }: { local?: boolean } = $props();

  let container: HTMLDivElement;
  let renderer: { kill(): void; refresh(): void } | null = null;
  let worker: { kill(): void } | null = null;
  let hovered: string | null = null;
  let count = $state(0);
  /** Positions survive redraws so the graph doesn't jump every time a file changes. */
  const positions = new Map<string, { x: number; y: number }>();
  let timer: ReturnType<typeof setTimeout>;

  function kill() {
    worker?.kill();
    renderer?.kill();
    worker = renderer = null;
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
    const [accent, node, edge, text] = [color("--fv-accent"), color("--fv-faint"), color("--fv-border"), color("--fv-text")];
    g.forEachNode((n) =>
      g.mergeNodeAttributes(n, { size: 3 + Math.sqrt(g.degree(n)) * 2, color: n === app.activePath ? accent : node }),
    );
    g.forEachEdge((e) => g.mergeEdgeAttributes(e, { color: edge, size: 1 }));

    kill();
    count = g.order;
    if (!g.order) return;
    const settings = { ...fa2.inferSettings(g), barnesHutOptimize: g.order > 500 };
    if (fresh && g.order <= 400) fa2.assign(g, { iterations: 250, settings });
    renderer = new Sigma(g, container, {
      settings: { labelRenderedSizeThreshold: local ? 0 : 7, renderEdgeLabels: false, stagePadding: 24 },
      nodeReducer: (n, d) => {
        const near = !hovered || n === hovered || g.areNeighbors(n, hovered);
        return { ...d, labelColor: text, color: near ? d.color : edge, label: near ? d.label : "" };
      },
      edgeReducer: (e, d) =>
        !hovered || g.hasExtremity(e, hovered) ? { ...d, color: hovered ? accent : d.color } : { ...d, visibility: "hidden" },
    });
    const r = renderer as any;
    r.on("clickNode", ({ node: n, event }: any) => app.open(n, !!(event?.original?.ctrlKey || event?.original?.metaKey)));
    r.on("enterNode", ({ node: n }: any) => ((hovered = n), r.refresh()));
    r.on("leaveNode", () => ((hovered = null), r.refresh()));
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
    timer = setTimeout(() => draw(focus).catch((e) => (app.error = `Graph: ${e}`)), local ? 150 : 400);
  });

  onDestroy(() => {
    clearTimeout(timer);
    kill();
  });
</script>

<div class="graph" class:local bind:this={container}>
  {#if count === 0}<div class="empty">{local ? "No links to or from this note yet." : "No notes yet."}</div>{/if}
</div>

<style>
  .graph {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 200px;
  }
  .graph.local {
    flex: 1;
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
</style>
