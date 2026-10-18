import { arrowIndex } from "./ui";

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Modal dialog behaviour: move focus in, keep Tab inside, close on Escape, give focus back. */
export function modal(node: HTMLElement, close: () => void) {
  const back = document.activeElement as HTMLElement | null;
  const items = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  (items()[0] ?? node).focus();

  const keydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      const list = items();
      if (!list.length) return e.preventDefault();
      const [a, z] = [list[0], list[list.length - 1]];
      if (e.shiftKey && (document.activeElement === a || !node.contains(document.activeElement))) (e.preventDefault(), z.focus());
      else if (!e.shiftKey && (document.activeElement === z || !node.contains(document.activeElement))) (e.preventDefault(), a.focus());
    }
  };
  node.addEventListener("keydown", keydown);
  return {
    update: (fn: () => void) => (close = fn),
    destroy() {
      node.removeEventListener("keydown", keydown);
      // Give focus back, unless something opened by this dialog (another dialog) already took it.
      const now = document.activeElement;
      if (!now || now === document.body || node.contains(now)) back?.focus?.();
    },
  };
}

/** Menu behaviour: focus the first item, arrows move between items, Escape or Tab closes. */
export function menuKeys(node: HTMLElement, close: () => void) {
  const items = () => [...node.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  items()[0]?.focus();
  const keydown = (e: KeyboardEvent) => {
    const list = items();
    const i = arrowIndex(e.key, list.indexOf(document.activeElement as HTMLElement), list.length, true, "ArrowUp", "ArrowDown");
    if (i >= 0) {
      e.preventDefault();
      list[i].focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };
  node.addEventListener("keydown", keydown);
  return {
    update: (fn: () => void) => (close = fn),
    destroy: () => node.removeEventListener("keydown", keydown),
  };
}

/** Tab-strip keys: arrows, Home and End move to the neighbouring tab and select it
 *  (roving focus: give only the selected tab tabindex 0). */
export function tabKeys(node: HTMLElement) {
  const keydown = (e: KeyboardEvent) => {
    const tabs = [...node.querySelectorAll<HTMLElement>(':scope > [role="tab"]')];
    const i = tabs.indexOf(e.target as HTMLElement);
    // Vertical lists (Settings sections) also take Up/Down; they lay out as a row on narrow windows.
    const vertical = node.getAttribute("aria-orientation") === "vertical";
    const up = vertical ? arrowIndex(e.key, i, tabs.length, true, "ArrowUp", "ArrowDown") : -1;
    const to = up >= 0 ? up : arrowIndex(e.key, i, tabs.length, true);
    if (to < 0 || !tabs.includes(e.target as HTMLElement)) return;
    e.preventDefault();
    tabs[to].click();
    tabs[to].focus();
  };
  node.addEventListener("keydown", keydown);
  return { destroy: () => node.removeEventListener("keydown", keydown) };
}
