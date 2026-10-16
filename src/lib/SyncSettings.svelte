<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { api, type GitStatus } from "./api";
  import { app } from "./store.svelte";

  let status = $state<GitStatus | null>(null);
  let remote = $state("");
  let busy = $state(false);

  async function refresh() {
    status = await api.gitStatus().catch(() => null);
    remote = status?.remote ?? "";
  }

  async function step(fn: () => Promise<unknown>) {
    busy = true;
    try {
      await fn();
    } catch (e) {
      app.error = String(e);
    }
    busy = false;
    await refresh();
  }

  $effect(() => {
    app.sync.last; // re-read after each sync
    refresh();
  });
</script>

<div class="block">
  <div class="title">Sync with Git <small>Version history for this vault, and sync through any Git host (GitHub, GitLab, your own server).</small></div>
  {#if !status}
    <small>Checking…</small>
  {:else if !status.git}
    <small>Git isn't installed. <button class="link" onclick={() => openUrl("https://git-scm.com/downloads")}>Get Git</button>, then reopen Settings.</small>
  {:else if !status.repo}
    <small>This vault isn't a Git repository. Setting it up commits your notes locally; <code>.fermi/</code> (app data) is left out.</small>
    <button class="primary" disabled={busy} onclick={() => step(() => api.gitInit())}>Set up Git for this vault</button>
  {:else}
    <small>
      Branch <code>{status.branch ?? "?"}</code> · {status.changes ? `${status.changes} change${status.changes === 1 ? "" : "s"} not yet synced` : "everything committed"}
    </small>
    <div class="row">
      <input bind:value={remote} placeholder="Remote URL (https://github.com/you/notes.git)" aria-label="Remote URL" spellcheck="false" />
      <button disabled={busy || remote.trim() === (status.remote ?? "")} onclick={() => step(() => api.gitSetRemote(remote))}>Save</button>
    </div>
    <div class="row">
      <span>Sync automatically</span>
      <select value={String(app.config.gitAutoSync ?? 0)} onchange={(e) => app.saveConfig({ gitAutoSync: Number(e.currentTarget.value) })}>
        <option value="0">Off</option>
        <option value="5">Every 5 minutes</option>
        <option value="15">Every 15 minutes</option>
        <option value="60">Every hour</option>
      </select>
      <button disabled={app.sync.busy} onclick={() => app.syncNow()}>{app.sync.busy ? "Syncing…" : "Sync now"}</button>
    </div>
    <small>
      If a note changed on both sides, your version stays and the other is saved next to it as “(conflict date)”. Sign-in uses Git's own credential helper.
    </small>
  {/if}
</div>

<style>
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
  .primary {
    align-self: flex-start;
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--fv-accent);
    font-size: 12px;
  }
</style>
