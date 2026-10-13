//! Reversible owner-only history visibility; immutable run evidence remains in the ledger.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let repository = repo(db)?;
    let owner = c["_workspace"].as_str().ok_or_else(forbidden)?;
    if (owner != "_admin" && repository["workspace"] != owner)
        || ["_grant", "job_id", "_reviewer"]
            .iter()
            .any(|key| c.get(key).is_some())
    {
        return Err(forbidden());
    }
    if c["op"] == "project_visibility_check" {
        return project_preflight(db, &repository);
    }
    let id = string(c, "run_id")?;
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
    let mut run = get(db, "runs", &id)?;
    if (run["hidden"] == true) != expected {
        return Err(Error::new(
            "VISIBILITY_CHANGED",
            "Refresh run visibility before changing it",
        ));
    }
    if hidden {
        ensure_hideable(db, &run, &repository)?;
    }
    if hidden != expected {
        run["hidden"] = json!(hidden);
        run["visibility_changed_at"] = json!(now);
        run["visibility_reason"] = json!(reason);
        save(db, "runs", &id, &run)?;
        event(
            db,
            "run.visibility_changed",
            now,
            json!({"run_id":id,"hidden":hidden,"reason":reason,"workspace":owner}),
        )?;
    }
    Ok(json!({"run_id":id,"hidden":hidden,"audit_retained":true}))
}

fn forbidden() -> Error {
    Error::new(
        "FORBIDDEN",
        "Only the authenticated repository owner may change history visibility",
    )
}

fn project_preflight<S: SqlStore>(db: &S, repository: &Value) -> Result<Value> {
    let unfinished_jobs = db.query("SELECT id FROM jobs WHERE COALESCE(json_extract(payload,'$.status'),'') NOT IN ('done','failed','cancelled') LIMIT 1", &[])?;
    let unfinished_executions = db.query("SELECT id FROM executions WHERE COALESCE(json_extract(payload,'$.status'),'') NOT IN ('completed','failed','cancelled') LIMIT 1", &[])?;
    let unfinished_runs = db.query("SELECT id FROM runs WHERE COALESCE(json_extract(payload,'$.status'),'') NOT IN ('accepted','cancelled','failed','ready') LIMIT 1", &[])?;
    let visible_runs = db.query(
        "SELECT id FROM runs WHERE COALESCE(json_extract(payload,'$.hidden'),0)!=1 LIMIT 1",
        &[],
    )?;
    let current = db.query("SELECT c.id FROM candidates c WHERE c.id IN (SELECT json_extract(payload,'$.latest_candidate_id') FROM working_branches WHERE json_extract(payload,'$.status')='active') OR (json_extract(c.payload,'$.status') IN ('eligible','accepted') AND json_extract(c.payload,'$.revision.commit')=?) LIMIT 1", &[repository["published_commit"].clone()])?;
    Ok(
        json!({"repo_id":repository["id"],"workspace":repository["workspace"],
        "quiescent":unfinished_jobs.is_empty() && unfinished_executions.is_empty() && unfinished_runs.is_empty() && repository["pending"].is_null(),
        "all_runs_hidden":visible_runs.is_empty(),"current_result":!current.is_empty()}),
    )
}

fn ensure_hideable<S: SqlStore>(db: &S, run: &Value, repository: &Value) -> Result<()> {
    let id = string(run, "id")?;
    if !matches!(
        run["status"].as_str(),
        Some("accepted" | "cancelled" | "failed" | "ready")
    ) {
        return Err(Error::new(
            "RUN_NOT_TERMINAL",
            "Only terminal run history can be hidden",
        ));
    }
    if run_jobs(db, &id)?.iter().any(|job| {
        !matches!(
            job["status"].as_str(),
            Some("done" | "failed" | "cancelled")
        )
    }) || run_executions(db, &id)?.iter().any(|execution| {
        !matches!(
            execution["status"].as_str(),
            Some("completed" | "failed" | "cancelled")
        )
    }) {
        return Err(Error::new(
            "RUN_ACTIVE_WORK",
            "Run has unfinished work and cannot be hidden",
        ));
    }
    let current = db.query("SELECT c.id FROM candidates c WHERE json_extract(c.payload,'$.run_id')=? AND (c.id IN (SELECT json_extract(payload,'$.latest_candidate_id') FROM working_branches WHERE json_extract(payload,'$.status')='active') OR (json_extract(c.payload,'$.status') IN ('eligible','accepted') AND json_extract(c.payload,'$.revision.commit')=?)) LIMIT 1", &[json!(id), repository["published_commit"].clone()])?;
    if !current.is_empty() {
        return Err(Error::new(
            "RUN_CURRENT_RESULT",
            "The current checked or published result must remain visible",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "run_visibility_tests.rs"]
mod tests;
