//! Compose exact retained overrides and sealed edits; source membership is checked against Git trees.
use std::collections::BTreeMap;
use yoneda_core::{
    Result,
    source_changeset::SourceChangeset,
    source_workspace::{ContentRef, SourceAccess, SourceBinding, SourceFile, invalid},
};
pub(crate) fn manifest_delta(
    binding: &SourceBinding,
    manifest: &SourceChangeset,
    digest: &str,
) -> Result<BTreeMap<String, Option<SourceFile>>> {
    manifest.validate(binding)?;
    if binding.access != SourceAccess::ReadWrite || manifest.digest()? != digest {
        return Err(invalid(
            "Capture manifest differs from registered writable seal",
        ));
    }
    let mut delta = BTreeMap::new();
    let mut previous = "";
    for item in &manifest.baseline_overrides {
        yoneda_core::validate_path(&item.path)?;
        if item.path.as_str() <= previous {
            return Err(invalid("Baseline overrides are not sorted unique"));
        }
        previous = &item.path;
        if let Some(file) = &item.file {
            validate_content(binding, file)?;
            if file.path != item.path {
                return Err(invalid("Override source path differs"));
            }
        }
        delta.insert(item.path.clone(), item.file.clone());
    }
    for change in &manifest.changes {
        if let Some(override_file) = delta.get(&change.path) {
            if override_file != &change.before {
                return Err(invalid(
                    "Before state differs from retained specialist baseline",
                ));
            }
        } else if let Some(before) = &change.before {
            validate_content(binding, before)?;
            if !matches!(&before.content,ContentRef::Git{repository,commit,path,..} if repository==&binding.base.repository&&commit==&binding.base.commit&&path==&change.path)
            {
                return Err(invalid(
                    "Unchanged-baseline before pointer is not canonical base content",
                ));
            }
        }
        if let Some(after) = &change.after {
            validate_content(binding, after)?;
        }
        delta.insert(change.path.clone(), change.after.clone());
    }
    Ok(delta)
}
pub(crate) fn validate_content(binding: &SourceBinding, file: &SourceFile) -> Result<()> {
    file.validate()?;
    match &file.content {
        ContentRef::Git {
            repository,
            commit,
            blob,
            ..
        } => {
            crate::source_git_tree::validate_oid(blob)
                .map_err(|_| invalid("Artifacts v1 blob requires Git SHA-1"))?;
            if !binding
                .inputs
                .iter()
                .any(|input| &input.repository == repository && &input.commit == commit)
            {
                return Err(invalid("Git bytes are outside frozen approved inputs"));
            }
        }
        ContentRef::R2 {
            key,
            sha256,
            ticket_id,
            ..
        } => {
            if key
                != &format!(
                    "source/v1/{}/uploads/{ticket_id}/{sha256}",
                    binding.workspace_id
                )
            {
                return Err(invalid("R2 bytes are outside sealed attempt view"));
            }
        }
    }
    Ok(())
}
