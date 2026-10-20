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
        "receive_pack" => receive_pack(&c),
        "replay_changes" => replay_changes(&c),
        "merge_trees" => merge(&c),
        "grant_check" => grant_check(&c),
        "search_plan" => crate::platform_derived::plan(&c),
        "index_partition" => crate::platform_derived::index_partition(&c),
        "search_segment" => crate::platform_derived::search_segment(&c),
        "grep" => crate::platform_derived::grep_blob(&c),
        "blame" => crate::platform_derived::blame_versions(&c),
        "symbols" => crate::platform_code::symbols(&c),
        "symbol_edit" => crate::platform_code::symbol_edit(&c),
        "review_classes" => crate::platform_code::review_classes(&c),
        "symbol_touches" => crate::platform_access::symbol_touches(&c),
        "work_plan" => crate::platform_access::work_plan(&c),
        "replace_literal" => crate::platform_code::replace_literal(&c),
        "code_facts" => crate::platform_facts::code_facts(&c),
        "view_files" => crate::platform_facts::view_files(&c),
        "symbol_contract" => crate::platform_symbol_graph::contract_view(&c),
        "agent_view" => crate::platform_symbol_graph::agent_view(&c),
        "human_view" => crate::platform_views::human_view(&c),
        "ref_update" => ref_update(&c),
        "ref_delete" => ref_delete(&c),
        "push_report" => push_report(&c),
        "push_outcome" => push_outcome(&c),
        "push_combine" => crate::platform_push::push_combine(&c),
        "push_split" => crate::platform_push::push_split(&c),
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
        Walk::Done(changes) => json!({ "changes": with_renames(changes.iter().map(|ch| {
            let side = |s: Option<(yoneda_core::git_object::FileMode, ObjectId)>| {
                s.map(|(m, id)| json!({"type": entry_type(m), "id": id}))
            };
            let op = match (&ch.old, &ch.new) {
                (None, _) => "add",
                (_, None) => "delete",
                _ => "modify",
            };
            json!({"path": ch.path, "op": op, "old": side(ch.old), "new": side(ch.new)})
        }).collect::<Vec<_>>()) }),
    })
}

/// Pairs a deleted and an added file with the same blob and mode into one exact rename
/// (`op: rename`, `old_path`), like `git diff -M100%`.
fn with_renames(changes: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(changes.len());
    let mut deleted: Vec<Value> = changes
        .iter()
        .filter(|c| c["op"] == "delete")
        .cloned()
        .collect();
    for change in changes.into_iter().filter(|c| c["op"] != "delete") {
        let twin = (change["op"] == "add")
            .then(|| deleted.iter().position(|d| d["old"] == change["new"]))
            .flatten();
        match twin {
            Some(index) => {
                let gone = deleted.remove(index);
                out.push(
                    json!({ "path": change["path"], "op": "rename", "old_path": gone["path"],
                    "old": gone["old"], "new": change["new"] }),
                );
            }
            None => out.push(change),
        }
    }
    out.extend(deleted);
    out.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    out
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

/// Grant decisions for the adapter, so grant semantics live in one place: `allows` for
/// files and `sees` for directories on the way to granted paths.
fn grant_check(c: &Value) -> Result<Value> {
    use crate::repo_store::grants;
    let grant = grants::parse(&c["grant"])?;
    let decide = |key: &str, f: fn(&grants::Grant, &str) -> bool| -> Vec<bool> {
        c[key]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| f(&grant, p.as_str().unwrap_or_default()))
            .collect()
    };
    Ok(json!({ "paths": decide("paths", grants::allows), "dirs": decide("dirs", grants::sees) }))
}

/// Largest file merged textually; bigger files that both sides changed conflict.
const MAX_MERGE_BYTES: usize = 8 * 1024 * 1024;

/// Three-way merge of `theirs` into `ours` from `base`, as changes on top of `ours`.
/// Asks for trees, then for the blobs of files both sides changed (verified by id), and
/// returns prepare-ready changes (each with its expected `ours` value) plus conflicts
/// carrying diff3-marked text for a resolver.
fn merge(c: &Value) -> Result<Value> {
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
        if base.len().max(ours.len()).max(theirs.len()) > MAX_MERGE_BYTES {
            conflicts.push(json!({ "path": content.path, "kind": PathConflictKind::Content, "too_large": true }));
            continue;
        }
        match merge3(&base, &ours, &theirs) {
            TextMerge::Clean(merged) => changes.push(json!({
                "path": content.path, "content_b64": STANDARD.encode(merged),
                "type": entry_type(content.mode), "expect": content.ours,
            })),
            TextMerge::Conflict { marked, regions } => conflicts.push(json!({
                "path": content.path, "kind": PathConflictKind::Content,
                "marked_b64": STANDARD.encode(marked), "regions": regions,
            })),
            TextMerge::Binary => conflicts.push(json!({
                "path": content.path, "kind": PathConflictKind::Content, "binary": true,
            })),
        }
    }
    Ok(json!({ "changes": changes, "conflicts": conflicts }))
}

/// Changes that re-apply (`pick`) or undo (`revert`) the diff from `old` to `new` on
/// another parent. Each change carries the blob it expects there, so the authority
/// rejects the result with CONFLICT instead of silently overwriting later edits.
fn replay_changes(c: &Value) -> Result<Value> {
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

/// A ref-only receive-pack request (empty pack) moving a branch from `old` (expected-old
/// lease; null to create) to `new`, which the object store already holds.
fn ref_update(c: &Value) -> Result<Value> {
    use yoneda_core::git_object::{receive_pack_request, write_pack};
    let refname = string(c, "refname")?;
    if !refname.starts_with("refs/heads/") {
        return Err(bad("Only branch refs are projected"));
    }
    let new = ObjectId::parse(&string(c, "new")?)?;
    let body = receive_pack_request(&refname, optional_id(c, "old")?, new, &write_pack(&[])?)?;
    Ok(json!({ "push_b64": STANDARD.encode(body) }))
}

/// Releases a commit's hidden ref (vacuum) so the object store may collect it.
fn ref_delete(c: &Value) -> Result<Value> {
    let commit = ObjectId::parse(&string(c, "commit")?)?;
    let refname = yoneda_core::git_object::hidden_ref(&commit);
    let body = yoneda_core::git_object::receive_pack_delete(&refname, commit)?;
    Ok(json!({ "push_b64": STANDARD.encode(body), "refname": refname }))
}

/// The report-status an object store answers with (R2 store).
fn push_report(c: &Value) -> Result<Value> {
    let refname = string(c, "refname")?;
    let report = yoneda_core::git_object::receive_pack_report(&refname, c["refused"].as_str());
    Ok(json!({ "report_b64": STANDARD.encode(report) }))
}

fn push_outcome(c: &Value) -> Result<Value> {
    let report = STANDARD
        .decode(string(c, "report_b64")?)
        .map_err(|_| bad("report_b64 is not base64"))?;
    let refused = yoneda_core::git_object::receive_pack_outcome(&report, &string(c, "refname")?)?;
    Ok(json!({ "accepted": refused.is_none(), "refused": refused }))
}

/// Server side of a push for the R2 object store (local development and fallback):
/// unpacks and verifies the objects and answers with Git's report-status.
fn receive_pack(c: &Value) -> Result<Value> {
    use yoneda_core::git_object::{PackLimits, parse_receive_pack_request, read_pack};
    let body = STANDARD
        .decode(
            c["body_b64"]
                .as_str()
                .ok_or_else(|| bad("Missing body_b64"))?,
        )
        .map_err(|_| bad("body_b64 is not base64"))?;
    let push = parse_receive_pack_request(&body)?;
    if push.new == ObjectId::from_bytes([0; 20]) {
        // A delete carries no pack.
        return Ok(
            json!({ "ref": push.refname, "old": push.old, "new": null, "delete": true, "objects": [] }),
        );
    }
    let objects = read_pack(push.pack, PackLimits::default())?
        .into_iter()
        .map(|(kind, data)| {
            let id = hash_object(kind, &data);
            crate::platform_objects::object_json(id, kind, &data)
        })
        .collect::<Result<Vec<_>>>()?;
    // Ref-only updates (projections) carry an empty pack: the store must already hold
    // `new`, which the adapter checks before accepting.
    let contains_new = objects
        .iter()
        .any(|o| o["id"] == json!(push.new) && o["kind"] == "commit");
    Ok(json!({
        "ref": push.refname, "old": push.old, "new": push.new, "objects": objects,
        "contains_new": contains_new,
    }))
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
    fn ref_updates_carry_an_empty_pack_and_reports_classify() {
        let new = blob("commit stand-in");
        let update = compute(
            json!({"op": "ref_update", "refname": "refs/heads/main", "old": null, "new": new}),
        )
        .unwrap();
        let received =
            compute(json!({"op": "receive_pack", "body_b64": update["push_b64"]})).unwrap();
        assert_eq!(received["objects"], json!([]));
        assert_eq!(received["contains_new"], false);
        assert_eq!(received["ref"], "refs/heads/main");
        let refused = compute(
            json!({"op": "push_report", "refname": "refs/heads/main", "refused": "stale info"}),
        )
        .unwrap();
        let outcome = compute(json!({"op": "push_outcome", "refname": "refs/heads/main", "report_b64": refused["report_b64"]})).unwrap();
        assert_eq!(outcome, json!({"accepted": false, "refused": "stale info"}));
        assert!(
            compute(json!({"op": "ref_update", "refname": "refs/yoneda/c/x", "new": new})).is_err()
        );
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
