//! Compact source capture context returned only by the current root capture boundary.
use serde_json::Value;
use yoneda_core::{
    Result,
    source_workspace::{SourceAccess, SourceBinding, invalid, validate_hash, validate_id},
};
pub(crate) struct CaptureContext {
    pub binding: SourceBinding,
    pub digest: String,
    pub header: Value,
}
impl CaptureContext {
    pub fn decode(value: Value) -> Result<Self> {
        if value["version"] != 1 || !value["manifest_cursor"].is_null() {
            return Err(invalid("Invalid initial capture context"));
        }
        let binding: SourceBinding = serde_json::from_value(value["binding"].clone())
            .map_err(|_| invalid("Capture binding violates source contract"))?;
        binding.validate()?;
        if binding.access != SourceAccess::ReadWrite
            || value["view_digest"] != binding.view_digest
            || value["baseline_overrides_digest"] != binding.baseline_overrides_digest
            || value["base"]
                != serde_json::to_value(&binding.base)
                    .map_err(|_| invalid("Invalid base encoding"))?
            || value["parents"]
                != serde_json::to_value(&binding.parents)
                    .map_err(|_| invalid("Invalid parents encoding"))?
        {
            return Err(invalid("Capture context differs from its frozen binding"));
        }
        let seal = &value["seal"];
        if seal["workspace_id"] != binding.workspace_id
            || seal["workspace_version"] != value["manifest_header"]["workspace_version"]
        {
            return Err(invalid("Capture seal differs from its immutable workspace"));
        }
        for key in ["seal_id", "checkpoint_id"] {
            validate_id(
                seal[key]
                    .as_str()
                    .ok_or_else(|| invalid("Registered seal identity missing"))?,
            )?;
        }
        let digest = seal["changeset_digest"]
            .as_str()
            .ok_or_else(|| invalid("Registered seal digest missing"))?
            .to_owned();
        validate_hash(&digest, &[64])?;
        for input in &binding.inputs {
            crate::source_git_tree::validate_oid(&input.commit)
                .map_err(|_| invalid("Artifacts v1 commit requires SHA-1"))?;
            crate::source_git_tree::validate_oid(&input.tree)
                .map_err(|_| invalid("Artifacts v1 tree requires SHA-1"))?;
        }
        for parent in &binding.parents {
            if !binding.inputs.iter().any(|input| &input.commit == parent) {
                return Err(invalid("Frozen parent is outside approved Git inputs"));
            }
        }
        Ok(Self {
            binding,
            digest,
            header: value["manifest_header"].clone(),
        })
    }
}
