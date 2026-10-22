//! What the projector builds next: the oldest unprojected changesets of a branch, as
//! steps of one Git commit each. A batch landing's changesets form one step (up to
//! [`MERGED_PARENTS`] of them; a larger batch is cut into consecutive steps), and a
//! changeset landed on its own forms a step of its own. Each step names its landed
//! commits, which `platform_project` makes the projected commit's history.
use super::rows::{self, branch_ref};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::{
    Result,
    git_object::ObjectId,
    txlog::{TxEntry, TxKind},
};

/// Changesets per plan; a batch holds at most 256, so a whole batch always fits.
const PLAN_ROWS: u64 = 512;
/// Steps per plan: what `repo_changeset_record` accepts in one call.
pub(super) const PLAN_STEPS: usize = 64;
/// Landed commits per step: a projected merge names each as a parent, and a commit built
/// here has at most 128 merged parents.
const MERGED_PARENTS: usize = 128;

fn brief<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Value> {
    let row = rows::recorded(db, id)?;
    Ok(json!({ "id": id, "tree": row.tree, "generation": row.generation }))
}

/// A changeset's landed commit: tree, generation, parents and whether this store holds it
/// (`recorded`). One landed from its commit shard's record and never adopted is described
/// by its changeset row; the projector adopts it before naming it in main's history.
fn landed<S: SqlStore>(db: &S, row: &Value) -> Result<Value> {
    let id = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
    if let Some(commit) = rows::commit_row(db, &id)? {
        return Ok(json!({
            "id": id, "tree": commit.tree, "generation": commit.generation,
            "parents": commit.parents, "recorded": true,
        }));
    }
    let parents: Vec<String> = serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
        .map_err(|_| rows::corrupt("changeset parents"))?;
    match (row["tree"].as_str(), row["generation"].as_u64()) {
        (Some(tree), Some(generation)) => Ok(json!({
            "id": id, "tree": tree, "generation": generation, "parents": parents,
            "recorded": false,
        })),
        _ => Err(rows::corrupt("changeset commit")),
    }
}

/// What a change's mode lookup reads of its landed commit.
fn source(landed: &Value) -> Value {
    json!({ "id": landed["id"], "tree": landed["tree"], "generation": landed["generation"] })
}

/// The paths each changeset version wrote, from the log.
pub(super) fn written<S: SqlStore>(
    db: &S,
    refname: &str,
    first: u64,
    last: u64,
) -> Result<BTreeMap<u64, TxEntry>> {
    Ok(rows::entries(db, first - 1, last, Some(refname))?
        .into_iter()
        .filter(|e| e.kind == TxKind::Changeset)
        .map(|e| (e.version, e))
        .collect())
}

/// `repo_changeset_plan`: the next steps for `ref` (default: the branch with the oldest
/// unprojected changeset), with the projected head they apply to.
pub fn plan<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = match c.get("ref").filter(|r| !r.is_null()) {
        Some(_) => branch_ref(c)?,
        None => match db
            .query(
                "SELECT refname FROM changesets WHERE projected IS NULL ORDER BY version LIMIT 1",
                &[],
            )?
            .first()
            .and_then(|r| r["refname"].as_str().map(str::to_owned))
        {
            Some(refname) => refname,
            None => return Ok(json!({ "items": [] })),
        },
    };
    let rows = db.query(
        "SELECT version,commit_id,landed_at,batch,tree,generation,parents FROM changesets \
         WHERE refname=? AND projected IS NULL ORDER BY version LIMIT ?",
        &[json!(refname), json!(PLAN_ROWS)],
    )?;
    let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
        return Ok(json!({ "ref": refname, "items": [] }));
    };
    let entries = written(
        db,
        &refname,
        first["version"].as_u64().unwrap_or(1),
        last["version"].as_u64().unwrap_or(1),
    )?;
    let mut groups: Vec<Vec<&Value>> = Vec::new();
    for row in &rows {
        match groups.last_mut() {
            Some(group)
                if !row["batch"].is_null()
                    && group[0]["batch"] == row["batch"]
                    && group.len() < MERGED_PARENTS =>
            {
                group.push(row)
            }
            _ => groups.push(vec![row]),
        }
    }
    // A batch cut off by the row limit waits for the next plan (unless it is all there is).
    if rows.len() as u64 == PLAN_ROWS && groups.len() > 1 && !last["batch"].is_null() {
        groups.pop();
    }
    // As many steps as one record takes.
    groups.truncate(PLAN_STEPS);
    let mut steps = Vec::new();
    for group in groups {
        let versions: Vec<u64> = group.iter().filter_map(|r| r["version"].as_u64()).collect();
        let mut changes = Vec::new();
        let mut commits = Vec::new();
        for row in &group {
            let landed = landed(db, row)?;
            let version = row["version"].as_u64().unwrap_or_default();
            let entry = entries
                .get(&version)
                .ok_or_else(|| rows::corrupt("changeset entry"))?;
            for touch in &entry.paths {
                changes.push(json!({ "path": touch.path, "blob": touch.new_blob,
                    "mode": touch.mode, "source": source(&landed) }));
            }
            commits.push(landed);
        }
        let (first, last) = (versions[0], versions[versions.len() - 1]);
        let ids: Vec<&str> = commits.iter().filter_map(|c| c["id"].as_str()).collect();
        // The message of a projected merge (a fast-forward keeps the landed commit's own).
        let message = if group[0]["batch"].is_null() {
            format!("Merge {} at version {first}", ids[0])
        } else {
            format!(
                "Merge {} changesets at versions {first}..{last}\n\n{}",
                ids.len(),
                ids.join("\n")
            )
        };
        steps.push(json!({
            "versions": versions, "at": group[group.len() - 1]["landed_at"], "message": message,
            "landed": commits, "changes": changes,
        }));
    }
    let head =
        rows::projected_ref(db, &refname)?.ok_or_else(|| rows::corrupt("changeset branch head"))?;
    Ok(json!({ "ref": refname, "head": brief(db, &head)?, "items": steps }))
}

/// Projected commits of changeset versions in `(after, until]`, for replaying the log.
pub fn projected_between<S: SqlStore>(
    db: &S,
    after: u64,
    until: u64,
) -> Result<BTreeMap<u64, ObjectId>> {
    db.query(
        "SELECT version,projected FROM changesets WHERE version>? AND version<=? AND projected IS NOT NULL",
        &[json!(after), json!(until)],
    )?
    .into_iter()
    .map(|r| {
        Ok((
            r["version"].as_u64().ok_or_else(|| rows::corrupt("changeset"))?,
            ObjectId::parse(r["projected"].as_str().unwrap_or_default())?,
        ))
    })
    .collect()
}
