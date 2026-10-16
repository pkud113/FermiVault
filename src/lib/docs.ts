// How open notes reach disk. Kept free of Svelte and CodeMirror so the rules
// can be tested with `node --test` (see tests/docs.test.ts).

/** A note open in an editor pane: its editor state and the text disk had when we last read or wrote it. */
export type Doc<S> = {
  vault: string;
  path: string;
  state: S;
  saved: string;
  /** Trashed, or its vault was closed: never written again. */
  closed?: boolean;
  /** Pending deferred save, or retry after a failed one. */
  timer?: ReturnType<typeof setTimeout>;
};

/** Writes `text`; `base` is what disk had at the last load/save. Resolves true when disk
 *  had changed since (the backend then keeps that version as a snapshot). */
export type Writer = (vault: string, path: string, text: string, base: string) => Promise<boolean>;

let tail: Promise<unknown> = Promise.resolve();

/** Runs note writes and file moves one at a time, in call order. So a save queued
 *  before a rename writes the old path (which the rename then moves) and one queued
 *  after it writes the new path; nothing can land in between. */
// ponytail: one queue for the whole app; per-note queues only if many panes ever write at once.
export function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task);
  tail = run.catch(() => {});
  return run;
}

/** Writes `doc` if it differs from disk. Vault, path and text are read when the write
 *  actually runs, so renames and later typing are respected. `saved` only advances
 *  once the write succeeds: a failed save stays dirty and the next one retries it.
 *  Resolves true when someone else had changed the file since we last synced. */
export function saveDoc<S>(doc: Doc<S>, text: (s: S) => string, write: Writer): Promise<boolean> {
  return serial(async () => {
    const t = text(doc.state);
    if (doc.closed || t === doc.saved) return false;
    const conflict = await write(doc.vault, doc.path, t, doc.saved);
    doc.saved = t;
    return conflict;
  });
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

/** Where `p` is after a file or folder moved from `from` to `to`. */
export const moved = (p: string, from: string, to: string) => (under(p, from) ? to + p.slice(from.length) : p);

/** After a file or folder moved from `from` to `to`: points affected docs at their new paths. */
export function renameDocs<S>(docs: Doc<S>[], from: string, to: string) {
  for (const d of docs) d.path = moved(d.path, from, to);
}

/** Marks docs at or under `path` (all of them for `null`) as closed and returns the rest. */
export function closeDocs<S>(docs: Doc<S>[], path: string | null): Doc<S>[] {
  for (const d of docs) {
    if (path === null || under(d.path, path)) {
      d.closed = true;
      clearTimeout(d.timer);
    }
  }
  return docs.filter((d) => !d.closed);
}

export type PaneIO<S> = {
  read: (path: string) => Promise<string>;
  create: (text: string) => S;
  text: (s: S) => string;
  vault: () => string;
  /** Queue a save of a note that's being switched away from. */
  save: (d: Doc<S>) => unknown;
};

/** The notes one editor pane has open, and which one it's showing. */
export class PaneDocs<S> {
  docs: Doc<S>[] = [];
  /** The note shown and editable. Null while a note loads: nothing is bound to the new
   *  path until its text has arrived, so neither typing nor a save can put the previous
   *  note's text into it. */
  doc: Doc<S> | null = null;
  /** The note being shown or loaded. */
  target: string | null = null;
  private loads = 0;
  private io: PaneIO<S>;

  constructor(io: PaneIO<S>) {
    this.io = io;
  }

  /** Loads `p` and makes it current. Resolves to null when a later `open` superseded this one. */
  async open(p: string): Promise<{ doc: Doc<S> } | { error: unknown } | null> {
    const my = ++this.loads;
    if (this.doc) this.io.save(this.doc);
    this.doc = null;
    this.target = p;
    let disk: string;
    try {
      disk = await this.io.read(p);
    } catch (error) {
      return my === this.loads ? { error } : null;
    }
    if (my !== this.loads) return null;
    const vault = this.io.vault();
    let d = this.docs.find((x) => x.path === p && x.vault === vault);
    // Reuse the open doc (undo history, unsaved edits) unless it's clean and disk has moved on.
    if (d && this.io.text(d.state) === d.saved && d.saved !== disk) {
      this.docs = this.docs.filter((x) => x !== d);
      d = undefined;
    }
    if (!d) this.docs.push((d = { vault, path: p, state: this.io.create(disk), saved: disk }));
    this.doc = d;
    return { doc: d };
  }

  /** Follows a move. Returns the new path when a load of the old one was in flight and must restart. */
  renamed(from: string, to: string): string | null {
    renameDocs(this.docs, from, to);
    const next = this.target === null ? null : moved(this.target, from, to);
    if (next === null || next === this.target) return null;
    this.target = next;
    if (this.doc) return null;
    this.loads++; // drop the in-flight read of the old path
    return next;
  }

  closed(path: string | null) {
    this.docs = closeDocs(this.docs, path);
    if (this.doc?.closed) this.doc = null;
  }
}

/** A file whose latest edits aren't on disk yet (a saved file has none). */
export type SaveState = { state: "pending" | "saving" | "failed"; error?: string };

/** The next save state of a file after `event`. A failure stays visible until a save succeeds:
 *  retries and further typing don't hide it. `null`: everything is on disk. */
export function nextSave(cur: SaveState | undefined, event: "edit" | "saving" | "saved" | "failed", error?: string): SaveState | null {
  if (event === "saved") return null;
  if (event === "failed") return { state: "failed", error };
  if (cur?.state === "failed") return cur;
  return { state: event === "edit" ? "pending" : "saving" };
}
