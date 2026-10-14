//! Trusted attempt source descriptors. No model argument can select a workspace identity.
use crate::source_client::failure;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use yoneda_core::{
    Result,
    source_workspace::{SourceAccess, SourceRevision},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceMountSpec {
    pub path: String,
    pub workspace_id: String,
    pub base: SourceRevision,
    pub view_digest: String,
    pub access: SourceAccess,
    #[serde(default)]
    pub scratch_paths: Vec<String>,
}
pub fn enabled(job: &Value) -> bool {
    job["payload"]["workspace_transport"] == "api-source-v1"
}
pub fn mounts(job: &Value) -> Result<Vec<SourceMountSpec>> {
    descriptors(job, false)
}
fn descriptors(job: &Value, evaluation: bool) -> Result<Vec<SourceMountSpec>> {
    if !enabled(job) {
        return Err(failure(
            "SOURCE_TRANSPORT",
            "Source API transport was not approved",
        ));
    }
    if job["kind"] != if evaluation { "evaluate" } else { "agent" } {
        return Err(failure(
            "SOURCE_SCOPE",
            "Only active agent jobs mount mutable source",
        ));
    }
    let specs: Vec<SourceMountSpec> = serde_json::from_value(job["source_mounts"].clone())
        .map_err(|_| {
            failure(
                "SOURCE_INDEX_PENDING",
                "Trusted source metadata is not ready",
            )
        })?;
    let captured = if !evaluation && job["payload"]["comparison_review"] == true {
        Some(comparison_candidates(job)?)
    } else {
        None
    };
    if specs.len() > 3
        || specs.is_empty() && captured.as_ref().is_none_or(|items| !items.is_empty())
    {
        return Err(failure(
            "SOURCE_INDEX_PENDING",
            "Source mount descriptors missing",
        ));
    }
    let role = job["payload"]["execution"]["team_role"]
        .as_str()
        .unwrap_or_default();
    let readonly = evaluation
        || job["payload"]["review_only"] == true
        || job["payload"]["comparison_review"] == true
        || job["payload"]["team_planning"] == true
        || ["planner", "coordinator", "reviewer"].contains(&role);
    let mut aliases = BTreeSet::new();
    let mut workspaces = BTreeSet::new();
    for spec in &specs {
        spec.base.validate()?;
        let mut scratch = std::collections::BTreeSet::new();
        if spec.scratch_paths.len() > 4
            || spec.scratch_paths.iter().any(|path| {
                !["node_modules/", "target/", ".venv/", "__pycache__/"].contains(&path.as_str())
                    || !scratch.insert(path)
            })
            || !evaluation && readonly && !spec.scratch_paths.is_empty()
        {
            return Err(failure("SOURCE_SCOPE", "Invalid frozen scratch paths"));
        }

        let digest = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        if !["repo", "candidate-0", "candidate-1"].contains(&spec.path.as_str())
            || !aliases.insert(&spec.path)
            || !workspaces.insert(&spec.workspace_id)
            || !spec
                .workspace_id
                .strip_prefix("source-workspace:")
                .is_some_and(digest)
            || !digest(&spec.view_digest)
            || (readonly || spec.path != "repo") && spec.access != SourceAccess::ReadOnly
        {
            return Err(failure("SOURCE_SCOPE", "Invalid frozen source mount"));
        }
    }
    if let Some(captured) = captured {
        if specs.len() != captured.len() {
            return Err(failure("SOURCE_SCOPE", "Comparison source set changed"));
        }
        for (ordinal, candidate) in captured.iter().enumerate() {
            let alias = format!("candidate-{ordinal}");
            let spec = specs
                .iter()
                .find(|spec| spec.path == alias)
                .ok_or_else(|| failure("SOURCE_SCOPE", "Comparison captured source missing"))?;
            if candidate["revision"]["repository"] != spec.base.repository
                || candidate["revision"]["commit"] != spec.base.commit
            {
                return Err(failure(
                    "SOURCE_FENCED",
                    "Comparison captured source changed",
                ));
            }
        }
    }
    Ok(specs)
}
/// Only immutable review manifests may authorize zero source views or compact captured ordinals.
pub fn comparison_candidates(job: &Value) -> Result<Vec<&Value>> {
    let payload = &job["payload"];
    let frozen = &payload["comparison_manifest"];
    let approval = frozen["approval_id"].as_str().filter(|id| !id.is_empty());
    if !enabled(job)
        || job["kind"] != "agent"
        || payload["comparison_review"] != true
        || payload["review_only"] != true
        || payload["execution"]["comparison_role"] != "reviewer"
        || frozen["version"] != 1
        || approval.is_none()
        || frozen["approval_id"] != payload["execution"]["comparison_approval_id"]
        || frozen["approval_id"] != payload["run"]["comparison"]["approval"]["id"]
        || frozen["manifest_digest"] != yoneda_core::fingerprint(&frozen["manifest"])?
    {
        return Err(failure(
            "SOURCE_SCOPE",
            "Invalid frozen source comparison scope",
        ));
    }
    let alternatives = frozen["manifest"]["alternatives"]
        .as_array()
        .filter(|items| items.len() == 2)
        .ok_or_else(|| failure("SOURCE_SCOPE", "Frozen comparison alternatives missing"))?;
    let mut captured = Vec::new();
    let mut identities = BTreeSet::new();
    for alternative in alternatives {
        if !alternative.is_object() {
            return Err(failure("SOURCE_SCOPE", "Invalid comparison alternative"));
        }
        if alternative["candidate_id"].is_null() {
            continue;
        }
        let id = alternative["candidate_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| failure("SOURCE_SCOPE", "Invalid captured candidate identity"))?;
        if !identities.insert(id) {
            return Err(failure(
                "SOURCE_SCOPE",
                "Duplicate comparison captured source",
            ));
        }
        captured.push(alternative);
    }
    Ok(captured)
}
pub fn evaluation_mounts(job: &Value) -> Result<Vec<SourceMountSpec>> {
    let specs = descriptors(job, true)?;
    if specs.len() != 1
        || specs[0].path != "repo"
        || specs[0].access != SourceAccess::ReadOnly
        || job["payload"]["candidate"]["revision"]["repository"] != specs[0].base.repository
        || job["payload"]["candidate"]["revision"]["commit"] != specs[0].base.commit
    {
        return Err(failure(
            "SOURCE_FENCED",
            "Evaluation view differs from exact captured source",
        ));
    }
    Ok(specs)
}
