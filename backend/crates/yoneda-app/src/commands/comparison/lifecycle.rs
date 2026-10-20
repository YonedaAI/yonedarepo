use super::*;
pub(in crate::commands) fn wake<S: SqlStore>(db: &S, rid: &str, now: i64) -> Result<()> {
    let mut run = get(db, "runs", rid)?;
    if !run["comparison"]["approval"].is_object()
        || ["cancelled", "accepted"]
            .iter()
            .any(|s| run["status"] == *s)
        || super::super::autonomy::intent_pending(&run)
    {
        return Ok(());
    }
    validate(&run)?;
    if pending(db, rid, None)? {
        if run["comparison"]["status"] != "reviewing" && run["comparison"]["status"] != "repairing"
        {
            run["comparison"]["status"] =
                json!(if run_jobs(db, rid)?.iter().any(|j| j["kind"] == "evaluate"
                    && ["queued", "running"].iter().any(|s| j["status"] == *s))
                {
                    "checking"
                } else {
                    "building"
                });
            run["status"] = json!("exploring");
            persist(db, &run, now)?;
        }
        return Ok(());
    }
    if repo(db)?["policy"] != run["comparison"]["approval"]["policy"] {
        run["comparison"]["status"] = json!("stale");
        run["status"] = json!("ready");
        return persist(db, &run, now);
    }
    if ["selected", "needs_attention", "stale"]
        .iter()
        .any(|s| run["comparison"]["status"] == *s)
    {
        return Ok(());
    }
    if let Some(id) = run["comparison"]["review_execution_id"].as_str() {
        let e = get(db, "executions", id)?;
        let round = e["comparison_round"].as_i64().unwrap_or(-1);
        if round == run["comparison"]["round"].as_i64().unwrap_or(0) {
            if e["comparison_finish_verified"] == true && !e["comparison_submission"].is_null() {
                return submission::apply(db, &mut run, &e, now);
            }
            run["comparison"]["status"] = json!("needs_attention");
            run["status"] = json!("ready");
            return persist(db, &run, now);
        }
    }
    let manifest = manifest::current(db, &run)?;
    let candidates = manifest["candidates"]
        .as_array()
        .ok_or_else(|| bad("Missing comparison candidate manifest"))?;
    let mut has_checked_result = false;
    for entry in candidates {
        let candidate = get(db, "candidates", &string(entry, "candidate_id")?)?;
        if manifest::checked(db, &run, &candidate).is_ok() {
            has_checked_result = true;
            break;
        }
    }
    // Pending capture/evaluation and existing reviews are handled above. A new
    // review requires independently checked source, not merely terminal jobs.
    if !has_checked_result {
        let reason = json!({"code":"NO_CHECKED_RESULTS","authority":"platform","message":"Review skipped — no checked results"});
        run["comparison"]["status"] = json!("needs_attention");
        run["comparison"]["reviewer_status"] = json!("skipped");
        run["comparison"]["review_skip_reason"] = reason.clone();
        run["status"] = json!("failed");
        persist(db, &run, now)?;
        event(
            db,
            "comparison.review_skipped",
            now,
            json!({"run_id":rid,"round":run["comparison"]["round"],"reason":reason}),
        )?;
        return Ok(());
    }
    let recovery = &run["comparison"]["verification_recovery"];
    if recovery["version"] == 1
        && recovery["automatic_review"] == false
        && recovery["authority"] == "owner_verification_recovery"
    {
        let reason = json!({"code":"CAPTURE_RECOVERY_CHECK_ONLY","authority":"platform","message":"Checked captures are ready for human choice"});
        run["comparison"]["status"] = json!("needs_attention");
        run["comparison"]["reviewer_status"] = json!("skipped");
        run["comparison"]["review_skip_reason"] = reason.clone();
        run["status"] = json!("ready");
        persist(db, &run, now)?;
        event(
            db,
            "comparison.verification_recovery_completed",
            now,
            json!({"run_id":rid,"request_id":run["comparison"]["verification_recovery"]["request_id"],"automatic_review":false,"reason":reason}),
        )?;
        return Ok(());
    }
    let digest = yoneda_agents_core::fingerprint(&manifest)?;
    let round = number(&run["comparison"], "round")?;
    let id = format!("comparison-review:{rid}:r{round}:{digest}");
    let mut e = run["comparison"]["approval"]["reviewer"].clone();
    let p = string(&e, "provider")?;
    for (k,v) in json!({"id":id,"run_id":rid,"harness":yoneda_agents_core::providers::provider(&p)?.harness,"role":"reviewer","status":"queued","base":run["base"],"context":run["context"],"depth":0,"comparison_approval_id":run["comparison"]["approval"]["id"],"comparison_role":"reviewer","comparison_round":round,"budget":{"provider":e["provider"],"model":e["model"]}}).as_object().ok_or_else(||bad("Invalid execution"))? {e[k]=v.clone();}
    run["execution_count"] = json!(
        number(&run, "execution_count")?
            .checked_add(1)
            .filter(|n| *n <= 7)
            .ok_or_else(|| Error::new(
                "RESOURCE_LIMIT",
                "Comparison logical execution cap reached"
            ))?
    );
    run["comparison"]["status"] = json!("reviewing");
    run["comparison"]["review_execution_id"] = json!(id);
    run["comparison"]["manifest_digest"] = json!(digest);
    run["status"] = json!("reviewing");
    persist(db, &run, now)?;
    create(db, "executions", &id, &e)?;
    save_execution(db, &e, now)?;
    node(
        db,
        &id,
        "execution",
        "Read-only comparison review",
        "platform",
        now,
        e.clone(),
    )?;
    job(
        db,
        &format!("job:{id}"),
        "agent",
        now,
        json!({"review_only":true,"comparison_review":true,"comparison_manifest":{"version":1,"approval_id":run["comparison"]["approval"]["id"],"round":round,"manifest_digest":digest,"manifest":manifest},"execution":e,"run":run,"policy":run["comparison"]["approval"]["policy"]}),
    )?;
    event(
        db,
        "comparison.review_scheduled",
        now,
        json!({"run_id":rid,"execution_id":id,"round":round,"manifest_digest":digest}),
    )?;
    Ok(())
}
pub(in crate::commands) fn complete_review<S: SqlStore>(
    db: &S,
    j: &Value,
    result: &Value,
    now: i64,
) -> Result<bool> {
    if j["payload"]["comparison_review"] != true {
        return Ok(false);
    }
    let mut e = get(db, "executions", &string(&j["payload"]["execution"], "id")?)?;
    let run = get(db, "runs", &string(&e, "run_id")?)?;
    authorize_execution(&run, j)?;
    if result["review_only"] != true
        || result["source_unchanged"] != true
        || result.get("workspace").is_some()
        || result.get("fork_revision").is_some()
        || e["comparison_submission"].is_null()
        || e["comparison_submission"]["epoch"] != j["epoch"]
        || result
            .get("review_id")
            .is_some_and(|id| *id != e["comparison_submission"]["review_id"])
    {
        return Err(Error::new(
            "INVALID_REVIEW",
            "Trusted read-only completion and this epoch's submitted review are required",
        ));
    }
    e["transcript"] = json!(hash(result, "transcript", &[64])?);
    e["comparison_finish_verified"] = json!(true);
    e["status"] = json!("completed");
    e["finished_at"] = json!(now);
    save_execution(db, &e, now)?;
    Ok(true)
}
