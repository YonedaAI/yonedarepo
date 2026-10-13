//! Trusted workspace request-counter observations are operational fences, never approvals.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result, agents::MAX_RUN_MODEL_REQUESTS, model_budget::MAX_SAFE_BUDGET_INTEGER,
};

pub(super) fn available(run: &Value, agent: &Value) -> Result<bool> {
    if run["unavailable_model_groups"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|g| g["provider"] == agent["provider"] && g["model"] == agent["model"])
    {
        return Ok(false);
    }
    if run["request_limits"] != "optional-v1"
        && run["model_requests"].as_i64().unwrap_or(0) >= MAX_RUN_MODEL_REQUESTS
    {
        return Ok(false);
    }
    let Some(_) = run.get("model_budgets") else {
        return Ok(true);
    };
    let mut execution = agent.clone();
    execution["budget"] = json!({"provider":agent["provider"],"model":agent["model"]});
    let (_, budget) = super::model_budgets::group(run, &execution)?
        .ok_or_else(|| bad("Missing approved model budget"))?;
    Ok(budget.max_requests.is_none_or(|v| budget.requests < v)
        && budget
            .spend_limit_microusd
            .is_none_or(|v| budget.charged_microusd < v))
}

pub(super) fn coordinator(run: &Value, preferred: usize) -> Result<Option<usize>> {
    let agents = run["agents"]
        .as_array()
        .ok_or_else(|| bad("Missing original roster"))?;
    for index in std::iter::once(preferred).chain(0..agents.len()) {
        if let Some(agent) = agents.get(index)
            && agent["model"] != "claude-opus-5-5"
            && available(run, agent)?
        {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

pub(super) fn require_assignment(run: &Value, index: usize) -> Result<()> {
    // Keep legacy owner repair behavior when no observed operational fence exists.
    if run["unavailable_model_groups"]
        .as_array()
        .is_none_or(Vec::is_empty)
    {
        return Ok(());
    }
    let agent = run["agents"]
        .as_array()
        .and_then(|a| a.get(index))
        .ok_or_else(|| bad("Invalid approved agent index"))?;
    if !available(run, agent)? {
        return Err(Error::new(
            "MODEL_REQUEST_LIMIT",
            "Choose an available group from the original approved roster",
        ));
    }
    Ok(())
}

pub(super) fn observe<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let repository = repo(db)?;
    if c["_workspace"].as_str() != Some(repository["workspace"].as_str().unwrap_or("_admin"))
        || c.get("_grant").is_some()
        || c.get("_reviewer").is_some()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the trusted owning workspace can observe campaign counters",
        ));
    }
    let jid = string(c, "job_id")?;
    let job = get(db, "jobs", &jid)?;
    let execution = get(
        db,
        "executions",
        &string(&job["payload"]["execution"], "id")?,
    )?;
    let rid = string(&execution, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    if ["cancelled", "accepted"].contains(&run["status"].as_str().unwrap_or_default()) {
        return Err(Error::new("FENCED", "This run cannot be reconciled"));
    }
    if job["kind"] != "agent"
        || job["external"] == true
        || run["external"] == true
        || execution["role"] != "coding"
        || execution["provider"] != job["payload"]["execution"]["provider"]
        || execution["model"] != job["payload"]["execution"]["model"]
        || !run["campaign"].is_object()
        || run["campaign_approval_digest"].as_str().is_none()
        || run["campaign"]["id"] != c["campaign_id"]
        || run["campaign"]["version"] != c["campaign_version"]
        || run["campaign"]["chain_id"] != c["chain_id"]
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Observation differs from the authoritative hosted campaign binding",
        ));
    }
    if number(&job, "epoch")? != number(c, "epoch")? {
        return Err(Error::new(
            "FENCED",
            "Observation belongs to a different attempt epoch",
        ));
    }
    let (_, budget) = super::model_budgets::group(&run, &execution)?
        .ok_or_else(|| bad("Campaign requires a frozen model budget"))?;
    let requests = number(c, "requests")?;
    let cap = number(c, "max_requests")?;
    if !(1..=MAX_SAFE_BUDGET_INTEGER).contains(&cap)
        || !(cap..=MAX_SAFE_BUDGET_INTEGER).contains(&requests)
        || budget.max_requests != Some(cap)
        || !job["payload"]["run"]["model_budgets"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|b| {
                b["provider"] == execution["provider"]
                    && b["model"] == execution["model"]
                    && b["max_requests"] == cap
            })
    {
        return Err(bad(
            "Counter does not prove exhaustion of the original group cap",
        ));
    }
    let provider = string(&execution, "provider")?;
    let model = string(&execution, "model")?;
    let group = json!({"provider":provider,"model":model});
    let mut groups = run["unavailable_model_groups"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let observed = groups
        .iter()
        .any(|g| g["provider"] == provider && g["model"] == model);
    let replay = job["status"] == "failed" && job["campaign_model_limit_observed"] == true;
    if job["status"] == "running" {
        active(db, c, now)?;
    } else if !(replay
        || job["status"] == "failed"
            && execution["team_role"] == "coordinator"
            && run["coordinator_execution_id"] == execution["id"])
    {
        return Err(Error::new(
            "FENCED",
            "Only an active attempt or the failed current coordinator can be reconciled",
        ));
    }
    if !observed {
        groups.push(json!({"provider":provider,"model":model,"requests":requests,"max_requests":cap,"campaign_id":c["campaign_id"],"campaign_version":c["campaign_version"],"chain_id":c["chain_id"],"observed_at":now}));
        run["unavailable_model_groups"] = json!(groups);
        run["coordination_pending"] =
            json!(run["mode"] == "collaborate" && run["team_plan"].is_object());
        run["coordination_signal"] =
            json!(format!("model-limit-{}", yoneda_core::fingerprint(&group)?));
        save(db, "runs", &rid, &run)?;
        event(
            db,
            "run.model_group_unavailable",
            now,
            json!({"run_id":rid,"job_id":jid,"group":group,"requests":requests,"max_requests":cap,"authority":"workspace_counter"}),
        )?;
    }
    if !replay {
        if job["status"] == "running" {
            super::leases::handle(
                db,
                json!({"op":"fail","job_id":jid,"epoch":c["epoch"],"retryable":false,"error":{"code":"CAMPAIGN_MODEL_REQUEST_LIMIT","message":"Original shared campaign model allowance exhausted"}}),
                now,
            )?;
            outbox(
                db,
                &format!("stop:{jid}:{}", number(&job, "epoch")?),
                "stop",
                json!({"job_id":jid,"epoch":job["epoch"]}),
            )?;
        }
        let mut stopped = get(db, "jobs", &jid)?;
        stopped["campaign_model_limit_observed"] = json!(true);
        save(db, "jobs", &jid, &stopped)?;
    }
    if !observed && run["mode"] == "collaborate" && run["team_plan"].is_object() {
        super::team::recover_budget(db, &get(db, "runs", &rid)?, now)?;
    }
    Ok(json!({"run":get(db,"runs",&rid)?,"observed":true,"already_observed":observed,"job_id":jid}))
}
