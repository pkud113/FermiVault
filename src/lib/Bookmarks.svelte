<script lang="ts">
  import { keys, t } from "./i18n.svelte";
  import { basename, dirname } from "./api";
  import { app } from "./store.svelte";
</script>

<div class="wrap">
  {#each app.config.bookmarks ?? [] as path (path)}
    <div class="row">
      <button class="open" onclick={(e) => app.open(path, e.ctrlKey || e.metaKey)} title={path}>
        {basename(path)} <span class="dir">{dirname(path)}</span>
      </button>
      <button class="x" aria-label={t("Remove bookmark")} onclick={() => app.toggleBookmark(path)}>✕</button>
    </div>
  {:else}
    <div class="empty">{t("No bookmarks yet. Use “{command}” in the command palette ({keys}) or the “{button}” button at the bottom of a note.", { command: t("Bookmark / unbookmark current note"), keys: keys("Ctrl+P"), button: t("Bookmark") })}</div>
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
