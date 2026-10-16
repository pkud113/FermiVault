<script lang="ts">
  import { api, type AiApp } from "./api";
  import { app } from "./store.svelte";
  import { modal } from "./modal";

  let apps = $state<AiApp[]>([]);
  let confirm = $state<{ app: AiApp; preview: string } | null>(null);
  let busy = $state(false);

  const refresh = async () => (apps = await api.aiApps());
  $effect(() => {
    refresh();
  });

  const here = (a: AiApp) => a.connected && a.vault?.toLowerCase() === app.root?.toLowerCase();
  const sorted = $derived([...apps].sort((a, b) => Number(b.detected) - Number(a.detected)));

  async function ask(a: AiApp) {
    confirm = { app: a, preview: await api.aiPreview(a.id) };
  }

  async function set(a: AiApp, connected: boolean) {
    busy = true;
    try {
      await api.aiSet(a.id, connected);
      confirm = null;
      await refresh();
    } catch (e) {
      app.error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <p class="intro">
    Let AI apps read, search and edit this vault through MCP. They stay separate apps: FermiVault only adds itself to
    their MCP config. Restart the app after connecting.
  </p>
  {#each sorted as a (a.id)}
    <div class="app" class:off={!a.detected}>
      <div class="info">
        <div class="name">
          {a.name}
          {#if here(a)}<span class="badge ok">Connected</span>
          {:else if a.connected}<span class="badge warn">Other vault</span>
          {:else if !a.detected}<span class="badge">Not found</span>{/if}
        </div>
        {#if a.connected && !here(a)}<div class="sub">Points to {a.vault}</div>{/if}
      </div>
      {#if here(a)}
        <button disabled={busy} onclick={() => set(a, false)}>Disconnect</button>
      {:else}
        <button class="primary" disabled={busy} onclick={() => ask(a)}>{a.connected ? "Switch here" : "Connect"}</button>
      {/if}
    </div>
  {/each}
</div>

{#if confirm}
  <div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && (confirm = null)}>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Confirm connection" tabindex="-1" use:modal={() => (confirm = null)}>
      <h3>Connect {confirm.app.name}?</h3>
      <p>FermiVault will add this entry to the file below. Other settings are kept, and the original is saved next to it as <code>.fermivault-backup</code>.</p>
      <pre>{confirm.preview}</pre>
      <div class="actions">
        <button onclick={() => (confirm = null)}>Cancel</button>
        <button class="primary" disabled={busy} onclick={() => set(confirm!.app, true)}>Connect</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .wrap {
    flex: 1;
    min-height: 0;
    padding: 8px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .intro {
    font-size: 12.5px;
    color: var(--fv-muted);
    margin: 0 4px 6px;
    line-height: 1.5;
  }
  .app {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--fv-border);
    border-radius: 8px;
  }
  .app.off {
    color: var(--fv-muted);
  }
  .info {
    min-width: 0;
  }
  .name {
    font-weight: 600;
    font-size: 13.5px;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .sub {
    font-size: 11.5px;
    color: var(--fv-faint);
    word-break: break-all;
  }
  .badge {
    font-size: 10.5px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 99px;
    background: var(--fv-hover);
    color: var(--fv-muted);
  }
  .badge.ok {
    background: var(--fv-ok-bg);
    color: var(--fv-ok);
  }
  .badge.warn {
    background: var(--fv-warn-bg);
    color: var(--fv-warn);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--fv-scrim);
    z-index: 100;
    display: grid;
    place-items: center;
  }
  .dialog {
    width: min(640px, 92vw);
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-border);
    border-radius: 12px;
    padding: 20px;
    box-shadow: var(--fv-shadow);
  }
  h3 {
    margin: 0 0 8px;
  }
  p {
    font-size: 13px;
    color: var(--fv-muted);
  }
  pre {
    background: var(--fv-bg);
    border: 1px solid var(--fv-border);
    border-radius: 8px;
    padding: 12px;
    font-size: 12px;
    overflow: auto;
    max-height: 40vh;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
