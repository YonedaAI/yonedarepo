use super::support::*;
use super::*;
pub(super) fn resolve<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    owner(c)?;
    let mut record = get(db, "conflicts", &string(c, "conflict_id")?)?;
    let brief = string(c, "owner_brief")?;
    if brief.len() > 4096 {
        return Err(bad("Resolver brief exceeds 4096 bytes"));
    }
    let request = string(c, "request_id")?;
    let job_id = format!("job:conflict-resolver:{request}");
    let fingerprint = yoneda_core::fingerprint(
        &json!({"conflict_id":record["id"],"expected_version":c["expected_version"],"owner_brief":brief}),
    )?;
    if let Some(previous) = record.get("resolver_request_id") {
        if previous == &json!(request) && record["resolver_fingerprint"] == fingerprint {
            return Ok(
                json!({"conflict_id":record["id"],"status":record["status"],"job_id":record["resolver_job_id"],"execution_id":record["resolver_execution_id"],"model":record["resolver_model"]}),
            );
        }
        if record["status"] != "unresolved" || record["resolver_evaluation"] != "rejected" {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Conflict already has a different resolver request",
            ));
        }
    }
    let repository = repo(db)?;
    if !repository["pending"].is_null() {
        return Err(Error::new(
            "PUBLICATION_PENDING",
            "Wait for canonical publication before resolving a conflict",
        ));
    }
    if record["status"] != "unresolved" {
        return Err(Error::new(
            "INVALID_STATE",
            "Only unresolved conflicts can be resolved",
        ));
    }
    if repository["version"] != number(c, "expected_version")?
        || repository["version"] != record["expected_version"]
        || repository["head_commit"] != record["head_commit"]
    {
        return Err(Error::new(
            "HEAD_MOVED",
            "Repository changed since conflict review",
        ));
    }
    let conflict_paths = record["conflict_paths"]
        .as_array()
        .ok_or_else(|| bad("Invalid conflict path list"))?;
    let scopes: Vec<String> = conflict_paths
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad("Invalid conflict path"))
        })
        .collect::<Result<_>>()?;
    validate_path_list(&scopes)?;
    hash(&record["workspace_revision"], "commit", &[40, 64])?;
    string(&record["workspace_revision"], "repository")?;
    if record["workspace_revision"]["commit"] != record["merge_workspace_commit"] {
        return Err(bad("Frozen merge workspace identity differs"));
    }
    let source_execution = get(
        db,
        "executions",
        &string(&record["candidate"], "execution")?,
    )?;
    let approved_model = (|| -> Result<()> {
        let provider = string(&source_execution, "provider")?;
        let model = string(&source_execution, "model")?;
        let harness = string(&source_execution, "harness")?;
        yoneda_core::providers::validate_model(&provider, &model)?;
        if yoneda_core::providers::provider(&provider)?.harness != harness {
            return Err(bad("Frozen provider and harness differ"));
        }
        Ok(())
    })();
    if approved_model.is_err() {
        return Err(Error::new(
            "MISSING_MODEL_APPROVAL",
            "This candidate has no approved hosted model. Resolve its merge workspace with your local agent and submit a new contribution.",
        ));
    }
    let run_id = string(&record["candidate"], "run_id")?;
    let run = get(db, "runs", &run_id)?;
    let count = run_executions(db, &run_id)?.len();
    let limit = if run["mode"] == "collaborate" {
        yoneda_core::team::MAX_TEAM_EXECUTIONS
    } else {
        yoneda_core::agents::MAX_RUN_EXECUTIONS
    };
    if count >= limit {
        return Err(Error::new(
            "RESOURCE_LIMIT",
            "No approved execution slot remains for a scoped resolver",
        ));
    }
    let resolver_id = format!("conflict-resolver:{request}");
    let resolver_task = format!(
        "Resolve the actual three-way merge for conflict {}. Owner brief: {}. The source checkout is the trusted merge workspace at {}, with canonical head {} and immutable candidate {} as its two Git parents. Its conflict markers contain both sides, and its tree already preserves cleanly merged candidate changes. Read and integrate both sides semantically; do not discard either side by choosing current or candidate wholesale. Edit only these conflict paths: {}. The trusted capture and independent evaluator will inspect the resulting revision against canonical head.",
        record["id"],
        brief,
        record["merge_workspace_commit"],
        record["head_commit"],
        record["candidate_revision"],
        scopes.join(", ")
    );
    let mut execution = json!({"id":resolver_id,"run_id":run_id,"harness":source_execution["harness"],"provider":source_execution["provider"],"connection":source_execution.get("connection").cloned().unwrap_or_else(||source_execution["provider"].clone()),"model":source_execution["model"],"strategy":"Owner-approved three-way conflict resolver","role":"coding","status":"queued","context":source_execution["context"],"base":{"repository":record["candidate"]["base"]["repository"],"commit":record["head_commit"]},"depth":0,"source_execution":source_execution["id"],"task":resolver_task,"conflict_id":record["id"],"conflict_paths":scopes,"conflict_candidate":record["candidate"],"conflict_expected_version":record["expected_version"],"team_role":if source_execution["team_role"] == "integrator" {json!("integrator")} else {json!("conflict_resolver")}});
    if let Some(budget) = source_execution.get("budget") {
        execution["budget"] = budget.clone();
    }
    create(db, "executions", &resolver_id, &execution)?;
    node(
        db,
        &resolver_id,
        "execution",
        "Scoped conflict resolver",
        "owner",
        now,
        execution.clone(),
    )?;
    edge(
        db,
        &string(&record, "id")?,
        &resolver_id,
        "resolved_by",
        "owner-approved scoped resolver using both Git parents",
    )?;
    let policy = repository["policy"].clone();
    job(
        db,
        &job_id,
        "agent",
        now,
        json!({"workspace_transport":"git-native-v1","execution":execution,"run":run,"policy":policy,"team_owned_paths":scopes,"conflict_resolver":{"conflict_id":record["id"],"expected_base":record["candidate_base"],"expected_head":record["head_commit"],"expected_version":record["expected_version"],"candidate":record["candidate"],"merge_workspace_commit":record["merge_workspace_commit"],"merge_workspace_repository":record["workspace_revision"]["repository"],"merge_workspace_revision":record["workspace_revision"],"approved_manifest":record["evidence"],"serverguard":"own_repository_only"}}),
    )?;
    record["resolver_request_id"] = json!(request);
    record["status"] = json!("resolving");
    record["resolver_fingerprint"] = json!(fingerprint);
    record["resolver_job_id"] = json!(job_id);
    record["resolver_execution_id"] = json!(resolver_id);
    record["resolver_model"] =
        json!({"provider":source_execution["provider"],"model":source_execution["model"]});
    save(db, "conflicts", &string(&record, "id")?, &record)?;
    event(
        db,
        "candidate.resolution_requested",
        now,
        json!({"conflict_id":record["id"],"job_id":job_id,"execution_id":resolver_id}),
    )?;
    Ok(
        json!({"conflict_id":record["id"],"status":"resolving","job_id":job_id,"execution_id":resolver_id,"model":record["resolver_model"]}),
    )
}
