//! Detects installed AI apps and adds/removes FermiVault as an MCP server in their
//! config. Only runs on an explicit user click; the original file is backed up
//! next to itself as `<file>.fermivault-backup` before every change.

use crate::vault::{Res, err};
use serde::Serialize;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

const NAME: &str = "fermivault";

#[derive(Clone, Copy)]
enum Fmt {
    /// JSON object under `key`; `typed` adds `"type": "stdio"` (VS Code, Claude Code).
    Json {
        key: &'static str,
        typed: bool,
    },
    Toml,
}

struct Client {
    id: &'static str,
    name: &'static str,
    file: PathBuf,
    /// Exists when the app is installed, even before it has an MCP config.
    marker: PathBuf,
    fmt: Fmt,
}

#[derive(Serialize)]
pub struct Status {
    pub id: &'static str,
    pub name: &'static str,
    pub file: String,
    pub detected: bool,
    pub connected: bool,
    /// Vault the existing entry points at, if any.
    pub vault: Option<String>,
}

fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

/// Per-user app config dir: %APPDATA%, ~/Library/Application Support, or ~/.config.
fn config_dir() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData/Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".config"))
    }
}

fn clients() -> Vec<Client> {
    // Join per segment so Windows paths use backslashes throughout.
    let at = |base: &Path, rel: &str| rel.split('/').fold(base.to_path_buf(), |p, s| p.join(s));
    let (h, c) = (&home(), &config_dir());
    let json = |key| Fmt::Json { key, typed: false };
    vec![
        Client {
            id: "claude-desktop",
            name: "Claude Desktop",
            file: at(c, "Claude/claude_desktop_config.json"),
            marker: at(c, "Claude"),
            fmt: json("mcpServers"),
        },
        Client {
            id: "claude-code",
            name: "Claude Code",
            file: at(h, ".claude.json"),
            marker: at(h, ".claude"),
            fmt: Fmt::Json {
                key: "mcpServers",
                typed: true,
            },
        },
        Client {
            id: "codex",
            name: "Codex",
            file: at(h, ".codex/config.toml"),
            marker: at(h, ".codex"),
            fmt: Fmt::Toml,
        },
        Client {
            id: "cursor",
            name: "Cursor",
            file: at(h, ".cursor/mcp.json"),
            marker: at(h, ".cursor"),
            fmt: json("mcpServers"),
        },
        Client {
            id: "windsurf",
            name: "Windsurf",
            file: at(h, ".codeium/windsurf/mcp_config.json"),
            marker: at(h, ".codeium/windsurf"),
            fmt: json("mcpServers"),
        },
        Client {
            id: "vscode",
            name: "VS Code",
            file: at(c, "Code/User/mcp.json"),
            marker: at(c, "Code/User"),
            fmt: Fmt::Json {
                key: "servers",
                typed: true,
            },
        },
        Client {
            id: "gemini",
            name: "Gemini CLI",
            file: at(h, ".gemini/settings.json"),
            marker: at(h, ".gemini"),
            fmt: json("mcpServers"),
        },
        Client {
            id: "lmstudio",
            name: "LM Studio",
            file: at(h, ".lmstudio/mcp.json"),
            marker: at(h, ".lmstudio"),
            fmt: json("mcpServers"),
        },
    ]
}

fn launch(vault: &str) -> Res<(String, Vec<String>)> {
    let exe = std::env::current_exe().map_err(err)?.to_string_lossy().into_owned();
    Ok((exe, vec!["mcp".into(), "--vault".into(), vault.into()]))
}

fn read_or_empty(file: &Path) -> Res<String> {
    match fs::read_to_string(file) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

/// The vault our entry in `text` points at; `Some(None)` if present but unparseable.
fn existing_vault(text: &str, fmt: Fmt) -> Option<Option<String>> {
    let args: Vec<String> = match fmt {
        Fmt::Json { key, .. } => {
            let v: Value = serde_json::from_str(text).ok()?;
            let e = v.get(key)?.get(NAME)?;
            e.get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default()
        }
        Fmt::Toml => {
            let d: toml_edit::DocumentMut = text.parse().ok()?;
            let e = d.get("mcp_servers")?.get(NAME)?;
            e.get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default()
        }
    };
    Some(args.iter().position(|a| a == "--vault").and_then(|i| args.get(i + 1).cloned()))
}

/// New file contents with our entry set (`Some`) or removed (`None`).
fn rewrite(text: &str, fmt: Fmt, entry: Option<&(String, Vec<String>)>) -> Res<String> {
    match fmt {
        Fmt::Json { key, typed } => {
            let mut root: Value = if text.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(text).map_err(|e| format!("not valid JSON, left untouched: {e}"))?
            };
            let obj = root.as_object_mut().ok_or("config root is not a JSON object")?;
            match entry {
                Some((cmd, args)) => {
                    let mut e = json!({"command": cmd, "args": args});
                    if typed {
                        e.as_object_mut().unwrap().insert("type".into(), json!("stdio"));
                    }
                    let servers = obj.entry(key).or_insert_with(|| json!({}));
                    servers
                        .as_object_mut()
                        .ok_or(format!("`{key}` is not an object"))?
                        .insert(NAME.into(), e);
                }
                None => {
                    if let Some(s) = obj.get_mut(key).and_then(Value::as_object_mut) {
                        s.remove(NAME);
                    }
                }
            }
            Ok(serde_json::to_string_pretty(&root).map_err(err)? + "\n")
        }
        Fmt::Toml => {
            use toml_edit::{Array, DocumentMut, Item, Table, value};
            let mut doc: DocumentMut = text.parse().map_err(|e| format!("not valid TOML, left untouched: {e}"))?;
            match entry {
                Some((cmd, args)) => {
                    if doc.get("mcp_servers").is_none() {
                        let mut t = Table::new();
                        t.set_implicit(true);
                        doc["mcp_servers"] = Item::Table(t);
                    }
                    let mut t = Table::new();
                    t["command"] = value(cmd.as_str());
                    t["args"] = value(args.iter().map(String::as_str).collect::<Array>());
                    doc["mcp_servers"][NAME] = Item::Table(t);
                }
                None => {
                    if let Some(t) = doc.get_mut("mcp_servers").and_then(Item::as_table_mut) {
                        t.remove(NAME);
                    }
                }
            }
            Ok(doc.to_string())
        }
    }
}

fn find(id: &str) -> Res<Client> {
    clients()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("unknown app `{id}`"))
}

pub fn status() -> Vec<Status> {
    clients()
        .into_iter()
        .map(|c| {
            let existing = read_or_empty(&c.file).ok().and_then(|t| existing_vault(&t, c.fmt));
            Status {
                id: c.id,
                name: c.name,
                file: c.file.to_string_lossy().into_owned(),
                detected: c.marker.exists() || c.file.exists(),
                connected: existing.is_some(),
                vault: existing.flatten(),
            }
        })
        .collect()
}

/// What `set(id, Some(vault))` would write, for the confirmation dialog.
pub fn preview(id: &str, vault: &str) -> Res<String> {
    let c = find(id)?;
    let full = rewrite("", c.fmt, Some(&launch(vault)?))?;
    Ok(format!("{}\n\n{}", c.file.display(), full.trim()))
}

/// Connects (`Some(vault)`) or disconnects (`None`) one app.
pub fn set(id: &str, vault: Option<&str>) -> Res<()> {
    let c = find(id)?;
    let text = read_or_empty(&c.file)?;
    let entry = vault.map(launch).transpose()?;
    let new = rewrite(&text, c.fmt, entry.as_ref())?;
    if c.file.exists() {
        let mut bak = c.file.clone().into_os_string();
        bak.push(".fermivault-backup");
        fs::copy(&c.file, bak).map_err(err)?;
    } else if let Some(dir) = c.file.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(&c.file, new).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_roundtrip_preserves_other_servers() {
        let fmt = Fmt::Json {
            key: "mcpServers",
            typed: false,
        };
        let orig = r#"{"z": 1, "mcpServers": {"other": {"command": "x"}}, "a": [1]}"#;
        let e = ("C:/fv.exe".to_string(), vec!["mcp".into(), "--vault".into(), "C:/notes".into()]);
        let added = rewrite(orig, fmt, Some(&e)).unwrap();
        assert_eq!(existing_vault(&added, fmt), Some(Some("C:/notes".into())));
        assert!(added.find("\"z\"").unwrap() < added.find("\"a\"").unwrap(), "key order kept");
        assert!(added.contains("other"));
        let removed = rewrite(&added, fmt, None).unwrap();
        assert_eq!(existing_vault(&removed, fmt), None);
        assert!(removed.contains("other"));
        assert!(rewrite("{broken", fmt, Some(&e)).is_err(), "never clobber unparseable configs");
        let typed = rewrite(
            "",
            Fmt::Json {
                key: "servers",
                typed: true,
            },
            Some(&e),
        )
        .unwrap();
        assert!(typed.contains("\"type\": \"stdio\""));
    }

    #[test]
    fn toml_roundtrip_preserves_comments() {
        let orig = "# my settings\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = \"y\"\n";
        let e = ("fv".to_string(), vec!["mcp".into(), "--vault".into(), "/v".into()]);
        let added = rewrite(orig, Fmt::Toml, Some(&e)).unwrap();
        assert!(added.starts_with("# my settings\nmodel = \"x\""));
        assert!(added.contains("[mcp_servers.fermivault]"));
        assert_eq!(existing_vault(&added, Fmt::Toml), Some(Some("/v".into())));
        let removed = rewrite(&added, Fmt::Toml, None).unwrap();
        assert_eq!(removed, orig);
        let fresh = rewrite("", Fmt::Toml, Some(&e)).unwrap();
        assert!(fresh.starts_with("[mcp_servers.fermivault]"), "{fresh}");
    }
}
