//! Agent completion freezes source transport before trusted capture.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn complete<S: SqlStore>(db: &S, j: &Value, result: &Value, now: i64) -> Result<()> {
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
        if j["payload"]["workspace_transport"] == "git-native-v1" {
            if result["git_verified"] != true {
                return Err(Error::new(
                    "INVALID_CAPTURE",
                    "Git completion needs an adapter-verified fork receipt",
                ));
            }
            hash(&result["fork_revision"], "commit", &[40, 64])?;
            string(&result["fork_revision"], "repository")?;
            payload["source_revision"] = result["fork_revision"].clone();
            payload["workspace_transport"] = j["payload"]["workspace_transport"].clone();
        } else {
            payload["workspace"] = json!(hash(result, "workspace", &[64])?);
        }
        if let Some(resolver) = j["payload"].get("conflict_resolver") {
            payload["conflict_resolver"] = resolver.clone();
            payload["capture_subtype"] = json!("resolve_conflict");
            payload["conflict_id"] = resolver["conflict_id"].clone();
            payload["candidate"] = resolver["candidate"].clone();
            payload["expected_head"] = resolver["expected_head"].clone();
            payload["expected_version"] = resolver["expected_version"].clone();
            payload["merge_workspace_revision"] = resolver["merge_workspace_revision"].clone();
            payload["conflict_paths"] = e["conflict_paths"].clone();
            payload["team_owned_paths"] = e["conflict_paths"].clone();
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
