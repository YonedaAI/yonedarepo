//! Move local binding variables without rotating credentials or overwriting reviewed files.
use crate::{cloudflare::private, layout::DEV_VARS, process::Result};
use std::{fs, io::Write, path::Path};

pub(crate) fn copy_private_if_missing(source: &Path, target: &Path) -> Result<()> {
    if target.exists() {
        private(target, false)?;
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let contents = fs::read(source)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(target) {
        Ok(mut file) => file.write_all(&contents)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    private(target, false)
}

pub(crate) fn migrate_vars(root: &Path) -> Result<()> {
    let legacy = root.join(".dev.vars");
    if legacy.exists() {
        private(&legacy, false)?;
        copy_private_if_missing(&legacy, &root.join(DEV_VARS))?;
    }
    Ok(())
}

pub(crate) fn named_vars(root: &Path, deployment: &Path) -> Result<()> {
    copy_private_if_missing(&root.join(DEV_VARS), &deployment.join(".dev.vars"))
}

pub(crate) fn ensure(root: &Path) -> Result<()> {
    fs::create_dir_all(root.join(".local"))?;
    fs::create_dir_all(root.join("cloudflare"))?;
    migrate_vars(root)?;
    let vars_path = root.join(DEV_VARS);
    let mut vars = if vars_path.exists() {
        fs::read_to_string(&vars_path)?
    } else {
        String::new()
    };
    for (name, filename, hexadecimal) in [
        ("OWNER_TOKEN", "owner-token", false),
        ("VAULT_KEY", "vault-key", true),
    ] {
        let path = root.join(".local").join(filename);
        let configured = variable(&vars, name);
        if !path.exists() {
            // Existing bindings are adopted when a private backup is absent; never rotate them.
            let value = configured.clone().unwrap_or_else(|| {
                if hexadecimal {
                    format!(
                        "{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    )
                } else {
                    format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4())
                }
            });
            if value.is_empty()
                || (hexadecimal
                    && (value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit())))
            {
                return Err(
                    format!("Invalid {name} in {DEV_VARS}; existing values were retained").into(),
                );
            }
            write_private(&path, value.as_bytes())?;
        }
        private(&path, false)?;
        if configured.is_none() {
            if !vars.is_empty() && !vars.ends_with('\n') {
                vars.push('\n');
            }
            vars.push_str(&format!("{name}={}\n", fs::read_to_string(&path)?.trim()));
        }
    }
    if !vars_path.exists() || fs::read(&vars_path)? != vars.as_bytes() {
        write_private(&vars_path, vars.as_bytes())?;
    }
    private(&vars_path, false)
}
fn variable(vars: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    vars.lines().find_map(|line| {
        let value = line.trim().strip_prefix(&prefix)?.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        Some(value.to_owned())
    })
}
fn write_private(path: &Path, contents: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(contents)?;
    private(path, false)
}

#[cfg(test)]
#[path = "local_config/tests.rs"]
mod tests;
