//! Group landing for a moved branch. Commits are created in parallel and never wait;
//! landings that need a merge are queued per branch. Whoever claims the branch's short
//! lease merges every pending independent landing into one platform (octopus) merge
//! commit, which lands as one log entry, so 100 concurrent landings cost a few round
//! trips instead of 100 racing merges. The lease orders merge construction; it never
//! blocks commits, reads or other branches.
use super::land::{append, gates};
use super::merging::{self, MERGE_PRINCIPAL};
use super::rows::{
    self, CommitRow, RecordedGraph, Settings, branch_ref, current_version, object_id,
};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, merge_bases},
    txlog::{OccOutcome, TxKind},
};

/// How long one builder is left alone with a batch. Advisory: it only spares the branch a
/// stampede of identical merges; a batch lands only if the head it was built on is still
/// the head (compare-and-swap), so a slow or vanished builder never blocks or corrupts.
const LEASE_MS: i64 = 10_000;
const BATCH: u64 = 64;

pub fn enqueue<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    let refname = branch_ref(c)?;
    let commit = rows::recorded(db, &rows::object_id(c, "commit")?)?;
    let gate = gates(db, &commit.id, settings)?;
    if gate["ready"] != true {
        return Err(Error::new(
            "NOT_READY",
            format!("Commit cannot land yet: {gate}"),
        ));
    }
    let existing = db.query(
        "SELECT ticket FROM land_queue WHERE refname=? AND commit_id=? AND status='pending'",
        &[json!(refname), json!(commit.id.hex())],
    )?;
    if let Some(row) = existing.first() {
        return Ok(json!({ "ticket": row["ticket"], "queued": true }));
    }
    db.query(
        "INSERT INTO land_queue(refname,commit_id,principal,status,requested_at) VALUES(?,?,?,'pending',?)",
        &[json!(refname), json!(commit.id.hex()), json!(principal), json!(number(c, "now")?)],
    )?;
    let ticket = db.query("SELECT last_insert_rowid() AS t", &[])?[0]["t"].clone();
    Ok(json!({ "ticket": ticket, "queued": true }))
}

pub fn status<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let ticket = c["ticket"].as_i64().ok_or_else(|| bad("Missing ticket"))?;
    let row = db
        .query(
            "SELECT ticket,refname,commit_id,status,result FROM land_queue WHERE ticket=?",
            &[json!(ticket)],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", "Unknown landing ticket"))?;
    Ok(json!({
        "ticket": row["ticket"], "ref": row["refname"], "commit": row["commit_id"], "status": row["status"],
        "result": row["result"].as_str().and_then(|r| serde_json::from_str::<Value>(r).ok()),
    }))
}

/// Active lease, if any: (epoch, expires_at).
fn lease<S: SqlStore>(db: &S, refname: &str) -> Result<Option<(i64, i64)>> {
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

fn finish<S: SqlStore>(
    db: &S,
    ticket: &Value,
    status: &str,
    result: Value,
    now: i64,
) -> Result<()> {
    db.query(
        "UPDATE land_queue SET status=?,result=?,finished_at=? WHERE ticket=? AND status='pending'",
        &[
            json!(status),
            json!(result.to_string()),
            json!(now),
            ticket.clone(),
        ],
    )?;
    Ok(())
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
    let head = rows::ref_value(db, &refname)?
        .ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
    let head_row = rows::recorded(db, &head)?;
    let pending = db.query(
        "SELECT ticket,commit_id FROM land_queue WHERE refname=? AND status='pending' ORDER BY ticket LIMIT ?",
        &[json!(refname), json!(BATCH)],
    )?;
    if pending.is_empty() {
        return Ok(json!({ "empty": true }));
    }
    let epoch = lease(db, &refname)?.map_or(1, |(e, _)| e + 1);
    db.query(
        "INSERT INTO land_leases(refname,epoch,expires_at) VALUES(?,?,?) ON CONFLICT(refname) DO UPDATE SET epoch=excluded.epoch,expires_at=excluded.expires_at",
        &[json!(refname), json!(epoch), json!(now + LEASE_MS)],
    )?;
    let mut items = Vec::new();
    for row in pending {
        let commit = rows::recorded(
            db,
            &ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?,
        )?;
        if commit.parents.first() == Some(&head) {
            items.push(
                json!({ "ticket": row["ticket"], "commit": commit.id, "fast_forward": true }),
            );
            continue;
        }
        match merging::occ(db, &commit, &refname)? {
            outcome @ (OccOutcome::Conflict { .. } | OccOutcome::FastForward) => {
                let error = merging::outcome_error(&refname, &head, outcome);
                finish(
                    db,
                    &row["ticket"],
                    "failed",
                    json!({ "code": error.code, "message": error.message }),
                    now,
                )?;
            }
            OccOutcome::Rebase { .. } | OccOutcome::Merge { .. } => {
                let base = merge_bases(&RecordedGraph(db), &head, &commit.id)?
                    .into_iter()
                    .next();
                let base_tree = base
                    .map(|b| rows::recorded(db, &b).map(|r| r.tree))
                    .transpose()?;
                items.push(json!({
                    "ticket": row["ticket"], "commit": commit.id, "commit_tree": commit.tree, "base_tree": base_tree,
                }));
            }
        }
    }
    Ok(json!({
        "epoch": epoch, "ref": refname, "head": head, "head_tree": head_row.tree,
        "version": current_version(db)?, "items": items,
    }))
}

/// Lands a claimed batch with one compare-and-swap of the head it was built on and one log
/// entry: either one fast-forward commit, or one platform merge commit whose parents are
/// the head followed by every landed commit. Failed tickets record why; deferred tickets
/// stay queued for the next batch. Releases the builder's lease.
pub fn land_batch<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let refname = branch_ref(c)?;
    let now = number(c, "now")?;
    let epoch = c["epoch"].as_i64().ok_or_else(|| bad("Missing epoch"))?;
    let built_on = object_id(c, "head")?;
    let head =
        rows::ref_value(db, &refname)?.ok_or_else(|| Error::new("NOT_FOUND", "Branch vanished"))?;
    if head != built_on {
        // Compare-and-swap lost: the builder rebuilds against the new head.
        return Err(Error::new(
            "STALE_HEAD",
            format!("{refname} moved to {head} while the batch was built"),
        ));
    }
    for failure in c["failed"].as_array().into_iter().flatten() {
        finish(
            db,
            &failure["ticket"],
            "failed",
            failure["error"].clone(),
            now,
        )?;
    }
    let tickets: Vec<Value> = c["landed"].as_array().cloned().unwrap_or_default();
    let mut landed_commits = Vec::new();
    for ticket in &tickets {
        let row = db
            .query("SELECT commit_id FROM land_queue WHERE ticket=? AND refname=? AND status='pending'", &[ticket.clone(), json!(refname)])?
            .into_iter()
            .next()
            .ok_or_else(|| bad("Ticket is not pending on this branch"))?;
        landed_commits.push(rows::recorded(
            db,
            &ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?,
        )?);
    }
    let mut result = json!({ "landed": [] });
    if !landed_commits.is_empty() {
        result = match c.get("merge").filter(|m| !m.is_null()) {
            None => {
                let [only] = landed_commits.as_slice() else {
                    return Err(bad("Several commits land only through a merge commit"));
                };
                if only.parents.first() != Some(&head) {
                    return Err(Error::new(
                        "STALE_PARENT",
                        "The branch moved during the batch",
                    ));
                }
                append(db, c, TxKind::Commit, &refname, Some(head), only, principal)?
            }
            Some(merge) => {
                let merge =
                    rows::recorded(db, &ObjectId::parse(merge.as_str().unwrap_or_default())?)?;
                verify_octopus(db, &refname, &head, &landed_commits, &merge)?;
                let reads: BTreeSet<String> = landed_commits
                    .iter()
                    .flat_map(|c| c.read_set.clone())
                    .collect();
                let landed_as = CommitRow {
                    read_set: reads.into_iter().collect(),
                    base_version: landed_commits
                        .iter()
                        .map(|c| c.base_version)
                        .min()
                        .unwrap_or(0),
                    ..merge
                };
                let entry = append(
                    db,
                    c,
                    TxKind::Merge,
                    &refname,
                    Some(head),
                    &landed_as,
                    principal,
                )?;
                for commit in &landed_commits {
                    db.query(
                        "INSERT INTO landings(commit_id,refname,version,landed_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
                        &[json!(commit.id.hex()), json!(refname), entry["version"].clone(), json!(now)],
                    )?;
                }
                entry
            }
        };
        for ticket in &tickets {
            finish(
                db,
                ticket,
                "landed",
                json!({ "version": result["version"], "commit": result["commit"] }),
                now,
            )?;
        }
    }
    db.query(
        "DELETE FROM land_leases WHERE refname=? AND epoch=?",
        &[json!(refname), json!(epoch)],
    )?;
    Ok(result)
}

/// The batch merge must sit on the current head, be computed by the platform, and change
/// only paths that the landed work changed.
fn verify_octopus<S: SqlStore>(
    db: &S,
    refname: &str,
    head: &ObjectId,
    landed: &[CommitRow],
    merge: &CommitRow,
) -> Result<()> {
    let expected: Vec<ObjectId> = std::iter::once(*head)
        .chain(landed.iter().map(|c| c.id))
        .collect();
    if merge.parents != expected {
        return Err(Error::new(
            "STALE_PARENT",
            format!("The batch merge is not based on the current head of {refname}"),
        ));
    }
    if merge.principal != MERGE_PRINCIPAL {
        return Err(Error::new(
            "FORBIDDEN",
            "Only platform merge commits land queued work",
        ));
    }
    let mut allowed = BTreeSet::new();
    for commit in landed {
        match merging::occ(db, commit, refname)? {
            OccOutcome::Rebase { .. } | OccOutcome::Merge { .. } => {}
            OccOutcome::FastForward if commit.parents.first() == Some(head) => {}
            other => return Err(merging::outcome_error(refname, head, other)),
        }
        allowed.extend(merging::branch_paths(db, &commit.id, head)?);
    }
    if let Some(extra) = rows::touches(db, &merge.id)?
        .into_iter()
        .find(|t| !allowed.contains(&t.path))
    {
        return Err(Error::new(
            "FORBIDDEN",
            format!(
                "The batch merge changes {}, which no landed commit did",
                extra.path
            ),
        ));
    }
    Ok(())
}

pub fn release<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = string(c, "ref").and_then(|_| branch_ref(c))?;
    let epoch = c["epoch"].as_i64().ok_or_else(|| bad("Missing epoch"))?;
    db.query(
        "DELETE FROM land_leases WHERE refname=? AND epoch=?",
        &[json!(refname), json!(epoch)],
    )?;
    Ok(json!({ "released": true }))
}
