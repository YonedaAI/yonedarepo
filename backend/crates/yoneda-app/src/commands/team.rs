//! Hosted collaboration policy. Every entry point runs in the enclosing ledger transaction.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, team::TeamPlan};
mod capture;
mod evidence;
mod inputs;
mod planning;
mod proposals;
mod retry;
mod scheduling;
mod tools;

pub(super) fn freeze(c: &Value, general: bool) -> Result<Option<TeamPlan>> {
    let mode = c
        .get("mode")
        .map(|m| m.as_str().ok_or_else(|| bad("Run mode must be a string")))
        .transpose()?
        .unwrap_or("compare");
    match mode {
        "compare" if c.get("team").is_none_or(Value::is_null) => Ok(None),
        "compare" => Err(bad("Team configuration requires Build together mode")),
        "collaborate" => {
            if !general || c["delegation"]["enabled"] == true {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Teams require hosted coding and cannot create independent comparison subagents",
                ));
            }
            if c.get("team").is_none_or(Value::is_null) {
                return Ok(None);
            }
            let plan: TeamPlan =
                serde_json::from_value(c["team"].clone()).map_err(|e| bad(&e.to_string()))?;
            plan.validate(c["agents"].as_array().map_or(0, Vec::len))?;
            Ok(Some(plan))
        }
        _ => Err(bad("Choose compare or collaborate run mode")),
    }
}
pub(super) fn start<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    scheduling::start(db, run, now)
}
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    if c["op"] == "team_plan_propose" {
        planning::propose(db, &c, now)
    } else if c["op"] == "retry_team_task" {
        retry::retry(db, &c, now)
    } else {
        tools::handle(db, &c, now)
    }
}
pub(super) fn captured<S: SqlStore>(db: &S, job: &Value, result: &Value, now: i64) -> Result<bool> {
    capture::captured(db, job, result, now)
}
pub(super) fn capture_payload<S: SqlStore>(
    db: &S,
    job: &Value,
    payload: &mut Value,
    now: i64,
) -> Result<()> {
    if job["payload"]["execution"]["team_task"].is_null() {
        return Ok(());
    }
    for key in [
        "team_inputs",
        "team_owned_paths",
        "team_write_paths",
        "integration_manifest",
        "integration_digest",
        "manifest_record",
    ] {
        if let Some(value) = job["payload"].get(key) {
            payload[key] = value.clone();
        }
    }
    reflect(
        db,
        &job["payload"]["execution"],
        "capturing",
        job["epoch"].clone(),
        now,
    )
}
pub(super) fn reflect<S: SqlStore>(
    db: &S,
    e: &Value,
    status: &str,
    epoch: Value,
    now: i64,
) -> Result<()> {
    let Some(id) = e["team_task"].as_str() else {
        return planning::reflect(db, e, status, now);
    };
    let mut task = get(db, "team_tasks", id)?;
    task["status"] = json!(status);
    task["epoch"] = epoch;
    if status == "failed" {
        task["error"] = e["error"].clone();
    }
    save(db, "team_tasks", id, &task)?;
    if status == "failed" {
        let rid = string(e, "run_id")?;
        let mut run = get(db, "runs", &rid)?;
        if run["status"] != "cancelled" && run["status"] != "accepted" {
            run["status"] = json!("failed");
            save(db, "runs", &rid, &run)?;
        }
    }
    event(
        db,
        "team.task_status",
        now,
        json!({"task_id":id,"status":status,"epoch":task["epoch"]}),
    )?;
    if status == "failed" {
        let run = get(db, "runs", &string(e, "run_id")?)?;
        scheduling::wake(db, &run, now)?;
    }
    Ok(())
}
pub(super) fn cancelled<S: SqlStore>(db: &S, run_id: &str, now: i64) -> Result<()> {
    for task in rows(db, "team_tasks", run_id)? {
        let mut task = task;
        if task["status"] != "complete" {
            task["status"] = json!("cancelled");
            save(db, "team_tasks", &string(&task, "id")?, &task)?;
        }
    }
    event(db, "team.cancelled", now, json!({"run_id":run_id}))
}
pub(super) fn validate_candidate<S: SqlStore>(
    db: &S,
    run: &Value,
    candidate: &Value,
) -> Result<()> {
    if run["mode"] != "collaborate" {
        return Ok(());
    }
    let execution = get(db, "executions", &string(candidate, "execution")?)?;
    if execution["team_role"] != "integrator" {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the integrated team result is selectable",
        ));
    }
    let manifest = inputs::manifest(db, run)?;
    if candidate["integration_manifest"] != manifest
        || candidate["integration_digest"] != yoneda_core::fingerprint(&manifest)?
    {
        return Err(Error::new(
            "STALE_INTEGRATION",
            "Candidate no longer includes the exact frozen task outputs",
        ));
    }
    Ok(())
}
fn plan(run: &Value) -> Result<TeamPlan> {
    serde_json::from_value(run["team_plan"].clone()).map_err(|e| bad(&e.to_string()))
}
fn rows<S: SqlStore>(db: &S, table: &str, run: &str) -> Result<Vec<Value>> {
    db.query(
        &format!(
            "SELECT payload FROM {table} WHERE json_extract(payload,'$.run_id')=? ORDER BY id"
        ),
        &[json!(run)],
    )?
    .iter()
    .map(|row| {
        serde_json::from_str(
            row["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt team row"))?,
        )
        .map_err(|e| bad(&e.to_string()))
    })
    .collect()
}
fn task_id(run: &str, local: &str) -> String {
    format!("{run}:task:{local}")
}

pub(super) fn citation_sources<S: SqlStore>(
    db: &S,
    execution: &str,
    epoch: &Value,
    checked: &[Value],
) -> Result<Vec<Value>> {
    evidence::sources(db, execution, epoch, checked)
}

pub(super) fn start_planner<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    planning::start(db, run, now)
}
pub(super) fn finish_planner<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    run: &mut Value,
    now: i64,
) -> Result<bool> {
    planning::finish(db, job, result, run, now)
}
