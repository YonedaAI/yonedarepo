//! Group landing for a moved branch. Commits are created in parallel and never wait;
//! landings that need a merge are queued per branch. Whoever claims the branch's short
//! lease merges every pending independent landing into one platform (octopus) merge
//! commit, which lands as one log entry, so 100 concurrent landings cost a few round
//! trips instead of 100 racing merges. The lease orders merge construction; it never
//! blocks commits, reads or other branches.
use super::land_tickets::{finish, status};
use super::merging;
use super::rows::{self, RecordedGraph, branch_ref, current_version};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, merge_bases},
    txlog::OccOutcome,
};

/// How long one builder is left alone with a batch. Advisory: it only spares the branch a
/// stampede of identical merges; a batch lands only if the head it was built on is still
/// the head (compare-and-swap), so a slow or vanished builder never blocks or corrupts.
const LEASE_MS: i64 = 10_000;
const BATCH: u64 = 128;

/// Active lease, if any: (epoch, expires_at).
pub(super) fn lease<S: SqlStore>(db: &S, refname: &str) -> Result<Option<(i64, i64)>> {
    Ok(db
        .query(
            "SELECT epoch,expires_at FROM land_leases WHERE refname=?",
            &[json!(refname)],
        )?
        .first()
        .map(|r| {
            (
                r["epoch"].as_i64().unwrap_or(0),
                r["expires_at"].as_i64().unwrap_or(0),
            )
        }))
}

/// Whether a landing batch currently owns `refname` (direct lands then queue behind it).
pub fn busy<S: SqlStore>(db: &S, refname: &str, now: i64) -> Result<bool> {
    Ok(
        lease(db, refname)?.is_some_and(|(_, expires)| expires > now)
            || !db
                .query(
                    "SELECT 1 AS x FROM land_queue WHERE refname=? AND status='pending' LIMIT 1",
                    &[json!(refname)],
                )?
                .is_empty(),
    )
}

/// Takes the branch's lease (if free) and returns the pending batch to merge. Stale reads
/// fail immediately; the rest come with the trees needed for a three-way merge. A waiter
/// passes its `ticket`: once settled, that answers instead (one call per poll, not two).
pub fn claim<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let now = number(c, "now")?;
    if c.get("ticket").is_some_and(|t| !t.is_null()) {
        let mine = status(db, c)?;
        if mine["status"] != "pending" {
            return Ok(json!({ "settled": mine }));
        }
    }
    if let Some((_, expires)) = lease(db, &refname)?
        && expires > now
    {
        return Ok(json!({ "wait": true, "retry_after_ms": (expires - now).min(250) }));
    }
    // `slow_only`: changeset landing settles the path-disjoint items itself and leaves
    // only those on the same files to merges.
    let pending = db.query(
        "SELECT ticket,commit_id FROM land_queue WHERE refname=? AND status='pending' AND slow>=? ORDER BY ticket LIMIT ?",
        &[json!(refname), json!(i64::from(c["slow_only"] == true)), json!(BATCH)],
    )?;
    if pending.is_empty() {
        return Ok(json!({ "empty": true }));
    }
    let head = rows::ref_value(db, &refname)?
        .ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
    let head_row = rows::recorded(db, &head)?;
    let epoch = lease(db, &refname)?.map_or(1, |(e, _)| e + 1);
    db.query(
        "INSERT INTO land_leases(refname,epoch,expires_at) VALUES(?,?,?) ON CONFLICT(refname) DO UPDATE SET epoch=excluded.epoch,expires_at=excluded.expires_at",
        &[json!(refname), json!(epoch), json!(now + LEASE_MS)],
    )?;
    let mut items = Vec::new();
    // Tickets settled here (stale reads) are reported, so their waiters hear at once.
    let mut failed = Vec::new();
    for row in pending {
        let commit = rows::recorded(
            db,
            &ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?,
        )?;
        if merging::on_head(db, &commit, &head)? {
            items.push(
                json!({ "ticket": row["ticket"], "commit": commit.id, "fast_forward": true }),
            );
            continue;
        }
        match merging::occ(db, &commit, &refname)? {
            outcome @ (OccOutcome::Conflict { .. } | OccOutcome::FastForward) => {
                let error = merging::outcome_error(&refname, &head, outcome);
                let result = json!({ "code": error.code, "message": error.message });
                finish(db, &row["ticket"], "failed", result.clone(), now)?;
                failed
                    .push(json!({ "ticket": row["ticket"], "status": "failed", "result": result }));
            }
            OccOutcome::Rebase { .. } | OccOutcome::Merge { .. } => {
                let base = merge_bases(&RecordedGraph(db), &head, &commit.id)?
                    .into_iter()
                    .next();
                let base_tree = base
                    .map(|b| rows::recorded(db, &b).map(|r| r.tree))
                    .transpose()?;
                // The builder applies the batch write-skew rule with these (as land_batch does).
                let writes = merging::branch_paths(db, &commit.id, &head)?;
                items.push(json!({
                    "ticket": row["ticket"], "commit": commit.id, "commit_tree": commit.tree, "base_tree": base_tree,
                    "reads": commit.read_set, "writes": writes,
                }));
            }
        }
    }
    Ok(json!({
        "epoch": epoch, "ref": refname, "head": head, "head_tree": head_row.tree,
        "version": current_version(db)?, "items": items, "failed": failed,
    }))
}
