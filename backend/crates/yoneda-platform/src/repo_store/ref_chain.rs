//! Branches' first-parent chains, kept as their refs move, so path history finds the
//! commits that changed a path from that path's own rows (`commit_paths` by path) rather
//! than by walking every first parent (3 statements a commit, up to 5,000 commits).
//! Each chain entry is a commit and its depth along the chain; a move adds the commits
//! between the new head and where its first parents meet the chain, and drops the entries
//! above that point (a rewind or forced move). A chain starts from the commit whose first
//! parent is not recorded (as the walk did) or, past `BUILD` commits, from its newest ones:
//! a branch that held more history before this index existed keeps the walk below them.
use super::rows;
use crate::storage::SqlStore;
use serde_json::json;
use yoneda_core::{Result, git_object::ObjectId};

/// First parents one move walks at most to meet the chain (the walk's own MAX_SCAN).
const BUILD: usize = 5_000;
/// Depth below which a chain started without reaching the start of history begins.
const PARTIAL: i64 = 1_000_000_000;

/// `commit`'s depth on `refname`'s chain, if the chain holds it.
pub fn depth<S: SqlStore>(db: &S, refname: &str, commit: &ObjectId) -> Result<Option<i64>> {
    Ok(db
        .query(
            "SELECT depth FROM ref_chain WHERE ref=? AND commit_id=?",
            &[json!(refname), json!(commit.hex())],
        )?
        .first()
        .and_then(|row| row["depth"].as_i64()))
}

/// The branches holding `commit`: at their head, on their chain, or landed on a protected
/// one (those never rewind, and a merged commit is on no chain). O(branches).
pub fn branches_holding<S: SqlStore>(db: &S, commit: &ObjectId) -> Result<Vec<String>> {
    let id = [json!(commit.hex())];
    let moved = db.query(
        "SELECT name FROM refs WHERE name LIKE 'refs/heads/%' AND (commit_id=?1 OR EXISTS \
         (SELECT 1 FROM ref_chain c WHERE c.ref=refs.name AND c.commit_id=?1))",
        &id,
    )?;
    let landed = db.query(
        "SELECT refname AS name FROM landings WHERE commit_id=?",
        &id,
    )?;
    let name = |row: &serde_json::Value| row["name"].as_str().unwrap_or_default().to_owned();
    let mut branches: Vec<String> = moved.iter().map(name).collect();
    branches.extend(landed.iter().map(name).filter(|r| rows::protected(r)));
    Ok(branches)
}

/// Records `refname` now at `head` (a recorded commit).
pub fn advance<S: SqlStore>(db: &S, refname: &str, head: &ObjectId) -> Result<()> {
    if let Some(at) = depth(db, refname, head)? {
        return truncate(db, refname, at);
    }
    let mut walked = Vec::new();
    let mut next = *head;
    let mut row = rows::commit_row(db, head)?;
    let base = loop {
        walked.push(next);
        if walked.len() >= BUILD {
            truncate(db, refname, 0)?;
            break PARTIAL;
        }
        let Some(parent) = row.as_ref().and_then(|r| r.parents.first().copied()) else {
            break 0;
        };
        if let Some(at) = depth(db, refname, &parent)? {
            break at;
        }
        row = rows::commit_row(db, &parent)?;
        if row.is_none() {
            break 0;
        }
        next = parent;
    };
    truncate(db, refname, base)?;
    let oldest_first: Vec<String> = walked.iter().rev().map(ObjectId::hex).collect();
    db.query(
        "INSERT INTO ref_chain(ref,depth,commit_id) \
         SELECT ?, ? + key + 1, value FROM json_each(?)",
        &[
            json!(refname),
            json!(base),
            json!(json!(oldest_first).to_string()),
        ],
    )?;
    Ok(())
}

/// Drops `refname`'s chain above `depth` (all of it at 0).
fn truncate<S: SqlStore>(db: &S, refname: &str, depth: i64) -> Result<()> {
    db.query(
        "DELETE FROM ref_chain WHERE ref=? AND depth>?",
        &[json!(refname), json!(depth)],
    )?;
    Ok(())
}

/// Forgets a deleted branch's chain.
pub fn forget<S: SqlStore>(db: &S, refname: &str) -> Result<()> {
    truncate(db, refname, i64::MIN)
}
