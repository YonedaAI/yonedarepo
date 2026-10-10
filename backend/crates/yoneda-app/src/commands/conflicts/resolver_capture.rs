use super::support::attach_typed;
use super::*;
use std::collections::BTreeSet;
/// Complete a resolver's ordinary trusted capture, fencing stale heads before
/// candidate creation and limiting the resulting diff to the approved conflicts.
pub(super) fn complete_resolver_capture<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    now: i64,
) -> Result<Value> {
    if job["payload"]["capture_subtype"] != "resolve_conflict" {
        return Err(Error::new("FORBIDDEN", "Not a conflict resolver capture"));
    }
    let conflict_id = string(&job["payload"], "conflict_id")?;
    let mut record = get(db, "conflicts", &conflict_id)?;
    if job["payload"]["expected_head"] != record["head_commit"]
        || job["payload"]["expected_version"] != record["expected_version"]
        || job["payload"]["base"]["commit"] != record["head_commit"]
        || job["payload"]["candidate"]["revision"]["commit"] != record["candidate_revision"]
        || job["payload"]["conflict_paths"] != record["conflict_paths"]
    {
        return Err(Error::new(
            "FENCED",
            "Resolver capture fields differ from the owner-approved conflict",
        ));
    }
    let repository = repo(db)?;
    if repository["head_commit"] != record["head_commit"]
        || repository["version"] != record["expected_version"]
    {
        record["status"] = json!("stale");
        save(db, "conflicts", &conflict_id, &record)?;
        event(
            db,
            "candidate.resolution_fenced",
            now,
            json!({"conflict_id":conflict_id,"reason":"HEAD_MOVED"}),
        )?;
        return Ok(json!({"conflict_id":conflict_id,"status":"stale","reason":"HEAD_MOVED"}));
    }
    let approved: BTreeSet<_> = record["conflict_paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    yoneda_core::conflict_capture::validate_capture_result(
        job,
        &string(job, "id")?,
        number(job, "epoch")?,
        result,
    )?;
    let captured = result["resolver_delta_paths"]
        .as_array()
        .ok_or_else(|| bad("Resolver capture omitted its Git paths"))?;
    for path in captured {
        let path = path.as_str().ok_or_else(|| bad("Invalid resolver path"))?;
        yoneda_core::validate_path(path)?;
        if !approved.contains(path) {
            return Err(Error::new(
                "WRITE_SCOPE",
                "Resolver capture exceeded conflict paths",
            ));
        }
    }
    if captured.is_empty() {
        return Err(bad("Resolver capture did not change a conflict path"));
    }
    super::super::capture_completion::complete(db, job, result, now)?;
    let cid = string(result, "id")?;
    let mut candidate = get(db, "candidates", &cid)?;
    candidate["conflict_expected_version"] = record["expected_version"].clone();
    candidate["conflict_id"] = record["id"].clone();
    save(db, "candidates", &cid, &candidate)?;
    record["status"] = json!("evaluating");
    record["resolver_candidate_id"] = result["id"].clone();
    save(db, "conflicts", &conflict_id, &record)?;
    Ok(json!({"conflict_id":conflict_id,"candidate_id":result["id"],"status":"evaluating"}))
}

/// Record the normal independent evaluation without changing the original evidence.
pub(super) fn resolver_evaluated<S: SqlStore>(
    db: &S,
    candidate_id: &str,
    eligible: bool,
    now: i64,
) -> Result<()> {
    let rows = db.query(
        "SELECT id,payload FROM conflicts WHERE json_extract(payload,'$.resolver_candidate_id')=?",
        &[json!(candidate_id)],
    )?;
    let Some(row) = rows.first() else {
        return Ok(());
    };
    let id = row["id"]
        .as_str()
        .ok_or_else(|| bad("Invalid conflict row"))?;
    let mut record: Value = serde_json::from_str(row["payload"].as_str().unwrap_or_default())
        .map_err(|e| bad(&e.to_string()))?;
    let repository = repo(db)?;
    record["status"] = json!(if repository["head_commit"] != record["head_commit"]
        || repository["version"] != record["expected_version"]
    {
        "stale"
    } else if eligible {
        "resolved"
    } else {
        "unresolved"
    });
    record["resolver_evaluation"] = json!(if eligible { "eligible" } else { "rejected" });
    if record["status"] == "resolved" {
        record["resolver_run_id"] = record["candidate"]["run_id"].clone();
    }
    attach_typed(&mut record)?;
    save(db, "conflicts", id, &record)?;
    event(
        db,
        "candidate.resolution_evaluated",
        now,
        json!({"conflict_id":id,"candidate_id":candidate_id,"eligible":eligible}),
    )?;
    Ok(())
}
