use super::*;
fn reviewer<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<(Value, Value, Value)> {
    let job = active(db, c, now)?;
    let e = get(
        db,
        "executions",
        &string(&job["payload"]["execution"], "id")?,
    )?;
    let run = get(db, "runs", &string(&e, "run_id")?)?;
    if job["payload"]["comparison_review"] != true || e["comparison_role"] != "reviewer" {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the active comparison reviewer can submit",
        ));
    }
    authorize_execution(&run, &job)?;
    Ok((job, e, run))
}
pub(in crate::commands) fn context<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let (j, _, run) = reviewer(db, c, now)?;
    let frozen = &j["payload"]["comparison_manifest"];
    if let Some(id) = c["candidate_id"].as_str()
        && !frozen["manifest"]["candidates"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v["candidate_id"] == id))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Candidate is outside the review manifest",
        ));
    }
    if let Some(path) = c["path"].as_str() {
        yoneda_core::validate_path(path)?;
        if c["candidate_id"].is_null() {
            return Err(bad("Source paths require an exact manifest candidate"));
        }
    }
    if let Some(id) = c["context_id"].as_str()
        && !run["comparison"]["approval"]["context"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(id)))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Context is outside frozen review approval",
        ));
    }
    if let Some(digest) = c["digest"].as_str()
        && !refs(&frozen["manifest"]).iter().any(|v| v == digest)
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Evidence is outside frozen review manifest",
        ));
    }
    Ok(
        json!({"run_id":run["id"],"comparison":view(&run),"approval_id":frozen["approval_id"],"manifest_digest":frozen["manifest_digest"],"manifest":frozen["manifest"]}),
    )
}
fn refs(manifest: &Value) -> Vec<String> {
    let mut refs = manifest["alternatives"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|a| a["evidence_refs"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    refs.extend(
        manifest["candidates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| c["diff_digest"].as_str())
            .map(str::to_owned),
    );
    refs
}
pub(in crate::commands) fn submit<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let (j, mut e, mut run) = reviewer(db, c, now)?;
    let request = string(c, "request_id")?;
    let fp = fingerprint(c)?;
    if e["comparison_submission"]["request_id"] == request {
        if e["comparison_submission"]["epoch"] != j["epoch"] {
            return Err(Error::new(
                "FENCED",
                "Earlier epoch submission cannot certify a retry",
            ));
        }
        if e["comparison_submission"]["fingerprint"] != fp {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Review submission changed",
            ));
        }
        return Ok(e["comparison_submission"]["receipt"].clone());
    }
    if !e["comparison_submission"].is_null() && e["comparison_submission"]["epoch"] == j["epoch"] {
        return Err(Error::new(
            "IDEMPOTENCY_CONFLICT",
            "This reviewer epoch already submitted",
        ));
    }
    let manifest = &j["payload"]["comparison_manifest"]["manifest"];
    let digest = yoneda_core::fingerprint(manifest)?;
    if c["manifest_digest"] != digest
        || run["comparison"]["manifest_digest"] != digest
        || manifest::current(db, &run)? != *manifest
    {
        return Err(Error::new("FENCED", "Review manifest is stale"));
    }
    let outcome = string(c, "outcome")?;
    if !["selected", "repair_requested", "needs_attention"].contains(&outcome.as_str()) {
        return Err(bad("Invalid comparison outcome"));
    }
    let rationale = string(c, "rationale")?;
    if rationale.trim().is_empty() || rationale.len() > 8192 {
        return Err(bad("Bounded review rationale required"));
    }
    let alternatives = c["alternatives"]
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or_else(|| bad("Reasons must cover both alternatives"))?;
    let slots = manifest["alternatives"]
        .as_array()
        .ok_or_else(|| bad("Missing manifest alternatives"))?;
    for slot in slots {
        let matched = alternatives
            .iter()
            .filter(|a| {
                a["candidate_id"] == slot["candidate_id"]
                    && (slot["candidate_id"].is_string()
                        || a["execution_id"] == slot["execution_id"])
            })
            .collect::<Vec<_>>();
        if matched.len() != 1
            || matched[0]["reason"]
                .as_str()
                .is_none_or(|r| r.trim().is_empty() || r.len() > 4096)
        {
            return Err(bad(
                "Each original approach requires its exact candidate or failed execution and reason",
            ));
        }
    }
    for key in ["risks", "evidence_refs"] {
        if let Some(value) = c.get(key)
            && value.as_array().is_none_or(|a| {
                a.len() > 20 || a.iter().any(|v| v.as_str().is_none_or(|s| s.len() > 2048))
            })
        {
            return Err(bad("Review lists must be bounded strings"));
        }
    }
    let allowed = refs(manifest);
    if c["evidence_refs"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|v| v.as_str().is_none_or(|v| !allowed.iter().any(|a| a == v)))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Review evidence is outside its manifest",
        ));
    }
    if outcome != "needs_attention" {
        let id = string(c, "candidate_id")?;
        if !slots.iter().any(|a| a["candidate_id"] == id) {
            return Err(Error::new(
                "FORBIDDEN",
                "Selection must identify a current manifest alternative",
            ));
        }
        let candidate = get(db, "candidates", &id)?;
        if outcome == "selected" {
            manifest::checked(db, &run, &candidate)?;
        } else {
            manifest::ancestry(db, &run, &candidate)?;
            if number(&run["comparison"], "round")? >= 2 {
                return Err(Error::new(
                    "RESOURCE_LIMIT",
                    "Comparison repair rounds exhausted",
                ));
            }
            let instructions = string(c, "repair_instructions")?;
            if instructions.trim().is_empty() || instructions.len() > 8192 {
                return Err(bad("Bounded repair instructions required"));
            }
        }
    }
    let id = format!(
        "proposed-decision:{}",
        yoneda_core::fingerprint(
            &json!({"execution":e["id"],"epoch":j["epoch"],"request":request})
        )?
    );
    let review = json!({"id":id,"run_id":run["id"],"outcome":outcome,"selected_candidate_id":if outcome=="selected" {c["candidate_id"].clone()}else{Value::Null},"candidate_id":c["candidate_id"],"rationale":rationale,"alternatives":alternatives,"risks":c.get("risks").cloned().unwrap_or(json!([])),"evidence_refs":c.get("evidence_refs").cloned().unwrap_or(json!([])),"manifest_digest":digest,"manifest":manifest,"producer_execution_id":e["id"],"producer_epoch":j["epoch"],"repair_instructions":c["repair_instructions"]});
    node(
        db,
        &id,
        "proposed_decision",
        &rationale,
        "agent_assertion",
        now,
        review.clone(),
    )?;
    edge(
        db,
        &string(&e, "id")?,
        &id,
        "proposes",
        "reviewer assertion; selection requires trusted completion",
    )?;
    run["comparison"]["latest_review_id"] = json!(id);
    run["comparison"]["latest_review"] = review;
    let receipt = json!({"review_id":id,"outcome":outcome,"comparison":view(&run)});
    e["comparison_submission"] = json!({"request_id":request,"fingerprint":fp,"receipt":receipt,"review_id":id,"epoch":j["epoch"]});
    save_execution(db, &e, now)?;
    persist(db, &run, now)?;
    Ok(receipt)
}
pub(in crate::commands) fn apply<S: SqlStore>(
    db: &S,
    run: &mut Value,
    e: &Value,
    now: i64,
) -> Result<()> {
    let id = string(&e["comparison_submission"], "review_id")?;
    let review = get(db, "nodes", &id)?["data"].clone();
    if review["producer_execution_id"] != e["id"]
        || review["manifest_digest"] != run["comparison"]["manifest_digest"]
        || manifest::current(db, run)? != review["manifest"]
    {
        run["comparison"]["status"] = json!("stale");
        run["status"] = json!("ready");
        return persist(db, run, now);
    }
    let result = match review["outcome"].as_str() {
        Some("selected") => {
            let c = get(db, "candidates", &string(&review, "selected_candidate_id")?)?;
            selection::choose(
                db,
                run,
                &c,
                "comparison_reviewer",
                &string(&review, "rationale")?,
                now,
            )
            .map(|_| ())
        }
        Some("repair_requested") => repair::launch(db, run, &review, now),
        _ => {
            run["comparison"]["status"] = json!("needs_attention");
            run["status"] = json!("ready");
            persist(db, run, now)
        }
    };
    if let Err(error) = result {
        if ![
            "HEAD_MOVED",
            "WORKING_HEAD_MOVED",
            "POLICY_MOVED",
            "PUBLICATION_PENDING",
            "CHECKS_FAILED",
            "RESOURCE_LIMIT",
        ]
        .contains(&error.code.as_str())
        {
            return Err(error);
        }
        run["comparison"]["status"] = json!(if error.code == "RESOURCE_LIMIT" {
            "needs_attention"
        } else {
            "stale"
        });
        run["comparison"]["terminal_reason"] = json!({"code":error.code,"message":error.message});
        run["status"] = json!("ready");
        persist(db, run, now)?;
    }
    event(
        db,
        "comparison.review_applied",
        now,
        json!({"run_id":run["id"],"review_id":id,"outcome":review["outcome"]}),
    )?;
    Ok(())
}
