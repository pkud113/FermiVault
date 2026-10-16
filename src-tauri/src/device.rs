//! Per-vault settings kept on this device, outside the vault: the ones that grant something
//! (plugin permissions, running Git). A vault someone shares, with its `.fermi/` folder, can't
//! arrive with them switched on, because copies of these keys in `.fermi/config.json` are ignored.

use crate::vault::{Res, err};
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Mutex;

/// Keys stored per device. `gitTrusted` is set only by setting up Git (see `git_init`).
pub const KEYS: [&str; 3] = ["plugins", "gitAutoSync", "gitTrusted"];

static FILE: Mutex<()> = Mutex::new(());

fn read_all(file: &Path) -> Map<String, Value> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// This device's settings for the vault at `root`.
pub fn get(file: &Path, root: &str) -> Map<String, Value> {
    let _g = FILE.lock().unwrap();
    match read_all(file).remove(root) {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// Merges `patch` into the settings for `root` (`null` removes a key).
pub fn update(file: &Path, root: &str, patch: Map<String, Value>) -> Res<()> {
    let _g = FILE.lock().unwrap();
    let mut all = read_all(file);
    let entry = all.entry(root).or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    let m = entry.as_object_mut().unwrap();
    for (k, v) in patch {
        if v.is_null() {
            m.remove(&k);
        } else {
            m.insert(k, v);
        }
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&all).map_err(err)?).map_err(err)?;
    std::fs::rename(tmp, file).map_err(err)
}

/// Takes the device keys out of a vault config (the rest stays in the vault).
pub fn split(config: &mut Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(m) = config.as_object_mut() {
        for k in KEYS {
            if let Some(v) = m.remove(k) {
                out.insert(k.into(), v);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn device_settings_stay_out_of_the_vault() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("cfg").join("vaults.json");
        // What a shared vault might carry: ignored.
        let mut shared = json!({ "bookmarks": ["a.md"], "plugins": { "x": { "enabled": true } }, "gitAutoSync": 5, "gitTrusted": true });
        let carried = split(&mut shared);
        assert_eq!(shared, json!({ "bookmarks": ["a.md"] }));
        assert_eq!(carried.len(), 3);
        assert!(get(&file, "/v").is_empty());

        update(&file, "/v", json!({ "gitAutoSync": 15, "gitTrusted": true }).as_object().unwrap().clone()).unwrap();
        update(&file, "/other", json!({ "gitAutoSync": 5 }).as_object().unwrap().clone()).unwrap();
        update(&file, "/v", json!({ "gitTrusted": null }).as_object().unwrap().clone()).unwrap();
        assert_eq!(Value::Object(get(&file, "/v")), json!({ "gitAutoSync": 15 }));
        assert_eq!(Value::Object(get(&file, "/other")), json!({ "gitAutoSync": 5 }));
    }
}
