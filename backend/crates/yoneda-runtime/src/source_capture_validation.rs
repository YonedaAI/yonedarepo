//! Validated metadata planning for registered, sealed API-source capture.
use std::collections::BTreeMap;
use yoneda_agents_core::{
    Result,
    source_changeset::SourceChangeset,
    source_workspace::{
        BaselineOverride, ContentRef, SourceAccess, SourceBinding, SourceFile, SourceView, invalid,
        merged_baseline, validate_files, view_digest,
    },
};

/// Caller obtains this envelope from the active capture job's registered seal, never model kwargs.
/// This validates metadata; the adapter still verifies source bytes, trees and remote readback.
#[cfg(test)]
pub(crate) fn capture_delta(
    binding: &SourceBinding,
    view: &SourceView,
    overrides: &[BaselineOverride],
    changeset: &SourceChangeset,
    digest: &str,
) -> Result<BTreeMap<String, Option<SourceFile>>> {
    changeset.validate(binding)?;
    if binding.access != SourceAccess::ReadWrite
        || view.base != binding.base
        || changeset.baseline_overrides != overrides
        || view_digest(view, overrides)? != binding.view_digest
        || changeset.digest()? != digest
    {
        return Err(invalid(
            "Capture differs from registered frozen source metadata",
        ));
    }
    for oid in binding
        .parents
        .iter()
        .chain(std::iter::once(&binding.base.tree))
    {
        crate::source_git_tree::validate_oid(oid)
            .map_err(|_| invalid("Artifacts v1 capture requires Git SHA-1"))?;
    }
    let mut final_files = merged_baseline(view, overrides)?;
    for file in final_files.values() {
        validate_content(binding, file)?;
    }
    for change in &changeset.changes {
        if final_files.get(&change.path) != change.before.as_ref() {
            return Err(invalid(
                "Changeset before state differs from frozen merged baseline",
            ));
        }
        match &change.after {
            Some(file) => {
                validate_content(binding, file)?;
                final_files.insert(change.path.clone(), file.clone());
            }
            None => {
                final_files.remove(&change.path);
            }
        }
    }
    validate_files(&final_files)?;
    let original = view
        .files
        .iter()
        .map(|f| (f.path.clone(), f))
        .collect::<BTreeMap<_, _>>();
    let mut delta = BTreeMap::new();
    for (path, file) in &final_files {
        if !original.get(path).is_some_and(|old| equivalent(old, file)) {
            delta.insert(path.clone(), Some(file.clone()));
        }
    }
    for path in original.keys() {
        if !final_files.contains_key(path) {
            delta.insert(path.clone(), None);
        }
    }
    Ok(delta)
}

fn validate_content(binding: &SourceBinding, file: &SourceFile) -> Result<()> {
    file.validate()?;
    match &file.content {
        ContentRef::Git {
            repository,
            commit,
            blob,
            path,
        } => {
            yoneda_agents_core::validate_path(path)?;
            crate::source_git_tree::validate_oid(blob)
                .map_err(|_| invalid("Artifacts v1 blob requires Git SHA-1"))?;
            if !binding
                .inputs
                .iter()
                .any(|input| &input.repository == repository && &input.commit == commit)
            {
                return Err(invalid("Git content is outside approved captured inputs"));
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
                return Err(invalid(
                    "Changed R2 bytes are outside the sealed attempt view",
                ));
            }
        }
    }
    Ok(())
}

fn equivalent(before: &SourceFile, after: &SourceFile) -> bool {
    if before.mode != after.mode || before.size != after.size {
        return false;
    }
    match (&before.content, &after.content) {
        (ContentRef::Git { blob: a, .. }, ContentRef::Git { blob: b, .. }) => a == b,
        (a, b) => a == b,
    }
}
