//! Git over HTTPS (smart HTTP) as the authority sees it: who may fetch or push, and which
//! commits a fetch must send. Stock Git reads and writes whole repositories, so a
//! path-restricted grant is refused outright, as for `clone`.
use super::auth::Actor;
use super::rows::{self, RecordedGraph, Settings};
use super::{git_shallow, git_wanted};
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use std::collections::{BinaryHeap, HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{CommitGraph, ObjectId},
};

/// Most commits one fetch sends.
const WALK_COMMITS: usize = 100_000;
const HAVES: usize = 10_000;
/// Wants of a v2 fetch, which may name every file a partial clone's checkout lacks (Git
/// asks for them in one request); what one answer sends is capped by the upload session.
const OBJECT_WANTS: usize = 100_000;

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
/// first parent's tree (what the client already has of it, when that parent is common;
/// none for a shallow boundary), and the recorded haves in request order. Walks by
/// generation, so it stops once only common history is left; `common_only` (a negotiation
/// round) skips the walk. A shallow fetch (`shallows`, `depth`, `deepen_relative`) is cut
/// as `git_shallow` plans and answers its `shallow` and `unshallow` lines. With `objects`
/// (protocol v2, where a partial clone fetches missing blobs by id), wants that are not
/// commits are listed as `objects` for the adapter to read from this repository's store.
/// Every want, commit or blob, must be reachable from a branch or tag (`git_wanted`).
pub fn walk<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let v2_objects = c["objects"] == true;
    let wants = ids(c, "wants", if v2_objects { OBJECT_WANTS } else { HAVES })?;
    let haves = ids(c, "haves", HAVES)?;
    let graph = RecordedGraph(db);
    let mut marks: HashMap<ObjectId, u8> = HashMap::new();
    let mut queue = BinaryHeap::new();
    let recorded = git_wanted::generations(db, &wants)?;
    let (mut wanted, mut objects) = (Vec::new(), Vec::new());
    for want in &wants {
        match recorded.get(want) {
            Some(generation) => {
                *marks.entry(*want).or_default() |= WANTED;
                queue.push((*generation, *want));
                wanted.push((*want, *generation));
            }
            None if v2_objects => objects.push(*want),
            None => {
                return Err(Error::new(
                    "NOT_FOUND",
                    format!("{want} is not a commit in this repository"),
                ));
            }
        }
    }
    let mut common = Vec::new();
    for have in &haves {
        if let Some(row) = rows::commit_row(db, have)? {
            *marks.entry(*have).or_default() |= COMMON;
            queue.push((row.generation, *have));
            common.push(*have);
        }
    }
    // Every round, a negotiation one too: nothing a branch or tag does not reach is served.
    git_wanted::require_reachable(db, &graph, &wanted, &objects)?;
    // A negotiation round only asks which haves are common.
    if c["common_only"] == true {
        return Ok(json!({ "common": common }));
    }
    let wanted: Vec<ObjectId> = wanted.into_iter().map(|(id, _)| id).collect();
    let shallow = git_shallow::plan(db, &graph, c, &wanted)?;
    for id in shallow.client.iter().chain(&shallow.starts) {
        let mark = if shallow.client.contains(id) {
            COMMON
        } else {
            WANTED
        };
        *marks.entry(*id).or_default() |= mark;
        queue.push((graph.generation(id)?, *id));
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
        let parents = if shallow.stops.contains(&id) {
            Vec::new()
        } else {
            graph.parents(&id)?
        };
        for parent in parents {
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
            Some(_) if shallow.boundaries.contains(&id) => None,
            Some(parent) => rows::commit_row(db, parent)?.map(|p| p.tree),
            None => None,
        };
        commits.push(json!({
            "commit": id, "tree": row.tree, "parents": row.parents, "base_tree": base_tree,
        }));
    }
    Ok(json!({
        "commits": commits, "common": common, "objects": objects,
        "shallow": shallow.shallow, "unshallow": shallow.unshallow,
    }))
}
