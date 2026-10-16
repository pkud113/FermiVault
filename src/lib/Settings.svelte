<script lang="ts">
  import { LANGUAGES, t } from "./i18n.svelte";
  import { app } from "./store.svelte";
  import AiSettings from "./AiSettings.svelte";
  import SyncSettings from "./SyncSettings.svelte";
  import PluginSettings from "./PluginSettings.svelte";
  import { modal } from "./modal";
</script>

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && (app.showSettings = false)}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label={t("Settings")} tabindex="-1" use:modal={() => (app.showSettings = false)}>
    <div class="head">
      <h3>{t("Settings")}</h3>
      <button onclick={() => (app.showSettings = false)} aria-label={t("Close")}>✕</button>
    </div>
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
    <AiSettings />
    <h4>{t("This vault")}</h4>
    <label>
      <span>{t("Daily notes folder")}</span>
      <input value={app.config.dailyFolder ?? "daily"} onchange={(e) => app.saveConfig({ dailyFolder: e.currentTarget.value.trim() || "daily" })} />
    </label>
    <label>
      <span>{t("Web clipper folder")} <small>{t("Where “Clip web page” saves articles")}</small></span>
      <input value={app.config.clipFolder ?? "Clippings"} onchange={(e) => app.saveConfig({ clipFolder: e.currentTarget.value.trim() || "Clippings" })} />
    </label>
    <SyncSettings />
    <PluginSettings />
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
    <div class="vault">
      <span>{t("Location")}</span>
      <code>{app.root}</code>
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
  }
  .dialog {
    width: min(520px, 92vw);
    background: var(--fv-bg-2);
    border: 1px solid var(--fv-border);
    border-radius: 12px;
    padding: 18px 20px;
    box-shadow: var(--fv-shadow);
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 88vh;
    overflow: auto;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  h3 {
    margin: 0;
  }
  label,
  .vault {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 10px 0;
    border-top: 1px solid var(--fv-border);
    font-size: 14px;
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
    width: 190px;
  }
  h4 {
    margin: 14px 0 2px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fv-faint);
  }
  code {
    font-size: 12px;
    color: var(--fv-muted);
    word-break: break-all;
    text-align: right;
  }
</style>
