//! Quarantine: the owner (or an admin) withholds content without rewriting any id. A blob
//! keeps its place in every tree, but no read serves its bytes: every access answer lists
//! it (`withheld`), and the adapter refuses it on each read path. A session record keeps its
//! row, but its text reads masked, as do the memories of its session and those anchored to
//! a withheld blob (`memories`). Purge deletes what is withheld: the bytes (by the
//! adapter, in R2 and the caches) and a session record's text (here). It runs after the
//! record's retention window (the platform's quarantine job), or at once when the owner
//! confirms with the target's id. The record itself outlives the content: target, state,
//! reason, actor and times. Release serves a quarantined target again; a purged one never.
//!
//! Bytes live outside this store, so a purge is leased like the LFS sweep (`purge`): a
//! claim leases records, the adapter deletes, then `repo_quarantine_purged` marks them,
//! fenced by `epoch` against a finisher whose lease ran out.
use super::auth::Actor;
use super::op::QuarantineOp as Q;
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod memories;
pub(super) mod mirror;
mod purge;
mod sessions;
pub(super) use memories::Withheld as WithheldMemories;
pub(super) use sessions::{mask_sessions, refuse_transcript, withheld as withheld_sessions};

/// What a record withholds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Target {
    /// A Git blob's bytes, by object id.
    Blob,
    /// A session record's text (summary and transcript), by session record id.
    Session,
}

impl Target {
    fn parse(kind: &str) -> Result<Self> {
        match kind {
            "blob" => Ok(Self::Blob),
            "session" => Ok(Self::Session),
            _ => Err(bad("target.kind must be blob or session")),
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Blob => "blob",
            Self::Session => "session",
        }
    }
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Days a record waits before the job purges it, unless the owner says otherwise.
pub const RETAIN_DAYS: i64 = 7;
const MAX_RETAIN_DAYS: i64 = 365;
/// Blobs withheld at once: every access answer carries their ids.
const MAX_WITHHELD: usize = 1000;
const MAX_REASON: usize = 512;
const MAX_PATH: usize = 4096;
const LISTED: i64 = 500;
const COLUMNS: &str = "id,target_kind,target_id,path,state,reason,actor,at,purge_after,\
                       purged_at,purged_by,released_at,released_by,mirror";

/// The owner (or an admin) quarantines, lists, releases and purges; the platform's
/// quarantine job claims due records and reports them purged.
pub(super) fn authorize(actor: &Actor, op: Q) -> Result<()> {
    match op {
        Q::Claim if actor.can("quarantine") => Ok(()),
        Q::Claim => Err(Error::new(
            "FORBIDDEN",
            "Only the platform's quarantine job claims due purges",
        )),
        Q::Purged if actor.can("quarantine") => Ok(()),
        Q::Put | Q::List | Q::Release | Q::Purge | Q::Purged => actor.require_owner(),
        Q::MirrorClaim | Q::MirrorCopied | Q::MirrorSwitch | Q::MirrorRetired | Q::MirrorFailed
            if actor.can("quarantine") =>
        {
            Ok(())
        }
        Q::MirrorClaim | Q::MirrorCopied | Q::MirrorSwitch | Q::MirrorRetired | Q::MirrorFailed => {
            Err(Error::new(
                "FORBIDDEN",
                "Only the platform's quarantine job retires a mirror",
            ))
        }
    }
}

pub(super) fn run<S: SqlStore>(db: &S, c: &Value, op: Q, actor: &Actor) -> Result<Value> {
    if actor.grant.is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Quarantine covers the whole repository; a path-restricted token cannot use it",
        ));
    }
    match op {
        Q::Put => put(db, c, actor),
        Q::List => Ok(json!({ "records": records(db, "1", &[])?, "mirror": mirror::status(db)? })),
        Q::Release => release(db, c, actor),
        Q::Purge => purge::now(db, c),
        Q::Claim => purge::claim(db, c),
        Q::Purged => purge::done(db, c, actor),
        Q::MirrorClaim => mirror::claim(db, c),
        Q::MirrorCopied => mirror::copied(db, c),
        Q::MirrorSwitch => mirror::switch(db, c),
        Q::MirrorRetired => mirror::retired(db, c),
        Q::MirrorFailed => mirror::failed(db, c),
    }
}

/// A record as the API answers it.
fn shaped(row: &Value) -> Value {
    json!({
        "id": row["id"], "target": { "kind": row["target_kind"], "id": row["target_id"] },
        "path": row["path"], "state": row["state"], "reason": row["reason"],
        "actor": row["actor"], "at": row["at"], "purge_after": row["purge_after"],
        "purged_at": row["purged_at"], "purged_by": row["purged_by"],
        "released_at": row["released_at"], "released_by": row["released_by"],
        // The retirement of the repository's Artifacts mirror this purge started.
        "mirror": row["mirror"],
    })
}

fn records<S: SqlStore>(db: &S, filter: &str, params: &[Value]) -> Result<Vec<Value>> {
    let rows = db.query(
        &format!("SELECT {COLUMNS} FROM quarantine WHERE {filter} ORDER BY id DESC LIMIT {LISTED}"),
        params,
    )?;
    Ok(rows.iter().map(shaped).collect())
}

fn record<S: SqlStore>(db: &S, id: i64) -> Result<Value> {
    records(db, "id=?", &[json!(id)])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", format!("No quarantine record {id}")))
}

fn record_id(c: &Value) -> Result<i64> {
    c["id"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| bad("id must be a quarantine record id"))
}

fn text<'a>(c: &'a Value, key: &str, max: usize) -> Result<Option<&'a str>> {
    match &c[key] {
        Value::Null => Ok(None),
        Value::String(s)
            if !s.trim().is_empty() && s.len() <= max && !s.contains(char::is_control) =>
        {
            Ok(Some(s.trim()))
        }
        _ => Err(bad(&format!("{key} must be 1-{max} printable bytes"))),
    }
}

/// The target id, checked: a lowercase blob id, or a session record this repository holds.
fn target_id<S: SqlStore>(db: &S, kind: Target, id: &str) -> Result<String> {
    match kind {
        Target::Blob
            if id.len() == 40 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Ok(id.to_owned())
        }
        Target::Blob => Err(bad("target.id must be a blob id (40 lowercase hex digits)")),
        Target::Session => {
            let n = id
                .parse::<i64>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| bad("target.id must be a session record id"))?;
            if db
                .query("SELECT 1 FROM sessions WHERE id=?", &[json!(n)])?
                .is_empty()
            {
                return Err(Error::new(
                    "NOT_FOUND",
                    format!("Session {n} is not recorded"),
                ));
            }
            Ok(n.to_string())
        }
    }
}

/// `repo_quarantine {target: {kind, id}, reason, path?, retain_days?}`: withholds the target
/// now; the job purges it once `retain_days` (default 7) have passed (`purge_at`). A target
/// already withheld answers its record (`already`).
fn put<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let now = number(c, "now")?;
    let kind = Target::parse(c["target"]["kind"].as_str().unwrap_or_default())?;
    let id = target_id(db, kind, c["target"]["id"].as_str().unwrap_or_default())?;
    let reason = text(c, "reason", MAX_REASON)?.ok_or_else(|| bad("reason is required"))?;
    // The reason is shown to admins; it may describe a credential, never hold one.
    crate::secret_scan::scan("quarantine reason", reason.as_bytes(), &[])?;
    let path = text(c, "path", MAX_PATH)?;
    let days = match &c["retain_days"] {
        Value::Null => RETAIN_DAYS,
        v => v
            .as_i64()
            .filter(|d| (1..=MAX_RETAIN_DAYS).contains(d))
            .ok_or_else(|| bad(&format!("retain_days must be 1-{MAX_RETAIN_DAYS}")))?,
    };
    let live = records(
        db,
        "target_kind=? AND target_id=? AND state<>'released'",
        &[json!(kind.as_str()), json!(id)],
    )?;
    if let Some(found) = live.into_iter().next() {
        return Ok(json!({ "record": found, "already": true, "purge_at": null }));
    }
    if kind == Target::Blob && withheld(db)?.len() >= MAX_WITHHELD {
        return Err(Error::new(
            "TOO_LARGE",
            format!(
                "A repository withholds at most {MAX_WITHHELD} blobs; purge or release some first"
            ),
        ));
    }
    let purge_after = now + days * DAY_MS;
    let row = db.query(
        &format!(
            "INSERT INTO quarantine(target_kind,target_id,path,state,reason,actor,at,purge_after) \
             VALUES(?,?,?,'quarantined',?,?,?,?) RETURNING {COLUMNS}"
        ),
        &[
            json!(kind.as_str()),
            json!(id),
            json!(path),
            json!(reason),
            json!(actor.principal),
            json!(now),
            json!(purge_after),
        ],
    )?;
    let record = row
        .first()
        .map(shaped)
        .ok_or_else(|| bad("quarantine was not recorded"))?;
    Ok(json!({ "record": record, "already": false, "purge_at": purge_after }))
}

/// `repo_quarantine_release {id}`: serves a quarantined target again. Purged content is
/// gone, and a purge in progress may have deleted part of it, so neither is released.
fn release<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let now = number(c, "now")?;
    let id = record_id(c)?;
    let current = record(db, id)?;
    if current["state"] != "quarantined" {
        return Err(Error::new(
            "CONFLICT",
            format!(
                "Record {id} is {}; only quarantined content is released",
                current["state"]
            ),
        ));
    }
    let row = db.query(
        &format!(
            "UPDATE quarantine SET state='released',released_at=?,released_by=? \
             WHERE id=? AND (lease_until IS NULL OR lease_until<=?) RETURNING {COLUMNS}"
        ),
        &[json!(now), json!(actor.principal), json!(id), json!(now)],
    )?;
    let record = row.first().map(shaped).ok_or_else(|| purge::busy(id))?;
    Ok(json!({ "record": record }))
}

/// Blobs no read may serve (quarantined or purged), as `{id, path}` in record order.
pub(crate) fn withheld<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    Ok(db
        .query(
            "SELECT target_id,path FROM quarantine WHERE target_kind='blob' AND state<>'released' \
             ORDER BY id",
            &[],
        )?
        .into_iter()
        .map(|r| json!({ "id": r["target_id"], "path": r["path"] }))
        .collect())
}

/// Changes whenever the withheld set does (each record and each release counts once), so
/// caches derived from content key by it and an older isolate's builds are never read.
pub(crate) fn epoch<S: SqlStore>(db: &S) -> Result<u64> {
    let row = db.query(
        "SELECT COUNT(*)+COUNT(released_at) AS n FROM quarantine",
        &[],
    )?;
    Ok(row.first().and_then(|r| r["n"].as_u64()).unwrap_or(0))
}

/// A direct clone of the object store serves every blob it holds: refused while any is
/// withheld (Git over HTTPS refuses only a fetch that needs one).
pub(super) fn refuse_direct_clone<S: SqlStore>(db: &S) -> Result<()> {
    if withheld(db)?.is_empty() {
        return Ok(());
    }
    Err(Error::new(
        "QUARANTINED",
        "This repository withholds quarantined content, which a direct object-store clone \
         would serve; clone over Git HTTPS instead",
    ))
}
