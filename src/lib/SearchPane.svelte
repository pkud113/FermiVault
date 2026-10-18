<script lang="ts">
  import { t } from "./i18n.svelte";
  import { onDestroy, onMount } from "svelte";
  import { api, basename, dirname, type Hit } from "./api";
  import { Search, type SearchState } from "./search";
  import { app } from "./store.svelte";

  let q = $state("");
  let input: HTMLInputElement;
  let st = $state<SearchState<Hit>>({ status: "idle", query: "", hits: [] });
  const search = new Search<Hit>(api.search, (s) => (st = s));

  $effect(() => search.set(q));
  // Files changed: re-run the current query (without clearing what is shown).
  let seen = app.version;
  $effect(() => {
    if (app.version !== seen) ((seen = app.version), search.refresh());
  });
  onDestroy(() => search.dispose());

  /** Snippets mark matches with **…**; escape first so note content can't inject HTML. */
  const render = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/\*\*(.+?)\*\*/g, "<mark>$1</mark>");

  onMount(() => input.focus());
</script>

<div class="wrap">
  <input bind:this={input} bind:value={q} placeholder={t("Search vault…")} aria-label={t("Search vault")} spellcheck="false" />
  <div class="count" role="status">
    {#if st.status === "searching"}{t("Searching…")}
    {:else if st.status === "done" && st.hits.length === 0}{t("No matches for “{query}”", { query: st.query.trim() })}
    {:else if st.status === "done"}{t(st.hits.length === 1 ? "1 result" : "{n} results", { n: `${st.hits.length}${st.hits.length === 50 ? "+" : ""}` })}{/if}
  </div>
  {#if st.status === "error"}
    <div class="failed" role="alert">
      <span>{t("Search failed: {error}", { error: st.error ?? "" })}</span>
      <button onclick={() => search.refresh()}>{t("Retry")}</button>
    </div>
  {/if}
  <div class="results" class:stale={st.status === "searching"}>
    {#each st.hits as h (h.path)}
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
  .count:empty {
    display: none;
  }
  .failed {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--fv-danger);
    padding: 6px 8px;
    border: 1px solid var(--fv-danger);
    border-radius: 7px;
  }
  .failed span {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .results.stale {
    opacity: 0.6;
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
