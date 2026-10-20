//! Immutable compiled app artifacts captured only by the clean evaluator.
use crate::err;
use serde_json::Value;
use std::path::Path;
use yoneda_agents_core::{Policy, Result};
/// Matches the trusted app-bundle broker upload ceiling.
const MAX_BUNDLE_BYTES: usize = 2 * 1024 * 1024;
/// Capture after all candidate processes stop; `revision` is the evaluator's captured Git commit.
/// The caller stores `encode` bytes using create-only `sha256/<digest>` R2 semantics.
pub fn capture(root: &Path, revision: &str, policy: &Policy) -> Result<Value> {
    yoneda_agents_core::build::validate_policy(policy)?;
    if ![40, 64].contains(&revision.len())
        || !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(err("Invalid captured application revision"));
    }
    let manifest = policy
        .build
        .as_ref()
        .and_then(|p| p.app.as_ref())
        .ok_or_else(|| err("Missing owner-approved app manifest"))?;
    manifest.validate()?;
    // Read the entrypoint first with descriptor-relative O_NOFOLLOW for every component.
    crate::secure_fs::read_regular(root, &manifest.entrypoint)?;
    let parent = Path::new(&manifest.entrypoint)
        .parent()
        .ok_or_else(|| err("Missing app directory"))?;
    let directory = root.join(parent);
    let mut modules = std::collections::BTreeMap::new();
    let mut total = 0usize;
    for entry in walkdir::WalkDir::new(&directory).follow_links(false) {
        let entry = entry.map_err(err)?;
        if entry.file_type().is_symlink()
            || (!entry.file_type().is_file() && !entry.file_type().is_dir())
        {
            return Err(err(
                "Application artifacts require regular files and directories",
            ));
        }
        if entry.file_type().is_dir() {
            continue;
        }
        let path = entry
            .path()
            .strip_prefix(&directory)
            .map_err(err)?
            .to_str()
            .ok_or_else(|| err("Non-UTF8 app module path"))?;
        yoneda_agents_core::validate_path(path)?;
        if path
            .split('/')
            .any(|part| part == "node_modules" || part.starts_with("_yoneda_"))
        {
            return Err(err("Forbidden application module path"));
        }
        if !["js", "mjs"].contains(&path.rsplit('.').next().unwrap_or("")) {
            continue;
        }
        let relative = parent.join(path);
        let source = crate::secure_fs::read_regular(
            root,
            relative.to_str().ok_or_else(|| err("Non-UTF8 module"))?,
        )?;
        let bytes = source.bytes()?;
        total = total.saturating_add(bytes.len());
        if total > MAX_BUNDLE_BYTES || modules.len() >= yoneda_agents_core::MAX_FILES {
            return Err(err("Application bundle exceeds resource limits"));
        }
        modules.insert(path.to_owned(), String::from_utf8(bytes).map_err(err)?);
    }
    let main = Path::new(&manifest.entrypoint)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| err("Missing app entrypoint filename"))?;
    if !modules.contains_key(main) {
        return Err(err("Missing compiled app entrypoint"));
    }
    let policy_digest = yoneda_agents_core::build::policy_digest(policy)?;
    Ok(
        serde_json::json!({"version":1,"revision":revision,"policy_digest":policy_digest,
        "manifest":manifest,"modules":modules}),
    )
}
pub fn encode(root: &Path, revision: &str, policy: &Policy) -> Result<(String, String)> {
    let value = capture(root, revision, policy)?;
    let text = serde_json::to_string(&value).map_err(err)?;
    if text.len() > MAX_BUNDLE_BYTES {
        return Err(err("Encoded application bundle exceeds 2 MiB"));
    }
    let digest = yoneda_agents_core::digest(text.as_bytes());
    Ok((text, digest))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn policy() -> Policy {
        serde_json::from_value(json!({"version":"v1","suite":"commands-v1",
            "environment":yoneda_agents_core::build::ENVIRONMENT,"required_checks":["app"],
            "build":{"checks":[{"name":"app","argv":["true"],"timeout_seconds":1}],
            "app":{"version":1,"entrypoint":"dist/worker.js","export_name":"App",
            "migrations":[{"version":1,"sql":["CREATE TABLE notes (id TEXT)"]}],"seed":[]}}}))
        .unwrap()
    }
    #[test]
    fn pins_revision_policy_and_compiled_bytes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("dist")).unwrap();
        std::fs::write(root.path().join("dist/worker.js"), "export class App {}").unwrap();
        let policy = policy();
        let (text, digest) = encode(root.path(), &"a".repeat(40), &policy).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["revision"], "a".repeat(40));
        assert_eq!(
            value["policy_digest"],
            yoneda_agents_core::build::policy_digest(&policy).unwrap()
        );
        assert_eq!(value["modules"]["worker.js"], "export class App {}");
        assert_eq!(digest, yoneda_agents_core::digest(text.as_bytes()));
        std::fs::write(root.path().join("dist/worker.js"), "changed").unwrap();
        assert_ne!(
            encode(root.path(), &"a".repeat(40), &policy).unwrap().1,
            digest
        );
    }
    #[test]
    fn refuses_symlinked_artifact_directory_and_reserved_host_module() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("worker.js"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("dist")).unwrap();
        assert!(capture(root.path(), &"a".repeat(40), &policy()).is_err());
        std::fs::remove_file(root.path().join("dist")).unwrap();
        std::fs::create_dir(root.path().join("dist")).unwrap();
        std::fs::write(root.path().join("dist/worker.js"), "export class App {}").unwrap();
        std::fs::write(root.path().join("dist/_yoneda_managed.js"), "shadow").unwrap();
        assert!(capture(root.path(), &"a".repeat(40), &policy()).is_err());
    }
}
