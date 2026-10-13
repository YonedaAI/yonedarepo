//! A refresh freezes either canonical HEAD or the current checked working branch.
use super::*;

pub(super) fn current<S: SqlStore>(db: &S, candidate: &Value) -> Result<Value> {
    let repository = repo(db)?;
    let run = get(db, "runs", &string(candidate, "run_id")?)?;
    if let Some(id) = run["working_branch_id"].as_str() {
        let branch = get(db, "working_branches", id)?;
        if branch["status"] != "active" {
            return Err(Error::new(
                "HEAD_MOVED",
                "Working branch is no longer active",
            ));
        }
        return Ok(
            json!({"head_commit":branch["working_commit"],"expected_version":branch["version"],"revision":branch["working_revision"],"working_branch_id":id}),
        );
    }
    Ok(
        json!({"head_commit":repository["head_commit"],"expected_version":repository["version"],"revision":{"repository":candidate["base"]["repository"],"commit":repository["head_commit"]}}),
    )
}

pub(super) fn matches<S: SqlStore>(db: &S, record: &Value) -> Result<bool> {
    let head = current(db, &record["candidate"])?;
    Ok(head["head_commit"] == record["head_commit"]
        && head["expected_version"] == record["expected_version"]
        && head["working_branch_id"] == record["working_branch_id"]
        && record
            .get("target_revision")
            .is_none_or(|revision| revision == &head["revision"]))
}

pub(super) fn attach(record: &mut Value, target: &Value) {
    record["target_revision"] = target["revision"].clone();
    if let Some(id) = target.get("working_branch_id") {
        record["working_branch_id"] = id.clone();
    }
}

pub(super) fn evaluated_matches<S: SqlStore>(
    db: &S,
    record: &Value,
    candidate_id: &str,
) -> Result<bool> {
    if matches(db, record)? {
        return Ok(true);
    }
    let Some(id) = record["working_branch_id"].as_str() else {
        return Ok(false);
    };
    let branch = get(db, "working_branches", id)?;
    let candidate = get(db, "candidates", candidate_id)?;
    Ok(branch["latest_candidate_id"] == candidate_id
        && branch["working_revision"] == candidate["revision"]
        && number(&branch, "version")?
            == number(record, "expected_version")?
                .checked_add(1)
                .ok_or_else(|| bad("Branch version overflow"))?)
}
