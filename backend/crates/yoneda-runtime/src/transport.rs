//! Git file maps for legacy JSON workspaces and test bundles.
use crate::err;
use std::{collections::BTreeMap, path::Path};
use yoneda_core::{Result, Workspace};

#[derive(Debug, Clone)]
pub(crate) struct GitFile {
    pub(crate) bytes: Vec<u8>,
    pub(crate) executable: bool,
}
pub(crate) type GitWorkspace = BTreeMap<String, GitFile>;

impl GitFile {
    pub(crate) fn from_entry(entry: yoneda_core::FileEntry) -> Result<Self> {
        Ok(Self {
            bytes: entry.bytes()?,
            executable: entry.executable,
        })
    }
}

pub(crate) fn from_legacy(workspace: Workspace) -> Result<GitWorkspace> {
    workspace
        .into_iter()
        .map(|(path, file)| Ok((path, GitFile::from_entry(file)?)))
        .collect()
}

pub(crate) fn materialize_git(root: &Path, files: &GitWorkspace) -> Result<()> {
    if files.is_empty() || files.len() > 10_000 {
        return Err(err("Workspace must contain 1–10,000 files"));
    }
    let mut total = 0usize;
    for (path, file) in files {
        yoneda_core::validate_path(path)?;
        if file.bytes.len() > 32_000_000 {
            return Err(err("Git blob exceeds 32 MB"));
        }
        total = total.saturating_add(file.bytes.len());
        if total > 100 * 1024 * 1024 {
            return Err(err("Workspace exceeds 100 MiB"));
        }
        let destination = root.join(path);
        std::fs::create_dir_all(
            destination
                .parent()
                .ok_or_else(|| err("Invalid workspace path"))?,
        )
        .map_err(crate::err)?;
        std::fs::write(&destination, &file.bytes).map_err(crate::err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                destination,
                std::fs::Permissions::from_mode(if file.executable { 0o755 } else { 0o644 }),
            )
            .map_err(crate::err)?;
        }
    }
    Ok(())
}
