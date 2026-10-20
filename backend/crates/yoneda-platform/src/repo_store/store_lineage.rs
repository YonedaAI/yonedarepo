//! Which commits Artifacts holds. Platform-built commits live in R2 (the store of record)
//! and reach Artifacts with the first protected ref that includes them: the projector asks
//! for every commit reachable from the ref's target that Artifacts lacks, pushes their
//! objects with the ref update in one receive-pack and reports them stored.
use super::rows::corrupt;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{Error, Result, git_object::ObjectId};

const WALK_COMMITS: usize = 5000;

/// Commits reachable from `refname`'s projection target that Artifacts lacks, oldest
/// first (by generation), each with the ids of the objects it introduced.
pub fn unprojected<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = string(c, "refname")?;
    let target = db
        .query(
            "SELECT target_commit FROM ref_projections WHERE refname=?",
            &[json!(refname)],
        )?
        .first()
        .and_then(|r| r["target_commit"].as_str().map(str::to_owned))
        .ok_or_else(|| bad("Unknown projected ref"))?;
    let mut stack = vec![target.clone()];
    let mut seen = BTreeSet::new();
    let mut missing = Vec::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if seen.len() > WALK_COMMITS {
            return Err(Error::new(
                "TOO_LARGE",
                "Too many commits to project in one push",
            ));
        }
        let row = db
            .query(
                "SELECT parents,generation,artifacts_at FROM commits WHERE id=?",
                &[json!(id)],
            )?
            .into_iter()
            .next()
            .ok_or_else(|| corrupt("commit graph"))?;
        if !row["artifacts_at"].is_null() {
            continue;
        }
        let parents: Vec<String> = serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
            .map_err(|_| corrupt("parents"))?;
        stack.extend(parents);
        missing.push((row["generation"].as_u64().unwrap_or(0), id));
    }
    missing.sort();
    let mut commits = Vec::new();
    for (_, id) in missing {
        let objects = db.query(
            "SELECT id,kind FROM commit_objects WHERE commit_id=? ORDER BY id",
            &[json!(id)],
        )?;
        if objects.is_empty() {
            return Err(corrupt("commit objects to project"));
        }
        commits.push(json!({ "commit": id, "objects": objects }));
    }
    Ok(json!({ "refname": refname, "target": target, "commits": commits }))
}

/// Marks commits as held by Artifacts (under their own hidden refs when `hidden`) and drops
/// their object lists.
pub fn stored<S: SqlStore>(db: &S, commits: &[Value], hidden: bool, now: i64) -> Result<()> {
    for commit in commits {
        let id = ObjectId::parse(commit.as_str().unwrap_or_default())?;
        db.query(
            "UPDATE commits SET artifacts_at=COALESCE(artifacts_at,?),hidden_ref=MAX(hidden_ref,?) WHERE id=?",
            &[json!(now), json!(i64::from(hidden)), json!(id.hex())],
        )?;
        db.query(
            "DELETE FROM commit_objects WHERE commit_id=?",
            &[json!(id.hex())],
        )?;
    }
    Ok(())
}

/// `repo_objects_stored`: a projection too large for one push stores its oldest commits
/// first, each under its own hidden ref.
pub fn stored_op<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let commits = c["commits"]
        .as_array()
        .ok_or_else(|| bad("commits must be a list"))?;
    stored(db, commits, true, number(c, "now")?)?;
    Ok(json!({ "stored": commits.len() }))
}
