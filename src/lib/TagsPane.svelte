<script lang="ts">
  import { api, basename } from "./api";
  import { app } from "./store.svelte";

  let tags = $state<[string, number][]>([]);
  let open = $state<string | null>(null);
  let notes = $state<string[]>([]);
  let filter = $state("");

  $effect(() => {
    app.version;
    api.tags().then((t) => (tags = t)).catch(() => {});
  });
  $effect(() => {
    const t = open;
    app.version;
    if (t) api.tagged(t).then((n) => open === t && (notes = n));
  });

  const shown = $derived(tags.filter(([t]) => t.toLowerCase().includes(filter.toLowerCase().replace(/^#/, ""))));
</script>

<div class="wrap">
  <input bind:value={filter} placeholder="Filter tags…" spellcheck="false" />
  <div class="list">
    {#each shown as [tag, n] (tag)}
      <button class="tag" class:on={open === tag} onclick={() => (open = open === tag ? null : tag)}>
        <span>#{tag}</span><span class="n">{n}</span>
      </button>
      {#if open === tag}
        {#each notes as path (path)}
          <button class="note" onclick={(e) => app.open(path, e.ctrlKey || e.metaKey)}>{basename(path)}</button>
        {/each}
      {/if}
    {:else}
      <div class="empty">{tags.length ? "No matching tags" : "No tags yet. Add #tags to notes or a tags: list in frontmatter."}</div>
    {/each}
  </div>
</div>

<style>
  .wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
  }
  .list {
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  button {
    border: none;
    background: none;
    text-align: left;
    padding: 5px 8px;
    border-radius: 6px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  button:hover,
  .on {
    background: var(--fv-hover);
    color: var(--fv-text);
  }
  .tag {
    color: var(--fv-accent);
    font-size: 13.5px;
  }
  .n {
    color: var(--fv-faint);
    font-size: 12px;
  }
  .note {
    padding-left: 22px;
    font-size: 13px;
  }
  .empty {
    color: var(--fv-faint);
    font-size: 12.5px;
    padding: 8px;
  }
</style>
