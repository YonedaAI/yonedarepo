use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::Result;
#[cfg(test)]
#[path = "status_tests.rs"]
mod tests;
pub(super) fn reflect_status<S: SqlStore>(db: &S, job: &Value, now: i64) -> Result<()> {
    if job["status"] == "failed" {
        let conflict_id = job["payload"]["conflict_id"]
            .as_str()
            .or_else(|| job["payload"]["conflict_resolver"]["conflict_id"].as_str());
        if let Some(id) = conflict_id {
            let mut record = get(db, "conflicts", id)?;
            record["status"] = json!("failed");
            record["error"] = job
                .get("error")
                .cloned()
                .unwrap_or(json!("Conflict attempt budget exhausted"));
            save(db, "conflicts", id, &record)?;
            event(
                db,
                "candidate.refresh_failed",
                now,
                json!({"conflict_id":id,"job_id":job["id"],"error":record["error"]}),
            )?;
        }
    }
    let execution = if job["kind"] == "agent" || job["kind"] == "capture" {
        job["payload"]["execution"]["id"].as_str()
    } else if job["kind"] == "evaluate" {
        job["payload"]["candidate"]["execution"].as_str()
    } else {
        None
    };
    if let Some(id) = execution {
        let mut e = get(db, "executions", id)?;
        if job["kind"] == "agent" || job["status"] == "failed" {
            e["status"] = job["status"].clone();
        }
        e["error"] = job
            .get("error")
            .cloned()
            .unwrap_or(json!("Attempt lease expired"));
        if job["status"] == "failed" {
            e["finished_at"] = json!(now);
            // Stage attribution comes from the authoritative job, never an error body.
            e["failure_stage"] = job["kind"].clone();
            e["failure_job_id"] = job["id"].clone();
            e["failure_job_epoch"] = job["epoch"].clone();
        }
        save_execution(db, &e, now)?;
        if job["kind"] == "agent" || job["status"] == "failed" {
            fence_descendants(db, job, now)?;
        }
        if job["kind"] == "evaluate" && job["status"] == "failed" {
            let cid = string(&job["payload"]["candidate"], "id")?;
            let mut candidate = get(db, "candidates", &cid)?;
            if candidate["status"] == "evaluating"
                && job["payload"]["policy"] == repo(db)?["policy"]
            {
                candidate["status"] = json!("failed");
                candidate["error"] = e["error"].clone();
                save(db, "candidates", &cid, &candidate)?;
            }
        }
        if job["status"] == "failed" {
            super::super::sandbox_team::failed(db, &e, now)?;
        }
        if job["status"] == "failed" {
            let rid = string(&e, "run_id")?;
            let mut run = get(db, "runs", &rid)?;
            if (run["mode"] == "compare" || run["external"] == true) && run["status"] == "exploring"
            {
                let active = db.query("SELECT id FROM executions WHERE json_extract(payload,'$.run_id')=? AND json_extract(payload,'$.status') IN ('queued','running','capturing','evaluating') LIMIT 1", &[json!(rid)])?;
                let reviewable = db.query("SELECT id FROM candidates WHERE json_extract(payload,'$.run_id')=? AND json_extract(payload,'$.status') IN ('eligible','evaluating') LIMIT 1", &[json!(rid)])?;
                if active.is_empty() && reviewable.is_empty() {
                    run["status"] = json!("failed");
                    run["error"] = failure_summary(db, &rid)?;
                    save(db, "runs", &rid, &run)?;
                    event(
                        db,
                        "run.failed",
                        now,
                        json!({"run_id":rid,"reason":"No active or independently eligible approach remains","error":run["error"]}),
                    )?;
                }
            }
        }
    }
    Ok(())
}

/// Why no approach of a run remains: each failed execution's agent, model and error, and
/// each rejected or failed candidate. `code` is the first failure's leading error code.
fn failure_summary<S: SqlStore>(db: &S, rid: &str) -> Result<Value> {
    let rows = |table: &str| {
        db.query(
            &format!("SELECT payload FROM {table} WHERE json_extract(payload,'$.run_id')=? AND json_extract(payload,'$.status') IN ('failed','rejected','cancelled') ORDER BY id"),
            &[json!(rid)],
        )
    };
    let parse = |row: &Value| {
        serde_json::from_str::<Value>(row["payload"].as_str().unwrap_or("{}")).unwrap_or_default()
    };
    let text = |v: &Value| {
        v.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| v.to_string())
    };
    let mut executions = Vec::new();
    let mut lines = Vec::new();
    for e in rows("executions")?.iter().map(parse) {
        let error = text(&e["error"]).chars().take(300).collect::<String>();
        let agent = format!("{}/{}", text(&e["provider"]), text(&e["model"]));
        lines.push(format!(
            "{} {} {agent}: {error}",
            text(&e["id"]),
            text(&e["role"])
        ));
        executions.push(json!({"id":e["id"],"role":e["role"],"provider":e["provider"],"model":e["model"],"stage":e["failure_stage"],"error":error}));
    }
    for c in rows("candidates")?.iter().map(parse) {
        let error = text(&c["error"]).chars().take(300).collect::<String>();
        lines.push(format!(
            "candidate {} {}: {error}",
            text(&c["execution"]),
            text(&c["status"])
        ));
    }
    let code = executions
        .first()
        .and_then(|e| e["error"].as_str())
        .and_then(|e| e.split(':').next())
        .filter(|c| !c.is_empty() && c.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
        .unwrap_or("NO_ELIGIBLE_APPROACH");
    Ok(json!({"code":code,"message":lines.join("; "),"executions":executions}))
}
