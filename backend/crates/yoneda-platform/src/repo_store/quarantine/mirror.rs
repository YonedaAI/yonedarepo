//! Retiring the repository's Artifacts mirror after a purge. Artifacts deletes only whole
//! repositories, so a purged blob's bytes leave the mirror only with the mirror itself: the
//! first blob purge of a mirrored repository requests its retirement, in the purge's own
//! transaction. The platform's quarantine job then works through it under a lease fenced
//! by `epoch` (like the purge): it copies everything the mirror holds that the store of
//! record lacks (withheld blobs excepted) and reports the commits whose whole history is
//! copied (`copied`); `switch` puts the replacement store in the mirror's place and stops
//! projecting to it, in one transaction; once the adapter has deleted the Artifacts
//! repository, `retired` closes it and the records whose purge started it show it.
//!
//! From the request on, nothing new reaches the mirror alone: a commit too large to stage
//! pushes to the replacement (`push_store`), and commits prepared earlier for a push to the
//! mirror are dropped (recording one answers NOT_FOUND; the client prepares it again).
//! Projections only carry objects the store of record already holds.
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// How long a claim holds the retirement: a copy wave streams a pack of up to 64 MiB.
pub const LEASE_MS: i64 = 15 * 60 * 1000;
/// Commits one `copied` report records.
const MAX_COPIED: usize = 1000;
const MAX_DETAIL: usize = 500;
const COLUMNS: &str = "mirror,replacement,state,epoch,lease_until,detail,requested_at,\
                       switched_at,retired_at";

/// The store a repository writes and purges: a fork's own, never its parent's.
fn own(spec: &str) -> Result<String> {
    let Some(fork) = spec.strip_prefix("fork:") else {
        return Ok(spec.to_owned());
    };
    let parsed: Value = serde_json::from_str(fork).map_err(|_| bad("Malformed fork store"))?;
    parsed["own"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| bad("Malformed fork store"))
}

/// `spec` with its own store replaced by `store` (a fork keeps its parent).
fn replaced(spec: &str, store: &str) -> Result<String> {
    let Some(fork) = spec.strip_prefix("fork:") else {
        return Ok(store.to_owned());
    };
    let mut parsed: Value = serde_json::from_str(fork).map_err(|_| bad("Malformed fork store"))?;
    parsed["own"] = json!(store);
    Ok(format!("fork:{parsed}"))
}

/// A replacement the adapter names: the platform's own store of record (`platform:<repo>`).
fn replacement(c: &Value) -> Result<String> {
    let spec = string(c, "replacement")?;
    let name = spec.strip_prefix("platform:").unwrap_or_default();
    let valid = !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !valid {
        return Err(bad("replacement must be platform:<repository>"));
    }
    Ok(spec)
}

fn current<S: SqlStore>(db: &S) -> Result<Option<Value>> {
    Ok(db
        .query(&format!("SELECT {COLUMNS} FROM mirror_retirement"), &[])?
        .into_iter()
        .next())
}

/// Called when blob record `record` is purged: requests the retirement of the repository's
/// own Artifacts mirror (`c.replacement` names the store replacing it), or joins the one
/// under way; the record shows it (`mirror`). Answers whether a retirement waits.
pub(super) fn request<S: SqlStore>(db: &S, c: &Value, record: i64, now: i64) -> Result<bool> {
    let mark = || {
        db.query(
            "UPDATE quarantine SET mirror='retiring' WHERE id=?",
            &[json!(record)],
        )
        .map(|_| true)
    };
    if let Some(row) = current(db)? {
        return if row["state"] == "retired" {
            Ok(false)
        } else {
            mark()
        };
    }
    let spec = db
        .query("SELECT object_store FROM repo_settings", &[])?
        .first()
        .and_then(|r| r["object_store"].as_str().map(str::to_owned))
        .ok_or_else(|| super::super::rows::corrupt("repo_settings"))?;
    let mirror = own(&spec)?;
    if !mirror.starts_with("artifacts:") {
        return Ok(false);
    }
    db.query(
        "INSERT INTO mirror_retirement(id,mirror,replacement,state,requested_at) \
         VALUES(1,?,?,'copying',?)",
        &[json!(mirror), json!(replacement(c)?), json!(now)],
    )?;
    // A commit prepared for a push to the mirror would hold objects only the mirror has.
    db.query(
        "DELETE FROM prepared_commits WHERE commit_id NOT IN (SELECT commit_id FROM staged_objects)",
        &[],
    )?;
    mark()
}

/// Whether the repository no longer projects to a mirror (its retirement switched).
pub(in crate::repo_store) fn switched<S: SqlStore>(db: &S) -> Result<bool> {
    Ok(!db
        .query(
            "SELECT 1 AS x FROM mirror_retirement WHERE state<>'copying'",
            &[],
        )?
        .is_empty())
}

/// Where a commit too large to stage is pushed while the mirror is being retired (the
/// replacement), or none.
pub(in crate::repo_store) fn push_store<S: SqlStore>(db: &S) -> Result<Option<String>> {
    Ok(db
        .query(
            "SELECT replacement FROM mirror_retirement WHERE state='copying'",
            &[],
        )?
        .first()
        .and_then(|r| r["replacement"].as_str().map(str::to_owned)))
}

/// The retirement as the quarantine listing shows it (null: none was ever needed).
pub(super) fn status<S: SqlStore>(db: &S) -> Result<Value> {
    Ok(current(db)?.map_or(Value::Null, |r| {
        json!({ "state": r["state"], "detail": r["detail"], "requested_at": r["requested_at"],
                "switched_at": r["switched_at"], "retired_at": r["retired_at"] })
    }))
}

/// `repo_mirror_claim`: leases the retirement under way. Answers `{retirement: null}` when
/// none waits, `{busy, lease_until}` while another run holds it, else the step reached
/// (`state`), the mirror and its replacement, the `epoch` every report carries, and the
/// commits already copied (oldest first).
pub(super) fn claim<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let Some(row) = current(db)?.filter(|r| r["state"] != "retired") else {
        return Ok(json!({ "retirement": null }));
    };
    if row["lease_until"].as_i64().is_some_and(|until| until > now) {
        return Ok(json!({ "busy": true, "lease_until": row["lease_until"] }));
    }
    let lease_until = now + LEASE_MS;
    let rows = db.query(
        &format!("UPDATE mirror_retirement SET epoch=epoch+1,lease_until=? RETURNING {COLUMNS}"),
        &[json!(lease_until)],
    )?;
    let row = rows.first().unwrap_or(&row);
    let copied: Vec<Value> = db
        .query("SELECT commit_id FROM mirror_copied ORDER BY seq", &[])?
        .into_iter()
        .map(|r| r["commit_id"].clone())
        .collect();
    Ok(json!({
        "retirement": { "mirror": row["mirror"], "replacement": row["replacement"],
                        "state": row["state"], "detail": row["detail"] },
        "epoch": row["epoch"], "lease_until": lease_until, "copied": copied,
    }))
}

/// The retirement, if `c.epoch` still holds it: a run whose lease ran out and was claimed
/// again reports nothing.
fn fenced<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let epoch = c["epoch"]
        .as_i64()
        .ok_or_else(|| bad("epoch is required"))?;
    current(db)?
        .filter(|r| r["epoch"].as_i64() == Some(epoch))
        .ok_or_else(|| {
            Error::new(
                "CONFLICT",
                "The mirror retirement was claimed again; this run stops",
            )
        })
}

/// `repo_mirror_copied {epoch, commits}`: these commits' whole history is in the store of
/// record (a copy may `have` them).
pub(super) fn copied<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    fenced(db, c)?;
    let commits = c["commits"]
        .as_array()
        .filter(|list| list.len() <= MAX_COPIED)
        .ok_or_else(|| bad(&format!("commits must be a list of at most {MAX_COPIED}")))?;
    for commit in commits {
        let id = yoneda_core::git_object::ObjectId::parse(commit.as_str().unwrap_or_default())?;
        db.query(
            "INSERT INTO mirror_copied(commit_id) VALUES(?) ON CONFLICT DO NOTHING",
            &[json!(id.hex())],
        )?;
    }
    Ok(json!({ "copied": commits.len() }))
}

/// `repo_mirror_switch {epoch}`: the store of record holds everything the mirror did; the
/// replacement takes the mirror's place and nothing projects to the mirror again (pending
/// projections are dropped; a projection reporting late is ignored). Repeatable.
pub(super) fn switch<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let row = fenced(db, c)?;
    if row["state"] == "copying" {
        let spec = db
            .query("SELECT object_store FROM repo_settings", &[])?
            .first()
            .and_then(|r| r["object_store"].as_str().map(str::to_owned))
            .ok_or_else(|| super::super::rows::corrupt("repo_settings"))?;
        let store = replaced(&spec, row["replacement"].as_str().unwrap_or_default())?;
        db.query("UPDATE repo_settings SET object_store=?", &[json!(store)])?;
        db.query("DELETE FROM ref_projections", &[])?;
        db.query(
            "UPDATE mirror_retirement SET state='switched',switched_at=?,detail=NULL",
            &[json!(now)],
        )?;
    }
    let spec = db.query("SELECT object_store FROM repo_settings", &[])?;
    Ok(
        json!({ "state": "switched", "object_store": spec.first().map(|r| r["object_store"].clone()) }),
    )
}

/// `repo_mirror_retired {epoch}`: the Artifacts repository is deleted. Every record whose
/// purge started the retirement shows it retired. Repeatable.
pub(super) fn retired<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let row = fenced(db, c)?;
    if row["state"] == "copying" {
        return Err(Error::new(
            "CONFLICT",
            "The mirror is deleted only after the switch",
        ));
    }
    db.query(
        "UPDATE mirror_retirement SET state='retired',retired_at=COALESCE(retired_at,?),\
         lease_until=NULL,detail=NULL",
        &[json!(now)],
    )?;
    db.query(
        "UPDATE quarantine SET mirror='retired' WHERE mirror='retiring'",
        &[],
    )?;
    Ok(json!({ "state": "retired" }))
}

/// `repo_mirror_failed {epoch, detail}`: why this run stopped (shown with the retirement);
/// the lease is released for the next run.
pub(super) fn failed<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    fenced(db, c)?;
    let detail: String = c["detail"]
        .as_str()
        .unwrap_or("The retirement stopped")
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_DETAIL)
        .collect();
    db.query(
        "UPDATE mirror_retirement SET detail=?,lease_until=NULL",
        &[json!(detail)],
    )?;
    Ok(json!({ "detail": detail }))
}
