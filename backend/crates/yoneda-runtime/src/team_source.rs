//! Source SDK access stays in the Worker; assembly and write-scope decisions stay in Rust.
use crate::{broker::broker, team_workspace::Assembly};
use serde_json::{Value, json};
use yoneda_core::{Result, Workspace};

pub(crate) async fn load_git(job: &Value) -> Result<crate::transport::GitWorkspace> {
    let base = &job["payload"]["execution"]["base"];
    base["repository"]
        .as_str()
        .ok_or_else(|| crate::err("Frozen canonical repository is missing"))?;
    let commit = base["commit"]
        .as_str()
        .ok_or_else(|| crate::err("Frozen canonical commit is missing"))?;
    let files =
        crate::git::read_git_revision("http://git.yoneda.internal/canonical", commit).await?;
    let Some(inputs) = job["payload"].get("team_inputs") else {
        return Ok(files);
    };
    let inputs = inputs
        .as_array()
        .ok_or_else(|| crate::err("Invalid frozen Team Git inputs"))?;
    let mut delivered = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.iter().enumerate() {
        let expected_repo = input["revision"]["repository"]
            .as_str()
            .ok_or_else(|| crate::err("Frozen Team input repository is missing"))?;
        let expected_commit = input["revision"]["commit"]
            .as_str()
            .ok_or_else(|| crate::err("Frozen Team input commit is missing"))?;
        let remote = format!("http://git.yoneda.internal/team-{index}");
        crate::git::verify_git_parent(&remote, expected_commit, commit).await?;
        delivered.push(crate::git::read_git_revision(&remote, expected_commit).await?);
        if expected_repo.is_empty() {
            return Err(crate::err("Frozen Team input repository is invalid"));
        }
    }
    crate::team_workspace::assemble_git(&files, inputs, &delivered)
}

pub(crate) async fn load(job: &Value) -> Result<Workspace> {
    let result = broker("/source", json!({}), true).await?;
    let base: Workspace = serde_json::from_value(result["files"].clone()).map_err(crate::err)?;
    let Some(inputs) = job["payload"].get("team_inputs") else {
        return Ok(base);
    };
    let inputs = inputs
        .as_array()
        .ok_or_else(|| crate::err("Invalid captured team input list"))?;
    let mut assembled = Assembly::new(&base, inputs)?;
    for (index, input) in inputs.iter().enumerate() {
        let delivered = broker("/team_source", json!({"index":index}), true).await?;
        let files: Workspace =
            serde_json::from_value(delivered["files"].clone()).map_err(crate::err)?;
        assembled.apply(&delivered["input"], &files)?;
        // Do not accept a mutable/favorable subset even if the files happen to look correct.
        if delivered["input"] != *input {
            return Err(crate::err("Team input identity mismatch"));
        }
    }
    assembled.finish()
}
