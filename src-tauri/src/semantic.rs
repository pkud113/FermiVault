//! Semantic layer over the index: background embedding of chunks, brute-force
//! cosine search over an in-memory matrix, hybrid (BM25 + vector) ranking, chat
//! context retrieval and related notes. Everything degrades to plain full-text
//! search when the embedding model isn't installed.

use crate::embed;
use crate::index::{Hit, Index, bump_gen};
use crate::vault::{Res, err};
use rusqlite::{TransactionBehavior, params};
use serde::Serialize;
use std::collections::HashMap;

/// Reciprocal-rank-fusion constant: the standard 60 keeps any one ranker from dominating.
const RRF_K: f32 = 60.0;

// ponytail: brute-force f32 scan; fine to ~100k chunks (~100 MB). Quantize or use sqlite-vec beyond that.
pub struct VecCache {
    generation: i64,
    dim: usize,
    ids: Vec<i64>,
    paths: Vec<String>,
    mat: Vec<f32>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ChunkRef {
    pub path: String,
    pub heading: String,
    pub line: i64,
    pub text: String,
}

fn rrf(rank: usize) -> f32 {
    1.0 / (RRF_K + rank as f32 + 1.0)
}

fn title(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md")
}

/// Indices of the `k` highest scores, best first.
fn top_k(scores: &[f32], k: usize) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..scores.len()).collect();
    let k = k.min(idx.len());
    if k == 0 {
        return vec![];
    }
    idx.select_nth_unstable_by(k - 1, |a, b| scores[*b].total_cmp(&scores[*a]));
    idx.truncate(k);
    idx.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]));
    idx
}

impl Index {
    fn generation(&self) -> Res<i64> {
        self.db
            .query_row("SELECT v FROM meta WHERE k = 'gen'", [], |r| r.get(0))
            .map_err(err)
    }

    /// (chunks still waiting for a vector, all chunks).
    pub fn embed_status(&self) -> Res<(i64, i64)> {
        self.db
            .query_row("SELECT count(*) FILTER (WHERE vec IS NULL), count(*) FROM chunks", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(err)
    }

    /// Embeds up to `limit` chunks that don't have a vector yet; returns how many.
    pub fn embed_pending(&mut self, limit: usize) -> Res<usize> {
        let rows: Vec<(i64, String, String, String)> = {
            let mut st = self
                .db
                .prepare("SELECT id, path, heading, text FROM chunks WHERE vec IS NULL LIMIT ?1")
                .map_err(err)?;
            st.query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .map_err(err)?
                .flatten()
                .collect()
        };
        if rows.is_empty() {
            return Ok(0);
        }
        // Title and heading give short chunks the context they need to be found.
        let inputs: Vec<String> = rows.iter().map(|(_, p, h, t)| format!("{}\n{h}\n{t}", title(p))).collect();
        let vecs = embed::embed(&inputs)?;
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
        for ((id, ..), v) in rows.iter().zip(&vecs) {
            tx.execute("UPDATE chunks SET vec = ?1 WHERE id = ?2", params![embed::to_blob(v), id])
                .map_err(err)?;
        }
        bump_gen(&tx)?;
        tx.commit().map_err(err)?;
        Ok(rows.len())
    }

    fn cache(&mut self) -> Res<&VecCache> {
        let generation = self.generation()?;
        if self.cache.as_ref().is_none_or(|c| c.generation != generation) {
            let mut c = VecCache {
                generation,
                dim: 0,
                ids: vec![],
                paths: vec![],
                mat: vec![],
            };
            let mut st = self
                .db
                .prepare("SELECT id, path, vec FROM chunks WHERE vec IS NOT NULL")
                .map_err(err)?;
            let mut rows = st.query([]).map_err(err)?;
            while let Some(r) = rows.next().map_err(err)? {
                let blob: Vec<u8> = r.get(2).map_err(err)?;
                let dim = blob.len() / 4;
                if c.dim == 0 {
                    c.dim = dim;
                }
                if dim != c.dim {
                    continue; // vector from a different model; it gets re-embedded on next edit
                }
                c.ids.push(r.get(0).map_err(err)?);
                c.paths.push(r.get(1).map_err(err)?);
                c.mat.extend(embed::from_blob(&blob));
            }
            drop(rows);
            drop(st);
            self.cache = Some(c);
        }
        Ok(self.cache.as_ref().unwrap())
    }

    /// Cosine scores of every cached chunk against `q` (vectors are normalized).
    fn scores(&mut self, q: &[f32]) -> Res<Vec<f32>> {
        let c = self.cache()?;
        if c.dim != q.len() {
            return Ok(vec![]);
        }
        Ok(c.mat
            .chunks_exact(c.dim)
            .map(|row| row.iter().zip(q).map(|(a, b)| a * b).sum())
            .collect())
    }

    /// Top `k` chunks for a query vector as (chunk id, path).
    pub(crate) fn nearest(&mut self, q: &[f32], k: usize) -> Res<Vec<(i64, String)>> {
        let scores = self.scores(q)?;
        let c = self.cache.as_ref().unwrap();
        Ok(top_k(&scores, k).into_iter().map(|i| (c.ids[i], c.paths[i].clone())).collect())
    }

    /// Semantic neighbours of free text; empty when the model isn't installed.
    fn semantic(&mut self, query: &str, k: usize) -> Vec<(i64, String)> {
        if !embed::installed() || query.trim().is_empty() {
            return vec![];
        }
        let Ok(q) = embed::embed(&[query.to_string()]) else { return vec![] };
        self.nearest(&q[0], k).unwrap_or_default()
    }

    fn chunk(&self, id: i64) -> Res<ChunkRef> {
        self.db
            .query_row("SELECT path, heading, line, text FROM chunks WHERE id = ?1", [id], |r| {
                Ok(ChunkRef {
                    path: r.get(0)?,
                    heading: r.get(1)?,
                    line: r.get(2)?,
                    text: r.get(3)?,
                })
            })
            .map_err(err)
    }

    /// Notes ranked by keyword (BM25) and meaning (embeddings) together, fused with RRF.
    /// Exact-word queries still win; paraphrases and related concepts are found too.
    pub fn hybrid(&mut self, q: &str, limit: usize) -> Res<Vec<Hit>> {
        let fts = self.search(q, 50)?;
        let sem = self.semantic(q, 80);
        let mut score: HashMap<String, f32> = HashMap::new();
        let mut snippet: HashMap<String, String> = HashMap::new();
        for (i, h) in fts.into_iter().enumerate() {
            *score.entry(h.path.clone()).or_default() += rrf(i);
            snippet.insert(h.path, h.snippet);
        }
        let mut seen = std::collections::HashSet::new();
        for (id, path) in sem {
            if !seen.insert(path.clone()) {
                continue; // one vote per note: its best chunk
            }
            *score.entry(path.clone()).or_default() += rrf(seen.len() - 1);
            if !snippet.contains_key(&path)
                && let Ok(c) = self.chunk(id)
            {
                let text: String = c.text.chars().take(220).collect::<String>().replace('\n', " ");
                snippet.insert(
                    path,
                    if c.heading.is_empty() {
                        text
                    } else {
                        format!("§ {}: {text}", c.heading)
                    },
                );
            }
        }
        let mut ranked: Vec<(String, f32)> = score.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(ranked
            .into_iter()
            .take(limit)
            .map(|(path, _)| Hit {
                snippet: snippet.remove(&path).unwrap_or_default(),
                path,
            })
            .collect())
    }

    /// The `k` passages most relevant to `q`, for grounding a chat answer.
    pub fn context(&mut self, q: &str, k: usize) -> Res<Vec<ChunkRef>> {
        let mut score: HashMap<i64, f32> = HashMap::new();
        for (i, (id, _)) in self.semantic(q, 40).into_iter().enumerate() {
            *score.entry(id).or_default() += rrf(i);
        }
        // Keyword hits: the best-matching chunk of each top note.
        let words: Vec<String> = q.split_whitespace().map(|w| w.to_lowercase()).filter(|w| w.len() > 2).collect();
        for (i, h) in self.search(q, 10)?.into_iter().enumerate() {
            let mut st = self.db.prepare("SELECT id, text FROM chunks WHERE path = ?1").map_err(err)?;
            let best = st
                .query_map([&h.path], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(err)?
                .flatten()
                .max_by_key(|(_, t)| {
                    let t = t.to_lowercase();
                    words.iter().filter(|w| t.contains(w.as_str())).count()
                });
            if let Some((id, _)) = best {
                *score.entry(id).or_default() += rrf(i);
            }
        }
        let mut ranked: Vec<(i64, f32)> = score.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        ranked.into_iter().take(k).map(|(id, _)| self.chunk(id)).collect()
    }

    /// Notes most similar in meaning to `path` (mean of chunk vectors), best first.
    pub fn related(&mut self, path: &str, k: usize) -> Res<Vec<(String, f32)>> {
        let c = self.cache()?;
        let dim = c.dim;
        let mut sums: HashMap<&str, Vec<f32>> = HashMap::new();
        for (p, row) in c.paths.iter().zip(c.mat.chunks_exact(dim.max(1))) {
            let s = sums.entry(p).or_insert_with(|| vec![0.0; dim]);
            s.iter_mut().zip(row).for_each(|(a, b)| *a += b);
        }
        let unit = |v: &[f32]| {
            let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
            v.iter().map(|x| x / n).collect::<Vec<f32>>()
        };
        let Some(me) = sums.get(path).map(|v| unit(v)) else {
            return Ok(vec![]);
        };
        let mut out: Vec<(String, f32)> = sums
            .iter()
            .filter(|(p, _)| **p != path)
            .map(|(p, v)| (p.to_string(), unit(v).iter().zip(&me).map(|(a, b)| a * b).sum()))
            .collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out.truncate(k);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;

    /// Exercises storage, caching, ranking and vector reuse with hand-made vectors,
    /// so tests don't need the downloaded model.
    #[test]
    fn vectors_ranking_and_reuse() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path()).unwrap();
        v.write("cats.md", "# Cats\nfelines purr").unwrap();
        v.write("dogs.md", "# Dogs\ncanines bark").unwrap();
        v.write("pets.md", "# Pets\ncats and dogs").unwrap();
        let mut ix = Index::open(&v).unwrap();
        ix.sync(&v).unwrap();
        assert_eq!(ix.embed_status().unwrap(), (3, 3));

        let set = |ix: &Index, path: &str, vec: [f32; 2]| {
            ix.db
                .execute("UPDATE chunks SET vec = ?1 WHERE path = ?2", params![embed::to_blob(&vec), path])
                .unwrap();
            bump_gen(&ix.db).unwrap();
        };
        let s = 0.5f32.sqrt();
        set(&ix, "cats.md", [1.0, 0.0]);
        set(&ix, "dogs.md", [0.0, 1.0]);
        set(&ix, "pets.md", [s, s]);
        assert_eq!(ix.embed_status().unwrap(), (0, 3));

        let near: Vec<String> = ix.nearest(&[1.0, 0.0], 2).unwrap().into_iter().map(|x| x.1).collect();
        assert_eq!(near, ["cats.md", "pets.md"]);
        let rel = ix.related("cats.md", 5).unwrap();
        assert_eq!(rel[0].0, "pets.md");
        assert_eq!(rel.len(), 2);

        // Editing one note keeps its vector when the chunk text is unchanged...
        v.write("dogs.md", "# Dogs\ncanines bark").unwrap();
        ix.refresh(&v, "dogs.md").unwrap();
        assert_eq!(ix.embed_status().unwrap(), (0, 3));
        // ...and queues only the changed chunk for re-embedding; the cache reloads.
        v.write("dogs.md", "# Dogs\nwolves howl").unwrap();
        ix.refresh(&v, "dogs.md").unwrap();
        assert_eq!(ix.embed_status().unwrap(), (1, 3));
        assert_eq!(ix.nearest(&[0.0, 1.0], 1).unwrap()[0].1, "pets.md");

        // Without a model, hybrid search is plain full-text search; context finds the passage.
        let hits = ix.hybrid("purr", 10).unwrap();
        assert_eq!(hits[0].path, "cats.md");
        let ctx = ix.context("wolves howl", 3).unwrap();
        assert_eq!(ctx[0].path, "dogs.md");
        assert_eq!(ctx[0].heading, "Dogs");
    }

    #[test]
    fn top_k_orders_best_first() {
        assert_eq!(top_k(&[0.1, 0.9, 0.5, 0.7], 3), [1, 3, 2]);
        assert!(top_k(&[], 3).is_empty());
    }
}
