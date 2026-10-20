//! Frozen approval bounds agent coordination; product ambiguity remains an owner decision.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result, autonomy::AutonomyPolicy};
mod intent;
pub(super) use intent::{hold_candidate, intent_pending, validate_candidate};

pub(super) fn freeze(c: &Value, run: &mut Value) -> Result<()> {
    let adaptive = run["adaptive_team"].is_object();
    let default = json!({"version":1,"enabled":true,"max_repair_rounds":2,"max_concurrent_agents":3,"max_executions":20,"source_scope":"project","allow_intent_questions":true});
    let Some(value) = c
        .get("autonomy_policy")
        .or_else(|| adaptive.then_some(&default))
    else {
        return Ok(());
    };
    let policy: AutonomyPolicy =
        serde_json::from_value(value.clone()).map_err(|e| bad(&e.to_string()))?;
    policy.validate()?;
    if adaptive && (!policy.enabled || policy.max_concurrent_agents > 3) {
        return Err(bad(
            "Adaptive teams require enabled autonomy with at most three concurrent agents",
        ));
    }
    if c.get("job_id").is_some()
        || c.get("_grant").is_some()
        || run["mode"] != "collaborate"
        || run["model_budgets"].as_array().is_none_or(Vec::is_empty)
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Autonomy requires an owner-approved collaborative run and frozen model budgets",
        ));
    }
    if run["model_budgets"].as_array().is_none_or(|budgets| {
        budgets.iter().any(|budget| {
            budget["max_requests"].as_i64().is_none_or(|n| n < 1)
                || budget["spend_limit_microusd"]
                    .as_i64()
                    .is_none_or(|n| n < 1)
                || !budget["pricing"].is_object()
        })
    }) {
        return Err(bad(
            "Autonomy needs finite request and spend limits for every approved model",
        ));
    }
    let approved = serde_json::to_value(policy).map_err(|e| bad(&e.to_string()))?;
    run["autonomy_policy_digest"] = json!(yoneda_agents_core::fingerprint(&approved)?);
    run["autonomy_policy"] = approved;
    run["approved_policy"] = run["policy"].clone();
    run["autonomy_approval"] = json!({"intent":run["intent"],"criteria":run["criteria"],"agents":run["agents"],"model_budgets":run["model_budgets"],"policy":run["policy"]});
    if adaptive {
        if let Some(approval) = run["autonomy_approval"].as_object_mut() {
            approval.remove("agents");
        }
        for field in [
            "adaptive_team",
            "approved_model_pool",
            "adaptive_team_digest",
        ] {
            run["autonomy_approval"][field] = run[field].clone();
        }
    }
    Ok(())
}

pub(super) fn authorize_repair<S: SqlStore>(
    db: &S,
    c: &Value,
    run: &Value,
    now: i64,
) -> Result<Value> {
    let job = active(db, c, now)?;
    let execution = &job["payload"]["execution"];
    let approval: AutonomyPolicy = serde_json::from_value(run["autonomy_policy"].clone())
        .map_err(|_| Error::new("FORBIDDEN", "This run has no frozen autonomy approval"))?;
    approval.validate()?;
    if job["kind"] != "agent"
        || job["external"] == true
        || execution["run_id"] != run["id"]
        || !["coordinator", "integrator"]
            .contains(&execution["team_role"].as_str().unwrap_or_default())
        || !approval.enabled
        || run["status"] == "cancelled"
        || run["status"] == "accepted"
        || intent_pending(run)
        || run["approved_policy"] != run["policy"]
        || repo(db)?["policy"] != run["approved_policy"]
        || run["intent"] != run["autonomy_approval"]["intent"]
        || run["criteria"] != run["autonomy_approval"]["criteria"]
        || super::adaptive_team::validate_approval(run).is_err()
        || run["adaptive_team"].is_object()
            && yoneda_agents_core::adaptive_team::execution_effort(run, execution).is_err()
        || job["payload"]["run"]["autonomy_approval"] != run["autonomy_approval"]
        || json!(yoneda_agents_core::fingerprint(&run["autonomy_policy"])?)
            != run["autonomy_policy_digest"]
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the active approved coordinator may revise this work",
        ));
    }
    if run["team_repair_rounds"].as_u64().unwrap_or_default()
        >= u64::from(approval.max_repair_rounds)
        || run_executions(db, &string(run, "id")?)?.len()
            >= usize::try_from(approval.max_executions).map_err(|_| bad("Invalid execution cap"))?
    {
        return Err(Error::new(
            "REPAIR_BUDGET_EXHAUSTED",
            "The approved repair or execution envelope is exhausted",
        ));
    }
    Ok(
        json!({"approved_by":"run_autonomy_policy","execution_id":execution["id"],"policy_digest":run["autonomy_policy_digest"],"goal":run["intent"]}),
    )
}

pub(super) fn validate_scopes(run: &Value, paths: &[String]) -> Result<()> {
    validate_plan_scopes(run.get("approved_policy").unwrap_or(&run["policy"]), paths)
}

pub(crate) fn validate_plan_scopes(policy: &Value, paths: &[String]) -> Result<()> {
    for path in paths {
        yoneda_agents_core::validate_path(path.trim_end_matches('/'))?;
        if path.split('/').any(|component| component == ".git")
            || policy["build"]["test_bundle"]["protected_paths"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|protected| {
                    let scope = path.trim_end_matches('/');
                    let protected = protected.trim_end_matches('/');
                    scope == protected
                        || scope.starts_with(&format!("{protected}/"))
                        || protected.starts_with(&format!("{scope}/"))
                })
        {
            return Err(Error::new(
                "FORBIDDEN",
                "Agent plans cannot edit protected verification or Git metadata",
            ));
        }
    }
    Ok(())
}

pub(super) fn question<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c["op"] == "answer_intent" {
        return answer(db, c, now);
    }
    let job = active(db, c, now)?;
    let mut run = get(db, "runs", &string(&job["payload"]["execution"], "run_id")?)?;
    if run["autonomy_policy"]["allow_intent_questions"] != true {
        return Err(Error::new(
            "FORBIDDEN",
            "Intent questions were not approved",
        ));
    }
    let request = string(c, "request_id")?;
    let text = string(c, "question")?;
    let options = c.get("options").cloned().unwrap_or(json!([]));
    if request.len() > 128
        || text.len() > 4096
        || options.as_array().is_none_or(|v| {
            v.len() > 4
                || v.iter()
                    .any(|s| s.as_str().is_none_or(|s| s.is_empty() || s.len() > 512))
        })
    {
        return Err(bad("Intent clarification must be bounded"));
    }
    let id = format!("question:{}:{request}", string(&run, "id")?);
    let fingerprint = yoneda_agents_core::fingerprint(&json!({"question":text,"options":options}))?;
    if let Ok(old) = get(db, "intent_questions", &id) {
        if job["kind"] != "agent" || old["execution_id"] != job["payload"]["execution"]["id"] {
            return Err(Error::new(
                "FORBIDDEN",
                "Only the original active requester may replay this question",
            ));
        }
        if old["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Clarification request changed",
            ));
        }
        return Ok(old);
    }
    authorize_repair(db, c, &run, now)?;
    let value = json!({"id":id,"run_id":run["id"],"execution_id":job["payload"]["execution"]["id"],"epoch":job["epoch"],"question":text,"options":options,"fingerprint":fingerprint,"status":"pending","created_at":now});
    create(db, "intent_questions", &id, &value)?;
    run["intent_question"] = value.clone();
    run["intent_epoch"] = json!(
        run["intent_epoch"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| bad("Intent epoch overflow"))?
    );
    run["status_before_question"] = run["status"].clone();
    run["status"] = json!("awaiting_intent");
    save(db, "runs", &string(&run, "id")?, &run)?;
    for mut candidate in all(db, "candidates")?
        .into_iter()
        .filter(|c| c["run_id"] == run["id"])
    {
        hold_candidate(db, &run, &mut candidate)?;
        save(db, "candidates", &string(&candidate, "id")?, &candidate)?;
        node(
            db,
            &string(&candidate, "id")?,
            "candidate",
            candidate["summary"].as_str().unwrap_or("Candidate"),
            "platform_capture",
            now,
            candidate.clone(),
        )?;
    }
    for mut queued in run_jobs(db, &string(&run, "id")?)? {
        if queued["status"] == "queued" {
            queued["status"] = json!("awaiting_intent");
            save(db, "jobs", &string(&queued, "id")?, &queued)?;
        }
    }
    event(db, "intent.question", now, value.clone())?;
    Ok(value)
}

fn answer<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c.get("job_id").is_some() || c.get("_grant").is_some() || c.get("_reviewer").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the owner may clarify product intent",
        ));
    }
    let mut question = get(db, "intent_questions", &string(c, "question_id")?)?;
    let mut run = get(db, "runs", &string(c, "run_id")?)?;
    let answer = string(c, "answer")?;
    if answer.len() > 4096 || question["run_id"] != run["id"] {
        return Err(bad("Invalid intent answer"));
    }
    if question["status"] == "answered" {
        if question["answer"] != answer {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "This clarification already has a different answer",
            ));
        }
        return Ok(question);
    }
    if run["status"] != "awaiting_intent" || run["intent_question"]["id"] != question["id"] {
        return Err(Error::new("FENCED", "Clarification is no longer active"));
    }
    question["answer"] = json!(answer);
    question["status"] = json!("answered");
    question["answered_at"] = json!(now);
    save(db, "intent_questions", &string(&question, "id")?, &question)?;
    run["intent_question"] = question.clone();
    run["intent_epoch"] = json!(
        run["intent_epoch"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| bad("Intent epoch overflow"))?
    );
    run["status"] = run["status_before_question"].clone();
    let mut answers = run["intent_clarifications"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    answers.push(question.clone());
    run["intent_clarifications"] = json!(answers);
    save(db, "runs", &string(&run, "id")?, &run)?;
    for mut queued in run_jobs(db, &string(&run, "id")?)? {
        if queued["status"] == "awaiting_intent" {
            queued["status"] = json!("queued");
            let jid = string(&queued, "id")?;
            save(db, "jobs", &jid, &queued)?;
            outbox(
                db,
                &format!("intent-resume:{}:{jid}", string(&question, "id")?),
                &string(&queued, "kind")?,
                json!({"job_id":jid}),
            )?;
        }
    }
    event(db, "intent.answered", now, question.clone())?;
    super::team::resume_after_intent(db, &run, now)?;
    Ok(question)
}
