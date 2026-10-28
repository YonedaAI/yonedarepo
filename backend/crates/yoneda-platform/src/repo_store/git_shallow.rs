//! The shallow side of a fetch (`git clone --depth N`, `git fetch --deepen N`,
//! `--unshallow`), as Git's upload-pack decides it. A depth counts commits from the wants
//! (from the client's shallow commits with `deepen_relative`, which then count as depth 1
//! of N + 1); commits at the last depth that have parents are the new shallow boundaries.
//! The client's shallow commits within the depth are unshallowed and their parents
//! wanted. Neither side of the walk passes a boundary or a client shallow commit: the
//! client holds no parent of one.
use super::rows;
use crate::storage::SqlStore;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque, hash_map::Entry};
use yoneda_core::{
    Error, Result,
    git_object::{CommitGraph, ObjectId},
    transport::INFINITE_DEPTH,
};

/// Most commits a depth may cover; past it, a fetch is a full one.
const DEPTH_COMMITS: usize = 100_000;

#[derive(Default)]
pub struct Shallow {
    /// The client's shallow commits this repository records: it holds each one.
    pub client: Vec<ObjectId>,
    /// Commits whose parents the walk does not follow.
    pub stops: HashSet<ObjectId>,
    /// Every boundary: sent with its whole tree, as its parents are not sent.
    pub boundaries: HashSet<ObjectId>,
    /// `shallow` lines: boundaries the client does not already have as shallow.
    pub shallow: Vec<ObjectId>,
    pub unshallow: Vec<ObjectId>,
    /// Parents of unshallowed commits, wanted in addition to the wants.
    pub starts: Vec<ObjectId>,
}

/// Plans `{shallows, depth, deepen_relative}` for the commit `wants`.
pub fn plan<S: SqlStore>(
    db: &S,
    graph: &impl CommitGraph,
    c: &Value,
    wants: &[ObjectId],
) -> Result<Shallow> {
    let mut out = Shallow::default();
    for id in c["shallows"].as_array().into_iter().flatten() {
        let id = ObjectId::parse(id.as_str().unwrap_or_default())?;
        // Git skips a shallow commit it does not have, as upload-pack does.
        if rows::commit_row(db, &id)?.is_some() && !out.client.contains(&id) {
            out.client.push(id);
        }
    }
    out.stops.extend(out.client.iter().copied());
    let Some(depth) = c["depth"].as_u64() else {
        return Ok(out);
    };
    let depth = u32::try_from(depth).unwrap_or(INFINITE_DEPTH).max(1);
    if depth >= INFINITE_DEPTH {
        out.unshallow = out.client.clone();
    } else {
        let (sources, limit) = if c["deepen_relative"] == true {
            (out.client.as_slice(), depth + 1)
        } else {
            (wants, depth)
        };
        let (distance, boundaries) = depths(graph, sources, limit)?;
        out.unshallow = out
            .client
            .iter()
            .filter(|id| distance.get(id).is_some_and(|d| *d < limit))
            .copied()
            .collect();
        out.shallow = boundaries
            .iter()
            .filter(|id| !out.client.contains(id))
            .copied()
            .collect();
        out.stops.extend(boundaries.iter().copied());
        out.boundaries = boundaries.into_iter().collect();
    }
    for id in &out.unshallow {
        out.starts.extend(graph.parents(id)?);
    }
    Ok(out)
}

/// Each commit's least depth from `sources` (a source is depth 1), up to `limit`, and the
/// commits at `limit` that have parents, in walk order.
fn depths(
    graph: &impl CommitGraph,
    sources: &[ObjectId],
    limit: u32,
) -> Result<(HashMap<ObjectId, u32>, Vec<ObjectId>)> {
    let mut distance = HashMap::new();
    let mut queue = VecDeque::new();
    for id in sources {
        if distance.insert(*id, 1).is_none() {
            queue.push_back(*id);
        }
    }
    let mut boundaries = Vec::new();
    while let Some(id) = queue.pop_front() {
        let depth = distance[&id];
        let parents = graph.parents(&id)?;
        if depth >= limit {
            if !parents.is_empty() {
                boundaries.push(id);
            }
            continue;
        }
        for parent in parents {
            if let Entry::Vacant(slot) = distance.entry(parent) {
                slot.insert(depth + 1);
                queue.push_back(parent);
            }
        }
        if distance.len() > DEPTH_COMMITS {
            return Err(Error::new(
                "TOO_LARGE",
                format!("A depth covers at most {DEPTH_COMMITS} commits; fetch without one"),
            ));
        }
    }
    Ok((distance, boundaries))
}
