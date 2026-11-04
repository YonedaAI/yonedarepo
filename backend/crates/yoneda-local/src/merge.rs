//! A platform merge commit for work whose branch moved, as the Worker builds one: the
//! authority plans it (`repo_merge_plan`), compute merges the trees, the merger prepares
//! the commit, the store receives its pack under a hidden ref (as the cloud's object store
//! does), and the authority records it after reading it back. Landing it is the caller's:
//! `repo_land` with `merge` verifies it against the head.
use crate::authority::{Authority, Cred};
use crate::compute;
use crate::layout::local_error;
use crate::store::Store;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use yoneda_core::{
    Error, Result,
    git_object::{Commit, ObjectId},
};

const MERGER: Cred = Cred::System("merge");
const AUTHOR: (&str, &str) = ("YonedaRepo", "commits@yonedarepo.invalid");

/// The conflicting paths of a merge that cannot be built, in the CONFLICT's message.
pub fn conflict(paths: &[String]) -> Error {
    Error::new(
        "CONFLICT",
        format!("Concurrent changes conflict in {}", paths.join(", ")),
    )
}

/// Builds and records the merge of `commit` into `refname`'s head; answers its id.
pub fn build(
    authority: &Authority,
    cred: &Cred,
    store: &Store,
    refname: &str,
    commit: &str,
) -> Result<ObjectId> {
    let plan = authority.call(
        cred,
        json!({ "op": "repo_merge_plan", "ref": refname, "commit": commit }),
    )?;
    let merged = compute::run(
        store,
        json!({ "op": "merge_trees", "base": plan["base_tree"], "ours": plan["head_tree"],
                "theirs": plan["commit_tree"] }),
    )?;
    let conflicts: Vec<String> = merged["conflicts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["path"].as_str().or(c.as_str()).map(str::to_owned))
        .collect();
    if !conflicts.is_empty() {
        return Err(conflict(&conflicts));
    }
    let branch = refname.trim_start_matches("refs/heads/");
    let short: String = commit.chars().take(10).collect();
    let prepared = compute::supplied(store, |trees, blobs| {
        authority.call(
            &MERGER,
            json!({ "op": "repo_prepare_commit", "parent": plan["head"], "merge_parent": commit,
                    "base_version": plan["version"], "changes": merged["changes"], "read_set": [],
                    "trees": trees, "blobs": blobs, "message": format!("Merge {short} into {branch}"),
                    "author": { "name": AUTHOR.0, "email": AUTHOR.1 } }),
        )
    })?;
    let push = STANDARD
        .decode(prepared["push_b64"].as_str().unwrap_or_default())
        .map_err(|_| local_error("The prepared merge has no pack"))?;
    let report = store.receive_pack(&push)?;
    let id = ObjectId::parse(prepared["commit"].as_str().unwrap_or_default())?;
    let read = store.read(&[id])?;
    let (_, data) = read
        .get(&id)
        .ok_or_else(|| local_error("The merge commit did not reach the store"))?;
    let made = Commit::decode(data)?;
    authority.call(
        &MERGER,
        json!({ "op": "repo_record_commit", "commit": id, "push_report_b64": STANDARD.encode(&report),
                "readback": { "tree": made.tree()?, "parents": made.parents()? } }),
    )?;
    Ok(id)
}

/// The paths a refused landing names: a stale read's (`… on <paths>, which this commit
/// read`) or a write conflict's.
pub fn stale_reads(e: &Error) -> Vec<String> {
    e.message
        .split_once(" on ")
        .and_then(|(_, rest)| rest.split_once(", which this commit read"))
        .map(|(paths, _)| paths.split(", ").map(str::to_owned).collect())
        .unwrap_or_default()
}

/// The paths a write CONFLICT's message names after "in ".
pub fn conflict_paths(e: &Error) -> Vec<String> {
    e.message
        .rsplit_once(" in ")
        .map(|(_, paths)| paths.split(", ").map(|p| p.trim().to_owned()).collect())
        .unwrap_or_default()
}
