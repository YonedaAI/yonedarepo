use super::support::owner;
use super::*;
use std::collections::BTreeSet;
pub(super) fn status<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    owner(c)?;
    let repository = repo(db)?;
    if let Some(id) = c.get("conflict_id").and_then(Value::as_str) {
        return get(db, "conflicts", id);
    }
    let rows = db.query("SELECT payload FROM conflicts ORDER BY id", &[])?;
    let mut conflicts: Vec<Value> = rows
        .iter()
        .map(|row| {
            serde_json::from_str(row["payload"].as_str().unwrap_or_default())
                .map_err(|e| bad(&e.to_string()))
        })
        .collect::<Result<_>>()?;
    for record in &mut conflicts {
        if record["status"] == "clean"
            && let Some(id) = record["refreshed_candidate_id"].as_str()
        {
            let candidate = get(db, "candidates", id)?;
            record["merge_status"] = json!("clean");
            record["evaluation_status"] = candidate["status"].clone();
            if candidate["status"] != "eligible" {
                record["status"] = candidate["status"].clone();
            }
        }
    }
    let existing: BTreeSet<String> = conflicts
        .iter()
        .filter_map(|v| v["candidate_id"].as_str().map(str::to_owned))
        .collect();
    let candidates = db.query("SELECT payload FROM candidates ORDER BY id", &[])?;
    let mut stale_candidates = Vec::new();
    for row in candidates {
        let candidate: Value = serde_json::from_str(row["payload"].as_str().unwrap_or_default())
            .map_err(|e| bad(&e.to_string()))?;
        if candidate["base"]["commit"] != repository["head_commit"]
            && !existing.contains(candidate["id"].as_str().unwrap_or_default())
        {
            stale_candidates.push(json!({"candidate_id":candidate["id"],"candidate_base":candidate["base"]["commit"],"captured_paths":candidate["paths"],"status":candidate["status"],"overlap_status":"not_analyzed"}));
        }
    }
    // The inventory is useful before refresh only if stale candidates are visible
    // alongside recorded conflicts. Their overlap state remains explicitly unknown
    // until a trusted Git refresh computes it.
    let mut inventory = conflicts.clone();
    inventory.extend(stale_candidates.iter().map(|candidate| {
        json!({"kind":"stale_candidate","candidate_id":candidate["candidate_id"],"candidate_base":candidate["candidate_base"],"captured_paths":candidate["captured_paths"],"status":candidate["status"],"overlap_status":"not_analyzed"})
    }));
    let mut overlaps: Vec<Value> = conflicts.iter().filter(|v| v.get("evidence").is_some()).map(|v| json!({"conflict_id":v["id"],"candidate_id":v["candidate_id"],"paths":v["evidence"]["overlapping_paths"],"status":v["status"]})).collect();
    overlaps.extend(stale_candidates.iter().map(|candidate| {
        json!({"candidate_id":candidate["candidate_id"],"paths":[],"status":"not_analyzed"})
    }));
    Ok(
        json!({"conflicts":inventory,"overlaps":overlaps,"head_commit":repository["head_commit"],"version":repository["version"]}),
    )
}
