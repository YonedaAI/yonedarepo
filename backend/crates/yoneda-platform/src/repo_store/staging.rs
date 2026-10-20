//! Staged objects: a small commit is accepted once this authority durably holds every
//! object it built for it, instead of after a receive-pack round trip (Artifacts takes one
//! receive-pack per repository at a time, so synchronous pushes queue behind each other).
//! Each accepted staged commit gets an object-outbox row in the same transaction; the
//! projector pushes it to its hidden ref, reads it back and reports, and only then are the
//! staged copies dropped. Until then reads fall back to them by id, and branch refs are not
//! projected (the object store would refuse a ref to objects it lacks). Failures stay
//! pending with their reason, visible in `repo_status`; nothing is dropped unprojected.
use super::rows::{corrupt, object_id};
use crate::platform_objects::object_json;
use crate::storage::{SqlStore, bad, number};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, ObjectKind, hash_object},
};

/// Commits whose objects total at most this many bytes are staged (SQLite rows in a
/// Durable Object hold at most 2 MB; base64 adds a third). Larger commits are pushed and
/// read back before they are accepted.
pub const STAGE_LIMIT: usize = 1024 * 1024;
const PENDING_BYTES: usize = 8 * 1024 * 1024;
const READ_IDS: usize = 64;
/// A drain request older than this is presumed lost (a dropped queue message) and resent.
const DISPATCH_STALE_MS: i64 = 30_000;

/// Stages a prepared commit's objects if they fit; returns whether it did.
pub fn stage<S: SqlStore>(
    db: &S,
    commit: &ObjectId,
    objects: &[(ObjectId, ObjectKind, &[u8])],
) -> Result<bool> {
    if objects.iter().map(|(_, _, d)| d.len()).sum::<usize>() > STAGE_LIMIT {
        return Ok(false);
    }
    for (id, kind, data) in objects {
        db.query(
            "INSERT INTO staged_objects(commit_id,id,kind,data_b64) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
            &[json!(commit.hex()), json!(id.hex()), json!(kind.name()), json!(STANDARD.encode(data))],
        )?;
    }
    Ok(true)
}

/// Drops staged copies of prepared commits that expired without being accepted.
pub fn expire<S: SqlStore>(db: &S, now: i64) -> Result<()> {
    db.query(
        "DELETE FROM staged_objects WHERE commit_id IN (SELECT commit_id FROM prepared_commits WHERE expires_at<?) \
         AND commit_id NOT IN (SELECT commit_id FROM object_projections)",
        &[json!(now)],
    )?;
    Ok(())
}

/// Accepts a staged commit: its objects must be staged here (this store built them, so
/// they need no readback), and its outbox row commits with the commit row. Returns whether
/// the adapter must ask for a projector job.
pub fn accept<S: SqlStore>(db: &S, commit: &ObjectId, now: i64) -> Result<bool> {
    let staged = db.query(
        "SELECT 1 FROM staged_objects WHERE commit_id=? AND id=? AND kind='commit'",
        &[json!(commit.hex()), json!(commit.hex())],
    )?;
    if staged.is_empty() {
        return Err(Error::new(
            "NOT_FOUND",
            "This commit's objects were not staged; push them instead",
        ));
    }
    db.query(
        "INSERT INTO object_projections(commit_id,recorded_at,updated_at) VALUES(?,?,?)",
        &[json!(commit.hex()), json!(now), json!(now)],
    )?;
    should_dispatch(db, now)
}

/// Whether the caller must ask for a drain: none is outstanding (or the last looks lost).
/// One request covers every commit accepted before the job next finds the outbox empty.
fn should_dispatch<S: SqlStore>(db: &S, now: i64) -> Result<bool> {
    let fresh = db.query(
        "SELECT 1 FROM object_outbox_dispatch WHERE dispatched_at>?",
        &[json!(now - DISPATCH_STALE_MS)],
    )?;
    if !fresh.is_empty() {
        return Ok(false);
    }
    db.query(
        "INSERT INTO object_outbox_dispatch(id,dispatched_at) VALUES(1,?) \
         ON CONFLICT(id) DO UPDATE SET dispatched_at=excluded.dispatched_at",
        &[json!(now)],
    )?;
    Ok(true)
}

/// A commit accepted through the object store needs no staged copies.
pub fn discard<S: SqlStore>(db: &S, commit: &ObjectId) -> Result<()> {
    db.query(
        "DELETE FROM staged_objects WHERE commit_id=?",
        &[json!(commit.hex())],
    )?;
    Ok(())
}

/// The outbox, oldest first, with each commit's raw objects, up to a response budget.
pub fn pending<S: SqlStore>(db: &S) -> Result<Value> {
    let rows = db.query(
        "SELECT commit_id,attempts FROM object_projections ORDER BY recorded_at,commit_id LIMIT 64",
        &[],
    )?;
    let mut commits = Vec::new();
    let mut bytes = 0;
    for row in rows {
        let objects = db.query(
            "SELECT id,kind,data_b64 FROM staged_objects WHERE commit_id=? ORDER BY id",
            &[row["commit_id"].clone()],
        )?;
        bytes += objects
            .iter()
            .map(|o| o["data_b64"].as_str().map_or(0, str::len))
            .sum::<usize>();
        if !commits.is_empty() && bytes > PENDING_BYTES {
            break;
        }
        commits.push(
            json!({ "commit": row["commit_id"], "attempts": row["attempts"], "objects": objects }),
        );
    }
    if commits.is_empty() {
        // Drained: the next accepted commit asks for a new job.
        db.query("DELETE FROM object_outbox_dispatch", &[])?;
    }
    Ok(json!({ "commits": commits }))
}

/// The projector's outcome per commit: `ok` (pushed and read back) drops the staged
/// copies; `failed` keeps them pending with the reason.
pub fn projected<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let mut done = 0;
    for result in c["results"]
        .as_array()
        .ok_or_else(|| bad("results must be a list"))?
    {
        let id = object_id(result, "commit")?;
        match result["outcome"].as_str() {
            Some("ok") => {
                db.query(
                    "DELETE FROM object_projections WHERE commit_id=?",
                    &[json!(id.hex())],
                )?;
                discard(db, &id)?;
                done += 1;
            }
            Some("failed") => {
                let detail: String = result["detail"]
                    .as_str()
                    .unwrap_or("Object store push failed")
                    .chars()
                    .take(500)
                    .collect();
                db.query(
                    "UPDATE object_projections SET attempts=attempts+1,detail=?,updated_at=? WHERE commit_id=?",
                    &[json!(detail), json!(now), json!(id.hex())],
                )?;
            }
            _ => return Err(bad("outcome must be ok or failed")),
        }
    }
    Ok(json!({ "projected": done, "pending": count(db)? }))
}

/// Accepted objects not yet in the object store, by id (the read tier behind the store).
pub fn read<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let ids = c["ids"]
        .as_array()
        .filter(|ids| !ids.is_empty() && ids.len() <= READ_IDS)
        .ok_or_else(|| bad("ids must list 1 to 64 object ids"))?;
    let mut objects = Vec::new();
    for id in ids {
        let id = ObjectId::parse(id.as_str().unwrap_or_default())?;
        let row = db
            .query(
                "SELECT kind,data_b64 FROM staged_objects WHERE id=? \
                 AND commit_id IN (SELECT commit_id FROM object_projections) LIMIT 1",
                &[json!(id.hex())],
            )?
            .into_iter()
            .next();
        let Some(row) = row else { continue };
        let kind = match row["kind"].as_str() {
            Some("commit") => ObjectKind::Commit,
            Some("tree") => ObjectKind::Tree,
            Some("blob") => ObjectKind::Blob,
            _ => return Err(corrupt("staged object kind")),
        };
        let data = STANDARD
            .decode(row["data_b64"].as_str().unwrap_or_default())
            .map_err(|_| corrupt("staged object"))?;
        if hash_object(kind, &data) != id {
            return Err(corrupt("staged object"));
        }
        objects.push(object_json(id, kind, &data)?);
    }
    Ok(json!({ "objects": objects }))
}

pub fn count<S: SqlStore>(db: &S) -> Result<u64> {
    let rows = db.query("SELECT COUNT(*) AS n FROM object_projections", &[])?;
    Ok(rows
        .first()
        .and_then(|r| r["n"].as_u64())
        .unwrap_or_default())
}

/// For `repo_status`: how far the object store trails the authority, and why.
pub fn status<S: SqlStore>(db: &S) -> Result<Value> {
    let oldest = db.query(
        "SELECT commit_id,recorded_at,attempts,detail FROM object_projections ORDER BY recorded_at LIMIT 1",
        &[],
    )?;
    Ok(json!({ "pending": count(db)?, "oldest": oldest.into_iter().next() }))
}
