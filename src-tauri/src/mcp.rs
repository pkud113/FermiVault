//! MCP server over stdio (newline-delimited JSON-RPC 2.0). AI apps spawn
//! `fermivault mcp --vault <path>`. It runs in its own process and shares the
//! index with the GUI through SQLite WAL, so agent traffic never touches the UI.

use crate::index::Index;
use crate::parse::section_range;
use crate::vault::{Res, Vault};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

const INSTRUCTIONS: &str = "FermiVault is a folder of Markdown notes. Notes link with [[Note name]] or \
[[folder/Note|alias]] and use #tags and YAML frontmatter. Paths are vault-relative (e.g. 'projects/Plan.md'); \
tools also accept a bare note name. Prefer `search` then `read_note` with `section` to save tokens. \
Prefer `edit_note` (str_replace/append/replace_section) over full rewrites. Every write is snapshotted so the user can undo it.";

pub struct Server {
    vault: Vault,
    ix: Index,
    last_sync: Option<Instant>,
}

fn tools() -> Value {
    let s = |props: Value, req: &[&str]| json!({"type": "object", "properties": props, "required": req});
    json!([
        {"name": "search", "description": "Search all notes by keywords and meaning (hybrid full-text + semantic). Returns paths with matching snippets.",
         "inputSchema": s(json!({"query": {"type": "string"}, "limit": {"type": "integer", "default": 10}}), &["query"])},
        {"name": "read_note", "description": "Read a note, or only one section of it by heading text.",
         "inputSchema": s(json!({"path": {"type": "string", "description": "Path or note name"},
                                 "section": {"type": "string", "description": "Heading text; returns just that section"}}), &["path"])},
        {"name": "list_notes", "description": "List note paths, newest first, optionally inside a folder.",
         "inputSchema": s(json!({"folder": {"type": "string"}, "limit": {"type": "integer", "default": 200}}), &[])},
        {"name": "recent_changes", "description": "Notes modified in the last N hours, newest first. Use to catch up on what changed.",
         "inputSchema": s(json!({"hours": {"type": "number", "default": 24}, "limit": {"type": "integer", "default": 50}}), &[])},
        {"name": "links", "description": "Outgoing links of a note (resolved or missing) and backlinks with the line that links.",
         "inputSchema": s(json!({"path": {"type": "string"}}), &["path"])},
        {"name": "related", "description": "Notes most similar in meaning to a note (needs semantic search enabled in FermiVault). Use to find link candidates.",
         "inputSchema": s(json!({"path": {"type": "string"}, "limit": {"type": "integer", "default": 10}}), &["path"])},
        {"name": "query", "description": "Find notes by their frontmatter properties and tags, as a table. One clause per line: `from: #tag, folder/` (any match), `where: <field> <op> <value>` (repeatable, all must hold; ops = != < <= > >= contains exists missing), `sort: <field> [desc]`, `columns: a, b`, `limit: N`. Fields: any property plus file, path, folder, modified, tags. Example: \"from: #project\nwhere: status != done\nsort: due\ncolumns: status, due\".",
         "inputSchema": s(json!({"query": {"type": "string"}}), &["query"])},
        {"name": "tags", "description": "Without `tag`: all tags with counts. With `tag`: notes having it (nested tags included).",
         "inputSchema": s(json!({"tag": {"type": "string"}}), &[])},
        {"name": "create_note", "description": "Create a new note. Fails if it already exists.",
         "inputSchema": s(json!({"path": {"type": "string"}, "content": {"type": "string"}}), &["path", "content"])},
        {"name": "edit_note", "description": "Edit an existing note. Modes: append (add content at end), str_replace (replace the unique text `old` with `content`), replace_section (replace the body under heading `section`), replace (whole note).",
         "inputSchema": s(json!({"path": {"type": "string"},
                                 "mode": {"type": "string", "enum": ["append", "str_replace", "replace_section", "replace"]},
                                 "content": {"type": "string"}, "old": {"type": "string"}, "section": {"type": "string"}}),
                          &["path", "mode", "content"])},
        {"name": "rename_note", "description": "Rename or move a note and update every link pointing to it.",
         "inputSchema": s(json!({"from": {"type": "string"}, "to": {"type": "string"}}), &["from", "to"])}
    ])
}

fn arg<'a>(a: &'a Value, k: &str) -> Res<&'a str> {
    a.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string argument `{k}`"))
}

fn with_md(p: &str) -> String {
    if p.ends_with(".md") { p.to_string() } else { format!("{p}.md") }
}

impl Server {
    pub fn new(vault: Vault) -> Res<Self> {
        let ix = Index::open(&vault)?;
        Ok(Self {
            vault,
            ix,
            last_sync: None,
        })
    }

    /// Picks up edits made elsewhere (GUI, other agents, the user's editor).
    /// Throttled: an mtime scan is cheap but not free on huge vaults.
    fn sync(&mut self) -> Res<()> {
        if self.last_sync.is_none_or(|t| t.elapsed() > Duration::from_secs(2)) {
            self.ix.sync(&self.vault)?;
            self.last_sync = Some(Instant::now());
        }
        Ok(())
    }

    /// Static guidance plus this vault's conventions, so agents file notes the way the user does.
    fn instructions(&self) -> String {
        let c = self.vault.config();
        let folder = |k: &str, d: &str| c.get(k).and_then(Value::as_str).unwrap_or(d).to_string();
        format!(
            "{INSTRUCTIONS} In this vault, daily notes are `{}/YYYY-MM-DD.md` and templates live in `{}/`.",
            folder("dailyFolder", "daily"),
            folder("templatesFolder", "templates")
        )
    }

    /// Accepts a path or a bare note name; returns an existing note's path.
    fn existing(&self, p: &str) -> Res<String> {
        let md = with_md(p);
        if self.vault.abs(&md)?.is_file() {
            return Ok(md);
        }
        self.ix.resolve(p)?.ok_or_else(|| format!("note not found: {p}"))
    }

    /// Embeds chunks changed since the app last ran (bounded, so a query never stalls).
    fn embed_new(&mut self) {
        if crate::embed::installed() {
            for _ in 0..32 {
                if !matches!(self.ix.embed_pending(128), Ok(n) if n > 0) {
                    break;
                }
            }
        }
    }

    fn written(&mut self, path: &str) -> Res<()> {
        self.ix.refresh(&self.vault, path)
    }

    pub fn call(&mut self, name: &str, a: &Value) -> Res<String> {
        self.sync()?;
        let n = |k: &str, d: u64| a.get(k).and_then(Value::as_u64).unwrap_or(d) as usize;
        match name {
            "search" => {
                self.embed_new();
                let hits = self.ix.hybrid(arg(a, "query")?, n("limit", 10))?;
                if hits.is_empty() {
                    return Ok("No matches.".into());
                }
                Ok(hits
                    .iter()
                    .map(|h| format!("- {}: {}", h.path, h.snippet.replace('\n', " ")))
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            "read_note" => {
                let path = self.existing(arg(a, "path")?)?;
                let text = self.vault.read(&path)?;
                match a.get("section").and_then(Value::as_str) {
                    Some(h) => {
                        let (s, e) = section_range(&text, h).ok_or_else(|| format!("no heading `{h}` in {path}"))?;
                        Ok(text[s..e].to_string())
                    }
                    None => Ok(text),
                }
            }
            "list_notes" => {
                let rows = self
                    .ix
                    .list(a.get("folder").and_then(Value::as_str).unwrap_or(""), 0, n("limit", 200))?;
                Ok(rows.into_iter().map(|r| r.0).collect::<Vec<_>>().join("\n"))
            }
            "recent_changes" => {
                let hours = a.get("hours").and_then(Value::as_f64).unwrap_or(24.0);
                let since = crate::vault::now_ms() as i64 - (hours * 3_600_000.0) as i64;
                let rows = self.ix.list("", since, n("limit", 50))?;
                let now = crate::vault::now_ms() as i64;
                Ok(rows
                    .iter()
                    .map(|(p, m)| format!("- {p} ({} min ago)", (now - m) / 60_000))
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            "links" => {
                let path = self.existing(arg(a, "path")?)?;
                let mut out = vec![format!("Outgoing from {path}:")];
                for (t, p) in self.ix.outgoing(&path)? {
                    out.push(match p {
                        Some(p) => format!("- {p}"),
                        None => format!("- {t} (missing note)"),
                    });
                }
                out.push("Backlinks:".into());
                for l in self.ix.backlinks(&path)? {
                    out.push(format!("- {}:{}: {}", l.path, l.line, l.context));
                }
                Ok(out.join("\n"))
            }
            "related" => {
                self.embed_new();
                let path = self.existing(arg(a, "path")?)?;
                let rel = self.ix.related(&path, n("limit", 10))?;
                if rel.is_empty() {
                    return Ok("No related notes (semantic search may be off in FermiVault settings).".into());
                }
                Ok(rel.iter().map(|(p, s)| format!("- {p} ({s:.2})")).collect::<Vec<_>>().join("\n"))
            }
            "query" => {
                let q = crate::query::parse(arg(a, "query")?)?;
                Ok(crate::query::to_markdown(&self.ix.query(&q)?))
            }
            "tags" => match a.get("tag").and_then(Value::as_str) {
                Some(t) => Ok(self.ix.tagged(t)?.join("\n")),
                None => Ok(self
                    .ix
                    .tags()?
                    .iter()
                    .map(|(t, c)| format!("#{t} ({c})"))
                    .collect::<Vec<_>>()
                    .join("\n")),
            },
            "create_note" => {
                let path = with_md(arg(a, "path")?);
                let _lock = self.vault.lock()?;
                self.vault.create(&path, arg(a, "content")?)?;
                self.written(&path)?;
                Ok(format!("Created {path}"))
            }
            "edit_note" => {
                let path = self.existing(arg(a, "path")?)?;
                let content = arg(a, "content")?;
                // Read, change and write as one step: another agent or the app can't slip a write in between.
                let _lock = self.vault.lock()?;
                let text = self.vault.read(&path)?;
                let new = match arg(a, "mode")? {
                    "append" => {
                        let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
                        format!("{text}{sep}{content}")
                    }
                    "replace" => content.to_string(),
                    "str_replace" => {
                        let old = arg(a, "old")?;
                        match text.matches(old).count() {
                            1 => text.replacen(old, content, 1),
                            0 => return Err(format!("`old` text not found in {path}")),
                            c => return Err(format!("`old` text appears {c} times in {path}; include more context")),
                        }
                    }
                    "replace_section" => {
                        let h = arg(a, "section")?;
                        let (s, e) = section_range(&text, h).ok_or_else(|| format!("no heading `{h}` in {path}"))?;
                        // Keep the heading line itself; replace only its body.
                        let body_start = text[s..e].find('\n').map_or(e, |i| s + i + 1);
                        let tail = if content.ends_with('\n') || e == text.len() { "" } else { "\n" };
                        format!("{}{content}{tail}{}", &text[..body_start], &text[e..])
                    }
                    m => return Err(format!("unknown mode `{m}`")),
                };
                self.vault.snapshot(&path, 0)?;
                self.vault.write(&path, &new)?;
                self.written(&path)?;
                Ok(format!("Updated {path}"))
            }
            "rename_note" => {
                let from = self.existing(arg(a, "from")?)?;
                let to = with_md(arg(a, "to")?);
                let _lock = self.vault.lock()?;
                let n = self.ix.rename_note(&self.vault, &from, &to)?;
                Ok(format!("Renamed {from} -> {to}; updated links in {n} note(s)"))
            }
            _ => Err(format!("unknown tool `{name}`")),
        }
    }

    /// Handles one JSON-RPC message; `None` for notifications.
    pub fn handle(&mut self, msg: &Value) -> Option<Value> {
        let id = msg.get("id")?.clone();
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let result = match msg.get("method").and_then(Value::as_str).unwrap_or("") {
            "initialize" => json!({
                "protocolVersion": params.get("protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fermivault", "version": env!("CARGO_PKG_VERSION")},
                "instructions": self.instructions(),
            }),
            "ping" => json!({}),
            "tools/list" => json!({"tools": tools()}),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let (text, is_error) = match self.call(name, &args) {
                    Ok(t) => (t, false),
                    Err(e) => (e, true),
                };
                json!({"content": [{"type": "text", "text": text}], "isError": is_error})
            }
            m => return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("method not found: {m}")}})),
        };
        Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }
}

pub fn serve(vault: Vault) -> Res<()> {
    let mut server = Server::new(vault)?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(crate::vault::err)?;
        let line = line.trim_start_matches('\u{feff}'); // some Windows shells prepend a BOM
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(line) {
            Ok(msg) => server.handle(&msg),
            Err(e) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}})),
        };
        if let Some(r) = reply {
            writeln!(stdout, "{r}").and_then(|_| stdout.flush()).map_err(crate::vault::err)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(s: &mut Server, name: &str, args: Value) -> (String, bool) {
        let r = s
            .handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}))
            .unwrap();
        (
            r["result"]["content"][0]["text"].as_str().unwrap().to_string(),
            r["result"]["isError"].as_bool().unwrap(),
        )
    }

    /// Two agents (separate servers, as separate processes would be) appending to one note:
    /// every edit must survive.
    #[test]
    fn concurrent_agents_lose_no_edits() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write(
            "Log.md", "# Log
",
        )
        .unwrap();
        let barrier = std::sync::Barrier::new(2);
        let servers: Vec<_> = (0..2).map(|_| Server::new(v.clone()).unwrap()).collect();
        std::thread::scope(|s| {
            for (agent, mut srv) in servers.into_iter().enumerate() {
                let barrier = &barrier;
                s.spawn(move || {
                    barrier.wait();
                    for i in 0..25 {
                        let (msg, failed) = call(
                            &mut srv,
                            "edit_note",
                            json!({"path": "Log", "mode": "append", "content": format!("a{agent}-{i}
")}),
                        );
                        assert!(!failed, "{msg}");
                    }
                });
            }
        });
        let text = v.read("Log.md").unwrap();
        for agent in 0..2 {
            for i in 0..25 {
                assert!(
                    text.contains(&format!(
                        "a{agent}-{i}
"
                    )),
                    "lost a{agent}-{i}"
                );
            }
        }
    }

    /// One agent edits while another renames the note: every edit that reports success is in
    /// the renamed note, the rest fail loudly, and the old path is never recreated.
    #[test]
    fn rename_during_edits_loses_nothing() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write("Doc.md", "start\n").unwrap();
        let (mut editor, mut renamer) = (Server::new(v.clone()).unwrap(), Server::new(v.clone()).unwrap());
        let barrier = std::sync::Barrier::new(2);
        let ok: Vec<String> = std::thread::scope(|s| {
            let edits = s.spawn(|| {
                barrier.wait();
                (0..40)
                    .map(|i| format!("e{i}\n"))
                    .filter(|line| {
                        !call(
                            &mut editor,
                            "edit_note",
                            json!({"path": "Doc.md", "mode": "append", "content": line}),
                        )
                        .1
                    })
                    .collect()
            });
            barrier.wait();
            std::thread::sleep(std::time::Duration::from_millis(5));
            assert!(!call(&mut renamer, "rename_note", json!({"from": "Doc", "to": "Moved"})).1);
            edits.join().unwrap()
        });
        let text = v.read("Moved.md").unwrap();
        assert!(ok.iter().all(|line| text.contains(line.as_str())), "a reported edit went missing");
        assert!(v.read("Doc.md").is_err(), "the old path must not come back");
    }

    #[test]
    fn protocol_and_tools() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write("Home.md", "# Home\nintro\n## Tasks\n- a\n## Notes\nn\n").unwrap();
        let mut s = Server::new(v.clone()).unwrap();

        let init = s
            .handle(&json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}))
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(init["result"]["instructions"].as_str().unwrap().contains("`daily/YYYY-MM-DD.md`"));
        v.set_config(&json!({"dailyFolder": "journal"})).unwrap();
        let init = s
            .handle(&json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}))
            .unwrap();
        assert!(init["result"]["instructions"].as_str().unwrap().contains("`journal/YYYY-MM-DD.md`"));
        assert!(
            s.handle(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
                .is_none()
        );
        let list = s.handle(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 11);

        assert_eq!(
            call(&mut s, "read_note", json!({"path": "home", "section": "Tasks"})).0,
            "## Tasks\n- a\n"
        );
        assert!(
            call(&mut s, "create_note", json!({"path": "Idea", "content": "links to [[Home]]"}))
                .0
                .contains("Idea.md")
        );
        assert!(
            call(&mut s, "create_note", json!({"path": "Idea", "content": "x"})).1,
            "no overwrite"
        );
        assert!(call(&mut s, "search", json!({"query": "links"})).0.contains("Idea.md"));
        call(
            &mut s,
            "create_note",
            json!({"path": "Task", "content": "---
status: open
---
"}),
        );
        let table = call(
            &mut s,
            "query",
            json!({"query": "where: status = open
columns: status"}),
        );
        assert!(table.0.contains("| Task.md | open |"), "{}", table.0);
        assert!(
            call(&mut s, "query", json!({"query": "where: status"})).1,
            "bad query is an error, not a crash"
        );
        assert!(
            call(&mut s, "links", json!({"path": "Home.md"}))
                .0
                .contains("Idea.md:1: links to [[Home]]")
        );

        call(
            &mut s,
            "edit_note",
            json!({"path": "Home", "mode": "replace_section", "section": "Tasks", "content": "- b"}),
        );
        assert_eq!(v.read("Home.md").unwrap(), "# Home\nintro\n## Tasks\n- b\n## Notes\nn\n");
        assert!(
            call(
                &mut s,
                "edit_note",
                json!({"path": "Home", "mode": "str_replace", "old": "n", "content": "x"})
            )
            .1,
            "ambiguous"
        );
        call(
            &mut s,
            "edit_note",
            json!({"path": "Home", "mode": "str_replace", "old": "- b", "content": "- c"}),
        );
        call(&mut s, "edit_note", json!({"path": "Home", "mode": "append", "content": "end"}));
        assert!(v.read("Home.md").unwrap().ends_with("- c\n## Notes\nn\nend"));
        assert_eq!(v.snapshots("Home.md").len(), 3);

        assert!(call(&mut s, "read_note", json!({"path": "../secret"})).1);
        if cfg!(windows) {
            // A drive-relative name must not resolve against the process's working directory.
            assert!(call(&mut s, "create_note", json!({"path": "safe/C:outside", "content": "x"})).1);
            assert!(call(&mut s, "read_note", json!({"path": "safe/C:outside.md"})).1);
            assert!(!std::path::Path::new("outside.md").exists());
        }
        assert!(
            call(&mut s, "rename_note", json!({"from": "Home", "to": "Start"}))
                .0
                .contains("1 note")
        );
        assert_eq!(v.read("Idea.md").unwrap(), "links to [[Start]]");
    }
}
