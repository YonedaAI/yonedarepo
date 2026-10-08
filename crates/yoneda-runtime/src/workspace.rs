use crate::err;
use std::path::Path;
use yoneda_core::{Result, Workspace};
pub fn materialize(root: &Path, workspace: &Workspace) -> Result<()> {
    yoneda_core::validate_workspace(workspace)?;
    for (path, file) in workspace {
        let destination = root.join(path);
        std::fs::create_dir_all(destination.parent().unwrap()).map_err(err)?;
        std::fs::write(&destination, &file.content).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                destination,
                std::fs::Permissions::from_mode(if file.executable { 0o755 } else { 0o644 }),
            )
            .map_err(err)?;
        }
    }
    Ok(())
}

pub fn export_workspace(root: &Path) -> Result<Workspace> {
    let mut result = Workspace::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            ![".git", "target", "node_modules"]
                .contains(&e.file_name().to_str().unwrap_or_default())
        })
    {
        let entry = entry.map_err(err)?;
        if entry.file_type().is_symlink() {
            return Err(err("Workspace symlinks are unsupported"));
        }
        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() {
            return Err(err("Workspace contains a nonregular file"));
        }
        let path = entry
            .path()
            .strip_prefix(root)
            .map_err(err)?
            .to_str()
            .ok_or_else(|| err("Non-UTF8 path"))?
            .to_owned();
        yoneda_core::validate_path(&path)?;
        let file = crate::secure_fs::read_regular(root, &path)?;
        result.insert(path, file);
        if result.len() > yoneda_core::MAX_FILES {
            return Err(err("Too many workspace files"));
        }
    }
    yoneda_core::validate_workspace(&result)?;
    Ok(result)
}
