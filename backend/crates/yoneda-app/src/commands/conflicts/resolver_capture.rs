use super::support::attach_typed;
use super::*;
/// Complete a resolver's ordinary trusted capture, fencing stale heads before
/// candidate creation and limiting the resulting diff to the approved conflicts.
pub(super) fn complete_resolver_capture<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    now: i64,
) -> Result<Value> {
    if job["payload"]["source_resolution"] != true
        || job["payload"]["capture_subtype"] != "source_changeset"
    {
        return Err(Error::new("FORBIDDEN", "Not a conflict resolver capture"));
    }
    let conflict_id = string(&job["payload"], "conflict_id")?;
    let stored = get(db, "conflicts", &conflict_id)?;
    let mut record = super::source::hydrate(db, &stored)?;
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
    if !target::matches(db, &record)? {
        record["status"] = json!("stale");
        super::source::compact(db, &mut record)?;
        save(db, "conflicts", &conflict_id, &record)?;
        event(
            db,
            "candidate.resolution_fenced",
            now,
            json!({"conflict_id":conflict_id,"reason":"HEAD_MOVED"}),
        )?;
        return Ok(json!({"conflict_id":conflict_id,"status":"stale","reason":"HEAD_MOVED"}));
    }
    super::source::validate_capture(db, job, result, now)?;
    let captured = result["resolver_delta_paths"]
        .as_array()
        .ok_or_else(|| bad("Resolver capture omitted its Git paths"))?;
    if captured.is_empty() {
        return Err(bad("Resolver capture did not change any path"));
    }
    // Any valid path may be edited except protected verification paths under
    // the current policy.
    let policy = repo(db)?["policy"].clone();
    let protected: Vec<&str> = policy["build"]["test_bundle"]["protected_paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let paths = captured
        .iter()
        .map(|path| path.as_str().ok_or_else(|| bad("Invalid resolver path")))
        .collect::<Result<Vec<_>>>()?;
    yoneda_agents_core::resolver_scope::validate_edits(paths.iter().copied(), &protected)?;
    super::super::capture_completion::complete(db, job, result, now)?;
    let cid = string(result, "id")?;
    let mut candidate = get(db, "candidates", &cid)?;
    candidate["conflict_expected_version"] = record["expected_version"].clone();
    candidate["conflict_id"] = record["id"].clone();
    if let Some(id) = record.get("working_branch_id") {
        candidate["working_branch_id"] = id.clone();
    }
    for key in ["integration_manifest", "integration_digest"] {
        if let Some(value) = record["candidate"].get(key) {
            candidate[key] = value.clone();
        }
    }
    let mut evaluator = get(db, "jobs", &format!("evaluate:{cid}"))?;
    evaluator["payload"]["candidate"] = candidate.clone();
    save(db, "jobs", &string(&evaluator, "id")?, &evaluator)?;
    save(db, "candidates", &cid, &candidate)?;
    record["status"] = json!("evaluating");
    record["resolver_candidate_id"] = result["id"].clone();
    // Display-only record of what the resolver actually changed in its merge workspace.
    record["resolver_delta_paths"] = result["resolver_delta_paths"].clone();
    super::source::compact(db, &mut record)?;
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
    record["status"] = json!(if !target::evaluated_matches(db, &record, candidate_id)? {
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
    attach_typed(db, &mut record)?;
    save(db, "conflicts", id, &record)?;
    event(
        db,
        "candidate.resolution_evaluated",
        now,
        json!({"conflict_id":id,"candidate_id":candidate_id,"eligible":eligible}),
    )?;
    Ok(())
}
