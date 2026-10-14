//! Capture static build output without following candidate-controlled links or ignore rules.
use serde_json::{Value, json};
use std::path::Path;
use yoneda_core::{Error, Result, Workspace};
fn failure(stage: &str, code: &str, path: Option<&str>, errno: Option<i32>) -> Error {
    let path = path.filter(|p| {
        p.len() <= 512
            && yoneda_core::validate_path(p).is_ok()
            && p.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/._-".contains(&c))
    });
    Error::new(
        "STATIC_EXPORT",
        json!({"version":1,"stage":stage,"code":code,"path":path,"errno":errno}).to_string(),
    )
}
pub(crate) fn record_failure(report: &mut Value, error: &Error) {
    report["static_error"] = json!("Static output missing, unsafe or exceeds limits");
    report["static_export_diagnostic"] = (error.code == "STATIC_EXPORT")
        .then(|| serde_json::from_str::<Value>(&error.message).ok())
        .flatten()
        .unwrap_or_else(
            || json!({"version":1,"stage":"export","code":"FAILED","path":null,"errno":null}),
        );
}
pub(crate) fn assets(root: &Path, directory: &str) -> Result<Workspace> {
    yoneda_core::validate_path(directory)
        .map_err(|_| failure("path", "UNSAFE_PATH", Some(directory), None))?;
    let static_root = root.join(directory);
    let mut files = Workspace::new();
    let mut bytes = 0usize;
    for entry in walkdir::WalkDir::new(&static_root).follow_links(false) {
        let entry = entry.map_err(|error| {
            failure(
                "walk",
                "IO",
                error
                    .path()
                    .and_then(|p| p.strip_prefix(root).ok())
                    .and_then(Path::to_str),
                error.io_error().and_then(std::io::Error::raw_os_error),
            )
        })?;
        let relative = entry.path().strip_prefix(root).ok().and_then(Path::to_str);
        if entry.file_type().is_symlink()
            || (!entry.file_type().is_dir() && !entry.file_type().is_file())
        {
            return Err(failure("entry", "UNSAFE_TYPE", relative, None));
        }
        if entry.file_type().is_dir() {
            continue;
        }
        let path = entry
            .path()
            .strip_prefix(&static_root)
            .ok()
            .and_then(Path::to_str)
            .ok_or_else(|| failure("path", "UNSAFE_PATH", None, None))?
            .to_owned();
        let relative = format!("{directory}/{path}");
        let file = crate::secure_fs::read_regular_detailed(
            root,
            &relative,
            yoneda_core::MAX_WORKSPACE_BYTES,
        )
        .map_err(|e| failure(e.stage, e.code, Some(&relative), e.errno))?;
        bytes = bytes.saturating_add(
            file.bytes()
                .map_err(|_| failure("decode", "INVALID_BYTES", Some(&relative), None))?
                .len(),
        );
        if bytes > yoneda_core::MAX_WORKSPACE_BYTES || files.len() >= yoneda_core::MAX_FILES {
            return Err(failure("limits", "WORKSPACE_LIMIT", Some(&relative), None));
        }
        files.insert(path, file);
    }
    yoneda_core::validate_workspace(&files)
        .map_err(|_| failure("workspace", "WORKSPACE_LIMIT", Some(directory), None))?;
    if !files.contains_key("index.html") {
        return Err(failure(
            "index",
            "MISSING_INDEX",
            Some(&format!("{directory}/index.html")),
            None,
        ));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn diagnostic(root: &Path, directory: &str) -> serde_json::Value {
        let error = assets(root, directory).unwrap_err();
        assert_eq!(error.code, "STATIC_EXPORT");
        serde_json::from_str(&error.message).unwrap()
    }
    #[test]
    fn missing_index_reports_safe_stage_and_relative_path_not_absolute_error_text() {
        let root = tempfile::Builder::new()
            .prefix("private-root-secret-")
            .tempdir()
            .unwrap();
        std::fs::create_dir(root.path().join("public")).unwrap();
        std::fs::write(
            root.path().join("public/app.js"),
            "export const app = true;",
        )
        .unwrap();
        let value = diagnostic(root.path(), "public");
        assert_eq!(
            value,
            json!({"version":1,"stage":"index","code":"MISSING_INDEX","path":"public/index.html","errno":null})
        );
        assert!(!value.to_string().contains("private-root-secret"));
    }
    #[test]
    fn absent_directory_and_unsafe_paths_keep_bounded_nonsecret_diagnostics() {
        let root = tempfile::tempdir().unwrap();
        let value = diagnostic(root.path(), "public");
        assert_eq!(value["stage"], "walk");
        assert_eq!(value["code"], "IO");
        assert_eq!(value["path"], "public");
        assert_eq!(value["errno"], libc::ENOENT);
        let unsafe_path = diagnostic(root.path(), "../private?token=secret");
        assert_eq!(unsafe_path["code"], "UNSAFE_PATH");
        assert!(unsafe_path["path"].is_null());
    }
    #[test]
    fn symlink_output_remains_rejected_with_a_safe_entry_diagnostic() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("public")).unwrap();
        std::fs::write(root.path().join("public/index.html"), "<html>safe</html>").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.path().join("public/private")).unwrap();
        assert_eq!(
            diagnostic(root.path(), "public"),
            json!({"version":1,"stage":"entry","code":"UNSAFE_TYPE","path":"public/private","errno":null})
        );
    }
    #[test]
    fn report_never_serializes_untrusted_raw_error_json() {
        let mut report = json!({});
        record_failure(
            &mut report,
            &Error::new("RUNTIME", "{\"password\":\"must-not-leak\"}"),
        );
        assert_eq!(
            report["static_export_diagnostic"],
            json!({"version":1,"stage":"export","code":"FAILED","path":null,"errno":null})
        );
        assert!(!report.to_string().contains("must-not-leak"));
    }
}
