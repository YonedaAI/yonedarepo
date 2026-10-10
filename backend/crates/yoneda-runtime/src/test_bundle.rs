//! Fetch and install immutable owner-approved tests outside candidate source.
use crate::{broker::broker, err};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::path::Path;
use yoneda_core::{Result, Workspace, build::TestBundlePolicy};

const ROOT: &str = "/opt/yoneda/test-bundle";

pub(crate) async fn install(policy: Option<&TestBundlePolicy>) -> Result<Option<String>> {
    let Some(policy) = policy else {
        return Ok(None);
    };
    let value = broker("/test-bundle", json!({"digest":policy.digest}), true).await?;
    let files: Workspace = serde_json::from_value(value["files"].clone()).map_err(err)?;
    let digest = yoneda_core::digest(&serde_json::to_vec(&files).map_err(err)?);
    if digest != policy.digest || value["digest"] != policy.digest {
        return Err(err("Owner-approved test bundle digest mismatch"));
    }
    if files.is_empty() || files.len() > 10_000 {
        return Err(err("Invalid test bundle file count"));
    }
    let mut git_files = crate::transport::GitWorkspace::new();
    let mut total = 0usize;
    for (path, file) in &files {
        yoneda_core::validate_path(path)?;
        let bytes = match file.encoding.as_deref() {
            None => file.content.as_bytes().to_vec(),
            Some("base64") => STANDARD.decode(&file.content).map_err(err)?,
            Some(_) => return Err(err("Unsupported test bundle encoding")),
        };
        if bytes.len() > 32_000_000 {
            return Err(err("Test bundle blob exceeds 32 MB"));
        }
        total = total.saturating_add(bytes.len());
        if total > 100 * 1024 * 1024 {
            return Err(err("Test bundle exceeds 100 MiB"));
        }
        git_files.insert(
            path.clone(),
            crate::transport::GitFile {
                bytes,
                executable: file.executable,
            },
        );
    }
    let root = Path::new(ROOT);
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(err)?;
    }
    std::fs::create_dir_all(root).map_err(err)?;
    crate::transport::materialize_git(root, &git_files)?;
    for path in git_files.keys() {
        let file = root.join(path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                &file,
                std::fs::Permissions::from_mode(if git_files[path].executable {
                    0o555
                } else {
                    0o444
                }),
            )
            .map_err(err)?;
        }
    }
    for entry in walkdir::WalkDir::new(root).min_depth(0).into_iter() {
        let entry = entry.map_err(err)?;
        if !entry.file_type().is_dir() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(0o555))
                .map_err(err)?;
        }
    }
    Ok(Some(digest))
}

pub(crate) fn report_fields(
    policy: Option<&TestBundlePolicy>,
    digest: Option<&str>,
    job: &Value,
) -> Value {
    let protected_changes = job["payload"]["protected_changes"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            policy
                .map(|bundle| {
                    bundle
                        .protected_paths
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect()
                })
                .unwrap_or_default()
        });
    json!({"test_bundle_digest":digest,"protected_changes":protected_changes,
        "test_bundle_policy_digest":policy.map(|p| p.digest.as_str())})
}

#[cfg(test)]
mod tests {
    use yoneda_core::{FileEntry, Workspace};

    #[test]
    fn owner_bundle_digest_input_uses_rust_utf8_path_and_entry_field_order() {
        let mut files = Workspace::new();
        for (path, content) in [
            ("2", "two"),
            ("10", "ten"),
            ("😀", "astral"),
            ("\u{e000}", "bmp"),
        ] {
            files.insert(
                path.to_owned(),
                FileEntry::from_bytes(content.as_bytes().to_vec(), false),
            );
        }
        assert_eq!(
            serde_json::to_string(&files).unwrap(),
            r#"{"10":{"content":"ten","executable":false},"2":{"content":"two","executable":false},"":{"content":"bmp","executable":false},"😀":{"content":"astral","executable":false}}"#
        );
    }
}
