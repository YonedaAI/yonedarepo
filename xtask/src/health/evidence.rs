//! What `.local/staging` holds, and what a trim would free. Reports only: nothing here deletes.
//! The proposal keeps every small file and the browser captures the newest kit runs name.
use crate::process::Result;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Kit runs whose browser captures a trim keeps.
const KEEP_RUNS: usize = 20;
const BROWSER_PREFIX: &str = "browser-";

#[derive(Debug, Default, PartialEq)]
pub(super) struct Evidence {
    pub entries: usize,
    pub bytes: u64,
    /// Bytes and entries per kind of run, the name without its stamp.
    pub kinds: BTreeMap<String, (u64, usize)>,
    /// Bytes of the browser captures no recent kit run names.
    pub trimmable: u64,
}

fn size_of(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !metadata.is_dir() {
        return metadata.len();
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries.flatten().map(|e| size_of(&e.path())).sum()
}

/// `realworld-1793.json` and `browser-1793` become `realworld` and `browser`.
fn kind(name: &str) -> &str {
    let stem = name.split('.').next().unwrap_or(name);
    match stem.rsplit_once('-') {
        Some((kind, stamp)) if stamp.bytes().all(|b| b.is_ascii_digit()) => kind,
        _ => stem,
    }
}

/// The directory names of `.local/staging/...` paths a kit run points at.
fn named_captures(run: &Value) -> impl Iterator<Item = String> {
    let items = run["items"].as_array().cloned().unwrap_or_default();
    items.into_iter().filter_map(|item| {
        let path = item["metrics"]["evidence"].as_str()?;
        Some(path.rsplit('/').next()?.to_owned())
    })
}

pub(super) fn survey(dir: &Path) -> Result<Evidence> {
    let mut found = Evidence::default();
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir)?.flatten() {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    let mut kits: Vec<&String> = names
        .iter()
        .filter(|name| name.starts_with("realworld-") && name.ends_with(".json"))
        .collect();
    kits.sort_by_key(|name| std::cmp::Reverse(stamp(name)));
    let mut kept = BTreeSet::new();
    for name in kits.into_iter().take(KEEP_RUNS) {
        let text = std::fs::read_to_string(dir.join(name)).unwrap_or_default();
        if let Ok(run) = serde_json::from_str::<Value>(&text) {
            kept.extend(named_captures(&run));
        }
    }
    for name in &names {
        let bytes = size_of(&dir.join(name));
        found.entries += 1;
        found.bytes += bytes;
        let row = found.kinds.entry(kind(name).to_owned()).or_default();
        row.0 += bytes;
        row.1 += 1;
        if name.starts_with(BROWSER_PREFIX) && kind(name) == "browser" && !kept.contains(name) {
            found.trimmable += bytes;
        }
    }
    Ok(found)
}

fn stamp(name: &str) -> u64 {
    let digits = name.chars().filter(char::is_ascii_digit);
    digits.collect::<String>().parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_lose_their_stamps() {
        assert_eq!(kind("realworld-1793.json"), "realworld");
        assert_eq!(kind("browser-1793"), "browser");
        assert_eq!(kind("browser-gate-1793.json"), "browser-gate");
        assert_eq!(kind("dogfood"), "dogfood");
    }

    #[test]
    fn counts_each_kind_and_keeps_the_captures_recent_runs_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (name, bytes) in [
            ("browser-1", 700),
            ("browser-2", 300),
            ("browser-gate-3", 5),
        ] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("shot.png"), vec![0; bytes]).unwrap();
        }
        let kit =
            r#"{"items":[{"id":"browser","metrics":{"evidence":".local/staging/browser-2"}}]}"#;
        std::fs::write(root.join("realworld-5.json"), kit).unwrap();
        let found = survey(root).unwrap();
        assert_eq!(found.entries, 4);
        assert_eq!(found.bytes, 1_005 + kit.len() as u64);
        assert_eq!(found.kinds["browser"], (1_000, 2));
        assert_eq!(found.trimmable, 700);
    }

    #[test]
    fn a_trim_keeps_only_the_captures_of_the_newest_runs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let capture = |stamp: usize| format!("browser-{stamp}");
        for stamp in 0..=KEEP_RUNS {
            std::fs::create_dir(root.join(capture(stamp))).unwrap();
            std::fs::write(root.join(capture(stamp)).join("a"), [0; 10]).unwrap();
            let kit = format!(
                r#"{{"items":[{{"metrics":{{"evidence":"{}"}}}}]}}"#,
                capture(stamp)
            );
            std::fs::write(root.join(format!("realworld-{stamp}.json")), kit).unwrap();
        }
        assert_eq!(survey(root).unwrap().trimmable, 10);
    }
}
