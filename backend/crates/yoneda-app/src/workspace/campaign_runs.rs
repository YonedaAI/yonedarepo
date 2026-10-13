//! Immutable server run bindings. No identity is accepted from a model body.
use super::campaign::{approval, identifier, require};
use super::*;
use crate::storage::{create, number};
pub(super) fn run_key(repo: &str, run: &str) -> String {
    format!("campaign-run:{repo}:{run}")
}
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let repo = identifier(c, "repo_id")?;
    let run = identifier(c, "run_id")?;
    let key = run_key(&repo, &run);
    if c["op"] == "campaign_run_status" {
        return get(db, TABLE, &key);
    }
    let id = identifier(c, "id")?;
    let version = number(c, "version")?;
    let chain = identifier(c, "chain_id")?;
    let bucket = string(c, "bucket")?;
    let purpose = string(c, "purpose")?;
    let current = require(db, &id, now)?;
    let approved = approval(db, &id, version)?;
    if current["version"] != version
        || !approved["repo_ids"]
            .as_array()
            .is_some_and(|ids| ids.contains(&json!(repo)))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Run outside campaign version or repositories",
        ));
    }
    if bucket != "routine" || purpose != "routine" {
        return Err(Error::new(
            "FORBIDDEN",
            "Campaign runs start routine; Opus is only the original one-shot second repair",
        ));
    }
    let escalation = &c["repair_escalation"];
    if !escalation.is_null()
        && (escalation["version"] != 1
            || escalation["provider"] != "claude"
            || escalation["model"] != "claude-opus-5-5"
            || escalation["max_executions"] != 1
            || escalation["repair_round"] != 2
            || escalation["after_cheaper_repair_failure"] != true
            || escalation["budget"]["provider"] != "claude"
            || escalation["budget"]["model"] != "claude-opus-5-5")
    {
        return Err(bad("Invalid original one-shot Opus approval"));
    }
    let access = c.get("access").cloned().unwrap_or_else(|| json!("owner"));
    if ![json!("owner"), json!("reviewer")].contains(&access)
        || (access == "reviewer" && current["reviewer_enabled"] != true)
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Reviewer campaign entry is not enabled",
        ));
    }
    let requested = c["model_budgets"]
        .as_array()
        .ok_or_else(|| bad("Run model budgets required"))?;
    let allowed = approved["model_budgets"]
        .as_array()
        .ok_or_else(|| bad("Corrupt campaign approval"))?;
    if requested.is_empty()
        || requested.iter().any(|b| {
            !allowed.contains(b)
                || (b["model"] == "claude-opus-5-5"
                    && (escalation.is_null() || escalation["budget"] != *b))
                || (access == "reviewer" && b["provider"] == "zai")
        })
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Run model budget differs from frozen campaign approval",
        ));
    }
    let binding = json!({"id":id,"version":version,"repo_id":repo,"run_id":run,"chain_id":chain,"bucket":bucket,"purpose":purpose,"model_budgets":requested,"repair_escalation":c["repair_escalation"],"access":access});
    let rows = db.query(
        "SELECT payload FROM workspace_records WHERE id=?",
        &[json!(key)],
    )?;
    if !rows.is_empty() {
        let old = get(db, TABLE, &key)?;
        if old != binding {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Run campaign binding is immutable",
            ));
        }
        return Ok(old);
    }
    let chain_key = format!("campaign:{id}:chain:{chain}");
    let rows = db.query(
        "SELECT payload FROM workspace_records WHERE id=?",
        &[json!(chain_key)],
    )?;
    if rows.is_empty() {
        create(
            db,
            TABLE,
            &chain_key,
            &json!({"id":chain,"charged_microusd":0,"models":{}}),
        )?;
    }
    create(db, TABLE, &key, &binding)?;
    audit(db, "campaign.run_bound", now, binding.clone())?;
    Ok(binding)
}
