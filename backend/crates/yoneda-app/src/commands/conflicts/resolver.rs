use super::support::*;
use super::*;
pub(super) fn resolve<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c.get("job_id").is_none() {
        owner(c)?;
    }
    let stored = get(db, "conflicts", &string(c, "conflict_id")?)?;
    let mut record = super::source::hydrate(db, &stored)?;
    let request = string(c, "request_id")?;
    let request_input = json!({"conflict_id":c["conflict_id"],"expected_commit":c["expected_commit"],"expected_version":c["expected_version"],"expected_plan_revision":c["expected_plan_revision"],"expected_task_revisions":c["expected_task_revisions"],"owner_brief":c["owner_brief"]});
    if record["resolver_request_id"] == request && record.get("resolver_request_input").is_some() {
        if record["resolver_request_input"] != request_input {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Resolver request ID reused with different input",
            ));
        }
        if c.get("job_id").is_some() {
            let caller = active(db, c, now)?;
            if caller["payload"]["execution"]["id"]
                != record["resolver_authorization"]["execution_id"]
            {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Resolver receipt belongs to a different authority",
                ));
            }
        } else if record["resolver_authorization"]["approved_by"] != "repository_owner" {
            return Err(Error::new(
                "FORBIDDEN",
                "Resolver receipt belongs to agent authority",
            ));
        }
        return Ok(
            json!({"conflict_id":record["id"],"status":record["status"],"job_id":record["resolver_job_id"],"execution_id":record["resolver_execution_id"],"model":record["resolver_model"]}),
        );
    }
    let (mut run, authorization, brief) = super::repair_authority::prepare(db, c, &record, now)?;
    let autonomous = c.get("job_id").is_some();
    let job_id = format!("job:conflict-resolver:{request}");
    let fingerprint = yoneda_core::fingerprint(
        &json!({"conflict_id":record["id"],"expected_version":c["expected_version"],"guidance":brief,"expected_plan_revision":c["expected_plan_revision"],"expected_task_revisions":c["expected_task_revisions"],"authorization":authorization}),
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
    if record["expected_version"] != number(c, "expected_version")?
        || !target::matches(db, &record)?
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
    // SourceBinding v1 freezes at most 64 write scopes; reject before scheduling or charging.
    if run["workspace_transport"] == "api-source-v1" && scopes.len() > 64 {
        return Err(Error::new(
            "SOURCE_SCOPE_LIMIT",
            "API source conflict resolution requires at most 64 approved write scopes",
        ));
    }
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
    if autonomous {
        let group = super::super::model_budgets::group(&run, &source_execution)?;
        if group.is_none() || source_execution["run_id"] != run["id"] {
            return Err(Error::new(
                "MISSING_MODEL_APPROVAL",
                "Resolver requires the original approved run model and budget",
            ));
        }
    }
    if approved_model.is_err() {
        return Err(Error::new(
            "MISSING_MODEL_APPROVAL",
            "This candidate has no approved hosted model. Resolve its merge workspace with your local agent and submit a new contribution.",
        ));
    }
    let run_id = string(&record["candidate"], "run_id")?;
    let count = run_executions(db, &run_id)?.len();
    let limit = if run["mode"] == "collaborate" {
        if autonomous {
            usize::try_from(
                run["autonomy_policy"]["max_executions"]
                    .as_u64()
                    .unwrap_or(20),
            )
            .map_err(|_| bad("Invalid execution budget"))?
        } else {
            yoneda_core::team::MAX_TEAM_EXECUTIONS
        }
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
    let legacy_task = format!(
        "Resolve the actual three-way merge for conflict {}. Approved guidance: {}. The source checkout is the trusted merge workspace at {}, with checked target head {} and immutable candidate {} as its two Git parents. Its conflict markers contain both sides, and its tree already preserves cleanly merged candidate changes. Read and integrate both sides semantically; do not discard either side by choosing current or candidate wholesale. Edit only these conflict paths: {}. The trusted capture and independent evaluator will inspect the resulting revision against the checked target head.",
        record["id"],
        brief,
        record["merge_workspace_commit"],
        record["head_commit"],
        record["candidate_revision"],
        scopes.join(", ")
    );
    let resolver_task = if run["workspace_transport"] == "api-source-v1" {
        format!(
            "Resolve the actual three-way merge for conflict {}. Approved guidance: {}. The repo workspace is rooted at target {} with the trusted premerged changes from {} already applied; unresolved paths may still contain target bytes, without conflict markers. Read ../candidate-0 for the exact original candidate {} and ../candidate-1 for the exact preserved premerge workspace. Both views are read-only. Integrate both sides semantically and preserve clean premerged changes; do not select either side wholesale. Edit only these approved conflict paths: {}. Trusted capture preserves the ordered target and original candidate parents, then independent checks evaluate the exact result.",
            record["id"],
            brief,
            record["head_commit"],
            record["merge_workspace_commit"],
            record["candidate_revision"],
            scopes.join(", ")
        )
    } else {
        legacy_task
    };
    let mut execution = json!({"id":resolver_id,"run_id":run_id,"harness":source_execution["harness"],"provider":source_execution["provider"],"connection":source_execution.get("connection").cloned().unwrap_or_else(||source_execution["provider"].clone()),"model":source_execution["model"],"strategy":if autonomous {"Autonomous three-way conflict resolver"} else {"Owner-approved three-way conflict resolver"},"role":"coding","status":"queued","context":if autonomous { &run["context"] } else { &source_execution["context"] },"base":record.get("target_revision").cloned().unwrap_or_else(||json!({"repository":record["candidate"]["base"]["repository"],"commit":record["head_commit"]})),"depth":0,"source_execution":source_execution["id"],"task":resolver_task,"conflict_id":record["id"],"conflict_paths":scopes,"conflict_candidate":record["candidate"],"conflict_expected_version":record["expected_version"],"team_role":if source_execution["team_role"] == "integrator" {json!("integrator")} else {json!("conflict_resolver")}});
    if let Some(budget) = source_execution.get("budget") {
        execution["budget"] = budget.clone();
    }
    for field in ["agent_index", "reasoning_effort"] {
        if let Some(value) = source_execution.get(field) {
            execution[field] = value.clone();
        }
    }
    if autonomous {
        execution["repair_round"] = json!(
            run["team_repair_rounds"]
                .as_u64()
                .unwrap_or_default()
                .checked_add(1)
                .ok_or_else(|| bad("Repair round overflow"))?
        );
    }
    if autonomous {
        run["team_repair_rounds"] = json!(
            run["team_repair_rounds"]
                .as_u64()
                .unwrap_or_default()
                .checked_add(1)
                .ok_or_else(|| bad("Repair round overflow"))?
        );
        run["execution_count"] = json!(
            number(&run, "execution_count")?
                .checked_add(1)
                .ok_or_else(|| bad("Execution count overflow"))?
        );
        save(db, "runs", &run_id, &run)?;
        if let Some(selected) = super::super::campaign::claim_escalation(db, &run, &execution, now)?
        {
            if let Some(object) = execution.as_object_mut() {
                object.remove("routing");
            }
            for (key, value) in selected
                .as_object()
                .ok_or_else(|| bad("Invalid approved escalation selection"))?
            {
                execution[key] = value.clone();
            }
        }
        run = get(db, "runs", &run_id)?;
        record["resolver_plan_revision"] = run["team_plan_revision"].clone();
        record["resolver_task_revisions"] = c["expected_task_revisions"].clone();
    }
    create(db, "executions", &resolver_id, &execution)?;
    node(
        db,
        &resolver_id,
        "execution",
        "Scoped conflict resolver",
        if autonomous { "platform" } else { "owner" },
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
    let policy = if autonomous {
        run["policy"].clone()
    } else {
        repository["policy"].clone()
    };
    let mut compact_record = record.clone();
    super::source::compact(db, &mut compact_record)?;
    job(
        db,
        &job_id,
        "agent",
        now,
        json!({"workspace_transport":"git-native-v1","execution":execution,"run":run,"policy":policy,"team_owned_paths":scopes,"conflict_resolver":{"working_branch_id":record["working_branch_id"],"target_revision":record.get("target_revision").cloned().unwrap_or_else(||json!({"repository":record["candidate"]["base"]["repository"],"commit":record["head_commit"]})),"conflict_id":record["id"],"expected_base":record["candidate_base"],"expected_head":record["head_commit"],"expected_version":record["expected_version"],"candidate":record["candidate"],"merge_workspace_commit":record["merge_workspace_commit"],"merge_workspace_repository":record["workspace_revision"]["repository"],"merge_workspace_revision":record["workspace_revision"],"approved_manifest":compact_record["evidence"],"serverguard":"own_repository_only"}}),
    )?;
    record["resolver_request_input"] = request_input;
    record["resolver_authorization"] = authorization;
    record["resolver_request_id"] = json!(request);
    record["status"] = json!("resolving");
    record["resolver_fingerprint"] = json!(fingerprint);
    record["resolver_job_id"] = json!(job_id);
    record["resolver_execution_id"] = json!(resolver_id);
    record["resolver_model"] = json!({"provider":execution["provider"],"model":execution["model"]});
    super::source::compact(db, &mut record)?;
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
