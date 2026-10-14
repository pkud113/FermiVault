//! Filesystem access, confined to the vault root. Every path from the UI or an
//! agent goes through `abs()`, which is the trust boundary.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub type Res<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub path: String,
    pub dir: bool,
}

#[derive(Serialize, Debug)]
pub struct Snapshot {
    pub id: String,
    /// Unix ms when taken.
    pub time: i64,
    pub size: u64,
}

const SNAPSHOTS_KEPT: usize = 50;

#[derive(Clone)]
pub struct Vault {
    pub root: PathBuf,
}

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

/// Sortable, collision-free stamp (GUI and MCP processes may write in the same ms).
fn stamp() -> String {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    format!(
        "{}-{}-{}",
        now_ms(),
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

pub fn mtime(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

impl Vault {
    pub fn new(root: impl Into<PathBuf>) -> Res<Self> {
        let root: PathBuf = root.into();
        let root = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
        // Windows canonical paths are `\\?\C:\...`; keep the plain form users and AI-app configs expect.
        let root = match root.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
            Some(plain) if !plain.starts_with("UNC\\") => PathBuf::from(plain),
            _ => root,
        };
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        fs::create_dir_all(root.join(".fermi")).map_err(err)?;
        Ok(Self { root })
    }

    pub fn dot_dir(&self) -> PathBuf {
        self.root.join(".fermi")
    }

    /// Vault-relative `rel` to an absolute path; rejects anything escaping the root
    /// or touching hidden (dot) folders such as `.fermi`.
    pub fn abs(&self, rel: &str) -> Res<PathBuf> {
        let p = Path::new(rel);
        let mut out = self.root.clone();
        for c in p.components() {
            match c {
                Component::Normal(s) if !s.to_string_lossy().starts_with('.') => out.push(s),
                Component::CurDir => {}
                _ => return Err(format!("invalid path: {rel}")),
            }
        }
        if out == self.root {
            return Err("empty path".into());
        }
        Ok(out)
    }

    pub fn rel(&self, abs: &Path) -> Option<String> {
        let r = abs.strip_prefix(&self.root).ok()?;
        if r.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
            return None;
        }
        Some(r.to_string_lossy().replace('\\', "/"))
    }

    /// All files and folders, skipping dot-entries, sorted folders-first per level.
    pub fn entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        self.walk(&self.root, &mut out);
        out
    }

    fn walk(&self, dir: &Path, out: &mut Vec<Entry>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut items: Vec<_> = rd.flatten().filter(|e| !e.file_name().to_string_lossy().starts_with('.')).collect();
        items.sort_by_key(|e| (!e.path().is_dir(), e.file_name().to_string_lossy().to_lowercase()));
        for e in items {
            let path = e.path();
            let dir = path.is_dir();
            if let Some(rel) = self.rel(&path) {
                out.push(Entry { path: rel, dir });
            }
            if dir {
                self.walk(&path, out);
            }
        }
    }

    /// (rel path, mtime ms) for every markdown note.
    pub fn notes(&self) -> Vec<(String, i64)> {
        self.entries()
            .into_iter()
            .filter(|e| !e.dir && e.path.ends_with(".md"))
            .filter_map(|e| {
                let m = mtime(&fs::metadata(self.abs(&e.path).ok()?).ok()?);
                Some((e.path, m))
            })
            .collect()
    }

    pub fn read(&self, rel: &str) -> Res<String> {
        fs::read_to_string(self.abs(rel)?).map_err(|e| format!("{rel}: {e}"))
    }

    /// Atomic write (temp file + rename) so a crash never leaves a half-written note.
    pub fn write(&self, rel: &str, content: &str) -> Res<()> {
        let p = self.abs(rel)?;
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let tmp = self.dot_dir().join(format!("write-{}.tmp", stamp()));
        fs::write(&tmp, content).map_err(err)?;
        fs::rename(&tmp, &p).map_err(err)
    }

    pub fn create(&self, rel: &str, content: &str) -> Res<()> {
        if self.abs(rel)?.exists() {
            return Err(format!("{rel} already exists"));
        }
        self.write(rel, content)
    }

    /// `.fermi/snapshots/<encoded path>/`: one folder per note, so listing is exact.
    fn snapshot_dir(&self, rel: &str) -> PathBuf {
        self.dot_dir().join("snapshots").join(rel.replace('%', "%25").replace('/', "%2F"))
    }

    /// Copies the current file into its snapshot folder (keeping the newest
    /// `SNAPSHOTS_KEPT`). Agents snapshot before every write; the editor at most
    /// once per `min_gap_ms` while typing.
    pub fn snapshot(&self, rel: &str, min_gap_ms: i64) -> Res<()> {
        let src = self.abs(rel)?;
        if !src.is_file() {
            return Ok(());
        }
        let existing = self.snapshots(rel);
        if existing.first().is_some_and(|s| now_ms() as i64 - s.time < min_gap_ms) {
            return Ok(());
        }
        let dir = self.snapshot_dir(rel);
        fs::create_dir_all(&dir).map_err(err)?;
        fs::copy(&src, dir.join(format!("{}.md", stamp()))).map_err(err)?;
        for old in existing.iter().skip(SNAPSHOTS_KEPT - 1) {
            let _ = fs::remove_file(dir.join(format!("{}.md", old.id)));
        }
        Ok(())
    }

    /// Snapshots of `rel`, newest first.
    pub fn snapshots(&self, rel: &str) -> Vec<Snapshot> {
        let Ok(rd) = fs::read_dir(self.snapshot_dir(rel)) else {
            return vec![];
        };
        let mut out: Vec<Snapshot> = rd
            .flatten()
            .filter_map(|e| {
                let id = e.file_name().to_string_lossy().strip_suffix(".md")?.to_string();
                let time = id.split('-').next()?.parse().ok()?;
                Some(Snapshot {
                    size: e.metadata().ok()?.len(),
                    id,
                    time,
                })
            })
            .collect();
        let key = |s: &Snapshot| s.id.split('-').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
        out.sort_by_key(|s| std::cmp::Reverse(key(s)));
        out
    }

    pub fn read_snapshot(&self, rel: &str, id: &str) -> Res<String> {
        // `id` comes from the UI; only accept our own `<ms>-<pid>-<seq>` names.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit() || c == '-') {
            return Err("invalid snapshot id".into());
        }
        self.abs(rel)?; // validates `rel`
        fs::read_to_string(self.snapshot_dir(rel).join(format!("{id}.md"))).map_err(err)
    }

    /// Restores a snapshot; the current content is snapshotted first so restore is undoable.
    pub fn restore_snapshot(&self, rel: &str, id: &str) -> Res<()> {
        let text = self.read_snapshot(rel, id)?;
        self.snapshot(rel, 0)?;
        self.write(rel, &text)
    }

    /// Per-vault settings in `.fermi/config.json` (bookmarks, daily notes, templates).
    pub fn config(&self) -> serde_json::Value {
        fs::read_to_string(self.dot_dir().join("config.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .filter(serde_json::Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}))
    }

    pub fn set_config(&self, value: &serde_json::Value) -> Res<()> {
        if !value.is_object() {
            return Err("config must be a JSON object".into());
        }
        let tmp = self.dot_dir().join(format!("config-{}.tmp", stamp()));
        fs::write(&tmp, serde_json::to_string_pretty(value).map_err(err)?).map_err(err)?;
        fs::rename(tmp, self.dot_dir().join("config.json")).map_err(err)
    }

    pub fn rename(&self, from: &str, to: &str) -> Res<()> {
        let (a, b) = (self.abs(from)?, self.abs(to)?);
        if b.exists() {
            return Err(format!("{to} already exists"));
        }
        if let Some(parent) = b.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        fs::rename(a, b).map_err(err)
    }

    /// Moves to `.fermi/trash` instead of deleting, so nothing is lost by a misclick.
    pub fn trash(&self, rel: &str) -> Res<()> {
        let src = self.abs(rel)?;
        let dir = self.dot_dir().join("trash");
        fs::create_dir_all(&dir).map_err(err)?;
        let name = src.file_name().unwrap().to_string_lossy();
        fs::rename(&src, dir.join(format!("{}.{name}", stamp()))).map_err(err)
    }

    pub fn mkdir(&self, rel: &str) -> Res<()> {
        fs::create_dir_all(self.abs(rel)?).map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_confinement() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        assert!(v.abs("a/b.md").is_ok());
        for bad in ["../x.md", "a/../../x.md", ".fermi/index.db", "a/.git/x", "", "/etc/passwd"] {
            assert!(v.abs(bad).is_err(), "{bad} should be rejected");
        }
        v.write("n/a.md", "hi").unwrap();
        assert_eq!(v.read("n/a.md").unwrap(), "hi");
        assert!(v.create("n/a.md", "x").is_err());
        v.rename("n/a.md", "b.md").unwrap();
        assert_eq!(v.notes().len(), 1);
        v.trash("b.md").unwrap();
        assert!(v.notes().is_empty());
    }

    #[test]
    fn snapshots_throttle_prune_restore() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write("dir/n.md", "v0").unwrap();
        v.snapshot("dir/n.md", 0).unwrap();
        v.write("dir/n.md", "v1").unwrap();
        v.snapshot("dir/n.md", 60_000).unwrap(); // throttled: one was just taken
        assert_eq!(v.snapshots("dir/n.md").len(), 1);
        for i in 0..SNAPSHOTS_KEPT + 5 {
            v.write("dir/n.md", &format!("v{}", i + 2)).unwrap();
            v.snapshot("dir/n.md", 0).unwrap();
        }
        let snaps = v.snapshots("dir/n.md");
        assert_eq!(snaps.len(), SNAPSHOTS_KEPT);
        let newest = v.read_snapshot("dir/n.md", &snaps[0].id).unwrap();
        assert_eq!(newest, format!("v{}", SNAPSHOTS_KEPT + 6));
        assert!(v.snapshots("dir/other.md").is_empty(), "per-note folders don't mix");
        assert!(v.read_snapshot("dir/n.md", "../../x").is_err());

        let oldest = snaps.last().unwrap().id.clone();
        let old_text = v.read_snapshot("dir/n.md", &oldest).unwrap();
        v.restore_snapshot("dir/n.md", &oldest).unwrap();
        assert_eq!(v.read("dir/n.md").unwrap(), old_text);

        assert_eq!(v.config(), serde_json::json!({}));
        v.set_config(&serde_json::json!({"bookmarks": ["dir/n.md"]})).unwrap();
        assert_eq!(v.config()["bookmarks"][0], "dir/n.md");
        assert!(v.set_config(&serde_json::json!([1])).is_err());
    }
}
