# Translating FermiVault

Interface text is translated with plain JSON files in [`src/lib/locales/`](../src/lib/locales). Each key is the English text, and each value is the translation:

```json
{
  "New note": "Nueva nota",
  "Couldn't save {path}: {error}. Your changes are kept and FermiVault keeps retrying.": "No se pudo guardar {path}: {error}. …"
}
```

- Keep every `{placeholder}` exactly as written. The app fills them in, for example with a file name or a count.
- Anything missing falls back to English, so a partial translation still works.
- `pnpm test` checks every locale. It lists strings that are missing, have different placeholders, or are no longer used.

## Adding a language

1. Copy `es.json` to `<code>.json`, using a two-letter code such as `it` or `pt`, and translate the values.
2. Add the language to `LANGUAGES` and `loaders` in `src/lib/i18n.svelte.ts`.
3. Run `pnpm test`.

## Adding UI text in code

Wrap it in `t("…")`, with `{name}` placeholders for values: `t("Synced {when}", { when })`. Text that's stored first and shown later (command names, tab labels) is marked with `tk("…")` where it's defined and passed through `t()` where it's shown. Then add the new strings to every locale.
