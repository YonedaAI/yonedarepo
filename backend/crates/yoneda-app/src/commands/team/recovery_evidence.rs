//! Escalation is based on terminal failure of a repaired attempt, never an agent claim.
use super::*;

pub(super) fn record<S: SqlStore>(db: &S, run: &Value, candidate: Option<&Value>) -> Result<Value> {
    let mut run = get(db, "runs", &string(run, "id")?)?;
    let round = run["team_repair_rounds"].as_u64().unwrap_or_default();
    if round == 0 {
        return Ok(run);
    }
    if let Some(candidate) = candidate {
        let execution = get(db, "executions", &string(candidate, "execution")?)?;
        let task = execution["team_task"]
            .as_str()
            .map(|id| get(db, "team_tasks", id))
            .transpose()?;
        let attempt_round = execution["repair_round"]
            .as_u64()
            .or_else(|| task.as_ref().and_then(|t| t["repair_round"].as_u64()));
        if candidate["status"] == "rejected"
            && attempt_round == Some(round)
            && execution["model"] != "claude-opus-5-5"
            && task
                .as_ref()
                .is_none_or(|t| t["revision"] == execution["team_task_revision"])
        {
            run["team_repair_failure"] = json!({"round":round,"kind":"evaluation","candidate_id":candidate["id"],"evaluation_id":candidate["evaluation"],"execution_id":execution["id"],"provider":execution["provider"],"model":execution["model"]});
        }
    } else {
        for task in rows(db, "team_tasks", &string(&run, "id")?)?
            .into_iter()
            .filter(|t| t["status"] == "failed" && t["repair_round"].as_u64() == Some(round))
        {
            if let Some(id) = task["execution_id"].as_str() {
                let execution = get(db, "executions", id)?;
                if execution["model"] != "claude-opus-5-5"
                    && execution["team_task_revision"] == task["revision"]
                {
                    run["team_repair_failure"] = json!({"round":round,"kind":"task","task_id":task["task_id"],"task_revision":task["revision"],"execution_id":id,"provider":execution["provider"],"model":execution["model"]});
                    break;
                }
            }
        }
    }
    save(db, "runs", &string(&run, "id")?, &run)?;
    Ok(run)
}
