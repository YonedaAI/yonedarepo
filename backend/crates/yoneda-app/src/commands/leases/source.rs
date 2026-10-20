//! Preparation is operational state: it cannot renew time, inference, or approval authority.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
pub(in crate::commands) fn validate_defer<S: SqlStore>(db: &S, j: &Value) -> Result<()> {
    let run_id = j["payload"]["execution"]["run_id"]
        .as_str()
        .or_else(|| j["payload"]["candidate"]["run_id"].as_str())
        .ok_or_else(|| bad("Missing source run"))?;
    if !["agent", "evaluate"].contains(&j["kind"].as_str().unwrap_or(""))
        || j["payload"]["workspace_transport"] != "api-source-v1"
        || get(db, "runs", run_id)?["workspace_transport"] != "api-source-v1"
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only API source agents and evaluators may await source preparation",
        ));
    }
    let count = j["model_requests"].as_i64().unwrap_or(0);
    let initial = j["model_requests_at_claim"].as_i64().unwrap_or(0);
    let reservations=db.query("SELECT id FROM model_reservations WHERE json_extract(payload,'$.job_id')=? AND json_extract(payload,'$.epoch')=? LIMIT 1",&[j["id"].clone(),j["epoch"].clone()])?;
    if count != initial || !reservations.is_empty() || !j["source_registered"].is_null() {
        return Err(Error::new(
            "INVALID_STATE",
            "Preparation cannot refund model use or a registered source result",
        ));
    }
    Ok(())
}
pub(super) fn claimed(j: &mut Value, now: i64) -> Result<()> {
    if j["payload"]["workspace_transport"] != "api-source-v1" {
        return Ok(());
    }
    let entries = j["source_bindings"]
        .as_object()
        .map(|m| m.values().collect::<Vec<_>>())
        .unwrap_or_default();
    let refs=entries.iter().map(|entry|json!({"workspace_id":entry["binding"]["workspace_id"],"view_digest":entry["binding"]["view_digest"],"epoch":entry["producer_epoch"]})).collect::<Vec<_>>();
    if !refs.is_empty() {
        if j["source_attempts"].is_null() {
            j["source_attempts"] = json!([]);
        }
        j["source_attempts"]
            .as_array_mut()
            .ok_or_else(|| bad("Corrupt source attempt history"))?
            .push(json!({"workspaces":refs}));
    }
    if let Some(old) = j.get("source_registered").filter(|v| !v.is_null()).cloned() {
        let epoch = number(&old["registration"]["binding"], "epoch")?.to_string();
        j["source_registration_history"][epoch] = old;
    }
    j["source_bindings"] = json!({});
    j["source_registered"] = Value::Null;
    j["model_requests_at_claim"] = json!(j["model_requests"].as_i64().unwrap_or(0));
    if !j["source_preparation"].is_null() {
        j["source_preparation"]["epoch"] = j["epoch"].clone();
        j["source_preparation"]["status"] = json!("pending");
        j["source_preparation"]["observed_at"] = json!(now);
    }
    Ok(())
}
pub(super) fn runtime_ready(j: &mut Value, now: i64) {
    if !j["source_preparation"].is_null() {
        j["source_preparation"]["status"] = json!("ready");
        j["source_preparation"]["epoch"] = j["epoch"].clone();
        j["source_preparation"]["observed_at"] = json!(now);
    }
}
pub(in crate::commands) fn deferred(j: &mut Value, now: i64) {
    j["source_preparation"] =
        json!({"status":"pending","stage":"source_preparing","epoch":j["epoch"],"observed_at":now});
}
pub(super) fn terminal(j: &mut Value, now: i64) {
    if j["status"] == "failed"
        && !j["source_preparation"].is_null()
        && j["source_preparation"]["status"] == "pending"
    {
        j["source_preparation"]["status"] = json!("failed");
        j["source_preparation"]["observed_at"] = json!(now);
    }
}
