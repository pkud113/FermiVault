<script lang="ts">
  import { t } from "./i18n.svelte";
  // An infinite canvas over a JSON Canvas (.canvas) file. Loaded only when a canvas is opened.
  import { onDestroy, onMount } from "svelte";
  import type { EditorView } from "@codemirror/view";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { api, assetUrl, basename, kind } from "./api";
  import { closeDocs, renameDocs, saveDoc, type Doc } from "./docs";
  import { app, type Saver } from "./store.svelte";
  import { host } from "./host";
  import { body } from "./frontmatter";
  import "./editor"; // sets host.nested, the Markdown preview cards use
  import {
    PRESETS,
    anchor,
    bounds,
    colorOf,
    drawable,
    facingSides,
    insideGroup,
    newId,
    parseCanvas,
    removeNodes,
    serializeCanvas,
    type Canvas,
    type CanvasEdge,
    type CanvasNode,
    type Side,
  } from "./canvas";

  let { path }: { path: string } = $props();

  let canvas = $state<Canvas>({ nodes: [], edges: [] });
  let error = $state<string | null>(null);
  let cam = $state({ x: 0, y: 0, zoom: 1 });
  let selected = $state(new Set<string>());
  let selectedEdge = $state<string | null>(null);
  let editing = $state<string | null>(null);
  let viewport: HTMLDivElement;

  /** The file and its pending save; `state` is the serialized canvas. */
  let doc: Doc<string> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const history: string[] = [];

  const shown = $derived(canvas.nodes.filter(drawable));
  // Groups draw underneath everything else.
  const ordered = $derived([...shown.filter((n) => n.type === "group"), ...shown.filter((n) => n.type !== "group")]);

  // ---------- loading and saving ----------

  async function load() {
    try {
      const text = await api.read(path);
      canvas = parseCanvas(text);
      doc = { vault: app.root ?? "", path, state: text, saved: text };
      error = null;
      requestAnimationFrame(fit);
    } catch (e) {
      error = t("Can't open this canvas: {error}. The file is left unchanged.", { error: String(e) });
    }
  }

  function persist(): Promise<boolean> {
    clearTimeout(timer);
    timer = undefined;
    const d = doc;
    if (!d) return Promise.resolve(true);
    if (!d.closed && d.state !== d.saved) app.setSave(d.path, "saving");
    return saveDoc(d, (s) => s, api.write).then(
      (conflict) => {
        app.setSave(d.path, !d.closed && d.state !== d.saved ? "edit" : "saved");
        if (conflict) app.error = t("{path} was also changed outside FermiVault. Your version is saved; the other one is in File recovery.", { path: d.path });
        return true;
      },
      (e) => {
        if (d.closed) return (app.setSave(d.path, "saved"), false);
        app.setSave(d.path, "failed", String(e));
        app.error = t("Couldn't save {path}: {error}. Your changes are kept and FermiVault keeps retrying.", { path: d.path, error: String(e) });
        timer = setTimeout(persist, 5000);
        return false;
      },
    );
  }

  /** Records the canvas after a change and saves shortly. */
  function changed() {
    if (!doc) return;
    doc.state = serializeCanvas($state.snapshot(canvas) as Canvas);
    app.setSave(doc.path, "edit");
    clearTimeout(timer);
    timer = setTimeout(persist, 500);
  }

  /** Remembers the current canvas for undo; call before a change. */
  function checkpoint() {
    if (!doc) return;
    history.push(doc.state);
    if (history.length > 100) history.shift();
  }

  function mutate(fn: () => void) {
    checkpoint();
    fn();
    changed();
  }

  function undo() {
    const prev = history.pop();
    if (prev === undefined || !doc) return;
    canvas = parseCanvas(prev);
    selected = new Set();
    doc.state = prev;
    app.setSave(doc.path, "edit");
    clearTimeout(timer);
    timer = setTimeout(persist, 500);
  }

  const saver: Saver = {
    flush: () => persist(),
    renamed: (from, to) => doc && renameDocs([doc], from, to),
    closed: (p) => doc && closeDocs([doc], p),
  };

  onMount(() => {
    app.savers.add(saver);
    load();
    // Wheel needs a non-passive listener to stop the page from scrolling.
    viewport.addEventListener("wheel", wheel, { passive: false });
  });
  onDestroy(() => {
    viewport?.removeEventListener("wheel", wheel);
    persist();
    app.savers.delete(saver);
  });

  // Picks up edits from elsewhere (an agent, sync, another app) unless we have unsaved changes.
  $effect(() => {
    app.version;
    const d = doc;
    if (!d || timer || d.state !== d.saved) return;
    api.read(d.path).then((text) => {
      if (d !== doc || timer || d.state !== d.saved || text === d.saved) return;
      try {
        canvas = parseCanvas(text);
        d.state = d.saved = text;
      } catch {}
    }, () => {});
  });

  // ---------- coordinates and camera ----------

  function toWorld(clientX: number, clientY: number) {
    const r = viewport.getBoundingClientRect();
    return { x: (clientX - r.left - cam.x) / cam.zoom, y: (clientY - r.top - cam.y) / cam.zoom };
  }

  function zoomAt(factor: number, clientX?: number, clientY?: number) {
    const r = viewport.getBoundingClientRect();
    const sx = (clientX ?? r.left + r.width / 2) - r.left, sy = (clientY ?? r.top + r.height / 2) - r.top;
    const zoom = Math.min(4, Math.max(0.1, cam.zoom * factor));
    cam = { zoom, x: sx - ((sx - cam.x) / cam.zoom) * zoom, y: sy - ((sy - cam.y) / cam.zoom) * zoom };
  }

  function fit() {
    if (!viewport) return;
    const b = bounds(shown);
    const r = viewport.getBoundingClientRect();
    const zoom = Math.min(1, Math.max(0.1, Math.min((r.width - 80) / b.width, (r.height - 80) / b.height)));
    cam = { zoom, x: r.width / 2 - (b.x + b.width / 2) * zoom, y: r.height / 2 - (b.y + b.height / 2) * zoom };
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    else cam = { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY };
  }

  // ---------- pointer interactions ----------

  type Drag =
    | { kind: "pan"; sx: number; sy: number; x0: number; y0: number }
    | { kind: "move"; sx: number; sy: number; start: Map<string, { x: number; y: number }>; moved: boolean }
    | { kind: "resize"; id: string; sx: number; sy: number; w0: number; h0: number }
    | { kind: "connect"; from: string; side: Side; x: number; y: number };
  let drag = $state<Drag | null>(null);

  const byId = (id: string) => canvas.nodes.find((n) => n.id === id);

  function backgroundDown(e: PointerEvent) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    editing = null;
    selected = new Set();
    selectedEdge = null;
    viewport.setPointerCapture(e.pointerId);
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, x0: cam.x, y0: cam.y };
  }

  function nodeDown(e: PointerEvent, n: CanvasNode) {
    if (e.button !== 0 || editing === n.id) return;
    e.stopPropagation();
    selectedEdge = null;
    if (e.shiftKey) {
      const s = new Set(selected);
      s.has(n.id) ? s.delete(n.id) : s.add(n.id);
      selected = s;
    } else if (!selected.has(n.id)) selected = new Set([n.id]);
    // Moving a group moves what's inside it.
    const moving = new Map<string, { x: number; y: number }>();
    for (const id of selected) {
      const m = byId(id);
      if (!m) continue;
      moving.set(m.id, { x: m.x, y: m.y });
      if (m.type === "group") for (const c of insideGroup(canvas, m)) moving.set(c.id, { x: c.x, y: c.y });
    }
    viewport.setPointerCapture(e.pointerId);
    drag = { kind: "move", sx: e.clientX, sy: e.clientY, start: moving, moved: false };
  }

  function resizeDown(e: PointerEvent, n: CanvasNode) {
    e.stopPropagation();
    checkpoint();
    viewport.setPointerCapture(e.pointerId);
    drag = { kind: "resize", id: n.id, sx: e.clientX, sy: e.clientY, w0: n.width, h0: n.height };
  }

  function connectDown(e: PointerEvent, n: CanvasNode, side: Side) {
    e.stopPropagation();
    viewport.setPointerCapture(e.pointerId);
    const p = anchor(n, side);
    drag = { kind: "connect", from: n.id, side, x: p.x, y: p.y };
  }

  function pointerMove(e: PointerEvent) {
    const d = drag;
    if (!d) return;
    const dx = (e.clientX - ("sx" in d ? d.sx : 0)) / cam.zoom, dy = (e.clientY - ("sy" in d ? d.sy : 0)) / cam.zoom;
    if (d.kind === "pan") cam = { ...cam, x: d.x0 + (e.clientX - d.sx), y: d.y0 + (e.clientY - d.sy) };
    else if (d.kind === "move") {
      if (!d.moved && Math.hypot(dx, dy) * cam.zoom < 3) return; // a click, not a drag
      if (!d.moved) checkpoint();
      d.moved = true;
      for (const n of canvas.nodes) {
        const s = d.start.get(n.id);
        if (s) (n.x = Math.round(s.x + dx)), (n.y = Math.round(s.y + dy));
      }
    } else if (d.kind === "resize") {
      const n = byId(d.id);
      if (n) (n.width = Math.max(60, Math.round(d.w0 + dx))), (n.height = Math.max(40, Math.round(d.h0 + dy)));
    } else {
      const w = toWorld(e.clientX, e.clientY);
      drag = { ...d, x: w.x, y: w.y };
    }
  }

  function pointerUp(e: PointerEvent) {
    const d = drag;
    drag = null;
    if (!d) return;
    if ((d.kind === "move" && d.moved) || d.kind === "resize") changed();
    if (d.kind === "connect") {
      const w = toWorld(e.clientX, e.clientY);
      // Topmost card under the pointer; groups only if nothing else is there.
      const hit = [...ordered].reverse().find((n) => n.id !== d.from && w.x >= n.x && w.x <= n.x + n.width && w.y >= n.y && w.y <= n.y + n.height);
      const from = byId(d.from);
      if (hit && from) mutate(() => canvas.edges.push({ id: newId(canvas), fromNode: d.from, fromSide: d.side, toNode: hit.id, toSide: facingSides(from, hit)[1] }));
    }
  }

  // ---------- creating and editing ----------

  function addNode(n: Omit<CanvasNode, "id">, edit = false) {
    let id = "";
    mutate(() => {
      id = newId(canvas);
      canvas.nodes.push({ ...n, id } as CanvasNode);
    });
    selected = new Set([id]);
    if (edit) editing = id;
    return id;
  }

  const center = () => {
    const r = viewport.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  };

  function dblclick(e: MouseEvent) {
    if (e.target !== e.currentTarget) return;
    const w = toWorld(e.clientX, e.clientY);
    addNode({ type: "text", text: "", x: Math.round(w.x - 125), y: Math.round(w.y - 30), width: 250, height: 60 }, true);
  }

  function addText() {
    const c = center();
    addNode({ type: "text", text: "", x: Math.round(c.x - 125), y: Math.round(c.y - 30), width: 250, height: 60 }, true);
  }

  function addFile() {
    const c = center();
    app.palette = {
      kind: "pick",
      placeholder: t("Add a note or file to the canvas…"),
      items: app.files
        .filter((f) => !f.dir && f.path !== path)
        .map((f) => ({
          label: basename(f.path),
          detail: f.path,
          run: () => {
            const image = kind(f.path) === "image";
            addNode({ type: "file", file: f.path, x: Math.round(c.x - 160), y: Math.round(c.y - 120), width: 320, height: image ? 240 : 260 });
          },
        })),
    };
  }

  async function addLink() {
    const url = (await app.ask(t("Web address")))?.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return void (app.error = t("Links must start with http:// or https://"));
    const c = center();
    addNode({ type: "link", url, x: Math.round(c.x - 150), y: Math.round(c.y - 40), width: 300, height: 80 });
  }

  function addGroup() {
    const inside = shown.filter((n) => selected.has(n.id));
    const b = inside.length ? bounds(inside) : { ...center(), width: 400, height: 300 };
    const pad = inside.length ? 30 : 0;
    const x = inside.length ? b.x - pad : b.x - 200, y = inside.length ? b.y - pad - 20 : b.y - 150;
    addNode({ type: "group", label: t("Group"), x: Math.round(x), y: Math.round(y), width: Math.round(b.width + pad * 2), height: Math.round(b.height + pad * 2 + 20) });
  }

  function remove() {
    if (selectedEdge) {
      const id = selectedEdge;
      mutate(() => (canvas.edges = canvas.edges.filter((e) => e.id !== id)));
      selectedEdge = null;
    } else if (selected.size) {
      const ids = new Set(selected);
      mutate(() => (canvas = removeNodes(canvas, ids)));
      selected = new Set();
    }
  }

  function setColor(color: string | undefined) {
    mutate(() => {
      for (const n of canvas.nodes) if (selected.has(n.id)) color ? (n.color = color) : delete n.color;
      for (const e of canvas.edges) if (e.id === selectedEdge) color ? (e.color = color) : delete e.color;
    });
  }

  function startEdit(n: CanvasNode) {
    if (n.type !== "text" && n.type !== "group") return;
    checkpoint();
    editing = n.id;
  }

  function open(n: CanvasNode, newTab = true) {
    if (n.type === "file" && n.file) app.open(n.file, newTab);
    else if (n.type === "link" && n.url && /^https?:\/\//i.test(n.url)) openUrl(n.url);
    else startEdit(n);
  }

  function keydown(e: KeyboardEvent) {
    if (editing) {
      if (e.key === "Escape") (e.preventDefault(), (editing = null), viewport.focus());
      return; // typing goes to the text box
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const step = e.shiftKey ? 50 : 10;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (ctrl && e.key.toLowerCase() === "z") undo();
    else if (ctrl && e.key.toLowerCase() === "a") selected = new Set(shown.map((n) => n.id));
    else if (e.key === "Delete" || e.key === "Backspace") remove();
    else if (e.key === "Escape") (selected = new Set()), (selectedEdge = null);
    else if (e.key === "Enter" && selected.size === 1) open(byId([...selected][0])!, false);
    else if (e.key === "+" || e.key === "=") zoomAt(1.2);
    else if (e.key === "-") zoomAt(1 / 1.2);
    else if (arrows[e.key] && selected.size) {
      const [dx, dy] = arrows[e.key];
      mutate(() => {
        for (const n of canvas.nodes) if (selected.has(n.id)) (n.x += dx), (n.y += dy);
      });
    } else if (arrows[e.key]) cam = { ...cam, x: cam.x - arrows[e.key][0] * 3, y: cam.y - arrows[e.key][1] * 3 };
    else return;
    e.preventDefault();
  }

  // ---------- rendering helpers ----------

  /** Read-only Markdown preview for text cards and note files (same renderer as notes). */
  function markdown(el: HTMLElement, text: string) {
    let v: EditorView | null = host.nested(text, 1);
    el.append(v.dom);
    return {
      update(t: string) {
        v?.destroy();
        v = host.nested(t, 1);
        el.append(v.dom);
      },
      destroy: () => v?.destroy(),
    };
  }

  function notePreview(el: HTMLElement, file: string) {
    let v: EditorView | null = null;
    let alive = true;
    host.read(file).then((t) => {
      if (!alive) return;
      v = host.nested(body(t).slice(0, 4000), 1);
      el.append(v.dom);
    }, () => (el.textContent = t("Couldn't read this note.")));
    return { destroy: () => ((alive = false), v?.destroy()) };
  }

  const exists = (file?: string) => !!file && app.files.some((f) => f.path === file);
  const host_ = (url?: string) => {
    try {
      return new URL(url ?? "").host;
    } catch {
      return url ?? "";
    }
  };
  const label = (n: CanvasNode) =>
    n.type === "text"
      ? t("Text card: {text}", { text: (n.text ?? "").slice(0, 60) || t("empty") })
      : n.type === "file"
        ? t("File: {file}", { file: n.file ?? "" })
        : n.type === "link"
          ? t("Link: {url}", { url: n.url ?? "" })
          : t("Group: {label}", { label: n.label ?? "" });

  function edgeView(e: CanvasEdge) {
    const a = byId(e.fromNode), b = byId(e.toNode);
    if (!a || !b || !drawable(a) || !drawable(b)) return null;
    const [fs, ts] = facingSides(a, b);
    const from = e.fromSide ?? fs, to = e.toSide ?? ts;
    const p = anchor(a, from), q = anchor(b, to);
    const n: Record<Side, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
    const k = Math.max(40, Math.hypot(q.x - p.x, q.y - p.y) / 3);
    const d = `M ${p.x} ${p.y} C ${p.x + n[from][0] * k} ${p.y + n[from][1] * k}, ${q.x + n[to][0] * k} ${q.y + n[to][1] * k}, ${q.x} ${q.y}`;
    // Arrowhead pointing into the target side.
    const arrow = (pt: { x: number; y: number }, s: Side) => {
      const [nx, ny] = n[s];
      const [bx, by] = [pt.x + nx * 12, pt.y + ny * 12];
      return `${pt.x},${pt.y} ${bx - ny * 6},${by + nx * 6} ${bx + ny * 6},${by - nx * 6}`;
    };
    return {
      d,
      head: (e.toEnd ?? "arrow") === "arrow" ? arrow(q, to) : null,
      tail: e.fromEnd === "arrow" ? arrow(p, from) : null,
      mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
      color: colorOf(e.color) ?? "var(--fv-muted)",
    };
  }

  const SIDES: Side[] = ["top", "right", "bottom", "left"];
</script>

<div class="canvas">
  <div class="toolbar" role="toolbar" aria-label={t("Canvas tools")}>
    <button onclick={addText} title={t("Text card (or double-click the canvas)")}>{t("＋ Text")}</button>
    <button onclick={addFile} title={t("Add a note, image or file")}>{t("＋ Note")}</button>
    <button onclick={addLink}>{t("＋ Link")}</button>
    <button onclick={addGroup} title={t("Group the selection")}>{t("Group")}</button>
    {#if selected.size || selectedEdge}
      <span class="sep"></span>
      {#each PRESETS as c, i}
        <button class="swatch" style="--c:{c}" aria-label={t("Colour {n}", { n: i + 1 })} onclick={() => setColor(String(i + 1))}></button>
      {/each}
      <button class="swatch none" aria-label={t("No colour")} onclick={() => setColor(undefined)}></button>
      <button onclick={remove} title={t("Delete (Del)")}>{t("Delete")}</button>
    {/if}
    <span class="spacer"></span>
    <button onclick={() => zoomAt(1 / 1.2)} aria-label={t("Zoom out")}>−</button>
    <span class="zoom">{Math.round(cam.zoom * 100)}%</span>
    <button onclick={() => zoomAt(1.2)} aria-label={t("Zoom in")}>＋</button>
    <button onclick={fit} title={t("Show everything")}>{t("Fit")}</button>
  </div>

  {#if error}
    <div class="error" role="alert">{error}</div>
  {/if}

  <!-- The board is one keyboard-operable widget (role=application): it handles its own keys. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="viewport"
    class:panning={drag?.kind === "pan"}
    bind:this={viewport}
    role="application"
    aria-label={t("Canvas {name}. Arrow keys move the selection, Enter opens or edits it, Delete removes it.", { name: basename(path) })}
    tabindex="0"
    onpointerdown={backgroundDown}
    onpointermove={pointerMove}
    onpointerup={pointerUp}
    ondblclick={dblclick}
    onkeydown={keydown}
    style="background-position:{cam.x}px {cam.y}px; background-size:{24 * cam.zoom}px {24 * cam.zoom}px"
  >
    <div class="world" style="transform: translate({cam.x}px, {cam.y}px) scale({cam.zoom})">
      <svg class="edges" aria-hidden="true">
        {#each canvas.edges as e (e.id)}
          {@const g = edgeView(e)}
          {#if g}
            <g class:sel={selectedEdge === e.id} style="--c:{g.color}">
              <!-- Edge picking is pointer-only; with the keyboard, deleting a card removes its edges. -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <path class="hit" d={g.d} onpointerdown={(ev) => (ev.stopPropagation(), (selectedEdge = e.id), (selected = new Set()))} />
              <path class="line" d={g.d} />
              {#if g.head}<polygon points={g.head} />{/if}
              {#if g.tail}<polygon points={g.tail} />{/if}
              {#if e.label}<text x={g.mid.x} y={g.mid.y}>{e.label}</text>{/if}
            </g>
          {/if}
        {/each}
        {#if drag?.kind === "connect"}
          {@const from = byId(drag.from)}
          {#if from}
            {@const p = anchor(from, drag.side)}
            <line class="pending" x1={p.x} y1={p.y} x2={drag.x} y2={drag.y} />
          {/if}
        {/if}
      </svg>

      {#each ordered as n (n.id)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="node {n.type}"
          class:sel={selected.has(n.id)}
          class:colored={!!colorOf(n.color)}
          style="left:{n.x}px; top:{n.y}px; width:{n.width}px; height:{n.height}px; --c:{colorOf(n.color) ?? 'var(--fv-border)'}"
          role="group"
          aria-label={label(n)}
          tabindex="0"
          onpointerdown={(e) => nodeDown(e, n)}
          ondblclick={(e) => (e.stopPropagation(), open(n))}
          onfocus={() => !selected.has(n.id) && !drag && (selected = new Set([n.id]))}
        >
          {#if n.type === "group"}
            {#if editing === n.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input class="label-edit" bind:value={n.label} autofocus onblur={() => ((editing = null), changed())} onkeydown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).blur()} />
            {:else}
              <div class="label">{n.label || "Group"}</div>
            {/if}
          {:else if n.type === "text"}
            {#if editing === n.id}
              <!-- svelte-ignore a11y_autofocus -->
              <textarea bind:value={n.text} autofocus onblur={() => ((editing = null), changed())} placeholder={t("Write Markdown…")}></textarea>
            {:else}
              <div class="md" use:markdown={n.text ?? ""}></div>
            {/if}
          {:else if n.type === "file"}
            <div class="title">{basename(n.file ?? "")}</div>
            {#if !exists(n.file)}
              <div class="missing">{t("“{file}” not found", { file: n.file ?? "" })}</div>
            {:else if kind(n.file!) === "image"}
              <img src={assetUrl(app.root ?? "", n.file!)} alt={n.file} draggable="false" />
            {:else if kind(n.file!) === "note"}
              {#key n.file}<div class="md" use:notePreview={n.file!}></div>{/key}
            {:else}
              <div class="missing">{t("Double-click to open")}</div>
            {/if}
          {:else}
            <div class="title">{host_(n.url)}</div>
            <div class="url">{n.url}</div>
          {/if}

          {#if selected.has(n.id) && selected.size === 1 && n.type !== "group"}
            {#each SIDES as s}
              <div class="handle {s}" role="presentation" title={t("Drag to connect")} onpointerdown={(e) => connectDown(e, n, s)}></div>
            {/each}
          {/if}
          {#if selected.has(n.id)}
            <div class="resize" role="presentation" onpointerdown={(e) => resizeDown(e, n)}></div>
          {/if}
        </div>
      {/each}
    </div>

    {#if !error && !shown.length}
      <div class="hint">{t("Double-click to add a text card, or use the toolbar to add notes and links.")}</div>
    {/if}
  </div>
</div>

<style>
  .canvas {
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--fv-border);
    font-size: 12.5px;
  }
  .toolbar button {
    padding: 3px 8px;
    font-size: 12.5px;
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--fv-border);
    margin: 0 4px;
  }
  .swatch {
    width: 18px;
    height: 18px;
    padding: 0 !important;
    border-radius: 50%;
    background: var(--c);
    border: 1px solid var(--fv-border);
  }
  .swatch.none {
    background: linear-gradient(135deg, transparent 45%, var(--fv-danger) 45% 55%, transparent 55%);
  }
  .zoom {
    min-width: 40px;
    text-align: center;
    color: var(--fv-muted);
  }
  .spacer {
    flex: 1;
  }
  .error {
    padding: 12px;
    color: var(--fv-danger);
  }
  .viewport {
    flex: 1;
    position: relative;
    overflow: hidden;
    cursor: default;
    touch-action: none;
    background-image: radial-gradient(circle, var(--fv-border) 1px, transparent 1px);
    outline-offset: -2px;
  }
  .viewport.panning {
    cursor: grabbing;
  }
  .world {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  }
  .edges {
    position: absolute;
    left: 0;
    top: 0;
    width: 1px;
    height: 1px;
    overflow: visible;
  }
  .edges g {
    color: var(--c);
  }
  .edges .line {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    pointer-events: none;
  }
  .edges .hit {
    fill: none;
    stroke: transparent;
    stroke-width: 14;
    pointer-events: stroke;
    cursor: pointer;
  }
  .edges g.sel .line {
    stroke-width: 3.5;
  }
  .edges polygon {
    fill: currentColor;
  }
  .edges text {
    fill: var(--fv-text);
    font-size: 13px;
    text-anchor: middle;
    paint-order: stroke;
    stroke: var(--fv-bg);
    stroke-width: 4px;
  }
  .pending {
    stroke: var(--fv-accent);
    stroke-width: 2;
    stroke-dasharray: 6 4;
  }
  .node {
    position: absolute;
    background: var(--fv-bg);
    border: 1.5px solid var(--c);
    border-radius: 10px;
    box-shadow: 0 1px 3px #0000001a;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    font-size: 14px;
  }
  .node.colored {
    background: color-mix(in srgb, var(--c) 8%, var(--fv-bg));
  }
  .node.sel {
    outline: 2px solid var(--fv-accent);
    outline-offset: 2px;
    overflow: visible;
  }
  .node.group {
    background: color-mix(in srgb, var(--c) 6%, transparent);
    border-style: dashed;
    box-shadow: none;
    overflow: visible;
  }
  .label,
  .label-edit {
    position: absolute;
    top: -26px;
    left: 0;
    font-weight: 600;
    font-size: 14px;
    color: var(--fv-muted);
    white-space: nowrap;
  }
  .label-edit {
    padding: 1px 4px;
  }
  .md {
    flex: 1;
    overflow: hidden;
    padding: 4px 12px;
    pointer-events: none;
  }
  .md :global(.cm-content) {
    padding: 0 !important;
  }
  textarea {
    flex: 1;
    border: none;
    resize: none;
    padding: 8px 12px;
    font: inherit;
    background: transparent;
    color: var(--fv-text);
    outline: none;
  }
  .title {
    font-weight: 600;
    font-size: 13px;
    padding: 6px 12px 2px;
    color: var(--fv-heading);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .url,
  .missing {
    padding: 0 12px 8px;
    font-size: 12.5px;
    color: var(--fv-muted);
    word-break: break-all;
  }
  img {
    flex: 1;
    min-height: 0;
    object-fit: contain;
    pointer-events: none;
  }
  .handle {
    position: absolute;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--fv-accent);
    border: 2px solid var(--fv-bg);
    cursor: crosshair;
  }
  .handle.top {
    top: -7px;
    left: calc(50% - 6px);
  }
  .handle.bottom {
    bottom: -7px;
    left: calc(50% - 6px);
  }
  .handle.left {
    left: -7px;
    top: calc(50% - 6px);
  }
  .handle.right {
    right: -7px;
    top: calc(50% - 6px);
  }
  .resize {
    position: absolute;
    right: -5px;
    bottom: -5px;
    width: 12px;
    height: 12px;
    cursor: nwse-resize;
  }
  .hint {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--fv-faint);
    font-size: 14px;
    pointer-events: none;
  }
</style>
