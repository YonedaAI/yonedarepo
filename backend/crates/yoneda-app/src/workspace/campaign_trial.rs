//! Durable campaign trial approval and one active reservation. Missing starts stay reserved.
use super::campaign::{identifier, key, require};
use super::*;
use crate::storage::create;
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let id = identifier(c, "id")?;
    let run = identifier(c, "run_id")?;
    let receipt_key = format!("campaign-trial:{id}:{run}");
    if c["op"] == "campaign_trial_status" {
        return get(db, TABLE, &receipt_key);
    }
    if c["op"] == "campaign_trial_complete" {
        let mut state = get(db, TABLE, &key(&id))?;
        let mut receipt = get(db, TABLE, &receipt_key)?;
        receipt["status"] = json!("complete");
        put(db, &receipt_key, &receipt)?;
        if state["active_trial"] == run {
            state["active_trial"] = Value::Null;
            put(db, &key(&id), &state)?;
        }
        return Ok(receipt);
    }
    super::spend::require_legacy(db)?;
    let mut state = require(db, &id, now)?;
    let rows = db.query(
        "SELECT payload FROM workspace_records WHERE id=?",
        &[json!(receipt_key)],
    )?;
    if !rows.is_empty() {
        return get(db, TABLE, &receipt_key);
    }
    if !state["active_trial"].is_null() {
        return Err(Error::new(
            "TRIAL_ACTIVE",
            "A campaign trial is already reserved or running",
        ));
    }
    let approval = &c["run_request"];
    if approval["id"] != run
        || approval["campaign"]["id"] != id
        || approval["campaign"]["version"] != state["version"]
        || approval["working_branch_id"] != "campaign-development"
        || approval["mode"] != "collaborate"
        || approval["autonomy_policy"]["enabled"] != true
    {
        return Err(bad(
            "Campaign trial requires the fixed collaborative working-branch approval",
        ));
    }
    let receipt = json!({"run_id":run,"campaign_id":id,"repo_id":c["repo_id"],"status":"reserved","approval":approval,"created_at":now});
    create(db, TABLE, &receipt_key, &receipt)?;
    state["active_trial"] = json!(run);
    put(db, &key(&id), &state)?;
    Ok(receipt)
}
