//! The Git view of changeset landings. Each changeset version gets one Git commit for its
//! branch, built by stateless compute from the previous version's commit and the landed
//! commit's changes (parents: previous head, landed commit), so the same versions always
//! yield the same ids. The adapter stores the new objects in R2 first, then records them
//! here: recording checks the chain (contiguous versions, parents, paths) and is
//! idempotent, so any number of projectors may race or crash and retry.
use super::merging::MERGE_PRINCIPAL;
use super::rows::{self, branch_ref, object_id};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{Error, Result, git_object::ObjectId};

const PLAN_ITEMS: u64 = 64;

fn brief<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Value> {
    let row = rows::recorded(db, id)?;
    Ok(json!({ "id": id, "tree": row.tree, "generation": row.generation }))
}

/// `repo_changeset_plan`: the oldest unprojected changesets of `ref` (default: the branch
/// with the oldest one), with the projected head they apply to.
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
    let limit = c["limit"]
        .as_u64()
        .unwrap_or(PLAN_ITEMS)
        .clamp(1, PLAN_ITEMS);
    let rows = db.query(
        "SELECT version,commit_id,landed_at FROM changesets WHERE refname=? AND projected IS NULL ORDER BY version LIMIT ?",
        &[json!(refname), json!(limit)],
    )?;
    if rows.is_empty() {
        return Ok(json!({ "ref": refname, "items": [] }));
    }
    let head =
        rows::projected_ref(db, &refname)?.ok_or_else(|| rows::corrupt("changeset branch head"))?;
    let mut items = Vec::new();
    for row in rows {
        let commit = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
        let paths: Vec<Value> = rows::touches(db, &commit)?
            .into_iter()
            .map(|t| json!({ "path": t.path, "blob": t.new_blob }))
            .collect();
        items.push(json!({
            "version": row["version"], "at": row["landed_at"],
            "commit": brief(db, &commit)?, "paths": paths,
        }));
    }
    Ok(json!({ "ref": refname, "head": brief(db, &head)?, "items": items }))
}

fn ids(value: &Value) -> Result<Vec<ObjectId>> {
    value
        .as_array()
        .ok_or_else(|| bad("Expected a list of commit ids"))?
        .iter()
        .map(|id| ObjectId::parse(id.as_str().unwrap_or_default()))
        .collect()
}

/// `repo_changeset_record`: records projected commits for the oldest unprojected versions
/// of `ref`, built on `from` (its projected head), and moves the Git ref to the last one.
pub fn record<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let now = number(c, "now")?;
    let from = object_id(c, "from")?;
    let items = c["items"]
        .as_array()
        .filter(|i| !i.is_empty() && i.len() as u64 <= PLAN_ITEMS)
        .ok_or_else(|| bad("Record 1 to 64 projected versions"))?;
    let mut prior = Vec::new();
    for item in items {
        let row = db
            .query(
                "SELECT projected FROM changesets WHERE version=? AND refname=?",
                &[item["version"].clone(), json!(refname)],
            )?
            .into_iter()
            .next()
            .ok_or_else(|| bad("Not a changeset version of this branch"))?;
        prior.push(row["projected"].as_str().map(str::to_owned));
    }
    // A retried or racing projector: the same versions are already projected.
    if prior.iter().all(Option::is_some) {
        let same = items
            .iter()
            .zip(&prior)
            .all(|(item, p)| item["commit"].as_str() == p.as_deref());
        if !same {
            return Err(Error::new(
                "PROJECTION_MISMATCH",
                "A projection of these versions with different commits is already recorded",
            ));
        }
        return Ok(json!({ "ref": refname, "already": true }));
    }
    if rows::projected_ref(db, &refname)? != Some(from) || prior.iter().any(Option::is_some) {
        return Err(Error::new(
            "STALE_HEAD",
            format!("{refname} was projected past {from}; plan again"),
        ));
    }
    let expected = db.query(
        "SELECT version,commit_id FROM changesets WHERE refname=? AND projected IS NULL ORDER BY version LIMIT ?",
        &[json!(refname), json!(items.len())],
    )?;
    let mut head = from;
    let mut version = 0;
    for (item, row) in items.iter().zip(&expected) {
        version = row["version"]
            .as_u64()
            .ok_or_else(|| rows::corrupt("changeset"))?;
        let landed = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
        if item["version"].as_u64() != Some(version) {
            return Err(bad(
                "Projected versions must be the oldest unprojected, in order",
            ));
        }
        head = record_one(db, item, version, head, &landed, now)?;
    }
    db.query(
        "UPDATE refs SET commit_id=?,version=? WHERE name=?",
        &[json!(head.hex()), json!(version), json!(refname)],
    )?;
    super::projection::target(db, &refname, &head, version, now)?;
    Ok(json!({ "ref": refname, "projected": items.len(), "head": head, "version": version }))
}

/// Records one projected commit: its parents must be the previous head and the landed
/// commit, and it must change exactly the landed commit's paths.
fn record_one<S: SqlStore>(
    db: &S,
    item: &Value,
    version: u64,
    previous: ObjectId,
    landed: &ObjectId,
    now: i64,
) -> Result<ObjectId> {
    let id = object_id(item, "commit")?;
    if ids(&item["parents"])? != [previous, *landed] {
        return Err(bad(&format!(
            "The projection of version {version} must have parents [previous head, landed commit]"
        )));
    }
    let touches = item["touches"]
        .as_array()
        .ok_or_else(|| bad("Missing touches"))?;
    let paths: BTreeSet<&str> = touches.iter().filter_map(|t| t["path"].as_str()).collect();
    let landed_paths: Vec<String> = rows::touches(db, landed)?
        .into_iter()
        .map(|t| t.path)
        .collect();
    if paths != landed_paths.iter().map(String::as_str).collect() {
        return Err(bad(&format!(
            "The projection of version {version} must change exactly the landed paths"
        )));
    }
    let message = item["message"]
        .as_str()
        .ok_or_else(|| bad("Missing message"))?;
    db.query(
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,hidden_ref,artifacts_at) \
         VALUES(?,?,?,?,?,?,?,'[]',?,0,NULL) ON CONFLICT(id) DO NOTHING",
        &[
            json!(id.hex()),
            json!(object_id(item, "tree")?.hex()),
            json!(item["parents"].to_string()),
            json!(item["generation"].as_u64().ok_or_else(|| bad("Missing generation"))?),
            json!(version - 1),
            json!(MERGE_PRINCIPAL),
            json!(message),
            json!(now),
        ],
    )?;
    for touch in touches {
        db.query(
            "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
            &[json!(id.hex()), touch["path"].clone(), touch["op"].clone(), touch["old_blob"].clone(), touch["new_blob"].clone()],
        )?;
    }
    // Its new objects (already in R2) travel to Artifacts with the branch.
    for object in item["objects"].as_array().into_iter().flatten() {
        let kind = object["kind"].as_str().unwrap_or_default();
        if !matches!(kind, "commit" | "tree" | "blob") {
            return Err(bad("Object kinds are commit, tree or blob"));
        }
        db.query(
            "INSERT INTO commit_objects(commit_id,id,kind) VALUES(?,?,?) ON CONFLICT DO NOTHING",
            &[
                json!(id.hex()),
                json!(object_id(object, "id")?.hex()),
                json!(kind),
            ],
        )?;
    }
    db.query(
        "UPDATE changesets SET projected=?,projected_at=? WHERE version=?",
        &[json!(id.hex()), json!(now), json!(version)],
    )?;
    Ok(id)
}

/// Projected commits of changeset versions in `(after, until]`, for replaying the log.
pub fn projected_between<S: SqlStore>(
    db: &S,
    after: u64,
    until: u64,
) -> Result<std::collections::BTreeMap<u64, ObjectId>> {
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
