use super::*;
pub(in crate::commands) fn guards<S: SqlStore>(db: &S, c: &Value, run: &Value) -> Result<()> {
    let r = repo(db)?;
    if r["status"] != "ready" || !r["pending"].is_null() {
        return Err(Error::new(
            "PUBLICATION_PENDING",
            "Resolve repository publication before selecting",
        ));
    }
    if r["head_commit"] != c["expected_commit"] || r["version"] != c["expected_version"] {
        return Err(Error::new(
            "HEAD_MOVED",
            "Canonical selection lease changed",
        ));
    }
    if r["policy"]["version"] != c["expected_policy_version"] {
        return Err(Error::new("POLICY_MOVED", "Selection policy changed"));
    }
    if let Some(id) = run["working_branch_id"].as_str() {
        let b = get(db, "working_branches", id)?;
        if b["working_commit"] != c["expected_working_commit"]
            || b["version"] != c["expected_working_version"]
        {
            return Err(Error::new(
                "WORKING_HEAD_MOVED",
                "Working branch selection lease changed",
            ));
        }
    }
    Ok(())
}
fn head<S: SqlStore>(db: &S, run: &Value) -> Result<Option<Value>> {
    head_at(db, run, None)
}
/// The selectable head; a refreshed selection is current on its refresh target, not the run base.
fn head_at<S: SqlStore>(db: &S, run: &Value, refreshed: Option<&Value>) -> Result<Option<Value>> {
    let r = repo(db)?;
    if r["status"] != "ready"
        || !r["pending"].is_null()
        || super::super::autonomy::intent_pending(run)
        || ["cancelled", "accepted"]
            .iter()
            .any(|s| run["status"] == *s)
    {
        return Err(Error::new(
            "FENCED",
            "Comparison is paused or no longer selectable",
        ));
    }
    let branch = match run["working_branch_id"].as_str() {
        Some(id) => Some(get(db, "working_branches", id)?),
        None => None,
    };
    if let Some(b) = &branch {
        if b["status"] != "active"
            || b["canonical_base_commit"] != r["head_commit"]
            || b["canonical_base_version"] != r["version"]
        {
            return Err(Error::new(
                "HEAD_MOVED",
                "Working branch canonical root changed",
            ));
        }
        if b["working_revision"] != run["base"] {
            let current = get(db, "candidates", &string(b, "latest_candidate_id")?)?;
            if current["run_id"] != run["id"] || current["revision"] != b["working_revision"] {
                return Err(Error::new(
                    "WORKING_HEAD_MOVED",
                    "Another run advanced this branch",
                ));
            }
            manifest::ancestry(db, run, &current)?;
        }
    } else if let Some(c) = refreshed {
        if r["head_commit"] != c["base"]["commit"] || r["version"] != c["refresh_expected_version"]
        {
            return Err(Error::new("HEAD_MOVED", "Refreshed result's base is stale"));
        }
    } else if r["head_commit"] != run["base"]["commit"] || r["version"] != run["base_version"] {
        return Err(Error::new("HEAD_MOVED", "Comparison base is stale"));
    }
    let commits = all(db, "candidates")?
        .into_iter()
        .filter(|c| c["run_id"] == run["id"])
        .map(|c| c["revision"]["commit"].clone())
        .collect::<Vec<_>>();
    if all(db, "runs")?.iter().any(|other| {
        other["id"] != run["id"]
            && other["status"] != "cancelled"
            && commits.contains(&other["base"]["commit"])
    }) {
        return Err(Error::new(
            "WORKING_HEAD_MOVED",
            "Downstream work already depends on a comparison alternative",
        ));
    }
    Ok(branch)
}
pub(in crate::commands) fn validate_repair_head<S: SqlStore>(db: &S, run: &Value) -> Result<()> {
    if let Some(branch) = head(db, run)?
        && (branch["version"] != run["comparison"]["approval"]["branch_version"]
            || branch["working_commit"] != run["comparison"]["approval"]["working_commit"])
    {
        return Err(Error::new(
            "WORKING_HEAD_MOVED",
            "Approved repair branch lease changed",
        ));
    }
    Ok(())
}
pub(in crate::commands) fn choose<S: SqlStore>(
    db: &S,
    run: &mut Value,
    candidate: &Value,
    by: &str,
    reason: &str,
    now: i64,
) -> Result<Value> {
    if pending(db, &string(run, "id")?, None)? {
        return Err(Error::new(
            "INVALID_STATE",
            "Wait for all builders, checks and review attempts to settle",
        ));
    }
    manifest::checked(db, run, candidate)?;
    let branch = head(db, run)?;
    let working = if let Some(mut b) = branch {
        b["working_revision"] = candidate["revision"].clone();
        b["working_commit"] = candidate["revision"]["commit"].clone();
        b["latest_candidate_id"] = candidate["id"].clone();
        b["version"] = json!(
            number(&b, "version")?
                .checked_add(1)
                .ok_or_else(|| bad("Branch version overflow"))?
        );
        b["updated_at"] = json!(now);
        save(db, "working_branches", &string(&b, "id")?, &b)?;
        let mut captured = candidate.clone();
        captured["working_branch_id"] = b["id"].clone();
        captured["working_branch_state"] = json!("checked_head");
        save(db, "candidates", &string(candidate, "id")?, &captured)?;
        event(
            db,
            "working_branch.selected",
            now,
            json!({"run_id":run["id"],"candidate_id":candidate["id"],"branch_id":b["id"],"version":b["version"],"selected_by":by}),
        )?;
        b
    } else {
        Value::Null
    };
    if !run["comparison"].is_object() {
        run["comparison"] = json!({"version":1,"round":0,"latest_review_id":null,"latest_review":null,"selection_version":0});
    }
    run["comparison"]["status"] = json!("selected");
    run["comparison"]["selected_candidate_id"] = candidate["id"].clone();
    run["comparison"]["selected_by"] = json!(by);
    run["comparison"]["selection_reason"] = json!(reason);
    run["comparison"]["selection_version"] = json!(
        run["comparison"]["selection_version"]
            .as_i64()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| bad("Selection overflow"))?
    );
    run["checked_working_revision"] = candidate["revision"].clone();
    run["status"] = json!("ready");
    persist(db, run, now)?;
    Ok(working)
}
pub(in crate::commands) fn owner_select<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    owner(c)?;
    let rid = string(c, "run_id")?;
    let request = string(c, "request_id")?;
    let fp = fingerprint(c)?;
    let mut run = get(db, "runs", &rid)?;
    if let Some(previous) = run["comparison"]["selection_receipts"]
        .as_array()
        .and_then(|r| r.iter().find(|r| r["request_id"] == request))
    {
        if previous["fingerprint"] != fp {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Selection input changed",
            ));
        }
        return Ok(previous["receipt"].clone());
    }
    if !manual_roster(&run)
        || c["expected_selection_version"].as_i64()
            != Some(run["comparison"]["selection_version"].as_i64().unwrap_or(0))
    {
        return Err(Error::new("FENCED", "Comparison selection changed"));
    }
    guards(db, c, &run)?;
    let reason = string(c, "reason")?;
    if reason.trim().is_empty() || reason.len() > 8192 {
        return Err(bad("Bounded selection reason required"));
    }
    let candidate = get(db, "candidates", &string(c, "candidate_id")?)?;
    let working = choose(db, &mut run, &candidate, "owner", &reason, now)?;
    run["comparison"]["selection_request_id"] = json!(request);
    let receipt = json!({"run_id":rid,"comparison":view(&run),"working_branch":working});
    let mut receipts = run["comparison"]["selection_receipts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if receipts.len() >= 20 {
        return Err(bad("Comparison selection receipt bound reached"));
    }
    receipts.push(json!({"request_id":request,"fingerprint":fp,"receipt":receipt}));
    run["comparison"]["selection_receipts"] = json!(receipts);
    persist(db, &run, now)?;
    event(
        db,
        "comparison.owner_selected",
        now,
        json!({"run_id":rid,"candidate_id":candidate["id"],"reason":reason}),
    )?;
    Ok(receipt)
}
pub(in crate::commands) fn validate_publish<S: SqlStore>(
    db: &S,
    run: &Value,
    c: &Value,
) -> Result<()> {
    if !(run["comparison"].is_object()
        || manual_roster(run) && run["working_branch_id"].is_string())
    {
        return Ok(());
    }
    // The selection stands for its validated refreshes: refreshing only merges the selected
    // change onto a newer main, and the refreshed revision is checked again before this point.
    if run["comparison"]["status"] != "selected"
        || !super::refresh::is_selection(db, run, c)?
        || pending(db, &string(run, "id")?, None)?
    {
        return Err(Error::new(
            "COMPARISON_NOT_SELECTED",
            "Select the checked comparison result before publication",
        ));
    }
    let refreshed = run["comparison"]["selected_candidate_id"] != c["id"];
    head_at(db, run, refreshed.then_some(c))?;
    manifest::checked(db, run, c)?;
    if let Some(id) = run["working_branch_id"].as_str() {
        let b = get(db, "working_branches", id)?;
        if b["latest_candidate_id"] != c["id"] || b["working_revision"] != c["revision"] {
            return Err(Error::new(
                "WORKING_HEAD_MOVED",
                "Selected comparison head changed",
            ));
        }
    }
    Ok(())
}
