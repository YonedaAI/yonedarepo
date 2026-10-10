use super::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::conflict::{ConflictRecord, ConflictStatus};
pub(super) fn owner(c: &Value) -> Result<()> {
    if c.get("_grant").is_some() || c.get("_reviewer").is_some() || c.get("job_id").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Conflict changes require the repository owner",
        ));
    }
    Ok(())
}

pub(super) fn by_request<S: SqlStore>(db: &S, request: &str) -> Result<Option<Value>> {
    let rows = db.query(
        "SELECT payload FROM conflicts WHERE json_extract(payload,'$.request_id')=?",
        &[json!(request)],
    )?;
    rows.first()
        .map(|row| {
            serde_json::from_str(row["payload"].as_str().unwrap_or_default())
                .map_err(|e| bad(&e.to_string()))
        })
        .transpose()
}

pub(super) fn attach_typed(record: &mut Value) -> Result<()> {
    let status = match record["status"].as_str().unwrap_or_default() {
        "clean" => ConflictStatus::Clean,
        "unresolved" => ConflictStatus::Unresolved,
        "resolved" => ConflictStatus::Resolved,
        "stale" => ConflictStatus::Stale,
        "failed" => ConflictStatus::Failed,
        _ => ConflictStatus::Refreshing,
    };
    let typed = ConflictRecord {
        id: string(record, "id")?,
        repository_id: string(record, "repository_id")?,
        request_id: string(record, "request_id")?,
        candidate_id: string(record, "candidate_id")?,
        expected_version: number(record, "expected_version")?,
        head_commit: string(record, "head_commit")?,
        candidate_base: string(record, "candidate_base")?,
        status,
        evidence: serde_json::from_value(record["evidence"].clone())
            .map_err(|e| bad(&e.to_string()))?,
        merge_commit: record["merge_commit"].as_str().map(str::to_owned),
        merge_workspace_commit: record["merge_workspace_commit"].as_str().map(str::to_owned),
        conflict_paths: record["conflict_paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        resolver_run_id: record["resolver_run_id"].as_str().map(str::to_owned),
    };
    record["trusted_record"] = serde_json::to_value(typed).map_err(|e| bad(&e.to_string()))?;
    Ok(())
}

pub(super) fn declared_scopes<S: SqlStore>(
    db: &S,
    candidate: &Value,
) -> Result<(Vec<String>, String)> {
    if let Some(paths) = candidate.get("declared_paths").and_then(Value::as_array) {
        let scopes = paths
            .iter()
            .map(|p| {
                p.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| bad("Invalid frozen declared path"))
            })
            .collect::<Result<Vec<_>>>()?;
        validate_path_list(&scopes)?;
        return Ok((scopes, "candidate_declaration".into()));
    }
    let run = get(db, "runs", &string(candidate, "run_id")?)?;
    if run["mode"] == "collaborate" {
        let plan: yoneda_core::team::TeamPlan =
            serde_json::from_value(run["team_plan"].clone()).map_err(|e| bad(&e.to_string()))?;
        let declared: BTreeSet<String> = plan
            .integration_paths
            .into_iter()
            .chain(plan.tasks.into_iter().flat_map(|t| t.write_paths))
            .collect();
        let paths = candidate["paths"]
            .as_array()
            .ok_or_else(|| bad("Candidate lacks captured paths"))?;
        let paths: Vec<String> = paths
            .iter()
            .map(|p| {
                p.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| bad("Invalid captured path"))
            })
            .collect::<Result<_>>()?;
        if paths.iter().any(|path| {
            !declared
                .iter()
                .any(|scope| yoneda_core::team::owns_path(scope, path))
        }) {
            return Err(Error::new(
                "WRITE_SCOPE",
                "Captured candidate paths exceed the frozen team plan",
            ));
        }
        validate_path_list(&paths)?;
        return Ok((paths, "frozen_team_plan".into()));
    }
    let paths = candidate["paths"]
        .as_array()
        .ok_or_else(|| bad("Candidate lacks captured paths"))?;
    let scopes: Vec<String> = paths
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad("Invalid captured path"))
        })
        .collect::<Result<_>>()?;
    validate_path_list(&scopes)?;
    Ok((scopes, "captured_candidate_paths".into()))
}

pub(super) fn validate_path_list(paths: &[String]) -> Result<()> {
    if paths.is_empty() || paths.len() > yoneda_core::MAX_FILES {
        return Err(bad("Candidate path manifest must contain 1–500 paths"));
    }
    let unique: BTreeSet<_> = paths.iter().collect();
    if unique.len() != paths.len() {
        return Err(bad("Candidate path manifest contains duplicates"));
    }
    for path in paths {
        yoneda_core::validate_path(path)?;
    }
    Ok(())
}
