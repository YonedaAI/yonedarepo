//! Trusted adapters observe remote Git and pre-execution capacity failures outside transactions.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "resync_repository" => resync(db, c, now),
        "defer_job" => defer(db, c, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown recovery operation")),
    }
}

fn resync<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let workspace = string(c, "_workspace")?;
    let mut repository = repo(db)?;
    if c.get("_grant").is_some()
        || repository["workspace"].as_str().unwrap_or("_admin") != workspace
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the repository owner can resynchronize",
        ));
    }
    let observed = hash(c, "observed_commit", &[40, 64])?;
    let expected = number(c, "expected_version")?;
    let next = expected
        .checked_add(1)
        .filter(|_| expected >= 0)
        .ok_or_else(|| bad("Invalid expected_version"))?;
    let pending = c
        .get("expected_pending")
        .filter(|v| {
            v.is_null()
                || v.as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 16384)
        })
        .ok_or_else(|| bad("expected_pending must be an explicit decision ID or null"))?;
    let input =
        json!({"observed_commit":observed,"expected_version":expected,"expected_pending":pending});
    // A replay succeeds only while the exact recovered state remains current.
    // A receipt alone must never conceal a later selection or another resynchronization.
    if repository["status"] == "ready"
        && repository["version"] == next
        && repository["pending"].is_null()
        && repository["head_commit"] == observed
        && repository["published_commit"] == observed
        && repository["last_resync"]["input"] == input
    {
        return Ok(repository["last_resync"]["receipt"].clone());
    }
    if repository["version"] != expected || repository["pending"] != *pending {
        return Err(Error::new(
            "HEAD_MOVED",
            "Repository version or pending decision changed",
        ));
    }
    if repository["status"] != "blocked" {
        return Err(Error::new(
            "INVALID_STATE",
            "Only blocked repositories can be resynchronized",
        ));
    }
    fence_publication(db, pending)?;
    if let Some(did) = pending.as_str() {
        let mut decision = get(db, "decisions", did)?;
        if decision["target"]["commit"] == observed {
            super::completion::record_publication(db, &mut repository, &mut decision, now)?;
        } else {
            // Preserve failed/conflict status, original observation and error as audit history.
            repository["site"] = Value::Null;
        }
        decision["resynchronized_at"] = json!(now);
        decision["resynchronized_commit"] = json!(observed);
        save(db, "decisions", did, &decision)?;
        let author = if decision["decision_kind"] == "development_verification" {
            "owner_automation"
        } else {
            "owner"
        };
        node(
            db,
            did,
            "decision",
            decision["rationale"].as_str().unwrap_or("Decision"),
            author,
            now,
            decision.clone(),
        )?;
    } else {
        repository["site"] = Value::Null;
    }
    repository["head_commit"] = json!(observed);
    repository["published_commit"] = json!(observed);
    repository["pending"] = Value::Null;
    repository["status"] = json!("ready");
    repository["version"] = json!(next);
    let receipt = json!({"id":repository["id"],"status":"ready","version":next,
        "head_commit":observed,"published_commit":observed,"pending":null,"site":repository["site"]});
    repository["last_resync"] = json!({"input":input,"receipt":receipt});
    save(db, "repository", "repo", &repository)?;
    event(
        db,
        "repository.resynchronized",
        now,
        json!({"expected_version":expected,"expected_pending":pending,"observed_commit":observed,"version":next}),
    )?;
    Ok(receipt)
}

fn fence_publication<S: SqlStore>(db: &S, pending: &Value) -> Result<()> {
    for row in db.query(
        "SELECT payload FROM jobs WHERE json_extract(payload,'$.kind')='publish' AND (json_extract(payload,'$.payload.decision_id')=? OR json_extract(payload,'$.status') IN ('queued','running')) ORDER BY id",
        std::slice::from_ref(pending),
    )? {
        let mut job: Value = serde_json::from_str(row["payload"].as_str().ok_or_else(|| bad("Corrupt publisher"))?)
            .map_err(|e| bad(&e.to_string()))?;
        let id = string(&job, "id")?;
        let epoch = number(&job, "epoch")?;
        outbox(db, &format!("stop:{id}:{epoch}"), "stop", json!({"job_id":id,"epoch":epoch}))?;
        job["epoch"] = json!(epoch.checked_add(1).ok_or_else(|| bad("Attempt epoch overflow"))?);
        job["lease_until"] = json!(0);
        if job["status"] == "queued" || job["status"] == "running" {
            job["status"] = json!("cancelled");
        }
        save(db, "jobs", &id, &job)?;
    }
    Ok(())
}

fn defer<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let mut job = active(db, c, now)?;
    if job["external"] == true || c.get("_grant").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "External attempts cannot defer hosted dispatch",
        ));
    }
    if c["reason"] != "container_capacity" {
        return Err(bad(
            "Only known container_capacity failures can defer a job",
        ));
    }
    if !job["runtime_started_at"].is_null() {
        return Err(Error::new(
            "INVALID_STATE",
            "Started execution cannot refund an attempt",
        ));
    }
    let id = string(&job, "id")?;
    let epoch = number(&job, "epoch")?;
    let count = job["defer_count"]
        .as_i64()
        .unwrap_or(0)
        .checked_add(1)
        .filter(|count| *count > 0)
        .ok_or_else(|| bad("Defer counter overflow"))?;
    let backoff = (5_000_i64 << (count - 1).min(4)).min(60_000);
    let not_before = now
        .checked_add(backoff)
        .ok_or_else(|| bad("Defer time overflow"))?;
    job["epoch"] = json!(
        epoch
            .checked_add(1)
            .ok_or_else(|| bad("Attempt epoch overflow"))?
    );
    job["attempt"] = json!(
        number(&job, "attempt")?
            .checked_sub(1)
            .filter(|attempt| *attempt >= 0)
            .ok_or_else(|| bad("No claimed attempt to refund"))?
    );
    job["status"] = json!("queued");
    job["lease_until"] = json!(0);
    job["attempt_deadline"] = Value::Null;
    job["progress"] = Value::Null;
    job["not_before"] = json!(not_before);
    job["defer_count"] = json!(count);
    job["error"] = json!("Container capacity unavailable before execution");
    save(db, "jobs", &id, &job)?;
    super::leases::reflect_status(db, &job, now)?;
    outbox(
        db,
        &format!("stop:{id}:{epoch}"),
        "stop",
        json!({"job_id":id,"epoch":epoch}),
    )?;
    outbox(
        db,
        &format!("dispatch:{id}:defer:{}", job["epoch"]),
        &string(&job, "kind")?,
        json!({"job_id":id,"not_before":not_before}),
    )?;
    event(
        db,
        "job.deferred",
        now,
        json!({"id":id,"epoch":job["epoch"],"refunded_epoch":epoch,"reason":"container_capacity","not_before":not_before}),
    )?;
    Ok(job)
}
