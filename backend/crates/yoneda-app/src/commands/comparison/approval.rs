use super::*;
use std::collections::{BTreeMap, BTreeSet};
use yoneda_agents_core::model_budget::ModelBudget;

pub(in crate::commands) fn freeze(c: &Value, run: &mut Value) -> Result<()> {
    if c.get("comparison").is_none() {
        return Ok(());
    }
    if c["comparison"] != json!({"version":1})
        || !hosted(run)
        || run["delegation"]["enabled"] == true
        || run["adaptive_team"].is_object()
        || run["team_plan"].is_object()
        || run["campaign"].is_object()
    {
        return Err(bad(
            "Comparison v1 requires two fixed builders without delegation, team or campaign",
        ));
    }
    let request = c["request_id"]
        .as_str()
        .unwrap_or(run["id"].as_str().unwrap_or(""))
        .to_owned();
    let policy = run["policy"].clone();
    install(c, run, &request, false, &policy)
}
fn reviewer(c: &Value) -> Result<Value> {
    let mut r = c["_comparison_reviewer"].clone();
    let p = string(&r, "provider")?;
    let model = string(&r, "model")?;
    let catalog = yoneda_agents_core::providers::provider(&p)?;
    if !catalog
        .models
        .iter()
        .any(|m| m.id == model && m.auto_seed_eligible)
        || !r["reasoning_effort"].is_null()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Reviewer Auto requires an already validated model",
        ));
    }
    string(&r, "connection")?;
    let allowed = [
        "provider",
        "model",
        "connection",
        "routing",
        "version",
        "reasoning_effort",
    ];
    r.as_object_mut()
        .ok_or_else(|| bad("Invalid reviewer identity"))?
        .retain(|k, _| allowed.contains(&k.as_str()));
    Ok(r)
}
fn install(c: &Value, run: &mut Value, request: &str, legacy: bool, policy: &Value) -> Result<()> {
    let reviewer = reviewer(c)?;
    let mut new_budget: ModelBudget =
        serde_json::from_value(c["_comparison_reviewer_budget"].clone())
            .map_err(|e| bad(&e.to_string()))?;
    new_budget.validate_configuration()?;
    if json!(new_budget.provider) != reviewer["provider"]
        || json!(new_budget.model) != reviewer["model"]
        || new_budget.pricing.is_none()
        || new_budget.spend_limit_microusd.is_none()
    {
        return Err(bad("Reviewer requires exact finite priced budget"));
    }
    let mut budgets = run["model_budgets"].clone();
    if legacy {
        let values = budgets
            .as_array()
            .ok_or_else(|| bad("Legacy extension needs original budgets"))?;
        let mut groups = BTreeMap::new();
        for value in values {
            let mut b: ModelBudget =
                serde_json::from_value(value.clone()).map_err(|e| bad(&e.to_string()))?;
            b.requests = 0;
            b.charged_microusd = 0;
            b.max_requests = Some(144);
            if let Some(current) = yoneda_agents_core::providers::provider(&b.provider)?
                .models
                .iter()
                .find(|m| m.id == b.model)
                .and_then(|m| m.conservative_pricing.as_ref())
                && let Some(price) = b.pricing.as_mut()
            {
                price.input_microusd_per_million = price
                    .input_microusd_per_million
                    .max(current.input_microusd_per_million);
                price.output_microusd_per_million = price
                    .output_microusd_per_million
                    .max(current.output_microusd_per_million);
            }
            if b.pricing.is_none() || b.spend_limit_microusd.is_none() {
                return Err(bad(
                    "Legacy extension requires priced finite original budgets",
                ));
            }
            b.validate_configuration()?;
            groups.insert((b.provider.clone(), b.model.clone()), json!(b));
        }
        let key = (new_budget.provider.clone(), new_budget.model.clone());
        groups.entry(key).or_insert_with(|| {
            new_budget.max_requests = Some(36);
            json!(new_budget)
        });
        budgets = json!(groups.into_values().collect::<Vec<_>>());
    }
    let identities = run["agents"]
        .as_array()
        .ok_or_else(|| bad("Missing builders"))?
        .iter()
        .chain(std::iter::once(&reviewer))
        .map(|a| Ok((string(a, "provider")?, string(a, "model")?)))
        .collect::<Result<BTreeSet<_>>>()?;
    let mut keys = BTreeSet::new();
    for b in budgets.as_array().ok_or_else(|| bad("Missing budgets"))? {
        let budget: ModelBudget =
            serde_json::from_value(b.clone()).map_err(|e| bad(&e.to_string()))?;
        budget.validate_configuration()?;
        if budget.max_requests.is_none()
            || budget.spend_limit_microusd.is_none()
            || budget.pricing.is_none()
            || !keys.insert((budget.provider.clone(), budget.model.clone()))
        {
            return Err(bad("Comparison requires unique finite priced groups"));
        }
    }
    if keys != identities {
        return Err(bad(
            "Comparison budgets must exactly match builders and reviewer",
        ));
    }
    let id = format!("comparison-approval:{}:{request}", string(run, "id")?);
    let mut approval = json!({"id":id,"request_id":request,"version":1,"builders":run["agents"],"reviewer":reviewer,"intent":run["intent"],"criteria":run["criteria"],"policy":policy,"original_policy":run["policy"],"policy_digest":yoneda_agents_core::fingerprint(policy)? ,"context":run["context"],"context_records":run["context_records"],"base":run["base"],"branch_id":run["working_branch_id"],"original_branch_version":run["working_branch_version"],"branch_version":if legacy {&c["expected_working_version"]}else{&run["working_branch_version"]},"working_commit":if legacy {&c["expected_working_commit"]}else{&run["base"]["commit"]},"source_scope":"project","max_repair_rounds":2,"max_logical_executions":7,"max_review_requests":12,"budget_scope":if legacy {"comparison_approval"} else {"run"},"model_budget_configs":yoneda_agents_core::comparison::configurations(&budgets)?});
    approval["digest"] = json!(yoneda_agents_core::fingerprint(&approval)?);
    run["comparison"] = json!({"version":1,"status":"building","round":0,"approval":approval,"review_requests_by_round":[0,0,0],"model_requests":0,"selected_candidate_id":null,"latest_review_id":null,"latest_review":null,"selection_version":0,"review_execution_id":null});
    run["comparison"]["approved_policy"] = policy.clone();
    if legacy {
        run["comparison"]["model_budgets"] = budgets;
        run["comparison"]["workspace_spend"] = json!({"version":1});
    }
    Ok(())
}
pub(in crate::commands) fn validate(run: &Value) -> Result<()> {
    yoneda_agents_core::comparison::validate_approval(run)
}
fn legacy_roots_only<S: SqlStore>(db: &S, run: &Value) -> Result<bool> {
    if run["delegation"]["enabled"] == true {
        let policy: yoneda_agents_core::agents::DelegationPolicy =
            serde_json::from_value(run["delegation"].clone()).map_err(|e| bad(&e.to_string()))?;
        policy.validate(2)?;
        if policy.max_executions > 2 {
            return Ok(false);
        }
    }
    let rid = string(run, "id")?;
    let executions = run_executions(db, &rid)?;
    Ok(executions.len() == 2
        && (1..=2).all(|index| {
            executions.iter().any(|e| {
                e["id"] == format!("{rid}:agent-{index}")
                    && e["role"] == "coding"
                    && e["parent_execution"].is_null()
                    && e["depth"].as_i64().unwrap_or(0) == 0
            })
        }))
}
pub(in crate::commands) fn approve<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    owner(c)?;
    let rid = string(c, "run_id")?;
    let request = string(c, "request_id")?;
    let mut run = get(db, "runs", &rid)?;
    let fp = fingerprint(c)?;
    if run["comparison"]["approval"]["request_id"] == request {
        if run["comparison"]["approval_fingerprint"] != fp {
            return Err(Error::new("IDEMPOTENCY_CONFLICT", "Approval input changed"));
        }
        return Ok(run["comparison"]["approval_receipt"].clone());
    }
    if !hosted(&run)
        || run["comparison"]["approval"].is_object()
        || run["campaign"].is_object()
        || !legacy_roots_only(db, &run)?
        || ["cancelled", "accepted"]
            .iter()
            .any(|s| run["status"] == *s)
        || pending(db, &rid, None)?
    {
        return Err(Error::new(
            "INVALID_STATE",
            "Only a terminal ordinary two-builder comparison can be additionally approved",
        ));
    }
    selection::guards(db, c, &run)?;
    let current = repo(db)?["policy"].clone();
    install(c, &mut run, &request, true, &current)?;
    run["comparison"]["approval_fingerprint"] = json!(fp);
    persist(db, &run, now)?;
    wake(db, &rid, now)?;
    run = get(db, "runs", &rid)?;
    let receipt = json!({"run_id":rid,"comparison":view(&run)});
    run["comparison"]["approval_receipt"] = receipt.clone();
    persist(db, &run, now)?;
    event(
        db,
        "comparison.approved",
        now,
        json!({"run_id":rid,"approval_id":run["comparison"]["approval"]["id"]}),
    )?;
    Ok(receipt)
}
pub(in crate::commands) fn read<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let run = get(db, "runs", &string(c, "run_id")?)?;
    validate(&run)?;
    let a = &run["comparison"]["approval"];
    if c["approval_id"] != a["id"] {
        return Err(Error::new("FENCED", "Comparison approval changed"));
    }
    Ok(
        json!({"id":a["id"],"digest":a["digest"],"version":1,"reviewer":a["reviewer"],"builders":a["builders"],"model_budgets":budget_values(&run,None)?,"workspace_spend":if a["budget_scope"]=="comparison_approval" {&run["comparison"]["workspace_spend"]} else {&run["workspace_spend"]},"comparison":{"status":run["comparison"]["status"],"round":run["comparison"]["round"],"review_requests_by_round":run["comparison"]["review_requests_by_round"],"max_review_requests":12}}),
    )
}
