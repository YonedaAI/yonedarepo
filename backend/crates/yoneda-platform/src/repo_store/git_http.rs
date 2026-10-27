//! Git over HTTPS (smart HTTP) as the authority sees it: who may fetch or push, and which
//! commits a fetch must send. Stock Git reads and writes whole repositories, so a
//! path-restricted grant is refused outright, as for `clone`.
use super::auth::Actor;
use super::rows::{self, RecordedGraph, Settings};
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use std::collections::{BinaryHeap, HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{CommitGraph, ObjectId},
};

/// Most commits one fetch sends; a larger history needs a partial clone (not yet served).
const WALK_COMMITS: usize = 100_000;
const HAVES: usize = 10_000;

/// `repo_git_access`: `read` fetches, `write` pushes (landing a protected ref still needs
/// what landing needs); either way over the whole repository.
pub fn access(actor: &Actor, c: &Value, settings: &Settings) -> Result<Value> {
    match string(c, "service")?.as_str() {
        "git-upload-pack" => actor.require("read")?,
        "git-receive-pack" => actor.require("write")?,
        _ => return Err(bad("service must be git-upload-pack or git-receive-pack")),
    }
    whole_repository(actor)?;
    // A push's files are scanned for credentials, excusing what the owner allowed.
    Ok(json!({
        "object_store": settings.object_store, "principal": actor.principal,
        "secret_allow": settings.policy.secret_allow,
    }))
}

pub fn whole_repository(actor: &Actor) -> Result<()> {
    if actor.grant.is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Git over HTTPS reads and writes the whole repository; a path-restricted token cannot use it",
        ));
    }
    Ok(())
}

fn ids(c: &Value, key: &str, limit: usize) -> Result<Vec<ObjectId>> {
    let list = c[key]
        .as_array()
        .ok_or_else(|| bad(&format!("{key} must be a list")))?;
    if list.len() > limit {
        return Err(Error::new("TOO_LARGE", format!("Too many {key}")));
    }
    list.iter()
        .map(|v| ObjectId::parse(v.as_str().unwrap_or_default()))
        .collect()
}

const WANTED: u8 = 1;
const COMMON: u8 = 2;

/// `repo_git_walk`: the commits reachable from `wants` but not from the recorded `haves`
/// (`git rev-list wants --not haves`), newest first, each with its tree, parents and its
/// first parent's tree (what the client already has of it, when that parent is common),
/// and the recorded haves in request order. Walks by generation, so it stops once only
/// common history is left; `common_only` (a negotiation round) skips the walk.
pub fn walk<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let wants = ids(c, "wants", HAVES)?;
    let haves = ids(c, "haves", HAVES)?;
    let graph = RecordedGraph(db);
    let mut marks: HashMap<ObjectId, u8> = HashMap::new();
    let mut queue = BinaryHeap::new();
    for want in &wants {
        let row = rows::commit_row(db, want)?.ok_or_else(|| {
            Error::new(
                "NOT_FOUND",
                format!("{want} is not a commit in this repository"),
            )
        })?;
        *marks.entry(*want).or_default() |= WANTED;
        queue.push((row.generation, *want));
    }
    let mut common = Vec::new();
    for have in &haves {
        if let Some(row) = rows::commit_row(db, have)? {
            *marks.entry(*have).or_default() |= COMMON;
            queue.push((row.generation, *have));
            common.push(*have);
        }
    }
    // A negotiation round only asks which haves are common.
    if c["common_only"] == true {
        return Ok(json!({ "common": common }));
    }
    let mut done = HashSet::new();
    let mut send = Vec::new();
    while queue.iter().any(|(_, id)| marks[id] == WANTED) {
        let Some((_, id)) = queue.pop() else { break };
        if !done.insert(id) {
            continue;
        }
        // Every child has a higher generation and was popped first: this mark is final.
        let mark = marks[&id];
        for parent in graph.parents(&id)? {
            let entry = marks.entry(parent).or_default();
            if *entry | mark != *entry {
                *entry |= mark;
                queue.push((graph.generation(&parent)?, parent));
            }
        }
        if mark == WANTED {
            send.push(id);
            if send.len() > WALK_COMMITS {
                return Err(Error::new(
                    "TOO_LARGE",
                    format!("A fetch sends at most {WALK_COMMITS} commits"),
                ));
            }
        }
    }
    let mut commits = Vec::with_capacity(send.len());
    for id in send {
        let row = rows::recorded(db, &id)?;
        let base_tree = match row.parents.first() {
            Some(parent) => rows::commit_row(db, parent)?.map(|p| p.tree),
            None => None,
        };
        commits.push(json!({
            "commit": id, "tree": row.tree, "parents": row.parents, "base_tree": base_tree,
        }));
    }
    Ok(json!({ "commits": commits, "common": common }))
}
