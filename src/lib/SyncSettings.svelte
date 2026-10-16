<script lang="ts">
  import { t } from "./i18n.svelte";
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
  <div class="title">{t("Sync with Git")} <small>{t("Version history for this vault, and sync through any Git host (GitHub, GitLab, your own server).")}</small></div>
  {#if !status}
    <small>{t("Checking…")}</small>
  {:else if !status.git}
    <small>{t("Git isn't installed.")} <button class="link" onclick={() => openUrl("https://git-scm.com/downloads")}>{t("Get Git")}</button>{t(", then reopen Settings.")}</small>
  {:else if !status.repo}
    <small>{t("This vault isn't a Git repository. Setting it up commits your notes locally;")} <code>.fermi/</code> {t("(app data) is left out.")}</small>
    <button class="primary" disabled={busy} onclick={() => step(() => api.gitInit())}>{t("Set up Git for this vault")}</button>
  {:else if !status.trusted}
    <small>{t("This vault already has a Git repository. Use it only if you made it or trust where it came from: a repository's settings can run programs on your computer.")}</small>
    <button class="primary" disabled={busy} onclick={() => step(() => api.gitInit())}>{t("Use this repository")}</button>
  {:else}
    <small>
      {t("Branch")} <code>{status.branch ?? "?"}</code> · {status.changes ? t(status.changes === 1 ? "1 change not yet synced" : "{n} changes not yet synced", { n: status.changes }) : t("everything committed")}
    </small>
    <div class="row">
      <input bind:value={remote} placeholder={t("Remote URL (https://github.com/you/notes.git)")} aria-label={t("Remote URL")} spellcheck="false" />
      <button disabled={busy || remote.trim() === (status.remote ?? "")} onclick={() => step(() => api.gitSetRemote(remote))}>{t("Save")}</button>
    </div>
    <div class="row">
      <span>{t("Sync automatically")}</span>
      <select value={String(app.config.gitAutoSync ?? 0)} onchange={(e) => app.saveConfig({ gitAutoSync: Number(e.currentTarget.value) })}>
        <option value="0">{t("Off")}</option>
        <option value="5">{t("Every 5 minutes")}</option>
        <option value="15">{t("Every 15 minutes")}</option>
        <option value="60">{t("Every hour")}</option>
      </select>
      <button disabled={app.sync.busy} onclick={() => app.syncNow()}>{app.sync.busy ? t("Syncing…") : t("Sync now")}</button>
    </div>
    <small>
      {t("If a note changed on both sides, your version stays and the other is saved next to it as “(conflict date)”. Sign-in uses Git's own credential helper.")}
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
