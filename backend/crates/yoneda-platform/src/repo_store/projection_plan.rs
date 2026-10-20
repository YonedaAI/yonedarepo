//! What the projector builds next: the oldest unprojected changesets of a branch, as
//! steps of one Git commit each. A batch landing's changesets form one step (linear: its
//! commit's only parent is the previous head); a changeset landed on its own forms a step
//! whose commit also names the landed commit as its second parent.
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

fn brief<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Value> {
    let row = rows::recorded(db, id)?;
    Ok(json!({ "id": id, "tree": row.tree, "generation": row.generation }))
}

/// A changeset's landed commit (its tree from the changeset row when it was never adopted).
fn landed<S: SqlStore>(db: &S, row: &Value) -> Result<Value> {
    let id = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
    match row["tree"].as_str() {
        Some(tree) => Ok(json!({ "id": id, "tree": tree, "generation": row["generation"] })),
        None => brief(db, &id),
    }
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
        "SELECT version,commit_id,landed_at,batch,tree,generation FROM changesets \
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
            Some(group) if !row["batch"].is_null() && group[0]["batch"] == row["batch"] => {
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
        let mut ids = Vec::new();
        for row in &group {
            let source = landed(db, row)?;
            let version = row["version"].as_u64().unwrap_or_default();
            let entry = entries
                .get(&version)
                .ok_or_else(|| rows::corrupt("changeset entry"))?;
            for touch in &entry.paths {
                changes
                    .push(json!({ "path": touch.path, "blob": touch.new_blob, "mode": touch.mode, "source": source }));
            }
            ids.push(source["id"].as_str().unwrap_or_default().to_owned());
        }
        let (first, last) = (versions[0], versions[versions.len() - 1]);
        let batched = !group[0]["batch"].is_null();
        let message = if batched {
            format!(
                "Land {} changesets at versions {first}..{last}\n\n{}",
                ids.len(),
                ids.join("\n")
            )
        } else {
            format!("Land {} at version {first}", ids[0])
        };
        steps.push(json!({
            "versions": versions, "at": group[group.len() - 1]["landed_at"], "message": message,
            "merge": if batched { Value::Null } else { landed(db, group[0])? },
            "changes": changes,
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
