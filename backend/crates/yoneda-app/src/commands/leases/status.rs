use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::Result;
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
        save_execution(db, &e, now)?;
        if (!e["team_task"].is_null() || e["team_role"] == "planner")
            && (job["kind"] == "agent" || job["status"] == "failed")
        {
            super::super::team::reflect(
                db,
                &e,
                job["status"].as_str().unwrap_or("failed"),
                e["epoch"].clone(),
                now,
            )?;
        }
        if job["kind"] == "agent" || job["status"] == "failed" {
            fence_descendants(db, job, now)?;
        }
        if job["status"] == "failed" && e["role"] == "research" {
            let rid = string(&e, "run_id")?;
            let mut run = get(db, "runs", &rid)?;
            run["status"] = json!("failed");
            save(db, "runs", &rid, &run)?;
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
                super::super::conflicts::resolver_evaluated(db, &cid, false, now)?;
            }
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
                    save(db, "runs", &rid, &run)?;
                    event(
                        db,
                        "run.failed",
                        now,
                        json!({"run_id":rid,"reason":"No active or independently eligible approach remains"}),
                    )?;
                }
            }
        }
    }
    if job["kind"] == "publish" && job["status"] == "failed" {
        let did = string(&job["payload"], "decision_id")?;
        let mut repository = repo(db)?;
        if repository["pending"] != did {
            // A superseded publisher cannot re-block a recovered or advanced repository.
            return Ok(());
        }
        let mut decision = get(db, "decisions", &did)?;
        decision["status"] = json!("publication_failed");
        decision["error"] = job
            .get("error")
            .cloned()
            .unwrap_or(json!("Publisher attempt budget exhausted"));
        repository["status"] = json!("blocked");
        save(db, "repository", "repo", &repository)?;
        save(db, "decisions", &did, &decision)?;
        node(
            db,
            &did,
            "decision",
            decision["rationale"].as_str().unwrap_or("Decision"),
            "owner",
            now,
            decision.clone(),
        )?;
    }
    Ok(())
}
