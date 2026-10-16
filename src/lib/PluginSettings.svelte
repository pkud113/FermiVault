<script lang="ts">
  import { t } from "./i18n.svelte";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { api, type PluginInfo } from "./api";
  import { PERMISSIONS, knownPermission } from "./pluginApi";
  import { pluginName } from "./plugins";
  import { app } from "./store.svelte";

  let list = $state<PluginInfo[] | null>(null);
  const load = () => api.pluginsList().then((l) => (list = l), () => (list = []));
  load();

  const requested = (p: PluginInfo) => (Array.isArray(p.manifest?.permissions) ? (p.manifest.permissions as unknown[]) : []);
  const grant = (p: PluginInfo) => app.config.plugins?.[p.id];

  async function toggle(p: PluginInfo, on: boolean) {
    const plugins = { ...(app.config.plugins ?? {}) };
    if (!on) {
      plugins[p.id] = { enabled: false, permissions: [] };
      return app.saveConfig({ plugins });
    }
    const perms = requested(p).filter(knownPermission);
    const lines = perms.length ? perms.map((x) => `• ${t(PERMISSIONS[x])}`).join("\n") : `• ${t("Nothing beyond adding commands and showing messages")}`;
    const ok = await ask(
      t("Enable “{plugin}”? It will be able to:", { plugin: pluginName(p) }) +
        `\n${lines}\n\n` +
        t("Plugins run in a sandbox with no network access and can't touch anything else on your computer. Only enable plugins you trust."),
      { title: t("Enable plugin"), kind: "warning", okLabel: t("Enable"), cancelLabel: t("Cancel") },
    );
    if (!ok) return;
    plugins[p.id] = { enabled: true, permissions: perms };
    await app.saveConfig({ plugins });
  }
</script>

<div class="block">
  <div class="title">
    {t("Plugins")} <small>{t("Add a plugin by putting its folder in")} <code>.fermi/plugins/</code> {t("in this vault, then reload. Plugins run sandboxed, with the permissions you approve.")}</small>
  </div>
  {#if !list}
    <small>{t("Loading…")}</small>
  {:else}
    {#each list as p (p.id)}
      {@const g = grant(p)}
      <div class="plugin">
        <div class="info">
          <div>
            <strong>{pluginName(p)}</strong>
            {#if typeof p.manifest?.version === "string"}<small>v{p.manifest.version}</small>{/if}
          </div>
          {#if p.error}
            <small class="err">{p.error}</small>
          {:else}
            {#if typeof p.manifest?.description === "string"}<small>{p.manifest.description}</small>{/if}
            <small>
              {#if requested(p).length}{t("Asks to:")}
                {requested(p).map((x) => (knownPermission(x) ? t(PERMISSIONS[x]) : t("“{name}” (unknown, ignored)", { name: String(x) }))).join("; ")}{:else}{t("No permissions")}{/if}
            </small>
            {#if g?.enabled && requested(p).some((x) => knownPermission(x) && !g.permissions.includes(x))}
              <small class="err">{t("Now asks for more than you approved; turn it off and on to review.")}</small>
            {/if}
          {/if}
        </div>
        <input type="checkbox" aria-label={t("Enable {plugin}", { plugin: pluginName(p) })} disabled={!!p.error} checked={!!g?.enabled} onchange={(e) => toggle(p, e.currentTarget.checked).then(load)} />
      </div>
    {:else}
      <small>{t("No plugins installed. See")} <code>docs/PLUGINS.md</code> {t("on GitHub to write one.")}</small>
    {/each}
    <button class="reload" onclick={load}>{t("Reload list")}</button>
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
  .plugin {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 0;
  }
  .info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .err {
    color: var(--fv-danger);
  }
  .reload {
    align-self: flex-start;
  }
</style>
