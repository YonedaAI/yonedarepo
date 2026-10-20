//! Bounded verified streams into root-owned temporary files; keys/hashes are never caller selectors.
use crate::{
    source_capture_api::{CaptureApi, bounded, failure},
    source_capture_diff::SnapshotFile,
    source_git::SourceGitObjects,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use tokio::io::AsyncWriteExt;
use yoneda_agents_core::{
    Result,
    source_workspace::{ContentRef, FileMode, MAX_FILE_BYTES, SourceBinding, SourceFile},
};

pub(crate) async fn download(
    api: &CaptureApi,
    file: &SourceFile,
    kind: &str,
    destination: &Path,
    objects: &SourceGitObjects,
) -> Result<(SnapshotFile, String)> {
    download_with_first(api, file, kind, destination, objects, None).await
}

pub(crate) async fn download_before(
    api: &CaptureApi,
    binding: &SourceBinding,
    path: &str,
    entry: &crate::source_git_tree::TreeEntry,
    destination: &Path,
    objects: &SourceGitObjects,
) -> Result<(SnapshotFile, String, SourceFile)> {
    let response = api
        .request(
            "blob",
            json!({"path":path,"kind":"before","offset":0,"limit":65536}),
        )
        .await?;
    let size = response
        .headers()
        .get("x-yoneda-source-size")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| failure("Canonical before byte length is missing"))?;
    let mode = match entry.mode {
        0o100644 => FileMode::Regular,
        0o100755 => FileMode::Executable,
        _ => return Err(failure("Before snapshot is not a regular file")),
    };
    let file = SourceFile {
        path: path.into(),
        mode,
        size,
        content: ContentRef::Git {
            repository: binding.base.repository.clone(),
            commit: binding.base.commit.clone(),
            path: path.into(),
            blob: entry.oid.clone(),
        },
    };
    let (snapshot, oid) =
        download_with_first(api, &file, "before", destination, objects, Some(response)).await?;
    Ok((snapshot, oid, file))
}

async fn download_with_first(
    api: &CaptureApi,
    file: &SourceFile,
    kind: &str,
    destination: &Path,
    objects: &SourceGitObjects,
    mut first: Option<reqwest::Response>,
) -> Result<(SnapshotFile, String)> {
    file.validate()?;
    if !["before", "after", "override"].contains(&kind) || file.size > MAX_FILE_BYTES {
        return Err(failure("Blob exceeds sealed source capability"));
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options
        .open(destination)
        .await
        .map_err(|_| failure("Private capture spool unavailable"))?;
    let mut hash = Sha256::new();
    let mut offset = 0u64;
    loop {
        let length = (file.size - offset).min(65536);
        let response = if let Some(response) = first.take() {
            response
        } else {
            api.request(
                "blob",
                json!({"path":file.path,"kind":kind,"offset":offset,"limit":length.max(1)}),
            )
            .await?
        };
        let range = if length == 0 {
            format!("bytes */{}", file.size)
        } else {
            format!(
                "bytes {offset}-{}/{size}",
                offset + length - 1,
                size = file.size
            )
        };
        let mode = if file.mode == FileMode::Executable {
            "100755"
        } else {
            "100644"
        };
        if response
            .headers()
            .get("x-yoneda-source-mode")
            .and_then(|v| v.to_str().ok())
            != Some(mode)
        {
            return Err(failure("Blob mode differs from frozen source metadata"));
        }
        if response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            != Some(range.as_str())
        {
            return Err(failure("Blob range differs from frozen file metadata"));
        }
        if let ContentRef::R2 { sha256, .. } = &file.content
            && response
                .headers()
                .get("x-source-sha256")
                .and_then(|v| v.to_str().ok())
                != Some(sha256)
        {
            return Err(failure("Blob stream SHA differs from sealed ticket"));
        }
        let bytes = bounded(response, 65536).await?;
        if bytes.len() as u64 != length {
            return Err(failure(
                "Blob stream is truncated or exceeds requested range",
            ));
        }
        hash.update(&bytes);
        output
            .write_all(&bytes)
            .await
            .map_err(|_| failure("Capture spool write failed"))?;
        offset += length;
        if offset == file.size {
            break;
        }
    }
    output
        .flush()
        .await
        .map_err(|_| failure("Capture spool flush failed"))?;
    drop(output);
    if let ContentRef::R2 { sha256, .. } = &file.content
        && yoneda_agents_core::hex(&hash.finalize()) != *sha256
    {
        return Err(failure(
            "Received R2 bytes differ from immutable sealed digest",
        ));
    }
    let input = fs::File::open(destination).map_err(|_| failure("Verified spool unavailable"))?;
    let oid = objects
        .hash_reader("blob", file.size, input)
        .map_err(|_| failure("Trusted blob hashing failed"))?;
    if let ContentRef::Git { blob, .. } = &file.content
        && &oid != blob
    {
        return Err(failure(
            "Received Git bytes differ from approved blob identity",
        ));
    }
    Ok((
        SnapshotFile {
            file: destination.into(),
            executable: file.mode == FileMode::Executable,
        },
        oid,
    ))
}
