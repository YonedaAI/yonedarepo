//! Snapshot-consistent reads. `at` pins a log version; refs at a past version are rebuilt
//! by replaying the hash-chained log, so time travel also verifies history integrity.
use super::{
    auth::Actor,
    land::gates,
    rows::{self, Settings, branch_ref, current_version, object_id},
};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, merge_bases},
    txlog::replay_projected,
};

pub(super) fn at<S: SqlStore>(db: &S, c: &Value) -> Result<u64> {
    let current = current_version(db)?;
    match c.get("at").filter(|v| !v.is_null()) {
        None => Ok(current),
        Some(v) => v.as_u64().filter(|v| *v <= current).ok_or_else(|| {
            Error::new(
                "INVALID_INPUT",
                format!("at must be a version from 0 to {current}"),
            )
        }),
    }
}

/// Refs as of `version`. Current reads use the refs table (O(refs)); time travel replays the hash-chained log from the nearest checkpoint, so time travel also
/// verifies the history it crosses without re-reading the whole log.
pub(super) fn refs_at<S: SqlStore>(
    db: &S,
    c: &Value,
    version: u64,
) -> Result<BTreeMap<String, ObjectId>> {
    // Reads without `at` take the fast path; an explicit `at` always verifies.
    if c.get("at").is_none_or(Value::is_null) {
        if super::changesets::any_unprojected(db)? {
            return Err(Error::new(
                "PROJECTION_PENDING",
                "Landed changesets are not projected to Git yet",
            ));
        }
        return db
            .query("SELECT name,commit_id FROM refs", &[])?
            .into_iter()
            .map(|r| {
                Ok((
                    r["name"].as_str().unwrap_or_default().to_owned(),
                    ObjectId::parse(r["commit_id"].as_str().unwrap_or_default())?,
                ))
            })
            .collect();
    }
    // Below the compaction floor the state comes from the archived segment holding it.
    if version > 0 && version < super::maintenance::archive::floor(db)? {
        return Ok(super::maintenance::archive::state_at(db, version)?.refs);
    }
    let from = rows::checkpoint_at_or_before(db, version)?;
    let tail = rows::entries(db, from.version, version, None)?;
    let projected = super::projection_plan::projected_between(db, from.version, version)?;
    Ok(replay_projected(&from, &tail, &projected)?.refs)
}

/// The repository's status, with who is asking (`viewer`).
pub fn status<S: SqlStore>(db: &S, settings: &Settings, actor: &Actor) -> Result<Value> {
    let refs = db.query(
        "SELECT name,commit_id AS commit_id,version FROM refs ORDER BY name",
        &[],
    )?;
    Ok(json!({
        "version": current_version(db)?,
        "name": settings.name,
        "owner": settings.owner,
        "object_store": settings.object_store,
        "policy": settings.policy,
        "policy_digest": settings.policy_digest,
        "refs": refs,
        "projections": super::projection::list(db)?,
        "objects": super::staging::status(db)?,
        "bundled": super::pushed::bundles::any(db)?,
        "automation": super::break_glass::state(db)?,
        "viewer": { "principal": actor.principal, "owner": actor.owner,
            "role": actor.member.map(super::members::Role::as_str) },
    }))
}

pub fn refs<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let version = at(db, c)?;
    let refs = refs_at(db, c, version)?;
    // Annotated tags: the tag object each such ref names to Git (the ref holds the commit).
    let annotated = super::annotated::listed(db, &refs)?;
    Ok(json!({ "version": version, "refs": refs, "annotated": annotated }))
}

pub fn snapshot<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let version = at(db, c)?;
    let refname = branch_ref(c)?;
    let commit = refs_at(db, c, version)?.remove(&refname).ok_or_else(|| {
        Error::new(
            "NOT_FOUND",
            format!("{refname} does not exist at version {version}"),
        )
    })?;
    let row = rows::recorded(db, &commit)?;
    Ok(
        json!({ "version": version, "ref": refname, "commit": commit, "tree": row.tree, "parents": row.parents }),
    )
}

/// First-parent history from a branch head, newest first.
pub fn log<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let version = at(db, c)?;
    let refname = branch_ref(c)?;
    let limit = c["limit"].as_u64().unwrap_or(50).clamp(1, 200);
    let mut next = refs_at(db, c, version)?.remove(&refname);
    let mut commits = Vec::new();
    while let Some(id) = next {
        if commits.len() as u64 >= limit {
            break;
        }
        let row = rows::recorded(db, &id)?;
        let landed = db.query(
            "SELECT version,landed_at FROM landings WHERE commit_id=? AND refname=? AND version<=?",
            &[json!(id.hex()), json!(refname), json!(version)],
        )?;
        let broke_glass = db.query(
            "SELECT action FROM break_glass WHERE commit_id=? AND refname=? AND version<=?",
            &[json!(id.hex()), json!(refname), json!(version)],
        )?;
        commits.push(json!({
            "commit": id, "tree": row.tree, "parents": row.parents, "message": row.message,
            "principal": row.principal, "landed": landed.first(),
            "break_glass": broke_glass.first().map(|r| r["action"].clone()),
        }));
        next = match row.parents.first() {
            Some(parent) if rows::commit_row(db, parent)?.is_some() => Some(*parent),
            _ => None,
        };
    }
    Ok(json!({ "version": version, "ref": refname, "commits": commits }))
}

pub fn txlog<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let after = c["after"].as_u64().unwrap_or(0);
    let limit = c["limit"].as_u64().unwrap_or(100).clamp(1, 500);
    let until = current_version(db)?.min(after.saturating_add(limit));
    // Changeset entries carry their projection: the Git commit and when it was built.
    let projections = db.query(
        "SELECT version,projected,projected_at FROM changesets WHERE version>? AND version<=?",
        &[json!(after), json!(until)],
    )?;
    // Archived versions are listed a segment at a time, from the segment's own objects.
    let listed = if after < super::maintenance::archive::floor(db)? {
        super::maintenance::archive::page(db, after, limit)?
    } else {
        rows::entries(db, after, until, None)?
    };
    let entries = listed
        .into_iter()
        .map(|entry| {
            let mut value = json!(entry);
            if let Some(p) = projections.iter().find(|p| p["version"] == entry.version) {
                value["projected"] = json!({ "commit": p["projected"], "at": p["projected_at"] });
            }
            value
        })
        .collect::<Vec<_>>();
    Ok(json!({ "entries": entries, "version": current_version(db)? }))
}

pub fn commit<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let id = object_id(c, "commit")?;
    let row = rows::recorded(db, &id)?;
    // What a read needs to walk the commit, without its reviews, checks and gates.
    if c["brief"] == true {
        return Ok(json!({ "commit": id, "tree": row.tree, "parents": row.parents }));
    }
    let key = [json!(id.hex())];
    Ok(json!({
        "commit": id, "tree": row.tree, "parents": row.parents, "generation": row.generation,
        "base_version": row.base_version, "principal": row.principal, "message": row.message,
        "read_set": row.read_set, "paths": rows::touches(db, &id)?,
        "checks": db.query("SELECT name,status,evidence,principal,recorded_at FROM checks WHERE commit_id=? ORDER BY name", &key)?,
        "reviews": db.query("SELECT principal,decision,reason,recorded_at FROM reviews WHERE commit_id=? ORDER BY recorded_at", &key)?,
        "landings": db.query("SELECT refname,version,landed_at FROM landings WHERE commit_id=? ORDER BY version", &key)?,
        "check_runs": super::checks::runs_for(db, &id)?,
        "repairs": super::checks::repairs_for(db, &id)?,
        "review_classes": super::classes::for_commit(db, &id)?,
        "symbol_touches": super::symbols::as_json(&super::symbols::for_commit(db, &id)?),
        "break_glass": super::break_glass::for_commit(db, &id)?,
        "gates": gates(db, &id, settings)?,
    }))
}

/// Best common ancestors of two recorded commits, with their trees.
pub fn merge_base<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let bases = merge_bases(
        &rows::RecordedGraph(db),
        &object_id(c, "left")?,
        &object_id(c, "right")?,
    )?;
    let listed = bases
        .iter()
        .map(|id| Ok(json!({ "commit": id, "tree": rows::recorded(db, id)?.tree })))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({ "merge_bases": listed }))
}
