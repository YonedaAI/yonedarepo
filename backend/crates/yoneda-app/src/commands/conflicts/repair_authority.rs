//! Autonomous resolution derives its instructions from frozen intent and context.
use super::*;

pub(super) fn prepare<S: SqlStore>(
    db: &S,
    c: &Value,
    record: &Value,
    now: i64,
) -> Result<(Value, Value, String)> {
    let run = get(db, "runs", &string(&record["candidate"], "run_id")?)?;
    if c.get("job_id").is_none() {
        support::owner(c)?;
        let brief = string(c, "owner_brief")?;
        if brief.len() > 4096 {
            return Err(bad("Resolver brief exceeds 4096 bytes"));
        }
        return Ok((run, json!({"approved_by":"repository_owner"}), brief));
    }
    let auth = super::super::autonomy::authorize_repair(db, c, &run, now)?;
    if c["expected_plan_revision"] != run["team_plan_revision"] {
        return Err(Error::new("PLAN_MOVED", "Resolver plan revision changed"));
    }
    if c["expected_commit"] != record["head_commit"] {
        return Err(Error::new("HEAD_MOVED", "Resolver target head changed"));
    }
    let paths = record["conflict_paths"]
        .as_array()
        .ok_or_else(|| bad("Invalid conflict paths"))?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad("Invalid conflict path"))
        })
        .collect::<Result<Vec<_>>>()?;
    super::super::autonomy::validate_scopes(&run, &paths)?;
    for task in affected(db, &run, &paths)? {
        let local = string(&task, "task_id")?;
        if c["expected_task_revisions"][&local] != task["revision"] {
            return Err(Error::new(
                "TASK_MOVED",
                "Resolver affected task revision changed",
            ));
        }
    }
    let brief = format!(
        "Approved goal: {}. Acceptance criteria: {}. Frozen context IDs: {}. Owner intent clarifications: {}",
        run["intent"], run["criteria"], run["context"], run["intent_clarifications"]
    );
    Ok((run, auth, brief))
}

fn affected<S: SqlStore>(db: &S, run: &Value, paths: &[String]) -> Result<Vec<Value>> {
    let mut tasks = Vec::new();
    for task in all(db, "team_tasks")?
        .into_iter()
        .filter(|t| t["run_id"] == run["id"])
    {
        if task["role"] == "integrator"
            || task["write_paths"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|scope| paths.iter().any(|p| yoneda_core::team::owns_path(scope, p)))
        {
            tasks.push(task);
        }
    }
    Ok(tasks)
}

pub(super) fn validate_capture<S: SqlStore>(db: &S, record: &Value) -> Result<()> {
    if record["resolver_authorization"]["approved_by"] != "run_autonomy_policy" {
        return Ok(());
    }
    let run = get(db, "runs", &string(&record["candidate"], "run_id")?)?;
    if ["cancelled", "accepted", "awaiting_intent"]
        .contains(&run["status"].as_str().unwrap_or_default())
        || run["team_plan_revision"] != record["resolver_plan_revision"]
        || run["autonomy_policy_digest"] != record["resolver_authorization"]["policy_digest"]
        || run["policy"] != run["approved_policy"]
        || repo(db)?["policy"] != run["policy"]
    {
        return Err(Error::new(
            "FENCED",
            "Autonomous resolver approval or plan changed",
        ));
    }
    let paths = record["conflict_paths"]
        .as_array()
        .ok_or_else(|| bad("Invalid conflict paths"))?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad("Invalid conflict path"))
        })
        .collect::<Result<Vec<_>>>()?;
    for task in affected(db, &run, &paths)? {
        if record["resolver_task_revisions"][string(&task, "task_id")?] != task["revision"] {
            return Err(Error::new(
                "FENCED",
                "Autonomous resolver task revision changed",
            ));
        }
    }
    Ok(())
}
