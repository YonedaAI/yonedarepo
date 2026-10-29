//! LFS orphans and their sweep. Bytes no row references any more (a reservation that lapsed,
//! an upload that failed verification) are queued in `lfs_orphans`, in the transaction that
//! dropped the row. The platform's LFS job claims them under a lease, deletes their bytes
//! from R2 and reports back. While a lease runs, that oid can be neither reserved nor
//! stored, so a sweep deletes no object's bytes; a finisher whose lease ran out first is
//! fenced by its epoch, and an object stored after its lease is demoted to pending so its
//! bytes are uploaded again. The job is armed (`sweep_at` in an answer) by the first
//! reservation and by every new orphan, and re-arms itself while work remains.
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// How long a claim holds its oids; the job deletes only with a margin of it left.
pub const LEASE_MS: i64 = 5 * 60 * 1000;
/// A due time this far in the past belongs to a job that never ran: it is re-armed.
const STALE_MS: i64 = 10 * 60 * 1000;
/// No sweep job outlives this (a queue consumer runs minutes): a claimed orphan whose oid
/// is an object's again is kept this long for its finisher's report, then forgotten.
const FINISH_MS: i64 = 24 * 60 * 60 * 1000;
/// Most orphans one claim hands out (R2 deletes up to 1000 keys per call).
const MAX_CLAIM: i64 = 1000;

/// Queues `oid`'s bytes for the sweep (a no-op when already queued).
pub(super) fn orphan<S: SqlStore>(db: &S, oid: &str, now: i64) -> Result<()> {
    db.query(
        "INSERT INTO lfs_orphans(oid,queued_at) VALUES(?,?) ON CONFLICT(oid) DO NOTHING",
        &[json!(oid), json!(now)],
    )?;
    Ok(())
}

/// Whether a sweep holds `oid` now: it may then be neither reserved nor stored.
pub(super) fn sweeping<S: SqlStore>(db: &S, oid: &str, now: i64) -> Result<bool> {
    Ok(!db
        .query(
            "SELECT 1 FROM lfs_orphans WHERE oid=? AND lease_until>?",
            &[json!(oid), json!(now)],
        )?
        .is_empty())
}

/// `oid` is an object's again (reserved or stored): its bytes are no orphan's. A claimed
/// orphan stays for its finisher's report (see `done`); no lease holds it here.
pub(super) fn adopted<S: SqlStore>(db: &S, oid: &str) -> Result<()> {
    db.query(
        "DELETE FROM lfs_orphans WHERE oid=? AND lease_until IS NULL",
        &[json!(oid)],
    )?;
    Ok(())
}

/// The refusal for an oid a sweep holds.
pub(super) fn busy(oid: &str) -> Error {
    Error::new(
        "CONFLICT",
        format!(
            "Object {oid} is being cleaned up after an upload that was not kept; retry in a few minutes"
        ),
    )
}

/// Arms the sweep job for `wanted` unless it is already due by then: answers the time the
/// adapter schedules it for, or null.
pub(super) fn arm<S: SqlStore>(db: &S, wanted: i64, now: i64) -> Result<Value> {
    let due = db
        .query("SELECT due_at FROM lfs_sweep WHERE id=1", &[])?
        .first()
        .and_then(|r| r["due_at"].as_i64());
    if due.is_some_and(|due| due <= wanted && due + STALE_MS >= now) {
        return Ok(Value::Null);
    }
    schedule(db, Some(wanted))?;
    Ok(json!(wanted))
}

fn schedule<S: SqlStore>(db: &S, due: Option<i64>) -> Result<()> {
    match due {
        Some(due) => db.query(
            "INSERT INTO lfs_sweep(id,due_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET due_at=excluded.due_at",
            &[json!(due)],
        )?,
        None => db.query("DELETE FROM lfs_sweep", &[])?,
    };
    Ok(())
}

/// `repo_lfs_sweep_claim {limit}`: lapses expired reservations, drops orphans whose oid is
/// an object's again, and leases up to `limit` orphans (`claims: [{oid, epoch}]`, until
/// `lease_until`). `next_at` is when the job is due again (null: nothing waits).
pub(super) fn claim<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let limit = number(c, "limit")?;
    if !(1..=MAX_CLAIM).contains(&limit) {
        return Err(bad(&format!("limit must be 1 to {MAX_CLAIM}")));
    }
    super::lapse(db, now)?;
    db.query(
        "DELETE FROM lfs_orphans WHERE (lease_until IS NULL OR lease_until<?) \
         AND oid IN (SELECT oid FROM lfs_objects)",
        &[json!(now - FINISH_MS)],
    )?;
    let lease_until = now + LEASE_MS;
    let claims = db.query(
        "UPDATE lfs_orphans SET epoch=epoch+1,claimed_at=?,lease_until=? WHERE oid IN \
         (SELECT oid FROM lfs_orphans WHERE (lease_until IS NULL OR lease_until<=?) \
          AND oid NOT IN (SELECT oid FROM lfs_objects) ORDER BY queued_at LIMIT ?) \
         RETURNING oid,epoch",
        &[json!(now), json!(lease_until), json!(now), json!(limit)],
    )?;
    let next_at = next_due(db, now, lease_until)?;
    schedule(db, next_at)?;
    Ok(json!({ "claims": claims, "lease_until": lease_until, "next_at": next_at }))
}

/// When the sweep is next due: now while unleased orphans wait, else when a lease other
/// than this claim's ends (its job may have died) or the oldest reservation lapses.
fn next_due<S: SqlStore>(db: &S, now: i64, claimed_until: i64) -> Result<Option<i64>> {
    let row = db.query(
        "SELECT \
           (SELECT MIN(CASE WHEN lease_until IS NULL OR lease_until<=?1 THEN ?1 ELSE lease_until END) \
              FROM lfs_orphans WHERE (lease_until IS NULL OR lease_until<>?2) \
              AND oid NOT IN (SELECT oid FROM lfs_objects)) AS orphans, \
           (SELECT MIN(reserved_at) FROM lfs_objects WHERE state='pending') AS pending",
        &[json!(now), json!(claimed_until)],
    )?;
    let row = row.first();
    let orphans = row.and_then(|r| r["orphans"].as_i64());
    let pending = row
        .and_then(|r| r["pending"].as_i64())
        .map(|at| at + super::PENDING_MS);
    Ok([orphans, pending].into_iter().flatten().min())
}

/// `repo_lfs_sweep_done {claims: [{oid, epoch}]}`: the claimed bytes are deleted. Orphans
/// still held at that epoch leave the outbox (`done` counts them; a redelivered or fenced
/// report counts none). A report after its lease ran out demotes an object stored since,
/// whose bytes the late delete may have removed, to pending (`demoted`).
pub(super) fn done<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let claims = c["claims"]
        .as_array()
        .ok_or_else(|| bad("claims must be a list"))?;
    let mut finished = 0;
    let mut demoted = Vec::new();
    for claim in claims {
        let oid = claim["oid"]
            .as_str()
            .filter(|oid| super::valid_oid(oid))
            .ok_or_else(|| bad("each claim needs its oid"))?;
        let epoch = claim["epoch"]
            .as_i64()
            .ok_or_else(|| bad("each claim needs its epoch"))?;
        let held = db.query(
            "DELETE FROM lfs_orphans WHERE oid=? AND epoch=? RETURNING lease_until",
            &[json!(oid), json!(epoch)],
        )?;
        let Some(row) = held.first() else { continue };
        finished += 1;
        if row["lease_until"]
            .as_i64()
            .is_some_and(|until| until <= now)
        {
            let late = db.query(
                "UPDATE lfs_objects SET state='pending',reserved_at=?,stored_at=NULL \
                 WHERE oid=? AND state='stored' RETURNING oid",
                &[json!(now), json!(oid)],
            )?;
            if !late.is_empty() {
                demoted.push(oid.to_owned());
            }
        }
    }
    Ok(json!({ "done": finished, "demoted": demoted }))
}
