//! Rebuildable SQLite index at `<vault>/.fermi/index.db`: notes, links, tags,
//! headings, an FTS5 full-text table and retrieval chunks (with embeddings, see
//! `semantic.rs`). WAL mode lets the GUI and any number of
//! MCP server processes share it safely.

use crate::parse::{self, link_key};
use crate::vault::{Res, Vault, err};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::LazyLock;

const SCHEMA_VERSION: i32 = 2;

pub struct Index {
    pub db: Connection,
    /// In-memory copy of all chunk vectors, reloaded when `meta.gen` changes.
    pub(crate) cache: Option<crate::semantic::VecCache>,
}

#[derive(Serialize, Debug)]
pub struct Hit {
    pub path: String,
    pub snippet: String,
}

/// Every note plus resolved note-to-note links (unresolved targets are left out).
#[derive(Serialize, Debug)]
pub struct Graph {
    pub nodes: Vec<String>,
    pub edges: Vec<(String, String)>,
}

#[derive(Serialize, Debug)]
pub struct LinkRef {
    pub path: String,
    pub line: i64,
    pub context: String,
}

fn stem_of(key: &str) -> &str {
    key.rsplit('/').next().unwrap_or(key)
}

/// FTS5 query from free text: every word must match, last word as a prefix.
fn fts_query(q: &str) -> String {
    let words: Vec<String> = q.split_whitespace().map(|w| format!("\"{}\"", w.replace('"', "\"\""))).collect();
    match words.split_last() {
        Some((last, rest)) => rest.iter().cloned().chain([format!("{last}*")]).collect::<Vec<_>>().join(" "),
        None => String::new(),
    }
}

impl Index {
    pub fn open(vault: &Vault) -> Res<Self> {
        let db = Connection::open(vault.dot_dir().join("index.db")).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(err)?;
        db.pragma_update(None, "synchronous", "NORMAL").map_err(err)?;
        let v: i32 = db.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(err)?;
        if v != SCHEMA_VERSION {
            db.execute_batch(&format!(
                "DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS tags;
                 DROP TABLE IF EXISTS headings; DROP TABLE IF EXISTS fts;
                 DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS meta;
                 CREATE TABLE notes(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, key TEXT NOT NULL,
                                    stem TEXT NOT NULL, mtime INTEGER NOT NULL);
                 CREATE INDEX notes_stem ON notes(stem);
                 CREATE INDEX notes_mtime ON notes(mtime);
                 CREATE TABLE links(src TEXT NOT NULL, dst TEXT NOT NULL, dst_stem TEXT NOT NULL,
                                    line INTEGER NOT NULL, ctx TEXT NOT NULL);
                 CREATE INDEX links_src ON links(src);
                 CREATE INDEX links_dst_stem ON links(dst_stem);
                 CREATE TABLE tags(path TEXT NOT NULL, tag TEXT NOT NULL);
                 CREATE INDEX tags_path ON tags(path);
                 CREATE INDEX tags_tag ON tags(tag);
                 CREATE TABLE headings(path TEXT NOT NULL, level INTEGER NOT NULL, text TEXT NOT NULL, line INTEGER NOT NULL);
                 CREATE INDEX headings_path ON headings(path);
                 CREATE VIRTUAL TABLE fts USING fts5(title, body, tokenize='unicode61 remove_diacritics 2');
                 CREATE TABLE chunks(id INTEGER PRIMARY KEY, path TEXT NOT NULL, heading TEXT NOT NULL,
                                     line INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB);
                 CREATE INDEX chunks_path ON chunks(path);
                 CREATE INDEX chunks_pending ON chunks(id) WHERE vec IS NULL;
                 CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
                 INSERT INTO meta VALUES ('gen', 0);
                 PRAGMA user_version = {SCHEMA_VERSION};"
            ))
            .map_err(err)?;
        }
        Ok(Self { db, cache: None })
    }

    /// Brings the index up to date with the files on disk. Only notes whose mtime
    /// changed are re-read. Returns the number of notes added, updated or removed.
    pub fn sync(&mut self, vault: &Vault) -> Res<usize> {
        let known: HashMap<String, i64> = {
            let mut st = self.db.prepare("SELECT path, mtime FROM notes").map_err(err)?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.flatten().collect()
        };
        let disk = vault.notes();
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
        let mut changed = 0;
        for (path, m) in &disk {
            if known.get(path) != Some(m)
                && let Ok(text) = vault.read(path)
            {
                index_note(&tx, path, &text, *m)?;
                changed += 1;
            }
        }
        let on_disk: std::collections::HashSet<&String> = disk.iter().map(|(p, _)| p).collect();
        for path in known.keys().filter(|p| !on_disk.contains(p)) {
            remove_note(&tx, path)?;
            changed += 1;
        }
        tx.commit().map_err(err)?;
        Ok(changed)
    }

    /// Re-indexes one note from disk (or drops it if it no longer exists).
    pub fn refresh(&mut self, vault: &Vault, path: &str) -> Res<()> {
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
        match vault.abs(path).ok().and_then(|p| std::fs::metadata(p).ok()) {
            Some(meta) if meta.is_file() => index_note(&tx, path, &vault.read(path)?, crate::vault::mtime(&meta))?,
            _ => remove_note(&tx, path)?,
        }
        tx.commit().map_err(err)
    }

    pub fn search(&self, q: &str, limit: usize) -> Res<Vec<Hit>> {
        let fq = fts_query(q);
        if fq.is_empty() {
            return Ok(vec![]);
        }
        let mut st = self
            .db
            .prepare(
                "SELECT n.path, snippet(fts, 1, '**', '**', '…', 16) FROM fts JOIN notes n ON n.id = fts.rowid
                 WHERE fts MATCH ?1 ORDER BY bm25(fts, 10.0, 1.0) LIMIT ?2",
            )
            .map_err(err)?;
        let rows = st
            .query_map(params![fq, limit as i64], |r| {
                Ok(Hit {
                    path: r.get(0)?,
                    snippet: r.get(1)?,
                })
            })
            .map_err(err)?;
        Ok(rows.flatten().collect())
    }

    /// Resolves a link target (`Note`, `folder/Note`, `Note.md`) to a note path.
    /// Exact path wins, then the shortest path whose tail matches.
    pub fn resolve(&self, target: &str) -> Res<Option<String>> {
        let k = link_key(target);
        self.db
            .query_row(
                "SELECT path FROM notes WHERE stem = ?2 AND (key = ?1 OR substr(key, -length(?1) - 1) = '/' || ?1)
                 ORDER BY key = ?1 DESC, length(path) LIMIT 1",
                params![k, stem_of(&k)],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)
    }

    // ponytail: a bare [[Name]] counts as a backlink for every note with that name
    // when names are ambiguous; disambiguate if users hit it.
    pub fn backlinks(&self, path: &str) -> Res<Vec<LinkRef>> {
        let k = link_key(path);
        let mut st = self
            .db
            .prepare(
                "SELECT src, line, ctx FROM links WHERE dst_stem = ?2 AND src != ?3
                 AND (dst = ?1 OR substr(?1, -length(dst) - 1) = '/' || dst) ORDER BY src, line",
            )
            .map_err(err)?;
        let rows = st
            .query_map(params![k, stem_of(&k), path], |r| {
                Ok(LinkRef {
                    path: r.get(0)?,
                    line: r.get(1)?,
                    context: r.get(2)?,
                })
            })
            .map_err(err)?;
        Ok(rows.flatten().collect())
    }

    /// Outgoing links as (target as written, resolved path if the note exists).
    pub fn outgoing(&self, path: &str) -> Res<Vec<(String, Option<String>)>> {
        let targets: Vec<String> = {
            let mut st = self.db.prepare("SELECT DISTINCT dst FROM links WHERE src = ?1").map_err(err)?;
            st.query_map([path], |r| r.get(0)).map_err(err)?.flatten().collect()
        };
        targets.into_iter().map(|t| Ok((t.clone(), self.resolve(&t)?))).collect()
    }

    /// Notes under `folder` (prefix), newest first. `since` is unix ms.
    pub fn list(&self, folder: &str, since: i64, limit: usize) -> Res<Vec<(String, i64)>> {
        let prefix = folder.trim_matches('/');
        let like = if prefix.is_empty() {
            "%".to_string()
        } else {
            format!("{}/%", prefix.replace('%', ""))
        };
        let mut st = self
            .db
            .prepare("SELECT path, mtime FROM notes WHERE path LIKE ?1 AND mtime > ?2 ORDER BY mtime DESC LIMIT ?3")
            .map_err(err)?;
        let rows = st
            .query_map(params![like, since, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?;
        Ok(rows.flatten().collect())
    }

    /// Renames/moves a note and rewrites every `[[link]]` and `[x](path.md)` pointing
    /// at it. Returns how many other notes were updated.
    // ponytail: relative markdown links *inside* the moved note aren't rebased; rare in practice.
    pub fn rename_note(&mut self, vault: &Vault, from: &str, to: &str) -> Res<usize> {
        let old_key = link_key(from);
        let new_key = to.trim_end_matches(".md").to_string();
        let new_stem = new_key.rsplit('/').next().unwrap().to_string();
        let sources: Vec<String> = {
            let mut s: Vec<String> = self.backlinks(from)?.into_iter().map(|l| l.path).collect();
            s.dedup();
            s
        };
        let matches = |dst: &str| dst == old_key || old_key.ends_with(&format!("/{dst}"));
        vault.rename(from, to)?;
        let mut updated = 0;
        for src in &sources {
            let text = vault.read(src)?;
            let out = WIKI_REWRITE.replace_all(&text, |c: &regex::Captures| {
                if matches(&link_key(&c[2])) {
                    let target = if c[2].contains('/') { &new_key } else { &new_stem };
                    format!("{}{target}{}", &c[1], &c[3])
                } else {
                    c[0].to_string()
                }
            });
            let out = MD_REWRITE.replace_all(&out, |c: &regex::Captures| {
                let resolved = crate::parse::resolve_relative(src, &c[2]);
                if link_key(&resolved) == old_key {
                    format!("[{}]({}{})", &c[1], relative_href(src, to), c.get(3).map_or("", |m| m.as_str()))
                } else {
                    c[0].to_string()
                }
            });
            if out != text {
                vault.write(src, &out)?;
                self.refresh(vault, src)?;
                updated += 1;
            }
        }
        self.refresh(vault, from)?;
        self.refresh(vault, to)?;
        Ok(updated)
    }

    /// Link graph in one indexed join (same resolution rule as `resolve`).
    pub fn graph(&self) -> Res<Graph> {
        let mut st = self.db.prepare("SELECT path FROM notes ORDER BY path").map_err(err)?;
        let nodes = st.query_map([], |r| r.get(0)).map_err(err)?.flatten().collect();
        let mut st = self
            .db
            .prepare(
                "SELECT DISTINCT l.src, n.path FROM links l JOIN notes n ON n.stem = l.dst_stem
                 AND (n.key = l.dst OR substr(n.key, -length(l.dst) - 1) = '/' || l.dst) WHERE n.path != l.src",
            )
            .map_err(err)?;
        let edges = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.flatten().collect();
        Ok(Graph { nodes, edges })
    }

    pub fn tags(&self) -> Res<Vec<(String, i64)>> {
        let mut st = self
            .db
            .prepare("SELECT tag, count(*) c FROM tags GROUP BY tag ORDER BY c DESC, tag")
            .map_err(err)?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
        Ok(rows.flatten().collect())
    }

    /// Notes tagged `tag` or any nested `tag/...`.
    pub fn tagged(&self, tag: &str) -> Res<Vec<String>> {
        let t = tag.trim_start_matches('#');
        let mut st = self
            .db
            .prepare("SELECT DISTINCT path FROM tags WHERE tag = ?1 OR substr(tag, 1, length(?1) + 1) = ?1 || '/' ORDER BY path")
            .map_err(err)?;
        let rows = st.query_map([t], |r| r.get(0)).map_err(err)?;
        Ok(rows.flatten().collect())
    }
}

static WIKI_REWRITE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(!?\[\[)([^\]\|#\^]*)([^\]]*\]\])").unwrap());
static MD_REWRITE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\(<?([^)>\s]+?\.md)>?(#[^)]*)?\)").unwrap());

/// Relative href from note `src` to note `dst` (both vault-relative).
fn relative_href(src: &str, dst: &str) -> String {
    let from: Vec<&str> = src.split('/').collect();
    let from = &from[..from.len() - 1];
    let to: Vec<&str> = dst.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/").replace(' ', "%20")
}

/// Bumped whenever chunks or their vectors change, so vector caches know to reload.
pub(crate) fn bump_gen(db: &Connection) -> Res<()> {
    db.execute("UPDATE meta SET v = v + 1 WHERE k = 'gen'", []).map(|_| ()).map_err(err)
}

fn remove_note(db: &Connection, path: &str) -> Res<()> {
    if let Some(id) = db
        .query_row("SELECT id FROM notes WHERE path = ?1", [path], |r| r.get::<_, i64>(0))
        .optional()
        .map_err(err)?
    {
        db.execute("DELETE FROM fts WHERE rowid = ?1", [id]).map_err(err)?;
    }
    for sql in [
        "DELETE FROM notes WHERE path = ?1",
        "DELETE FROM links WHERE src = ?1",
        "DELETE FROM tags WHERE path = ?1",
        "DELETE FROM headings WHERE path = ?1",
        "DELETE FROM chunks WHERE path = ?1",
    ] {
        db.execute(sql, [path]).map_err(err)?;
    }
    bump_gen(db)
}

fn index_note(db: &Connection, path: &str, text: &str, mtime: i64) -> Res<()> {
    // Keep vectors of unchanged chunks: an edit re-embeds only the paragraph that changed.
    let old_vecs: HashMap<String, Vec<u8>> = {
        let mut st = db
            .prepare("SELECT text, vec FROM chunks WHERE path = ?1 AND vec IS NOT NULL")
            .map_err(err)?;
        st.query_map([path], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?
            .flatten()
            .collect()
    };
    remove_note(db, path)?;
    for c in parse::chunks(text) {
        db.execute(
            "INSERT INTO chunks(path, heading, line, text, vec) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![path, c.heading, c.line as i64, c.text, old_vecs.get(&c.text)],
        )
        .map_err(err)?;
    }
    let key = link_key(path);
    db.execute(
        "INSERT INTO notes(path, key, stem, mtime) VALUES (?1, ?2, ?3, ?4)",
        params![path, key, stem_of(&key), mtime],
    )
    .map_err(err)?;
    let id = db.last_insert_rowid();
    let title = path.rsplit('/').next().unwrap().trim_end_matches(".md");
    db.execute("INSERT INTO fts(rowid, title, body) VALUES (?1, ?2, ?3)", params![id, title, text])
        .map_err(err)?;
    let p = parse::parse(path, text);
    for (dst, line, ctx) in &p.links {
        db.execute(
            "INSERT INTO links(src, dst, dst_stem, line, ctx) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![path, dst, stem_of(dst), *line as i64, ctx],
        )
        .map_err(err)?;
    }
    for t in &p.tags {
        db.execute("INSERT INTO tags(path, tag) VALUES (?1, ?2)", params![path, t])
            .map_err(err)?;
    }
    for (level, text, line) in &p.headings {
        db.execute(
            "INSERT INTO headings(path, level, text, line) VALUES (?1, ?2, ?3, ?4)",
            params![path, level, text, *line as i64],
        )
        .map_err(err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GUI watcher and MCP server re-index the same note concurrently; deferred
    /// transactions failed instantly with "database is locked" here.
    #[test]
    fn concurrent_writers_wait_instead_of_failing() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write("a.md", "links to [[b]] #x").unwrap();
        Index::open(&v).unwrap().sync(&v).unwrap();
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let v = v.clone();
                std::thread::spawn(move || {
                    let mut ix = Index::open(&v).unwrap();
                    for _ in 0..40 {
                        ix.refresh(&v, "a.md").unwrap();
                        ix.sync(&v).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
    }

    #[test]
    fn index_search_links() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write("Home.md", "Welcome. See [[Ideas]] and [[proj/Plan]]. #start").unwrap();
        v.write("Ideas.md", "Quantum gardening thoughts #idea/raw").unwrap();
        v.write("proj/Plan.md", "Plan links back to [[home]].").unwrap();
        v.write("other/Plan.md", "unrelated").unwrap();
        let mut ix = Index::open(&v).unwrap();
        assert_eq!(ix.sync(&v).unwrap(), 4);
        assert_eq!(ix.sync(&v).unwrap(), 0, "unchanged files are skipped");

        let hits = ix.search("quant", 10).unwrap();
        assert_eq!(hits[0].path, "Ideas.md");
        assert!(hits[0].snippet.contains("**Quantum**"));
        assert!(ix.search("\"", 10).unwrap().is_empty());

        assert_eq!(ix.resolve("ideas").unwrap().as_deref(), Some("Ideas.md"));
        assert_eq!(ix.resolve("proj/Plan").unwrap().as_deref(), Some("proj/Plan.md"));
        assert_eq!(ix.resolve("nope").unwrap(), None);

        let bl = ix.backlinks("Ideas.md").unwrap();
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].path, "Home.md");
        assert_eq!(ix.backlinks("proj/Plan.md").unwrap().len(), 1);
        assert!(
            ix.backlinks("other/Plan.md").unwrap().is_empty(),
            "path-qualified link is not ambiguous"
        );

        assert_eq!(ix.tagged("idea").unwrap(), ["Ideas.md"]);
        let g = ix.graph().unwrap();
        assert_eq!(g.nodes.len(), 4);
        let mut edges = g.edges.clone();
        edges.sort();
        assert_eq!(
            edges,
            [
                ("Home.md".into(), "Ideas.md".into()),
                ("Home.md".into(), "proj/Plan.md".into()),
                ("proj/Plan.md".into(), "Home.md".into())
            ]
        );
        assert_eq!(ix.list("proj", 0, 10).unwrap().len(), 1);

        // Rename rewrites wikilinks (bare and path-qualified) and markdown links.
        v.write("notes/Ref.md", "[p](../proj/Plan.md#x) and [[proj/Plan|alias]]").unwrap();
        ix.sync(&v).unwrap();
        assert_eq!(ix.rename_note(&v, "proj/Plan.md", "archive/Old Plan.md").unwrap(), 2);
        assert_eq!(
            v.read("notes/Ref.md").unwrap(),
            "[p](../archive/Old%20Plan.md#x) and [[archive/Old Plan|alias]]"
        );
        assert!(v.read("Home.md").unwrap().contains("[[archive/Old Plan]]"));
        let mut srcs: Vec<_> = ix.backlinks("archive/Old Plan.md").unwrap().into_iter().map(|l| l.path).collect();
        srcs.dedup();
        assert_eq!(srcs, ["Home.md", "notes/Ref.md"]);
        assert_eq!(relative_href("a/b/c.md", "a/x.md"), "../x.md");

        v.trash("Ideas.md").unwrap();
        ix.refresh(&v, "Ideas.md").unwrap();
        assert!(ix.search("quantum", 10).unwrap().is_empty());
        assert!(ix.outgoing("Home.md").unwrap().iter().any(|(t, p)| t == "ideas" && p.is_none()));
    }
}
