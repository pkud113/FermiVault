//! Performance budgets for the Rust core, on a vault from `scripts/bench-vault.mjs`:
//!
//!     node scripts/bench-vault.mjs <dir>
//!     FERMIVAULT_BENCH_VAULT=<dir> cargo test --profile budgets --test budgets -- --ignored --nocapture
//!
//! CI runs this on every push (see .github/workflows/ci.yml).

use fermivault_lib::index::Index;
use fermivault_lib::query;
use fermivault_lib::vault::Vault;
use std::time::{Duration, Instant};

/// Full-text query budget (the plan's "under 30 ms").
const SEARCH_BUDGET: Duration = Duration::from_millis(30);

fn time<T>(f: impl FnOnce() -> T) -> (T, Duration) {
    let t = Instant::now();
    let out = f();
    (out, t.elapsed())
}

#[test]
#[ignore = "needs FERMIVAULT_BENCH_VAULT; run in CI"]
fn core_budgets() {
    let dir = std::env::var("FERMIVAULT_BENCH_VAULT").expect("set FERMIVAULT_BENCH_VAULT");
    let vault = Vault::new(&dir).unwrap();
    for f in ["index.db", "index.db-wal", "index.db-shm"] {
        let _ = std::fs::remove_file(vault.dot_dir().join(f)); // measure a cold index
    }
    let (bytes, read) = time(|| vault.notes().iter().map(|(p, _)| vault.read(p).unwrap().len()).sum::<usize>());
    println!("read all notes ({} MB): {read:?}", bytes >> 20);
    let (_, parse) = time(|| {
        for (p, _) in vault.notes() {
            let text = vault.read(&p).unwrap();
            fermivault_lib::parse::parse(&p, &text);
            fermivault_lib::parse::chunks(&text);
            fermivault_lib::parse::properties(&text);
        }
    });
    println!("read + parse all notes: {parse:?}");
    let mut ix = Index::open(&vault).unwrap();
    let (n, full) = time(|| ix.sync(&vault).unwrap());
    println!("index {n} notes: {full:?}");
    let (_, idle) = time(|| ix.sync(&vault).unwrap());
    println!("re-check unchanged vault: {idle:?}");

    let mut slowest = Duration::ZERO;
    for q in ["vault", "search index", "release budget", "meeting notes", "\"plain markdown\"", "proj", "editor canvas table", "zzzz"] {
        let (hits, d) = time(|| ix.search(q, 50).unwrap());
        println!("search {q:?}: {} hits in {d:?}", hits.len());
        slowest = slowest.max(d);
    }
    let table = query::parse("from: Projects/\nwhere: status != done\nsort: due desc\nlimit: 50").unwrap();
    let (t, d) = time(|| ix.query(&table).unwrap());
    println!("table query: {} of {} rows in {d:?}", t.rows.len(), t.total);
    assert!(slowest < SEARCH_BUDGET, "slowest full-text query took {slowest:?} (budget {SEARCH_BUDGET:?})");
}
