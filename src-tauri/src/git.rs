//! Git sync: commits the vault and syncs it with a remote using the system `git` (no git
//! library, so the app stays small). Never opens a console window and never waits on a terminal
//! prompt. Only a vault that is the top level of its own repository is synced, so a vault that
//! happens to sit inside some other project's repository is never committed.
//!
//! Conflicts never lose work: if both sides changed a file, your version stays in place and the
//! remote's is saved next to it as `name (conflict YYYY-MM-DD).md`.

use crate::vault::{Res, Vault, err};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Debug, Default)]
pub struct Status {
    /// `git` is installed.
    pub git: bool,
    /// The vault is the top level of a Git repository.
    pub repo: bool,
    /// Git was set up for this vault on this device, so it's used (see `git_trusted` in lib.rs).
    pub trusted: bool,
    pub branch: Option<String>,
    pub remote: Option<String>,
    /// Files changed since the last commit.
    pub changes: usize,
}

#[derive(Serialize, Debug, Default)]
pub struct Synced {
    /// Files in the commit made for local changes (0: nothing to commit).
    pub committed: usize,
    pub pulled: bool,
    pub pushed: bool,
    /// Files changed on both sides; the remote version of each was kept as a copy.
    pub conflicts: Vec<String>,
}

/// Runs git and returns its exact stdout bytes.
fn output(root: &Path, args: &[&str]) -> Res<Vec<u8>> {
    output_with(root, args, true)
}

/// `interactive: false` (background auto-sync) also stops credential helpers from opening a
/// sign-in window: the sync fails quietly instead and the user can sync by hand.
fn output_with(root: &Path, args: &[&str], interactive: bool) -> Res<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0") // fail instead of waiting on a hidden terminal
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C");
    if !interactive {
        cmd.env("GCM_INTERACTIVE", "never").env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    let out = cmd.output().map_err(|e| format!("git isn't available: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let msg = String::from_utf8_lossy(&out.stderr);
        let msg = if msg.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout)
        } else {
            msg
        };
        Err(format!("git {}: {}", args.first().unwrap_or(&""), msg.trim()))
    }
}

fn run(root: &Path, args: &[&str]) -> Res<String> {
    output(root, args).map(|o| String::from_utf8_lossy(&o).trim_end().to_string())
}

/// For network commands (fetch, push), which may need credentials.
fn run_net(root: &Path, args: &[&str], interactive: bool) -> Res<String> {
    output_with(root, args, interactive).map(|o| String::from_utf8_lossy(&o).trim_end().to_string())
}

/// The vault is the top level of its own repository (not a folder inside another one). Checked
/// on disk, without running git in a repository that may not be trusted yet.
fn own_repo(root: &Path) -> bool {
    root.join(".git").exists()
}

/// `git` is installed (asked outside the vault, so no repository settings are read).
fn installed() -> bool {
    run(&std::env::temp_dir(), &["--version"]).is_ok()
}

/// `trusted: false` reports only what's on disk and never runs git in the vault.
pub fn status(vault: &Vault, trusted: bool) -> Status {
    let root = &vault.root;
    let mut s = Status {
        git: installed(),
        repo: own_repo(root),
        trusted,
        ..Default::default()
    };
    if !s.git || !s.repo || !trusted {
        return s;
    }
    s.branch = run(root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| b != "HEAD");
    s.remote = run(root, &["remote", "get-url", "origin"]).ok();
    s.changes = run(root, &["status", "--porcelain"]).map_or(0, |o| o.lines().count());
    s
}

/// Repository settings a notes vault needs: keep files byte-for-byte (no line-ending rewriting on
/// checkout) and report non-ASCII file names unescaped.
fn configure(root: &Path) -> Res<()> {
    run(root, &["config", "core.autocrlf", "false"])?;
    run(root, &["config", "core.quotepath", "false"]).map(|_| ())
}

/// `.fermi/` is app state (index, snapshots, lock): never commit it.
fn ignore_app_state(vault: &Vault) -> Res<()> {
    let p = vault.root.join(".gitignore");
    let text = std::fs::read_to_string(&p).unwrap_or_default();
    if text
        .lines()
        .any(|l| matches!(l.trim(), ".fermi" | ".fermi/" | "/.fermi" | "/.fermi/"))
    {
        return Ok(());
    }
    let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    std::fs::write(p, format!("{text}{sep}.fermi/\n")).map_err(err)
}

/// Commit identity: the user's own if configured, otherwise a neutral FermiVault one.
fn identity(root: &Path) -> Vec<&'static str> {
    if run(root, &["config", "user.email"]).is_ok_and(|e| !e.is_empty()) {
        vec![]
    } else {
        vec!["-c", "user.name=FermiVault", "-c", "user.email=fermivault@localhost"]
    }
}

fn today() -> String {
    let ms = crate::vault::now_ms() as i64;
    crate::query::format_ms(ms)[..10].to_string()
}

fn commit_all(vault: &Vault, message: &str) -> Res<usize> {
    let root = &vault.root;
    run(root, &["add", "-A"])?;
    let n = run(root, &["diff", "--cached", "--name-only"])?.lines().count();
    if n > 0 {
        let mut args = identity(root);
        args.extend(["commit", "-q", "-m", message]);
        run(root, &args)?;
    }
    Ok(n)
}

/// Makes the vault a Git repository (with `.fermi/` ignored) and commits what's there.
pub fn init(vault: &Vault) -> Res<()> {
    if !installed() {
        return Err("Git isn't installed. Get it from https://git-scm.com, then try again.".into());
    }
    if !own_repo(&vault.root) {
        run(&vault.root, &["init", "-q"])?;
    }
    configure(&vault.root)?;
    ignore_app_state(vault)?;
    let _lock = vault.lock()?;
    commit_all(vault, "Start vault history")?;
    Ok(())
}

/// Sets (or with an empty URL, removes) the `origin` remote.
pub fn set_remote(vault: &Vault, url: &str) -> Res<()> {
    let root = &vault.root;
    if !own_repo(root) {
        return Err("Set up Git for this vault first.".into());
    }
    let url = url.trim();
    if url.starts_with('-') {
        return Err(format!("Not a remote address: {url}"));
    }
    let has = run(root, &["remote", "get-url", "origin"]).is_ok();
    match (has, url.is_empty()) {
        (true, true) => run(root, &["remote", "remove", "origin"]).map(|_| ()),
        (true, false) => run(root, &["remote", "set-url", "origin", url]).map(|_| ()),
        (false, false) => run(root, &["remote", "add", "origin", url]).map(|_| ()),
        (false, true) => Ok(()),
    }
}

/// Commits local changes, brings in the remote's, and pushes. The vault write lock is held
/// while the working tree changes (commit, rebase/merge), not during network transfers.
pub fn sync(vault: &Vault, interactive: bool) -> Res<Synced> {
    let root = &vault.root;
    if !own_repo(root) {
        return Err("This vault isn't a Git repository yet. Set it up in Settings → Sync.".into());
    }
    configure(root)?;
    ignore_app_state(vault)?;
    let mut out = Synced::default();
    {
        let _lock = vault.lock()?;
        out.committed = commit_all(vault, &format!("Vault backup {}", today()))?;
    }
    if run(root, &["remote", "get-url", "origin"]).is_err() {
        return Ok(out); // local history only
    }
    let branch = run(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    run_net(root, &["fetch", "-q", "origin"], interactive)?;
    let upstream = format!("origin/{branch}");
    if run(root, &["rev-parse", "--verify", "-q", &upstream]).is_ok() {
        let _lock = vault.lock()?;
        let behind = run(root, &["rev-list", "--count", &format!("HEAD..{upstream}")])?;
        if behind != "0" {
            out.pulled = true;
            let mut rebase = identity(root);
            rebase.extend(["rebase", "-q", &upstream]);
            if run(root, &rebase).is_err() {
                let _ = run(root, &["rebase", "--abort"]);
                out.conflicts = merge_keeping_both(vault, &upstream)?;
            }
        }
    }
    run_net(root, &["push", "-q", "-u", "origin", &branch], interactive)?;
    out.pushed = true;
    Ok(out)
}

/// Merges `upstream`; for every file changed on both sides, keeps ours in place and writes theirs
/// next to it as a conflict copy, then commits. Returns the conflicted paths.
fn merge_keeping_both(vault: &Vault, upstream: &str) -> Res<Vec<String>> {
    let root = &vault.root;
    let mut merge = identity(root);
    merge.extend(["merge", "--no-edit", "-q", upstream]);
    if run(root, &merge).is_ok() {
        return Ok(vec![]); // rebase failed for another reason but a merge is clean
    }
    let conflicted: Vec<String> = run(root, &["diff", "--name-only", "--diff-filter=U"])?
        .lines()
        .map(String::from)
        .collect();
    if conflicted.is_empty() {
        let _ = run(root, &["merge", "--abort"]);
        return Err("Couldn't merge the remote's changes; nothing was changed.".into());
    }
    for path in &conflicted {
        // Theirs to a copy (if it still exists there), ours back in place.
        // Hidden files (`.gitignore`, other apps' dot folders) aren't vault files: ours wins, theirs
        // stays in the history.
        let (stem, ext) = path.rsplit_once('.').filter(|(s, _)| !s.is_empty() && !s.ends_with('/')).unwrap_or((path, ""));
        let dot = if ext.is_empty() { "" } else { "." };
        let copy = vault.abs(&format!("{stem} (conflict {}){dot}{ext}", today()));
        if let (Ok(copy), Ok(theirs)) = (copy, output(root, &["show", &format!("{upstream}:{path}")])) {
            std::fs::write(copy, theirs).map_err(err)?; // exact bytes: works for images too
        }
        if run(root, &["checkout", "--ours", "--", path]).is_err() {
            let _ = run(root, &["rm", "-q", "--cached", "--", path]); // deleted on our side
        }
    }
    run(root, &["add", "-A"])?;
    let mut commit = identity(root);
    commit.extend(["commit", "-q", "--no-edit"]);
    run(root, &commit)?;
    Ok(conflicted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_ok() -> bool {
        run(Path::new("."), &["--version"]).is_ok()
    }

    /// A bare "remote" and two vault clones of it.
    fn setup() -> (tempfile::TempDir, Vault, Vault) {
        let d = tempfile::tempdir().unwrap();
        let remote = d.path().join("remote.git");
        run(d.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]).unwrap();
        let a = d.path().join("a");
        std::fs::create_dir(&a).unwrap();
        let va = Vault::new(&a).unwrap();
        run(&va.root, &["init", "-q", "-b", "main"]).unwrap();
        va.write("Note.md", "line 1\nline 2\n").unwrap();
        init(&va).unwrap();
        set_remote(&va, remote.to_str().unwrap()).unwrap();
        sync(&va, false).unwrap();
        // A plain clone, as a user would make on another machine (no FermiVault settings yet).
        run(
            d.path(),
            &["clone", "-q", "-c", "core.autocrlf=false", remote.to_str().unwrap(), "b"],
        )
        .unwrap();
        let vb = Vault::new(d.path().join("b")).unwrap();
        (d, va, vb)
    }

    #[test]
    fn never_touches_a_parent_repository() {
        if !git_ok() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        run(d.path(), &["init", "-q"]).unwrap();
        std::fs::create_dir(d.path().join("vault")).unwrap();
        let v = Vault::new(d.path().join("vault")).unwrap();
        let s = status(&v, true);
        assert!(s.git && !s.repo, "a folder inside another repo isn't the vault's repo");
        assert!(sync(&v, false).is_err());
        assert!(init(&v).is_ok() && status(&v, true).repo, "setting up gives the vault its own repo");
        assert!(run(d.path(), &["log", "-1"]).is_err(), "the parent repo gets no commits");
    }

    #[test]
    fn untrusted_repository_is_only_looked_at() {
        if !git_ok() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        // Not a real repository: any git command run in it would fail or misbehave.
        std::fs::write(d.path().join(".git"), "gitdir: /nowhere").unwrap();
        let v = Vault::new(d.path()).unwrap();
        let s = status(&v, false);
        assert!(s.git && s.repo && !s.trusted && s.branch.is_none() && s.changes == 0, "{s:?}");
        assert!(set_remote(&v, "--upload-pack=x").is_err());
    }

    #[test]
    fn init_ignores_app_state_and_commits() {
        if !git_ok() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write("a.md", "hello").unwrap();
        init(&v).unwrap();
        let s = status(&v, true);
        assert!(s.repo && s.changes == 0, "{s:?}");
        assert!(std::fs::read_to_string(v.root.join(".gitignore")).unwrap().contains(".fermi/"));
        let tracked = run(&v.root, &["ls-files"]).unwrap();
        assert!(tracked.contains("a.md") && !tracked.contains(".fermi"), "{tracked}");
        v.write("b.md", "new").unwrap();
        assert_eq!(sync(&v, false).unwrap().committed, 1, "no remote: commits locally");
    }

    #[test]
    fn syncs_between_two_vaults() {
        if !git_ok() {
            return;
        }
        let (_d, a, b) = setup();
        assert_eq!(b.read("Note.md").unwrap(), "line 1\nline 2\n");
        b.write("From B.md", "hi from b").unwrap();
        let r = sync(&b, false).unwrap();
        assert!(r.committed == 1 && r.pushed, "{r:?}");
        let r = sync(&a, false).unwrap();
        assert!(r.pulled && r.conflicts.is_empty(), "{r:?}");
        assert_eq!(a.read("From B.md").unwrap(), "hi from b");
    }

    #[test]
    fn conflicts_keep_both_versions() {
        if !git_ok() {
            return;
        }
        let (_d, a, b) = setup();
        a.write("Note.md", "line 1 from A\nline 2\n").unwrap();
        a.write("Café.md", "A").unwrap();
        sync(&a, false).unwrap();
        b.write("Note.md", "line 1 from B\nline 2\n").unwrap();
        b.write("Café.md", "B").unwrap(); // added on both sides, and not ASCII
        let r = sync(&b, false).unwrap();
        assert_eq!(r.conflicts, ["Café.md", "Note.md"]);
        assert_eq!(b.read(&format!("Café (conflict {}).md", today())).unwrap(), "A");
        assert!(r.pushed);
        assert_eq!(b.read("Note.md").unwrap(), "line 1 from B\nline 2\n", "your version stays in place");
        let copy = format!("Note (conflict {}).md", today());
        assert_eq!(
            b.read(&copy).unwrap(),
            "line 1 from A\nline 2\n",
            "the remote's version is kept as a copy"
        );
        assert!(status(&b, true).changes == 0);
        sync(&a, false).unwrap();
        assert_eq!(a.read(&copy).unwrap(), "line 1 from A\nline 2\n", "and both reach the other vault");
    }
}
