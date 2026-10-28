//! The LFS quota: bytes stored and reserved against it, and the owner's setting.
use super::MAX_OBJECT_BYTES;
use crate::repo_store::auth::Actor;
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// Quota of a repository whose owner never set one.
pub const DEFAULT_QUOTA_BYTES: i64 = 5 * 1024 * 1024 * 1024;
pub const MAX_QUOTA_BYTES: i64 = 1024 * 1024 * 1024 * 1024;

pub(super) fn quota_exceeded(usage: &Usage, wanted: i64) -> Error {
    Error::new(
        "QUOTA_EXCEEDED",
        format!(
            "LFS quota exceeded: this upload needs {wanted} bytes, {} of {} are used; the owner can raise the quota in Settings",
            usage.used, usage.quota
        ),
    )
}

pub(super) struct Usage {
    pub(super) quota: i64,
    pub(super) used: i64,
    stored: i64,
    objects: i64,
}

impl Usage {
    pub(super) fn json(&self) -> Value {
        json!({
            "quota_bytes": self.quota,
            "used_bytes": self.used,
            "stored_bytes": self.stored,
            "pending_bytes": self.used - self.stored,
            "objects": self.objects,
            "max_object_bytes": MAX_OBJECT_BYTES,
            "max_quota_bytes": MAX_QUOTA_BYTES,
        })
    }
}

/// `repo_lfs_usage`: the quota, and the bytes stored and reserved against it.
pub(super) fn usage<S: SqlStore>(db: &S) -> Result<Usage> {
    let quota = db
        .query("SELECT bytes FROM lfs_quota WHERE id=1", &[])?
        .first()
        .and_then(|r| r["bytes"].as_i64())
        .unwrap_or(DEFAULT_QUOTA_BYTES);
    let totals = db.query(
        "SELECT COALESCE(SUM(size),0) AS used, \
         COALESCE(SUM(CASE WHEN state='stored' THEN size ELSE 0 END),0) AS stored, \
         COALESCE(SUM(CASE WHEN state='stored' THEN 1 ELSE 0 END),0) AS objects FROM lfs_objects",
        &[],
    )?;
    let total = |key: &str| totals.first().and_then(|r| r[key].as_i64()).unwrap_or(0);
    Ok(Usage {
        quota,
        used: total("used"),
        stored: total("stored"),
        objects: total("objects"),
    })
}

/// `repo_lfs_set_quota {quota_bytes}`: owner only. A quota below what is stored keeps the
/// objects and refuses further uploads.
pub(super) fn set_quota<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let bytes = c["quota_bytes"]
        .as_i64()
        .filter(|n| (0..=MAX_QUOTA_BYTES).contains(n))
        .ok_or_else(|| {
            bad(&format!(
                "quota_bytes must be a whole number from 0 to {MAX_QUOTA_BYTES}"
            ))
        })?;
    db.query(
        "INSERT INTO lfs_quota(id,bytes,set_by,set_at) VALUES(1,?,?,?) \
         ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,set_by=excluded.set_by,set_at=excluded.set_at",
        &[json!(bytes), json!(actor.principal), json!(number(c, "now")?)],
    )?;
    usage(db).map(|u| u.json())
}
