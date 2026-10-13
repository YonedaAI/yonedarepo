//! Checked working heads are separate from canonical publication and advance with a CAS.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "working_branch" => get(db, "working_branches", &string(c, "id")?),
        "working_branches" => Ok(json!({"items":all(db,"working_branches")?})),
        "create_working_branch" => {
            if c.get("job_id").is_some()
                || c.get("_grant").is_some()
                || c.get("_reviewer").is_some()
            {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Only an owner may approve a working branch",
                ));
            }
            let r = repo(db)?;
            if r["status"] != "ready"
                || !r["pending"].is_null()
                || r["published_commit"] != c["expected_commit"]
                || r["version"] != c["expected_version"]
            {
                return Err(Error::new(
                    "HEAD_MOVED",
                    "Refresh the canonical revision before creating a working branch",
                ));
            }
            let id = string(c, "id")?;
            if id.len() > 120
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(bad("Working branch ID must be bounded and safe"));
            }
            let value = json!({"id":id,"canonical_base_commit":r["published_commit"],"canonical_base_version":r["version"],
                "working_commit":r["published_commit"],"working_revision":{"repository":format!("{}/{}",string(&r["remote"],"namespace")?,string(&r["remote"],"name")?),"commit":r["published_commit"]},
                "version":0,"latest_candidate_id":null,"created_at":now,"status":"active"});
            create(db, "working_branches", &id, &value)?;
            event(db, "working_branch.created", now, value.clone())?;
            Ok(value)
        }
        _ => Err(bad("Unknown working branch operation")),
    }
}

pub(super) fn freeze<S: SqlStore>(db: &S, c: &Value) -> Result<Option<Value>> {
    let Some(id) = c.get("working_branch_id") else {
        return Ok(None);
    };
    if c.get("continuation_of").is_some() || c.get("restart_of").is_some() {
        return Err(bad(
            "Choose a working branch, published continuation or restart",
        ));
    }
    let branch = get(
        db,
        "working_branches",
        id.as_str()
            .ok_or_else(|| bad("Invalid working branch ID"))?,
    )?;
    if branch["status"] != "active"
        || branch["working_commit"] != c["expected_working_commit"]
        || branch["version"] != c["expected_working_version"]
    {
        return Err(Error::new(
            "WORKING_HEAD_MOVED",
            "Refresh the checked working head before starting this update",
        ));
    }
    Ok(Some(branch))
}

pub(super) fn validate_run_head<S: SqlStore>(db: &S, run: &Value) -> Result<()> {
    let r = repo(db)?;
    let valid = if let Some(id) = run["working_branch_id"].as_str() {
        let branch = get(db, "working_branches", id)?;
        branch["working_commit"] == run["base"]["commit"]
            && branch["version"] == run["working_branch_version"]
    } else {
        r["head_commit"] == run["base"]["commit"] && r["version"] == run["base_version"]
    };
    if r["status"] != "ready" || !r["pending"].is_null() || !valid {
        return Err(Error::new(
            "HEAD_MOVED",
            "The approved working head changed",
        ));
    }
    Ok(())
}

pub(super) fn promote<S: SqlStore>(
    db: &S,
    run: &mut Value,
    candidate: &mut Value,
    now: i64,
) -> Result<()> {
    // Compare checks establish evidence for alternatives; selection is a separate decision.
    // Older research jobs use mode=compare without a hosted agent roster.
    if run["mode"] == "compare" && run["agents"].is_array() {
        return Ok(());
    }
    if super::autonomy::hold_candidate(db, run, candidate)? {
        save(db, "candidates", &string(candidate, "id")?, candidate)?;
        return Ok(());
    }
    let Some(id) = run["working_branch_id"].as_str().map(str::to_owned) else {
        return Ok(());
    };
    if candidate["status"] != "eligible" {
        return Ok(());
    }
    let mut branch = get(db, "working_branches", &id)?;
    if branch["latest_candidate_id"] == candidate["id"] {
        return Ok(());
    }
    let expected = candidate
        .get("refresh_expected_version")
        .or_else(|| candidate.get("conflict_expected_version"))
        .unwrap_or(&run["working_branch_version"]);
    let execution = get(db, "executions", &string(candidate, "execution")?)?;
    let superseded = execution
        .get("resolver_plan_revision")
        .is_some_and(|revision| *revision != run["team_plan_revision"]);
    if superseded
        || branch["version"] != *expected
        || branch["working_revision"] != candidate["base"]
    {
        candidate["working_branch_state"] = json!("stale");
        save(db, "candidates", &string(candidate, "id")?, candidate)?;
        event(
            db,
            "working_branch.stale_candidate",
            now,
            json!({"run_id":run["id"],"branch_id":id,"candidate_id":candidate["id"],"working_revision":branch["working_revision"]}),
        )?;
        return Ok(());
    }
    branch["working_revision"] = candidate["revision"].clone();
    branch["working_commit"] = candidate["revision"]["commit"].clone();
    branch["version"] = json!(
        number(&branch, "version")?
            .checked_add(1)
            .ok_or_else(|| bad("Branch version overflow"))?
    );
    branch["latest_candidate_id"] = candidate["id"].clone();
    branch["updated_at"] = json!(now);
    save(db, "working_branches", &id, &branch)?;
    candidate["working_branch_id"] = json!(id);
    candidate["working_branch_state"] = json!("checked_head");
    save(db, "candidates", &string(candidate, "id")?, candidate)?;
    run["checked_working_revision"] = candidate["revision"].clone();
    event(
        db,
        "working_branch.advanced",
        now,
        json!({"branch_id":id,"run_id":run["id"],"candidate_id":candidate["id"],"revision":candidate["revision"],"version":branch["version"]}),
    )?;
    Ok(())
}

/// A published checked head is the new canonical root for subsequent branch work.
pub(super) fn published<S: SqlStore>(db: &S, repository: &Value, now: i64) -> Result<()> {
    for mut branch in all(db, "working_branches")? {
        if branch["status"] == "active"
            && branch["working_commit"] == repository["published_commit"]
        {
            branch["canonical_base_commit"] = repository["published_commit"].clone();
            branch["canonical_base_version"] = repository["version"].clone();
            branch["published_at"] = json!(now);
            save(db, "working_branches", &string(&branch, "id")?, &branch)?;
        }
    }
    Ok(())
}

pub(super) fn publishable<S: SqlStore>(db: &S, candidate: &Value, r: &Value) -> Result<bool> {
    let run = get(db, "runs", &string(candidate, "run_id")?)?;
    super::autonomy::validate_candidate(&run, candidate)?;
    let Some(id) = run["working_branch_id"].as_str().map(str::to_owned) else {
        return Ok(false);
    };
    let branch = get(db, "working_branches", &id)?;
    Ok(branch["canonical_base_commit"] == r["head_commit"]
        && branch["canonical_base_version"] == r["version"]
        && branch["latest_candidate_id"] == candidate["id"]
        && branch["working_revision"] == candidate["revision"])
}
