//! Campaign claims require an internal signed grant, scoped to the exact command.
use crate::storage::*;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use yoneda_core::{Error, Result};

pub(super) fn freeze<S: SqlStore>(db: &S, c: &Value, run: &mut Value, now: i64) -> Result<()> {
    let Some(campaign) = c.get("campaign") else {
        if c.get("_campaign_grant").is_some() {
            return Err(bad("Campaign grant without campaign"));
        }
        return Ok(());
    };
    let claims = &c["_campaign_grant"]["claims"];
    let reject = || {
        Error::new(
            "FORBIDDEN",
            "Campaign requires a scoped internal signed approval",
        )
    };
    let key = c["_campaign_signing_key"]
        .as_str()
        .filter(|s| s.len() == 64)
        .ok_or_else(reject)?;
    let signature = hash(&c["_campaign_grant"], "signature", &[64]).map_err(|_| reject())?;
    let bytes = signature
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).map_err(|_| reject())?;
            u8::from_str_radix(pair, 16).map_err(|_| reject())
        })
        .collect::<Result<Vec<_>>>()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).map_err(|_| reject())?;
    mac.update(
        format!(
            "yoneda:campaign-grant:v1\0{}",
            yoneda_core::fingerprint(claims)?
        )
        .as_bytes(),
    );
    mac.verify_slice(&bytes).map_err(|_| reject())?;
    let repository = repo(db)?;
    let mut request = c.clone();
    if let Some(object) = request.as_object_mut() {
        for key in [
            "op",
            "now",
            "_workspace",
            "_campaign_grant",
            "_campaign_signing_key",
        ] {
            object.remove(key);
        }
    }
    if claims["workspace"] != repository["workspace"]
        || claims["repo_id"] != repository["id"]
        || claims["run_id"] != run["id"]
        || claims["campaign"] != *campaign
        || claims["request_digest"] != yoneda_core::fingerprint(&request)?
        || number(claims, "expires")? <= now
        || number(claims, "expires")? > now + 60_000
        || c.get("job_id").is_some()
        || c.get("_grant").is_some()
    {
        return Err(reject());
    }
    if campaign.as_object().is_none_or(|o| o.len() != 5)
        || !["routine", "opus"].contains(&string(campaign, "bucket")?.as_str())
        || number(campaign, "version")? < 1
    {
        return Err(bad("Invalid campaign binding"));
    }
    if let Some(escalation) = c.get("repair_escalation") {
        if escalation["version"] != 1
            || escalation["provider"] != "claude"
            || escalation["model"] != "claude-opus-5-5"
            || escalation["max_executions"] != 1
            || escalation["repair_round"] != 2
            || escalation["after_cheaper_repair_failure"] != true
            || run["autonomy_policy"]["enabled"] != true
            || run["autonomy_policy"]["max_repair_rounds"] != 2
        {
            return Err(bad(
                "Opus escalation must be one preapproved execution in the shared second repair round",
            ));
        }
        let budget: yoneda_core::model_budget::ModelBudget =
            serde_json::from_value(escalation["budget"].clone())
                .map_err(|e| bad(&e.to_string()))?;
        budget.validate_configuration()?;
        if budget.provider != "claude"
            || budget.model != "claude-opus-5-5"
            || budget.max_requests.is_none()
            || budget.spend_limit_microusd.is_none()
            || budget.pricing.is_none()
        {
            return Err(bad("Opus requires its finite original budget"));
        }
        run["model_budgets"]
            .as_array_mut()
            .ok_or_else(|| bad("Missing model budgets"))?
            .push(json!(budget));
        run["repair_escalation"] = escalation.clone();
    }
    let approved: Vec<yoneda_core::model_budget::ModelBudget> =
        serde_json::from_value(claims["model_budgets"].clone()).map_err(|e| bad(&e.to_string()))?;
    if json!(approved) != run["model_budgets"] {
        return Err(reject());
    }
    run["campaign"] = campaign.clone();
    // Retain public provenance, never the transient signature key or raw grant.
    run["campaign_approval_digest"] = json!(yoneda_core::fingerprint(claims)?);
    Ok(())
}

/// B's scheduling hook: call ONLY for a second-round source repair/resolver,
/// never a read-only coordinator. The terminal cheaper-failure marker is set by B.
pub(super) fn claim_escalation<S: SqlStore>(
    db: &S,
    run: &Value,
    execution: &Value,
    now: i64,
) -> Result<Option<Value>> {
    let rid = string(run, "id")?;
    let mut current = get(db, "runs", &rid)?;
    if current["repair_escalation"].is_null()
        || current["team_repair_rounds"] != 2
        || current["team_repair_failure"]["round"] != 1
        || execution["role"] == "coordinator"
        || execution["team_role"] == "coordinator"
        || execution["repair_round"] != 2
        || current["campaign_opus"]["used"] == true
    {
        return Ok(None);
    }
    let failure = &current["team_repair_failure"];
    if failure["model"] == "claude-opus-5-5"
        || (failure["candidate_id"].is_null() && failure["execution_id"].is_null())
    {
        return Ok(None);
    }
    let escalation = current["repair_escalation"].clone();
    let id = string(execution, "id")?;
    current["campaign_opus"] =
        json!({"used":true,"execution_id":id,"repair_round":2,"used_at":now,"failure":failure});
    save(db, "runs", &rid, &current)?;
    event(
        db,
        "campaign.opus_execution_reserved",
        now,
        json!({"run_id":rid,"execution_id":id,"repair_round":2,"failure":current["campaign_opus"]["failure"]}),
    )?;
    Ok(Some(
        json!({"provider":"claude","model":"claude-opus-5-5","harness":"claude","connection":escalation["connection"],"budget":{"provider":"claude","model":"claude-opus-5-5"},"campaign_opus":true,"repair_round":2}),
    ))
}

#[cfg(test)]
mod tests;
