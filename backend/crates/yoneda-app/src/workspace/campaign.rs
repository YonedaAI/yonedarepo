//! Versioned campaign approvals, separate from historical workspace/trial spend.
use super::*;
use crate::storage::{create, number};
use yoneda_core::model_budget::ModelBudget;

pub(super) fn key(id: &str) -> String {
    format!("campaign:{id}")
}
pub(super) fn identifier(value: &Value, field: &str) -> Result<String> {
    let id = string(value, field)?;
    if !(1..=100).contains(&id.len())
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err(bad("Invalid campaign identifier"));
    }
    Ok(id)
}
pub(super) fn approval<S: SqlStore>(db: &S, id: &str, version: i64) -> Result<Value> {
    get(db, TABLE, &format!("campaign:{id}:approval:{version}"))
}
pub(super) fn require<S: SqlStore>(db: &S, id: &str, now: i64) -> Result<Value> {
    let campaign = get(db, TABLE, &key(id))?;
    if campaign["enabled"] != true || number(&campaign, "expires")? <= now {
        return Err(Error::new(
            "CAMPAIGN_DISABLED",
            "Campaign is disabled or expired",
        ));
    }
    if !super::reviewer::valid(db, now)? {
        return Err(Error::new("REVIEWER_EXPIRED", "Reviewer access expired"));
    }
    Ok(campaign)
}
fn validate(value: &Value, now: i64) -> Result<()> {
    let limit = number(value, "limit_microusd")?;
    let chain = number(value, "chain_limit_microusd")?;
    if !(1..=50_000_000).contains(&limit)
        || !(1..=limit).contains(&chain)
        || number(value, "expires")? <= now
    {
        return Err(bad("Invalid campaign ceilings or expiration"));
    }
    let mut sum = 0_i64;
    for bucket in ["routine", "opus", "reserve"] {
        let amount = number(&value["buckets"], bucket)?;
        if !(0..=limit).contains(&amount) {
            return Err(bad("Invalid campaign bucket"));
        }
        sum = sum
            .checked_add(amount)
            .ok_or_else(|| bad("Campaign ceiling overflow"))?;
    }
    if sum != limit || value["buckets"].as_object().is_none_or(|b| b.len() != 3) {
        return Err(bad("Campaign buckets must exactly partition the ceiling"));
    }
    if !["owner", "reviewer"].contains(&string(value, "audience")?.as_str()) {
        return Err(bad("Invalid campaign audience"));
    }
    let repos = value["repo_ids"]
        .as_array()
        .ok_or_else(|| bad("Campaign repositories required"))?;
    if repos.is_empty() || repos.len() > 24 {
        return Err(bad("Invalid campaign repositories"));
    }
    let mut repository_ids = std::collections::BTreeSet::new();
    for repo in repos {
        if !repository_ids.insert(identifier(&json!({"id":repo}), "id")?) {
            return Err(bad("Campaign repositories must be unique"));
        }
    }
    let budgets: Vec<ModelBudget> =
        serde_json::from_value(value["model_budgets"].clone()).map_err(|e| bad(&e.to_string()))?;
    if budgets.is_empty() || budgets.len() > 4 {
        return Err(bad("Campaign model approvals required"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for budget in budgets {
        budget.validate_configuration()?;
        if budget.max_requests.is_none()
            || budget.pricing.is_none()
            || budget.spend_limit_microusd.is_none()
            || budget.spend_limit_microusd.is_some_and(|v| v > chain)
            || !seen.insert((budget.provider.clone(), budget.model.clone()))
        {
            return Err(bad(
                "Campaign models need unique bounded requests, spend and pricing",
            ));
        }
        let floors = match (budget.provider.as_str(), budget.model.as_str()) {
            ("zai", "glm-5.3-flash") => (150_000, 500_000),
            ("codex", "gpt-5.6-luna") => (250_000, 1_200_000),
            ("claude", "claude-sonnet-5-5") => (4_000_000, 10_000_000),
            ("claude", "claude-opus-5-5") => (8_000_000, 20_000_000),
            _ => return Err(Error::new("FORBIDDEN", "Model outside campaign approval")),
        };
        if budget.pricing.as_ref().is_none_or(|p| {
            p.input_microusd_per_million < floors.0 || p.output_microusd_per_million < floors.1
        }) {
            return Err(bad(
                "Campaign pricing must cover current conservative provider rates",
            ));
        }
        if !matches!(
            (budget.provider.as_str(), budget.model.as_str()),
            ("codex", "gpt-5.6-luna")
                | ("zai", "glm-5.3-flash")
                | ("claude", "claude-sonnet-5-5")
                | ("claude", "claude-opus-5-5")
        ) || value["audience"] == "reviewer" && budget.provider == "zai"
        {
            return Err(Error::new(
                "FORBIDDEN",
                "Model outside campaign approval; Coding Plan is owner only",
            ));
        }
    }
    Ok(())
}
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c["op"] == "reviewer_campaign_status" {
        let rows = db.query(
            "SELECT payload FROM workspace_records WHERE id='reviewer_campaign'",
            &[],
        )?;
        if rows.is_empty() {
            return Ok(Value::Null);
        }
        let pointer = get(db, TABLE, "reviewer_campaign")?;
        let state = get(db, TABLE, &key(&string(&pointer, "id")?))?;
        let approved = approval(db, &string(&pointer, "id")?, number(&state, "version")?)?;
        return Ok(json!({"campaign":state,"approval":approved}));
    }
    let id = identifier(c, "id")?;
    let k = key(&id);
    match string(c, "op")?.as_str() {
        "campaign_status" => {
            let mut state = get(db, TABLE, &k)?;
            state["approval"] = approval(db, &id, number(&state, "version")?)?;
            let prefix = format!("campaign:{id}:chain:");
            let rows = db.query(
                "SELECT payload FROM workspace_records WHERE substr(id,1,?)=? ORDER BY id",
                &[json!(prefix.len()), json!(prefix)],
            )?;
            let chains: Vec<Value> = rows
                .iter()
                .map(|r| {
                    serde_json::from_str(
                        r["payload"]
                            .as_str()
                            .ok_or_else(|| bad("Corrupt campaign chain"))?,
                    )
                    .map_err(|e| bad(&e.to_string()))
                })
                .collect::<Result<_>>()?;
            state["campaign"] = state.clone();
            state["chains"] = json!(chains);
            Ok(state)
        }
        "campaign_configure" => {
            account(db)?;
            let value = &c["approval"];
            validate(value, now)?;
            let version = number(value, "version")?;
            let expected = number(c, "expected_version")?;
            if !(1..=1000).contains(&version) {
                return Err(bad("Invalid campaign approval version"));
            }
            let existing = db.query(
                "SELECT payload FROM workspace_records WHERE id=?",
                &[json!(k)],
            )?;
            let mut state = if existing.is_empty() {
                if expected != 0 || version != 1 {
                    return Err(Error::new(
                        "STALE_VERSION",
                        "New campaign requires version one",
                    ));
                }
                json!({"id":id,"version":0,"revision":0,"enabled":false,"expires":value["expires"],"limit_microusd":value["limit_microusd"],"buckets":value["buckets"],"charged_microusd":0,"charged":{"routine":0,"opus":0,"reserve":0}})
            } else {
                get(db, TABLE, &k)?
            };
            let old = number(&state, "version")?;
            if version <= old {
                if approval(db, &id, version)? != *value {
                    return Err(Error::new(
                        "IDEMPOTENCY_CONFLICT",
                        "Campaign approval is immutable",
                    ));
                }
                return Ok(state);
            }
            if expected != old
                || version != old + 1
                || state["enabled"] == true
                || !state["active_trial"].is_null()
            {
                return Err(Error::new(
                    "STALE_VERSION",
                    "Disable campaign before configuring its next version",
                ));
            }
            if old > 0 {
                let prior = approval(db, &id, old)?;
                for field in [
                    "limit_microusd",
                    "chain_limit_microusd",
                    "buckets",
                    "expires",
                    "audience",
                ] {
                    if prior[field] != value[field] {
                        return Err(Error::new(
                            "IDEMPOTENCY_CONFLICT",
                            "Campaign identity and ceilings cannot be reinterpreted",
                        ));
                    }
                }
                // A new approval may change repository scope. Prior approvals and
                // bindings stay immutable; aggregate, bucket and chain charges stay in state.
            }
            create(
                db,
                TABLE,
                &format!("campaign:{id}:approval:{version}"),
                value,
            )?;
            state["version"] = json!(version);
            state["revision"] = json!(number(&state, "revision")? + 1);
            put(db, &k, &state)?;
            if value["profile"] == "reviewer-event-booking-v1" {
                put(db, "reviewer_campaign", &json!({"id":id}))?;
            }
            audit(
                db,
                "campaign.configured",
                now,
                json!({"id":id,"version":version}),
            )?;
            Ok(state)
        }
        "reviewer_campaign_enable" | "campaign_enable" | "campaign_disable" => {
            let mut state = get(db, TABLE, &k)?;
            let enabled = c["op"] != "campaign_disable";
            if number(c, "expected_version")? != number(&state, "version")?
                || number(c, "expected_revision")? != number(&state, "revision")?
            {
                return Err(Error::new(
                    "STALE_VERSION",
                    "Campaign lifecycle revision changed",
                ));
            }
            if enabled && number(&state, "expires")? <= now {
                return Err(bad("Campaign expired"));
            }
            if enabled && string(c, "local_gate_receipt")?.trim().is_empty() {
                return Err(bad("Successful local gate receipt required"));
            }
            state["enabled"] = json!(enabled);
            if c["op"] == "reviewer_campaign_enable" {
                state["reviewer_enabled"] = json!(true);
                state["glm_evidence_run_id"] = json!(identifier(c, "glm_evidence_run_id")?);
            }
            if !enabled {
                state["reviewer_enabled"] = json!(false);
            }
            state["revision"] = json!(number(&state, "revision")? + 1);
            put(db, &k, &state)?;
            audit(
                db,
                if enabled {
                    "campaign.enabled"
                } else {
                    "campaign.disabled"
                },
                now,
                json!({"id":id,"version":state["version"],"revision":state["revision"]}),
            )?;
            Ok(state)
        }
        _ => Err(bad("Unknown campaign lifecycle operation")),
    }
}

#[cfg(test)]
mod tests;
