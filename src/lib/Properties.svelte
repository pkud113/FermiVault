<script lang="ts">
  import { t } from "./i18n.svelte";
  import { diffChange, readProps, removeProp, setProp, type PropValue } from "./frontmatter";
  import { app } from "./store.svelte";

  const props = $derived(readProps(app.docText));
  let newKey = $state("");
  let newValue = $state("");

  /** Applies a frontmatter edit to the open note through its editor: undoable, and saved like typing. */
  function edit(fn: (text: string) => string) {
    const ed = app.focusedEditor();
    const doc = ed?.doc();
    if (!ed || !doc) return void (app.error = t("Open a note first."));
    const text = doc.state.doc.toString();
    const next = fn(text);
    if (next !== text) ed.apply(doc, { changes: diffChange(text, next) });
  }

  const kind = (v: PropValue) =>
    Array.isArray(v) ? "list" : /^(true|false)$/i.test(v) ? "check" : /^\d{4}-\d{2}-\d{2}$/.test(v) ? "date" : "text";
  const value = (s: string, list: boolean): PropValue => (list ? s.split(",").map((x) => x.trim()).filter(Boolean) : s.trim());

  function add() {
    const key = newKey.trim();
    if (!key) return;
    edit((text) => setProp(text, key, value(newValue, newValue.includes(","))));
    newKey = newValue = "";
  }
</script>

{#each props as p (p.key)}
  <div class="prop">
    <span class="key" title={p.key}>{p.key}</span>
    {#if kind(p.value) === "check"}
      <input type="checkbox" aria-label={p.key} checked={p.value === "true"} onchange={(e) => edit((text) => setProp(text, p.key, e.currentTarget.checked ? "true" : "false"))} />
      <span class="spacer"></span>
    {:else if kind(p.value) === "date"}
      <input type="date" aria-label={p.key} value={p.value} onchange={(e) => edit((text) => setProp(text, p.key, e.currentTarget.value))} />
    {:else}
      <input
        aria-label={p.key}
        value={Array.isArray(p.value) ? p.value.join(", ") : p.value}
        placeholder={Array.isArray(p.value) ? "a, b, c" : t("empty")}
        onchange={(e) => edit((text) => setProp(text, p.key, value(e.currentTarget.value, Array.isArray(p.value))))}
      />
    {/if}
    <button class="x" aria-label={t("Remove {property}", { property: p.key })} title={t("Remove property")} onclick={() => edit((text) => removeProp(text, p.key))}>✕</button>
  </div>
{:else}
  <div class="empty">{t("No properties yet. They're stored as YAML at the top of the note, and tables can filter and sort by them.")}</div>
{/each}

<form class="add" onsubmit={(e) => (e.preventDefault(), add())}>
  <input placeholder={t("Property")} aria-label={t("New property name")} bind:value={newKey} spellcheck="false" />
  <input placeholder={t("Value (a, b for a list)")} aria-label={t("New property value")} bind:value={newValue} />
  <button disabled={!newKey.trim()}>{t("Add")}</button>
</form>

<style>
  .prop {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
  }
  .key {
    flex: 0 0 34%;
    font-size: 12.5px;
    color: var(--fv-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .prop input:not([type="checkbox"]) {
    flex: 1;
    min-width: 0;
    font-size: 13px;
  }
  .spacer {
    flex: 1;
  }
  .x {
    border: none;
    background: none;
    padding: 2px 4px;
    font-size: 10px;
    color: var(--fv-muted);
  }
  .x:hover {
    color: var(--fv-danger);
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--fv-border);
  }
  .add input {
    flex: 1 1 40%;
    min-width: 0;
    font-size: 13px;
  }
  .empty {
    color: var(--fv-faint);
    font-size: 12.5px;
    padding: 8px 0;
  }
</style>
