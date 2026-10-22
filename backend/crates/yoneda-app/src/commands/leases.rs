use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
pub(super) mod resume;
pub(super) mod source;
mod status;
pub(super) mod timing;
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
            if j["status"] == "awaiting_intent" {
                return Ok(json!({"already_done":true,"paused":true,"id":id}));
            }
            if j["kind"] == "agent"
                && let Some(run_id) = j["payload"]["execution"]["run_id"].as_str()
            {
                let run = get(db, "runs", run_id)?;
                if run["status"] == "awaiting_intent" {
                    j["status"] = json!("awaiting_intent");
                    save(db, "jobs", &id, &j)?;
                    return Ok(json!({"already_done":true,"paused":true,"id":id}));
                }
                if let Some(cap) = run["autonomy_policy"]["max_concurrent_agents"].as_i64() {
                    let active=db.query("SELECT COUNT(*) AS count FROM jobs WHERE json_extract(payload,'$.kind')='agent' AND json_extract(payload,'$.status')='running' AND json_extract(payload,'$.lease_until')>? AND json_extract(payload,'$.payload.execution.run_id')=? AND id<>?",&[json!(now),json!(run_id),json!(id)])?;
                    if number(&active[0], "count")? >= cap {
                        return Ok(json!({"deferred":true,"id":id,"not_before":now+5000}));
                    }
                }
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
            // Attempt times are observational evidence for stage durations, never authority.
            j["started_at"] = json!(now);
            j["finished_at"] = Value::Null;
            source::claimed(&mut j, now)?;
            j["runtime_started_at"] = Value::Null;
            j["progress"] = Value::Null;
            resume::claimed(&mut j);
            let budget = super::model_budgets::for_job(db, &j)?;
            if let Some(budget) = &budget {
                j["model_budget"] = json!(budget);
            }
            timing::claimed(&mut j, budget.as_ref(), now)?;
            save(db, "jobs", &id, &j)?;
            if j["kind"] == "agent" {
                let eid = string(&j["payload"]["execution"], "id")?;
                let mut e = get(db, "executions", &eid)?;
                e["status"] = json!("running");
                e["started_at"] = json!(now);
                e["finished_at"] = Value::Null;
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
            event(db, "job.started", now, job_event(&j))?;
            Ok(j)
        }
        "check_attempt" => {
            let j = active(db, &c, now)?;
            Ok(json!({"status":j["status"],"deadline":j["attempt_deadline"]}))
        }
        "heartbeat" | "progress" => {
            let mut j = active(db, &c, now)?;
            let id = string(&j, "id")?;
            let budget = super::model_budgets::for_job(db, &j)?;
            if c["progress"]["stage"] == "container_ready" && j["runtime_started_at"].is_null() {
                source::runtime_ready(&mut j, now);
                timing::runtime_ready(&mut j, budget.as_ref(), now)?;
                j["runtime_started_at"] = json!(now);
            }
            let model_active =
                timing::heartbeat(&mut j, budget.as_ref(), timing::supervisor_active(&c), now)?;
            let lease = if j["runtime_started_at"].is_null() {
                (now + 60_000).max(number(&j, "lease_until")?)
            } else {
                now + 60_000
            };
            j["lease_until"] = json!(lease.min(number(&j, "attempt_deadline")?));
            if c.get("progress").is_some() && j["progress"] != c["progress"] {
                j["progress"] = c["progress"].clone();
                let mut data = job_event(&j);
                data["progress"] = j["progress"].clone();
                event(db, "job.progress", now, data)?;
            }
            save(db, "jobs", &id, &j)?;
            Ok(
                json!({"lease_until":j["lease_until"],"attempt_deadline":j["attempt_deadline"],
                "attempt_ceiling_at":j["attempt_ceiling_at"],"model_active":model_active}),
            )
        }
        "fail" => {
            let mut j = active(db, &c, now)?;
            let id = string(&j, "id")?;
            j["status"] = json!(if c["retryable"] == true && number(&j, "attempt")? < 2 {
                "queued"
            } else {
                "failed"
            });
            source::terminal(&mut j, now);
            finished(&mut j, now);
            j["error"] = c["error"].clone();
            resume::failed(&mut j);
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
            let mut data = job_event(&j);
            data["status"] = j["status"].clone();
            data["error"] = j["error"].clone();
            event(db, "job.failed", now, data)?;
            Ok(j)
        }
        "recover" => {
            let mut recovered = 0;
            let rows = db.query("SELECT id FROM jobs WHERE (json_extract(payload,'$.status')='running' AND json_extract(payload,'$.lease_until')<=?) OR (json_extract(payload,'$.status')='queued' AND (json_extract(payload,'$.deadline')<=? OR (json_extract(payload,'$.attempt')=0 AND json_extract(payload,'$.dispatch_deadline')<=?))) ORDER BY id", &[json!(now),json!(now),json!(now)])?;
            for row in rows {
                // Recovering a parent may fence a child selected in this same pass.
                let mut j = get(db, "jobs", &string(&row, "id")?)?;
                let interrupted = j["status"] == "running";
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
                    source::terminal(&mut j, now);
                    finished(&mut j, now);
                    if interrupted {
                        resume::interrupted(&mut j);
                    }
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
                    let mut data = job_event(&j);
                    data["status"] = j["status"].clone();
                    event(db, "job.recovered", now, data)?;
                }
            }
            Ok(json!({"recovered":recovered}))
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
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

fn finished(j: &mut Value, now: i64) {
    if j["status"] == "failed" {
        j["finished_at"] = json!(now);
    }
}

#[cfg(test)]
#[path = "leases/timing_tests.rs"]
mod timing_tests;
