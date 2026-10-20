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

/// Remembers a tree by its encoded bytes (which hash to `id`).
pub fn keep<S: SqlStore>(db: &S, id: &ObjectId, encoded: &[u8]) -> Result<()> {
    if encoded.len() <= MAX_TREE_BYTES {
        db.query(
            "INSERT INTO tree_cache(id,data_b64) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
            &[json!(id.hex()), json!(STANDARD.encode(encoded))],
        )?;
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

/// Keeps the newest entries only.
pub fn prune<S: SqlStore>(db: &S) -> Result<()> {
    db.query(
        "DELETE FROM tree_cache WHERE seq<=(SELECT MAX(seq) FROM tree_cache)-?",
        &[json!(MAX_TREES)],
    )?;
    Ok(())
}
