# Changelog

## 0.2.3 (2026-10-19)

### Changed
- The license and package metadata now name the author, Pardhu Kudumula. No other changes from 0.2.2.

## 0.2.2 (2026-10-18)

### Changed
- New app icon: the FermiVault F with sharp beveled arms, on every platform and on the welcome screen.

## 0.2.1 (2026-10-17)

Fixes from an independent review of 0.2.0, and signed Windows installers.

### Fixed
- Hiding the left sidebar no longer collapses the editor area; every sidebar combination keeps the panes in place.
- The graph redraws to fit when panes are split, sidebars resized or panes closed, instead of drawing over the next pane.
- The outline, properties and word count always belong to the file you're looking at, never to a note you left.
- Search shows only the newest query's results, and reports failures (with Retry) instead of showing "0 results".

### Improved
- **Save status:** tabs with unsaved edits show a dot, and the footer shows Unsaved changes / Saving… / Saved. If a save fails, it stays marked, with Retry, until it succeeds.
- **Graph:** clearer links, Zoom and Fit buttons, a "Loading graph…" state, and a keyboard-friendly list of notes and their links.
- **Settings** has sections (General, Editor, AI, Vault, Sync, Plugins), and its title and Close button stay in view.
- **Properties:** labelled fields that fit the side panel. In live preview the YAML block collapses to one line until you move into it.
- Shortcuts are shown in your keyboard's language (German Strg, French Maj, Spanish Mayús, ⌘ on macOS), and the last English strings in the translations are fixed.
- The live preview toggle appears only for notes, and the graph tab is labelled "Graph".
- **Windows:** installers and the app are signed by Pardhu Kudumula through Microsoft Azure Artifact Signing. See [docs/INSTALLATION.md](docs/INSTALLATION.md).

## 0.2.0 (2026-10-16)

FermiVault now runs on Windows, macOS and Linux.

### New
- **macOS and Linux.** Universal `.dmg` for Apple silicon and Intel Macs; AppImage, `.deb` and `.rpm` for Linux.
- **Properties.** Edit a note's YAML frontmatter in the right panel, with text, list, date and checkbox fields.
- **Tables of notes.** A ```` ```table ```` block lists notes by tag or folder, filtered and sorted by their properties, and updates live. AI apps get the same thing as the MCP `query` tool.
- **Canvas.** Boards of text cards, notes, images, links and groups with arrows, saved as open [JSON Canvas](https://jsoncanvas.org) files.
- **Web clipper.** *Clip web page as a note* saves a page's article as Markdown, with its title, author, date and source as properties.
- **Git sync.** Version history and sync through any Git host, by hand or on a timer. If a note changed on both sides, nothing is lost: your version stays and the other is saved next to it as a "(conflict …)" copy.
- **Plugins.** Add commands and automate your vault in JavaScript. Plugins run in a sandbox with no network access and only the permissions you approve. See [docs/PLUGINS.md](docs/PLUGINS.md).
- **Vim key bindings**, loaded only when you turn them on.
- **Español, Français and Deutsch.** The interface follows your system language, or pick one in Settings.

### Improved
- Saving is more reliable: edits survive failed saves, renames and switching vaults, and a note changed by another app or an AI agent while you edit it is never silently overwritten (the other version is kept in File recovery).
- Inline AI writing always lands in the note and place it started in, even if you keep typing.
- Keyboard navigation, screen-reader labels and contrast, and layouts for narrow windows.
- Safer handling of file paths, AI server connections, web images and the semantic search model download.
- Plugin approvals and Git setup are stored on your computer, not in the vault, so a vault someone shares with you opens with its plugins off.
- Faster startup: the editor loads right after the window appears instead of before it, cutting the JavaScript loaded at startup from 840 KB to 200 KB, and your last vault starts opening while the window is still loading.
- The graph view is readable in small vaults (nodes were drawn far too large).
- Canvas note cards and `![[note]]` embeds no longer show the note's properties block.

### Performance
CI now checks every change against the performance budgets on a 10,000-note vault: cold start, idle memory, search, the quick switcher and installer size. See [CONTRIBUTING.md](CONTRIBUTING.md#performance-budgets).

## 0.1.0 (2026-10-14)

First public release, for Windows: live-preview Markdown editor, hybrid full-text and semantic search, backlinks, graph view, daily notes, templates, file recovery, chat with your notes, inline AI writing, and a built-in MCP server for Claude, Codex, Cursor and other AI apps.
