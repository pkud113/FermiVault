# Contributing to FermiVault

Thanks for helping. Bug reports, fixes, translations and plugins are all welcome.

## Reporting

- **Bugs and ideas:** open an issue. For a bug, include your OS, the FermiVault version (Settings), and steps to reproduce. A small vault that shows the problem helps most.
- **Security problems:** don't open an issue. Report them privately as described in [SECURITY.md](SECURITY.md).

## Building

You need Rust (stable), Node 24, pnpm and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm tauri dev
```

`fixtures/test-vault` is a small vault with every feature in it. Open it from the welcome screen.

Building Rust inside a synced folder (OneDrive, Dropbox) is slow. Point `CARGO_TARGET_DIR` at a folder outside it.

## Layout

| Path | What's there |
|---|---|
| `src-tauri/src/vault.rs` | File access. `Vault::abs` is the boundary every path from the UI, agents and plugins goes through |
| `src-tauri/src/index.rs`, `parse.rs`, `query.rs` | SQLite index: notes, links, tags, properties, full-text search, ```` ```table ```` queries |
| `src-tauri/src/semantic.rs`, `embed.rs` | Local embeddings and hybrid search |
| `src-tauri/src/mcp.rs`, `connect.rs` | The MCP server (`fermivault mcp --vault …`) and the AI apps panel |
| `src-tauri/src/ai.rs` | In-app chat and writing, against any OpenAI-compatible server |
| `src-tauri/src/git.rs`, `clip.rs`, `plugins.rs` | Git sync, web clipper downloads, plugin loading |
| `src/lib/` | Svelte 5 UI. `store.svelte.ts` holds app state; `docs.ts` holds the save rules |
| `src/lib/locales/` | Translations (see [docs/TRANSLATING.md](docs/TRANSLATING.md)) |

## Before you open a pull request

```bash
pnpm check
pnpm test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs the same checks on Windows, macOS and Linux, plus the performance budgets below.

- Keep a pull request to one change, and add a test when you fix a bug.
- Follow the code around you. Prefer the standard library and existing dependencies to new ones; every dependency ships to every user.
- Write user-facing text with `t("…")` (see [docs/TRANSLATING.md](docs/TRANSLATING.md)). English strings are the keys.
- By contributing, you agree that your work is released under the [MIT License](LICENSE).

## Performance budgets

FermiVault has to stay fast as it grows. CI measures these on a 10,000-note vault, on Windows:

| Budget | Limit | Checked by |
|---|---|---|
| Cold start to vault shown | 400 ms on a typical PC (see below) | `scripts/bench-startup.ps1` |
| Idle memory (app + WebView2) | 150 MB | `scripts/bench-startup.ps1` |
| Full-text query | 30 ms | `src-tauri/tests/budgets.rs` |
| Quick switcher | 50 ms | `tests/budgets.test.ts` |
| Installer | 15 MB | `.github/workflows/ci.yml` |
| JavaScript loaded before the first frame | 300 KB | `scripts/startup-size.mjs` |

CI's virtual machines have no GPU, and WebView2 alone takes about 400 ms to start there, before any FermiVault code runs. So for cold start, CI reports the time against the 400 ms target, splits out the part FermiVault controls, and fails only above 1000 ms. That still catches real regressions, such as startup waiting on indexing or loading a heavy library.

To run the search budget locally:

```bash
node scripts/bench-vault.mjs "$HOME/bench-vault"
FERMIVAULT_BENCH_VAULT="$HOME/bench-vault" cargo test --manifest-path src-tauri/Cargo.toml --profile budgets --test budgets -- --ignored --nocapture
```

Rules that keep it fast:
- Nothing slow runs on the UI thread. Indexing, embeddings, Git and AI run in the background.
- Heavy features (Mermaid, KaTeX, the graph, Canvas, Vim, the web clipper, translations) load the first time they're used, not at startup.

## Plugins and translations

- Write a plugin: [docs/PLUGINS.md](docs/PLUGINS.md)
- Add or fix a language: [docs/TRANSLATING.md](docs/TRANSLATING.md)

## Releases

Maintainers bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, add the changes to `CHANGELOG.md`, and push a `vX.Y.Z` tag. The Release workflow builds the installers into a draft GitHub release, which is published once the installers are checked.
