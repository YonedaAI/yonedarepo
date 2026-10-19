//! Commit-graph queries using generation numbers (1 + max parent generation), so walks
//! stop early instead of scanning history. Generations are stored per commit at record time.
use super::ObjectId;
use crate::Result;
use std::collections::{BTreeMap, BinaryHeap, HashMap};

pub trait CommitGraph {
    fn parents(&self, id: &ObjectId) -> Result<Vec<ObjectId>>;
    fn generation(&self, id: &ObjectId) -> Result<u64>;
}

pub fn next_generation(parent_generations: &[u64]) -> u64 {
    parent_generations.iter().copied().max().unwrap_or(0) + 1
}

/// Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor).
pub fn is_ancestor(
    graph: &impl CommitGraph,
    ancestor: &ObjectId,
    descendant: &ObjectId,
) -> Result<bool> {
    let floor = graph.generation(ancestor)?;
    let mut queue = BinaryHeap::from([(graph.generation(descendant)?, *descendant)]);
    let mut seen = std::collections::HashSet::new();
    while let Some((generation, id)) = queue.pop() {
        if id == *ancestor {
            return Ok(true);
        }
        if generation <= floor || !seen.insert(id) {
            continue;
        }
        for parent in graph.parents(&id)? {
            queue.push((graph.generation(&parent)?, parent));
        }
    }
    Ok(false)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Left = 1,
    Right = 2,
}

/// Best common ancestors (none is an ancestor of another), like `git merge-base --all`.
/// Walks highest generation first and stops once only already-common commits remain.
pub fn merge_bases(
    graph: &impl CommitGraph,
    left: &ObjectId,
    right: &ObjectId,
) -> Result<Vec<ObjectId>> {
    if left == right {
        return Ok(vec![*left]);
    }
    let mut marks: HashMap<ObjectId, u8> = HashMap::new();
    let mut queue = BinaryHeap::new();
    for (id, side) in [(*left, Side::Left), (*right, Side::Right)] {
        *marks.entry(id).or_default() |= side as u8;
        queue.push((graph.generation(&id)?, id));
    }
    let mut common: BTreeMap<ObjectId, u64> = BTreeMap::new();
    loop {
        // Once only common commits remain queued, no further base can appear; those queued
        // commits are candidates too (criss-cross merges have several bases).
        if !queue.iter().any(|(_, q)| marks[q] & 3 != 3) {
            common.extend(queue.drain().map(|(generation, id)| (id, generation)));
            break;
        }
        let Some((generation, id)) = queue.pop() else {
            break;
        };
        let mark = marks[&id];
        if mark & 3 == 3 {
            common.insert(id, generation);
        }
        for parent in graph.parents(&id)? {
            let entry = marks.entry(parent).or_default();
            let before = *entry;
            *entry |= mark;
            if *entry != before {
                queue.push((graph.generation(&parent)?, parent));
            }
        }
    }
    let candidates: Vec<ObjectId> = common.keys().copied().collect();
    let mut best = Vec::new();
    for candidate in &candidates {
        let mut dominated = false;
        for other in &candidates {
            if other != candidate && is_ancestor(graph, candidate, other)? {
                dominated = true;
                break;
            }
        }
        if !dominated {
            best.push(*candidate);
        }
    }
    Ok(best)
}
