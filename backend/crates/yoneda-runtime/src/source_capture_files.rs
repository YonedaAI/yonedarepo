//! Only touched canonical-before/final-after streams; all input membership is checked first.
use crate::{
    source_capture_api::{CaptureApi, failure},
    source_capture_blobs::{download, download_before},
    source_capture_diff::SnapshotFile,
    source_capture_plan::manifest_delta,
    source_capture_trees::TreeCache,
    source_git::SourceGitObjects,
    source_git_rewrite::TreeEdit,
    source_git_tree::TreeEntry,
};
use std::{collections::BTreeMap, fs, path::Path};
use yoneda_core::{
    Result,
    source_changeset::SourceChangeset,
    source_workspace::{ContentRef, FileMode, SourceBinding, SourceFile},
};
pub(crate) struct CaptureFiles {
    pub before: BTreeMap<String, SnapshotFile>,
    pub after: BTreeMap<String, SnapshotFile>,
    pub edits: BTreeMap<String, TreeEdit>,
}
pub(crate) async fn prepare(
    api: &CaptureApi,
    binding: &SourceBinding,
    manifest: &SourceChangeset,
    digest: &str,
    directory: &Path,
    objects: &mut SourceGitObjects,
    trees: &mut TreeCache,
) -> Result<CaptureFiles> {
    let delta = manifest_delta(binding, manifest, digest)?;
    let mut result = CaptureFiles {
        before: BTreeMap::new(),
        after: BTreeMap::new(),
        edits: BTreeMap::new(),
    };
    for (index, (path, after)) in delta.iter().enumerate() {
        let original = trees
            .lookup(api, objects, &binding.base, path, None)
            .await?;
        validate_before(manifest, path, original.as_ref())?;
        if let Some(file) = after {
            verify_input(api, binding, file, objects, trees).await?;
        }
        if let (Some(entry), Some(file)) = (&original, after)
            && entry.mode == mode(file)
            && matches!(&file.content,ContentRef::Git{blob,..} if blob==&entry.oid)
        {
            continue;
        }
        if original.is_none() && after.is_none() {
            continue;
        }
        if original
            .as_ref()
            .is_some_and(|entry| entry.mode == 0o040000)
        {
            let entry = original
                .as_ref()
                .ok_or_else(|| failure("Directory metadata missing"))?;
            trees
                .directory(api, objects, path, &entry.oid, None)
                .await?;
        }
        let mut before_identity = None;
        if let Some(entry) = original.as_ref().filter(|entry| entry.mode != 0o040000) {
            let (snapshot, oid, file) = download_before(
                api,
                binding,
                path,
                entry,
                &directory.join(format!("{index}.before")),
                objects,
            )
            .await?;
            if let Some(change) = manifest.changes.iter().find(|c| c.path == *path)
                && !manifest.baseline_overrides.iter().any(|o| o.path == *path)
                && change
                    .before
                    .as_ref()
                    .is_some_and(|claimed| claimed.size != file.size)
            {
                return Err(failure("Before byte size differs from frozen manifest"));
            }
            before_identity = Some((oid, file.mode));
            result.before.insert(path.clone(), snapshot);
        }
        match after {
            Some(file) => {
                let (snapshot, oid) = download(
                    api,
                    file,
                    "after",
                    &directory.join(format!("{index}.after")),
                    objects,
                )
                .await?;
                if before_identity
                    .as_ref()
                    .is_some_and(|(before, old_mode)| before == &oid && old_mode == &file.mode)
                {
                    result.before.remove(path);
                    continue;
                }
                // Base-linked byte identity is already in the exact-base destination closure.
                let retained_base_blob = matches!(&file.content, ContentRef::Git {repository,commit,..} if repository == &binding.base.repository && commit == &binding.base.commit);
                if !retained_base_blob
                    && before_identity
                        .as_ref()
                        .is_none_or(|(before, _)| before != &oid)
                {
                    let actual = objects
                        .write_reader(
                            "blob",
                            file.size,
                            fs::File::open(&snapshot.file)
                                .map_err(|_| failure("Verified file unavailable"))?,
                        )
                        .map_err(|_| failure("Trusted blob construction failed"))?;
                    if actual != oid {
                        return Err(failure("Verified spool changed before object construction"));
                    }
                }
                result.edits.insert(
                    path.clone(),
                    TreeEdit::Set {
                        mode: mode(file),
                        oid,
                    },
                );
                result.after.insert(path.clone(), snapshot);
            }
            None => {
                result.edits.insert(path.clone(), TreeEdit::Delete);
            }
        }
    }
    Ok(result)
}
fn mode(file: &SourceFile) -> u32 {
    if file.mode == FileMode::Executable {
        0o100755
    } else {
        0o100644
    }
}
fn validate_before(
    manifest: &SourceChangeset,
    path: &str,
    entry: Option<&TreeEntry>,
) -> Result<()> {
    if manifest.baseline_overrides.iter().any(|o| o.path == path) {
        return Ok(());
    }
    let Some(change) = manifest.changes.iter().find(|c| c.path == path) else {
        return Ok(());
    };
    match (&change.before, entry) {
        (None, None) => Ok(()),
        (None, Some(e)) if e.mode == 0o040000 => Ok(()),
        (Some(before), Some(e))
            if e.mode == mode(before)
                && matches!(&before.content,ContentRef::Git{blob,..} if blob==&e.oid) =>
        {
            Ok(())
        }
        _ => Err(failure(
            "Before state differs from hash-verified canonical tree",
        )),
    }
}
async fn verify_input(
    api: &CaptureApi,
    binding: &SourceBinding,
    file: &SourceFile,
    objects: &SourceGitObjects,
    trees: &mut TreeCache,
) -> Result<()> {
    let ContentRef::Git {
        repository,
        commit,
        path,
        blob,
    } = &file.content
    else {
        return Ok(());
    };
    let (index, input) = binding
        .inputs
        .iter()
        .enumerate()
        .find(|(_, input)| &input.repository == repository && &input.commit == commit)
        .ok_or_else(|| failure("Blob source is outside approved inputs"))?;
    let alias = (input != &binding.base).then(|| format!("input-{index}"));
    let entry = trees
        .lookup(api, objects, input, path, alias.as_deref())
        .await?
        .ok_or_else(|| failure("Blob is not present at its approved origin path"))?;
    if entry.mode == 0o040000 || entry.oid != *blob {
        return Err(failure("Blob identity is not linked from approved input"));
    }
    Ok(())
}
