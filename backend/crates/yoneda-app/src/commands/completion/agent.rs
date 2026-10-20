//! Agent completion freezes source transport before trusted capture.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
pub(super) fn complete<S: SqlStore>(db: &S, j: &Value, result: &Value, now: i64) -> Result<()> {
    if super::super::comparison::complete_review(db, j, result, now)? {
        return Ok(());
    }
    let eid = string(&j["payload"]["execution"], "id")?;
    let mut e = get(db, "executions", &eid)?;
    let run_id = string(&e, "run_id")?;
    let mut run = get(db, "runs", &run_id)?;
    e["status"] = json!("completed");
    e["finished_at"] = json!(now);
    if result.get("transcript").is_some() {
        e["transcript"] = json!(hash(result, "transcript", &[64])?);
    }
    if super::super::team::finish_planner(db, j, result, &mut run, now)? {
        // A successful read-only planner freezes a validated DAG; it creates no source capture.
    } else if e["role"] == "research" {
        let context: Vec<_> = all(db, "artifacts")?
            .iter()
            .filter(|a| a["producer"] == eid)
            .map(|a| a["id"].clone())
            .collect();
        if context.is_empty() {
            return Err(Error::new(
                "MISSING_CONTEXT",
                "Research must publish an artifact through MCP",
            ));
        }
        for (h, s) in [
            ("codex", "minimal"),
            ("claude", "defensive"),
            ("codex", "maintainable"),
        ] {
            execution(db, &run, h, s, "coding", json!(context), now)?;
        }
        run["status"] = json!("exploring");
    } else {
        let mut payload = json!({"execution":e,"run_id":run_id,"base":e["base"]});
        match j["payload"]["workspace_transport"].as_str() {
            Some("api-source-v1") => payload = super::source::payload(db, j, result, now)?,
            Some("platform-branch-v1") => {
                // The bound submission, never a commit named by the contributor's finish.
                payload["capture_subtype"] = json!("platform_commit");
                payload["contribution"] = j["submitted_revision"].clone();
            }
            _ => {
                return Err(Error::new(
                    "INVALID_CAPTURE",
                    "Attempts submit a sealed API source workspace or a platform contribution",
                ));
            }
        }
        if let Some(resolver) = j["payload"].get("conflict_resolver") {
            if payload["capture_subtype"] != "source_changeset" {
                return Err(Error::new(
                    "INVALID_CAPTURE",
                    "Conflict resolution needs a sealed source workspace",
                ));
            }
            payload["conflict_resolver"] = resolver.clone();
            payload["source_resolution"] = json!(true);
            payload["conflict_id"] = resolver["conflict_id"].clone();
            payload["candidate"] = resolver["candidate"].clone();
            payload["expected_head"] = resolver["expected_head"].clone();
            payload["expected_version"] = resolver["expected_version"].clone();
            payload["merge_workspace_revision"] = resolver["merge_workspace_revision"].clone();
            // The resolver may edit any valid path except these; `conflict_paths`
            // records only the actually conflicting paths.
            payload["conflict_paths"] = e["conflict_paths"].clone();
            payload["resolver_protected_paths"] = e["resolver_protected_paths"].clone();
        }
        super::super::team::capture_payload(db, j, &mut payload, now)?;
        let capture_id = if e["team_task_revision"].as_i64().is_some_and(|r| r > 1) {
            format!("capture:{eid}:r{}", number(&e, "team_task_revision")?)
        } else {
            format!("capture:{eid}")
        };
        job(db, &capture_id, "capture", now, payload)?;
        e["status"] = json!("capturing");
    }
    save(db, "runs", &run_id, &run)?;
    save_execution(db, &e, now)?;
    Ok(())
}
