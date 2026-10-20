//! Staged objects: a small commit is accepted once this authority durably holds every
//! object it built for it, instead of after a write to the object store (R2 writes take
//! about a second; Artifacts takes one receive-pack per repository at a time). Each
//! accepted staged commit gets an object-outbox row in the same transaction; the projector
//! writes its objects to R2 (the store of record), confirms each write and reports, and
//! only then are the staged copies dropped. Until then reads fall back to them by id.
//! Failures stay pending with their reason, visible in `repo_status`; nothing is dropped
//! unwritten. The object ids stay listed (`commit_objects`) until Artifacts holds the commit
//! (see projection). Written against `SqlStore` alone, so any authority can own a staging
//! area.
use super::rows::{corrupt, object_id};
use crate::platform_objects::object_json;
use crate::storage::{SqlStore, bad, number};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, ObjectKind, hash_object},
};

/// Commits of at most this many objects totalling at most this many bytes are staged
/// (SQLite rows in a Durable Object hold at most 2 MB; base64 adds a third). Larger ones,
/// such as imports, are pushed and read back before they are accepted, so one projector
/// job stays within a Worker invocation's limits.
pub const STAGE_LIMIT: usize = 1024 * 1024;
pub const STAGE_OBJECTS: usize = 256;
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
    if objects.len() > STAGE_OBJECTS
        || objects.iter().map(|(_, _, d)| d.len()).sum::<usize>() > STAGE_LIMIT
    {
        return Ok(false);
    }
    // Multi-row inserts: each statement is a host call, and Durable Object SQL binds at
    // most 100 parameters per statement.
    for chunk in objects.chunks(25) {
        let mut params = Vec::with_capacity(chunk.len() * 4);
        for (id, kind, data) in chunk {
            params.extend([
                json!(commit.hex()),
                json!(id.hex()),
                json!(kind.name()),
                json!(STANDARD.encode(data)),
            ]);
        }
        let rows = vec!["(?,?,?,?)"; chunk.len()].join(",");
        db.query(
            &format!("INSERT INTO staged_objects(commit_id,id,kind,data_b64) VALUES{rows} ON CONFLICT DO NOTHING"),
            &params,
        )?;
    }
    for chunk in objects.chunks(33) {
        let params: Vec<_> = chunk
            .iter()
            .flat_map(|(id, kind, _)| [json!(commit.hex()), json!(id.hex()), json!(kind.name())])
            .collect();
        let rows = vec!["(?,?,?)"; chunk.len()].join(",");
        db.query(
            &format!(
                "INSERT INTO commit_objects(commit_id,id,kind) VALUES{rows} ON CONFLICT DO NOTHING"
            ),
            &params,
        )?;
    }
    Ok(true)
}

/// Drops prepared commits that expired without being accepted, with their staged copies.
pub fn expire<S: SqlStore>(db: &S, now: i64) -> Result<()> {
    let expired = db.query(
        "SELECT 1 FROM prepared_commits WHERE expires_at<? LIMIT 1",
        &[json!(now)],
    )?;
    if expired.is_empty() {
        return Ok(());
    }
    for table in ["staged_objects", "commit_objects"] {
        db.query(
            &format!(
                "DELETE FROM {table} WHERE commit_id IN (SELECT commit_id FROM prepared_commits WHERE expires_at<?) \
                 AND commit_id NOT IN (SELECT id FROM commits)"
            ),
            &[json!(now)],
        )?;
    }
    db.query(
        "DELETE FROM prepared_commits WHERE expires_at<?",
        &[json!(now)],
    )?;
    Ok(())
}

/// Accepts a staged commit: its objects must be staged here (this store built them, so
/// they need no readback), and its outbox row commits with the commit row. Returns whether
/// the adapter must ask for a projector job.
pub fn accept<S: SqlStore>(db: &S, commit: &ObjectId, now: i64) -> Result<bool> {
    let accepted = db.query(
        "INSERT INTO object_projections(commit_id,recorded_at,updated_at) SELECT ?1,?2,?2 \
         WHERE EXISTS (SELECT 1 FROM staged_objects WHERE commit_id=?1 AND id=?1 AND kind='commit') \
         RETURNING commit_id",
        &[json!(commit.hex()), json!(now)],
    )?;
    if accepted.is_empty() {
        return Err(Error::new(
            "NOT_FOUND",
            "This commit's objects were not staged; push them instead",
        ));
    }
    should_dispatch(db, now)
}

/// Whether the caller must ask for a drain: none is outstanding (or the last looks lost).
/// One request covers every commit accepted before the job next finds the outbox empty.
fn should_dispatch<S: SqlStore>(db: &S, now: i64) -> Result<bool> {
    let claimed = db.query(
        "INSERT INTO object_outbox_dispatch(id,dispatched_at) VALUES(1,?) \
         ON CONFLICT(id) DO UPDATE SET dispatched_at=excluded.dispatched_at WHERE dispatched_at<=? \
         RETURNING dispatched_at",
        &[json!(now), json!(now - DISPATCH_STALE_MS)],
    )?;
    Ok(!claimed.is_empty())
}

/// A commit pushed to Artifacts before it was accepted needs neither staged copies nor a
/// list of objects still to project.
pub fn discard<S: SqlStore>(db: &S, commit: &ObjectId) -> Result<()> {
    for table in ["staged_objects", "commit_objects"] {
        db.query(
            &format!("DELETE FROM {table} WHERE commit_id=?"),
            &[json!(commit.hex())],
        )?;
    }
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
        // Counted when handed out, so a projector that dies before reporting still shows.
        db.query(
            "UPDATE object_projections SET attempts=attempts+1,detail=COALESCE(detail,'No outcome reported yet') WHERE commit_id=?",
            &[row["commit_id"].clone()],
        )?;
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

/// The projector's outcome per commit: `ok` (every object written to R2) drops the staged
/// copies; `failed` keeps them pending with the reason (attempts count hand-outs).
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
                db.query(
                    "DELETE FROM staged_objects WHERE commit_id=?",
                    &[json!(id.hex())],
                )?;
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
                    "UPDATE object_projections SET detail=?,updated_at=? WHERE commit_id=?",
                    &[json!(detail), json!(now), json!(id.hex())],
                )?;
            }
            _ => return Err(bad("outcome must be ok or failed")),
        }
    }
    Ok(json!({ "projected": done, "pending": count(db)? }))
}

/// Accepted objects not yet in the object store, by id (the read tier behind the store):
/// structured, or the raw Git content with `raw` (for packs).
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
        objects.push(if c["raw"] == true {
            json!({ "id": id, "kind": kind.name(), "data_b64": row["data_b64"] })
        } else {
            object_json(id, kind, &data)?
        });
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
