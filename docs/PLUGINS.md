# Writing FermiVault plugins

A plugin is a folder in a vault's `.fermi/plugins/` with two files:

```text
<vault>/.fermi/plugins/word-stats/
  manifest.json
  main.js
```

The folder name is the plugin's id. It may use letters, digits, `-` and `_`. After adding a folder, open **Settings → Plugins**, press **Reload list**, and turn the plugin on. FermiVault shows which permissions the plugin asks for before enabling it.

A complete example is in [`docs/plugins/word-stats`](plugins/word-stats).

## manifest.json

```json
{
  "name": "Word stats",
  "version": "1.0.0",
  "description": "Counts the words in your vault.",
  "author": "You",
  "permissions": ["read", "editor"]
}
```

| Permission | Allows |
| --- | --- |
| *(none)* | Adding commands, showing messages, asking the user for text, listening to events |
| `read` | `fermi.vault.list/read/search/query/backlinks` |
| `write` | `fermi.vault.create/write/append`. Every change is snapshotted first, so the user can undo it from File recovery |
| `editor` | `fermi.editor.selection/replaceSelection/insert` on the note that's open |

The user approves the permissions when turning the plugin on. If a later version asks for more, it keeps only what was approved until the user turns it off and on again.

## The sandbox

`main.js` runs in its own Web Worker, so:

- **No access to the page or the app.** There's no DOM. The app's internal commands need a key that only the main window has.
- **No network.** The app's Content Security Policy blocks `fetch`, `XMLHttpRequest` and WebSockets, and it doesn't allow scripts from other origins.
- **Only `fermi`.** Everything goes through the global `fermi` object. Each call is a message the app checks against your permissions, and every argument arrives as text.

A plugin that throws or loops only affects its own worker. Turning it off stops the worker.

## API

All calls return promises.

```js
fermi.manifest                       // your manifest.json, plus `id`
fermi.notice(text)                   // shows a message
fermi.prompt(title, value?)          // asks for text; resolves to a string or null

fermi.commands.add({ id, name }, async () => { ... })   // appears in the command palette as "Plugin name: name"
fermi.on("file-open", ({ path }) => { ... })            // a note or file was opened
fermi.on("vault-change", ({ paths }) => { ... })        // files changed on disk

// permission "read"
fermi.vault.list()                   // every file path in the vault
fermi.vault.read(path)               // a note's text
fermi.vault.search(query)            // [{ path, snippet }], ranked by keywords and meaning
fermi.vault.query(table)             // the ```table``` query language: { columns, rows: [{ path, cells }], total }
fermi.vault.backlinks(path)          // [{ path, line, context }]

// permission "write" (notes only: paths ending in .md)
fermi.vault.create(path, text)       // fails if it exists
fermi.vault.write(path, text)        // replaces the note (snapshotted first)
fermi.vault.append(path, text)

// permission "editor"
fermi.editor.selection()             // { path, text } or null
fermi.editor.replaceSelection(text)  // undoable with Ctrl+Z, like typing
fermi.editor.insert(text)            // at the cursor
```

Paths are relative to the vault root, use `/`, and can't reach outside the vault or into dot-folders.
