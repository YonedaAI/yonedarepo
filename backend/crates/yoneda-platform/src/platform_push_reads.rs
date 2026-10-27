//! Read sets declared on a push (`git push -o yoneda.reads=<path>[,<path>…]`, or a remote
//! helper's upload): the files the pushed work relied on. They are recorded with the pushed
//! tip, and landing refuses the push when any of them was written after its base, so a
//! plain `git push` gets the same read-set validation as a commit made through the API.
use crate::storage::bad;
use std::collections::BTreeSet;
use yoneda_core::{Error, Result};

/// At most this many declared reads per push, and this many bytes of paths in total.
pub const MAX_READS: usize = 2_000;
pub const MAX_READ_BYTES: usize = 64 * 1024;
const OPTION: &str = "yoneda.reads=";

/// Validates `entries` as one read set: repo-relative paths, `dir/` prefixes or
/// `path#symbol`; duplicates removed, sorted. Refuses one over the caps.
pub fn read_set<I: IntoIterator<Item = String>>(entries: I) -> Result<Vec<String>> {
    let mut set = BTreeSet::new();
    let mut bytes = 0;
    for entry in entries {
        let entry = entry.trim().to_owned();
        if entry.is_empty() {
            continue;
        }
        let path = entry.split('#').next().unwrap_or_default();
        if path.is_empty()
            || path.starts_with('/')
            || path.split('/').any(|part| part == ".." || part == ".")
            || entry.contains(['\0', '\n', '\r'])
        {
            return Err(bad(&format!(
                "Declared read {entry:?} must be a repo-relative path, dir/ prefix or path#symbol"
            )));
        }
        bytes += entry.len();
        set.insert(entry);
    }
    if set.len() > MAX_READS || bytes > MAX_READ_BYTES {
        return Err(Error::new(
            "TOO_LARGE",
            format!(
                "A push declares at most {MAX_READS} reads ({} KiB of paths); declare a directory (dir/) instead of its files",
                MAX_READ_BYTES / 1024
            ),
        ));
    }
    Ok(set.into_iter().collect())
}

/// The read set a push's options declare (each `yoneda.reads=` option adds its
/// comma-separated paths). Other `yoneda.*` options are refused, so a misspelt one is not
/// silently ignored; anything else is another server's option and is ignored.
pub fn from_push_options(options: &[String]) -> Result<Vec<String>> {
    let mut entries = Vec::new();
    for option in options {
        if let Some(paths) = option.strip_prefix(OPTION) {
            entries.extend(paths.split(',').map(str::to_owned));
        } else if option.starts_with("yoneda.") {
            return Err(bad(&format!(
                "Unknown push option {:?}; this server takes yoneda.reads=<path>[,<path>...]",
                option.split('=').next().unwrap_or(option)
            )));
        }
    }
    read_set(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn collects_repeated_options_into_one_sorted_set() {
        let reads = from_push_options(&options(&[
            "yoneda.reads=src/b.rs,config.json",
            "ci.skip",
            "yoneda.reads=config.json,src/,src/lib.rs#Policy::backoff",
        ]))
        .unwrap();
        assert_eq!(
            reads,
            [
                "config.json",
                "src/",
                "src/b.rs",
                "src/lib.rs#Policy::backoff"
            ]
        );
        assert!(
            from_push_options(&options(&["ci.skip"]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn refuses_unsafe_paths_unknown_options_and_oversized_sets() {
        for bad in ["/etc/passwd", "../x", "a/../../x", "#sym", "a/./b"] {
            assert!(
                from_push_options(&options(&[&format!("yoneda.reads={bad}")])).is_err(),
                "{bad}"
            );
        }
        assert!(from_push_options(&options(&["yoneda.read=a"])).is_err());
        let many: Vec<String> = (0..=MAX_READS).map(|i| format!("f{i}")).collect();
        let too_many = read_set(many).unwrap_err();
        assert_eq!(too_many.code, "TOO_LARGE");
        let long = vec!["a".repeat(MAX_READ_BYTES + 1)];
        assert_eq!(read_set(long).unwrap_err().code, "TOO_LARGE");
        assert_eq!(read_set(vec![" a ".into(), String::new()]).unwrap(), ["a"]);
    }
}
