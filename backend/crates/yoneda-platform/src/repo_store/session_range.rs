//! Which commits a session listing covers: those reachable from a branch head or a given
//! commit, less those reachable from a base commit. With a change's head and its merge base
//! with main, that is the commits the change introduces.
use super::rows;
use crate::storage::{SqlStore, bad};
use serde_json::Value;
use std::collections::HashSet;
use yoneda_core::{Result, git_object::ObjectId};

/// Commits walked back from each end, at most.
const SCAN: usize = 2000;

/// The commits in range, and whether the walk from the head stopped early. The base walk is
/// capped too, but the head walk stops at every base commit it reaches, so a cut there only
/// shows when the head walk wanders into unexcluded history and is cut itself.
pub(super) struct Range {
    pub commits: HashSet<String>,
    pub truncated: bool,
}

/// Commits reachable from `start`, not walking into `stop`, at most `SCAN` of them.
fn reachable<S: SqlStore>(
    db: &S,
    start: Option<ObjectId>,
    stop: &HashSet<String>,
) -> Result<(HashSet<String>, bool)> {
    let mut seen = HashSet::new();
    let mut queue: Vec<ObjectId> = start.into_iter().collect();
    while let Some(id) = queue.pop() {
        if seen.len() >= SCAN {
            return Ok((seen, true));
        }
        let hex = id.hex();
        if stop.contains(&hex) || !seen.insert(hex) {
            continue;
        }
        if let Some(row) = rows::commit_row(db, &id)? {
            queue.extend(row.parents);
        }
    }
    Ok((seen, false))
}

/// A commit id given as `key`, when present.
pub(super) fn commit_param(c: &Value, key: &str) -> Result<Option<ObjectId>> {
    match &c[key] {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        Value::String(s) => ObjectId::parse(s)
            .map(Some)
            .map_err(|_| bad(&format!("{key} must be a commit id"))),
        _ => Err(bad(&format!("{key} must be a commit id"))),
    }
}

/// The range from `refname`'s last projected head (a landing still projecting joins once
/// it is projected) or from `head`, less what `base` reaches.
pub(super) fn range<S: SqlStore>(
    db: &S,
    refname: Option<&str>,
    head: Option<ObjectId>,
    base: Option<ObjectId>,
) -> Result<Range> {
    let start = match (refname, head) {
        (Some(_), Some(_)) => return Err(bad("Give ref or head, not both")),
        (Some(name), None) => rows::projected_ref(db, name)?,
        (None, head) => head,
    };
    let (excluded, _) = reachable(db, base, &HashSet::new())?;
    let (commits, truncated) = reachable(db, start, &excluded)?;
    Ok(Range { commits, truncated })
}
