//! Scoped recovery requests, context and read-only completion.
use super::*;
pub(super) fn request<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = active(db, c, now)?;
    let execution = &job["payload"]["execution"];
    let rid = string(execution, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    if job["kind"] != "agent"
        || job["external"] == true
        || c.get("_grant").is_some()
        || c.get("_reviewer").is_some()
        || run["mode"] != "collaborate"
        || run["autonomy_policy"]["enabled"] != true
        || execution["team_task"].is_null()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only active approved team tasks request coordination",
        ));
    }
    let task = get(db, "team_tasks", &string(execution, "team_task")?)?;
    if task["revision"] != execution["team_task_revision"] {
        return Err(Error::new("FENCED", "Task version changed"));
    }
    let request = string(c, "request_id")?;
    let reason = string(c, "reason")?;
    if request.len() > 80 || reason.len() > 4096 || reason.contains('\0') {
        return Err(bad("Repair request must be bounded text"));
    }
    let id = format!(
        "repair-request:{}:{}:{request}",
        string(execution, "id")?,
        number(&job, "epoch")?
    );
    let data = json!({"run_id":rid,"execution_id":execution["id"],"task_id":task["task_id"],"task_revision":task["revision"],"reason":reason,"authority":"assertion"});
    if let Ok(old) = get(db, "nodes", &id) {
        if old["data"] != data {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Repair request ID reused",
            ));
        }
        return Ok(old);
    }
    node(
        db,
        &id,
        "repair_request",
        &reason,
        &string(execution, "id")?,
        now,
        data,
    )?;
    edge(
        db,
        &id,
        &rid,
        "requests_repair",
        "agent request; coordinator authorization required",
    )?;
    run["coordination_pending"] = json!(true);
    save(db, "runs", &rid, &run)?;
    maybe_start(db, &run, now)?;
    get(db, "nodes", &id)
}

pub(super) fn context<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = active(db, c, now)?;
    let e = &job["payload"]["execution"];
    let run = get(db, "runs", &string(e, "run_id")?)?;
    if job["kind"] != "agent" || job["external"] == true || e["team_role"] != "coordinator" {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the active read-only coordinator may inspect recovery",
        ));
    }
    let tasks = rows(db, "team_tasks", &string(&run, "id")?)?;
    let mut candidates: Vec<Value> = all(db, "candidates")?
        .into_iter()
        .filter(|v| v["run_id"] == run["id"])
        .collect();
    for candidate in &mut candidates {
        if let Some(id) = candidate["evaluation"].as_str() {
            candidate["evaluation_record"] = get(db, "evaluations", id)?;
        }
    }
    let working_branch = run["working_branch_id"]
        .as_str()
        .map(|id| get(db, "working_branches", id))
        .transpose()?;
    let conflicts: Vec<Value> = all(db, "conflicts")?
        .into_iter()
        .filter(|v| v["candidate"]["run_id"] == run["id"])
        .collect();
    Ok(
        json!({"run_id":run["id"],"stage":"coordination","goal":run["intent"],"criteria":run["criteria"],"base":run["base"],"base_version":run.get("working_branch_version").unwrap_or(&run["base_version"]),"working_branch_id":run["working_branch_id"],"working_branch":working_branch,"intent_clarifications":run["intent_clarifications"],"plan_revision":run["team_plan_revision"],"plan":run["team_plan"],"tasks":tasks,"candidates":candidates,"conflicts":conflicts,"autonomy_policy":run["autonomy_policy"],"repair_rounds":run["team_repair_rounds"],"context":run["context"],"model_budgets":run["model_budgets"],"agents":run["agents"],"unavailable_model_groups":run["unavailable_model_groups"],"recovery_instructions":"Use only available original approved model groups. If the integrator group is exhausted, select integrate in repair_team with its exact revision and every affected revision. This assigns the new integrator to your already approved coordinator group, retaining captured specialist handoffs. Reassign affected source task definitions only to available original agents. Capture and freshly check the repaired integration; publication remains owner-controlled."}),
    )
}

pub(super) fn finish<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    run: &mut Value,
    now: i64,
) -> Result<bool> {
    if result["planning"] != true
        || result["source_unchanged"] != true
        || result.get("workspace").is_some()
    {
        return Err(Error::new(
            "PLANNING_SOURCE_CHANGED",
            "Coordinator completion requires trusted read-only source verification",
        ));
    }
    let id = string(&job["payload"]["execution"], "id")?;
    if run["coordinator_execution_id"] != id {
        return Err(Error::new("FENCED", "Coordinator replaced"));
    }
    if run["status"] == "coordinating" && !super::super::super::autonomy::intent_pending(run) {
        run["status"] = json!(if rows(db, "team_tasks", &string(run, "id")?)?
            .iter()
            .any(|t| t["status"] == "failed")
        {
            "failed"
        } else {
            "exploring"
        });
        save(db, "runs", &string(run, "id")?, run)?;
    }
    event(
        db,
        "team.coordinator_finished",
        now,
        json!({"run_id":run["id"],"execution_id":id,"plan_revision":run["team_plan_revision"]}),
    )?;
    if run["coordination_pending"] == true && !super::super::super::autonomy::intent_pending(run) {
        let mut execution = get(db, "executions", &id)?;
        execution["status"] = json!("completed");
        save_execution(db, &execution, now)?;
        maybe_start(db, run, now)?;
        *run = get(db, "runs", &string(run, "id")?)?;
    }
    Ok(true)
}
