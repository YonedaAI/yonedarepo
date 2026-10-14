use super::*;
pub(super) fn read<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = get(db, "jobs", &string(c, "job_id")?)?;
    if job["status"] == "running" {
        active(
            db,
            &json!({"job_id":job["id"],"epoch":c.get("epoch").unwrap_or(&job["epoch"])}),
            now,
        )?;
    } else if job["status"] != "queued" {
        return Err(Error::new(
            "FENCED",
            "Source preparation requires queued or active job",
        ));
    }
    if let Some(epoch) = c.get("epoch")
        && epoch != &job["epoch"]
    {
        return Err(Error::new("FENCED", "Source epoch changed"));
    }
    if !["agent", "evaluate"].contains(&job["kind"].as_str().unwrap_or(""))
        || job["external"] == true
        || job["payload"]["workspace_transport"] != TRANSPORT
    {
        return Err(Error::new("FORBIDDEN", "Job has no API source approval"));
    }
    let candidate = if job["kind"] == "evaluate" {
        Some(get(
            db,
            "candidates",
            &string(&job["payload"]["candidate"], "id")?,
        )?)
    } else {
        None
    };
    let e = if let Some(candidate) = &candidate {
        if *candidate != job["payload"]["candidate"] {
            return Err(Error::new("FENCED", "Evaluation candidate changed"));
        }
        crate::path_lists::integrity::validate(db, &job, candidate)?;
        json!({"id":job["id"],"run_id":candidate["run_id"],"base":candidate["revision"]})
    } else {
        get(
            db,
            "executions",
            &string(&job["payload"]["execution"], "id")?,
        )?
    };
    let run = get(db, "runs", &string(&e, "run_id")?)?;
    if run["workspace_transport"] != TRANSPORT
        || ["cancelled", "accepted"].contains(&run["status"].as_str().unwrap_or(""))
    {
        return Err(Error::new("FENCED", "Run source approval is inactive"));
    }
    let resolution = super::resolution::record(db, &job, &e)?;
    let r = repo(db)?;
    let policy = if candidate.is_some() || resolution.is_some() {
        job["payload"]["policy"].clone()
    } else if e["comparison_approval_id"].is_string() {
        run["comparison"]["approval"]["policy"].clone()
    } else {
        run["policy"].clone()
    };
    if policy != r["policy"] || job["payload"]["policy"] != policy {
        return Err(Error::new("POLICY_CHANGED", "Source policy changed"));
    }
    let base = if let Some(record) = &resolution {
        super::resolution::revisions(record)?.0
    } else if let Some(candidate) = &candidate {
        revision(
            &candidate["revision"],
            Some(&json!({"tree":candidate["tree"]})),
        )?
    } else if let Some(id) = e["comparison_parent_candidate_id"].as_str() {
        let parent = get(db, "candidates", id)?;
        if parent["run_id"] != run["id"] || parent["revision"] != e["base"] {
            return Err(Error::new(
                "FENCED",
                "Repair base differs from exact approved parent candidate",
            ));
        }
        revision(&parent["revision"], Some(&json!({"tree":parent["tree"]})))?
    } else {
        revision(&e["base"], run.get("source_base"))?
    };
    let mut inputs = vec![base.clone()];
    let mut parents = vec![base.commit.clone()];
    if let Some(record) = &resolution {
        let (_, merge, candidate) = super::resolution::revisions(record)?;
        parents.push(candidate.commit.clone());
        inputs.extend([candidate, merge]);
    }
    let role = if candidate.is_some() {
        SourceRole::Evaluator
    } else if resolution.is_some() {
        SourceRole::Repair
    } else {
        match e["comparison_role"].as_str().or(e["team_role"].as_str()) {
            Some("reviewer") => SourceRole::Reviewer,
            Some("repair" | "conflict_resolver") => SourceRole::Repair,
            Some("planner") => SourceRole::Planner,
            Some("coordinator") => SourceRole::Coordinator,
            Some("integrator") => SourceRole::Integrator,
            Some("worker") => SourceRole::Specialist,
            _ => SourceRole::Builder,
        }
    };
    if role == SourceRole::Reviewer {
        let manifest = &job["payload"]["comparison_manifest"]["manifest"];
        if job["payload"]["comparison_manifest"]["manifest_digest"]
            != yoneda_core::fingerprint(manifest)?
        {
            return Err(Error::new("FENCED", "Reviewer manifest digest changed"));
        }
        for alternative in manifest["alternatives"].as_array().into_iter().flatten() {
            let Some(id) = alternative["candidate_id"].as_str() else {
                continue;
            };
            let stored = get(db, "candidates", id)?;
            if stored["run_id"] != run["id"] || stored["revision"] != alternative["revision"] {
                return Err(Error::new(
                    "FENCED",
                    "Reviewer source differs from frozen manifest",
                ));
            }
            inputs.push(revision(
                &stored["revision"],
                Some(&json!({"tree":stored["tree"]})),
            )?);
        }
    }
    for input in job["payload"]["team_inputs"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let handoff = get(db, "team_handoffs", &string(input, "handoff_id")?)?;
        if handoff["authority"] != "captured_revision"
            || handoff["run_id"] != run["id"]
            || handoff["output"] != *input
        {
            return Err(Error::new(
                "FENCED",
                "Dependency source lacks exact captured handoff",
            ));
        }
        inputs.push(revision(
            &input["revision"],
            Some(&json!({"tree":input["tree"]})),
        )?);
    }
    let readonly = matches!(
        role,
        SourceRole::Reviewer
            | SourceRole::Planner
            | SourceRole::Coordinator
            | SourceRole::Evaluator
    );
    let task = if let Some(id) = e["team_task"].as_str() {
        let t = get(db, "team_tasks", id)?;
        if t["revision"] != e["team_task_revision"] {
            return Err(Error::new("FENCED", "Source task version changed"));
        }
        Some(t)
    } else {
        None
    };
    let write = if let Some(record) = &resolution {
        record["conflict_paths"].clone()
    } else if readonly {
        json!([])
    } else if let Some(task) = &task {
        task["write_paths"].clone()
    } else {
        job["payload"]
            .get("team_owned_paths")
            .cloned()
            .unwrap_or(json!(["**"]))
    };
    let plan_version = run["team_plan_revision"].clone();
    let task_version = task.as_ref().map(|t| t["revision"].clone());
    Ok(
        json!({"version":1,"transport":TRANSPORT,"source_resolution":resolution.is_some(),"repo_id":r["id"],"run_id":run["id"],"job_id":job["id"],"epoch":job["epoch"],"status":job["status"],"execution_id":e["id"],"role":role,"access":if readonly{"read_only"}else{"read_write"},"base":base,"inputs":inputs,"parents":parents,"write_paths":write,"protected_paths":policy["build"]["test_bundle"]["protected_paths"].as_array().cloned().unwrap_or_default(),"policy_digest":yoneda_core::fingerprint(&policy)?,"intent_digest":yoneda_core::fingerprint(&json!({"intent":run["intent"],"clarifications":run["intent_clarifications"]}))?,"repo_base_version":resolution.as_ref().filter(|r|r["working_branch_id"].is_null()).map_or_else(||run["base_version"].clone(),|r|r["expected_version"].clone()),"working_branch_id":resolution.as_ref().map_or(&run["working_branch_id"],|r|&r["working_branch_id"]),"working_branch_version":resolution.as_ref().filter(|r|!r["working_branch_id"].is_null()).map_or(&run["working_branch_version"],|r|&r["expected_version"]),"plan_version":plan_version,"task_version":task_version,"bindings":job["source_bindings"].as_object().map(|m|m.values().map(|v|v["binding"].clone()).collect::<Vec<_>>()).unwrap_or_default(),"source_mounts":inputs.iter().enumerate().map(|(i,r)|json!({"path":if i==0{"repo".to_owned()}else{format!("candidate-{}",i-1)},"base":r})).collect::<Vec<_>>(),"baseline_inputs":if let Some(record)=&resolution {super::resolution::baseline(db,record)?}else{baseline_inputs(db, &job)?}}),
    )
}
fn revision(value: &Value, fallback: Option<&Value>) -> Result<SourceRevision> {
    let r = SourceRevision {
        repository: string(value, "repository")?,
        commit: string(value, "commit")?,
        tree: value
            .get("tree")
            .or_else(|| fallback.and_then(|f| f.get("tree")))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Error::new(
                    "SOURCE_PREPARING",
                    "Trusted immutable Git tree metadata is not frozen",
                )
            })?
            .into(),
    };
    if let Some(f) = fallback
        && f.get("repository").is_some()
        && (f["repository"] != r.repository || f["commit"] != r.commit)
    {
        return Err(Error::new("FENCED", "Approved source base differs"));
    }
    r.validate()?;
    Ok(r)
}
pub(super) fn validate_overrides<S: SqlStore>(
    db: &S,
    _job: &Value,
    context: &Value,
    overrides: &[BaselineOverride],
    readonly: bool,
) -> Result<()> {
    let mut expected = std::collections::BTreeSet::new();
    for input in context["baseline_inputs"].as_array().into_iter().flatten() {
        expected.extend(crate::path_lists::load(db, input, "paths")?);
    }
    let actual = overrides
        .iter()
        .map(|o| o.path.clone())
        .collect::<std::collections::BTreeSet<_>>();
    if readonly && !overrides.is_empty()
        || !readonly && actual != expected
        || actual.len() != overrides.len()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Baseline overrides must match exact captured dependency paths",
        ));
    }
    for o in overrides {
        if let Some(f) = &o.file {
            f.validate()?;
            match &f.content {
                ContentRef::Git {
                    repository, commit, ..
                } if context["inputs"].as_array().is_some_and(|a| {
                    a.iter()
                        .any(|r| r["repository"] == *repository && r["commit"] == *commit)
                }) => {}
                _ => {
                    return Err(Error::new(
                        "FORBIDDEN",
                        "Override content is not an approved captured input",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn baseline_inputs<S: SqlStore>(db: &S, job: &Value) -> Result<Vec<Value>> {
    job["payload"]["team_inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|input| {
            let mut expanded = input.clone();
            expanded["paths"] = json!(crate::path_lists::load(db, input, "paths")?);
            Ok(expanded)
        })
        .collect()
}
