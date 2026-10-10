//! Owner retries retain budgets and dependency inputs, fencing every old callback.
use super::*;
use std::collections::BTreeSet;
pub(super) fn retry<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c.get("job_id").is_some() || c.get("_grant").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the repository owner retries team tasks",
        ));
    }
    let rid = string(c, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    if run["mode"] != "collaborate" || run["status"] == "cancelled" || run["status"] == "accepted" {
        return Err(Error::new(
            "INVALID_STATE",
            "This team run cannot be retried",
        ));
    }
    let local = string(c, "task_id")?;
    let id = task_id(&rid, &local);
    let mut task = get(db, "team_tasks", &id)?;
    if task["epoch"] != c["expected_epoch"] || task["revision"] != c["expected_revision"] {
        return Err(Error::new("TASK_MOVED", "Task attempt or revision changed"));
    }
    if task["status"] != "failed" {
        return Err(Error::new(
            "INVALID_STATE",
            "Only terminal failed tasks can be retried",
        ));
    }
    let mut descendants = BTreeSet::from([local.clone()]);
    let tasks = rows(db, "team_tasks", &rid)?;
    if tasks.iter().any(|other| {
        other["id"] != id && other["agent"] == task["agent"] && scheduling::holds_slot(other)
    }) {
        return Err(Error::new(
            "AGENT_BUSY",
            "Wait for this agent's current source task and capture before retrying an earlier task",
        ));
    }
    for _ in 0..tasks.len() {
        for t in &tasks {
            if t["depends_on"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|d| descendants.contains(d))
            {
                descendants.insert(string(t, "task_id")?);
            }
        }
    }
    if tasks.iter().any(|t| {
        t["task_id"] != local
            && descendants.contains(t["task_id"].as_str().unwrap_or_default())
            && (t["status"] != "blocked" || t["epoch"].as_i64().unwrap_or_default() != 0)
    }) {
        return Err(Error::new(
            "DEPENDENTS_STARTED",
            "Retry requires a new run after dependent work has started",
        ));
    }
    let revision = number(&task, "revision")?
        .checked_add(1)
        .ok_or_else(|| bad("Task revision overflow"))?;
    if revision > 3 {
        return Err(Error::new(
            "ATTEMPTS_EXHAUSTED",
            "Team task owner retry budget exhausted",
        ));
    }
    let mut execution = get(db, "executions", &id)?;
    execution["team_task_revision"] = json!(revision);
    execution["status"] = json!("queued");
    execution["error"] = Value::Null;
    execution["transcript"] = Value::Null;
    save_execution(db, &execution, now)?;
    for mut old in run_jobs(db, &rid)? {
        if old["payload"]["execution"]["id"] == id || old["payload"]["candidate"]["execution"] == id
        {
            let old_id = string(&old, "id")?;
            let old_epoch = number(&old, "epoch")?;
            if old_epoch > 0 {
                outbox(
                    db,
                    &format!("stop:{old_id}:{old_epoch}"),
                    "stop",
                    json!({"job_id":old_id,"epoch":old_epoch}),
                )?;
            }
            cancel_job(db, &mut old, now)?;
        }
    }
    for mut candidate in all(db, "candidates")?
        .into_iter()
        .filter(|candidate| candidate["execution"] == id)
    {
        candidate["status"] = json!("cancelled");
        save(db, "candidates", &string(&candidate, "id")?, &candidate)?;
    }
    let jid = format!("job:{id}");
    let mut job = get(db, "jobs", &jid)?;
    let epoch = number(&job, "epoch")?
        .checked_add(1)
        .ok_or_else(|| bad("Attempt epoch overflow"))?;
    job["status"] = json!("queued");
    job["epoch"] = json!(epoch);
    job["attempt"] = json!(0);
    job["lease_until"] = json!(0);
    let dispatch = now
        .checked_add(1_200_000)
        .ok_or_else(|| bad("Dispatch deadline overflow"))?;
    let duration =
        super::super::model_budgets::for_job(db, &job)?.map_or(600_000, |b| b.max_execution_ms);
    job["deadline"] = json!(
        dispatch
            .checked_add(duration)
            .and_then(|n| n.checked_add(120_000))
            .ok_or_else(|| bad("Retry deadline overflow"))?
    );
    job["dispatch_deadline"] = json!(dispatch);
    job["attempt_deadline"] = Value::Null;
    job["runtime_started_at"] = Value::Null;
    job["error"] = Value::Null;
    job["result"] = Value::Null;
    job["payload"]["execution"] = execution;
    if let Some(transport) = run.get("workspace_transport") {
        job["payload"]["workspace_transport"] = transport.clone();
    }
    save(db, "jobs", &jid, &job)?;
    outbox(
        db,
        &format!("dispatch:{jid}:team-retry:{revision}"),
        "agent",
        json!({"job_id":jid}),
    )?;
    task["status"] = json!("queued");
    task["revision"] = json!(revision);
    task["epoch"] = json!(epoch);
    task["error"] = Value::Null;
    task["output"] = Value::Null;
    task["candidate_id"] = Value::Null;
    save(db, "team_tasks", &id, &task)?;
    run["status"] = json!("exploring");
    save(db, "runs", &rid, &run)?;
    event(db, "team.task_retried", now, task.clone())?;
    Ok(task)
}
