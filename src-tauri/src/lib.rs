pub mod ai;
pub mod connect;
pub mod embed;
pub mod index;
pub mod mcp;
pub mod parse;
pub mod query;
pub mod semantic;
pub mod vault;

use index::{Graph, Hit, Index, LinkRef};
use notify::{RecursiveMode, Watcher};
use semantic::ChunkRef;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use vault::{Entry, Res, Snapshot, Vault, err};

struct Open {
    vault: Vault,
    ix: Mutex<Index>,
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
struct AppState(Mutex<Option<Arc<Open>>>);

impl AppState {
    fn get(&self) -> Res<Arc<Open>> {
        self.0.lock().unwrap().clone().ok_or_else(|| "no vault open".into())
    }
}

static EMBEDDING: AtomicBool = AtomicBool::new(false);
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Embeds new/changed chunks on a background thread, in small batches with
/// pauses, so it never competes with typing. No-op without the model.
fn kick_embedder(app: &tauri::AppHandle, vault: &Vault) {
    if !embed::installed() || EMBEDDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (app, vault) = (app.clone(), vault.clone());
    std::thread::spawn(move || {
        if let Ok(mut ix) = Index::open(&vault) {
            while let Ok(n) = ix.embed_pending(128) {
                if n == 0 {
                    break;
                }
                let _ = app.emit("embed-progress", ix.embed_status().ok());
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
        }
        EMBEDDING.store(false, Ordering::SeqCst);
        let _ = app.emit("embed-progress", ());
    });
}

fn state_file(app: &tauri::AppHandle) -> Res<std::path::PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("state.json"))
}

#[tauri::command]
async fn last_vault(app: tauri::AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(state_file(&app).ok()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["vault"].as_str().map(String::from)
}

/// Opens a vault: index catch-up runs in the background so the UI is usable
/// immediately; a file watcher keeps the index (and the UI) in sync after that.
#[tauri::command]
async fn open_vault(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Res<String> {
    let vault = Vault::new(&path)?;
    let root = vault.root.to_string_lossy().into_owned();
    // Images, PDFs and media in the vault load through the asset protocol; nothing else is exposed.
    app.asset_protocol_scope().allow_directory(&vault.root, true).map_err(err)?;

    let (bg_vault, bg_app) = (vault.clone(), app.clone());
    std::thread::spawn(move || {
        if let Ok(mut ix) = Index::open(&bg_vault) {
            let _ = ix.sync(&bg_vault);
            let _ = bg_app.emit("index-ready", ());
            kick_embedder(&bg_app, &bg_vault);
        }
    });

    let (w_vault, w_app) = (vault.clone(), app.clone());
    let mut w_ix = Index::open(&vault)?;
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        let rels: Vec<String> = ev.paths.iter().filter_map(|p| w_vault.rel(p)).collect();
        if rels.is_empty() {
            return; // only .fermi or other dot-folder churn
        }
        for r in rels.iter().filter(|r| r.ends_with(".md")) {
            let _ = w_ix.refresh(&w_vault, r);
        }
        kick_embedder(&w_app, &w_vault);
        let _ = w_app.emit("vault-changed", rels);
    })
    .map_err(err)?;
    watcher.watch(&vault.root, RecursiveMode::Recursive).map_err(err)?;

    let ix = Mutex::new(Index::open(&vault)?);
    *state.0.lock().unwrap() = Some(Arc::new(Open {
        vault,
        ix,
        _watcher: watcher,
    }));

    let sf = state_file(&app)?;
    std::fs::create_dir_all(sf.parent().unwrap()).map_err(err)?;
    std::fs::write(sf, serde_json::json!({ "vault": root }).to_string()).map_err(err)?;
    Ok(root)
}

#[tauri::command]
async fn list_files(state: State<'_, AppState>) -> Res<Vec<Entry>> {
    Ok(state.get()?.vault.entries())
}

#[tauri::command]
async fn read_note(state: State<'_, AppState>, path: String) -> Res<String> {
    state.get()?.vault.read(&path)
}

/// Saves editor text. `base` is the text the editor last loaded or saved; returns true when
/// disk had changed since, in which case that version was kept as a snapshot.
#[tauri::command]
async fn write_note(state: State<'_, AppState>, vault: String, path: String, content: String, base: String) -> Res<bool> {
    let o = state.get()?;
    // A save that outlived a vault switch must not land in the new vault.
    if vault != o.vault.root.to_string_lossy() {
        return Err(format!("{path} belongs to a vault that is no longer open"));
    }
    let _lock = o.vault.lock()?;
    let conflict = o.vault.save(&path, &content, &base)?;
    o.ix.lock().unwrap().refresh(&o.vault, &path)?;
    Ok(conflict)
}

#[tauri::command]
async fn create_note(state: State<'_, AppState>, path: String, content: String) -> Res<()> {
    let o = state.get()?;
    let _lock = o.vault.lock()?;
    o.vault.create(&path, &content)?;
    o.ix.lock().unwrap().refresh(&o.vault, &path)
}

#[tauri::command]
async fn create_folder(state: State<'_, AppState>, path: String) -> Res<()> {
    state.get()?.vault.mkdir(&path)
}

/// Renames a note (rewriting links to it) or any other file/folder. Returns the
/// number of notes whose links were updated.
#[tauri::command]
async fn rename_path(state: State<'_, AppState>, from: String, to: String) -> Res<usize> {
    let o = state.get()?;
    let _lock = o.vault.lock()?;
    let mut ix = o.ix.lock().unwrap();
    if from.ends_with(".md") && to.ends_with(".md") {
        return ix.rename_note(&o.vault, &from, &to);
    }
    o.vault.rename(&from, &to)?;
    ix.sync(&o.vault)?;
    Ok(0)
}

#[tauri::command]
async fn trash_path(state: State<'_, AppState>, path: String) -> Res<()> {
    let o = state.get()?;
    let _lock = o.vault.lock()?;
    o.vault.trash(&path)?;
    o.ix.lock().unwrap().sync(&o.vault).map(|_| ())
}

#[tauri::command]
async fn search(state: State<'_, AppState>, query: String) -> Res<Vec<Hit>> {
    state.get()?.ix.lock().unwrap().hybrid(&query, 50)
}

/// Passages relevant to `query`, used to ground chat answers.
#[tauri::command]
async fn ai_context(state: State<'_, AppState>, query: String, k: usize) -> Res<Vec<ChunkRef>> {
    state.get()?.ix.lock().unwrap().context(&query, k)
}

#[tauri::command]
async fn related(state: State<'_, AppState>, path: String) -> Res<Vec<(String, f32)>> {
    state.get()?.ix.lock().unwrap().related(&path, 12)
}

#[tauri::command]
async fn embed_status(state: State<'_, AppState>) -> Res<Value> {
    let (pending, total) = state.get()?.ix.lock().unwrap().embed_status()?;
    Ok(
        json!({ "installed": embed::installed(), "running": EMBEDDING.load(Ordering::SeqCst), "pending": pending, "total": total, "model": embed::MODEL }),
    )
}

/// Downloads the embedding model (~30 MB) in the background, then indexes the vault.
#[tauri::command]
async fn embed_install(app: tauri::AppHandle, state: State<'_, AppState>) -> Res<()> {
    let vault = state.get()?.vault.clone();
    std::thread::spawn(move || {
        let mut last = 0;
        let result = embed::download(|done, total| {
            if done - last > 512 * 1024 || done == total {
                last = done;
                let _ = app.emit("embed-download", json!({ "done": done, "total": total }));
            }
        });
        let _ = app.emit("embed-download", json!({ "finished": true, "error": result.err() }));
        kick_embedder(&app, &vault);
    });
    Ok(())
}

#[tauri::command]
async fn ai_detect() -> Vec<ai::Endpoint> {
    ai::detect()
}

#[tauri::command]
async fn ai_models(base_url: String) -> Res<Vec<String>> {
    ai::models(&base_url)
}

#[tauri::command]
async fn ai_set_key(base_url: String, key: Option<String>) -> Res<()> {
    ai::set_key(&base_url, key.as_deref())
}

#[tauri::command]
async fn ai_has_key(base_url: String) -> bool {
    ai::has_key(&base_url)
}

/// Starts a streaming completion. Text arrives as `ai-delta` events and the end
/// (or an error) as `ai-done`, both tagged with the caller's `id`.
#[tauri::command]
async fn ai_chat(app: tauri::AppHandle, id: String, base_url: String, model: String, messages: Value) -> Res<()> {
    std::thread::spawn(move || {
        let cancelled = || CANCELLED.lock().unwrap().as_ref().is_some_and(|c| c.contains(&id));
        let result = ai::chat(&base_url, &model, &messages, |text| {
            let _ = app.emit("ai-delta", json!({ "id": id, "text": text }));
            !cancelled()
        });
        if let Some(c) = CANCELLED.lock().unwrap().as_mut() {
            c.remove(&id);
        }
        let _ = app.emit("ai-done", json!({ "id": id, "error": result.err() }));
    });
    Ok(())
}

#[tauri::command]
async fn ai_cancel(id: String) {
    CANCELLED.lock().unwrap().get_or_insert_default().insert(id);
}

/// Runs a ```table``` block / query (see `query.rs`).
#[tauri::command]
async fn query(state: State<'_, AppState>, text: String) -> Res<query::Table> {
    let q = query::parse(&text)?;
    state.get()?.ix.lock().unwrap().query(&q)
}

#[tauri::command]
async fn backlinks(state: State<'_, AppState>, path: String) -> Res<Vec<LinkRef>> {
    state.get()?.ix.lock().unwrap().backlinks(&path)
}

#[tauri::command]
async fn resolve_link(state: State<'_, AppState>, target: String) -> Res<Option<String>> {
    state.get()?.ix.lock().unwrap().resolve(&target)
}

#[tauri::command]
async fn graph(state: State<'_, AppState>) -> Res<Graph> {
    state.get()?.ix.lock().unwrap().graph()
}

#[tauri::command]
async fn tags(state: State<'_, AppState>) -> Res<Vec<(String, i64)>> {
    state.get()?.ix.lock().unwrap().tags()
}

#[tauri::command]
async fn tagged(state: State<'_, AppState>, tag: String) -> Res<Vec<String>> {
    state.get()?.ix.lock().unwrap().tagged(&tag)
}

#[tauri::command]
async fn vault_config(state: State<'_, AppState>) -> Res<serde_json::Value> {
    Ok(state.get()?.vault.config())
}

#[tauri::command]
async fn set_vault_config(state: State<'_, AppState>, value: serde_json::Value) -> Res<()> {
    state.get()?.vault.set_config(&value)
}

#[tauri::command]
async fn snapshots(state: State<'_, AppState>, path: String) -> Res<Vec<Snapshot>> {
    Ok(state.get()?.vault.snapshots(&path))
}

#[tauri::command]
async fn read_snapshot(state: State<'_, AppState>, path: String, id: String) -> Res<String> {
    state.get()?.vault.read_snapshot(&path, &id)
}

#[tauri::command]
async fn restore_snapshot(state: State<'_, AppState>, path: String, id: String) -> Res<()> {
    let o = state.get()?;
    let _lock = o.vault.lock()?;
    o.vault.restore_snapshot(&path, &id)?;
    o.ix.lock().unwrap().refresh(&o.vault, &path)
}

#[tauri::command]
async fn ai_apps() -> Vec<connect::Status> {
    connect::status()
}

#[tauri::command]
async fn ai_preview(state: State<'_, AppState>, id: String) -> Res<String> {
    connect::preview(&id, &state.get()?.vault.root.to_string_lossy())
}

#[tauri::command]
async fn ai_set(state: State<'_, AppState>, id: String, connected: bool) -> Res<()> {
    let root = state.get()?.vault.root.to_string_lossy().into_owned();
    connect::set(&id, connected.then_some(root.as_str()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            last_vault,
            open_vault,
            list_files,
            read_note,
            write_note,
            create_note,
            create_folder,
            rename_path,
            trash_path,
            search,
            query,
            backlinks,
            resolve_link,
            graph,
            tags,
            tagged,
            vault_config,
            set_vault_config,
            snapshots,
            read_snapshot,
            restore_snapshot,
            ai_context,
            related,
            embed_status,
            embed_install,
            ai_detect,
            ai_models,
            ai_set_key,
            ai_has_key,
            ai_chat,
            ai_cancel,
            ai_apps,
            ai_preview,
            ai_set
        ])
        .run(tauri::generate_context!())
        .expect("error while running FermiVault");
}
