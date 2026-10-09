//! Read-only planners propose assertions. Successful attempt completion freezes the validated DAG.
use super::*;

pub(super) fn start<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    let agent = run["agents"]
        .as_array()
        .and_then(|agents| agents.first())
        .ok_or_else(|| bad("Planning requires a configured agent"))?;
    let rid = string(run, "id")?;
    let id = format!("{rid}:planner");
    let provider = string(agent, "provider")?;
    let harness = &yoneda_core::providers::provider(&provider)?.harness;
    let mut execution = json!({"id":id,"run_id":rid,"harness":harness,"provider":provider,"connection":agent.get("connection").cloned().unwrap_or_else(||json!(provider)),"model":agent["model"],"strategy":"Plan the shared implementation","role":"coding","team_role":"planner","status":"queued","context":run["context"],"base":run["base"],"depth":0,"task":"Inspect the brief, source and prior context. Propose a complementary bounded task DAG with explicit source ownership and an integrator. Do not modify source."});
    if let Some(routing) = agent.get("routing").filter(|v| !v.is_null()) {
        execution["routing"] = routing.clone();
    }
    if run.get("model_budgets").is_some() {
        execution["budget"] = json!({"provider":provider,"model":agent["model"]});
    }
    create(db, "executions", &id, &execution)?;
    node(
        db,
        &id,
        "execution",
        "Plan the shared implementation",
        "platform",
        now,
        execution.clone(),
    )?;
    edge(
        db,
        &rid,
        &id,
        "assigns",
        "read-only planning from the frozen brief, source and roster",
    )?;
    for context in run["context"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        edge(db, context, &id, "provided_to", "frozen planning context")?;
    }
    job(
        db,
        &format!("job:{id}"),
        "agent",
        now,
        json!({"execution":execution,"run":run,"policy":run["policy"],"team_planning":true}),
    )
}
fn planner<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<(Value, Value)> {
    let job = active(db, c, now)?;
    let execution = &job["payload"]["execution"];
    let run = get(db, "runs", &string(execution, "run_id")?)?;
    if job["kind"] != "agent"
        || job["external"] == true
        || execution["team_role"] != "planner"
        || job["payload"]["team_planning"] != true
        || run["team_planning"] != "automatic"
        || run["status"] != "planning"
        || run.get("team_plan").is_some()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the active read-only planner may propose this run's initial team plan",
        ));
    }
    Ok((job, run))
}
pub(super) fn propose<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let (job, run) = planner(db, c, now)?;
    proposals::propose(db, c, &job, &run, now)
}
pub(super) fn finish<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    run: &mut Value,
    now: i64,
) -> Result<bool> {
    let execution = &job["payload"]["execution"];
    if execution["team_role"] != "planner" {
        return Ok(false);
    }
    if result["planning"] != true
        || result["source_unchanged"] != true
        || result.get("workspace").is_some()
    {
        return Err(Error::new(
            "PLANNING_SOURCE_CHANGED",
            "Planner completion requires the trusted read-only source verdict and no capture workspace",
        ));
    }
    if job["payload"]["team_planning"] != true
        || run["status"] != "planning"
        || run["team_planning"] != "automatic"
        || run.get("team_plan").is_some()
    {
        return Err(Error::new(
            "FENCED",
            "The planning stage changed or already finished",
        ));
    }
    let proposal = proposals::current(db, job, run)?.ok_or_else(|| {
        Error::new(
            "MISSING_TEAM_PLAN",
            "Planner completion requires a validated proposal from this exact attempt",
        )
    })?;
    let proposal_id = string(&proposal, "id")?;
    let plan = proposals::validated(&proposal, job, run)?;
    run["team_plan"] = json!(plan);
    run["team_plan_revision"] = json!(1);
    run["team_plan_proposal"] = json!(proposal_id);
    run["execution_count"] = json!(plan.tasks.len() + 2);
    run["status"] = json!("exploring");
    save(db, "runs", &string(run, "id")?, run)?;
    scheduling::start(db, run, now)?;
    edge(
        db,
        &proposal_id,
        &string(run, "id")?,
        "frozen_as",
        "validated initial team plan after successful read-only planning",
    )?;
    event(
        db,
        "team.plan_frozen",
        now,
        json!({"run_id":run["id"],"proposal":proposal_id,"plan_revision":1,"planner_epoch":job["epoch"]}),
    )?;
    Ok(true)
}
pub(super) fn reflect<S: SqlStore>(
    db: &S,
    execution: &Value,
    status: &str,
    now: i64,
) -> Result<()> {
    if execution["team_role"] != "planner" {
        return Ok(());
    }
    let rid = string(execution, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    if run["status"] == "cancelled" || run["status"] == "accepted" || run.get("team_plan").is_some()
    {
        return Ok(());
    }
    run["status"] = json!(if status == "failed" {
        "failed"
    } else {
        "planning"
    });
    if status == "failed" {
        run["planning_error"] = execution["error"].clone();
    }
    save(db, "runs", &rid, &run)?;
    event(
        db,
        "team.planning_status",
        now,
        json!({"run_id":rid,"execution_id":execution["id"],"status":run["status"]}),
    )
}

pub(super) fn context<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let (job, run) = planner(db, c, now)?;
    let proposal = proposals::current(db, &job, &run)?;
    let proposal_id = proposal.as_ref().map(|p| p["id"].clone());
    let versions = proposals::count(db, &job)?;
    Ok(
        json!({"run_id":run["id"],"mode":"collaborate","stage":"planning","goal":run["intent"],"criteria":run["criteria"],"base":run["base"],"agents":run["agents"],"model_budgets":run["model_budgets"],"context":job["payload"]["execution"]["context"],"task":null,"inputs":[],"handoffs":[],"plan_revision":0,"contract":null,"integration_manifest":null,"integration_digest":null,"manifest_record":null,"active_proposal_id":proposal_id,"active_proposal":proposal,"proposal_versions":versions,"max_proposal_versions":proposals::MAX_DRAFTS}),
    )
}
