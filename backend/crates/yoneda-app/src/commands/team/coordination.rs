//! Read-only recovery coordinators share the approved roster, source and budget.
use super::*;
#[path = "recovery_evidence.rs"]
mod evidence;
#[path = "coordination_tools.rs"]
mod tools;

pub(super) fn maybe_start<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    if run["mode"] != "collaborate"
        || run["autonomy_policy"]["enabled"] != true
        || super::super::autonomy::intent_pending(run)
        || ["cancelled", "accepted", "awaiting_intent"]
            .contains(&run["status"].as_str().unwrap_or_default())
    {
        return Ok(());
    }
    let latest = evidence::record(db, run, None)?;
    let run = &latest;
    if let Some(current) = run["coordinator_execution_id"].as_str() {
        let previous = get(db, "jobs", &format!("job:{current}"))?;
        let execution = get(db, "executions", current)?;
        if ["queued", "running"].contains(&previous["status"].as_str().unwrap_or_default())
            && execution["status"] != "completed"
        {
            return Ok(());
        }
    }
    let rid = string(run, "id")?;
    let tasks = rows(db, "team_tasks", &rid)?;
    let busy = tasks.iter().filter(|t| scheduling::holds_slot(t)).count();
    let failed = tasks.iter().any(|t| t["status"] == "failed");
    if ((!failed || busy > 0) && run["coordination_pending"] != true)
        || busy
            >= usize::try_from(
                run["autonomy_policy"]["max_concurrent_agents"]
                    .as_u64()
                    .unwrap_or(3),
            )
            .map_err(|_| bad("Invalid concurrency limit"))?
    {
        return Ok(());
    }
    if run["team_repair_rounds"].as_u64().unwrap_or_default()
        >= run["autonomy_policy"]["max_repair_rounds"]
            .as_u64()
            .unwrap_or(2)
            .min(2)
    {
        return Ok(());
    }
    if run["policy"] != run["approved_policy"]
        || run["policy"] != repo(db)?["policy"]
        || json!(yoneda_core::fingerprint(&run["autonomy_policy"])?)
            != run["autonomy_policy_digest"]
    {
        return Ok(());
    }
    let id = format!(
        "{rid}:coordinator:{}:{}:{}",
        number(run, "team_plan_revision")?,
        run["team_repair_rounds"].as_u64().unwrap_or_default(),
        run["intent_clarifications"].as_array().map_or(0, Vec::len)
    );
    let id = if let Some(signal) = run["coordination_signal"].as_str() {
        format!("{id}:{signal}")
    } else {
        id
    };
    let jid = format!("job:{id}");
    if get(db, "jobs", &jid).is_ok() {
        return Ok(());
    }
    if run_executions(db, &rid)?.len()
        >= usize::try_from(
            run["autonomy_policy"]["max_executions"]
                .as_u64()
                .unwrap_or(20),
        )
        .map_err(|_| bad("Invalid execution budget"))?
    {
        return Ok(());
    }
    let plan = plan(run)?;
    let agent = run["agents"]
        .as_array()
        .and_then(|a| a.get(plan.integrator_agent))
        .ok_or_else(|| bad("Missing frozen coordinator agent"))?;
    let provider = string(agent, "provider")?;
    let mut execution = json!({"id":id,"run_id":rid,"team_role":"coordinator","role":"coding","status":"queued","provider":provider,"model":agent["model"],"connection":agent.get("connection").unwrap_or(&agent["provider"]),"harness":yoneda_core::providers::provider(&provider)?.harness,"strategy":"Coordinate approved team recovery","task":"Inspect failure evidence and peer requests. Negotiate contracts, repair the bounded DAG or ask an intent question within the frozen approval. Source is read-only.","context":run["context"],"base":run["base"],"depth":0,"team_plan_revision":run["team_plan_revision"]});
    if let Some(routing) = agent.get("routing").filter(|v| !v.is_null()) {
        execution["routing"] = routing.clone();
    }
    if run.get("model_budgets").is_some() {
        execution["budget"] = json!({"provider":provider,"model":agent["model"]});
    }
    execution["coordination_observed"] = rows(db, "candidates", &rid)?
        .into_iter()
        .filter(|c| c["status"] == "rejected" || c["working_branch_state"] == "stale")
        .map(|c| Ok((string(&c, "id")?, json!(incident(&c)?))))
        .collect::<Result<Value>>()?;
    create(db, "executions", &id, &execution)?;
    node(
        db,
        &id,
        "execution",
        "Read-only recovery coordinator",
        "platform",
        now,
        execution.clone(),
    )?;
    edge(
        db,
        &rid,
        &id,
        "assigns",
        "bounded recovery within the frozen run approval",
    )?;
    let mut payload = json!({"execution":execution,"run":run,"policy":run["policy"],"team_planning":true,"team_coordination":true});
    if let Some(transport) = run.get("workspace_transport") {
        payload["workspace_transport"] = transport.clone();
    }
    job(db, &jid, "agent", now, payload)?;
    let mut latest = get(db, "runs", &rid)?;
    latest["coordination_pending"] = json!(false);
    latest["coordinator_execution_id"] = json!(id);
    latest["execution_count"] = json!(
        number(run, "execution_count")?
            .checked_add(1)
            .ok_or_else(|| bad("Execution count overflow"))?
    );
    latest["status"] = json!("coordinating");
    save(db, "runs", &rid, &latest)?;
    event(
        db,
        "team.coordinator_scheduled",
        now,
        json!({"run_id":rid,"execution_id":id,"plan_revision":run["team_plan_revision"]}),
    )
}

pub(super) fn evaluated<S: SqlStore>(
    db: &S,
    run: &Value,
    candidate: &Value,
    success: bool,
    now: i64,
) -> Result<()> {
    if run["mode"] != "collaborate" || (success && candidate["working_branch_state"] != "stale") {
        return Ok(());
    }
    let execution = get(db, "executions", &string(candidate, "execution")?)?;
    if execution["team_role"] == "integrator" || execution["team_role"] == "conflict_resolver" {
        let mut latest = evidence::record(db, run, Some(candidate))?;
        let signal = incident(candidate)?;
        if let Some(id) = latest["coordinator_execution_id"].as_str() {
            let coordinator = get(db, "executions", id)?;
            let job = get(db, "jobs", &format!("job:{id}"))?;
            if ["queued", "running"].contains(&job["status"].as_str().unwrap_or_default())
                && coordinator["status"] != "completed"
                && coordinator["coordination_observed"][string(candidate, "id")?] == signal
            {
                return Ok(());
            }
        }
        latest["coordination_pending"] = json!(true);
        latest["coordination_candidate"] = candidate["id"].clone();
        latest["coordination_signal"] = json!(signal);
        save(db, "runs", &string(run, "id")?, &latest)?;
        maybe_start(db, &latest, now)?;
    }
    Ok(())
}

fn incident(candidate: &Value) -> Result<String> {
    yoneda_core::fingerprint(
        &json!({"candidate":candidate["id"],"evaluation":candidate["evaluation"],"status":candidate["status"],"working_branch_state":candidate["working_branch_state"],"signal":candidate["coordination_signal"]}),
    )
}

pub(super) fn resume_after_intent<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    let mut latest = get(db, "runs", &string(run, "id")?)?;
    latest["coordination_pending"] = json!(true);
    save(db, "runs", &string(run, "id")?, &latest)?;
    scheduling::wake(db, &latest, now)
}

pub(super) fn request<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    tools::request(db, c, now)
}
pub(super) fn context<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    tools::context(db, c, now)
}
pub(super) fn finish<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    run: &mut Value,
    now: i64,
) -> Result<bool> {
    tools::finish(db, job, result, run, now)
}
