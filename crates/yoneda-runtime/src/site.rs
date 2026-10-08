//! Capture static build output without following candidate-controlled links or ignore rules.
use crate::err;
use std::path::Path;
use yoneda_core::{Result, Workspace};
pub(crate) fn assets(root: &Path, directory: &str) -> Result<Workspace> {
    yoneda_core::validate_path(directory)?;
    let mut files = Workspace::new();
    let mut bytes = 0usize;
    for entry in walkdir::WalkDir::new(root.join(directory)).follow_links(false) {
        let entry = entry.map_err(err)?;
        if entry.file_type().is_symlink()
            || (!entry.file_type().is_dir() && !entry.file_type().is_file())
        {
            return Err(err("Static output requires regular files and directories"));
        }
        if entry.file_type().is_dir() {
            continue;
        }
        let path = entry
            .path()
            .strip_prefix(root.join(directory))
            .map_err(err)?
            .to_str()
            .ok_or_else(|| err("Non-UTF8 static path"))?
            .to_owned();
        let file = crate::secure_fs::read_regular(root, &format!("{directory}/{path}"))?;
        bytes = bytes.saturating_add(file.bytes()?.len());
        if bytes > yoneda_core::MAX_WORKSPACE_BYTES || files.len() >= yoneda_core::MAX_FILES {
            return Err(err("Static output exceeds platform limits"));
        }
        files.insert(path, file);
    }
    yoneda_core::validate_workspace(&files)?;
    if !files.contains_key("index.html") {
        return Err(err("Static output must include index.html"));
    }
    Ok(files)
}
