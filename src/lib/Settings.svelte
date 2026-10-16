<script lang="ts">
  import { LANGUAGES, t } from "./i18n.svelte";
  import { tk } from "./tk";
  import { app } from "./store.svelte";
  import AiSettings from "./AiSettings.svelte";
  import SyncSettings from "./SyncSettings.svelte";
  import PluginSettings from "./PluginSettings.svelte";
  import { modal, tabKeys } from "./modal";

  const SECTIONS = [
    ["general", tk("General")],
    ["editor", tk("Editor")],
    ["ai", tk("AI")],
    ["vault", tk("Vault")],
    ["sync", tk("Sync")],
    ["plugins", tk("Plugins")],
  ] as const;
  const close = () => (app.showSettings = false);
</script>

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && close()}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1" use:modal={close}>
    <!-- Title and Close stay put; only the section scrolls. -->
    <div class="head">
      <h3 id="settings-title">{t("Settings")}</h3>
      <button onclick={close} aria-label={t("Close")} title={t("Close (Esc)")}>✕</button>
    </div>
    <div class="layout">
      <div class="nav" role="tablist" aria-label={t("Settings sections")} aria-orientation="vertical" use:tabKeys>
        {#each SECTIONS as [id, label]}
          <button
            role="tab"
            id="settings-tab-{id}"
            aria-selected={app.settingsSection === id}
            aria-controls="settings-panel"
            tabindex={app.settingsSection === id ? 0 : -1}
            class:on={app.settingsSection === id}
            onclick={() => (app.settingsSection = id)}
          >
            {t(label)}
          </button>
        {/each}
      </div>
      <div class="panel" id="settings-panel" role="tabpanel" aria-labelledby="settings-tab-{app.settingsSection}" tabindex="-1">
        {#if app.settingsSection === "general"}
          <label>
            <span>{t("Language")}</span>
            <select bind:value={app.settings.language}>
              <option value="system">{t("System")}</option>
              {#each Object.entries(LANGUAGES) as [code, name]}<option value={code}>{name}</option>{/each}
            </select>
          </label>
          <label>
            <span>{t("Theme")}</span>
            <select bind:value={app.settings.theme}>
              <option value="system">{t("System")}</option>
              <option value="light">{t("Light")}</option>
              <option value="dark">{t("Dark")}</option>
            </select>
          </label>
          <label>
            <span>{t("Font size")}</span>
            <input type="number" min="11" max="28" bind:value={app.settings.fontSize} />
          </label>
        {:else if app.settingsSection === "editor"}
          <label>
            <span>{t("Live preview")} <small>{t("Hide Markdown syntax away from the cursor (Ctrl+E toggles)")}</small></span>
            <input type="checkbox" bind:checked={app.settings.livePreview} />
          </label>
          <label>
            <span>{t("Readable line width")} <small>{t("Limit text to a comfortable column")}</small></span>
            <input type="checkbox" bind:checked={app.settings.readableWidth} />
          </label>
          <label>
            <span>{t("Vim key bindings")} <small>{t("Normal, insert and visual modes;")} <code>:w</code> {t("saves")}</small></span>
            <input type="checkbox" bind:checked={app.settings.vim} />
          </label>
          <label>
            <span>{t("Load web images automatically")} <small>{t("Off: images from the web wait for a click, so opening a note never contacts other servers")}</small></span>
            <input type="checkbox" bind:checked={app.settings.remoteImages} />
          </label>
        {:else if app.settingsSection === "ai"}
          <AiSettings />
        {:else if app.settingsSection === "vault"}
          <p class="intro">{t("These settings belong to this vault.")}</p>
          <label>
            <span>{t("Daily notes folder")}</span>
            <input value={app.config.dailyFolder ?? "daily"} onchange={(e) => app.saveConfig({ dailyFolder: e.currentTarget.value.trim() || "daily" })} />
          </label>
          <label>
            <span>{t("Daily note template")} <small>{t("Path of a note; leave empty for none")}</small></span>
            <input
              value={app.config.dailyTemplate ?? ""}
              placeholder="templates/Daily.md"
              onchange={(e) => app.saveConfig({ dailyTemplate: e.currentTarget.value.trim() || undefined })}
            />
          </label>
          <label>
            <span>{t("Templates folder")} <small>{t("{a}, {b} and {c} are filled in", { a: "{{title}}", b: "{{date}}", c: "{{time}}" })}</small></span>
            <input
              value={app.config.templatesFolder ?? "templates"}
              onchange={(e) => app.saveConfig({ templatesFolder: e.currentTarget.value.trim() || "templates" })}
            />
          </label>
          <label>
            <span>{t("Web clipper folder")} <small>{t("Where “Clip web page” saves articles")}</small></span>
            <input value={app.config.clipFolder ?? "Clippings"} onchange={(e) => app.saveConfig({ clipFolder: e.currentTarget.value.trim() || "Clippings" })} />
          </label>
          <div class="vault">
            <span>{t("Location")}</span>
            <code>{app.root}</code>
          </div>
        {:else if app.settingsSection === "sync"}
          <SyncSettings />
        {:else}
          <PluginSettings />
        {/if}
      </div>
    </div>
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
    padding: 12px;
  }
  .dialog {
    width: min(720px, 100%);
    height: min(600px, 100%);
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-border);
    border-radius: 12px;
    box-shadow: var(--fv-shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px 10px 20px;
    border-bottom: 1px solid var(--fv-border);
    flex: none;
  }
  h3 {
    margin: 0;
  }
  .head button {
    border: none;
    background: none;
    padding: 4px 8px;
  }
  .layout {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .nav {
    flex: none;
    width: 150px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 8px;
    border-right: 1px solid var(--fv-border);
    overflow: auto;
  }
  .nav button {
    border: none;
    background: none;
    text-align: left;
    padding: 6px 10px;
    font-size: 13.5px;
    color: var(--fv-muted);
  }
  .nav button:hover {
    background: var(--fv-hover);
  }
  .nav .on {
    background: var(--fv-active);
    color: var(--fv-text);
  }
  .panel {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 4px 20px 16px;
    display: flex;
    flex-direction: column;
  }
  /* Narrow windows: sections become a row of tabs above the panel. */
  @media (max-width: 640px) {
    .layout {
      flex-direction: column;
    }
    .nav {
      width: auto;
      flex-direction: row;
      border-right: none;
      border-bottom: 1px solid var(--fv-border);
      padding: 6px 8px;
    }
    .nav button {
      white-space: nowrap;
    }
    .panel {
      padding: 4px 14px 14px;
    }
  }
  .intro {
    margin: 12px 0 2px;
    font-size: 12.5px;
    color: var(--fv-faint);
  }
  label,
  .vault {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--fv-border);
    font-size: 14px;
  }
  label:last-child,
  .vault:last-child {
    border-bottom: none;
  }
  small {
    display: block;
    color: var(--fv-faint);
    font-size: 12px;
  }
  input[type="number"] {
    width: 70px;
  }
  label input:not([type]) {
    width: min(190px, 45%);
    flex: none;
  }
  code {
    font-size: 12px;
    color: var(--fv-muted);
    word-break: break-all;
    text-align: right;
  }
</style>
