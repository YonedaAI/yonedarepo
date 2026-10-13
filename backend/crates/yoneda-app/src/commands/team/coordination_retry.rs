//! A single owner retry resumes read-only coordination without renewing any approval.
use super::*;

pub(super) fn retry<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let repository = repo(db)?;
    if c["_workspace"] != repository["workspace"]
        || c.get("job_id").is_some()
        || c.get("_grant").is_some()
        || c.get("_reviewer").is_some()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the trusted owning workspace can retry coordination",
        ));
    }
    let rid = string(c, "run_id")?;
    let request = string(c, "request_id")?;
    if request.is_empty()
        || request.len() > 80
        || !request
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err(bad("A bounded stable coordination retry ID is required"));
    }
    let mut run = get(db, "runs", &rid)?;
    let fingerprint = yoneda_core::fingerprint(&json!({"request_id":request,"run_id":rid,
        "job":c["expected_coordinator_job"],"epoch":c["expected_epoch"],"commit":c["expected_commit"],
        "version":c["expected_version"],"plan_revision":c["expected_plan_revision"]}))?;
    if let Some(previous) = run.get("coordinator_owner_retry") {
        if previous["request_id"] != request {
            return Err(Error::new(
                "COORDINATION_RETRY_EXHAUSTED",
                "The original run permits one owner coordination retry",
            ));
        }
        if previous["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Coordination retry input changed",
            ));
        }
        return Ok(previous["receipt"].clone());
    }
    let approval: yoneda_core::autonomy::AutonomyPolicy =
        serde_json::from_value(run["autonomy_policy"].clone())
            .map_err(|_| Error::new("FORBIDDEN", "Original bounded autonomy approval required"))?;
    approval.validate()?;
    if !approval.enabled
        || run["mode"] != "collaborate"
        || run["status"] != "failed"
        || super::super::autonomy::intent_pending(&run)
        || !run["campaign"].is_object()
        || run["campaign_approval_digest"].as_str().is_none()
        || run["approved_policy"] != run["policy"]
        || run["policy"] != repository["policy"]
        || run["intent"] != run["autonomy_approval"]["intent"]
        || run["criteria"] != run["autonomy_approval"]["criteria"]
        || run["agents"] != run["autonomy_approval"]["agents"]
        || json!(yoneda_core::fingerprint(&run["autonomy_policy"])?)
            != run["autonomy_policy_digest"]
        || configuration(&run["model_budgets"])?
            != configuration(&run["autonomy_approval"]["model_budgets"])?
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Retry requires the unchanged failed campaign approval and no pending intent",
        ));
    }
    super::super::branches::validate_run_head(db, &run)?;
    if run["base"]["commit"] != c["expected_commit"]
        || run
            .get("working_branch_version")
            .unwrap_or(&run["base_version"])
            != &c["expected_version"]
        || run["team_plan_revision"] != c["expected_plan_revision"]
    {
        return Err(Error::new(
            "HEAD_MOVED",
            "Coordination retry requires the exact head, version and plan",
        ));
    }
    let id = string(&run, "coordinator_execution_id")?;
    let job = get(db, "jobs", &format!("job:{id}"))?;
    let execution = get(db, "executions", &id)?;
    if job["id"] != c["expected_coordinator_job"]
        || job["epoch"] != c["expected_epoch"]
        || job["kind"] != "agent"
        || job["external"] == true
        || !["done", "failed"].contains(&job["status"].as_str().unwrap_or_default())
        || !["completed", "failed"].contains(&execution["status"].as_str().unwrap_or_default())
        || execution["team_role"] != "coordinator"
        || execution["run_id"] != rid
        || job["payload"]["run"]["autonomy_approval"] != run["autonomy_approval"]
        || run_jobs(db, &rid)?
            .iter()
            .any(|j| ["queued", "running"].contains(&j["status"].as_str().unwrap_or_default()))
    {
        return Err(Error::new(
            "FENCED",
            "The expected terminal coordinator changed or work is still active",
        ));
    }
    if run["team_repair_rounds"].as_u64().unwrap_or_default()
        >= u64::from(approval.max_repair_rounds)
        || run_executions(db, &rid)?.len()
            >= usize::try_from(approval.max_executions).map_err(|_| bad("Invalid execution cap"))?
    {
        return Err(Error::new(
            "REPAIR_BUDGET_EXHAUSTED",
            "Original repair or execution envelope exhausted",
        ));
    }
    observe_shared_limits(c, &mut run)?;
    if super::super::budget_availability::coordinator(&run, plan(&run)?.integrator_agent)?.is_none()
    {
        return Err(Error::new(
            "MODEL_REQUEST_LIMIT",
            "No original regular model allowance remains",
        ));
    }
    run["coordination_pending"] = json!(true);
    run["coordination_signal"] = json!(format!("owner-retry-{fingerprint}"));
    save(db, "runs", &rid, &run)?;
    coordination::maybe_start(db, &run, now)?;
    let mut latest = get(db, "runs", &rid)?;
    let next = string(&latest, "coordinator_execution_id")?;
    if next == id || latest["status"] != "coordinating" {
        return Err(Error::new(
            "INVALID_STATE",
            "Coordination retry could not schedule within the original envelope",
        ));
    }
    let receipt = json!({"run_id":rid,"execution_id":next,"job_id":format!("job:{next}"),
        "previous_job":job["id"],"campaign":run["campaign"],"request_id":request,"original_approval":run["campaign_approval_digest"]});
    latest["coordinator_owner_retry"] =
        json!({"request_id":request,"fingerprint":fingerprint,"receipt":receipt});
    save(db, "runs", &rid, &latest)?;
    event(db, "team.coordinator_retry_approved", now, receipt.clone())?;
    Ok(receipt)
}

fn observe_shared_limits(c: &Value, run: &mut Value) -> Result<()> {
    let Some(observations) = c.get("_shared_model_limits") else {
        return Ok(());
    };
    let observations = observations
        .as_array()
        .ok_or_else(|| bad("Invalid shared model observation"))?;
    let agents = run["agents"]
        .as_array()
        .ok_or_else(|| bad("Missing original roster"))?;
    if observations.len() > agents.len() {
        return Err(bad("Too many shared model observations"));
    }
    let budgets: Vec<yoneda_core::model_budget::ModelBudget> =
        serde_json::from_value(run["model_budgets"].clone())
            .map_err(|_| bad("Invalid frozen model budgets"))?;
    let mut groups = run["unavailable_model_groups"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for observed in observations {
        let provider = string(observed, "provider")?;
        let model = string(observed, "model")?;
        if !agents
            .iter()
            .any(|a| a["provider"] == provider && a["model"] == model)
        {
            return Err(Error::new(
                "FORBIDDEN",
                "Shared observation is outside the original roster",
            ));
        }
        let budget = budgets
            .iter()
            .find(|b| b.provider == provider && b.model == model)
            .ok_or_else(|| bad("Observed group has no original budget"))?;
        let requests = number(observed, "requests")?;
        let charged = number(observed, "charged_microusd")?;
        let cap = number(observed, "max_requests")?;
        let spend = number(observed, "spend_limit_microusd")?;
        let maximum = yoneda_core::model_budget::MAX_SAFE_BUDGET_INTEGER;
        if !(0..=maximum).contains(&requests)
            || !(0..=maximum).contains(&charged)
            || budget.max_requests != Some(cap)
            || budget.spend_limit_microusd != Some(spend)
            || (requests < cap && charged < spend)
        {
            return Err(bad(
                "Shared observation does not prove an original model limit",
            ));
        }
        if !groups
            .iter()
            .any(|g| g["provider"] == provider && g["model"] == model)
        {
            groups.push(json!({"provider":provider,"model":model,"requests":requests,"max_requests":cap,
                "charged_microusd":charged,"spend_limit_microusd":spend,"authority":"workspace_observation"}));
        }
    }
    run["unavailable_model_groups"] = json!(groups);
    Ok(())
}

fn configuration(value: &Value) -> Result<Value> {
    let mut budgets = value
        .as_array()
        .cloned()
        .ok_or_else(|| bad("Missing frozen model budgets"))?;
    for budget in &mut budgets {
        let object = budget
            .as_object_mut()
            .ok_or_else(|| bad("Invalid frozen model budget"))?;
        object.remove("requests");
        object.remove("charged_microusd");
    }
    Ok(json!(budgets))
}
