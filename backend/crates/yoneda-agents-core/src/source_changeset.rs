//! Sealed metadata delta; independent capture constructs and verifies Git objects.
use crate::{Result, source_workspace::*};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceChange {
    pub path: String,
    pub before: Option<SourceFile>,
    pub after: Option<SourceFile>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceChangeset {
    pub version: u32,
    pub transport: String,
    pub workspace_id: String,
    pub repo_id: String,
    pub run_id: String,
    pub job_id: String,
    pub epoch: i64,
    pub execution_id: String,
    pub view_digest: String,
    pub baseline_overrides: Vec<BaselineOverride>,
    pub base: SourceRevision,
    pub parents: Vec<String>,
    pub workspace_version: i64,
    pub policy_digest: String,
    pub intent_digest: String,
    pub write_paths: Vec<String>,
    pub changes: Vec<SourceChange>,
}
impl SourceChangeset {
    pub fn digest(&self) -> Result<String> {
        crate::fingerprint(
            &serde_json::to_value(self).map_err(|_| invalid("Invalid changeset encoding"))?,
        )
    }
    pub fn validate(&self, binding: &SourceBinding) -> Result<()> {
        binding.validate()?;
        if crate::fingerprint(
            &serde_json::to_value(&self.baseline_overrides)
                .map_err(|_| invalid("Invalid overrides"))?,
        )? != binding.baseline_overrides_digest
        {
            return Err(invalid("Changeset baseline overrides differ"));
        }
        if self.version != 1
            || self.transport != TRANSPORT
            || self.workspace_id != binding.workspace_id
            || self.repo_id != binding.repo_id
            || self.run_id != binding.run_id
            || self.job_id != binding.job_id
            || self.epoch != binding.epoch
            || self.execution_id != binding.execution_id
            || self.view_digest != binding.view_digest
            || self.base != binding.base
            || self.parents != binding.parents
            || self.policy_digest != binding.policy_digest
            || self.intent_digest != binding.intent_digest
            || self.write_paths != binding.write_paths
            || self.workspace_version < 0
            || self.changes.len() > MAX_FILES
        {
            return Err(invalid("Changeset differs from frozen source authority"));
        }
        let mut previous = "";
        for change in &self.changes {
            binding.authorize_path(&change.path)?;
            if change.path.as_str() <= previous || change.before == change.after {
                return Err(invalid("Changes must be sorted unique nonempty deltas"));
            }
            previous = &change.path;
            for file in change.before.iter().chain(&change.after) {
                file.validate()?;
                if file.path != change.path {
                    return Err(invalid("Changed path differs from file metadata"));
                }
            }
        }
        Ok(())
    }
}
/// Compact immutable manifest header. Delta/override arrays are served in bounded pages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceChangesetHeader {
    pub version: u32,
    pub transport: String,
    pub workspace_id: String,
    pub repo_id: String,
    pub run_id: String,
    pub job_id: String,
    pub epoch: i64,
    pub execution_id: String,
    pub view_digest: String,
    pub base: SourceRevision,
    pub parents: Vec<String>,
    pub workspace_version: i64,
    pub policy_digest: String,
    pub intent_digest: String,
    pub write_paths: Vec<String>,
}
