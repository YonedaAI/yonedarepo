//! Resume an interrupted attempt from its staged files instead of starting over.
//!
//! The Worker returns the previous attempt's staged files (identity from the claimed job and a
//! ledger-signed read-only grant). They are written through this attempt's own scoped mount, so
//! the normal write-path authorization, versioning and capture apply to them exactly as if the
//! agent had written them. Resume is best effort: if it fails, the attempt starts fresh.
use base64::Engine;
use serde_json::{Value, json};
use std::path::Path;
use yoneda_agents_core::Result;

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Restored {
    pub(crate) written: Vec<String>,
    pub(crate) removed: Vec<String>,
    pub(crate) skipped: Vec<String>,
}

pub(crate) async fn restore(job: &Value, root: &Path) -> Option<String> {
    // Only a claim carrying a ledger-recorded checkpoint asks the Worker for staged files.
    job["resume"]["workspace_id"].as_str()?;
    let manifest = match crate::broker::broker("/resume", json!({}), true).await {
        Ok(manifest) => manifest,
        Err(error) => {
            tracing::warn!(event = "attempt.resume_unavailable", error_code = %error.code);
            return None;
        }
    };
    let root = root.to_path_buf();
    let applied = tokio::task::spawn_blocking({
        let manifest = manifest.clone();
        move || apply(&root, &manifest)
    })
    .await;
    match applied {
        Ok(Ok(restored)) => {
            tracing::info!(
                event = "attempt.resumed",
                written = restored.written.len(),
                removed = restored.removed.len(),
                skipped = restored.skipped.len()
            );
            note(&manifest, &restored)
        }
        Ok(Err(error)) => {
            tracing::warn!(event = "attempt.resume_failed", error_code = %error.code);
            None
        }
        Err(_) => None,
    }
}

/// Write staged files into the mounted working tree; one bad entry never aborts the rest.
pub(crate) fn apply(root: &Path, manifest: &Value) -> Result<Restored> {
    let mut restored = Restored::default();
    let engine = base64::engine::general_purpose::STANDARD;
    for file in manifest["files"].as_array().into_iter().flatten() {
        let Some(path) = file["path"].as_str() else {
            continue;
        };
        let written = yoneda_agents_core::validate_path(path)
            .ok()
            .and_then(|()| engine.decode(file["content_base64"].as_str()?).ok())
            .and_then(|bytes| write(root, path, &bytes, file["mode"] == "100755").ok());
        if written.is_some() {
            restored.written.push(path.to_owned());
        } else {
            restored.skipped.push(path.to_owned());
        }
    }
    for path in manifest["deleted"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let removed = yoneda_agents_core::validate_path(path).is_ok()
            && match std::fs::remove_file(root.join(path)) {
                Ok(()) => true,
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            };
        if removed {
            restored.removed.push(path.to_owned());
        } else {
            restored.skipped.push(path.to_owned());
        }
    }
    for path in manifest["skipped"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        restored.skipped.push(path.to_owned());
    }
    Ok(restored)
}

fn write(root: &Path, path: &str, bytes: &[u8], executable: bool) -> std::io::Result<()> {
    let target = root.join(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if executable { 0o755 } else { 0o644 };
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

/// Prompt addendum telling the agent it is continuing, not starting over.
pub(crate) fn note(manifest: &Value, restored: &Restored) -> Option<String> {
    if restored.written.is_empty() && restored.removed.is_empty() {
        return None;
    }
    let listed = restored
        .written
        .iter()
        .take(50)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let more = restored.written.len().saturating_sub(50);
    let mut text = format!(
        "Resuming this task. The previous attempt (attempt epoch {}) stopped ({}) before finishing. Its staged work was restored into this workspace: {} file(s) written{}{}.",
        manifest["epoch"],
        manifest["reason"].as_str().unwrap_or("interrupted"),
        restored.written.len(),
        if listed.is_empty() {
            String::new()
        } else {
            format!(
                " ({listed}{})",
                if more > 0 {
                    format!(", and {more} more")
                } else {
                    String::new()
                }
            )
        },
        if restored.removed.is_empty() {
            String::new()
        } else {
            format!(", {} removed", restored.removed.len())
        },
    );
    if !restored.skipped.is_empty() {
        text.push_str(&format!(
            " {} file(s) could not be restored and may need to be redone.",
            restored.skipped.len()
        ));
    }
    text.push_str(" Inspect these files first and continue from where it stopped. Do not start over or rewrite working files.");
    Some(text)
}

#[cfg(test)]
#[path = "tests/attempt_resume.rs"]
mod tests;
