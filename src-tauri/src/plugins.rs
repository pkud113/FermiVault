//! Plugins live in `<vault>/.fermi/plugins/<id>/` as `manifest.json` plus `main.js`. Rust only
//! lists and reads them; they run in sandboxed Web Workers in the frontend (`plugins.ts`), which
//! have no access to the app's IPC and can only ask it for what the user allowed.

use crate::vault::{Res, Vault, err};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

const MAX_SOURCE: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Debug)]
pub struct Plugin {
    /// The folder name.
    pub id: String,
    pub manifest: Value,
    /// Why it can't be used, if it can't.
    pub error: Option<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn dir(vault: &Vault) -> PathBuf {
    vault.dot_dir().join("plugins")
}

/// Every plugin folder with its manifest (or the reason it's unusable).
pub fn list(vault: &Vault) -> Vec<Plugin> {
    let Ok(rd) = fs::read_dir(dir(vault)) else { return vec![] };
    let mut out: Vec<Plugin> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) // real folders only, no links
        .map(|e| {
            let id = e.file_name().to_string_lossy().into_owned();
            let manifest = fs::read_to_string(e.path().join("manifest.json"))
                .map_err(|_| "manifest.json is missing".to_string())
                .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("manifest.json: {e}")))
                .and_then(|m| {
                    if m.is_object() {
                        Ok(m)
                    } else {
                        Err("manifest.json must be an object".into())
                    }
                });
            let error = if !valid_id(&id) {
                Some("folder name may only use letters, digits, - and _".into())
            } else {
                manifest.as_ref().err().cloned()
            };
            Plugin {
                id,
                manifest: manifest.unwrap_or(Value::Null),
                error,
            }
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// A plugin's `main.js`.
pub fn source(vault: &Vault, id: &str) -> Res<String> {
    if !valid_id(id) {
        return Err(format!("invalid plugin id: {id}"));
    }
    let p = dir(vault).join(id).join("main.js");
    let meta = fs::symlink_metadata(&p).map_err(|_| format!("{id}: main.js is missing"))?;
    if !meta.is_file() || meta.len() > MAX_SOURCE {
        return Err(format!("{id}: main.js must be a regular file under 2 MB"));
    }
    fs::read_to_string(p).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_and_reads_plugins() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        let p = dir(&v);
        for (id, manifest) in [
            ("good", r#"{"name":"Good","permissions":["read"]}"#),
            ("broken", "{nope"),
            ("bad id!", "{}"),
            ("array", "[]"),
        ] {
            fs::create_dir_all(p.join(id)).unwrap();
            fs::write(p.join(id).join("manifest.json"), manifest).unwrap();
        }
        fs::write(p.join("good").join("main.js"), "fermi.notice('hi')").unwrap();
        fs::create_dir_all(p.join("empty")).unwrap();
        let l = list(&v);
        let by = |id: &str| l.iter().find(|x| x.id == id).unwrap();
        assert_eq!(by("good").manifest["name"], "Good");
        assert!(by("good").error.is_none());
        assert!(by("broken").error.as_ref().unwrap().contains("manifest.json"));
        assert!(by("bad id!").error.is_some());
        assert!(by("array").error.is_some());
        assert!(by("empty").error.as_ref().unwrap().contains("missing"));
        assert_eq!(source(&v, "good").unwrap(), "fermi.notice('hi')");
        for bad in ["../good", "good/../x", "", "a b"] {
            assert!(source(&v, bad).is_err(), "{bad}");
        }
        assert!(source(&v, "broken").unwrap_err().contains("missing"));
    }
}
