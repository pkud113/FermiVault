# FermiVault UI/UX Review

**Date:** October 15, 2026  
**Status:** Preliminary, source-based review. Native visual inspection is still pending.  
**Resolution (October 15, 2026):** UI-01 to UI-05 implemented in [#6](https://github.com/pkud113/FermiVault/pull/6). The live visual, OS-scaling and screen-reader review listed under *Required live review* has **not** been done yet.  
**Scope:** Colors, readability, layout, navigation, keyboard access, and implementation feasibility.  
**Baseline:** Original `main` at `3fecefa7619707dc955e7947aed0ce7dd2265f79`; relevant source rechecked at `5135c1be27881bba3b5521ce62df09d04bd1c0f5`.

## Read this first

This review contains source-confirmed issues and recommendations, not a completed screenshot-based visual audit. No native screens were inspected, and no screenshots or live usability results are claimed.

No UI implementation changes are included in this document. Keep this work separate from the ongoing security fixes, and preserve their behavior when changing the interface.

## Recommended direction

Retain the lightweight writing workspace and the existing neutral/purple token system as a starting point. Improve readability, hierarchy, discoverability, and narrow-window behavior before proposing a wholesale redesign. This is a design recommendation based on the source palette, not a judgment from viewing the running application.

## Priorities

| ID | Priority | Issue | Evidence level | Status |
| --- | --- | --- | --- | --- |
| UI-01 | High | Faint secondary text has insufficient contrast for ordinary text | Token calculation and actual source uses | Fixed in [#6](https://github.com/pkud113/FermiVault/pull/6) |
| UI-02 | High | Callout title colors need theme-specific contrast treatment | Source and calculated light-theme combinations | Fixed in [#6](https://github.com/pkud113/FermiVault/pull/6) |
| UI-03 | High | Fixed sidebars crowd the editor in narrow windows | Layout calculation; native resize validation pending | Fixed in [#6](https://github.com/pkud113/FermiVault/pull/6) |
| UI-04 | Medium | Settings and important controls need clearer discovery | Source-confirmed navigation structure | Fixed in [#6](https://github.com/pkud113/FermiVault/pull/6) |
| UI-05 | High | Dialog, tree, tab, and separator keyboard behavior needs completion | Source-confirmed missing handling; live testing pending | Fixed in [#6](https://github.com/pkud113/FermiVault/pull/6) |

Priorities represent usability impact and recommended order, not security severity.

### UI-01 — Improve secondary-text contrast

**Status: fixed in [#6](https://github.com/pkud113/FermiVault/pull/6).** Tokens rechecked on every surface each one is used on (editor, sidebar, hover, selected) in both themes; dark muted text brightened to keep the hierarchy. `tests/ui.test.ts` recomputes each pair from `src/app.css`.

**Locations:** `src/app.css` (`--fv-faint`, `--fv-bg`, `--fv-bg-2`); status bar and shortcut hints in `src/routes/+page.svelte`; settings helper text, search paths/counts, tag counts, graph empty states, and bookmark metadata in their respective components.

| Theme/surface | Foreground | Background | Calculated contrast |
| --- | --- | --- | --- |
| Light editor | `#8a8a92` | `#fbfbfa` | 3.31:1 |
| Light sidebar | `#8a8a92` | `#f3f3f1` | 3.08:1 |
| Dark editor | `#74747e` | `#17171a` | 3.87:1 |
| Dark sidebar | `#74747e` | `#1e1e22` | 3.59:1 |

These ratios are below the 4.5:1 minimum for normal text when those combinations are used for meaningful small labels. The existing muted-text tokens are substantially stronger: approximately 7.14:1 in light mode and 7.32:1 in dark mode on the editor background.

**Recommendation:** Introduce an accessible secondary-text token or strengthen `--fv-faint` wherever it carries information. Reserve lower contrast for genuinely decorative or inactive elements. Preserve hierarchy through size, weight, placement, and spacing rather than relying on faintness alone.

**Acceptance:** Check each actual text/background combination in both themes, including hover/selected states, helper text, shortcuts, source comments, and empty states. Do not infer whole-product accessibility compliance from token calculations alone.

### UI-02 — Give callouts theme-aware semantic colors

**Status: fixed in [#6](https://github.com/pkud113/FermiVault/pull/6).** Titles mix their colour toward the heading colour per theme (6.5:1 or better); labels unchanged. Covered by `tests/ui.test.ts`.

**Locations:** `src/app.css`, especially `.cm-callout`, `.cm-callout-title`, and the tip/warning/danger/info selectors.

Callout types use fixed colors shared by both themes. Titles use the same semantic color as their bar, over a 10% tint. At the default light background, approximate title contrast is:

- Tip/success: 2.99:1.
- Warning: 3.07:1.
- Danger/error: 3.77:1.
- Info: 3.59:1.

These are calculations from declared sRGB colors and alpha compositing, not screenshot measurements. Default-size callout titles are ordinary text for contrast purposes.

**Recommendation:** Separate callout foreground, surface, and border tokens per theme. A vivid border can coexist with a darker light-theme title or lighter dark-theme title. Retain text labels/icons so meaning does not depend on color alone.

**Acceptance:** Render each supported callout in light/dark themes with titles, no explicit title, nested Markdown, and keyboard focus. Verify title/body contrast against the actual composited surface.

### UI-03 — Protect the writing area at small window sizes

**Status: fixed in [#6](https://github.com/pkud113/FermiVault/pull/6).** Sidebars yield to a minimum editor width (380 px, 300 px per split pane); the sidebar opened last keeps its space; preferences return when the window widens; resizing is clamped. Layout rules in `src/lib/ui.ts`, covered by `tests/ui.test.ts`.

**Locations:** `src/routes/+page.svelte` (`leftW = 260`, `rightW = 280`, `resize()`, and `.shell`); `src-tauri/tauri.conf.json` (`minWidth: 640`).

The default sidebars consume 540 CSS pixels. At a roughly 640px client width, the editor receives only about 100px before internal padding. The grid retains both columns and no automatic narrow-layout collapse is present in this source. Multiple split panes divide the remaining space further. Users can manually hide the panels, but that does not establish a usable default at the configured minimum size.

**Recommendation:** Define a minimum usable editor width. Collapse or overlay secondary panels as needed; restore user preferences when sufficient space returns. Bound sidebar resizing against the current viewport. Keep panel toggles reachable and prevent an unusably narrow split configuration.

**Acceptance:** Inspect native windows at the configured minimum size, 800×600, 1024×768, and the default 1280×820, including increased OS scaling and larger editor fonts. Test both panels, one panel, no panels, split panes, long filenames, settings, and recovery dialogs. Verify no clipped primary controls or inaccessible content. The calculated risk still needs this live validation.

### UI-04 — Improve control discovery without crowding the editor

**Status: fixed in [#6](https://github.com/pkud113/FermiVault/pull/6).** Settings in the always-visible footer and the empty workspace; vault name switches vaults; distinct, labelled sidebar toggles and collapse-all icon.

**Locations:** `src/routes/+page.svelte` command definitions, sidebar switcher, empty workspace, and tab-strip panel toggles; `src/lib/FileTree.svelte`.

Settings is exposed through the command palette and `Ctrl+,`, with no persistent visible Settings entry in the inspected shell. Several actions depend on icon tooltips, shortcuts, or context menus. Left/right panel toggles use the same hamburger glyph, while the file-tree collapse action uses a different text glyph.

**Recommendation:** Add a stable Settings/menu entry; use consistent SVG icons and explicit accessible labels. Make left/right panel actions distinguishable. Keep keyboard shortcuts as accelerators and retain a useful command palette. Review onboarding/empty states for clear first actions, local-file ownership, and feature discovery.

**Acceptance:** A first-time user should find settings, open/create a note, search, switch vaults, and show/hide a panel without memorizing shortcuts. Check visible names, tooltips, keyboard focus, truncation, and selected-state clarity in both themes. Do not judge the overall visual hierarchy until the app is inspected.

### UI-05 — Complete keyboard interaction and dialog focus

**Status: fixed in [#6](https://github.com/pkud113/FermiVault/pull/6).** Modal focus trap, Escape and focus restore for Settings, Recovery, Connections and the palette (palette is also a combobox); no workspace shortcuts behind them; roving focus with arrows/Home/End for tabs, sidebar views and the file tree; keyboard context menu; keyboard-resizable separators. Index logic covered by `tests/ui.test.ts`.

**Locations:** `src/lib/Settings.svelte`, `Recovery.svelte`, `Connections.svelte`, `Palette.svelte`, `FileTree.svelte`, and `src/routes/+page.svelte`.

Source observations:

- Settings, recovery, and connection dialogs declare `role=dialog`, but do not implement modal focus containment, initial-focus placement, focus restoration, or an Escape handler in those components.
- The palette focuses its input and handles Escape/arrows there, which is useful existing behavior; it does not provide a complete modal focus boundary.
- File-tree rows handle Enter, but do not provide conventional arrow-key tree navigation or roving focus.
- Document tabs handle Enter, but do not provide a complete arrow/Home/End tab interaction.
- Sidebar separators respond to pointer drag but have no keyboard resize handling or focusable value controls.

**Recommendation:** Use shared accessible dialog/menu/tab primitives or implement the full interaction contract centrally. Prevent background shortcuts from changing the workspace while a modal is active. Support keyboard resizing or provide equivalent panel-size controls.

**Acceptance:** Complete the core flows without a mouse. Check Tab/Shift+Tab containment, Escape, restored focus, tree expansion/navigation, tab selection, context-menu dismissal, and panel resizing. Add behavior-based regression checks; confirm screen-reader announcements separately. These gaps are source-confirmed, but their full user-visible effects have not been tested live.

## What can change, and where constraints apply

| Area | Feasibility / constraint |
| --- | --- |
| Palette, typography, spacing, borders, selected/hover/focus styles | Directly adjustable through CSS tokens and component styles. No stack migration is indicated. |
| Sidebars, tabs, onboarding, settings structure, and empty/error states | Feasible in Svelte; requires interaction design, responsive rules, and regression checks. |
| Dialog focus, tree/tab keyboard navigation, and accessible labels | Feasible; behavior changes must accompany appearance changes. |
| CodeMirror live-preview visuals | Adjustable through editor themes, decorations, and widgets. Preserve selection, editing, cursor behavior, undo, and performance. |
| Native Windows title bar and window controls | Platform/Tauri work; not styled by ordinary document CSS. Custom chrome is possible, with additional drag, resize, accessibility, and platform testing obligations. |
| Built-in PDF/audio/video controls | Current implementation uses iframe/native webview controls (`src/lib/Viewer.svelte`). Styling is limited; full visual control would require replacing or wrapping those viewers. |
| Identical appearance on every OS/font/WebView | Cannot be promised from source alone. Native controls, fonts, scaling, and engines vary; test supported platforms. |
| Replacing the editor or redesigning the entire product | Not justified by this preliminary review. Treat as a separate architectural/product decision requiring evidence and approval. |

There is no evidence that Tauri, Rust, Svelte, or CodeMirror prevents the recommended UI improvements. Distinguish “requires more implementation/testing” from “cannot be changed.”

## Required live review before calling this complete

- First launch and opening a populated vault.
- Long-form reading, editing, source/live-preview switching, callouts, tables, math, diagrams, and transclusions.
- File tree, long/duplicate names, search with results/no results, tags, bookmarks, backlinks, and outline.
- Multiple tabs, split panes, global/local graphs, and narrow-window behavior.
- Settings, recovery, connection-preview dialogs, empty states, and recoverable errors.
- Light/dark/system themes, larger fonts, OS scaling, focus visibility, and keyboard-only use.
- Chat/AI setup states using synthetic data; do not transmit private notes, change credentials, connect clients, or download models merely for a visual review.

Record screenshots, viewport/scaling, reproduction steps, and observed impact when access is available. Keep observed defects separate from preferences and untested hypotheses.

## Suggested order

1. Recheck these source anchors against the latest `main`.
2. Address contrast and keyboard access first.
3. Establish editor-width and sidebar behavior, then improve control discovery.
4. Validate the native screens and present any broader visual direction to the user before implementing a larger redesign.
5. Have the changes visually and regression reviewed before release.

## Reference

The contrast comparison uses the [W3C explanation of WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): 4.5:1 for normal text, with separate exceptions for large, incidental, and inactive text. This document is not a formal conformance assessment.
