use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod status;
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "claim" => {
            let id = string(&c, "job_id")?;
            let mut j = get(db, "jobs", &id)?;
            if j["external"] == true {
                return Err(Error::new(
                    "FORBIDDEN",
                    "External attempts cannot launch hosted harnesses",
                ));
            }
            if j["status"] == "done" {
                return Ok(json!({"already_done":true,"id":id}));
            }
            if j["status"] == "cancelled" || j["status"] == "failed" {
                return Err(Error::new("FENCED", "Job is terminal"));
            }
            if j["status"] == "running" && number(&j, "lease_until")? > now {
                return Err(Error::new("LEASE_HELD", "Attempt is already running"));
            }
            if number(&j, "attempt")? >= 2
                || number(&j, "deadline")? <= now
                || (j["attempt"] == 0
                    && j["dispatch_deadline"]
                        .as_i64()
                        .is_some_and(|deadline| deadline <= now))
            {
                return Err(Error::new("ATTEMPTS_EXHAUSTED", "Job budget exhausted"));
            }
            if j["not_before"].as_i64().is_some_and(|time| time > now) {
                return Ok(json!({"deferred":true,"id":id,"not_before":j["not_before"]}));
            }
            check_lineage(db, &j, now)?;
            if j["kind"] == "agent" && number(&j, "attempt")? > 0 {
                fence_descendants(db, &j, now)?;
            }
            j["attempt"] = json!(number(&j, "attempt")? + 1);
            j["epoch"] = json!(number(&j, "epoch")? + 1);
            j["status"] = json!("running");
            j["not_before"] = Value::Null;
            j["runtime_started_at"] = Value::Null;
            j["progress"] = Value::Null;
            let duration = duration(db, &j)?;
            if let Some(budget) = super::model_budgets::for_job(db, &j)? {
                j["model_budget"] = json!(budget);
            }
            j["attempt_deadline"] = json!((now + 120_000 + duration).min(number(&j, "deadline")?));
            j["lease_until"] = json!((now + 120_000).min(number(&j, "attempt_deadline")?));
            save(db, "jobs", &id, &j)?;
            if j["kind"] == "agent" {
                let eid = string(&j["payload"]["execution"], "id")?;
                let mut e = get(db, "executions", &eid)?;
                e["status"] = json!("running");
                e["started_at"] = json!(now);
                e["epoch"] = j["epoch"].clone();
                let harness = string(&e, "harness")?;
                let model = e["model"]
                    .as_str()
                    .or_else(|| c["models"][&harness].as_str())
                    .map(str::to_owned);
                if let Some(model) = model {
                    if model.is_empty() || model.len() > 128 {
                        return Err(bad("Invalid model identifier"));
                    }
                    e["model"] = json!(model);
                    j["model"] = json!(model);
                    j["payload"]["execution"]["model"] = json!(model);
                    save(db, "jobs", &id, &j)?;
                }
                save_execution(db, &e, now)?;
                super::team::reflect(db, &e, "running", j["epoch"].clone(), now)?;
            }
            event(
                db,
                "job.started",
                now,
                json!({"id":id,"kind":j["kind"],"epoch":j["epoch"]}),
            )?;
            Ok(j)
        }
        "check_attempt" => {
            let j = active(db, &c, now)?;
            Ok(json!({"status":j["status"],"deadline":j["attempt_deadline"]}))
        }
        "heartbeat" | "progress" => {
            let mut j = active(db, &c, now)?;
            let id = string(&j, "id")?;
            if c["progress"]["stage"] == "container_ready" && j["runtime_started_at"].is_null() {
                j["runtime_started_at"] = json!(now);
                let duration = duration(db, &j)?;
                j["attempt_deadline"] = json!((now + duration).min(number(&j, "deadline")?));
            }
            let lease = if j["runtime_started_at"].is_null() {
                (now + 60_000).max(number(&j, "lease_until")?)
            } else {
                now + 60_000
            };
            j["lease_until"] = json!(lease.min(number(&j, "attempt_deadline")?));
            if c.get("progress").is_some() && j["progress"] != c["progress"] {
                j["progress"] = c["progress"].clone();
                event(
                    db,
                    "job.progress",
                    now,
                    json!({"id":id,"epoch":j["epoch"],"progress":j["progress"]}),
                )?;
            }
            save(db, "jobs", &id, &j)?;
            Ok(json!({"lease_until":j["lease_until"]}))
        }
        "fail" => {
            let mut j = active(db, &c, now)?;
            let id = string(&j, "id")?;
            j["status"] = json!(if c["retryable"] == true && number(&j, "attempt")? < 2 {
                "queued"
            } else {
                "failed"
            });
            j["error"] = c["error"].clone();
            j["lease_until"] = json!(0);
            save(db, "jobs", &id, &j)?;
            if j["status"] == "queued" {
                outbox(
                    db,
                    &format!("dispatch:{id}:{}", number(&j, "attempt")?),
                    j["kind"].as_str().unwrap_or("agent"),
                    json!({"job_id":id}),
                )?;
            }
            reflect_status(db, &j, now)?;
            event(
                db,
                "job.failed",
                now,
                json!({"id":id,"status":j["status"],"epoch":j["epoch"],"error":c["error"]}),
            )?;
            Ok(j)
        }
        "recover" => {
            let mut recovered = 0;
            let rows = db.query("SELECT id FROM jobs WHERE (json_extract(payload,'$.status')='running' AND json_extract(payload,'$.lease_until')<=?) OR (json_extract(payload,'$.status')='queued' AND (json_extract(payload,'$.deadline')<=? OR (json_extract(payload,'$.attempt')=0 AND json_extract(payload,'$.dispatch_deadline')<=?))) ORDER BY id", &[json!(now),json!(now),json!(now)])?;
            for row in rows {
                // Recovering a parent may fence a child selected in this same pass.
                let mut j = get(db, "jobs", &string(&row, "id")?)?;
                if (j["status"] == "running" && number(&j, "lease_until")? <= now)
                    || (j["status"] == "queued"
                        && (number(&j, "deadline")? <= now || dispatch_expired(&j, now)))
                {
                    let id = string(&j, "id")?;
                    j["status"] = json!(if number(&j, "attempt")? < 2
                        && number(&j, "deadline")? > now
                        && !dispatch_expired(&j, now)
                    {
                        "queued"
                    } else {
                        "failed"
                    });
                    save(db, "jobs", &id, &j)?;
                    reflect_status(db, &j, now)?;
                    if j["status"] == "queued" {
                        outbox(
                            db,
                            &format!("dispatch:{id}:{}", number(&j, "attempt")?),
                            j["kind"].as_str().unwrap_or("agent"),
                            json!({"job_id":id}),
                        )?;
                    }
                    recovered += 1;
                    event(
                        db,
                        "job.recovered",
                        now,
                        json!({"id":id,"status":j["status"],"epoch":j["epoch"]}),
                    )?;
                }
            }
            Ok(json!({"recovered":recovered}))
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}

fn duration<S: SqlStore>(db: &S, job: &Value) -> Result<i64> {
    if job["kind"] == "evaluate" {
        return Ok(120_000);
    }
    Ok(super::model_budgets::for_job(db, job)?.map_or(600_000, |budget| budget.max_execution_ms))
}

fn dispatch_expired(job: &Value, now: i64) -> bool {
    job["attempt"] == 0
        && job["dispatch_deadline"]
            .as_i64()
            .is_some_and(|time| time <= now)
}

pub(super) fn reflect_status<S: SqlStore>(db: &S, job: &Value, now: i64) -> Result<()> {
    status::reflect_status(db, job, now)
}
