//! The Git view of changeset landings. The projector builds one Git commit per step (a
//! landed batch, or a changeset landed on its own) by stateless compute from the previous
//! head and the steps' changes (`projection_plan`), so the same versions always yield the
//! same ids, and every version of a step maps to its commit. Recording checks the chain
//! (contiguous versions, parents, paths), stages the new objects in one write (the object
//! projector moves them to R2) and is idempotent, so projectors may race or crash and
//! retry.
use super::merging::MERGE_PRINCIPAL;
use super::projection_plan::written;
use super::rows::{self, Settings, branch_ref, object_id};
use crate::storage::{SqlStore, bad, number};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, ObjectKind, hash_object},
};

fn ids(value: &Value) -> Result<Vec<ObjectId>> {
    value
        .as_array()
        .ok_or_else(|| bad("Expected a list of ids"))?
        .iter()
        .map(|id| ObjectId::parse(id.as_str().unwrap_or_default()))
        .collect()
}

fn versions(step: &Value) -> Result<Vec<u64>> {
    step["versions"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| bad("A projected step names its versions"))?
        .iter()
        .map(|v| v.as_u64().ok_or_else(|| bad("Versions are numbers")))
        .collect()
}

/// `repo_changeset_record`: records projected steps for the oldest unprojected versions of
/// `ref`, built on `from` (its projected head), and moves the Git ref to the last one.
pub fn record<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let refname = branch_ref(c)?;
    let now = number(c, "now")?;
    let from = object_id(c, "from")?;
    let steps = c["items"]
        .as_array()
        .filter(|i| !i.is_empty() && i.len() <= super::projection_plan::PLAN_STEPS)
        .ok_or_else(|| bad("Record 1 to 64 projected steps"))?;
    let mut prior = Vec::new();
    for step in steps {
        for version in versions(step)? {
            let row = db
                .query(
                    "SELECT projected FROM changesets WHERE version=? AND refname=?",
                    &[json!(version), json!(refname)],
                )?
                .into_iter()
                .next()
                .ok_or_else(|| bad("Not a changeset version of this branch"))?;
            prior.push((step["commit"].clone(), row["projected"].clone()));
        }
    }
    // A retried or racing projector: the same versions are already projected.
    if prior.iter().all(|(_, p)| !p.is_null()) {
        if prior.iter().any(|(mine, theirs)| mine != theirs) {
            return Err(Error::new(
                "PROJECTION_MISMATCH",
                "A projection of these versions with different commits is already recorded",
            ));
        }
        return Ok(json!({ "ref": refname, "already": true }));
    }
    if rows::projected_ref(db, &refname)? != Some(from) || prior.iter().any(|(_, p)| !p.is_null()) {
        return Err(Error::new(
            "STALE_HEAD",
            format!("{refname} was projected past {from}; plan again"),
        ));
    }
    let expected = db.query(
        "SELECT version,commit_id,batch FROM changesets WHERE refname=? AND projected IS NULL ORDER BY version LIMIT ?",
        &[json!(refname), json!(prior.len())],
    )?;
    let mut rows_left = expected.iter();
    let (mut head, mut version, mut dispatch) = (from, 0, false);
    let mut check_runs = Vec::new();
    for step in steps {
        let group: Vec<&Value> = versions(step)?
            .iter()
            .map(|v| {
                rows_left
                    .next()
                    .filter(|r| r["version"].as_u64() == Some(*v))
                    .ok_or_else(|| {
                        bad("Projected versions must be the oldest unprojected, in order")
                    })
            })
            .collect::<Result<_>>()?;
        let (id, asked) = record_step(db, &refname, step, &group, head, now)?;
        // Main's new head gets the platform checks (post-land, on the combined result).
        check_runs.extend(super::checks::request(
            db,
            &id,
            None,
            MERGE_PRINCIPAL,
            settings,
            now,
        )?);
        version = group[group.len() - 1]["version"]
            .as_u64()
            .unwrap_or_default();
        head = id;
        dispatch |= asked;
    }
    db.query(
        "UPDATE refs SET commit_id=?,version=? WHERE name=?",
        &[json!(head.hex()), json!(version), json!(refname)],
    )?;
    super::projection::target(db, &refname, &head, version, now)?;
    Ok(json!({
        "ref": refname, "projected": steps.len(), "head": head, "version": version,
        "dispatch_objects": dispatch, "check_runs": check_runs,
    }))
}

/// Records one step's commit: a batch's commit has the previous head as its only parent,
/// a lone changeset's also the landed commit; it changes exactly the step's paths.
fn record_step<S: SqlStore>(
    db: &S,
    refname: &str,
    step: &Value,
    group: &[&Value],
    previous: ObjectId,
    now: i64,
) -> Result<(ObjectId, bool)> {
    let id = object_id(step, "commit")?;
    let batch = &group[0]["batch"];
    let parents = if batch.is_null() {
        if group.len() != 1 {
            return Err(bad("Changesets landed on their own project one by one"));
        }
        vec![previous, object_id(group[0], "commit_id")?]
    } else {
        if group.iter().any(|r| r["batch"] != *batch) {
            return Err(bad("A projected step is exactly one landed batch"));
        }
        vec![previous]
    };
    if ids(&step["parents"])? != parents {
        return Err(bad("A projected commit must build on the previous head"));
    }
    let first = group[0]["version"].as_u64().unwrap_or_default();
    let last = group[group.len() - 1]["version"]
        .as_u64()
        .unwrap_or_default();
    let landed: BTreeSet<String> = written(db, refname, first, last)?
        .into_values()
        .flat_map(|e| e.paths.into_iter().map(|t| t.path))
        .collect();
    let touches = step["touches"]
        .as_array()
        .ok_or_else(|| bad("Missing touches"))?;
    let paths: BTreeSet<String> = touches
        .iter()
        .filter_map(|t| t["path"].as_str().map(str::to_owned))
        .collect();
    if paths != landed {
        return Err(bad(
            "A projected commit must change exactly the landed paths",
        ));
    }
    db.query(
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,hidden_ref,artifacts_at) \
         VALUES(?,?,?,?,?,?,?,'[]',?,0,NULL) ON CONFLICT(id) DO NOTHING",
        &[
            json!(id.hex()),
            json!(object_id(step, "tree")?.hex()),
            json!(step["parents"].to_string()),
            json!(step["generation"].as_u64().ok_or_else(|| bad("Missing generation"))?),
            json!(first - 1),
            json!(MERGE_PRINCIPAL),
            json!(step["message"].as_str().ok_or_else(|| bad("Missing message"))?),
            json!(now),
        ],
    )?;
    for touch in touches {
        db.query(
            "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob,mode) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            &[json!(id.hex()), touch["path"].clone(), touch["op"].clone(), touch["old_blob"].clone(), touch["new_blob"].clone(), touch["mode"].clone()],
        )?;
    }
    let dispatch = stage(db, &id, &step["raw"], now)?;
    db.query(
        "UPDATE changesets SET projected=?,projected_at=? WHERE refname=? AND version>=? AND version<=?",
        &[json!(id.hex()), json!(now), json!(refname), json!(first), json!(last)],
    )?;
    Ok((id, dispatch))
}

/// Stages a projected commit's new objects in one write, verified against their ids (read
/// by id until the object projector has written them to R2; they reach Artifacts with the
/// branch). Returns whether a drain must be requested.
fn stage<S: SqlStore>(db: &S, id: &ObjectId, raw: &Value, now: i64) -> Result<bool> {
    let mut objects = Vec::new();
    for object in raw.as_array().into_iter().flatten() {
        let kind = match object["kind"].as_str() {
            Some("commit") => ObjectKind::Commit,
            Some("tree") => ObjectKind::Tree,
            Some("blob") => ObjectKind::Blob,
            _ => return Err(bad("Object kinds are commit, tree or blob")),
        };
        let data = STANDARD
            .decode(object["data_b64"].as_str().unwrap_or_default())
            .map_err(|_| bad("Object data is not base64"))?;
        let object_id = object_id(object, "id")?;
        if hash_object(kind, &data) != object_id {
            return Err(bad("An object does not hash to its id"));
        }
        objects.push((object_id, kind, data));
    }
    let refs: Vec<(ObjectId, ObjectKind, &[u8])> = objects
        .iter()
        .map(|(i, k, d)| (*i, *k, d.as_slice()))
        .collect();
    if !refs
        .iter()
        .any(|(i, k, _)| i == id && *k == ObjectKind::Commit)
        || !super::staging::stage(db, id, &refs)?
    {
        return Err(bad(
            "A projected commit must bring its objects and fit staging",
        ));
    }
    super::staging::accept(db, id, now)
}
