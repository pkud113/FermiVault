// Layout and keyboard rules for the workspace shell. No Svelte or DOM here, so they're
// testable with `node --test` (tests/ui.test.ts).

export type Side = "left" | "right";

/** The editor area never gets narrower than this. */
export const MIN_EDITOR = 380;
/** Each extra split pane needs this much more. */
export const MIN_PANE = 300;
export const MIN_PANEL = 180;
export const MAX_PANEL = 560;

type Panel = { show: boolean; width: number };

/** Sidebar widths for a window `vw` px wide. The editor keeps at least its minimum; the
 *  `first` sidebar gets space first, and a sidebar that doesn't fit is hidden for now. Its
 *  show setting is untouched, so it comes back when the window widens. */
export function sidebars(vw: number, panes: number, left: Panel, right: Panel, first: Side): { left: number; right: number } {
  let room = vw - Math.max(MIN_EDITOR, MIN_PANE * panes);
  const fit = (p: Panel) => {
    const w = p.show && room >= MIN_PANEL ? Math.min(Math.max(p.width, MIN_PANEL), MAX_PANEL, room) : 0;
    room -= w;
    return w;
  };
  if (first === "left") {
    const l = fit(left);
    return { left: l, right: fit(right) };
  }
  const r = fit(right);
  return { left: fit(left), right: r };
}

/** Width a sidebar should take when the user drags or arrow-keys it to `want`. */
export function clampPanel(want: number, vw: number, panes: number, other: number) {
  return Math.max(MIN_PANEL, Math.min(MAX_PANEL, vw - Math.max(MIN_EDITOR, MIN_PANE * panes) - other, want));
}

/** Roving-focus target for tab strips and lists: the index `key` moves to from `i` of `n`,
 *  or -1 if the key isn't a navigation key. `wrap` cycles at the ends (tabs do, trees don't). */
export function arrowIndex(key: string, i: number, n: number, wrap: boolean, prev = "ArrowLeft", next = "ArrowRight"): number {
  if (n === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  if (key === next) return wrap ? (i + 1) % n : Math.min(n - 1, i + 1);
  if (key === prev) return wrap ? (i - 1 + n) % n : Math.max(0, i - 1);
  return -1;
}
