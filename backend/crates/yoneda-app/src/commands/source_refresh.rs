//! Private sparse refresh context: root capture reads only ledger-reserved immutable revisions.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn context<S: SqlStore>(db: &S, command: &Value, now: i64) -> Result<Value> {
    let job = active(db, command, now)?;
    let payload = &job["payload"];
    if job["kind"] != "capture"
        || payload["capture_subtype"] != "refresh_candidate"
        || payload["workspace_transport"] != "api-source-v1"
    {
        return Err(Error::new("FORBIDDEN", "No sparse refresh capability"));
    }
    let record = get(db, "conflicts", &string(payload, "conflict_id")?)?;
    let candidate = get(db, "candidates", &string(&payload["candidate"], "id")?)?;
    let repository = repo(db)?;
    let run = get(db, "runs", &string(&candidate, "run_id")?)?;
    if record["status"] != "refreshing"
        || record["job_id"] != job["id"]
        || record["candidate"]
            != *payload
                .get("candidate")
                .ok_or_else(|| bad("Missing frozen candidate"))?
        || candidate["revision"] != record["candidate"]["revision"]
        || run["workspace_transport"] != "api-source-v1"
        || repository["status"] != "ready"
        || repository["policy"] != payload["policy"]
        || !repository["pending"].is_null()
        || ["cancelled", "accepted"].contains(&run["status"].as_str().unwrap_or(""))
    {
        return Err(Error::new("FENCED", "Sparse refresh reservation changed"));
    }
    let target = if let Some(id) = record["working_branch_id"].as_str() {
        let branch = get(db, "working_branches", id)?;
        if branch["status"] != "active"
            || branch["working_commit"] != record["head_commit"]
            || branch["version"] != record["expected_version"]
        {
            return Err(Error::new("HEAD_MOVED", "Working refresh target changed"));
        }
        branch["working_revision"].clone()
    } else {
        if repository["head_commit"] != record["head_commit"]
            || repository["version"] != record["expected_version"]
        {
            return Err(Error::new("HEAD_MOVED", "Canonical refresh target changed"));
        }
        json!({"repository":format!("{}/{}",string(&repository["remote"],"namespace")?,string(&repository["remote"],"name")?),"commit":record["head_commit"]})
    };
    if payload["expected_head"] != record["head_commit"]
        || payload["expected_base"] != record["candidate_base"]
    {
        return Err(Error::new("FENCED", "Sparse refresh source changed"));
    }
    let reference = &record["declared_paths_ref"];
    if reference["version"] != 1
        || reference["count"]
            .as_u64()
            .is_none_or(|n| n > crate::path_lists::MAX_PATHS as u64)
    {
        return Err(Error::new(
            "SOURCE_PREPARING",
            "Refresh path manifest is not frozen",
        ));
    }
    Ok(
        json!({"version":1,"job_id":job["id"],"epoch":job["epoch"],"conflict_id":record["id"],
        "base":{"repository":candidate["base"]["repository"],"commit":payload["expected_base"]},
        "head":target,"candidate":{"repository":candidate["revision"]["repository"],"commit":candidate["revision"]["commit"],"tree":candidate["tree"]},
        "declared_paths_ref":reference,"declared_paths_count":reference["count"],"expected_version":record["expected_version"]}),
    )
}
pub(super) fn paths<S: SqlStore>(db: &S, command: &Value, now: i64) -> Result<Value> {
    let header = context(db, command, now)?;
    let record = json!({"paths_ref":header["declared_paths_ref"]});
    if command.get("path").is_some() {
        crate::path_lists::access::membership(db, command, &record)
    } else {
        crate::path_lists::page_record(db, command, &record)
    }
}
#[cfg(test)]
#[path = "source_refresh_tests.rs"]
mod tests;
