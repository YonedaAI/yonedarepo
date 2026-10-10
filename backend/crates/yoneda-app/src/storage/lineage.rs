//! Descendants retain the exact parent attempt identity through capture and evaluation.
use super::*;
use std::collections::BTreeSet;
use yoneda_core::agents::{MAX_DELEGATION_DEPTH, MAX_RUN_EXECUTIONS};

pub(crate) fn run_executions<S: SqlStore>(db: &S, run_id: &str) -> Result<Vec<Value>> {
    let run = get(db, "runs", run_id)?;
    let limit = if run["mode"] == "collaborate" {
        yoneda_core::team::MAX_TEAM_EXECUTIONS
    } else {
        MAX_RUN_EXECUTIONS
    };
    let rows = db.query("SELECT payload FROM executions WHERE json_extract(payload,'$.run_id')=? ORDER BY id LIMIT ?",
        &[json!(run_id), json!(limit + 1)])?;
    if rows.len() > limit {
        return Err(Error::new(
            "RESOURCE_LIMIT",
            "Run execution ledger exceeds its bound",
        ));
    }
    rows.iter()
        .map(|row| {
            serde_json::from_str(
                row["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Corrupt execution"))?,
            )
            .map_err(|e| Error::new("DATABASE", e.to_string()))
        })
        .collect()
}

pub(crate) fn descendant_ids(executions: &[Value], parent: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for _ in 0..MAX_DELEGATION_DEPTH {
        for e in executions {
            if let (Some(p), Some(id)) = (e["parent_execution"].as_str(), e["id"].as_str())
                && (p == parent || ids.contains(p))
            {
                ids.insert(id.to_owned());
            }
        }
    }
    ids
}

fn execution_id(job: &Value) -> Option<&str> {
    job["payload"]["execution"]["id"]
        .as_str()
        .or_else(|| job["payload"]["candidate"]["execution"].as_str())
}

pub(crate) fn check_lineage<S: SqlStore>(db: &S, job: &Value, now: i64) -> Result<()> {
    if job["kind"] == "publish" {
        // Selection transfers this immutable revision to owner publication authority.
        // Only the ledger-issued publisher may bypass live agent ancestry checks.
        let did = string(&job["payload"], "decision_id")?;
        let decision = get(db, "decisions", &did)?;
        let repository = repo(db)?;
        if job["id"] != format!("publish:{did}")
            || decision["status"] != "publication_pending"
            || repository["pending"] != did
            || repository["head_commit"] != decision["target"]["commit"]
            || job["payload"]["target"] != decision["target"]
            || job["payload"]["expected"] != decision["base"]
        {
            return Err(Error::new("FENCED", "Publication reservation changed"));
        }
        return Ok(());
    }
    let Some(id) = execution_id(job) else {
        return Ok(());
    };
    let mut execution = get(db, "executions", id)?;
    let run = get(db, "runs", &string(&execution, "run_id")?)?;
    if run["status"] == "cancelled" || execution["status"] == "cancelled" {
        return Err(Error::new("FENCED", "Run or execution was cancelled"));
    }
    for _ in 0..=MAX_DELEGATION_DEPTH {
        let Some(parent) = execution["parent_execution"].as_str() else {
            return Ok(());
        };
        let ancestor = get(db, "executions", parent)?;
        let attempt = get(db, "jobs", &format!("job:{parent}"))?;
        if attempt["epoch"] != execution["parent_epoch"]
            || ancestor["status"] == "failed"
            || ancestor["status"] == "cancelled"
            || (attempt["status"] != "done"
                && (attempt["status"] != "running"
                    || number(&attempt, "lease_until")? <= now
                    || number(&attempt, "attempt_deadline")? <= now))
        {
            return Err(Error::new(
                "FENCED",
                "Delegating parent attempt expired, failed or was restarted",
            ));
        }
        execution = ancestor;
    }
    Err(Error::new(
        "FENCED",
        "Delegation ancestry exceeds the supported depth",
    ))
}

/// Fence descendants and durably request container stops in the same transaction.
pub(crate) fn fence_descendants<S: SqlStore>(db: &S, job: &Value, now: i64) -> Result<()> {
    let Some(parent) = execution_id(job) else {
        return Ok(());
    };
    let execution = get(db, "executions", parent)?;
    let run_id = string(&execution, "run_id")?;
    let executions = run_executions(db, &run_id)?;
    let ids = descendant_ids(&executions, parent);
    if ids.is_empty() {
        return Ok(());
    }
    for mut e in executions
        .into_iter()
        .filter(|e| e["id"].as_str().is_some_and(|id| ids.contains(id)))
    {
        e["status"] = json!("cancelled");
        e["error"] = json!("Delegating parent attempt was superseded");
        save_execution(db, &e, now)?;
    }
    for mut child in run_jobs(db, &run_id)? {
        if child["kind"] != "publish" && execution_id(&child).is_some_and(|id| ids.contains(id)) {
            cancel_job(db, &mut child, now)?;
        }
    }
    let rows = db.query(
        "SELECT payload FROM candidates WHERE json_extract(payload,'$.run_id')=?",
        &[json!(run_id)],
    )?;
    for row in rows {
        let mut c: Value = serde_json::from_str(
            row["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt candidate"))?,
        )
        .map_err(|e| bad(&e.to_string()))?;
        if c["execution"].as_str().is_some_and(|id| ids.contains(id)) {
            // Keep selected captures as immutable decision evidence even if their producer fails.
            if !db
                .query(
                    "SELECT id FROM decisions WHERE json_extract(payload,'$.candidate')=? LIMIT 1",
                    &[c["id"].clone()],
                )?
                .is_empty()
            {
                continue;
            }
            c["status"] = json!("cancelled");
            save(db, "candidates", &string(&c, "id")?, &c)?;
        }
    }
    event(
        db,
        "execution.descendants_cancelled",
        now,
        json!({"execution":parent,"descendants":ids}),
    )
}

pub(crate) fn run_jobs<S: SqlStore>(db: &S, run_id: &str) -> Result<Vec<Value>> {
    db.query("SELECT payload FROM jobs WHERE id IN (SELECT id FROM jobs WHERE json_extract(payload,'$.payload.execution.run_id')=? UNION SELECT id FROM jobs WHERE json_extract(payload,'$.payload.run_id')=? UNION SELECT id FROM jobs WHERE json_extract(payload,'$.payload.candidate.run_id')=? UNION SELECT id FROM jobs WHERE json_extract(payload,'$.payload.decision_id') IN (SELECT id FROM decisions WHERE json_extract(payload,'$.run_id')=?)) ORDER BY id",
        &[json!(run_id),json!(run_id),json!(run_id),json!(run_id)])?.iter().map(|row| {
        serde_json::from_str(row["payload"].as_str().ok_or_else(|| bad("Corrupt job"))?)
            .map_err(|e| bad(&e.to_string()))
    }).collect()
}

pub(crate) fn cancel_job<S: SqlStore>(db: &S, job: &mut Value, now: i64) -> Result<()> {
    if job["status"] != "queued" && job["status"] != "running" {
        return Ok(());
    }
    let id = string(job, "id")?;
    let epoch = number(job, "epoch")?;
    outbox(
        db,
        &format!("stop:{id}:{epoch}"),
        "stop",
        json!({"job_id":id,"epoch":epoch}),
    )?;
    job["status"] = json!("cancelled");
    job["epoch"] = json!(epoch + 1);
    save(db, "jobs", &id, job)?;
    if job["kind"] == "publish" {
        let did = string(&job["payload"], "decision_id")?;
        let mut decision = get(db, "decisions", &did)?;
        decision["status"] = json!("publication_failed");
        decision["error"] = json!(
            "Delegating parent attempt was superseded; verify the canonical remote before resynchronizing"
        );
        save(db, "decisions", &did, &decision)?;
        let author = if decision["decision_kind"] == "development_verification" {
            "owner_automation"
        } else {
            "owner"
        };
        node(
            db,
            &did,
            "decision",
            decision["rationale"].as_str().unwrap_or("Decision"),
            author,
            now,
            decision.clone(),
        )?;
        let mut repository = repo(db)?;
        repository["status"] = json!("blocked");
        save(db, "repository", "repo", &repository)?;
    }
    Ok(())
}
