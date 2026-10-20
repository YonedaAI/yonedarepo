//! Server-derived model bindings are immutable; source rotations require a new alias identity.
use super::*;

/// Retired identities never regain credentials matching an earlier frozen approval.
pub(super) fn assert_not_retired<S: SqlStore>(db: &S, connection: &str) -> Result<()> {
    match get(db, TABLE, &format!("provider-retired:{connection}")) {
        Ok(_) => Err(Error::new(
            "ALIAS_RETIRED",
            "This model alias was removed; refresh its saved provider in Manage Keys before adding this model again",
        )),
        Err(error) if error.code == "NOT_FOUND" => Ok(()),
        Err(error) => Err(error),
    }
}

pub(super) fn create<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let connection = string(c, "connection")?;
    let source_id = string(c, "source_connection")?;
    if source_id.is_empty()
        || source_id.len() > 80
        || !source_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err(bad("Invalid source connection"));
    }
    let source = get(db, TABLE, &format!("provider:{source_id}"))?;
    let source_version = match source.get("version") {
        None => 0,
        Some(value) => value
            .as_i64()
            .filter(|n| (0..=9_007_199_254_740_991).contains(n))
            .ok_or_else(|| bad("Invalid source connection version"))?,
    };
    if c["expected_version"].as_i64() != Some(source_version) {
        return Err(Error::new(
            "STALE_CONNECTION",
            "Source connection changed before alias creation",
        ));
    }
    let provider = string(c, "provider")?;
    let model = string(c, "model")?;
    if source["provider"] != provider {
        return Err(bad("Alias provider differs from source"));
    }
    validate_priced_model(&provider, &model)?;
    let key = format!("provider:{connection}");
    let provenance = json!({"connection":source_id,"version":source_version});
    match get(db, TABLE, &key) {
        Ok(existing) => {
            if existing["alias_source"] != provenance
                || existing["provider"] != provider
                || existing["model"] != model
                || existing["routing"] != source["routing"]
            {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Alias identity is already bound to another connection",
                ));
            }
            return Ok(public(&existing));
        }
        Err(error) if error.code == "NOT_FOUND" => {}
        Err(error) => return Err(error),
    }
    if c["sealed"]["v"] != 2 {
        return Err(bad(
            "Alias credentials require their own connection identity",
        ));
    }
    let mut create = c.clone();
    create["op"] = json!("provider_put");
    create["routing"] = source["routing"].clone();
    super::providers::handle(db, &create, now)?;
    let mut created = get(db, TABLE, &key)?;
    created["alias_source"] = provenance;
    put(db, &key, &created)?;
    audit(
        db,
        "provider.model_alias_created",
        now,
        json!({"connection":connection,"provider":provider,"model":model,"source_connection":source_id,"source_version":source_version}),
    )?;
    Ok(public(&created))
}

fn public(value: &Value) -> Value {
    json!({"id":value["id"],"label":value["label"],"provider":value["provider"],"model":value["model"],"routing":value["routing"],"configured":true,"version":value["version"],"alias_source":value["alias_source"]})
}

fn validate_priced_model(provider: &str, model: &str) -> Result<()> {
    let registry: Vec<Value> = serde_json::from_str(yoneda_agents_core::providers::MANIFEST)
        .map_err(|_| bad("Provider registry unavailable"))?;
    let entry = registry
        .iter()
        .find(|p| p["id"] == provider)
        .and_then(|p| p["models"].as_array())
        .and_then(|models| models.iter().find(|m| m["id"] == model))
        .ok_or_else(|| bad("Alias requires a supported catalog model"))?;
    let price = &entry["conservative_pricing"];
    for field in ["input_microusd_per_million", "output_microusd_per_million"] {
        if price[field]
            .as_i64()
            .is_none_or(|n| !(0..=9_007_199_254_740_991).contains(&n))
        {
            return Err(bad("Alias requires verified catalog pricing"));
        }
    }
    if price["source"].as_str().is_none_or(|s| s.is_empty()) {
        return Err(bad("Alias pricing source required"));
    }
    Ok(())
}
