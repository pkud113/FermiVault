<script lang="ts">
  import { tick } from "svelte";
  import { api, dirname, join, type Entry } from "./api";
  import { app } from "./store.svelte";
  import Icon from "./Icon.svelte";
  import { menuKeys } from "./modal";
  import { arrowIndex } from "./ui";

  const ROW = 26;
  let collapsed = $state(new Set<string>());
  let scrollTop = $state(0);
  let height = $state(600);
  let menu = $state<{ x: number; y: number; entry: Entry | null; from: HTMLElement | null } | null>(null);
  /** Row that Tab lands on (roving focus: the tree is one Tab stop, arrows move inside it). */
  let cursor = $state(0);
  let dropTarget = $state<string | null>(null);

  /** Flat list of rows not hidden under a collapsed folder (entries arrive depth-first). */
  const rows = $derived.by(() => {
    const out: { e: Entry; depth: number }[] = [];
    let hideUnder: string | null = null;
    for (const e of app.files) {
      if (hideUnder && e.path.startsWith(hideUnder + "/")) continue;
      hideUnder = e.dir && collapsed.has(e.path) ? e.path : null;
      out.push({ e, depth: e.path.split("/").length - 1 });
    }
    return out;
  });
  // Only render what's on screen: huge vaults stay instant.
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 10));
  const visible = $derived(rows.slice(first, first + Math.ceil(height / ROW) + 20));
  const tabStop = $derived(cursor >= first && cursor < first + visible.length ? cursor : first);

  function toggle(path: string) {
    const s = new Set(collapsed);
    s.has(path) ? s.delete(path) : s.add(path);
    collapsed = s;
  }

  let treeEl: HTMLElement;
  /** Arrow-key tree navigation. Rows are virtualised, so scroll the target in before focusing it. */
  async function rowKey(ev: KeyboardEvent, i: number) {
    const e = rows[i].e;
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      return click(e, ev as unknown as MouseEvent);
    }
    let to = arrowIndex(ev.key, i, rows.length, false, "ArrowUp", "ArrowDown");
    // Right opens a folder, then steps into it; Left closes it, then steps out to the parent.
    if (ev.key === "ArrowRight" && e.dir && collapsed.has(e.path)) return (ev.preventDefault(), toggle(e.path));
    if (ev.key === "ArrowRight" && e.dir && rows[i + 1]?.e.path.startsWith(e.path + "/")) to = i + 1;
    if (ev.key === "ArrowLeft" && e.dir && !collapsed.has(e.path)) return (ev.preventDefault(), toggle(e.path));
    if (ev.key === "ArrowLeft") to = rows.findIndex((r) => r.e.dir && e.path.startsWith(r.e.path + "/") && r.depth === rows[i].depth - 1);
    if (to < 0) return;
    ev.preventDefault();
    const top = to * ROW;
    if (top < treeEl.scrollTop) treeEl.scrollTop = top;
    else if (top + ROW > treeEl.scrollTop + height) treeEl.scrollTop = top + ROW - height;
    scrollTop = treeEl.scrollTop;
    cursor = to;
    await tick();
    treeEl.querySelector<HTMLElement>(`[data-i="${to}"]`)?.focus();
  }

  function click(e: Entry, ev: MouseEvent) {
    if (e.dir) toggle(e.path);
    else app.open(e.path, ev.ctrlKey || ev.metaKey);
  }

  async function newFolder(dir: string) {
    const name = await app.ask("New folder name");
    if (!name) return;
    await api.mkdir(join(dir, name)).catch((e) => (app.error = String(e)));
    await app.refreshFiles();
  }

  function drop(ev: DragEvent, dir: string) {
    ev.preventDefault();
    dropTarget = null;
    const from = ev.dataTransfer?.getData("text/fv-path");
    if (!from || from === dir || dir.startsWith(from + "/") || dirname(from) === dir) return;
    app.move(from, join(dir, from.split("/").pop()!));
  }
</script>

<svelte:window onclick={() => (menu = null)} />

<div class="head">
  <button title="New note" onclick={() => app.newNote("")}>＋ Note</button>
  <button title="New folder" onclick={() => newFolder("")}>＋ Folder</button>
  <button title="Collapse all" aria-label="Collapse all folders" onclick={() => (collapsed = new Set(app.files.filter((f) => f.dir).map((f) => f.path)))}><Icon name="collapse" size={15} /></button>
</div>
<div
  class="tree"
  bind:this={treeEl}
  role="tree"
  tabindex="-1"
  bind:clientHeight={height}
  onscroll={(ev) => (scrollTop = (ev.target as HTMLElement).scrollTop)}
  oncontextmenu={(ev) => {
    ev.preventDefault();
    menu = { x: ev.clientX, y: ev.clientY, entry: null, from: null };
  }}
  ondragover={(ev) => ev.preventDefault()}
  ondrop={(ev) => drop(ev, "")}
>
  <div style="height:{rows.length * ROW}px; position:relative">
    {#each visible as { e, depth }, i (e.path)}
      <div
        class="row"
        class:active={e.path === app.activePath}
        class:drop={dropTarget === e.path}
        role="treeitem"
        aria-selected={e.path === app.activePath}
        aria-expanded={e.dir ? !collapsed.has(e.path) : undefined}
        tabindex={first + i === tabStop ? 0 : -1}
        data-i={first + i}
        onfocus={() => (cursor = first + i)}
        draggable="true"
        style="top:{(first + i) * ROW}px; padding-left:{10 + depth * 14}px"
        onclick={(ev) => click(e, ev)}
        onkeydown={(ev) => rowKey(ev, first + i)}
        oncontextmenu={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          // Opened from the keyboard (Menu key / Shift+F10): place it at the row.
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          const keyboard = ev.clientX === 0 && ev.clientY === 0;
          menu = { x: keyboard ? r.left + 24 : ev.clientX, y: keyboard ? r.bottom : ev.clientY, entry: e, from: ev.currentTarget as HTMLElement };
        }}
        ondragstart={(ev) => ev.dataTransfer?.setData("text/fv-path", e.path)}
        ondragover={(ev) => {
          if (e.dir) {
            ev.preventDefault();
            ev.stopPropagation();
            dropTarget = e.path;
          }
        }}
        ondragleave={() => dropTarget === e.path && (dropTarget = null)}
        ondrop={(ev) => {
          if (e.dir) {
            ev.stopPropagation();
            drop(ev, e.path);
          }
        }}
      >
        <span class="icon">{e.dir ? (collapsed.has(e.path) ? "▸" : "▾") : ""}</span>
        <span class="name" class:dim={!e.dir && !e.path.endsWith(".md")}>
          {e.path.split("/").pop()!.replace(/\.md$/, "")}
        </span>
      </div>
    {/each}
  </div>
</div>

{#if menu}
  {@const target = menu.entry}
  {@const dir = target ? (target.dir ? target.path : dirname(target.path)) : ""}
  <div class="menu" style="left:{menu.x}px; top:{menu.y}px" role="menu" tabindex="-1" use:menuKeys={() => ((menu?.from?.focus()), (menu = null))}>
    <button role="menuitem" onclick={() => app.newNote(dir)}>New note</button>
    <button role="menuitem" onclick={() => newFolder(dir)}>New folder</button>
    {#if target}
      {#if !target.dir}<button role="menuitem" onclick={() => app.open(target.path, true)}>Open in new tab</button>{/if}
      {#if target.path.endsWith(".md")}
        <button role="menuitem" onclick={() => app.toggleBookmark(target.path)}>{app.isBookmarked(target.path) ? "Remove bookmark" : "Bookmark"}</button>
        <button role="menuitem" onclick={() => (app.recovery = target.path)}>File recovery…</button>
      {/if}
      <button role="menuitem" onclick={() => app.rename(target.path, target.dir)}>Rename…</button>
      <button role="menuitem" class="danger" onclick={() => app.remove(target.path)}>Delete</button>
    {/if}
  </div>
{/if}

<style>
  .head {
    display: flex;
    gap: 4px;
    padding: 8px;
  }
  .head button {
    font-size: 12px;
  }
  .tree {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
    height: 26px;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    border-radius: 6px;
    margin: 0 6px;
    white-space: nowrap;
    overflow: hidden;
    color: var(--fv-muted);
    font-size: 13.5px;
  }
  .row:hover {
    background: var(--fv-hover);
    color: var(--fv-text);
  }
  .row.active {
    background: var(--fv-active);
    color: var(--fv-text);
  }
  .row.drop {
    outline: 2px dashed var(--fv-accent);
  }
  .icon {
    width: 12px;
    flex: none;
    font-size: 11px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dim {
    color: var(--fv-faint);
  }
  .menu {
    position: fixed;
    z-index: 50;
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-border);
    border-radius: 8px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    box-shadow: var(--fv-shadow);
  }
  .menu button {
    text-align: left;
    border: none;
    background: none;
  }
  .menu button:hover {
    background: var(--fv-hover);
  }
  .danger {
    color: var(--fv-danger);
  }
</style>
