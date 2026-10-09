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
            providers.push(json!({"id":p.get("id").unwrap_or(&p["provider"]),"label":p.get("label").unwrap_or(&p["provider"]),"provider":p["provider"],"model":p["model"],"routing":p["routing"],"configured":true,"updated_at":p["updated_at"],"version":p["version"].as_i64().unwrap_or(0)}));
        }
        return Ok(json!({"providers":providers}));
    }
    let connection = c["connection"]
        .as_str()
        .or(c["provider"].as_str())
        .ok_or_else(|| bad("Missing connection"))?;
    if connection.is_empty()
        || connection.len() > 80
        || !connection
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err(bad("Invalid connection identity"));
    }
    let id = format!("provider:{connection}");
    match string(c, "op")?.as_str() {
        "provider_update" => {
            let old = get(db, TABLE, &id)?;
            if c["expected_version"].as_i64() != Some(old["version"].as_i64().unwrap_or(0)) {
                return Err(Error::new(
                    "STALE_CONNECTION",
                    "Connection changed; reopen its settings before saving",
                ));
            }
            let mut next = old.clone();
            for field in ["label", "model", "routing", "sealed"] {
                if let Some(value) = c.get(field) {
                    next[field] = value.clone();
                }
            }
            next["op"] = json!("provider_put");
            next["connection"] = json!(connection);
            handle(db, &next, now)
        }
        "provider_put" => {
            let provider = string(c, "provider")?;
            yoneda_core::providers::provider(&provider)?;
            let label = c["label"].as_str().unwrap_or(&provider).trim();
            if label.is_empty() || label.len() > 80 || label.chars().any(char::is_control) {
                return Err(bad("Invalid connection label"));
            }
            if get(db, TABLE, &id).is_err()
                && db
                    .query(
                        "SELECT id FROM workspace_records WHERE id LIKE 'provider:%'",
                        &[],
                    )?
                    .len()
                    >= 32
            {
                return Err(bad("Workspace supports up to 32 provider connections"));
            }
            let model = string(c, "model")?;
            yoneda_core::providers::validate_model(&provider, &model)?;
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
            let routing = if let Some(value) = c.get("routing").filter(|v| !v.is_null()) {
                let route: yoneda_core::provider_routing::ProviderRouting =
                    serde_json::from_value(value.clone()).map_err(|e| bad(&e.to_string()))?;
                route.validate(&provider)?;
                serde_json::to_value(route).map_err(|e| bad(&e.to_string()))?
            } else {
                Value::Null
            };
            let version = get(db, TABLE, &id)
                .ok()
                .and_then(|p| p["version"].as_i64())
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| bad("Connection version overflow"))?;
            put(
                db,
                &id,
                &json!({"id":connection,"label":label,"provider":provider,"model":model,"routing":routing,"sealed":c["sealed"],"updated_at":now,"version":version}),
            )?;
            audit(db, "provider.updated", now, json!({"provider":provider}))?;
            Ok(
                json!({"id":connection,"label":label,"provider":provider,"model":model,"routing":routing,"configured":true,"version":version}),
            )
        }
        "provider_secret" => {
            let value = get(db, TABLE, &id)?;
            if c.get("provider").is_some() && value["provider"] != c["provider"] {
                return Err(bad("Provider connection mismatch"));
            }
            Ok(value)
        }
        "provider_delete" => {
            db.query("DELETE FROM workspace_records WHERE id=?", &[json!(id)])?;
            Ok(json!({"removed":true}))
        }
        _ => Err(bad("Unknown provider operation")),
    }
}
