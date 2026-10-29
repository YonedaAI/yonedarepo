//! Landing a claimed batch (`land_queue`): one compare-and-swap of the head it was built
//! on and one log entry, a fast-forward or a platform (octopus) merge commit, verified
//! here; and releasing the builder's lease.
use super::changes;
use super::land::append;
use super::land_tickets::{finish, landed_version, settle_already};
use super::merging::{self, MERGE_PRINCIPAL};
use super::rows::{self, CommitRow, branch_ref, current_version, object_id};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{OccOutcome, TxKind},
};

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
                // A ticket for a commit already on the branch (queued before enqueue
                // answered `already`) settles; logging the landing again would break the
                // landings key and fail every batch after it.
                let landed_at = landed_version(db, &only.id, &refname)?;
                if landed_at.is_some() || head == only.id {
                    let settled = settle_already(db, &tickets, &only.id, &refname, landed_at, now)?;
                    release(db, &json!({ "ref": refname, "epoch": epoch }))?;
                    return Ok(settled);
                }
                if !merging::on_head(db, only, &head)? {
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
                    changes::landed(db, &commit.id, &refname, current_version(db)?, now)?;
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
    let mut batch = merging::BatchWrites::default();
    for commit in landed {
        match merging::occ(db, commit, refname)? {
            OccOutcome::Rebase { .. } | OccOutcome::Merge { .. } => {}
            OccOutcome::FastForward if commit.parents.first() == Some(head) => {}
            other => return Err(merging::outcome_error(refname, head, other)),
        }
        let writes = merging::branch_paths(db, &commit.id, head)?;
        if !batch.admits(&commit.read_set, &writes) {
            return Err(Error::new(
                "WRITE_SKEW",
                format!(
                    "{} reads or writes what an earlier commit of the batch writes; it lands in a later batch",
                    commit.id
                ),
            ));
        }
        allowed.extend(writes.iter().cloned());
        batch.accept(writes);
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
