<script lang="ts">
  import { t } from "./i18n.svelte";
  import { diffChange, readProps, removeProp, setProp, type PropValue } from "./frontmatter";
  import { app } from "./store.svelte";

  const props = $derived(readProps(app.activeDoc?.text ?? ""));
  let newKey = $state("");
  let newValue = $state("");

  /** Applies a frontmatter edit to the open note through its editor: undoable, and saved like typing. */
  function edit(fn: (text: string) => string) {
    const ed = app.focusedEditor();
    const doc = ed?.doc();
    if (!ed || !doc || doc.path !== app.activeDoc?.path) return void (app.error = t("Open a note first."));
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

{#each props as p, i (p.key)}
  {@const id = `prop-${i}`}
  <div class="prop" class:check={kind(p.value) === "check"}>
    <label class="key" for={id} title={p.key}>{p.key}</label>
    <button class="x" aria-label={t("Remove {property}", { property: p.key })} title={t("Remove property")} onclick={() => edit((text) => removeProp(text, p.key))}>✕</button>
    {#if kind(p.value) === "check"}
      <input {id} type="checkbox" checked={p.value === "true"} onchange={(e) => edit((text) => setProp(text, p.key, e.currentTarget.checked ? "true" : "false"))} />
    {:else if kind(p.value) === "date"}
      <input {id} type="date" value={p.value} onchange={(e) => edit((text) => setProp(text, p.key, e.currentTarget.value))} />
    {:else}
      <input
        {id}
        value={Array.isArray(p.value) ? p.value.join(", ") : p.value}
        placeholder={Array.isArray(p.value) ? t("item, item") : t("empty")}
        title={Array.isArray(p.value) ? t("A list: separate items with commas") : undefined}
        onchange={(e) => edit((text) => setProp(text, p.key, value(e.currentTarget.value, Array.isArray(p.value))))}
      />
    {/if}
  </div>
{:else}
  <div class="empty">{t("No properties yet. They're stored as YAML at the top of the note, and tables can filter and sort by them.")}</div>
{/each}

<form class="add" onsubmit={(e) => (e.preventDefault(), add())}>
  <div class="add-title">{t("Add a property")}</div>
  <label>
    <span>{t("Name")}</span>
    <input placeholder="status" bind:value={newKey} spellcheck="false" />
  </label>
  <label>
    <span>{t("Value")}</span>
    <input placeholder="doing" bind:value={newValue} aria-describedby="prop-hint" />
  </label>
  <small id="prop-hint">{t("Separate list items with commas. A date as YYYY-MM-DD gets a date picker; true or false gets a checkbox.")}</small>
  <button disabled={!newKey.trim()}>{t("Add")}</button>
</form>

<style>
  .prop {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 4px;
    padding: 4px 0 6px;
  }
  .prop input {
    grid-column: 1 / -1;
    min-width: 0;
    font-size: 13px;
  }
  /* Checkboxes sit next to their name. */
  .prop.check {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .prop.check input {
    grid-column: 1;
    grid-row: 1;
  }
  .prop.check .key {
    grid-column: 2;
  }
  .key {
    font-size: 12px;
    color: var(--fv-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 2px 2px;
  }
  .x {
    border: none;
    background: none;
    padding: 2px 6px;
    font-size: 10px;
    color: var(--fv-muted);
  }
  .x:hover {
    color: var(--fv-danger);
  }
  .add {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--fv-border);
  }
  .add-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--fv-muted);
  }
  .add label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: var(--fv-muted);
  }
  .add input {
    min-width: 0;
    font-size: 13px;
  }
  .add small {
    font-size: 11.5px;
    color: var(--fv-faint);
    line-height: 1.4;
  }
  .add button {
    align-self: flex-end;
  }
  .empty {
    color: var(--fv-faint);
    font-size: 12.5px;
    padding: 8px 0;
  }
</style>
