//! Table queries over note properties, used by ```` ```table ```` blocks in notes and the MCP
//! `query` tool:
//!
//! ```text
//! from: #project, work/      tags and/or folders, a note matching any is in (omit: all notes)
//! where: status = active     one condition per line; all must hold
//! where: due < 2026-12-01
//! sort: due desc
//! columns: status, due, tags
//! limit: 50
//! ```
//!
//! Operators: `= != < <= > >= contains`, plus `exists` and `missing` (no value). Fields are
//! property names plus `file`, `path`, `folder`, `modified` and `tags`. Values compare as
//! numbers when both sides are numbers, otherwise as case-insensitive text (so ISO dates work).

use crate::index::Index;
use crate::vault::{Res, err};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1000;

#[derive(Debug, PartialEq)]
enum Source {
    Tag(String),
    Folder(String),
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
    Exists,
    Missing,
}

#[derive(Debug, PartialEq)]
struct Cond {
    field: String,
    op: Op,
    value: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct Query {
    from: Vec<Source>,
    conds: Vec<Cond>,
    sort: Option<(String, bool)>,
    columns: Vec<String>,
    limit: usize,
}

#[derive(Serialize, Debug)]
pub struct Row {
    pub path: String,
    pub cells: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
    /// Matches before `limit` was applied.
    pub total: usize,
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
        .unwrap_or(s)
}

const OPS: [(&str, Op); 9] = [
    ("!=", Op::Ne),
    ("<=", Op::Le),
    (">=", Op::Ge),
    ("=", Op::Eq),
    ("<", Op::Lt),
    (">", Op::Gt),
    ("contains", Op::Contains),
    ("exists", Op::Exists),
    ("missing", Op::Missing),
];

fn parse_cond(s: &str) -> Res<Cond> {
    let s = s.trim();
    // The field is everything before the first operator.
    let (at, len, op) = OPS
        .iter()
        .filter_map(|(sym, op)| {
            let i = if sym.chars().all(char::is_alphabetic) {
                s.find(&format!(" {sym}")).map(|i| i + 1)
            } else {
                s.find(sym)
            };
            i.map(|i| (i, sym.len(), *op))
        })
        .min_by_key(|(i, len, _)| (*i, std::cmp::Reverse(*len)))
        .ok_or_else(|| format!("`where: {s}` needs an operator: = != < <= > >= contains exists missing"))?;
    let field = unquote(&s[..at]).to_string();
    let value = unquote(&s[at + len..]).to_string();
    if field.is_empty() {
        return Err(format!("`where: {s}` needs a field before the operator"));
    }
    if value.is_empty() && !matches!(op, Op::Exists | Op::Missing) {
        return Err(format!("`where: {s}` needs a value"));
    }
    Ok(Cond { field, op, value })
}

pub fn parse(text: &str) -> Res<Query> {
    let mut q = Query {
        limit: DEFAULT_LIMIT,
        ..Default::default()
    };
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("//")) {
        let (k, v) = line.split_once(':').ok_or_else(|| format!("`{line}`: expected `name: value`"))?;
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "from" => q.from.extend(
                v.split(',')
                    .map(unquote)
                    .filter(|s| !s.is_empty())
                    .map(|s| match s.strip_prefix('#') {
                        Some(tag) => Source::Tag(tag.to_string()),
                        None => Source::Folder(s.trim_matches('/').to_string()),
                    }),
            ),
            "where" => q.conds.push(parse_cond(v)?),
            "sort" => {
                let (field, dir) = v
                    .rsplit_once(' ')
                    .filter(|(_, d)| matches!(d.to_ascii_lowercase().as_str(), "asc" | "desc"))
                    .unwrap_or((v, "asc"));
                q.sort = Some((unquote(field).to_string(), dir.eq_ignore_ascii_case("desc")));
            }
            "columns" => q.columns = v.split(',').map(|c| unquote(c).to_string()).filter(|c| !c.is_empty()).collect(),
            "limit" => {
                q.limit = v
                    .parse::<usize>()
                    .map_err(|_| format!("`limit: {v}` must be a number"))?
                    .min(MAX_LIMIT)
            }
            other => return Err(format!("unknown line `{other}:`; use from, where, sort, columns or limit")),
        }
    }
    Ok(q)
}

/// Numbers compare as numbers, everything else as case-insensitive text.
fn compare(a: &str, b: &str) -> Ordering {
    match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
        (Ok(x), Ok(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        _ => a.to_lowercase().cmp(&b.to_lowercase()),
    }
}

fn holds(op: Op, values: &[String], want: &str) -> bool {
    let any = |f: &dyn Fn(Ordering) -> bool| values.iter().any(|v| f(compare(v, want)));
    match op {
        Op::Eq => any(&|o| o == Ordering::Equal),
        Op::Ne => !values.is_empty() && !any(&|o| o == Ordering::Equal),
        Op::Lt => any(&|o| o == Ordering::Less),
        Op::Le => any(&|o| o != Ordering::Greater),
        Op::Gt => any(&|o| o == Ordering::Greater),
        Op::Ge => any(&|o| o != Ordering::Less),
        Op::Contains => {
            let want = want.to_lowercase();
            values.iter().any(|v| v.to_lowercase().contains(&want))
        }
        Op::Exists => !values.is_empty(),
        Op::Missing => values.is_empty(),
    }
}

/// `YYYY-MM-DD HH:MM` (UTC) from unix ms, without a date library.
pub(crate) fn format_ms(ms: i64) -> String {
    let (days, secs) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000) / 1000);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", secs / 3600, secs / 60 % 60)
}

impl Index {
    pub fn query(&self, q: &Query) -> Res<Table> {
        let rows_of = |sql: &str| -> Res<Vec<(String, String)>> {
            let mut st = self.db.prepare(sql).map_err(err)?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
            Ok(rows.flatten().collect())
        };
        let mut props: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for (path, kv) in rows_of("SELECT path, key || char(0) || value FROM props")? {
            let (k, v) = kv.split_once('\0').unwrap_or((&kv, ""));
            props.entry(path).or_default().push((k.to_string(), v.to_string()));
        }
        let mut tags: HashMap<String, Vec<String>> = HashMap::new();
        for (path, tag) in rows_of("SELECT path, tag FROM tags ORDER BY tag")? {
            tags.entry(path).or_default().push(tag);
        }
        let notes: Vec<(String, i64)> = {
            let mut st = self.db.prepare("SELECT path, mtime FROM notes").map_err(err)?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.flatten().collect()
        };

        let values = |field: &str, path: &str, mtime: i64| -> Vec<String> {
            let name = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md");
            match field.to_ascii_lowercase().as_str() {
                "file" => vec![name.to_string()],
                "path" => vec![path.to_string()],
                "folder" => vec![path.rsplit_once('/').map_or("", |(d, _)| d).to_string()],
                "modified" => vec![format_ms(mtime)],
                "tags" => tags.get(path).cloned().unwrap_or_default(),
                _ => props
                    .get(path)
                    .map(|kv| {
                        kv.iter()
                            .filter(|(k, _)| k.eq_ignore_ascii_case(field))
                            .map(|(_, v)| v.clone())
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        };
        let in_from = |path: &str| {
            q.from.is_empty()
                || q.from.iter().any(|s| match s {
                    Source::Folder(f) => f.is_empty() || path.starts_with(&format!("{f}/")),
                    Source::Tag(t) => tags.get(path).is_some_and(|ts| {
                        ts.iter()
                            .any(|x| x.eq_ignore_ascii_case(t) || x.to_lowercase().starts_with(&format!("{}/", t.to_lowercase())))
                    }),
                })
        };

        let mut hits: Vec<&(String, i64)> = notes
            .iter()
            .filter(|(p, _)| in_from(p))
            .filter(|(p, m)| q.conds.iter().all(|c| holds(c.op, &values(&c.field, p, *m), &c.value)))
            .collect();
        match &q.sort {
            Some((field, desc)) => hits.sort_by(|a, b| {
                let (x, y) = (values(field, &a.0, a.1), values(field, &b.0, b.1));
                match (x.first(), y.first()) {
                    (Some(x), Some(y)) => {
                        let o = compare(x, y);
                        if *desc { o.reverse() } else { o }
                    }
                    (Some(_), None) => Ordering::Less, // missing values always last
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => Ordering::Equal,
                }
                .then_with(|| a.0.cmp(&b.0))
            }),
            None => hits.sort_by_key(|a| a.0.to_lowercase()),
        }
        let total = hits.len();
        hits.truncate(q.limit);

        let columns = if q.columns.is_empty() {
            // `file` plus the properties these notes use most.
            let mut freq: HashMap<&str, usize> = HashMap::new();
            for (p, _) in &hits {
                let keys: HashSet<&str> = props.get(p.as_str()).into_iter().flatten().map(|(k, _)| k.as_str()).collect();
                keys.into_iter().for_each(|k| *freq.entry(k).or_default() += 1);
            }
            let mut keys: Vec<(&str, usize)> = freq.into_iter().collect();
            keys.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
            std::iter::once("file".to_string())
                .chain(keys.into_iter().take(5).map(|(k, _)| k.to_string()))
                .collect()
        } else {
            q.columns.clone()
        };
        let rows = hits
            .into_iter()
            .map(|(p, m)| Row {
                path: p.clone(),
                cells: columns.iter().map(|c| values(c, p, *m).join(", ")).collect(),
            })
            .collect();
        Ok(Table { columns, rows, total })
    }
}

/// The table as Markdown, for agents.
pub fn to_markdown(t: &Table) -> String {
    if t.rows.is_empty() {
        return "No matching notes.".into();
    }
    let esc = |s: &str| s.replace('|', "\\|").replace('\n', " ");
    let mut out = format!(
        "| path | {} |\n|---|{}\n",
        t.columns.iter().map(|c| esc(c)).collect::<Vec<_>>().join(" | "),
        "---|".repeat(t.columns.len())
    );
    for r in &t.rows {
        out.push_str(&format!(
            "| {} | {} |\n",
            esc(&r.path),
            r.cells.iter().map(|c| esc(c)).collect::<Vec<_>>().join(" | ")
        ));
    }
    if t.total > t.rows.len() {
        out.push_str(&format!("\n{} more not shown (raise `limit`).", t.total - t.rows.len()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;

    #[test]
    fn parses_queries() {
        let q = parse("from: #project, work/\nwhere: status != done\nwhere: due exists\nwhere: title contains plan\nsort: due desc\ncolumns: status, due\nlimit: 5").unwrap();
        assert_eq!(q.from, [Source::Tag("project".into()), Source::Folder("work".into())]);
        assert_eq!(
            q.conds[0],
            Cond {
                field: "status".into(),
                op: Op::Ne,
                value: "done".into()
            }
        );
        assert_eq!(q.conds[1].op, Op::Exists);
        assert_eq!(q.conds[2].op, Op::Contains);
        assert_eq!(q.sort, Some(("due".into(), true)));
        assert_eq!((q.columns.len(), q.limit), (2, 5));
        assert!(parse("where: status").is_err(), "no operator");
        assert!(parse("where: status =").is_err(), "no value");
        assert!(parse("select: *").is_err(), "unknown line");
        assert!(parse("limit: lots").is_err());
        assert_eq!(parse("limit: 999999").unwrap().limit, MAX_LIMIT);
    }

    #[test]
    fn evaluates_queries() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write(
            "work/a.md",
            "---\nstatus: active\ndue: 2026-11-01\npriority: 10\ntags: [project]\n---\nA",
        )
        .unwrap();
        v.write("work/b.md", "---\nstatus: done\ndue: 2026-10-01\npriority: 9\n---\nB #project/sub")
            .unwrap();
        v.write("c.md", "---\nstatus: active\npriority: 2\n---\nC #project").unwrap();
        v.write("d.md", "no properties").unwrap();
        let mut ix = Index::open(&v).unwrap();
        ix.sync(&v).unwrap();
        let run = |q: &str| ix.query(&parse(q).unwrap()).unwrap();
        let paths = |t: &Table| t.rows.iter().map(|r| r.path.clone()).collect::<Vec<_>>();

        assert_eq!(
            paths(&run("from: #project")),
            ["c.md", "work/a.md", "work/b.md"],
            "nested tags count"
        );
        assert_eq!(paths(&run("from: work")), ["work/a.md", "work/b.md"]);
        assert_eq!(
            paths(&run("where: status = ACTIVE\nsort: priority")),
            ["c.md", "work/a.md"],
            "numeric sort, case-insensitive match"
        );
        assert_eq!(paths(&run("where: priority > 9")), ["work/a.md"], "10 > 9 numerically, not as text");
        assert_eq!(paths(&run("where: due missing")), ["c.md", "d.md"]);
        assert_eq!(
            paths(&run("sort: due desc")),
            ["work/a.md", "work/b.md", "c.md", "d.md"],
            "missing values last"
        );
        assert_eq!(paths(&run("where: status != done\nwhere: due < 2026-12-01")), ["work/a.md"]);

        let t = run("from: work\ncolumns: file, status, tags\nlimit: 1");
        assert_eq!(t.columns, ["file", "status", "tags"]);
        assert_eq!(t.rows[0].cells, ["a", "active", "project"]);
        assert_eq!(t.total, 2);
        assert!(to_markdown(&t).contains("1 more not shown"));
        assert_eq!(run("from: work").columns[0], "file", "default columns start with the file");
    }

    #[test]
    fn dates() {
        assert_eq!(format_ms(0), "1970-01-01 00:00");
        assert_eq!(format_ms(1_792_040_000_000), "2026-10-15 04:53");
    }
}
