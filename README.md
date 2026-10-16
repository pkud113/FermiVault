# FermiVault

Fast, local-first Markdown notes that your AI apps can work with natively.

- **Plain files.** A vault is any folder of `.md` files. Nothing proprietary; app state lives in `<vault>/.fermi/` and can be deleted at any time.
- **Fast.** Rust core + native webview (Tauri 2), SQLite FTS5 search, incremental indexing off the UI thread.
- **AI-native.** A built-in [MCP](https://modelcontextprotocol.io) server lets Claude Desktop, Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI and LM Studio search, read and edit your vault. Connect any of them with one click from the **AI apps** panel. Every agent edit is snapshotted so it can be undone.

## Download

Get the latest Windows installer from [**Releases**](https://github.com/pkud113/FermiVault/releases/latest): download `FermiVault_x.y.z_x64-setup.exe` and run it. No admin rights are needed; it installs for your user and adds a Start menu entry. Then pick any folder as your vault.

The installer isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Choose **More info → Run anyway**. macOS and Linux builds will follow; until then, build from source (below).

## Features

- Live-preview Markdown editor (CodeMirror 6) with source mode, `[[wikilinks]]` + autocomplete, formatting shortcuts, code highlighting
- Callouts (`> [!tip]`), task checkboxes (`Ctrl+L`), KaTeX math (`$…$`, `$$…$$`), Mermaid diagrams
- Embeds: `![[image.png|300]]`, `![[note]]`, `![[note#Section]]` (transclusion), PDFs, audio and video
- Graph view (global, `Alt+G`, and per-note local graph), tags pane, backlinks, outline
- Daily notes (`Ctrl+Shift+D`), templates with `{{title}}`/`{{date}}`/`{{time}}` (`Ctrl+Shift+T`), bookmarks
- File recovery: automatic snapshots (every 5 minutes while editing, before every AI-agent change), restore any version
- Vim key bindings (Settings, or "Toggle Vim key bindings"), loaded only when turned on
- Tabs and split panes, quick switcher (`Ctrl+O`), command palette (`Ctrl+P`), full-text search
- Link-safe rename/move (every `[[link]]` and `[x](note.md)` is rewritten)
- **Properties** (YAML frontmatter) edited in the right panel, with text, list, date and checkbox fields
- **Tables of notes**: a ```` ```table ```` block lists notes by tag or folder, filtered and sorted by their properties, live (see *Project board* in `fixtures/test-vault`)
- Image, PDF, audio and video viewers; file tree with drag-and-drop; trash instead of delete; light/dark themes
- Live reload when files change on disk (external editors, sync tools, agents)

Heavy renderers (KaTeX, Mermaid, the graph) load only when a note first needs them, so they never slow startup.

## AI inside the app

- **Semantic + hybrid search.** Search ranks notes by keywords (BM25) and meaning together. Meaning comes from a local [Model2Vec](https://github.com/MinishLab/model2vec) model (`potion-base-8M`, ~30 MB, CPU-only, downloaded once from Settings → AI). Indexing runs in the background and re-embeds only paragraphs that changed.
- **Chat with your notes** (`Ctrl+J`). Answers are grounded in the most relevant passages and cite them; citations link to the source note.
- **Inline writing commands**: improve writing, fix spelling and grammar, summarize, continue writing (`Ctrl+Shift+Enter`). Results stream into the editor and undo with `Ctrl+Z`.
- **Related notes** with one-click linking, in the Backlinks panel.
- **Any model.** Chat and writing use any OpenAI-compatible server. Ollama, LM Studio and llama.cpp are detected automatically on localhost; hosted APIs work with a key stored in the OS keychain.

AI apps connected over MCP get the same hybrid `search` plus a `related` tool.

## Tables

````markdown
```table
from: #project, work/        (tags and/or folders; leave out for all notes)
where: status != done        (one condition per line: = != < <= > >= contains exists missing)
where: due < 2026-12-01
sort: due desc
columns: file, status, due
limit: 50
```
````

Fields are any property plus `file`, `path`, `folder`, `modified` and `tags`. Numbers compare as numbers, everything else as text, so ISO dates sort correctly. Agents use the same syntax through the MCP `query` tool.

## MCP tools

`search`, `read_note` (whole note or one section), `list_notes`, `recent_changes`, `links`, `related`, `query` (notes by properties and tags, as a table), `tags`, `create_note`, `edit_note` (`append` / `str_replace` / `replace_section` / `replace`), `rename_note`.

Run it manually:

```bash
fermivault mcp --vault /path/to/vault
```

## Privacy

- Your vault never leaves your computer unless you send it somewhere: chat and writing go only to the model server you pick in Settings → AI. Plain `http` is allowed only on your computer or local network, and API keys are only sent over `https` (or to your own computer).
- Images from the web in notes and AI answers wait for a click, so opening a note never contacts another server. Turn on *Load web images automatically* in Settings if you prefer.
- The semantic search model is downloaded once, on request, from a pinned Hugging Face revision and checked against its SHA-256.
- Security issues: see [SECURITY.md](SECURITY.md).

## Develop

Requirements: Rust (stable), Node 20+, pnpm, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test
```

`fixtures/test-vault` is a small vault for trying things out.

## License

MIT
