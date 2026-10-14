use super::*;
pub(super) fn execute<S: SqlStore>(
    db: &S,
    c: &Value,
    mut session: Value,
    now: i64,
) -> Result<Value> {
    let step = string(c, "step_id")?;
    let index = STEPS
        .iter()
        .position(|id| *id == step)
        .ok_or_else(|| bad("Unknown guided step"))?;
    let request = string(c, "request_id")?;
    if request.is_empty() || request.len() > 128 {
        return Err(bad("Invalid guide request identity"));
    }
    let retry = retry::requested(c)?;
    let key = yoneda_core::digest(request.as_bytes());
    let mut identity = json!({"session":session["session_id"],"profile":session["profile_id"],"step":step,"commit":c["expected_commit"],"version":c["expected_version"]});
    if retry {
        // Only retries carry the flag so receipts recorded before retries existed still replay.
        identity["retry"] = json!(true);
    }
    let fingerprint = yoneda_core::fingerprint(&identity)?;
    if let Some(old) = session["requests"].get(&key) {
        if old["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Guide request identity was reused",
            ));
        }
        return evidence::view(db, &session);
    }
    let view = evidence::view(db, &session)?;
    if view["working_revision"]["commit"] != c["expected_commit"]
        || view["working_version"] != c["expected_version"]
    {
        return Err(Error::new("HEAD_MOVED", "Guided checked head changed"));
    }
    if retry {
        retry::check(db, &session, index, &view)?;
    } else if !session["steps"][index]["run_ids"]
        .as_array()
        .is_none_or(Vec::is_empty)
        || session["steps"][index]["started"] == true
    {
        return Ok(view);
    } else if view["steps"][index]["status"] != "ready" {
        return Err(Error::new(
            "GUIDED_STEP_LOCKED",
            "Finish verified evidence from the preceding step",
        ));
    }
    let r = repo(db)?;
    if r["policy"]["version"] != PROFILE
        || yoneda_core::fingerprint(&r["policy"])? != session["policy_digest"]
    {
        return Err(Error::new(
            "POLICY_CHANGED",
            "Guided root policy must remain immutable",
        ));
    }
    let branch_id = string(&session, "working_branch_id")?;
    let mut created = false;
    let branch = match get(db, "working_branches", &branch_id) {
        Ok(branch) => branch,
        Err(e) if e.code == "NOT_FOUND" => {
            created = true;
            super::super::branches::handle(
                db,
                &json!({"op":"create_working_branch","id":branch_id,"expected_commit":c["expected_commit"],"expected_version":c["expected_version"]}),
                now,
            )?
        }
        Err(e) => return Err(e),
    };
    if branch["working_commit"] != c["expected_commit"]
        || !created && branch["version"] != c["expected_version"]
    {
        return Err(Error::new("HEAD_MOVED", "Guided checked head changed"));
    }
    let prepared = c["_guided_runs"]
        .as_array()
        .ok_or_else(|| bad("Trusted guided run approvals required"))?;
    let count = match step.as_str() {
        "concurrent" => 2,
        "review" => 0,
        _ => 1,
    };
    if prepared.len() != count {
        return Err(bad("Guided step needs its exact trusted run count"));
    }
    let attempt = if retry {
        retry::advance(&mut session, index)
    } else {
        1
    };
    let session_id = string(&session, "session_id")?;
    let ids: Vec<String> = (0..count)
        .map(|ordinal| retry::run_id(&session_id, &step, ordinal, attempt))
        .collect();
    session["steps"][index]["run_ids"] = json!(ids);
    session["steps"][index]["started"] = json!(true);
    session["requests"][&key] = json!({"fingerprint":fingerprint});
    save_session(db, &session, now)?;
    for (ordinal, approval) in prepared.iter().enumerate() {
        let mut input = approval.clone();
        let object = input
            .as_object_mut()
            .ok_or_else(|| bad("Invalid trusted start approval"))?;
        for key in [
            "guided",
            "guide",
            "campaign",
            "continuation_of",
            "restart_of",
            "_reviewer",
            "job_id",
            "_grant",
        ] {
            if object.contains_key(key) {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Guided runs require ordinary owner approval",
                ));
            }
        }
        input["op"] = json!("start_run");
        input["id"] = json!(ids[ordinal]);
        input["mode"] = json!("collaborate");
        input["working_branch_id"] = json!(branch_id);
        input["expected_working_commit"] = branch["working_commit"].clone();
        input["expected_working_version"] = branch["version"].clone();
        input["_guided_binding"] = binding::make(&session, &step, ordinal)?;
        if step != "build" {
            let mut context = input["context"].as_array().cloned().unwrap_or_default();
            for evidence in view["steps"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|step| step["evidence"].as_array().into_iter().flatten())
            {
                if evidence["kind"] == "design_choice"
                    && evidence["verified"] == true
                    && evidence["record_id"].is_string()
                    && !context.contains(&evidence["record_id"])
                {
                    context.push(evidence["record_id"].clone());
                }
            }
            input["context"] = json!(context);
        }
        super::super::runs::handle(db, input, now)?;
    }
    event(
        db,
        "guided.step_started",
        now,
        if retry {
            json!({"session_id":session["session_id"],"step_id":step,"run_ids":ids,"attempt":attempt,"previous_run_ids":session["steps"][index]["previous_run_ids"]})
        } else {
            json!({"session_id":session["session_id"],"step_id":step,"run_ids":ids})
        },
    )?;
    evidence::view(db, &session)
}
