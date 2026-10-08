use super::*;
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    if c["op"] == "settings" {
        let rows = db.query(
            "SELECT payload FROM workspace_records WHERE id LIKE 'provider:%' ORDER BY id",
            &[],
        )?;
        let mut providers = Vec::new();
        for row in rows {
            let p: Value = serde_json::from_str(
                row["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Corrupt provider"))?,
            )
            .map_err(|e| bad(&e.to_string()))?;
            providers.push(json!({"provider":p["provider"],"model":p["model"],"configured":true,"updated_at":p["updated_at"]}));
        }
        return Ok(json!({"providers":providers}));
    }
    let provider = string(c, "provider")?;
    if !["codex", "claude", "mimo", "zai"].contains(&provider.as_str()) {
        return Err(bad("Unknown provider"));
    }
    let id = format!("provider:{provider}");
    match string(c, "op")?.as_str() {
        "provider_put" => {
            let model = string(c, "model")?;
            if model.len() > 128
                || !model
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b))
                || !c["sealed"].is_object()
                || c["sealed"].to_string().len() > 16384
            {
                return Err(bad("Invalid provider configuration"));
            }
            string(&c["sealed"], "iv")?;
            string(&c["sealed"], "ciphertext")?;
            put(
                db,
                &id,
                &json!({"provider":provider,"model":model,"sealed":c["sealed"],"updated_at":now}),
            )?;
            audit(db, "provider.updated", now, json!({"provider":provider}))?;
            Ok(json!({"provider":provider,"model":model,"configured":true}))
        }
        "provider_secret" => get(db, TABLE, &id),
        "provider_delete" => {
            db.query("DELETE FROM workspace_records WHERE id=?", &[json!(id)])?;
            Ok(json!({"removed":true}))
        }
        _ => Err(bad("Unknown provider operation")),
    }
}
