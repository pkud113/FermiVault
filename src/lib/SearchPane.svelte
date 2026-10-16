<script lang="ts">
  import { t } from "./i18n.svelte";
  import { onMount } from "svelte";
  import { api, basename, dirname, type Hit } from "./api";
  import { app } from "./store.svelte";

  let q = $state("");
  let hits = $state<Hit[]>([]);
  let input: HTMLInputElement;
  let timer: ReturnType<typeof setTimeout>;

  $effect(() => {
    const query = q;
    app.version; // re-run when files change
    clearTimeout(timer);
    timer = setTimeout(async () => {
      hits = query.trim() ? await api.search(query).catch(() => []) : [];
    }, 120);
  });

  /** Snippets mark matches with **…**; escape first so note content can't inject HTML. */
  const render = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/\*\*(.+?)\*\*/g, "<mark>$1</mark>");

  onMount(() => input.focus());
</script>

<div class="wrap">
  <input bind:this={input} bind:value={q} placeholder={t("Search vault…")} spellcheck="false" />
  {#if q.trim()}<div class="count">{t(hits.length === 1 ? "1 result" : "{n} results", { n: `${hits.length}${hits.length === 50 ? "+" : ""}` })}</div>{/if}
  <div class="results">
    {#each hits as h (h.path)}
      <button class="hit" onclick={(e) => app.open(h.path, e.ctrlKey || e.metaKey)}>
        <div class="name">{basename(h.path)} <span class="dir">{dirname(h.path)}</span></div>
        <div class="snip">{@html render(h.snippet)}</div>
      </button>
    {/each}
  </div>
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    padding: 8px;
    gap: 6px;
  }
  .count {
    font-size: 12px;
    color: var(--fv-faint);
    padding: 0 4px;
  }
  .results {
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hit {
    text-align: left;
    border: none;
    background: none;
    padding: 8px;
    border-radius: 7px;
  }
  .hit:hover {
    background: var(--fv-hover);
  }
  .name {
    font-weight: 600;
    font-size: 13.5px;
  }
  .dir {
    font-weight: 400;
    color: var(--fv-faint);
    font-size: 12px;
  }
  .snip {
    font-size: 12.5px;
    color: var(--fv-muted);
    margin-top: 2px;
    word-break: break-word;
  }
  .snip :global(mark) {
    background: var(--fv-match);
    color: inherit;
    border-radius: 3px;
  }
</style>
