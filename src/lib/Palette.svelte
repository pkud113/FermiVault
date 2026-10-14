<script lang="ts">
  import { onMount } from "svelte";
  import { basename, dirname, fuzzy } from "./api";
  import { app, type Command } from "./store.svelte";

  let { commands }: { commands: Command[] } = $props();
  type Item = { label: string; detail?: string; run: (newTab: boolean) => unknown };

  const mode = app.palette!;
  let q = $state(mode.kind === "prompt" ? mode.value : "");
  let sel = $state(0);
  let input: HTMLInputElement;
  let list = $state<HTMLDivElement>();

  function rank(items: Item[], key: (i: Item) => string): Item[] {
    if (!q.trim()) return items;
    return items
      .map((i) => [fuzzy(q, key(i)), i] as const)
      .filter(([s]) => s >= 0)
      .sort((a, b) => b[0] - a[0])
      .map(([, i]) => i);
  }

  const items: Item[] = $derived.by(() => {
    if (mode.kind === "prompt") return [];
    if (mode.kind === "commands") return rank(commands.map((c) => ({ label: c.name, detail: c.keys, run: c.run })), (i) => i.label);
    if (mode.kind === "pick") return rank(mode.items, (i) => i.label);
    const notes = rank(
      app.notes.map((p) => ({ label: basename(p), detail: dirname(p), run: (nt: boolean) => app.open(p, nt) })),
      (i) => (i.detail ? i.detail + "/" : "") + i.label,
    ).slice(0, 100);
    const name = q.trim();
    if (name && !app.notes.some((n) => n.toLowerCase() === (name.endsWith(".md") ? name : name + ".md").toLowerCase())) {
      notes.push({ label: `Create “${name}”`, run: (nt) => app.openLink(name, nt) });
    }
    return notes;
  });

  $effect(() => {
    q;
    sel = 0;
  });
  $effect(() => {
    list?.children[sel]?.scrollIntoView({ block: "nearest" });
  });

  function close(value: string | null = null) {
    app.palette = null;
    if (mode.kind === "prompt") mode.resolve(value);
  }

  function choose(i: number, newTab = false) {
    const item = items[i];
    close();
    item?.run(newTab);
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") sel = Math.min(sel + 1, items.length - 1);
    else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
    else if (e.key === "Enter") {
      if (mode.kind === "prompt") close(q.trim() || null);
      else choose(sel, e.ctrlKey || e.metaKey);
    } else return;
    e.preventDefault();
  }

  onMount(() => {
    input.focus();
    input.select();
  });
</script>

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && close()}>
  <div class="palette" role="dialog" aria-label={mode.kind === "prompt" ? mode.title : "Palette"}>
    {#if mode.kind === "prompt"}<div class="title">{mode.title}</div>{/if}
    <input
      bind:this={input}
      bind:value={q}
      onkeydown={keydown}
      spellcheck="false"
      placeholder={mode.kind === "switcher" ? "Find or create a note…" : mode.kind === "commands" ? "Type a command…" : mode.kind === "pick" ? mode.placeholder : ""}
    />
    {#if mode.kind !== "prompt"}
      <div class="list" bind:this={list} role="listbox">
        {#each items as item, i}
          <div
            class="item"
            class:sel={i === sel}
            role="option"
            aria-selected={i === sel}
            tabindex="-1"
            onmousemove={() => (sel = i)}
            onclick={(e) => choose(i, e.ctrlKey || e.metaKey)}
            onkeydown={() => {}}
          >
            <span>{item.label}</span>
            {#if item.detail}<span class="detail">{item.detail}</span>{/if}
          </div>
        {:else}
          <div class="empty">No results</div>
        {/each}
      </div>
      <div class="hint">↑↓ navigate · ↵ open · ctrl+↵ new tab · esc close</div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--fv-scrim);
    z-index: 100;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }
  .palette {
    width: min(620px, 92vw);
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-border);
    border-radius: 12px;
    box-shadow: var(--fv-shadow);
    overflow: hidden;
  }
  .title {
    padding: 12px 16px 0;
    font-size: 13px;
    color: var(--fv-muted);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    border: none;
    border-bottom: 1px solid var(--fv-border);
    background: transparent;
    padding: 14px 16px;
    font-size: 16px;
    color: var(--fv-text);
    outline: none;
  }
  .list {
    max-height: 50vh;
    overflow: auto;
    padding: 6px;
  }
  .item {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 10px;
    border-radius: 7px;
    cursor: pointer;
  }
  .item.sel {
    background: var(--fv-active);
  }
  .detail {
    color: var(--fv-faint);
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .empty,
  .hint {
    padding: 10px 16px;
    color: var(--fv-faint);
    font-size: 12px;
  }
  .hint {
    border-top: 1px solid var(--fv-border);
  }
</style>
