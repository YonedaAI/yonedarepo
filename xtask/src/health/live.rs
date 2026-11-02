//! Compares the newest kit run in `.local/staging` with the last run of each of its items,
//! from the same origin: a partial run still compares with the last time an item ran. Reads
//! the evidence and never writes it (`deploy_evidence.rs` reads the newest file).
use serde::Deserialize;
use std::path::Path;

/// How many runs back an item is looked for; the files are small, not free.
const LOOK_BACK: usize = 30;
/// Slower means both: the ratio alone flags a 40 ms item, the gap alone flags noise on a long one.
const SLOWER_RATIO: f64 = 1.5;
const SLOWER_MS: u64 = 2_000;

#[derive(Debug, Deserialize)]
pub(super) struct Run {
    origin: String,
    items: Vec<Item>,
}

impl Run {
    pub(super) fn count(&self, status: &str) -> usize {
        self.items.iter().filter(|i| i.status == status).count()
    }
}

#[derive(Debug, Deserialize)]
struct Item {
    id: String,
    title: String,
    status: String,
    ms: Option<u64>,
}

/// `(stamp, path)` of the kit evidence in `dir`, newest first.
fn evidence_files(dir: &Path) -> Vec<(u64, std::path::PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let stamp = name.strip_prefix("realworld-")?.strip_suffix(".json")?;
            Some((stamp.parse().ok()?, entry.path()))
        })
        .collect();
    files.sort_by_key(|file: &(u64, _)| std::cmp::Reverse(file.0));
    files
}

/// The readable runs in `dir`, newest first. A run cut off mid-write is skipped, not fatal.
pub(super) fn runs(dir: &Path) -> Vec<Run> {
    let files = evidence_files(dir).into_iter().take(LOOK_BACK);
    let text = files.filter_map(|(_, path)| std::fs::read_to_string(path).ok());
    text.filter_map(|text| serde_json::from_str(&text).ok())
        .collect()
}

/// What changed from each item's last run to the newest: newly failing, then slower.
pub(super) fn flags(runs: &[Run]) -> Vec<String> {
    let Some((newest, earlier)) = runs.split_first() else {
        return Vec::new();
    };
    let earlier: Vec<&Run> = earlier
        .iter()
        .filter(|run| run.origin == newest.origin)
        .collect();
    let (mut failing, mut slower) = (Vec::new(), Vec::new());
    for item in &newest.items {
        let last = earlier
            .iter()
            .find_map(|run| run.items.iter().find(|old| old.id == item.id));
        let Some(last) = last else { continue };
        if item.status == "fail" && last.status != "fail" {
            failing.push(format!(
                "newly failing: {} ({}), was {}",
                item.id, item.title, last.status
            ));
        }
        if let (Some(ms), Some(old), "pass", "pass") =
            (item.ms, last.ms, item.status.as_str(), last.status.as_str())
            && ms as f64 >= old as f64 * SLOWER_RATIO
            && ms >= old + SLOWER_MS
        {
            slower.push(format!(
                "slower: {} ({}), {old} -> {ms} ms",
                item.id, item.title
            ));
        }
    }
    failing.append(&mut slower);
    failing
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, status: &str, ms: u64) -> Item {
        Item {
            id: id.to_owned(),
            title: format!("item {id}"),
            status: status.to_owned(),
            ms: Some(ms),
        }
    }

    fn run(origin: &str, items: Vec<Item>) -> Run {
        Run {
            origin: origin.to_owned(),
            items,
        }
    }

    #[test]
    fn flags_a_newly_failing_item_but_not_one_that_was_already_failing() {
        let runs = [
            run("dev", vec![item("a", "fail", 10), item("b", "fail", 10)]),
            run("dev", vec![item("a", "pass", 10), item("b", "fail", 10)]),
        ];
        assert_eq!(flags(&runs), ["newly failing: a (item a), was pass"]);
    }

    #[test]
    fn slower_needs_the_ratio_and_the_gap() {
        let runs = [
            run(
                "dev",
                vec![
                    item("slow", "pass", 9_000),
                    item("tiny", "pass", 400),
                    item("long", "pass", 62_000),
                    item("failed", "fail", 90_000),
                ],
            ),
            run(
                "dev",
                vec![
                    item("slow", "pass", 4_000),
                    item("tiny", "pass", 100),
                    item("long", "pass", 58_000),
                    item("failed", "fail", 1_000),
                ],
            ),
        ];
        assert_eq!(flags(&runs), ["slower: slow (item slow), 4000 -> 9000 ms"]);
    }

    #[test]
    fn a_partial_run_compares_with_the_last_run_of_each_item() {
        let runs = [
            run("dev", vec![item("a", "fail", 10)]),
            run("dev", vec![item("b", "pass", 10)]),
            run("dev", vec![item("a", "pass", 10)]),
        ];
        assert_eq!(flags(&runs).len(), 1);
    }

    #[test]
    fn another_origin_is_never_the_baseline() {
        let runs = [
            run("prod", vec![item("a", "fail", 10)]),
            run("dev", vec![item("a", "pass", 10)]),
        ];
        assert!(flags(&runs).is_empty());
    }

    #[test]
    fn reads_the_kit_shape_newest_first_and_skips_a_cut_off_file() {
        let dir = tempfile::tempdir().unwrap();
        let text = |status: &str| {
            format!(
                r#"{{"schema":1,"origin":"o","platform":"p","tree":"t","recorded_at":"x","items":[
                {{"id":"6","title":"t","status":"{status}","ms":5,"metrics":{{"repo":"r"}}}}]}}"#
            )
        };
        std::fs::write(dir.path().join("realworld-9.json"), text("fail")).unwrap();
        std::fs::write(dir.path().join("realworld-10.json"), "{\"schema\":").unwrap();
        std::fs::write(dir.path().join("realworld-100.json"), text("pass")).unwrap();
        std::fs::write(dir.path().join("realuser-200.json"), text("skip")).unwrap();
        let found = runs(dir.path());
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].items[0].status, "pass");
        assert_eq!(found[1].items[0].status, "fail");
    }
}
