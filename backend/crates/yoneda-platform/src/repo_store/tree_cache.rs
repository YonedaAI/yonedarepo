//! Trees this authority built or verified, kept by id, so a commit on a recent head needs
//! no tree round trips: the adapter supplies only trees this store has not seen. Entries
//! are content-addressed (verified before they enter) and bounded by count and size;
//! losing one only costs the adapter a round.
use super::rows::corrupt;
use crate::storage::SqlStore;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use std::collections::{BTreeSet, HashMap};
use yoneda_core::{
    Result,
    git_object::{ObjectId, TreeEntry, decode_tree},
};

const MAX_TREES: i64 = 4096;
const MAX_TREE_BYTES: usize = 64 * 1024;
const PRUNE_EVERY: i64 = 64;

/// Remembers trees by their encoded bytes (each hashes to its id), keeping the newest.
pub fn keep<S: SqlStore>(db: &S, trees: &[(ObjectId, Vec<u8>)]) -> Result<()> {
    let small: Vec<_> = trees
        .iter()
        .filter(|(_, encoded)| encoded.len() <= MAX_TREE_BYTES)
        .collect();
    // Durable Object SQL binds at most 100 parameters per statement.
    for chunk in small.chunks(50) {
        let rows = vec!["(?,?)"; chunk.len()].join(",");
        let params: Vec<_> = chunk
            .iter()
            .flat_map(|(id, encoded)| [json!(id.hex()), json!(STANDARD.encode(encoded))])
            .collect();
        let inserted = db.query(
            &format!("INSERT INTO tree_cache(id,data_b64) VALUES{rows} ON CONFLICT(id) DO NOTHING RETURNING seq"),
            &params,
        )?;
        // Prune when the sequence crosses a multiple of the prune step, not on every write.
        if inserted
            .iter()
            .any(|r| r["seq"].as_i64().is_some_and(|seq| seq % PRUNE_EVERY == 0))
        {
            db.query(
                "DELETE FROM tree_cache WHERE seq<=(SELECT MAX(seq) FROM tree_cache)-?",
                &[json!(MAX_TREES)],
            )?;
        }
    }
    Ok(())
}

/// Adds every remembered tree among `wanted` to `trees`; returns whether any was found.
pub fn fill<S: SqlStore>(
    db: &S,
    trees: &mut HashMap<ObjectId, Vec<TreeEntry>>,
    wanted: &BTreeSet<ObjectId>,
) -> Result<bool> {
    let mut found = false;
    for id in wanted {
        let Some(row) = db
            .query(
                "SELECT data_b64 FROM tree_cache WHERE id=?",
                &[json!(id.hex())],
            )?
            .into_iter()
            .next()
        else {
            continue;
        };
        let bytes = STANDARD
            .decode(row["data_b64"].as_str().unwrap_or_default())
            .map_err(|_| corrupt("cached tree"))?;
        trees.insert(*id, decode_tree(&bytes)?);
        found = true;
    }
    Ok(found)
}
