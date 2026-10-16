<script lang="ts">
  import { t } from "./i18n.svelte";
  import { tk } from "./tk";
  import { tabKeys } from "./modal";
  import { api, basename, type LinkRef } from "./api";
  import { app } from "./store.svelte";
  import Chat from "./Chat.svelte";
  import Graph from "./Graph.svelte";
  import Properties from "./Properties.svelte";

  let links = $state<LinkRef[]>([]);
  let related = $state<[string, number][]>([]);

  // Semantic neighbours (empty until semantic search is enabled in Settings → AI).
  $effect(() => {
    const path = app.activePath;
    app.version;
    if (!path?.endsWith(".md") || app.right !== "backlinks") return void (related = []);
    api.related(path).then((r) => app.activePath === path && (related = r.slice(0, 8))).catch(() => (related = []));
  });

  /** Inserts a link to `path` at the cursor of the focused editor. */
  function linkTo(path: string) {
    const view = app.views[app.focus];
    if (!view) return;
    view.dispatch(view.state.replaceSelection(`[[${basename(path)}]]`));
    view.focus();
  }

  $effect(() => {
    const path = app.activePath;
    app.version;
    if (!path || app.right !== "backlinks") return;
    api.backlinks(path).then((l) => app.activePath === path && (links = l)).catch(() => (links = []));
  });

  const groups = $derived(Object.entries(Object.groupBy(links, (l) => l.path)) as [string, LinkRef[]][]);

  const headings = $derived.by(() => {
    const out: { level: number; text: string; line: number }[] = [];
    let fence = false;
    app.docText.split("\n").forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
    });
    return out;
  });
  const minLevel = $derived(Math.min(...headings.map((h) => h.level)));
</script>

<div class="tabs" role="tablist" aria-label={t("Side panel")} use:tabKeys>
  {#each [["backlinks", tk("Backlinks")], ["outline", tk("Outline")], ["properties", tk("Properties")], ["graph", tk("Graph")], ["chat", tk("Chat")]] as const as [id, label]}
    <button role="tab" aria-selected={app.right === id} tabindex={app.right === id ? 0 : -1} class:on={app.right === id} onclick={() => (app.right = id)}>
      {t(label)}
    </button>
  {/each}
</div>

<div class="body" class:fill={app.right === "graph" || app.right === "chat"}>
  {#if app.right === "chat"}
    <Chat />
  {:else if !app.activePath}
    <div class="empty">{t("No note open")}</div>
  {:else if app.right === "backlinks"}
    {#each groups as [path, refs] (path)}
      <div class="group">
        <button class="src" onclick={(e) => app.open(path, e.ctrlKey || e.metaKey)}>{basename(path)}</button>
        {#each refs as r}
          <button class="ctx" onclick={() => app.goto(path, r.line)}>{r.context}</button>
        {/each}
      </div>
    {:else}
      <div class="empty">{t("No backlinks yet. Link here with {link}.", { link: `[[${basename(app.activePath)}]]` })}</div>
    {/each}
    {#if related.length}
      <h5>{t("Related notes")}</h5>
      {#each related as [path, score] (path)}
        <div class="rel">
          <button class="src" onclick={(e) => app.open(path, e.ctrlKey || e.metaKey)} title={t("{percent}% similar", { percent: Math.round(score * 100) })}>{basename(path)}</button>
          <button class="link" onclick={() => linkTo(path)} title={t("Insert a link to this note at the cursor")}>{t("+ Link")}</button>
        </div>
      {/each}
    {/if}
  {:else if app.right === "graph"}
    <Graph local />
  {:else if app.right === "properties"}
    {#if app.activePath.endsWith(".md")}<Properties />{:else}<div class="empty">{t("Properties belong to notes.")}</div>{/if}
  {:else}
    {#each headings as h}
      <button class="heading" style="padding-left:{8 + (h.level - minLevel) * 14}px" onclick={() => app.goto(app.activePath!, h.line)}>
        {h.text}
      </button>
    {:else}
      <div class="empty">{t("No headings")}</div>
    {/each}
  {/if}
</div>

<style>
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px;
  }
  .tabs button {
    flex: 1 1 auto;
    font-size: 12px;
    padding: 5px 4px;
  }
  .tabs .on {
    background: var(--fv-active);
    color: var(--fv-text);
  }
  .body {
    overflow: auto;
    flex: 1;
    padding: 0 8px 8px;
  }
  .body.fill {
    display: flex;
    padding: 0;
    overflow: hidden;
  }
  .group {
    margin-bottom: 10px;
  }
  h5 {
    margin: 16px 8px 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fv-faint);
  }
  .rel {
    display: flex;
    align-items: center;
  }
  .rel .src {
    font-weight: 400;
    flex: 1;
  }
  .link {
    border: none;
    background: none;
    font-size: 11.5px;
    color: var(--fv-accent);
    white-space: nowrap;
    opacity: 0;
  }
  .rel:hover .link,
  .link:focus-visible {
    opacity: 1;
  }
  button.src,
  button.ctx,
  button.heading {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    padding: 5px 8px;
    border-radius: 6px;
  }
  .src {
    font-weight: 600;
    font-size: 13.5px;
  }
  .ctx {
    font-size: 12.5px;
    color: var(--fv-muted);
    border-left: 2px solid var(--fv-border) !important;
    border-radius: 0 !important;
    margin-left: 8px;
    word-break: break-word;
  }
  .heading {
    font-size: 13px;
    color: var(--fv-muted);
  }
  button:hover {
    background: var(--fv-hover);
    color: var(--fv-text);
  }
  .empty {
    color: var(--fv-faint);
    font-size: 12.5px;
    padding: 8px;
  }
</style>
