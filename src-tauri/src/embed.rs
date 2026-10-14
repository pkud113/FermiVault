//! Local semantic embeddings with Model2Vec (`potion-base-8M`): static token
//! vectors, mean-pooled. No neural-net runtime, no GPU, ~30 MB on disk, and
//! thousands of passages per second on one CPU core, so background indexing
//! never competes with the UI. The model is downloaded once, on request, into a
//! per-user folder shared by the app and the MCP server.

use crate::vault::{Res, err};
use model2vec_rs::model::StaticModel;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const MODEL: &str = "minishlab/potion-base-8M";
const FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];

/// Per-user data dir: %LOCALAPPDATA%, ~/Library/Application Support, or ~/.local/share.
fn data_dir() -> PathBuf {
    let home = std::env::home_dir().unwrap_or_default();
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
    }
}

pub fn model_dir() -> PathBuf {
    data_dir().join("FermiVault").join("models").join(MODEL.rsplit('/').next().unwrap())
}

pub fn installed() -> bool {
    FILES.iter().all(|f| model_dir().join(f).is_file())
}

/// Downloads the model from Hugging Face. `progress(done, total)` is called as bytes arrive.
pub fn download(mut progress: impl FnMut(u64, u64)) -> Res<()> {
    let dir = model_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut total = 0;
    let mut done = 0;
    for name in FILES {
        let url = format!("https://huggingface.co/{MODEL}/resolve/main/{name}");
        let mut resp = ureq::get(&url).call().map_err(|e| format!("download {name}: {e}"))?;
        total += resp.body().content_length().unwrap_or(0);
        let mut reader = resp.body_mut().as_reader();
        let tmp = dir.join(format!("{name}.part"));
        let mut file = std::fs::File::create(&tmp).map_err(err)?;
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = reader.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buf[..n]).map_err(err)?;
            done += n as u64;
            progress(done, total.max(done));
        }
        drop(file);
        std::fs::rename(&tmp, dir.join(name)).map_err(err)?;
    }
    Ok(())
}

// ponytail: the model stays loaded once used (~30 MB); add idle unloading if RAM budgets get tight.
static LOADED: Mutex<Option<Arc<StaticModel>>> = Mutex::new(None);

fn model() -> Res<Arc<StaticModel>> {
    let mut slot = LOADED.lock().unwrap();
    if let Some(m) = slot.as_ref() {
        return Ok(m.clone());
    }
    if !installed() {
        return Err("semantic search model not installed".into());
    }
    let m = Arc::new(StaticModel::from_pretrained(model_dir(), None, Some(true), None).map_err(err)?);
    *slot = Some(m.clone());
    Ok(m)
}

/// L2-normalized embeddings (dot product = cosine similarity).
pub fn embed(texts: &[String]) -> Res<Vec<Vec<f32>>> {
    Ok(model()?.encode(texts))
}

pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn from_blob(b: &[u8]) -> impl Iterator<Item = f32> + '_ {
    b.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c))
}
