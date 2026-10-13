//! Intent answers require newly approved source work, not promotion of pre-answer evidence.
use super::*;

pub(in crate::commands) fn intent_pending(run: &Value) -> bool {
    run["status"] == "awaiting_intent" || run["intent_question"]["status"] == "pending"
}

pub(in crate::commands) fn hold_candidate<S: SqlStore>(
    db: &S,
    run: &Value,
    candidate: &mut Value,
) -> Result<bool> {
    let epoch = run["intent_epoch"].as_u64().unwrap_or(0);
    if epoch == 0 && !intent_pending(run) && candidate["intent_hold"].is_null() {
        return Ok(false);
    }
    let approved = if let Some(id) = candidate["capture_job"].as_str() {
        get(db, "jobs", id)?["payload"]["intent_epoch"]
            .as_u64()
            .unwrap_or(0)
    } else {
        candidate["intent_epoch"].as_u64().unwrap_or(0)
    };
    candidate["intent_epoch"] = json!(approved);
    if intent_pending(run) || !candidate["intent_hold"].is_null() || approved != epoch {
        candidate["status"] = json!("awaiting_intent");
        candidate["intent_hold"] = json!({"question_id":run["intent_question"]["id"],"source_intent_epoch":approved,"requires":"post_answer_source_capture_and_evaluation"});
        return Ok(true);
    }
    Ok(false)
}

pub(in crate::commands) fn validate_candidate(run: &Value, candidate: &Value) -> Result<()> {
    if intent_pending(run)
        || !candidate["intent_hold"].is_null()
        || candidate["intent_epoch"].as_u64().unwrap_or(0)
            != run["intent_epoch"].as_u64().unwrap_or(0)
    {
        return Err(Error::new(
            "FENCED",
            "Intent clarification requires newly captured and checked source",
        ));
    }
    Ok(())
}
