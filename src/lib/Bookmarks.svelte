<script lang="ts">
  import { basename, dirname } from "./api";
  import { app } from "./store.svelte";
</script>

<div class="wrap">
  {#each app.config.bookmarks ?? [] as path (path)}
    <div class="row">
      <button class="open" onclick={(e) => app.open(path, e.ctrlKey || e.metaKey)} title={path}>
        {basename(path)} <span class="dir">{dirname(path)}</span>
      </button>
      <button class="x" aria-label="Remove bookmark" onclick={() => app.toggleBookmark(path)}>✕</button>
    </div>
  {:else}
    <div class="empty">No bookmarks. Use “Bookmark current note” in the command palette (Ctrl+P) or the file menu.</div>
  {/each}
</div>

<style>
  .wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: 6px;
  }
  .row:hover {
    background: var(--fv-hover);
  }
  button {
    border: none;
    background: none;
  }
  .open {
    flex: 1;
    text-align: left;
    padding: 6px 8px;
    color: var(--fv-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir {
    color: var(--fv-faint);
    font-size: 12px;
  }
  .x {
    font-size: 10px;
    opacity: 0;
  }
  .row:hover .x,
  .x:focus-visible {
    opacity: 0.85;
  }
  .empty {
    color: var(--fv-faint);
    font-size: 12.5px;
    padding: 8px;
    line-height: 1.5;
  }
</style>
