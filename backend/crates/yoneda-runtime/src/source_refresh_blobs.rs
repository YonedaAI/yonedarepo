//! Fetch only metadata-derived changed paths, as bounded hash-verified ranges into private spools.
use crate::{
    source_capture_api::bounded, source_capture_diff::SnapshotFile, source_git::SourceGitObjects,
    source_git_tree::TreeEntry, source_refresh_api::Api, source_refresh_plan::error,
};
use serde_json::json;
use std::{fs, path::Path};
use tokio::io::AsyncWriteExt;
use yoneda_agents_core::{Result, source_workspace::MAX_FILE_BYTES};
pub(crate) struct Blob {
    pub file: std::path::PathBuf,
    pub size: u64,
    pub oid: String,
}
impl Blob {
    pub fn snapshot(&self, mode: u32) -> SnapshotFile {
        SnapshotFile {
            file: self.file.clone(),
            executable: mode == 0o100755,
        }
    }
}
pub(crate) async fn download(
    api: &Api,
    store: &SourceGitObjects,
    input: &str,
    path: &str,
    entry: &TreeEntry,
    destination: &Path,
    total: &mut u64,
) -> Result<Blob> {
    let mut first = Some(
        api.request(
            "blob",
            json!({"input":input,"path":path,"offset":0,"limit":65536}),
        )
        .await?,
    );
    let size = first
        .as_ref()
        .and_then(|r| r.headers().get("x-yoneda-source-size"))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s <= MAX_FILE_BYTES)
        .ok_or_else(|| error("Refresh blob exceeds regular-file bound"))?;
    *total = total
        .checked_add(size)
        .filter(|v| *v <= 300 * 1024 * 1024)
        .ok_or_else(|| error("Refresh changed body union exceeds bound"))?;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options
        .open(destination)
        .await
        .map_err(|_| error("Private refresh spool unavailable"))?;
    let mut offset = 0;
    loop {
        let length = (size - offset).min(65536);
        let response = if let Some(r) = first.take() {
            r
        } else {
            api.request(
                "blob",
                json!({"input":input,"path":path,"offset":offset,"limit":length.max(1)}),
            )
            .await?
        };
        let range = if length == 0 {
            format!("bytes */{size}")
        } else {
            format!("bytes {offset}-{}/{size}", offset + length - 1)
        };
        let mode = if entry.mode == 0o100755 {
            "100755"
        } else {
            "100644"
        };
        if response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            != Some(range.as_str())
            || response
                .headers()
                .get("x-yoneda-source-mode")
                .and_then(|v| v.to_str().ok())
                != Some(mode)
        {
            return Err(error("Refresh blob differs from frozen range/mode"));
        }
        let bytes = bounded(response, 65536).await?;
        if bytes.len() as u64 != length {
            return Err(error("Refresh byte stream truncated or oversized"));
        }
        output
            .write_all(&bytes)
            .await
            .map_err(|_| error("Refresh spool write failed"))?;
        offset += length;
        if offset == size {
            break;
        }
    }
    output
        .flush()
        .await
        .map_err(|_| error("Refresh spool flush failed"))?;
    drop(output);
    let oid = store
        .hash_reader(
            "blob",
            size,
            fs::File::open(destination).map_err(|_| error("Refresh spool missing"))?,
        )
        .map_err(|_| error("Refresh blob hash failed"))?;
    if oid != entry.oid {
        return Err(error("Refresh bytes differ from approved Git identity"));
    }
    Ok(Blob {
        file: destination.into(),
        size,
        oid,
    })
}
