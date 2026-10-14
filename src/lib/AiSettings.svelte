<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { api, type EmbedStatus, type Endpoint } from "./api";
  import { app } from "./store.svelte";

  let status = $state<EmbedStatus | null>(null);
  let download = $state<{ done: number; total: number } | null>(null);
  let endpoints = $state<Endpoint[]>([]);
  let detecting = $state(true);
  let models = $state<string[]>([]);
  let custom = $state(app.settings.aiBaseUrl);
  let key = $state("");
  let hasKey = $state(false);

  const refresh = () => api.embedStatus().then((s) => (status = s)).catch(() => {});

  async function loadModels(base: string) {
    models = [];
    if (!base) return;
    hasKey = await api.aiHasKey(base).catch(() => false);
    models = await api.aiModels(base).catch(() => []);
    if (models.length && !models.includes(app.settings.aiModel)) app.settings.aiModel = models[0];
  }

  function useEndpoint(base: string) {
    app.settings.aiBaseUrl = custom = base;
    loadModels(base);
  }

  async function saveKey() {
    await api.aiSetKey(app.settings.aiBaseUrl, key || null).catch((e) => (app.error = String(e)));
    key = "";
    loadModels(app.settings.aiBaseUrl);
  }

  onMount(() => {
    refresh();
    api.aiDetect().then((e) => {
      endpoints = e;
      detecting = false;
      if (!app.settings.aiBaseUrl && e[0]) useEndpoint(e[0].base_url);
    });
    if (app.settings.aiBaseUrl) loadModels(app.settings.aiBaseUrl);
    const offs = [
      listen<{ done?: number; total?: number; finished?: boolean; error?: string }>("embed-download", (e) => {
        if (e.payload.finished) {
          download = null;
          if (e.payload.error) app.error = `Model download failed: ${e.payload.error}`;
          refresh();
        } else download = { done: e.payload.done!, total: e.payload.total! };
      }),
      listen("embed-progress", refresh),
    ];
    return () => offs.forEach((o) => o.then((f) => f()));
  });

  const mb = (n: number) => (n / 1048576).toFixed(1);
</script>

<h4>AI</h4>
<div class="block">
  <div class="title">Semantic search <small>Finds notes by meaning, powers chat sources and related notes. Runs locally.</small></div>
  {#if download}
    <progress max={download.total} value={download.done}></progress>
    <small>Downloading model… {mb(download.done)} / {mb(download.total)} MB</small>
  {:else if status && !status.installed}
    <button class="primary" onclick={() => api.embedInstall().then(() => (download = { done: 0, total: 1 }))}>Download model (about 30 MB)</button>
    <small>One-time download of <code>{status.model}</code> from Hugging Face.</small>
  {:else if status}
    <small>
      On · {(status.total - status.pending).toLocaleString()} / {status.total.toLocaleString()} passages indexed{status.running ? " (indexing…)" : ""}
    </small>
  {/if}
</div>

<div class="block">
  <div class="title">Chat and writing model <small>Any OpenAI-compatible server. Local servers are detected automatically.</small></div>
  {#if detecting}
    <small>Looking for local model servers…</small>
  {:else}
    {#each endpoints as e (e.base_url)}
      <label class="choice">
        <input type="radio" name="endpoint" checked={app.settings.aiBaseUrl === e.base_url} onchange={() => useEndpoint(e.base_url)} />
        {e.name} <small>{e.models.length} models · local</small>
      </label>
    {:else}
      <small>No local server found. Install <button class="link" onclick={() => openUrl("https://ollama.com")}>Ollama</button> or LM Studio, or use an API below.</small>
    {/each}
  {/if}
  <div class="row">
    <input bind:value={custom} placeholder="https://api.example.com/v1" spellcheck="false" />
    <button onclick={() => useEndpoint(custom.trim())}>Use URL</button>
  </div>
  {#if app.settings.aiBaseUrl}
    <div class="row">
      <span>Model</span>
      {#if models.length}
        <select bind:value={app.settings.aiModel}>
          {#each models as m}<option value={m}>{m}</option>{/each}
        </select>
      {:else}
        <input bind:value={app.settings.aiModel} placeholder="model name" spellcheck="false" />
      {/if}
    </div>
    <div class="row">
      <input type="password" bind:value={key} placeholder={hasKey ? "API key saved in system keychain" : "API key (only for hosted APIs)"} />
      <button onclick={saveKey}>{key ? "Save key" : hasKey ? "Remove key" : "Save key"}</button>
    </div>
  {/if}
</div>

<style>
  h4 {
    margin: 14px 0 2px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fv-faint);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 0;
    border-top: 1px solid var(--fv-border);
    font-size: 14px;
  }
  small {
    color: var(--fv-faint);
    font-size: 12px;
  }
  .title small {
    display: block;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .row input,
  .row select {
    flex: 1;
    min-width: 0;
  }
  progress {
    width: 100%;
    accent-color: var(--fv-accent);
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--fv-accent);
    font-size: 12px;
  }
  .primary {
    align-self: flex-start;
  }
</style>
