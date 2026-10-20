use super::*;
pub(in crate::commands) fn current<S: SqlStore>(db: &S, run: &Value) -> Result<Value> {
    let rid = string(run, "id")?;
    let mut candidates = all(db, "candidates")?
        .into_iter()
        .filter(|c| c["run_id"] == rid)
        .collect::<Vec<_>>();
    if candidates.len() > 7 {
        return Err(Error::new("FENCED", "Comparison candidate bound exceeded"));
    }
    candidates.sort_by_key(|c| c["id"].as_str().unwrap_or("").to_owned());
    let executions = all(db, "executions")?
        .into_iter()
        .filter(|e| e["run_id"] == rid)
        .collect::<Vec<_>>();
    let mut alternatives = Vec::new();
    let mut metadata = Vec::new();
    for c in &candidates {
        let e = executions
            .iter()
            .find(|e| e["id"] == c["execution"])
            .ok_or_else(|| bad("Missing candidate producer"))?;
        ancestry(db, run, c)?;
        let evaluation = match c["evaluation"].as_str() {
            Some(id) => get(db, "evaluations", id)?,
            None => Value::Null,
        };
        metadata.push(json!({"candidate_id":c["id"],"execution_id":e["id"],"agent_index":slot(run,e)?,"round":e["comparison_round"].as_i64().unwrap_or(0),"revision":c["revision"],"base":c["base"],"status":c["status"],"summary":c["summary"],"paths":c["paths"],"paths_ref":c["paths_ref"],"paths_count":c["paths_count"],"diff_digest":c["diff_digest"],"evaluation":evaluation}));
    }
    for index in 0..2 {
        let producer = executions
            .iter()
            .filter(|e| e["comparison_role"] != "reviewer" && slot(run, e).ok() == Some(index))
            .max_by_key(|e| e["comparison_round"].as_i64().unwrap_or(0))
            .ok_or_else(|| bad("Missing comparison builder"))?;
        let candidate = metadata
            .iter()
            .find(|c| c["execution_id"] == producer["id"]);
        let mut refs = Vec::new();
        if let Some(c) = candidate {
            refs.push(c["candidate_id"].clone());
            if !c["evaluation"]["id"].is_null() {
                refs.push(c["evaluation"]["id"].clone());
            }
            if !c["evaluation"]["evidence"].is_null() {
                refs.push(c["evaluation"]["evidence"].clone());
            }
        }
        alternatives.push(json!({"agent_index":index,"execution_id":producer["id"],"candidate_id":candidate.map(|c|c["candidate_id"].clone()),"revision":candidate.map(|c|c["revision"].clone()),"evaluation_id":candidate.map(|c|c["evaluation"]["id"].clone()),"status":candidate.map_or(&producer["status"],|c|&c["status"]),"checks":candidate.map(|c|c["evaluation"]["checks"].clone()),"evidence_refs":refs}));
    }
    let branch = match run["working_branch_id"].as_str() {
        Some(id) => get(db, "working_branches", id)?,
        None => Value::Null,
    };
    let branch = if branch.is_null() {
        Value::Null
    } else {
        json!({"id":branch["id"],"version":branch["version"],"working_revision":branch["working_revision"],"canonical_base_commit":branch["canonical_base_commit"],"canonical_base_version":branch["canonical_base_version"]})
    };
    let failures = run_jobs(db, &rid)?
        .into_iter()
        .filter(|j| j["status"] == "failed")
        .map(|j| json!({"job_id":j["id"],"kind":j["kind"],"epoch":j["epoch"],"error":j["error"]}))
        .collect::<Vec<_>>();
    Ok(
        json!({"version":1,"run_id":rid,"approval_id":run["comparison"]["approval"]["id"],"round":run["comparison"]["round"],"intent":run["intent"],"criteria":run["criteria"],"policy":repo(db)?["policy"],"policy_digest":yoneda_agents_core::fingerprint(&repo(db)?["policy"])? ,"base":run["base"],"branch":branch,"alternatives":alternatives,"candidates":metadata,"failures":failures}),
    )
}
pub(in crate::commands) fn slot(run: &Value, e: &Value) -> Result<i64> {
    let count = run["agents"].as_array().map_or(0, Vec::len);
    let count = i64::try_from(count).map_err(|_| bad("Invalid original roster"))?;
    if let Some(i) = e["agent_index"].as_i64().filter(|i| (0..count).contains(i)) {
        return Ok(i);
    }
    let id = string(e, "id")?;
    for i in 0..count {
        if id == format!("{}:agent-{}", string(run, "id")?, i + 1) {
            return Ok(i);
        }
    }
    Err(Error::new(
        "FENCED",
        "Producer has no original comparison slot",
    ))
}
fn original_slot<S: SqlStore>(db: &S, run: &Value, e: &Value) -> Result<i64> {
    let mut execution = e.clone();
    for _ in 0..=yoneda_agents_core::agents::MAX_DELEGATION_DEPTH {
        if execution["run_id"] != run["id"]
            || execution["base"] != run["base"]
            || execution["role"] != "coding"
        {
            return Err(Error::new(
                "FENCED",
                "Original comparison source lineage changed",
            ));
        }
        if let Some(parent_id) = execution["parent_execution"].as_str() {
            let policy: yoneda_agents_core::agents::DelegationPolicy =
                serde_json::from_value(run["delegation"].clone())
                    .map_err(|e| bad(&e.to_string()))?;
            policy.validate(run["agents"].as_array().map_or(0, Vec::len))?;
            let parent = get(db, "executions", parent_id)?;
            if !policy.enabled
                || run_executions(db, &string(run, "id")?)?.len() > policy.max_executions
                || execution["depth"].as_u64().is_none_or(|d| {
                    d > u64::from(policy.max_depth)
                        || d != parent["depth"].as_u64().unwrap_or(0) + 1
                })
                || execution["parent_epoch"] != parent["epoch"]
                || ["provider", "model", "connection", "reasoning_effort"]
                    .iter()
                    .any(|f| execution[*f] != parent[*f])
            {
                return Err(Error::new(
                    "FENCED",
                    "Delegated candidate exceeds frozen lineage authority",
                ));
            }
            execution = parent;
            continue;
        }
        let index = slot(run, &execution)?;
        if execution["id"] != format!("{}:agent-{}", string(run, "id")?, index + 1) {
            return Err(Error::new("FENCED", "Original builder identity changed"));
        }
        let agent =
            &run["agents"][usize::try_from(index).map_err(|_| bad("Invalid original slot"))?];
        if execution["provider"] != agent["provider"]
            || execution["model"] != agent["model"]
            || execution["connection"]
                != *agent
                    .get("connection")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&agent["provider"])
        {
            return Err(Error::new(
                "FENCED",
                "Original builder model or connection changed",
            ));
        }
        return Ok(index);
    }
    Err(Error::new(
        "FENCED",
        "Delegated lineage exceeds frozen depth",
    ))
}
pub(in crate::commands) fn ancestry<S: SqlStore>(db: &S, run: &Value, c: &Value) -> Result<()> {
    let mut candidate = c.clone();
    for _ in 0..3 {
        let e = get(db, "executions", &string(&candidate, "execution")?)?;
        if e["comparison_role"] == "repair" {
            slot(run, &e)?;
        } else {
            original_slot(db, run, &e)?;
        }
        if candidate["run_id"] != run["id"] || candidate["base"] != e["base"] {
            return Err(Error::new("FENCED", "Candidate ancestry changed"));
        }
        if e["comparison_role"] == "repair" {
            validate(run)?;
            if e["comparison_approval_id"] != run["comparison"]["approval"]["id"] {
                return Err(Error::new("FENCED", "Repair approval changed"));
            }
            let parent = get(
                db,
                "candidates",
                &string(&e, "comparison_parent_candidate_id")?,
            )?;
            let parent_e = get(db, "executions", &string(&parent, "execution")?)?;
            if candidate["base"] != parent["revision"] || slot(run, &parent_e)? != slot(run, &e)? {
                return Err(Error::new("FENCED", "Repair parent changed"));
            }
            candidate = parent;
        } else {
            return if candidate["base"] == run["base"] {
                Ok(())
            } else {
                Err(Error::new("FENCED", "Original candidate base changed"))
            };
        }
    }
    Err(Error::new("FENCED", "Repair ancestry exceeds its approval"))
}
pub(in crate::commands) fn checked<S: SqlStore>(db: &S, run: &Value, c: &Value) -> Result<()> {
    ancestry(db, run, c)?;
    if c["status"] != "eligible" {
        return Err(Error::new(
            "CHECKS_FAILED",
            "Selection requires an eligible captured candidate",
        ));
    }
    let evaluation: yoneda_agents_core::Evaluation =
        serde_json::from_value(get(db, "evaluations", &string(c, "evaluation")?)?)
            .map_err(|e| bad(&e.to_string()))?;
    let revision =
        serde_json::from_value(c["revision"].clone()).map_err(|e| bad(&e.to_string()))?;
    let policy =
        serde_json::from_value(repo(db)?["policy"].clone()).map_err(|e| bad(&e.to_string()))?;
    yoneda_agents_core::validate_evaluation(&evaluation, &string(c, "id")?, &revision, &policy)
}
