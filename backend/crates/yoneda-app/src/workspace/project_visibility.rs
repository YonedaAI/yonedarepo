//! Workspace list visibility never deletes repository storage or changes funding.
use super::*;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let owner = account(db)?;
    if c["_workspace"] != owner["username"]
        || c.get("_grant").is_some()
        || c.get("job_id").is_some()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the workspace owner may change project visibility",
        ));
    }
    let id = string(c, "id")?;
    let key = format!("project:{id}");
    let mut project = get(db, TABLE, &key)?;
    let hidden = c["hidden"]
        .as_bool()
        .ok_or_else(|| bad("hidden must be a boolean"))?;
    let expected = c["expected_hidden"]
        .as_bool()
        .ok_or_else(|| bad("expected_hidden must be a boolean"))?;
    let reason = string(c, "reason")?;
    if reason.trim().is_empty() || reason.len() > 512 {
        return Err(bad("A visibility reason of 1–512 bytes is required"));
    }
    if (project["hidden"] == true) != expected {
        return Err(Error::new(
            "VISIBILITY_CHANGED",
            "Refresh project visibility before changing it",
        ));
    }
    if project["status"] == "deleted" {
        return Err(Error::new(
            "REPOSITORY_DELETED",
            "This repository has been deleted",
        ));
    }
    if hidden {
        let receipt = &c["_visibility"];
        if receipt["repo_id"] != id || receipt["workspace"] != owner["username"] {
            return Err(Error::new(
                "FORBIDDEN",
                "A matching trusted repository preflight is required",
            ));
        }
        if receipt["quiescent"] != true
            || !matches!(project["status"].as_str(), Some("ready" | "failed"))
        {
            return Err(Error::new(
                "RUN_ACTIVE_WORK",
                "A project with active work cannot be hidden",
            ));
        }
    }
    if hidden != expected {
        project["hidden"] = json!(hidden);
        project["visibility_changed_at"] = json!(now);
        project["visibility_reason"] = json!(reason);
        put(db, &key, &project)?;
        audit(
            db,
            "project.visibility_changed",
            now,
            json!({"id":id,"hidden":hidden,"reason":reason}),
        )?;
    }
    Ok(project)
}

#[cfg(test)]
#[path = "project_visibility_tests.rs"]
mod tests;
