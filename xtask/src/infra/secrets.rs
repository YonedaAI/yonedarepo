//! Secrets files: `KEY=VALUE` lines, `#` comments. Values are only ever piped to
//! `wrangler secret bulk` on stdin; nothing here prints them.
use crate::process::Result;
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) fn parse(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(value);
            Some((key.trim().to_owned(), value.to_owned()))
        })
        .collect()
}

pub(crate) fn read(path: &Path) -> Result<BTreeMap<String, String>> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("Cannot read secrets file {}: {error}", path.display()))?;
    Ok(parse(&text))
}

/// Creates a private secrets file with a fresh owner token and vault key (ephemeral envs).
/// An existing file is kept, so reruns never rotate the keys of a running stack.
pub(crate) fn ensure_generated(path: &Path) -> Result<bool> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        crate::cloudflare::private(dir, true)?;
    }
    let owner = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let vault = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    std::io::Write::write_all(
        &mut file,
        format!("# Ephemeral stack secrets (generated).\nOWNER_TOKEN={owner}\nVAULT_KEY={vault}\n")
            .as_bytes(),
    )?;
    Ok(true)
}
