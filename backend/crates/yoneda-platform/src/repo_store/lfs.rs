//! Git LFS objects as the authority sees them: who may upload or download, which objects a
//! repository holds, and its storage quota. Bytes never pass through here: the adapter hands
//! out presigned R2 URLs for what a batch allows, then verifies the stored bytes (size and
//! sha256) before `repo_lfs_store` records them. A batch's new uploads are reserved as
//! `pending` rows that count against the quota until they are stored or lapse, so uploads
//! that are never verified cannot grow storage past it. Stock `git lfs` reads and writes
//! whole repositories, so a path-restricted credential is refused, as for smart HTTP.
use super::auth::Actor;
use super::git_http::whole_repository;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use std::collections::HashMap;
use yoneda_core::{Error, Result};
mod quota;
#[cfg(test)]
pub use quota::DEFAULT_QUOTA_BYTES;
use quota::{quota_exceeded, set_quota, usage};

/// Largest object: one presigned PUT to R2 (a single upload is at most 5 GiB).
pub const MAX_OBJECT_BYTES: i64 = 5_000_000_000;
/// Objects one batch may name (git-lfs sends 100 at a time).
const MAX_BATCH: usize = 1000;
/// A reservation never verified lapses after a day (upload URLs expire well before).
pub const PENDING_MS: i64 = 24 * 60 * 60 * 1000;

const OPS: [&str; 5] = [
    "repo_lfs_batch",
    "repo_lfs_store",
    "repo_lfs_discard",
    "repo_lfs_usage",
    "repo_lfs_set_quota",
];

pub(super) fn owns(op: &str) -> bool {
    OPS.contains(&op)
}

/// Downloads need `read`, uploads `write`, the quota the owner (or an admin).
pub(super) fn authorize(actor: &Actor, op: &str, c: &Value) -> Result<()> {
    match op {
        "repo_lfs_batch" if c["operation"] == "upload" => actor.require("write"),
        "repo_lfs_store" | "repo_lfs_discard" => actor.require("write"),
        "repo_lfs_set_quota" => actor.require_owner(),
        _ => actor.require("read"),
    }
}

pub(super) fn run<S: SqlStore>(db: &S, c: &Value, op: &str, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    match op {
        "repo_lfs_batch" => batch(db, c, actor),
        "repo_lfs_store" => store(db, c, actor),
        "repo_lfs_discard" => discard(db, c),
        "repo_lfs_usage" => usage(db).map(|u| u.json()),
        "repo_lfs_set_quota" => set_quota(db, c, actor),
        _ => Err(Error::new("UNKNOWN_OP", format!("Unknown LFS op {op}"))),
    }
}

/// A sha256 object id: 64 lowercase hex digits.
fn valid_oid(oid: &str) -> bool {
    oid.len() == 64 && oid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A requested object, or why it cannot be one (a per-object 422).
fn requested(v: &Value) -> std::result::Result<(String, i64), String> {
    let oid = v["oid"].as_str().unwrap_or_default();
    if !valid_oid(oid) {
        return Err("oid must be a sha256: 64 lowercase hex digits".into());
    }
    match v["size"].as_i64() {
        Some(size) if (0..=MAX_OBJECT_BYTES).contains(&size) => Ok((oid.to_owned(), size)),
        Some(size) if size > MAX_OBJECT_BYTES => {
            Err(format!("LFS objects are at most {MAX_OBJECT_BYTES} bytes"))
        }
        _ => Err("size must be a whole number of bytes".into()),
    }
}

fn object_error(oid: &Value, size: &Value, code: u16, message: &str) -> Value {
    json!({ "oid": oid, "size": size, "error": { "code": code, "message": message } })
}

struct Row {
    size: i64,
    stored: bool,
}

fn rows<S: SqlStore>(db: &S) -> Result<HashMap<String, Row>> {
    Ok(db
        .query("SELECT oid,size,state FROM lfs_objects", &[])?
        .into_iter()
        .filter_map(|r| {
            Some((
                r["oid"].as_str()?.to_owned(),
                Row {
                    size: r["size"].as_i64()?,
                    stored: r["state"] == "stored",
                },
            ))
        })
        .collect())
}

fn row<S: SqlStore>(db: &S, oid: &str) -> Result<Option<Row>> {
    Ok(db
        .query(
            "SELECT size,state FROM lfs_objects WHERE oid=?",
            &[json!(oid)],
        )?
        .into_iter()
        .next()
        .map(|r| Row {
            size: r["size"].as_i64().unwrap_or_default(),
            stored: r["state"] == "stored",
        }))
}

/// Drops reservations older than `PENDING_MS`; answers their oids, whose bytes (if any were
/// uploaded) the adapter deletes.
fn lapse<S: SqlStore>(db: &S, now: i64) -> Result<Vec<String>> {
    let cutoff = now - PENDING_MS;
    let lapsed: Vec<String> = db
        .query(
            "SELECT oid FROM lfs_objects WHERE state='pending' AND reserved_at<?",
            &[json!(cutoff)],
        )?
        .into_iter()
        .filter_map(|r| r["oid"].as_str().map(str::to_owned))
        .collect();
    db.query(
        "DELETE FROM lfs_objects WHERE state='pending' AND reserved_at<?",
        &[json!(cutoff)],
    )?;
    Ok(lapsed)
}

/// `repo_lfs_batch {operation, objects: [{oid, size}]}`: per object, whether it is stored
/// (`present`), may be uploaded (`upload`), or an error (`{code, message}` as the LFS batch
/// API answers it). Uploads are reserved against the quota as a whole: a batch that does
/// not fit is refused (`QUOTA_EXCEEDED`) and reserves nothing. `lapsed` lists expired
/// reservations whose bytes the adapter deletes.
fn batch<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let upload = match c["operation"].as_str() {
        Some("upload") => true,
        Some("download") => false,
        _ => return Err(bad("operation must be upload or download")),
    };
    let objects = c["objects"]
        .as_array()
        .filter(|list| !list.is_empty())
        .ok_or_else(|| bad("objects must be a non-empty list"))?;
    if objects.len() > MAX_BATCH {
        return Err(Error::new(
            "TOO_LARGE",
            format!("A batch names at most {MAX_BATCH} objects"),
        ));
    }
    let now = number(c, "now")?;
    let mut lapsed = if upload { lapse(db, now)? } else { Vec::new() };
    let held = rows(db)?;
    let mut answers = Vec::with_capacity(objects.len());
    // New reservations (and resized pending ones), by oid: the size to reserve.
    let mut reserve: HashMap<String, i64> = HashMap::new();
    for v in objects {
        let (oid, size) = match requested(v) {
            Ok(object) => object,
            Err(message) => {
                answers.push(object_error(&v["oid"], &v["size"], 422, &message));
                continue;
            }
        };
        let answer = match held.get(&oid) {
            Some(r) if r.stored && r.size != size => object_error(
                &json!(oid),
                &json!(size),
                422,
                &format!("Object {oid} is stored with size {}", r.size),
            ),
            Some(r) if r.stored => json!({ "oid": oid, "size": size, "present": true }),
            _ if !upload => object_error(&json!(oid), &json!(size), 404, "Object does not exist"),
            _ => {
                reserve.insert(oid.clone(), size);
                json!({ "oid": oid, "size": size, "upload": true })
            }
        };
        answers.push(answer);
    }
    if !reserve.is_empty() {
        let usage = usage(db)?;
        // A pending row is re-reserved at the size asked now.
        let freed: i64 = reserve
            .keys()
            .filter_map(|oid| held.get(oid).map(|r| r.size))
            .sum();
        let wanted: i64 = reserve.values().sum();
        if usage.used - freed + wanted > usage.quota {
            return Err(quota_exceeded(&usage, wanted));
        }
        for (oid, size) in &reserve {
            db.query(
                "INSERT INTO lfs_objects(oid,size,state,uploaded_by,reserved_at) VALUES(?,?,'pending',?,?) \
                 ON CONFLICT(oid) DO UPDATE SET size=excluded.size,uploaded_by=excluded.uploaded_by,reserved_at=excluded.reserved_at",
                &[json!(oid), json!(size), json!(actor.principal), json!(now)],
            )?;
        }
        lapsed.retain(|oid| !reserve.contains_key(oid));
    }
    Ok(json!({ "objects": answers, "lapsed": lapsed }))
}

/// `repo_lfs_store {oid, size}`: records an object whose bytes the adapter verified in R2.
/// Storing a stored object again is a no-op (`already`); an object that was never reserved
/// (or whose reservation lapsed) is stored if it still fits the quota.
fn store<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let (oid, size) = requested(c).map_err(|m| bad(&m))?;
    let now = number(c, "now")?;
    match row(db, &oid)? {
        Some(r) if r.stored && r.size == size => {
            return Ok(json!({ "oid": oid, "size": size, "stored": true, "already": true }));
        }
        Some(r) if r.stored => {
            return Err(bad(&format!("Object {oid} is stored with size {}", r.size)));
        }
        held => {
            let usage = usage(db)?;
            let freed = held.map_or(0, |r| r.size);
            if usage.used - freed + size > usage.quota {
                return Err(quota_exceeded(&usage, size));
            }
        }
    }
    db.query(
        "INSERT INTO lfs_objects(oid,size,state,uploaded_by,reserved_at,stored_at) VALUES(?,?,'stored',?,?,?) \
         ON CONFLICT(oid) DO UPDATE SET size=excluded.size,state='stored',stored_at=excluded.stored_at",
        &[json!(oid), json!(size), json!(actor.principal), json!(now), json!(now)],
    )?;
    Ok(json!({ "oid": oid, "size": size, "stored": true, "already": false }))
}

/// `repo_lfs_discard {oid}`: drops a reservation whose upload failed verification. A stored
/// object is never discarded (`stored`), so the adapter deletes the bytes only when not.
fn discard<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let oid = string(c, "oid")?;
    if !valid_oid(&oid) {
        return Err(bad("oid must be a sha256: 64 lowercase hex digits"));
    }
    let stored = row(db, &oid)?.is_some_and(|r| r.stored);
    if !stored {
        db.query(
            "DELETE FROM lfs_objects WHERE oid=? AND state='pending'",
            &[json!(oid)],
        )?;
    }
    Ok(json!({ "oid": oid, "stored": stored }))
}
