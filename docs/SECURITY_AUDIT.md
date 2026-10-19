# FermiVault Security and Reliability Audit

**Review date:** October 15, 2026 (America/New_York)  
**Audited revision:** `3fecefa7619707dc955e7947aed0ce7dd2265f79` (`main`)  
**Status:** Working report; final validation and remaining coverage reconciliation are in progress.  
**Resolution (October 15, 2026):** every finding below is fixed on `main` ([#1](https://github.com/pkud113/FermiVault/pull/1), [#2](https://github.com/pkud113/FermiVault/pull/2), [#3](https://github.com/pkud113/FermiVault/pull/3), [#4](https://github.com/pkud113/FermiVault/pull/4), [#5](https://github.com/pkud113/FermiVault/pull/5)), each with regression tests. Fixes were checked against this report by the maintainer; there was no separate independent re-verification. The v0.1.0 installer predates the fixes.  
**Reviewer:** AI-assisted security and QA review (OpenAI Codex). The review itself made no implementation changes.

This is the audit report for FermiVault, kept as ordinary repository Markdown. Findings below refer to the audited revision, not to hypothetical future features.

## Executive assessment

The current implementation has confirmed vault-confinement failures and multiple data-loss paths. Resolve the filesystem boundary and editor persistence/lifecycle issues before building the next feature phase. Passing the existing tests does not establish these properties: all 14 existing Rust tests pass, and the frontend typecheck reports zero errors/warnings, while targeted probes reproduce the failures described below.

Security severity considers attacker prerequisites and the local, single-user deployment. Reliability severity considers routine user actions, data loss, and recoverability. There is no confirmed critical vulnerability or demonstrated remote code execution in this review.

## Findings at a glance

| ID | Severity | Area | Finding | Validation | Status |
| --- | --- | --- | --- | --- | --- |
| S1 | Medium | Security | Windows internal drive components discard the vault root | Windows Rust runtime probe + source trace | Fixed in [#1](https://github.com/pkud113/FermiVault/pull/1) |
| S2 | Medium | Security | Symlinks/junctions route reads and writes outside the vault | Source confirmed; filesystem reproduction pending | Fixed in [#1](https://github.com/pkud113/FermiVault/pull/1) |
| S3 | Medium | Security | Non-loopback HTTP AI endpoints send notes and keys without TLS | Source confirmed; conditional configuration | Fixed in [#5](https://github.com/pkud113/FermiVault/pull/5) |
| S4 | Low | Security/availability | Malformed image URL can break preview construction | Source confirmed; renderer probe pending | Fixed in [#5](https://github.com/pkud113/FermiVault/pull/5) |
| S5 | Low | Privacy | Untrusted Markdown automatically contacts external image hosts | Source confirmed; CSP permits HTTPS images | Fixed in [#5](https://github.com/pkud113/FermiVault/pull/5) |
| R1 | High | Data integrity | Failed saves are treated as successful and never retried | Extracted production-function probe | Fixed in [#2](https://github.com/pkud113/FermiVault/pull/2) |
| R2 | High | Data integrity | Pending editor saves can write into a newly selected vault | Source trace + mocked lifecycle probe | Fixed in [#2](https://github.com/pkud113/FermiVault/pull/2) |
| R3 | High | Data integrity | Renaming/trashing a dirty note can recreate its old path | Extracted production-function probe | Fixed in [#2](https://github.com/pkud113/FermiVault/pull/2) |
| R4 | High | Data integrity | Pending/failed reads leave the old document bound to the new path | Extracted production-function probe | Fixed in [#2](https://github.com/pkud113/FermiVault/pull/2) |
| R5 | High | Data integrity | Concurrent file edits have no conflict detection | Source confirmed; interleaving reproduction pending | Fixed in [#3](https://github.com/pkud113/FermiVault/pull/3) |
| R6 | High | Data integrity | Inline AI output is not bound to the initiating document/range | Source confirmed; stream probe pending | Fixed in [#4](https://github.com/pkud113/FermiVault/pull/4) |

## Security findings

### S1 — Windows drive components bypass vault confinement

**Status: fixed in [#1](https://github.com/pkud113/FermiVault/pull/1).** Regression tests: `vault::tests::platform_path_tricks_rejected`; MCP drive-relative `create_note`/`read_note` in `mcp::tests::protocol_and_tools`.

**Severity:** Medium. **Confidence:** High. **CWE:** CWE-23.

**Evidence:** `src-tauri/src/vault.rs:80-94`, especially line 85; file sinks at `139-158`, `243-264`; MCP paths at `src-tauri/src/mcp.rs:95-100`, `196-238`.

`Vault::abs()` splits the original input into components, accepts a `Normal` component, and pushes it into a `PathBuf`. On Windows, an internal component such as `C:outside.md` is normal in the original input but becomes a drive prefix when pushed by itself. That push discards the accumulated vault root. A native Windows probe of this exact reconstruction returned `Ok("C:outside.md")` for `safe/C:outside.md`; the result is drive-relative rather than rooted inside the vault. Ordinary `../outside.md` was rejected as expected.

**Reachability/impact:** An MCP caller controls note paths. If its process working directory on that drive is outside the selected vault, reads, creation, edits, and renames can affect external Markdown files accessible to the application account. The MCP `.md` suffix limits some targets but does not preserve confinement. This is a real scope escalation from vault access; it is not evidence of an internet-facing server or administrator access.

**Recommendation:** Validate Windows components as standalone paths; reject colons, prefixes, device forms and unsupported special names. Require the assembled path to remain absolute and under the expected root. Couple lexical checks with the filesystem-link protections in S2.

**Regression requirements:** Windows tests for internal `C:`, `C:.fermi`, mixed slash/backslash, UNC/device paths, and ordinary valid nested paths. Exercise real MCP `read_note` and `create_note` with a process working directory different from the vault and require rejection without touching an outside sentinel.

### S2 — Filesystem links escape the vault boundary

**Status: fixed in [#1](https://github.com/pkud113/FermiVault/pull/1).** Regression tests: `vault::tests::links_are_not_followed` (junction/symlink, looping link, file link when the OS allows, nothing indexed or searchable), `vault::tests::linked_dot_folder_rejected`. Remaining limit: a link swapped in between the check and the file operation (needs handle-relative IO); documented in `Vault::abs`.

**Severity:** Medium. **Confidence:** High. **CWE:** CWE-59.

**Evidence:** `src-tauri/src/vault.rs:59-75`, `80-94`, `111-123`, `139-151`; indexing follows the same files at `src-tauri/src/index.rs:101-108`.

The vault root is canonicalized once, but descendants are checked lexically. Enumeration uses `path.is_dir()` and recurses through directory links. Reads follow file links; writes and directory creation follow linked parents. The internal `.fermi` directory is also used without rejecting a junction/symlink.

**Reachability/impact:** An imported or shared vault that preserves attacker-created links can expose readable external Markdown to search/MCP and route creation or updates outside the vault. A cyclic directory link can also make enumeration unbounded. A `.fermi` link redirects internal database/configuration/snapshot staging. Ordinary Markdown text alone cannot create this prerequisite.

**Recommendation:** Define an explicit link policy. Prefer rejecting symlinks and Windows reparse points for both visible files and `.fermi`. Use race-resistant directory-relative/no-follow access where possible; canonicalizing a path once before opening it is insufficient against link swaps. Track directory identities and bound recursion.

**Regression requirements:** File symlink, directory junction, ancestor link, linked `.fermi`, cyclic link, and link-swap tests. Assert no external reads, writes, indexing, or recursive expansion.

### S3 — Remote HTTP AI endpoints expose private content and credentials

**Status: fixed in [#5](https://github.com/pkud113/FermiVault/pull/5).** Regression tests: `ai::tests::endpoint_rules`, `ai::tests::redirects_are_not_followed`. Deliberate difference: plain `http` is also allowed on the local network (private/link-local IPs, `.local` and single-label names) so a model server on another home PC works, but API keys are only sent over https or to this computer.

**Severity:** Medium. **Confidence:** High. **CWE:** CWE-319.

**Evidence:** `src/lib/AiSettings.svelte:92-95`; `src-tauri/src/ai.rs:25-27`, `60-72`, `106-111`; `src/lib/ai.svelte.ts:79-89`.

The UI accepts a custom base URL. Native code trims it, appends API routes, and attaches the associated Bearer key and message body without requiring HTTPS. A configured LAN/remote `http://` server therefore receives credentials, retrieved note passages, questions and history in cleartext.

**Prerequisite/impact:** This requires a non-loopback HTTP configuration and a network observer/intermediary. The automatically detected loopback servers intentionally use HTTP; ordinary HTTPS endpoints receive the HTTP client's TLS protection. No real provider or credential was contacted during this audit.

**Recommendation:** Parse URLs centrally and require HTTPS outside verified loopback. If remote cleartext access is retained, require an explicit, informed opt-in before sending keys or note content. Reject URL userinfo and avoid silently weakening transport on redirects.

**Regression requirements:** Accept loopback HTTP and remote HTTPS; reject remote HTTP and deceptive loopback hostnames. Test redirects and credential handling using disposable mock credentials only.

### S4 — Invalid image escapes can abort note preview

**Status: fixed in [#5](https://github.com/pkud113/FermiVault/pull/5).** Regression tests: `tests/widgets.test.ts` (malformed and invalid-UTF-8 escapes).

**Severity:** Low. **Confidence:** High. **CWE:** CWE-248.

**Evidence:** `src/lib/widgets.ts:221-228`, `282-291`; `src/lib/Editor.svelte:73-77`; `src/lib/Chat.svelte:35-44`.

`decodeURI()` is called on untrusted Markdown image URLs without a catch. Inputs such as `![x](%ZZ)` throw during widget state creation/update. The same renderer handles notes, transclusions and completed AI answers. Source mode provides a possible recovery route; this is not demonstrated XSS or code execution.

**Recommendation:** Decode defensively and retain literal Markdown or an error placeholder for an invalid widget. A single widget failure must not invalidate the editor.

**Regression requirements:** Incomplete percent escapes and invalid UTF-8 escapes during opening, typing, transclusion, chat completion and source/preview switching.

### S5 — External images disclose viewing activity without a click

**Status: fixed in [#5](https://github.com/pkud113/FermiVault/pull/5).** Regression tests: `tests/widgets.test.ts` (only http(s) images count as web images). Web images in notes and AI answers wait for a click unless *Load web images automatically* is on; loaded images send no referrer. The click-to-load widget itself is DOM code and not unit-tested.

**Severity:** Low. **Confidence:** High. **CWE:** CWE-200.

**Evidence:** `src/lib/widgets.ts:60-63`, `225-228`; `src/lib/Chat.svelte:35-44`, `73-74`; `src-tauri/tauri.conf.json:23`.

Rendering an HTTPS Markdown image assigns the author-controlled URL directly to `img.src`; production CSP permits arbitrary HTTPS image origins. Opening a shared note or rendering a model answer can contact a third party, revealing network address, timing and a unique URL marker. Arbitrary vault-content exfiltration through prompt injection was not established and is not claimed here.

**Recommendation:** Block external resources by default for untrusted notes and AI answers, offer per-origin/per-note loading controls, and use a no-referrer policy when enabled. Make the behavior visible in privacy documentation.

**Regression requirements:** Rendering an untrusted note/AI answer causes no network request until authorized; opted-in origins load correctly; reopening preserves the selected policy.

## Reliability and data-loss findings

### R1 — Failed writes clear dirty state

**Status: fixed in [#2](https://github.com/pkud113/FermiVault/pull/2).** Regression tests: `tests/docs.test.ts`: failed write retried without further typing; out-of-order saves.

**Severity:** High. **Confidence:** High.

**Evidence:** `src/lib/Editor.svelte:40-48`.

`save()` assigns `saved = text` before `api.write()` succeeds. Its catch only displays an error. Later saves see identical text and skip the write. Switching tabs/closing the editor can discard the only remaining edited copy. A targeted harness extracted and executed the production functions: after a rejected write, calling `save()` again made no second attempt (`writes: 1`, `saved: UNSAVED`).

**Recommendation:** Advance the acknowledged baseline only after success; retain dirty content and a persistent retryable error. Serialize writes per document and prevent stale acknowledgements from clearing newer edits. Await flushes before destructive lifecycle changes.

**Regression requirements:** Disk denied/full, snapshot failure, retry without further typing, out-of-order save completions, and close/switch with a failed pending write.

### R2 — Switching vaults can flush old notes into the new vault

**Status: fixed in [#2](https://github.com/pkud113/FermiVault/pull/2).** Regression tests: `tests/docs.test.ts`: a save pending across a vault switch, closed-vault notes never written; the backend also refuses writes for a vault that is no longer open.

**Severity:** High. **Confidence:** High for source ordering; full desktop lifecycle reproduction remains outstanding.

**Evidence:** `src/lib/store.svelte.ts:76-82`; `src-tauri/src/lib.rs:106-111`, `130-135`; `src/lib/Editor.svelte:114-116`; `src/lib/api.ts:21`.

`openVault()` first switches the native global vault, then clears the old panes. Editor teardown calls `save()`, whose request includes only a relative path and content, not vault identity. A pending old editor flush therefore resolves against the new backend vault. With a same-named destination note it overwrites that note; otherwise it creates a copy in the wrong vault. A mocked lifecycle probe captured `PRIVATE A` replacing the new vault's `B original`.

**Recommendation:** Flush and await all old editors before switching. Bind every read/write/event/async completion to an immutable vault session and document identity; reject stale sessions in Rust. Stop AI streams and retire old view references before switching.

**Regression requirements:** Two vaults with the same note path and different content; switch with dirty/pending/failed saves and streaming AI. Assert neither cross-vault writes nor late-event mutation.

### R3 — Rename/trash runs before pending editor content is flushed

**Status: fixed in [#2](https://github.com/pkud113/FermiVault/pull/2).** Regression tests: `tests/docs.test.ts`: saves before/after a rename, trashed notes never written, rename during a load.

**Severity:** High. **Confidence:** High.

**Evidence:** `src/lib/store.svelte.ts:208-212`, `227-232`; `src/lib/Editor.svelte:59-66`, `114-116`; `src-tauri/src/vault.rs:144-151`.

Rename/move updates disk first, then changes the tab path. The editor's subsequent `load(newPath)` calls `save()` using the old path. With an unsaved buffer this recreates the old file, while the moved file retains stale disk content. Trash similarly closes the tab only after moving its file, and teardown can recreate the trashed path. The production-function harness reproduced both outcomes.

**Recommendation:** Flush relevant editors before rename/trash and await success. Suspend autosave during committed path transitions, update document identity atomically, and cancel saves for successfully deleted documents. Handle all panes showing the affected path or directory.

**Regression requirements:** Dirty file rename, directory move, trash, two panes on one note, delayed saves and failed rename/trash. Verify the old path is not recreated and the moved/trash version contains the latest acknowledged text.

### R4 — Loading a note relabels the previous buffer before reading succeeds

**Status: fixed in [#2](https://github.com/pkud113/FermiVault/pull/2).** Regression tests: `tests/docs.test.ts`: nothing bound until loaded, failed load binds nothing, rapid A→B→A.

**Severity:** High. **Confidence:** High.

**Evidence:** `src/lib/Editor.svelte:59-80`, `99-106`.

`load(p)` sets `current = p` while the view still contains the previous note. The old buffer remains editable during the read; a failure leaves it in place indefinitely. Typing or teardown then saves that buffer to `p`. The extracted-function probe reproduced a write to `missing.md` containing the previous note's edited text. A successful later read can also discard typing performed while it was pending.

**Recommendation:** Keep identity and buffer paired until a successful load commits; make loading/error states noneditable or retain an explicit previous-document binding. Use request generations, not path equality alone, for stale reads and same-path reopen races.

**Regression requirements:** Delayed and failed reads, typing while loading, rapid A→B→A navigation, close while loading and stale responses.

### R5 — Atomic replacement does not prevent concurrent lost updates

**Status: fixed in [#3](https://github.com/pkud113/FermiVault/pull/3).** Regression tests: `mcp::tests::concurrent_agents_lose_no_edits`, `mcp::tests::rename_during_edits_loses_nothing`, `vault::tests::save_keeps_the_other_version_on_conflict`, `vault::tests::create_never_overwrites`, `tests/docs.test.ts` (base text and conflict report). Conflicting app saves keep both versions (the other one goes to File recovery and the user is told) rather than refusing the save.

**Severity:** High. **Confidence:** High for the missing control; schedule reproduction pending.

**Evidence:** `src-tauri/src/mcp.rs:203-232`; `src-tauri/src/vault.rs:144-158`; `src/lib/Editor.svelte:83-91`; SQLite locking at `src-tauri/src/index.rs:56-60`, `122-128`.

MCP edits read a note, derive a new body, then snapshot and replace it without an expected revision or a per-note transaction shared by writers. Two agents can both read version A and successively replace it, losing the first edit. GUI autosave can likewise overwrite a newer external edit. SQLite WAL/transactions protect the index, not the Markdown read-modify-write sequence. `create()` separately checks existence then calls an overwrite-capable write, so concurrent creators can both succeed.

**Recommendation:** Add revision/hash-based conditional updates with a shared cross-process write lock covering read/compare/snapshot/replace; provide conflict handling to GUI/MCP. Use atomic no-overwrite creation rather than check-then-write. Preserve both versions when conflicts occur.

**Regression requirements:** Deterministic barriers for two appenders, two creators, GUI/MCP collisions, stale full replacements and rename-versus-edit. Require one explicit conflict or a merge preserving both edits, never silent loss.

### R6 — Inline AI deltas can corrupt a different note or stale range

**Status: fixed in [#4](https://github.com/pkud113/FermiVault/pull/4).** Regression tests: `tests/inline.test.ts`: one-step undo, typing above the insertion point, editing inside the output, partial failure, output into a background note.

**Severity:** High. **Confidence:** High for source trace; stream probe pending.

**Evidence:** `src/lib/ai.svelte.ts:49-75`; `src/lib/Editor.svelte:73-76`, `114-116`.

Inline writing captures an `EditorView`, selection and numeric positions. Tabs reuse that same view with a different document state; streaming callbacks continue dispatching to it. There is no check that the document/vault still matches, no transaction mapping for positions after user edits, and no teardown cancellation. Switching notes mid-stream can insert/replace generated text in the next note; editing before the selection can target the wrong range or throw.

**Recommendation:** Bind streams to a document/vault generation, cancel or buffer output when its owner changes, and map positions through transactions. Use a preview/accept transaction where appropriate; ensure one undo restores the complete original selection.

**Regression requirements:** Switch/close tabs or vaults mid-stream, edit before/inside the range, undo during streaming, and provider failure after a partial replacement.

## Additional fixes found during remediation

- **Index open race:** concurrent first opens of a fresh vault's index could fail with `database is locked`, silently skipping the initial index build. Fixed in [#3](https://github.com/pkud113/FermiVault/pull/3) (`index::tests::concurrent_first_opens`).
- **Unpinned model download:** the embedding model is now downloaded from a pinned Hugging Face revision and each file is checked against its SHA-256. Fixed in [#5](https://github.com/pkud113/FermiVault/pull/5).
- **Reporting policy:** `SECURITY.md` added (private vulnerability reporting enabled on the repository) in [#5](https://github.com/pkud113/FermiVault/pull/5).

## Verification so far

- Existing Rust suite, disposable source copy, `cargo test --offline --locked --manifest-path src-tauri/Cargo.toml`: **14 passed, 0 failed**. The initial sandbox build hit an MSVC access-denied error; the authorized retry passed.
- Frontend `pnpm check` in disposable source copy: **0 errors, 0 warnings**. Dependency paths were linked to the installed local dependencies. The installed pnpm wrapper attempted a pre-run verification; no dependency manifest changes were accepted into the repository.
- Production frontend build: first attempt hit sandbox dependency-realpath restrictions; authorized retry is in progress.
- Five frontend lifecycle probes passed their diagnostic expectations, using extracted production functions with mocked filesystem/IPC and editor state. These establish function behavior, not a full Tauri UI integration test.
- Native Windows path reconstruction probe confirmed internal drive-prefix reset; normal parent traversal was rejected.

All application execution uses disposable source copies and synthetic vault data. No real vault was edited, real API credential read/used, model downloaded, client configuration changed, issue posted, or fix implemented.

## Scope and known limits

An independent baseline reviewer fully read every first-party Rust/frontend implementation file and text configuration/fixture. A separate architecture review mapped storage, IPC, asset serving, AI requests, credentials, client registrations and concurrency. Each finding was checked against the source and relevant tests were run.

This is current-source review, not a guarantee that published installers match it. Dependency lockfiles were inspected/searched but a fresh external advisory audit, published installer verification, macOS/Linux execution, full desktop UI automation, real-provider integration, power-loss tests and large-vault benchmarking have not been performed. Binary icons/PDF fixtures were not audited as parser implementations.

Useful existing controls include parameterized SQL, strict Mermaid rendering, escaped search snippets, no enabled KaTeX trust, bounded transclusion depth, production script CSP, limited default URL opener schemes, OS keyring use and a stdio-only MCP transport. None substitutes for the broken filesystem and persistence controls above.
