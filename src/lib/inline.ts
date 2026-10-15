// Where streamed inline-AI text goes. The range a command owns lives in the note's own
// editor state, so every edit maps it (typing above it moves it; switching tabs doesn't
// matter because the command writes to that note's state, not to whatever is on screen).
// Only @codemirror/state here, so it's testable with `node --test`.

import { StateEffect, StateField, Transaction, type EditorState, type TransactionSpec } from "@codemirror/state";

export type AiRange = { from: number; to: number; touched: boolean };

const setAiRange = StateEffect.define<{ from: number; to: number } | null>();

/** The range the running inline command owns. `touched` once the user edits inside it. */
export const aiRange = StateField.define<AiRange | null>({
  create: () => null,
  update(r, tr) {
    for (const e of tr.effects) if (e.is(setAiRange)) return e.value && { ...e.value, touched: false };
    if (!r || !tr.docChanged) return r;
    let touched = r.touched;
    tr.changes.iterChangedRanges((a, b) => {
      if (a < r.to && b > r.from) touched = true;
    });
    // Text typed exactly at either edge stays outside the range.
    const from = tr.changes.mapPos(r.from, 1);
    return { from, to: Math.max(from, tr.changes.mapPos(r.to, -1)), touched };
  },
});

const quiet = Transaction.addToHistory.of(false);

/** Starts owning `from`–`to`: the selection being rewritten, or an empty range where text will be inserted. */
export const begin = (from: number, to: number): TransactionSpec => ({ effects: setAiRange.of({ from, to }), annotations: quiet });

/** Adds a streamed fragment: the first fragment of a rewrite replaces the owned text, later ones append.
 *  Null when the command should stop (no range, or the user edited inside it). Kept out of undo
 *  history until `finish`. */
export function step(state: EditorState, text: string, replace: boolean): TransactionSpec | null {
  const r = state.field(aiRange, false);
  if (!r || r.touched) return null;
  const from = replace ? r.from : r.to;
  return { changes: { from, to: r.to, insert: text }, effects: setAiRange.of({ from: r.from, to: from + text.length }), annotations: quiet };
}

/** Ends the command as one undo step: puts `original` back outside history, then applies
 *  original → output as a single change. Apply the specs in order. */
export function finish(state: EditorState, original: string): TransactionSpec[] {
  const r = state.field(aiRange, false);
  if (!r) return [];
  const output = state.sliceDoc(r.from, r.to);
  const restore = { changes: { from: r.from, to: r.to, insert: original }, effects: setAiRange.of(null), annotations: quiet };
  if (output === original) return [restore];
  return [restore, { changes: { from: r.from, to: r.from + original.length, insert: output }, userEvent: "input.ai" }];
}
