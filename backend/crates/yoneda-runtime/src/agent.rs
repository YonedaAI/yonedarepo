use crate::{agent_transcript::Transcript, broker::broker, field, workspace::export_with_baseline};
use serde_json::{Value, json};
use std::path::Path;
#[cfg(any(target_os = "linux", test))]
use tokio::process::Command;
use yoneda_core::Result;
pub(crate) async fn execute(job: &Value, root: &Path, transcript: &Transcript) -> Result<Value> {
    validate_reasoning_job(job)?;
    let approved_budget = crate::execution_limits::model_budget(job)?;
    if crate::source_workspace_job::enabled(job) {
        return crate::source_workspace_agent::execute(
            job,
            root,
            transcript,
            &agent_prompt(job)?,
            approved_budget.as_ref(),
        )
        .await;
    }
    let git_native = crate::transport::enabled(job);
    let baseline = if git_native {
        crate::transport::prepare_agent_workspace(job, root).await?;
        yoneda_core::Workspace::new()
    } else {
        super::jobs::workspace(job, root).await?
    };
    let git_baseline = if git_native && job["payload"]["team_planning"] == true {
        Some(crate::transport::snapshot_read_only(root).await?)
    } else {
        None
    };
    let repair_baseline = if git_native && job["payload"]["comparison_repair"].is_object() {
        Some(crate::team_source::load_git(job).await?)
    } else {
        None
    };
    #[cfg(target_os = "linux")]
    {
        Command::new("/usr/bin/chown")
            .args(["-R", "1000:1000", "/work", "/home/agent"])
            .status()
            .await
            .map_err(crate::err)?;
    }
    let payload = &job["payload"];
    let execution = &payload["execution"];
    let model = field(job, "model")?;
    let prompt = agent_prompt(job)?;
    let evidence =
        crate::agent_harness::run(job, root, transcript, &prompt, approved_budget.as_ref()).await?;
    if execution["role"] == "research" {
        return Ok(json!({"transcript":evidence["digest"],"model":model}));
    }
    if git_native {
        let commit = crate::git::git(root, &["rev-parse", "HEAD"]).await?;
        if let Some(before) = &repair_baseline {
            let after =
                crate::git::read_git_revision("http://git.yoneda.internal/fork", &commit).await?;
            crate::team_workspace::validate_changes_git(
                before,
                &after,
                &payload["comparison_repair"]["write_paths"],
            )?;
        }
        if let Some(snapshot) = &git_baseline {
            crate::transport::verify_read_only(root, snapshot).await?;
            return Ok(git_agent_result(
                job,
                commit,
                true,
                &evidence["digest"],
                model,
            ));
        }
        return Ok(git_agent_result(
            job,
            commit,
            false,
            &evidence["digest"],
            model,
        ));
    }
    let files = export_with_baseline(root, &baseline)?;
    if payload["team_planning"] == true {
        crate::team_workspace::validate_read_only(&baseline, &files)?;
        return Ok(
            json!({"planning":true,"source_unchanged":true,"transcript":evidence["digest"],"model":model}),
        );
    }
    if let Some(scope) = payload.get("team_owned_paths") {
        crate::team_workspace::validate_changes(&baseline, &files, scope)?;
    }
    if payload["comparison_repair"].is_object() {
        crate::team_workspace::validate_changes(
            &baseline,
            &files,
            &payload["comparison_repair"]["write_paths"],
        )?;
    }
    let uploaded = broker("/workspace", json!({"files":files}), true).await?;
    Ok(json!({"workspace":uploaded["digest"],"transcript":evidence["digest"],"model":model}))
}

fn validate_reasoning_job(job: &Value) -> Result<()> {
    let execution = &job["payload"]["execution"];
    let effort = yoneda_core::adaptive_team::execution_effort(&job["payload"]["run"], execution)?;
    if effort.is_some()
        && (job["model"] != execution["model"]
            || execution["harness"]
                != yoneda_core::providers::provider(field(execution, "provider")?)?.harness)
    {
        return Err(yoneda_core::Error::new(
            "FENCED",
            "Reasoning effort model or harness changed",
        ));
    }
    Ok(())
}

fn agent_prompt(job: &Value) -> Result<String> {
    if job["payload"]["review_only"] == true || job["payload"]["comparison_review"] == true {
        return crate::comparison_review::prompt(job);
    }
    let payload = &job["payload"];
    let execution = &payload["execution"];
    let read_only = payload["team_planning"] == true
        || execution["team_role"] == "planner"
        || execution["team_role"] == "coordinator";
    let mut body = crate::prompt::prompt(payload)?;
    if let Some(repair) = payload.get("comparison_repair") {
        body = format!(
            "Repair ONLY captured candidate {} at exact source {}. Approved repair instructions: {}. Frozen allowed write paths: {}. Preserve the original brief and criteria; capture and independent checking happen after your completed source. Never change verification policy, widen your scope, or claim publication.\n\n{body}",
            repair["candidate_id"],
            repair["source_revision"],
            repair["instructions"],
            repair["write_paths"]
        );
    }
    let mut prompt = if read_only && execution["harness"] == "codex" {
        format!("{}\n\n{body}", crate::team_prompt::CODEX_READ_ONLY_TOOLS)
    } else {
        body
    };
    if crate::source_workspace_job::enabled(job) {
        prompt.push_str("\n\nWorkspace transport: api-source-v1. Normal file operations and scoped source_* MCP tools use one staged SourceWorkspace authority. Inspect files on demand. Do not clone, Git commit, push or publish; the supervisor seals changes and a separate capture/evaluator checks exact Git source. Generated dependencies/build output are local scratch only. Staged writes are not checked or published evidence.\n");
    }
    if crate::transport::enabled(job) && !read_only {
        prompt.push_str("\n\nWorkspace transport: git-native-v1. Commit your completed changes on branch main and push them to origin. Preserve the existing history and do not modify remote URLs or credentials.\n");
    }
    Ok(prompt)
}

fn git_agent_result(
    job: &Value,
    commit: String,
    planning: bool,
    transcript: &Value,
    model: &str,
) -> Value {
    let mut result = json!({
        "fork_revision":crate::transport::candidate_revision(job, commit),
        "transcript":transcript,
        "model":model
    });
    if planning {
        result["planning"] = json!(true);
        result["source_unchanged"] = json!(true);
    }
    result
}

#[cfg(test)]
use crate::{
    agent_harness::{
        claude_arguments, codex_configuration, configure_output_limit, gemini_settings,
    },
    process::untrusted,
};
#[cfg(test)]
#[path = "tests/agent_config.rs"]
mod tests;
