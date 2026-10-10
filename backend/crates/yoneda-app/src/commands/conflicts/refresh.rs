use super::support::*;
use super::*;
use yoneda_core::conflict::TrustedPathEvidence;
pub(super) fn refresh<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    owner(c)?;
    let request_id = string(c, "request_id")?;
    if let Some(old) = by_request(db, &request_id)? {
        for field in [
            "request_id",
            "candidate_id",
            "expected_version",
            "expected_commit",
        ] {
            if old["request"][field] != c[field] {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Request ID was used with different input",
                ));
            }
        }
        return Ok(old["receipt"].clone());
    }
    let repository = repo(db)?;
    let expected_version = number(c, "expected_version")?;
    let head = hash(c, "expected_commit", &[40, 64])?;
    if !repository["pending"].is_null() {
        return Err(Error::new(
            "PUBLICATION_PENDING",
            "Wait for canonical publication before refreshing another candidate",
        ));
    }
    if repository["status"] != "ready"
        || repository["version"] != expected_version
        || repository["head_commit"] != head
    {
        return Err(Error::new(
            "HEAD_MOVED",
            "Repository head or version changed",
        ));
    }
    let candidate_id = string(c, "candidate_id")?;
    let candidate = get(db, "candidates", &candidate_id)?;
    if !["eligible", "rejected"].contains(&candidate["status"].as_str().unwrap_or_default())
        || candidate["evaluation"].as_str().is_none()
    {
        return Err(Error::new(
            "MISSING_EVIDENCE",
            "Only independently evaluated candidates can be refreshed",
        ));
    }
    if candidate["base"]["commit"] == head {
        return Err(Error::new(
            "INVALID_STATE",
            "Candidate already uses the current head",
        ));
    }
    let (paths, scope_source) = declared_scopes(db, &candidate)?;
    let input = json!({"request_id":request_id,"candidate_id":candidate_id,"expected_version":expected_version,"expected_commit":head,"declared_paths":paths,"scope_source":scope_source});
    let id = format!("conflict:{request_id}");
    let job_id = format!("capture:refresh:{request_id}");
    let mut record = json!({"id":id,"repository_id":repository["id"],"request_id":request_id,"candidate_id":candidate_id,"candidate":candidate,"candidate_revision":candidate["revision"]["commit"],"expected_version":expected_version,"head_commit":head,"candidate_base":candidate["base"]["commit"],"status":"refreshing","declared_paths":paths,"scope_source":scope_source,"conflict_paths":[],"created_at":now});
    record["request"] = input;
    record["job_id"] = json!(job_id);
    let receipt = json!({"conflict_id":id,"status":"refreshing","job_id":job_id});
    record["receipt"] = receipt.clone();
    create(db, "conflicts", &id, &record)?;
    job(
        db,
        &job_id,
        "capture",
        now,
        json!({"workspace_transport":"git-native-v1","capture_subtype":"refresh_candidate","conflict_id":id,"candidate":candidate,"expected_base":candidate["base"]["commit"],"expected_head":head,"expected_version":expected_version,"declared_paths":paths,"run_id":candidate["run_id"],"policy":repository["policy"]}),
    )?;
    event(db, "candidate.refresh_requested", now, receipt.clone())?;
    Ok(receipt)
}

pub(super) fn complete<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let mut active_job = active(db, c, now)?;
    if active_job["kind"] != "capture"
        || !["refresh_candidate", "resolve_conflict"].contains(
            &active_job["payload"]["capture_subtype"]
                .as_str()
                .unwrap_or_default(),
        )
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only an active trusted capture can complete a refresh",
        ));
    }
    active_job["status"] = json!("done");
    active_job["lease_until"] = json!(0);
    let active_id = string(&active_job, "id")?;
    // Validation uses the leased status; persist terminal state only after it succeeds.
    let id = string(&active_job["payload"], "conflict_id")?;
    let mut record = get(db, "conflicts", &id)?;
    let repository = repo(db)?;
    if repository["version"] != record["expected_version"]
        || repository["head_commit"] != record["head_commit"]
    {
        record["status"] = json!("stale");
        save(db, "conflicts", &id, &record)?;
        event(
            db,
            "candidate.refresh_fenced",
            now,
            json!({"conflict_id":id,"reason":"HEAD_MOVED"}),
        )?;
        save(db, "jobs", &active_id, &active_job)?;
        return Ok(json!({"conflict_id":id,"status":"stale","reason":"HEAD_MOVED"}));
    }
    if active_job["payload"]["capture_subtype"] == "refresh_candidate" {
        // Only the authenticated broker capture path can finish this internal operation.
        // Bind its readback to the server-frozen Git-native job; a result flag supplied by
        // the caller is not evidence that Git was read back from the canonical Artifact.
        if active_job["payload"]["workspace_transport"] != "git-native-v1" {
            return Err(Error::new(
                "FORBIDDEN",
                "Remote head readback requires a trusted Git-native capture job",
            ));
        }
        let observed_head = hash(&c["result"]["readback"], "observed_head", &[40, 64])?;
        if c["result"]["readback"]["version"] != record["expected_version"] {
            return Err(bad(
                "Canonical Git readback version differs from the reserved version",
            ));
        }
        if observed_head != record["head_commit"] {
            record["status"] = json!("stale");
            record["stale_reason"] = json!("REMOTE_CHANGE");
            record["observed_remote_head"] = json!(observed_head);
            save(db, "conflicts", &id, &record)?;
            event(
                db,
                "candidate.refresh_fenced",
                now,
                json!({"conflict_id":id,"reason":"REMOTE_CHANGE","observed_remote_head":observed_head}),
            )?;
            save(db, "jobs", &active_id, &active_job)?;
            return Ok(
                json!({"conflict_id":id,"status":"stale","reason":"REMOTE_CHANGE","observed_remote_head":observed_head}),
            );
        }
    }
    let mut leased = active_job.clone();
    leased["status"] = json!("running");
    yoneda_core::conflict_capture::validate_capture_result(
        &leased,
        &active_id,
        number(&leased, "epoch")?,
        &c["result"],
    )?;
    save(db, "jobs", &active_id, &active_job)?;
    let evidence: TrustedPathEvidence =
        serde_json::from_value(c["result"]["evidence"].clone()).map_err(|e| bad(&e.to_string()))?;
    evidence.validate(
        record["candidate_base"].as_str().unwrap_or_default(),
        record["head_commit"].as_str().unwrap_or_default(),
        record["candidate_revision"].as_str().unwrap_or_default(),
    )?;
    let result = &c["result"];
    if result["status"] == "unresolved" {
        record["status"] = json!("unresolved");
        record["evidence"] = json!(evidence);
        record["merge_tree"] = result["merge_tree"].clone();
        record["merge_workspace_commit"] =
            json!(hash(result, "merge_workspace_commit", &[40, 64])?);
        record["conflict_paths"] = result["conflict_paths"].clone();
        record["workspace_revision"] = result["workspace_revision"].clone();
        attach_typed(&mut record)?;
        save(db, "conflicts", &id, &record)?;
        event(
            db,
            "candidate.refresh_conflicted",
            now,
            json!({"conflict_id":id,"paths":record["conflict_paths"]}),
        )?;
        return Ok(record);
    }
    if result["status"] != "clean" {
        return Err(bad("Trusted merge result has an invalid status"));
    }
    let new_id = string(result, "candidate_id")?;
    let evidence_value = serde_json::to_value(&evidence).map_err(|e| bad(&e.to_string()))?;
    let mut candidate = json!({"id":new_id,"execution":record["candidate"]["execution"],"run_id":record["candidate"]["run_id"],"base":{"repository":record["candidate"]["base"]["repository"],"commit":record["head_commit"]},"revision":result["revision"],"tree":result["tree"],"paths":result["paths"],"diff_digest":result["diff_digest"],"approved_parents":[record["head_commit"],record["candidate_revision"]],"refresh_expected_version":record["expected_version"],"declared_paths":evidence.declared_paths,"status":"evaluating","capture_job":active_job["id"],"refresh_of":record["candidate_id"],"conflict_id":id});
    for key in ["integration_manifest", "integration_digest"] {
        if let Some(value) = record["candidate"].get(key) {
            candidate[key] = value.clone();
        }
    }
    hash(result, "diff_digest", &[64])?;
    create(db, "candidates", &new_id, &candidate)?;
    if result.get("file_provenance").is_some() {
        super::super::history::capture_file_provenance(db, &leased, result, now)?;
    }
    node(
        db,
        &new_id,
        "candidate",
        "Refreshed candidate",
        "platform_capture",
        now,
        candidate.clone(),
    )?;
    edge(
        db,
        &string(&record, "candidate_id")?,
        &new_id,
        "refreshed_as",
        &string(result, "merge_commit")?,
    )?;
    let policy = repository["policy"].clone();
    job(
        db,
        &format!("evaluate:{new_id}"),
        "evaluate",
        now,
        json!({"workspace_transport":"git-native-v1","candidate":candidate,"run_id":candidate["run_id"],"policy":policy}),
    )?;
    record["status"] = json!("clean");
    record["evidence"] = evidence_value;
    record["merge_commit"] = result["merge_commit"].clone();
    record["refreshed_candidate_id"] = json!(new_id);
    attach_typed(&mut record)?;
    record["conflict_paths"] = json!([]);
    save(db, "conflicts", &id, &record)?;
    event(
        db,
        "candidate.refreshed",
        now,
        json!({"conflict_id":id,"candidate_id":new_id}),
    )?;
    candidate["status"] = json!("evaluating");
    Ok(json!({"conflict":record,"candidate":candidate,"repository_version":repository["version"]}))
}
