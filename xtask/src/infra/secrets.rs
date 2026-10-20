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
