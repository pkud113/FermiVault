//! Local semantic embeddings with Model2Vec (`potion-base-8M`): static token
//! vectors, mean-pooled. No neural-net runtime, no GPU, ~30 MB on disk, and
//! thousands of passages per second on one CPU core, so background indexing
//! never competes with the UI. The model is downloaded once, on request, into a
//! per-user folder shared by the app and the MCP server.

use crate::vault::{Res, err};
use model2vec_rs::model::StaticModel;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const MODEL: &str = "minishlab/potion-base-8M";
/// The exact model commit we download, and each file's SHA-256: what we run is what we
/// tested, even if the repository changes later. Bump both together.
const REVISION: &str = "bf8b056651a2c21b8d2565580b8569da283cab23";
const FILES: [(&str, &str); 3] = [
    ("config.json", "2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553"),
    ("tokenizer.json", "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50"),
    (
        "model.safetensors",
        "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
    ),
];

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
    FILES.iter().all(|(f, _)| model_dir().join(f).is_file())
}

/// Downloads the model from Hugging Face. `progress(done, total)` is called as bytes arrive.
/// Each file is checked against its pinned SHA-256 before it's put in place.
pub fn download(mut progress: impl FnMut(u64, u64)) -> Res<()> {
    let dir = model_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut total = 0;
    let mut done = 0;
    for (name, sha256) in FILES {
        let url = format!("https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}");
        let mut resp = ureq::get(&url).call().map_err(|e| format!("download {name}: {e}"))?;
        total += resp.body().content_length().unwrap_or(0);
        let mut reader = resp.body_mut().as_reader();
        let tmp = dir.join(format!("{name}.part"));
        let mut file = std::fs::File::create(&tmp).map_err(err)?;
        let mut hash = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = reader.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
            std::io::Write::write_all(&mut file, &buf[..n]).map_err(err)?;
            done += n as u64;
            progress(done, total.max(done));
        }
        drop(file);
        if hex(&hash.finalize()) != sha256 {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("download {name}: checksum mismatch, file discarded"));
        }
        std::fs::rename(&tmp, dir.join(name)).map_err(err)?;
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums_compare_as_lowercase_hex() {
        let digest = Sha256::digest(b"abc");
        assert_eq!(hex(&digest), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(
            FILES
                .iter()
                .all(|(_, h)| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
        );
    }
}
