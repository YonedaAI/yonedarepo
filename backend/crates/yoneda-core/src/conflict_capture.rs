//! Validation for trusted runtime refresh results at the Cloudflare adapter boundary.
use crate::{Error, Result, conflict::TrustedPathEvidence};
use serde_json::Value;

/// Bind a runtime result to the currently leased capture job and its persisted manifest.
/// The broker remains responsible for Git object readback before invoking this function.
pub fn validate_capture_result(
    job: &Value,
    job_id: &str,
    epoch: i64,
    result: &Value,
) -> Result<()> {
    if job["kind"] != "capture"
        || job["id"] != job_id
        || job["epoch"] != epoch
        || job["status"] != "running"
        || !["refresh_candidate", "resolve_conflict"].contains(
            &job["payload"]["capture_subtype"]
                .as_str()
                .unwrap_or_default(),
        )
    {
        return Err(Error::new(
            "FENCED",
            "Conflict capture is not the active leased attempt",
        ));
    }
    let head = job["payload"]["expected_head"]
        .as_str()
        .ok_or_else(|| bad("Missing expected head"))?;
    git_hash(head)?;
    let readback = &result["readback"];
    if readback["observed_head"] != head
        || readback["version"] != job["payload"]["expected_version"]
    {
        return Err(bad("Canonical Git readback differs from the reserved head"));
    }
    let subtype = job["payload"]["capture_subtype"]
        .as_str()
        .ok_or_else(|| bad("Missing conflict capture subtype"))?;
    if subtype == "refresh_candidate" {
        let base = job["payload"]["expected_base"]
            .as_str()
            .ok_or_else(|| bad("Missing expected base"))?;
        let candidate = job["payload"]["candidate"]["revision"]["commit"]
            .as_str()
            .ok_or_else(|| bad("Missing original candidate revision"))?;
        git_hash(base)?;
        git_hash(candidate)?;
        let evidence: TrustedPathEvidence =
            serde_json::from_value(result["evidence"].clone()).map_err(|e| bad(&e.to_string()))?;
        evidence.validate(base, head, candidate)?;
        if serde_json::json!(evidence.declared_paths) != job["payload"]["declared_paths"] {
            return Err(bad(
                "Git evidence differs from the approved refresh manifest",
            ));
        }
        if readback["parents"] != serde_json::json!([head, candidate]) {
            return Err(bad(
                "Git readback parents do not match the approved refresh inputs",
            ));
        }
        let candidate_paths = paths(readback, "candidate_paths")?;
        let intervening_paths = paths(readback, "intervening_paths")?;
        let overlaps: Vec<_> = candidate_paths
            .iter()
            .filter(|path| intervening_paths.contains(path))
            .cloned()
            .collect();
        if candidate_paths != evidence.captured_paths
            || intervening_paths != evidence.intervening_paths
            || overlaps != evidence.overlapping_paths
        {
            return Err(bad("Runtime path claims differ from Git-derived readback"));
        }
    } else {
        let candidate_commit = result["revision"]["commit"]
            .as_str()
            .ok_or_else(|| bad("Resolver capture omitted its revision"))?;
        git_hash(candidate_commit)?;
        if readback["parents"] != serde_json::json!([head]) {
            return Err(bad(
                "Resolver capture is not based on the reserved canonical head",
            ));
        }
        let allowed: Vec<&str> = job["payload"]["conflict_paths"]
            .as_array()
            .ok_or_else(|| bad("Missing approved conflict paths"))?
            .iter()
            .filter_map(|path| path.as_str())
            .collect();
        let captured = result["resolver_delta_paths"]
            .as_array()
            .ok_or_else(|| bad("Resolver capture omitted Git paths"))?;
        if captured.is_empty()
            || captured.iter().any(|path| {
                path.as_str().is_none_or(|path| {
                    crate::validate_path(path).is_err() || !allowed.contains(&path)
                })
            })
            || candidate_commit.is_empty()
        {
            return Err(bad(
                "Resolver capture exceeds its approved conflict path manifest",
            ));
        }
        if result["id"].as_str().is_none_or(str::is_empty)
            || result["tree"].as_str().is_none_or(str::is_empty)
        {
            return Err(bad("Resolver capture is missing candidate identities"));
        }
        if paths(readback, "resolver_delta_paths")? != paths(result, "resolver_delta_paths")?
            || paths(readback, "captured_paths")? != paths(result, "paths")?
            || readback["candidate_commit"] != candidate_commit
        {
            return Err(bad("Resolver paths or revision differ from Git readback"));
        }
        return Ok(());
    }
    if result["status"] == "clean" {
        for field in ["candidate_id", "tree", "merge_commit"] {
            if result[field].as_str().is_none_or(str::is_empty) {
                return Err(bad(
                    "Clean refresh is missing a captured Git object identity",
                ));
            }
        }
        if readback["merge_commit"] != result["merge_commit"]
            || result["revision"]["commit"] != result["merge_commit"]
            || result["candidate_id"]
                != format!(
                    "candidate:refresh:{}",
                    result["merge_commit"].as_str().unwrap_or_default()
                )
            || paths(readback, "merged_paths")? != paths(result, "paths")?
        {
            return Err(bad(
                "Clean merge identity or paths differ from Git readback",
            ));
        }
        git_hash(result["merge_commit"].as_str().unwrap_or_default())?;
        git_hash(result["tree"].as_str().unwrap_or_default())?;
    } else if result["status"] == "unresolved" {
        if result["merge_workspace_commit"]
            .as_str()
            .is_none_or(str::is_empty)
        {
            return Err(bad(
                "Unresolved merge is missing its two-parent resolver workspace",
            ));
        }
        git_hash(
            result["merge_workspace_commit"]
                .as_str()
                .unwrap_or_default(),
        )?;
        let conflicts = result["conflict_paths"]
            .as_array()
            .ok_or_else(|| bad("Missing merge conflict paths"))?;
        if conflicts.is_empty() {
            return Err(bad("Unresolved merge has no conflict paths"));
        }
        if readback["parents"]
            != serde_json::json!([head, job["payload"]["candidate"]["revision"]["commit"]])
            || readback["workspace_commit"] != result["merge_workspace_commit"]
            || paths(readback, "conflict_paths")? != paths(result, "conflict_paths")?
        {
            return Err(bad("Resolver workspace identity differs from Git readback"));
        }
        for path in conflicts {
            crate::validate_path(path.as_str().ok_or_else(|| bad("Invalid conflict path"))?)?;
        }
    } else {
        return Err(bad("Unknown trusted refresh outcome"));
    }
    Ok(())
}

fn bad(message: &str) -> Error {
    Error::new("INVALID_CONFLICT_RESULT", message)
}

fn paths(value: &Value, key: &str) -> Result<Vec<String>> {
    let entries = value[key]
        .as_array()
        .ok_or_else(|| bad(&format!("Missing Git-derived {key}")))?;
    let mut parsed = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = entry.as_str().ok_or_else(|| bad("Invalid Git path"))?;
        crate::validate_path(path)?;
        parsed.push(path.to_owned());
    }
    parsed.sort();
    parsed.dedup();
    if parsed.len() != entries.len() {
        return Err(bad("Git readback contains duplicate paths"));
    }
    Ok(parsed)
}

fn git_hash(value: &str) -> Result<()> {
    if ![40, 64].contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(bad("Invalid Git object identity"));
    }
    Ok(())
}
