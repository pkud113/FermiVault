<script lang="ts">
  import { api, basename, type Snapshot } from "./api";
  import { serial } from "./docs";
  import { app } from "./store.svelte";
  import { modal } from "./modal";

  const path = app.recovery!;
  let snaps = $state<Snapshot[]>([]);
  let sel = $state<Snapshot | null>(null);
  let text = $state("");
  let busy = $state(false);

  api.snapshots(path).then((s) => {
    snaps = s;
    if (s[0]) pick(s[0]);
  });

  async function pick(s: Snapshot) {
    sel = s;
    text = await api.readSnapshot(path, s.id).catch((e) => `Could not read snapshot: ${e}`);
  }

  async function restore() {
    if (!sel) return;
    busy = true;
    try {
      // Save open edits first: restoring snapshots them, so they can be restored too.
      if (!(await app.flush())) throw new Error("Couldn't save open notes first; nothing was restored.");
      await serial(() => api.restoreSnapshot(path, sel!.id));
      app.version++; // open editors re-read the file
      app.recovery = null;
    } catch (e) {
      app.error = String(e);
    } finally {
      busy = false;
    }
  }

  const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60_000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleString();
  };
</script>

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && (app.recovery = null)}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="File recovery" tabindex="-1" use:modal={() => (app.recovery = null)}>
    <div class="head">
      <h3>File recovery · {basename(path)}</h3>
      <button onclick={() => (app.recovery = null)} aria-label="Close">✕</button>
    </div>
    {#if snaps.length}
      <div class="body">
        <div class="list">
          {#each snaps as s (s.id)}
            <button class:on={sel === s} onclick={() => pick(s)}>
              {ago(s.time)}<span>{(s.size / 1024).toFixed(1)} KB</span>
            </button>
          {/each}
        </div>
        <pre>{text}</pre>
      </div>
      <div class="actions">
        <span class="hint">Restoring keeps a snapshot of the current version, so it can be undone.</span>
        <button class="primary" disabled={!sel || busy} onclick={restore}>Restore this version</button>
      </div>
    {:else}
      <p class="hint">No snapshots yet. FermiVault keeps one every 5 minutes while you edit, and one before every AI-agent change.</p>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--fv-scrim);
    z-index: 100;
    display: grid;
    place-items: center;
  }
  .dialog {
    width: min(900px, 94vw);
    height: min(640px, 88vh);
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-border);
    border-radius: 12px;
    padding: 16px 18px;
    box-shadow: var(--fv-shadow);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h3 {
    margin: 0;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 210px 1fr;
    gap: 10px;
  }
  .list {
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .list button {
    border: none;
    background: none;
    text-align: left;
    display: flex;
    justify-content: space-between;
  }
  .list button span {
    color: var(--fv-faint);
    font-size: 12px;
  }
  .list .on {
    background: var(--fv-active);
    color: var(--fv-text);
  }
  pre {
    margin: 0;
    overflow: auto;
    background: var(--fv-bg);
    border: 1px solid var(--fv-border);
    border-radius: 8px;
    padding: 12px;
    font-size: 12.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .hint {
    color: var(--fv-faint);
    font-size: 12.5px;
  }
</style>
