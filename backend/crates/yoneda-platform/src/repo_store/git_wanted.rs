//! Blobs a protocol v2 fetch wants by id (a partial clone fetching what a checkout needs)
//! are served only when a current branch or tag reaches them, as Git refuses "not our
//! ref". The store also holds objects nothing reaches: the commits and files of a push
//! refused at its ref move, of a deleted branch, or of a commit never landed.
//!
//! A blob is in a commit's tree exactly when that commit or one of its ancestors
//! introduced it (`commit_paths.new_blob`, each commit's changes against its first parent,
//! a root's against nothing). So each blob's introducing commits are looked up by index,
//! then one walk from every branch and tag tip, newest generation first, looks for one of
//! them per blob. It stops once each blob has one, or once every commit left is older than
//! the youngest candidate of a blob still open (an ancestor's generation is lower).
use super::reads::refs_at;
use super::rows;
use crate::storage::SqlStore;
use serde_json::json;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{CommitGraph, ObjectId},
};

/// Commits one reachability walk may visit.
const REACH_COMMITS: usize = 100_000;

fn not_ours(id: &ObjectId) -> Error {
    Error::new("NOT_FOUND", format!("upload-pack: not our ref {id}"))
}

/// Ok when every blob in `blobs` is in the tree of a commit some branch or tag reaches.
pub fn require_reachable<S: SqlStore>(
    db: &S,
    graph: &impl CommitGraph,
    blobs: &[ObjectId],
) -> Result<()> {
    if blobs.is_empty() {
        return Ok(());
    }
    // Candidate commit → the blobs it introduced; each blob's youngest candidate.
    let mut introduced: HashMap<ObjectId, Vec<usize>> = HashMap::new();
    let mut youngest = BinaryHeap::new();
    for (index, blob) in blobs.iter().enumerate() {
        let mut newest = None;
        for row in db.query(
            "SELECT DISTINCT commit_id FROM commit_paths WHERE new_blob=?",
            &[json!(blob.hex())],
        )? {
            let commit = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
            let Some(recorded) = rows::commit_row(db, &commit)? else {
                continue;
            };
            introduced.entry(commit).or_default().push(index);
            newest = newest.max(Some(recorded.generation));
        }
        youngest.push((newest.ok_or_else(|| not_ours(blob))?, Reverse(index)));
    }
    let mut open = vec![true; blobs.len()];
    let mut queue = BinaryHeap::new();
    for (name, tip) in refs_at(db, &json!({}), 0)? {
        if name.starts_with("refs/heads/") || name.starts_with("refs/tags/") {
            queue.push((graph.generation(&tip)?, tip));
        }
    }
    let mut seen = HashSet::new();
    while let Some((generation, id)) = queue.pop() {
        // The blob whose youngest candidate is newest decides how far down to look.
        while youngest.peek().is_some_and(|(_, Reverse(i))| !open[*i]) {
            youngest.pop();
        }
        let Some((floor, _)) = youngest.peek() else {
            return Ok(());
        };
        if generation < *floor {
            break;
        }
        if !seen.insert(id) {
            continue;
        }
        if seen.len() > REACH_COMMITS {
            return Err(Error::new(
                "TOO_LARGE",
                format!("Finding wanted objects visits at most {REACH_COMMITS} commits"),
            ));
        }
        for index in introduced.get(&id).into_iter().flatten() {
            open[*index] = false;
        }
        for parent in graph.parents(&id)? {
            queue.push((graph.generation(&parent)?, parent));
        }
    }
    match open.iter().position(|o| *o) {
        Some(index) => Err(not_ours(&blobs[index])),
        None => Ok(()),
    }
}
