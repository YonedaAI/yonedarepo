//! Project records carry durable dispatch intent until setup reaches a terminal state.
use super::*;

pub(super) fn pending<S: SqlStore>(db: &S, now: i64) -> Result<Value> {
    let owner = account(db)?;
    let rows = db.query("SELECT id,payload FROM workspace_records WHERE id LIKE 'project:%' AND json_extract(payload,'$.status')='provisioning' ORDER BY id LIMIT 100", &[])?;
    let mut active = false;
    let mut projects = Vec::new();
    for row in rows {
        let key = string(&row, "id")?;
        let mut p: Value =
            serde_json::from_str(&string(&row, "payload")?).map_err(|e| bad(&e.to_string()))?;
        let started = p["setup_started_at"].as_i64().unwrap_or(now);
        if now.saturating_sub(started) >= 600_000 {
            p["status"] = json!("failed");
            p["stage"] = json!("failed");
            p["lease_until"] = json!(0);
            p["error_code"] = json!("SETUP_TIMEOUT");
            p["error"] = json!(
                "Repository setup took too long. Retry setup to resume it; existing source is preserved."
            );
            p["updated_at"] = json!(now);
            put(db, &key, &p)?;
            continue;
        }
        if p["setup_started_at"].is_null() {
            // Existing pre-background records start their deadline on first recovery.
            p["setup_started_at"] = json!(started);
            put(db, &key, &p)?;
        }
        active = true;
        if p["lease_until"].as_i64().unwrap_or(0) <= now
            && p["next_dispatch_at"].as_i64().unwrap_or(0) <= now
        {
            projects.push(json!({"id":p["id"],"epoch":p["setup_epoch"].as_u64().unwrap_or(0)}));
        }
    }
    Ok(json!({"workspace":owner["username"],"active":active,"projects":projects}))
}

pub(super) fn sent<S: SqlStore>(db: &S, c: &Value, key: &str, now: i64) -> Result<Value> {
    let mut p = get(db, TABLE, key)?;
    if p["status"] == "provisioning"
        && p["setup_epoch"].as_u64().unwrap_or(0) == c["epoch"].as_u64().unwrap_or(u64::MAX)
    {
        p["next_dispatch_at"] = json!(now.saturating_add(30_000));
        put(db, key, &p)?;
    }
    Ok(p)
}
