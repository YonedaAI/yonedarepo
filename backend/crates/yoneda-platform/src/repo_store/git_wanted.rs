//! What a fetch wants by id is served only when a current branch or tag reaches it, as Git
//! refuses "not our ref". The store also holds objects nothing reaches: the commits and
//! files of a push refused at its ref move, of a deleted branch, or of a commit never
//! landed. This holds for commits (protocol v0 and v2) and for the blobs a v2 partial clone
//! fetches when a checkout needs them.
//!
//! A wanted commit is its own candidate. A blob is in a commit's tree exactly when that
//! commit or one of its ancestors introduced it (`commit_paths.new_blob`, each commit's
//! changes against its first parent, a root's against nothing), so a blob's candidates are
//! the commits that introduced it, looked up by index. One walk from every branch and tag
//! tip, newest generation first, then looks for one candidate per want. It stops once each
//! want has one, or refuses once every commit left is older than the youngest candidate of
//! a want still open (an ancestor's generation is lower).
use super::reads::refs_at;
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{CommitGraph, ObjectId},
};

/// Commits one reachability walk may visit.
const REACH_COMMITS: usize = 100_000;
/// Ids bound per lookup (a Durable Object's SQLite allows 100 parameters).
const LOOKUP: usize = 100;

fn not_ours(id: &ObjectId) -> Error {
    Error::new("NOT_FOUND", format!("upload-pack: not our ref {id}"))
}

/// `(id, generation)` of each recorded commit among `ids`.
pub fn generations<S: SqlStore>(db: &S, ids: &[ObjectId]) -> Result<HashMap<ObjectId, u64>> {
    let mut found = HashMap::new();
    for chunk in ids.chunks(LOOKUP) {
        let marks = vec!["?"; chunk.len()].join(",");
        let params: Vec<Value> = chunk.iter().map(|id| json!(id.hex())).collect();
        for row in db.query(
            &format!("SELECT id,generation FROM commits WHERE id IN ({marks})"),
            &params,
        )? {
            let id = ObjectId::parse(row["id"].as_str().unwrap_or_default())?;
            found.insert(id, row["generation"].as_u64().unwrap_or_default());
        }
    }
    Ok(found)
}

/// Ok when each of `commits` (with their generations) is reachable from a branch or tag
/// and each of `blobs` is in the tree of a commit that is.
pub fn require_reachable<S: SqlStore>(
    db: &S,
    graph: &impl CommitGraph,
    commits: &[(ObjectId, u64)],
    blobs: &[ObjectId],
) -> Result<()> {
    let wants: Vec<ObjectId> = commits
        .iter()
        .map(|(id, _)| *id)
        .chain(blobs.iter().copied())
        .collect();
    if wants.is_empty() {
        return Ok(());
    }
    // Candidate commit → the wants it satisfies; each want's youngest candidate.
    let mut satisfies: HashMap<ObjectId, Vec<usize>> = HashMap::new();
    let mut newest: Vec<Option<u64>> = vec![None; wants.len()];
    for (index, (id, generation)) in commits.iter().enumerate() {
        satisfies.entry(*id).or_default().push(index);
        newest[index] = Some(*generation);
    }
    let mut by_blob: HashMap<ObjectId, Vec<usize>> = HashMap::new();
    for (offset, blob) in blobs.iter().enumerate() {
        by_blob
            .entry(*blob)
            .or_default()
            .push(commits.len() + offset);
    }
    let distinct: Vec<ObjectId> = by_blob.keys().copied().collect();
    for chunk in distinct.chunks(LOOKUP) {
        let marks = vec!["?"; chunk.len()].join(",");
        let params: Vec<Value> = chunk.iter().map(|id| json!(id.hex())).collect();
        for row in db.query(
            &format!(
                "SELECT DISTINCT p.new_blob AS blob,p.commit_id AS commit_id,c.generation AS generation \
                 FROM commit_paths p JOIN commits c ON c.id=p.commit_id WHERE p.new_blob IN ({marks})"
            ),
            &params,
        )? {
            let blob = ObjectId::parse(row["blob"].as_str().unwrap_or_default())?;
            let commit = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
            let generation = row["generation"].as_u64().unwrap_or_default();
            for index in by_blob.get(&blob).into_iter().flatten() {
                satisfies.entry(commit).or_default().push(*index);
                newest[*index] = newest[*index].max(Some(generation));
            }
        }
    }
    let mut youngest = BinaryHeap::new();
    for (index, generation) in newest.iter().enumerate() {
        youngest.push((
            generation.ok_or_else(|| not_ours(&wants[index]))?,
            Reverse(index),
        ));
    }
    let mut open = vec![true; wants.len()];
    let mut queue = BinaryHeap::new();
    for (name, tip) in refs_at(db, &json!({}), 0)? {
        if name.starts_with("refs/heads/") || name.starts_with("refs/tags/") {
            queue.push((graph.generation(&tip)?, tip));
        }
    }
    let mut seen = HashSet::new();
    while let Some((generation, id)) = queue.pop() {
        // The open want whose youngest candidate is newest decides how far down to look.
        while youngest.peek().is_some_and(|(_, Reverse(i))| !open[*i]) {
            youngest.pop();
        }
        let Some((floor, Reverse(index))) = youngest.peek() else {
            return Ok(());
        };
        // Its candidates are all newer than anything left: none is reachable.
        if generation < *floor {
            return Err(not_ours(&wants[*index]));
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
        for index in satisfies.get(&id).into_iter().flatten() {
            open[*index] = false;
        }
        for parent in graph.parents(&id)? {
            queue.push((graph.generation(&parent)?, parent));
        }
    }
    match open.iter().position(|o| *o) {
        Some(index) => Err(not_ours(&wants[index])),
        None => Ok(()),
    }
}
