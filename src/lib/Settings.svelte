<script lang="ts">
  import { app } from "./store.svelte";
  import AiSettings from "./AiSettings.svelte";
  import { modal } from "./modal";
</script>

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && (app.showSettings = false)}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1" use:modal={() => (app.showSettings = false)}>
    <div class="head">
      <h3>Settings</h3>
      <button onclick={() => (app.showSettings = false)} aria-label="Close">✕</button>
    </div>
    <label>
      <span>Theme</span>
      <select bind:value={app.settings.theme}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
    <label>
      <span>Font size</span>
      <input type="number" min="11" max="28" bind:value={app.settings.fontSize} />
    </label>
    <label>
      <span>Live preview <small>Hide Markdown syntax away from the cursor (Ctrl+E toggles)</small></span>
      <input type="checkbox" bind:checked={app.settings.livePreview} />
    </label>
    <label>
      <span>Readable line width <small>Limit text to a comfortable column</small></span>
      <input type="checkbox" bind:checked={app.settings.readableWidth} />
    </label>
    <label>
      <span>Vim key bindings <small>Normal, insert and visual modes; <code>:w</code> saves</small></span>
      <input type="checkbox" bind:checked={app.settings.vim} />
    </label>
    <label>
      <span>Load web images automatically <small>Off: images from the web wait for a click, so opening a note never contacts other servers</small></span>
      <input type="checkbox" bind:checked={app.settings.remoteImages} />
    </label>
    <AiSettings />
    <h4>This vault</h4>
    <label>
      <span>Daily notes folder</span>
      <input value={app.config.dailyFolder ?? "daily"} onchange={(e) => app.saveConfig({ dailyFolder: e.currentTarget.value.trim() || "daily" })} />
    </label>
    <label>
      <span>Web clipper folder <small>Where “Clip web page” saves articles</small></span>
      <input value={app.config.clipFolder ?? "Clippings"} onchange={(e) => app.saveConfig({ clipFolder: e.currentTarget.value.trim() || "Clippings" })} />
    </label>
    <label>
      <span>Daily note template <small>Path of a note; leave empty for none</small></span>
      <input
        value={app.config.dailyTemplate ?? ""}
        placeholder="templates/Daily.md"
        onchange={(e) => app.saveConfig({ dailyTemplate: e.currentTarget.value.trim() || undefined })}
      />
    </label>
    <label>
      <span>Templates folder <small>{"{{title}}, {{date}} and {{time}} are filled in"}</small></span>
      <input
        value={app.config.templatesFolder ?? "templates"}
        onchange={(e) => app.saveConfig({ templatesFolder: e.currentTarget.value.trim() || "templates" })}
      />
    </label>
    <div class="vault">
      <span>Location</span>
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
