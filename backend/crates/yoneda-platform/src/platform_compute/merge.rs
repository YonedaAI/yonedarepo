//! Three-way merges and replays (pick, revert) of tree diffs, as prepare-ready changes.
use super::{MAX_DIFF_FILES, optional_id};
use crate::platform_objects::{entry_type, supplied_trees};
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, ObjectKind, Walk, diff_trees, hash_object},
};

/// Largest file merged textually; bigger files that both sides changed conflict.
const MAX_MERGE_BYTES: usize = 8 * 1024 * 1024;

/// Three-way merge of `theirs` into `ours` from `base`, as changes on top of `ours`.
/// Asks for trees, then for the blobs of files both sides changed (verified by id), and
/// returns prepare-ready changes (each with its expected `ours` value) plus conflicts
/// carrying diff3-marked text for a resolver.
pub(super) fn merge(c: &Value) -> Result<Value> {
    use yoneda_core::merge::{PathConflictKind, TextMerge, merge_trees, merge3};
    let trees = supplied_trees(c)?;
    let walk = merge_trees(
        optional_id(c, "base")?,
        optional_id(c, "ours")?,
        optional_id(c, "theirs")?,
        &trees,
        MAX_DIFF_FILES,
    )?;
    let plan = match walk {
        Walk::Need(ids) => return Ok(json!({ "need_trees": ids })),
        Walk::Done(plan) => plan,
    };
    let supplied = c["blobs"].as_object();
    let mut need = std::collections::BTreeSet::new();
    let mut blob = |id: &ObjectId| -> Result<Option<Vec<u8>>> {
        let Some(encoded) = supplied
            .and_then(|b| b.get(&id.hex()))
            .and_then(Value::as_str)
        else {
            need.insert(*id);
            return Ok(None);
        };
        let data = STANDARD
            .decode(encoded)
            .map_err(|_| bad("Blob content is not base64"))?;
        if hash_object(ObjectKind::Blob, &data) != *id {
            return Err(Error::new(
                "BLOB_INVALID",
                format!("Supplied blob does not match {id}"),
            ));
        }
        Ok(Some(data))
    };
    let mut inputs = Vec::new();
    for content in &plan.content {
        let base = match content.base {
            Some(id) => blob(&id)?,
            None => Some(Vec::new()),
        };
        inputs.push((content, base, blob(&content.ours)?, blob(&content.theirs)?));
    }
    if !need.is_empty() {
        return Ok(json!({ "need_blobs": need }));
    }
    let mut changes = Vec::new();
    let mut conflicts: Vec<Value> = plan
        .conflicts
        .iter()
        .map(|(path, kind)| json!({ "path": path, "kind": kind }))
        .collect();
    for (path, entry) in &plan.take {
        changes.push(match entry {
            Some((mode, id)) => json!({ "path": path, "blob": id, "type": entry_type(*mode) }),
            None => json!({ "path": path, "delete": true }),
        });
    }
    for (content, base, ours, theirs) in inputs {
        let (Some(base), Some(ours), Some(theirs)) = (base, ours, theirs) else {
            continue;
        };
        // Every content conflict names its three sides, so the writer can reconcile.
        let sides = json!({ "base": content.base, "ours": content.ours, "theirs": content.theirs });
        let conflict = |extra: Value| {
            let mut c = json!({ "path": content.path, "kind": PathConflictKind::Content });
            for (k, v) in sides
                .as_object()
                .into_iter()
                .flatten()
                .chain(extra.as_object().into_iter().flatten())
            {
                c[k] = v.clone();
            }
            c
        };
        if base.len().max(ours.len()).max(theirs.len()) > MAX_MERGE_BYTES {
            conflicts.push(conflict(json!({ "too_large": true })));
            continue;
        }
        match merge3(&base, &ours, &theirs) {
            TextMerge::Clean(merged) => changes.push(json!({
                "path": content.path, "content_b64": STANDARD.encode(merged),
                "type": entry_type(content.mode), "expect": content.ours,
            })),
            TextMerge::Conflict { marked, regions } => conflicts.push(conflict(
                json!({ "marked_b64": STANDARD.encode(marked), "regions": regions }),
            )),
            TextMerge::Binary => conflicts.push(conflict(json!({ "binary": true }))),
        }
    }
    Ok(json!({ "changes": changes, "conflicts": conflicts }))
}

/// Changes that re-apply (`pick`) or undo (`revert`) the diff from `old` to `new` on
/// another parent. Each change carries the blob it expects there, so the authority
/// rejects the result with CONFLICT instead of silently overwriting later edits.
pub(super) fn replay_changes(c: &Value) -> Result<Value> {
    let revert = match string(c, "direction")?.as_str() {
        "revert" => true,
        "pick" => false,
        _ => return Err(bad("direction must be revert or pick")),
    };
    let trees = supplied_trees(c)?;
    let walk = diff_trees(
        optional_id(c, "old")?,
        optional_id(c, "new")?,
        &trees,
        MAX_DIFF_FILES,
    )?;
    let changes = match walk {
        Walk::Need(ids) => return Ok(json!({ "need_trees": ids })),
        Walk::Done(changes) => changes,
    };
    let listed = changes
        .iter()
        .map(|ch| {
            let (from, to) = if revert {
                (ch.new, ch.old)
            } else {
                (ch.old, ch.new)
            };
            let mut change = json!({ "path": ch.path, "expect": from.map(|(_, id)| id) });
            match to {
                Some((mode, id)) => {
                    change["blob"] = json!(id);
                    change["type"] = json!(entry_type(mode));
                }
                None => change["delete"] = json!(true),
            }
            change
        })
        .collect::<Vec<_>>();
    Ok(json!({ "changes": listed }))
}
