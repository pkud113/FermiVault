// Inline AI output placement and undo (R6). Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { aiRange, begin, finish, step } from "../src/lib/inline.ts";

const make = (doc: string, from: number, to = from) =>
  EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [history(), aiRange] });
const apply = (s: EditorState, ...specs: (TransactionSpec | null)[]) => specs.reduce((st, sp) => (sp ? st.update(sp).state : st), s);
const undone = (s: EditorState) => {
  let out = s;
  undo({ state: s, dispatch: (tr) => (out = tr.state) });
  return out;
};
/** A user edit, recorded in history like typing is. */
const type = (s: EditorState, from: number, insert: string, to = from) => s.update({ changes: { from, to, insert }, userEvent: "input.type" }).state;

test("a rewrite streams over the selection and undoes in one step", () => {
  let s = make("Hello wrld!", 6, 10);
  s = apply(s, begin(6, 10));
  s = apply(s, step(s, "Wor", true));
  s = apply(s, step(s, "ld", false));
  assert.equal(s.doc.toString(), "Hello World!");
  s = apply(s, ...finish(s, "wrld"));
  assert.equal(s.doc.toString(), "Hello World!");
  assert.equal(s.field(aiRange), null);
  assert.equal(undone(s).doc.toString(), "Hello wrld!", "one undo restores the original selection");
});

test("typing above the insertion point moves where output lands", () => {
  let s = make("one\ntwo", 7);
  s = apply(s, begin(7, 7));
  s = apply(s, step(s, " three", false));
  s = type(s, 0, "zero ");
  s = apply(s, step(s, " four", false));
  assert.equal(s.doc.toString(), "zero one\ntwo three four");
  s = apply(s, ...finish(s, ""));
  assert.equal(undone(s).doc.toString(), "zero one\ntwo", "undo removes exactly the AI text");
});

test("editing inside the AI text stops the stream but keeps both edits", () => {
  let s = make("abc", 3);
  s = apply(s, begin(3, 3));
  s = apply(s, step(s, "XYZ", false));
  s = type(s, 4, "-");
  assert.equal(step(s, "more", false), null, "stops after the user edits inside the output");
  s = apply(s, ...finish(s, ""));
  assert.equal(s.doc.toString(), "abcX-YZ");
});

test("a failed rewrite with no output leaves the note and history untouched", () => {
  let s = make("keep this", 0, 4);
  s = apply(s, begin(0, 4));
  s = apply(s, ...finish(s, "keep"));
  assert.equal(s.doc.toString(), "keep this");
  assert.equal(undone(s).doc.toString(), "keep this", "nothing to undo");
});

test("a provider failure after partial output still undoes to the original in one step", () => {
  let s = make("Fix this sentense please", 4, 17);
  s = apply(s, begin(4, 17));
  s = apply(s, step(s, "this sent", true)); // stream dies here
  assert.equal(s.doc.toString(), "Fix this sent please");
  s = apply(s, ...finish(s, "this sentense"));
  assert.equal(undone(s).doc.toString(), "Fix this sentense please");
});

test("output streamed into a note that's no longer on screen lands in that note's own state", () => {
  // The editor keeps each open note's state; a switched-away note is updated directly, not via the view.
  const background = { state: apply(make("note A", 6), begin(6, 6)) };
  const onScreen = make("note B", 6);
  background.state = apply(background.state, step(background.state, " + AI", false));
  assert.equal(background.state.doc.toString(), "note A + AI");
  assert.equal(onScreen.doc.toString(), "note B", "the visible note is untouched");
});
