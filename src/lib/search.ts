// Search-as-you-type without races: only the newest query's results are ever shown, a cleared
// query stays cleared, nothing updates after the pane closes, and failures are reported as
// failures (not as "no results"). No Svelte here, so tests/search.test.ts drives it directly.

export type SearchState<H> = {
  status: "idle" | "searching" | "done" | "error";
  query: string;
  /** The newest results. Kept while a refinement is searching, so the list doesn't flicker. */
  hits: H[];
  error?: string;
};

export class Search<H> {
  state: SearchState<H> = { status: "idle", query: "", hits: [] };
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private run: (q: string) => Promise<H[]>;
  private onChange: (s: SearchState<H>) => void;
  private delay: number;

  constructor(run: (q: string) => Promise<H[]>, onChange: (s: SearchState<H>) => void, delay = 120) {
    this.run = run;
    this.onChange = onChange;
    this.delay = delay;
  }

  private update(s: SearchState<H>) {
    this.state = s;
    this.onChange(s);
  }

  /** The query changed: search it after a short pause. An empty query cancels everything. */
  set(query: string) {
    if (this.disposed) return;
    clearTimeout(this.timer);
    const my = ++this.gen; // anything still in flight is now stale
    if (!query.trim()) return this.update({ status: "idle", query, hits: [] });
    this.update({ status: "searching", query, hits: this.state.hits });
    this.timer = setTimeout(() => this.go(my, query), this.delay);
  }

  /** Runs the current query again now (files changed, or Retry after a failure). */
  refresh() {
    if (this.disposed || !this.state.query.trim()) return;
    clearTimeout(this.timer);
    const my = ++this.gen;
    this.update({ status: "searching", query: this.state.query, hits: this.state.hits });
    this.go(my, this.state.query);
  }

  private async go(my: number, query: string) {
    try {
      const hits = await this.run(query);
      if (my === this.gen && !this.disposed) this.update({ status: "done", query, hits });
    } catch (e) {
      if (my === this.gen && !this.disposed) this.update({ status: "error", query, hits: [], error: String(e) });
    }
  }

  /** The pane closed: drop pending work and ignore late results. */
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
