//! Stateless platform computation that runs in the Worker next to the object cache,
//! not in the repository Durable Object, so diffs never queue behind landings. The
//! adapter supplies objects by id; everything supplied is verified before use.
use crate::platform_objects::{entry_type, supplied_trees};
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, ObjectKind, Walk, diff_trees, hash_object},
    textdiff,
};

const MAX_DIFF_FILES: usize = 10_000;
/// Larger files are listed without a patch, like a code host's "diff too large".
pub const MAX_PATCH_BYTES: usize = 2 * 1024 * 1024;

pub fn compute(c: Value) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "tree_diff" => tree_diff(&c),
        "file_patch" => file_patch(&c),
        op => Err(Error::new("UNKNOWN_OP", format!("Unknown compute op {op}"))),
    }
}

fn optional_id(c: &Value, key: &str) -> Result<Option<ObjectId>> {
    match c.get(key).filter(|v| !v.is_null()) {
        Some(_) => Ok(Some(ObjectId::parse(&string(c, key)?)?)),
        None => Ok(None),
    }
}

fn tree_diff(c: &Value) -> Result<Value> {
    let trees = supplied_trees(c)?;
    let walk = diff_trees(
        optional_id(c, "old")?,
        optional_id(c, "new")?,
        &trees,
        MAX_DIFF_FILES,
    )?;
    Ok(match walk {
        Walk::Need(ids) => json!({ "need_trees": ids }),
        Walk::Done(changes) => json!({ "changes": changes.iter().map(|ch| {
            let side = |s: Option<(yoneda_core::git_object::FileMode, ObjectId)>| {
                s.map(|(m, id)| json!({"type": entry_type(m), "id": id}))
            };
            let op = match (&ch.old, &ch.new) {
                (None, _) => "add",
                (_, None) => "delete",
                _ => "modify",
            };
            json!({"path": ch.path, "op": op, "old": side(ch.old), "new": side(ch.new)})
        }).collect::<Vec<_>>() }),
    })
}

/// One side of a patch: base64 content that must hash to the given blob id.
fn side(c: &Value, which: &str) -> Result<Vec<u8>> {
    let Some(id) = optional_id(c, &format!("{which}_id"))? else {
        return Ok(Vec::new());
    };
    let data = STANDARD
        .decode(c[format!("{which}_b64")].as_str().unwrap_or_default())
        .map_err(|_| bad("Blob content is not base64"))?;
    if hash_object(ObjectKind::Blob, &data) != id {
        return Err(Error::new(
            "BLOB_INVALID",
            format!("Supplied blob does not match {id}"),
        ));
    }
    Ok(data)
}

fn file_patch(c: &Value) -> Result<Value> {
    let (old, new) = (side(c, "old")?, side(c, "new")?);
    if old.len().max(new.len()) > MAX_PATCH_BYTES {
        return Ok(json!({ "too_large": true }));
    }
    if textdiff::is_binary(&old) || textdiff::is_binary(&new) {
        return Ok(json!({ "binary": true }));
    }
    let context = c["context"].as_u64().unwrap_or(3).min(100) as u32;
    let (patch, stats) = textdiff::unified(&old, &new, context);
    Ok(json!({ "patch": patch, "additions": stats.additions, "deletions": stats.deletions }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yoneda_core::git_object::{FileMode, TreeEntry, encode_tree};

    fn blob(text: &str) -> ObjectId {
        hash_object(ObjectKind::Blob, text.as_bytes())
    }
    fn tree(entries: &[(&str, FileMode, ObjectId)]) -> (ObjectId, Value) {
        let list: Vec<TreeEntry> = entries
            .iter()
            .map(|(n, m, id)| TreeEntry {
                name: (*n).into(),
                mode: *m,
                id: *id,
            })
            .collect();
        let id = hash_object(ObjectKind::Tree, &encode_tree(&list).unwrap());
        (id, crate::platform_objects::entries_json(&list))
    }

    #[test]
    fn diffs_trees_in_rounds_and_rejects_forged_trees() {
        let (src_old, src_old_json) = tree(&[("lib.rs", FileMode::Blob, blob("a"))]);
        let (src_new, src_new_json) = tree(&[("lib.rs", FileMode::Blob, blob("b"))]);
        let (old, old_json) = tree(&[("src", FileMode::Tree, src_old)]);
        let (new, new_json) = tree(&[
            ("README", FileMode::Blob, blob("r")),
            ("src", FileMode::Tree, src_new),
        ]);
        let mut c = json!({"op": "tree_diff", "old": old, "new": new, "trees": {}});
        assert_eq!(
            compute(c.clone()).unwrap()["need_trees"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        c["trees"] = json!({ old.hex(): old_json, new.hex(): new_json.clone() });
        assert_eq!(
            compute(c.clone()).unwrap()["need_trees"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        c["trees"][src_old.hex()] = src_old_json;
        c["trees"][src_new.hex()] = src_new_json;
        let done = compute(c.clone()).unwrap();
        let ops: Vec<String> = done["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|ch| {
                format!(
                    "{}:{}",
                    ch["op"].as_str().unwrap(),
                    ch["path"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(ops, ["add:README", "modify:src/lib.rs"]);
        c["trees"][new.hex()] = json!([]);
        assert_eq!(compute(c).unwrap_err().code, "TREE_INVALID");
    }

    #[test]
    fn patches_verified_blobs_only() {
        let c = json!({"op": "file_patch", "old_id": blob("a\n"), "old_b64": STANDARD.encode("a\n"),
            "new_id": blob("b\n"), "new_b64": STANDARD.encode("b\n")});
        let patch = compute(c.clone()).unwrap();
        assert_eq!(patch["patch"], "@@ -1 +1 @@\n-a\n+b\n");
        let mut forged = c;
        forged["new_b64"] = json!(STANDARD.encode("evil\n"));
        assert_eq!(compute(forged).unwrap_err().code, "BLOB_INVALID");
        let added = compute(
            json!({"op": "file_patch", "new_id": blob("x\n"), "new_b64": STANDARD.encode("x\n")}),
        )
        .unwrap();
        assert_eq!(added["additions"], 1);
    }
}
