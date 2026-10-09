//! Delegation creates isolated alternatives, never a shared checkout or automatic merge.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    agents::{DelegationPolicy, DelegationRequest},
};

pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let parent_job = active(db, &c, now)?;
    if parent_job["kind"] != "agent" || parent_job["external"] == true {
        return Err(Error::new(
            "FORBIDDEN",
            "Delegation tools require a hosted coding attempt",
        ));
    }
    let parent_id = string(&parent_job["payload"]["execution"], "id")?;
    let parent = get(db, "executions", &parent_id)?;
    let run_id = string(&parent, "run_id")?;
    let mut run = get(db, "runs", &run_id)?;
    if run["mode"] == "collaborate" {
        return Err(Error::new(
            "FORBIDDEN",
            "Team tasks do not create comparison subagents",
        ));
    }
    if parent["role"] != "coding" || run["policy"]["build"].is_null() || run["external"] == true {
        return Err(Error::new(
            "FORBIDDEN",
            "Delegation tools require a hosted coding attempt",
        ));
    }
    if c["op"] == "delegation_status" {
        return status(db, &parent, &run);
    }
    let policy: DelegationPolicy = serde_json::from_value(run["delegation"].clone())
        .map_err(|_| Error::new("FORBIDDEN", "Delegation was not enabled for this run"))?;
    if !policy.enabled {
        return Err(Error::new(
            "FORBIDDEN",
            "The owner did not enable delegation for this run",
        ));
    }
    let request: DelegationRequest = serde_json::from_value(json!({
        "request_id":c["request_id"],"task":c["task"],"strategy":c["strategy"]
    }))
    .map_err(|e| bad(&e.to_string()))?;
    request.validate()?;
    let key =
        yoneda_core::fingerprint(&json!({"parent":parent_id,"request_id":request.request_id}))?;
    let id = format!("{run_id}:child:{key}");
    let fingerprint = yoneda_core::fingerprint(
        &serde_json::to_value(&request).map_err(|e| bad(&e.to_string()))?,
    )?;
    if let Ok(existing) = get(db, "executions", &id) {
        if existing["parent_epoch"] != parent_job["epoch"] {
            return Err(Error::new(
                "FENCED",
                "Delegation request belongs to a superseded parent attempt; use a fresh request ID",
            ));
        }
        if existing["delegation_fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "This delegation request ID already names another task",
            ));
        }
        return Ok(
            json!({"execution":existing,"job_id":format!("job:{id}"),"delegation":policy,"replayed":true}),
        );
    }
    let depth = parent["depth"]
        .as_u64()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| bad("Delegation depth overflow"))?;
    let executions = run_executions(db, &run_id)?;
    if depth > u64::from(policy.max_depth) || executions.len() >= policy.max_executions {
        return Err(Error::new(
            "RESOURCE_LIMIT",
            "The run's delegation depth or execution budget is exhausted",
        ));
    }
    let mut child = json!({"id":id,"run_id":run_id,"harness":parent["harness"],
        "provider":parent["provider"],"connection":parent["connection"],"model":parent["model"],
        "strategy":request.strategy,"role":"coding","status":"queued","context":parent["context"],
        "base":parent["base"],"parent_execution":parent_id,"parent_epoch":parent_job["epoch"],
        "depth":depth,"task":request.task,"delegation_request_id":request.request_id,
        "delegation_fingerprint":fingerprint});
    if let Some(budget) = parent.get("budget") {
        child["budget"] = budget.clone();
    }
    if let Some(routing) = parent.get("routing") {
        child["routing"] = routing.clone();
    }
    create(db, "executions", &id, &child)?;
    node(
        db,
        &id,
        "execution",
        &string(&child, "strategy")?,
        "platform",
        now,
        child.clone(),
    )?;
    edge(
        db,
        &parent_id,
        &id,
        "delegates_to",
        "bounded independent alternative on the frozen base",
    )?;
    edge(db, &run_id, &id, "depends_on", "delegated coding attempt")?;
    for context in child["context"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        edge(
            db,
            context,
            &id,
            "provided_to",
            "inherited frozen execution context",
        )?;
    }
    run["execution_count"] = json!(executions.len() + 1);
    save(db, "runs", &run_id, &run)?;
    let job_id = format!("job:{id}");
    job(
        db,
        &job_id,
        "agent",
        now,
        json!({"execution":child,"run":run,"policy":parent_job["payload"]["policy"]}),
    )?;
    event(
        db,
        "execution.delegated",
        now,
        json!({"parent":parent_id,"execution":child,"parent_epoch":parent_job["epoch"]}),
    )?;
    Ok(json!({"execution":child,"job_id":job_id,"delegation":policy,"replayed":false}))
}

fn status<S: SqlStore>(db: &S, parent: &Value, run: &Value) -> Result<Value> {
    let id = string(parent, "id")?;
    let executions = run_executions(db, &string(run, "id")?)?;
    let descendants = descendant_ids(&executions, &id);
    let children: Vec<_> = executions
        .iter()
        .filter(|e| e["parent_execution"] == id)
        .collect();
    let candidates: Vec<_> = all(db, "candidates")?
        .into_iter()
        .filter(|c| {
            c["execution"]
                .as_str()
                .is_some_and(|e| descendants.contains(e))
        })
        .collect();
    let mut context: Vec<Value> = Vec::new();
    if !descendants.is_empty() {
        let placeholders = vec!["?"; descendants.len()].join(",");
        let mut params: Vec<Value> = descendants.iter().map(|id| json!(id)).collect();
        params.extend(descendants.iter().map(|id| json!(id)));
        let sql = format!(
            "SELECT payload FROM nodes WHERE json_extract(payload,'$.author') IN ({placeholders}) OR json_extract(payload,'$.data.producer') IN ({placeholders}) ORDER BY id LIMIT 51"
        );
        for row in db.query(&sql, &params)? {
            context.push(
                serde_json::from_str(
                    row["payload"]
                        .as_str()
                        .ok_or_else(|| bad("Corrupt context"))?,
                )
                .map_err(|e| bad(&e.to_string()))?,
            );
        }
    }
    let context_truncated = context.len() > 50;
    context.truncate(50);
    Ok(
        json!({"execution":parent,"children":children,"candidates":candidates,"context":context,
        "context_truncated":context_truncated,"delegation":run["delegation"],
        "model_requests":run["model_requests"].as_i64().unwrap_or_default(),
        "run_model_request_limit":if run["request_limits"] == "optional-v1" {Value::Null} else {json!(yoneda_core::agents::MAX_RUN_MODEL_REQUESTS)},
        "model_budgets":run.get("model_budgets").cloned().unwrap_or_else(||json!([]))}),
    )
}
