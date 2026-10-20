//! Three-way merge of touched regular files only; conflicts retain the frozen head's source.
use crate::{
    source_capture_diff::SnapshotFile,
    source_git::SourceGitObjects,
    source_git_rewrite::TreeEdit,
    source_refresh_api::Api,
    source_refresh_blobs::{Blob, download},
    source_refresh_plan::{Files, Plan, error},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
    process::{Command, Stdio},
};
use yoneda_agents_core::{Result, source_workspace::MAX_FILE_BYTES};
pub(crate) struct Merged {
    pub edits: BTreeMap<String, TreeEdit>,
    pub conflicts: BTreeSet<String>,
    pub before: BTreeMap<String, SnapshotFile>,
    pub after: BTreeMap<String, SnapshotFile>,
}
pub(crate) async fn merge(
    api: &Api,
    store: &mut SourceGitObjects,
    directory: &Path,
    base: &Files,
    head: &Files,
    candidate: &Files,
    plan: &Plan,
) -> Result<Merged> {
    let mut result = Merged {
        edits: BTreeMap::new(),
        conflicts: plan.structural.clone(),
        before: BTreeMap::new(),
        after: BTreeMap::new(),
    };
    let mut total = 0;
    for (index, path) in plan.captured.iter().enumerate() {
        if !plan.union.contains(path) {
            return Err(error("Refresh path outside derived changed union"));
        }
        let b = base.get(path);
        let h = head.get(path);
        let c = candidate.get(path);
        if plan.structural.contains(path)
            || h.is_some_and(|h| c.is_some_and(|c| h.oid == c.oid && h.mode == c.mode))
            || h.is_none() && c.is_none()
        {
            continue;
        }
        let overlap = plan.overlapping.contains(path);
        if overlap && (b.is_none() || h.is_none() || c.is_none()) {
            result.conflicts.insert(path.clone());
            continue;
        }
        let mut head_bytes = None;
        let mut candidate_bytes = None;
        if let Some(entry) = h {
            head_bytes = Some(
                download(
                    api,
                    store,
                    "head",
                    path,
                    entry,
                    &directory.join(format!("{index}.head")),
                    &mut total,
                )
                .await?,
            );
        }
        if let Some(entry) = c {
            candidate_bytes = Some(
                download(
                    api,
                    store,
                    "candidate",
                    path,
                    entry,
                    &directory.join(format!("{index}.candidate")),
                    &mut total,
                )
                .await?,
            );
        }
        let selected = if overlap {
            let b = b.ok_or_else(|| error("Base metadata missing"))?;
            let h = h.ok_or_else(|| error("Head metadata missing"))?;
            let c = c.ok_or_else(|| error("Candidate metadata missing"))?;
            let mode = if c.mode == b.mode {
                h.mode
            } else if h.mode == b.mode || c.mode == h.mode {
                c.mode
            } else {
                result.conflicts.insert(path.clone());
                continue;
            };
            if c.oid == b.oid || c.oid == h.oid {
                head_bytes.as_ref().map(|v| (v, mode))
            } else if h.oid == b.oid {
                candidate_bytes.as_ref().map(|v| (v, mode))
            } else {
                let base_bytes = download(
                    api,
                    store,
                    "base",
                    path,
                    b,
                    &directory.join(format!("{index}.base")),
                    &mut total,
                )
                .await?;
                let Some(merged) = merge_text(
                    store,
                    directory,
                    index,
                    head_bytes
                        .as_ref()
                        .ok_or_else(|| error("Head bytes missing"))?,
                    &base_bytes,
                    candidate_bytes
                        .as_ref()
                        .ok_or_else(|| error("Candidate bytes missing"))?,
                )?
                else {
                    result.conflicts.insert(path.clone());
                    continue;
                };
                candidate_bytes = Some(merged);
                candidate_bytes.as_ref().map(|v| (v, mode))
            }
        } else {
            candidate_bytes.as_ref().zip(c).map(|(v, e)| (v, e.mode))
        };
        match selected {
            Some((bytes, mode)) => {
                if h.is_some_and(|h| h.oid == bytes.oid && h.mode == mode) {
                    continue;
                }
                result.edits.insert(
                    path.clone(),
                    TreeEdit::Set {
                        mode,
                        oid: bytes.oid.clone(),
                    },
                );
                result.after.insert(path.clone(), bytes.snapshot(mode));
            }
            None => {
                result.edits.insert(path.clone(), TreeEdit::Delete);
            }
        }
        if let (Some(bytes), Some(entry)) = (&head_bytes, h) {
            result
                .before
                .insert(path.clone(), bytes.snapshot(entry.mode));
        }
    }
    Ok(result)
}
fn merge_text(
    store: &mut SourceGitObjects,
    root: &Path,
    index: usize,
    head: &Blob,
    base: &Blob,
    candidate: &Blob,
) -> Result<Option<Blob>> {
    for blob in [head, base, candidate] {
        if fs::metadata(&blob.file)
            .map_err(|_| error("Touched spool missing"))?
            .len()
            != blob.size
        {
            return Err(error("Touched spool size changed"));
        }
        let bytes = fs::read(&blob.file).map_err(|_| error("Touched refresh file unavailable"))?;
        if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            return Ok(None);
        }
    }
    let mut child = Command::new("/usr/bin/git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.attributesFile=/dev/null",
            "merge-file",
            "-p",
            "-L",
            "head",
            "-L",
            "base",
            "-L",
            "candidate",
            "--",
        ])
        .arg(&head.file)
        .arg(&base.file)
        .arg(&candidate.file)
        .current_dir(root)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| error("Trusted merge-file unavailable"))?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| error("Merge output missing"))?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Merge output interrupted"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error("Touched merge output exceeds file bound"));
    }
    let status = child
        .wait()
        .map_err(|_| error("Merge-file did not complete"))?;
    match status.code() {
        Some(0) => {
            let file = root.join(format!("{index}.merged"));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            options
                .open(&file)
                .map_err(|_| error("Merge spool unavailable"))?
                .write_all(&bytes)
                .map_err(|_| error("Merge spool write failed"))?;
            let oid = store
                .write("blob", &bytes)
                .map_err(|_| error("Trusted merged blob construction failed"))?;
            Ok(Some(Blob {
                file,
                size: bytes.len() as u64,
                oid,
            }))
        }
        Some(1..=127) => Ok(None),
        _ => Err(error("Merge-file failed without conflict status")),
    }
}
