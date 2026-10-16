//! Filesystem access, confined to the vault root. Every path from the UI or an
//! agent goes through `abs()`, which is the trust boundary.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
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

/// Held vault write lock (see `Vault::lock`).
pub struct WriteLock(fs::File);

impl Drop for WriteLock {
    /// Unlock explicitly: Windows releases a lock on handle close only "eventually".
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

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

/// Symlinks and Windows junctions. Other reparse points, like OneDrive's
/// files-on-demand placeholders, are ordinary files and are not links.
fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

/// One path segment: not hidden, no control characters, and on Windows nothing
/// the OS would reinterpret (drive or stream colons, reserved device names,
/// trailing dots/spaces that Windows silently strips).
fn valid_name(name: &str) -> bool {
    if name.starts_with('.') || name.chars().any(char::is_control) {
        return false;
    }
    if cfg!(windows) {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with([' ', '.']) {
            return false;
        }
        let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        let port = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|n| n.chars().count() == 1 && n.chars().all(|c| c.is_ascii_digit() || "¹²³".contains(c)));
        if port || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
            return false;
        }
    }
    true
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
        if is_link(&root.join(".fermi")) {
            return Err(format!("{}: .fermi must be a real folder, not a link", root.display()));
        }
        Ok(Self { root })
    }

    pub fn dot_dir(&self) -> PathBuf {
        self.root.join(".fermi")
    }

    /// Vault-relative `rel` to an absolute path; rejects anything escaping the root,
    /// touching hidden (dot) folders such as `.fermi`, or passing through a link.
    ///
    /// Each name is validated on its own before it is joined: on Windows a name like
    /// `C:x` or `\\server\x` would otherwise replace the vault root when pushed.
    // ponytail: links are checked just before use, so one swapped in at that exact moment
    // can still slip through; closing that needs handle-relative (openat-style) file IO.
    pub fn abs(&self, rel: &str) -> Res<PathBuf> {
        let bad = || format!("invalid path: {rel}");
        if rel.starts_with(std::path::is_separator) {
            return Err(bad());
        }
        let mut out = self.root.clone();
        let mut on_disk = true; // once a name doesn't exist, nothing below it can be a link
        for name in rel.split(std::path::is_separator).filter(|n| !n.is_empty() && *n != ".") {
            if !valid_name(name) {
                return Err(bad());
            }
            out.push(name);
            if on_disk {
                match fs::symlink_metadata(&out) {
                    Ok(m) if m.file_type().is_symlink() => return Err(format!("{rel}: links are not followed")),
                    Ok(_) => {}
                    Err(_) => on_disk = false,
                }
            }
        }
        if out == self.root {
            return Err("empty path".into());
        }
        debug_assert!(out.starts_with(&self.root));
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
        out.into_iter().map(|(e, _)| e).collect()
    }

    /// Links (symlinks, junctions) are skipped: they could lead outside the vault or loop forever.
    /// File types and mtimes come from the directory listing itself, so this costs no extra stat calls.
    fn walk(&self, dir: &Path, out: &mut Vec<(Entry, i64)>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut items: Vec<_> = rd
            .flatten()
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|e| Some((e.file_type().ok().filter(|t| !t.is_symlink())?, e)))
            .collect();
        items.sort_by_cached_key(|(t, e)| (!t.is_dir(), e.file_name().to_string_lossy().to_lowercase()));
        for (t, e) in items {
            let path = e.path();
            if let Some(rel) = self.rel(&path) {
                let m = e.metadata().map_or(0, |m| mtime(&m));
                out.push((
                    Entry {
                        path: rel,
                        dir: t.is_dir(),
                    },
                    m,
                ));
            }
            if t.is_dir() {
                self.walk(&path, out);
            }
        }
    }

    /// (rel path, mtime ms) for every markdown note.
    pub fn notes(&self) -> Vec<(String, i64)> {
        let mut out = Vec::new();
        self.walk(&self.root, &mut out);
        out.into_iter()
            .filter(|(e, _)| !e.dir && e.path.ends_with(".md"))
            .map(|(e, m)| (e.path, m))
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

    /// Creates a new note; fails if it exists. `create_new` makes "doesn't exist yet" and
    /// "now it's mine" one step, so two creators can't both succeed.
    pub fn create(&self, rel: &str, content: &str) -> Res<()> {
        let p = self.abs(rel)?;
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => format!("{rel} already exists"),
                _ => format!("{rel}: {e}"),
            })?;
        std::io::Write::write_all(&mut f, content.as_bytes()).map_err(err)
    }

    /// Takes the vault-wide write lock, shared by the app and every MCP process, until the
    /// returned guard drops. Each read-modify-write of notes runs under it, so concurrent
    /// writers queue instead of silently overwriting each other. Take it once per operation
    /// (it doesn't nest) and before the index lock.
    // ponytail: one lock per vault; per-note locks if agents ever contend on it.
    pub fn lock(&self) -> Res<WriteLock> {
        let f = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.dot_dir().join("write.lock"))
            .map_err(err)?;
        f.lock().map_err(err)?;
        Ok(WriteLock(f))
    }

    /// Saves editor text. `base` is what the editor last loaded or saved: if disk has changed
    /// since (another app, agent or sync tool wrote it), that version is snapshotted first so
    /// neither edit is lost, and `true` is returned so the UI can say so. Call under `lock()`.
    pub fn save(&self, rel: &str, content: &str, base: &str) -> Res<bool> {
        let disk = match fs::read_to_string(self.abs(rel)?) {
            Ok(t) => Some(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("{rel}: {e}")),
        };
        let conflict = disk.is_some_and(|d| d != base && d != content);
        // Otherwise keep a recovery point at most every 5 minutes of editing.
        self.snapshot(rel, if conflict { 0 } else { 5 * 60_000 })?;
        self.write(rel, content)?;
        Ok(conflict)
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
    fn platform_path_tricks_rejected() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        for ok in ["a/b.md", "./a/./b.md", "a//b.md", "Meeting notes 2026.md", "com10.md", "console.md"] {
            assert!(v.abs(ok).unwrap().starts_with(&v.root), "{ok} should be accepted");
        }
        let mut bad = vec!["/abs.md", "a/\u{0}.md", "a/\n.md"];
        if cfg!(windows) {
            bad.extend([
                "safe/C:outside.md",
                "C:outside.md",
                "C:.fermi",
                r"C:\outside.md",
                r"\abs.md",
                r"\\server\share\x.md",
                r"\\?\C:\x.md",
                r"\\.\pipe\x",
                r"a\..\..\x.md",
                r"a\.fermi\x",
                "a/x.md:stream",
                "a/CON",
                "a/nul.md",
                "a/Com1.txt",
                "a/LPT².md",
                "a/x.md.",
                "a/x ",
            ]);
        }
        for p in bad {
            assert!(v.abs(p).is_err(), "{p:?} should be rejected");
        }
    }

    /// Makes `link` point at directory `target`: a junction on Windows (no admin needed), a symlink elsewhere.
    fn dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        return std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success());
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, link).is_ok();
    }

    #[test]
    fn links_are_not_followed() {
        let d = tempfile::tempdir().unwrap();
        let (root, outside) = (d.path().join("vault"), d.path().join("outside"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        let v = Vault::new(&root).unwrap();
        v.write("real/a.md", "a").unwrap();

        assert!(dir_link(&outside, &root.join("out")), "could not create a directory link");
        assert!(dir_link(&root, &root.join("real").join("loop")), "could not create a looping link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.md"), root.join("file.md")).unwrap();
        // Windows file symlinks need admin or developer mode; test them when available.
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_file(outside.join("secret.md"), root.join("file.md"));

        // Enumeration and indexing skip links (and so can't loop).
        let paths: Vec<_> = v.entries().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, ["real", "real/a.md"]);
        assert_eq!(v.notes().len(), 1);

        // Reads, writes, folder creation and renames through a link are refused.
        assert!(v.read("out/secret.md").is_err());
        assert!(v.write("out/new.md", "x").is_err());
        assert!(v.write("out/secret.md", "pwned").is_err());
        assert!(v.mkdir("out/sub").is_err());
        assert!(v.create("real/loop/real/b.md", "x").is_err());
        assert!(v.rename("real/a.md", "out/a.md").is_err());
        if is_link(&root.join("file.md")) {
            assert!(v.read("file.md").is_err());
            assert!(v.write("file.md", "pwned").is_err());
        }
        assert_eq!(fs::read_to_string(outside.join("secret.md")).unwrap(), "secret");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1, "nothing created outside");
        assert!(v.read("real/a.md").is_ok(), "ordinary notes still work");

        // Nothing behind a link reaches the index, so search and MCP can't expose it.
        let mut ix = crate::index::Index::open(&v).unwrap();
        ix.sync(&v).unwrap();
        assert!(ix.search("secret", 10).unwrap().is_empty());
        assert_eq!(ix.list("", 0, 100).unwrap().len(), 1);
    }

    #[test]
    fn linked_dot_folder_rejected() {
        let d = tempfile::tempdir().unwrap();
        let (root, elsewhere) = (d.path().join("vault"), d.path().join("elsewhere"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        assert!(dir_link(&elsewhere, &root.join(".fermi")));
        assert!(Vault::new(&root).is_err());
    }

    #[test]
    fn save_keeps_the_other_version_on_conflict() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write("n.md", "v1").unwrap();
        assert!(!v.save("n.md", "mine", "v1").unwrap(), "disk still matched the editor's base");
        v.write("n.md", "agent edit").unwrap(); // someone else writes after our last sync
        assert!(v.save("n.md", "mine 2", "mine").unwrap(), "conflict reported");
        assert_eq!(v.read("n.md").unwrap(), "mine 2");
        let snaps = v.snapshots("n.md");
        assert_eq!(
            v.read_snapshot("n.md", &snaps[0].id).unwrap(),
            "agent edit",
            "the other version is recoverable"
        );
        assert!(!v.save("new.md", "x", "").unwrap(), "a note deleted on disk is simply recreated");
    }

    #[test]
    fn create_never_overwrites() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        let barrier = std::sync::Barrier::new(8);
        let wins = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            for i in 0..8 {
                let (v, barrier, wins) = (&v, &barrier, &wins);
                s.spawn(move || {
                    barrier.wait();
                    if v.create("race.md", &format!("creator {i}")).is_ok() {
                        wins.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(wins.into_inner(), 1, "exactly one creator wins");
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
