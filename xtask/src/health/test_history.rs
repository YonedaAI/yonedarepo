//! Test results over time. GitHub keeps `ci.yml`'s full-lane results for a day, so the record lives on the Mac:
//! `cargo xtask check` saves each vitest suite to `.local/health/tests/`, and any other run's
//! JSON can be added with `cargo xtask health tests <file>`. Flags a test that failed and then
//! passed, and a test that slowed down. Only names and timings are kept, never failure text.
//! `node --test` and `cargo test` have no timing JSON worth keeping yet, so they aren't here.
use crate::process::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

/// Runs per suite that are read: enough for a flake, and for a median that one slow run can't move.
const LOOK_BACK: usize = 10;
/// Slower means both, against the median of the earlier runs: CI-sized noise is well under this.
const SLOWER_RATIO: f64 = 2.0;
const SLOWER_MS: f64 = 500.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Run {
    pub suite: String,
    /// The tree it ran on, `None` when the checkout had uncommitted changes.
    pub tree: Option<String>,
    pub stamp: u64,
    pub tests: BTreeMap<String, Outcome>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Outcome {
    pub passed: bool,
    pub ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vitest {
    start_time: u64,
    test_results: Vec<VitestFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VitestFile {
    name: String,
    assertion_results: Vec<VitestTest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VitestTest {
    full_name: String,
    status: String,
    duration: Option<f64>,
}

/// A run from vitest's JSON: skipped and todo tests are dropped, and names are made relative to
/// `root` so that a worktree's run compares with the main checkout's.
fn parse(text: &str, suite: &str, tree: Option<String>, root: &str) -> Result<Run> {
    let vitest: Vitest = serde_json::from_str(text)?;
    let mut tests = BTreeMap::new();
    for file in &vitest.test_results {
        let name = file.name.strip_prefix(root).unwrap_or(&file.name);
        let name = name.trim_start_matches('/');
        for test in &file.assertion_results {
            if test.status != "passed" && test.status != "failed" {
                continue;
            }
            let outcome = Outcome {
                passed: test.status == "passed",
                ms: test.duration.unwrap_or(0.0),
            };
            tests.insert(format!("{name} > {}", test.full_name), outcome);
        }
    }
    Ok(Run {
        suite: suite.to_owned(),
        tree,
        stamp: vitest.start_time,
        tests,
    })
}

/// Tests of `runs` (oldest first, one suite) that failed and then passed. On one tree that's a
/// flake; across trees it may be a fix, and the flag says which.
pub(super) fn fail_then_pass(runs: &[Run]) -> Vec<String> {
    let mut last: BTreeMap<&str, (&Run, bool)> = BTreeMap::new();
    let mut flagged = BTreeMap::new();
    for run in runs {
        for (name, outcome) in &run.tests {
            if let Some((before, false)) = last.get(name.as_str())
                && outcome.passed
            {
                let same = run.tree.is_some() && run.tree == before.tree;
                let kind = if same { "flaky" } else { "fixed or flaky" };
                flagged.insert(name.as_str(), kind);
            }
            last.insert(name, (run, outcome.passed));
        }
    }
    let rows = flagged.into_iter();
    rows.map(|(name, kind)| format!("{kind}: {name} failed, then passed"))
        .collect()
}

/// Tests of the newest of `runs` (oldest first) well over their median of the earlier passes.
pub(super) fn slower(runs: &[Run]) -> Vec<String> {
    let Some((newest, earlier)) = runs.split_last() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (name, outcome) in newest.tests.iter().filter(|(_, o)| o.passed) {
        let passes = earlier.iter().filter_map(|run| run.tests.get(name));
        let mut times: Vec<f64> = passes.filter(|o| o.passed).map(|o| o.ms).collect();
        if times.is_empty() {
            continue;
        }
        times.sort_by(f64::total_cmp);
        let median = times[times.len() / 2];
        if outcome.ms >= median * SLOWER_RATIO && outcome.ms >= median + SLOWER_MS {
            found.push(format!(
                "slower: {name}, {median:.0} -> {:.0} ms",
                outcome.ms
            ));
        }
    }
    found
}

fn directory() -> Result<std::path::PathBuf> {
    Ok(super::local_dir()?.join("health/tests"))
}

/// The newest `LOOK_BACK` runs of each suite in `dir`, oldest first.
pub(super) fn history(dir: &Path) -> Result<BTreeMap<String, Vec<Run>>> {
    let mut suites: BTreeMap<String, Vec<Run>> = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(suites);
    };
    for entry in entries.flatten() {
        let run: Run = serde_json::from_slice(&std::fs::read(entry.path())?)?;
        suites.entry(run.suite.clone()).or_default().push(run);
    }
    for runs in suites.values_mut() {
        runs.sort_by_key(|run| run.stamp);
        let extra = runs.len().saturating_sub(LOOK_BACK);
        runs.drain(..extra);
    }
    Ok(suites)
}

/// Every flag in the kept history, and how many tests the newest runs held and failed.
pub(super) fn summary() -> Result<(Vec<String>, usize, usize)> {
    let (mut flags, mut total, mut failed) = (Vec::new(), 0, 0);
    for runs in history(&directory()?)?.values() {
        flags.extend(fail_then_pass(runs));
        flags.extend(slower(runs));
        if let Some(newest) = runs.last() {
            total += newest.tests.len();
            failed += newest.tests.values().filter(|o| !o.passed).count();
        }
    }
    Ok((flags, total, failed))
}

/// HEAD's tree, when that's what the working files are.
fn clean_tree() -> Option<String> {
    let git = |args: &[&str]| Command::new("git").args(args).output().ok();
    let status = git(&["status", "--porcelain"])?;
    if !status.status.success() || !status.stdout.is_empty() {
        return None;
    }
    let tree = git(&["rev-parse", "HEAD^{tree}"])?;
    Some(String::from_utf8(tree.stdout).ok()?.trim().to_owned())
}

fn keep(file: &Path, suite: &str) -> Result<()> {
    let root = std::env::current_dir()?;
    let root = root.to_str().ok_or("Invalid checkout path")?;
    let run = parse(&std::fs::read_to_string(file)?, suite, clean_tree(), root)?;
    let dir = directory()?;
    std::fs::create_dir_all(&dir)?;
    let name = format!("{}-{}.json", run.stamp, suite.replace(':', "-"));
    std::fs::write(dir.join(name), serde_json::to_vec(&run)?)?;
    let suites = history(&dir)?;
    let runs = suites.get(suite).map_or(&[][..], Vec::as_slice);
    for flag in fail_then_pass(runs).into_iter().chain(slower(runs)) {
        println!("health: {flag}");
    }
    Ok(())
}

/// A pnpm vitest script, with its results kept even when it fails: that's when they matter.
/// A record that can't be written warns and leaves the suite's own result alone.
pub(crate) fn run_suite(script: &str) -> Result<()> {
    let results = tempfile::NamedTempFile::new()?;
    let output = format!("--outputFile.json={}", results.path().display());
    let args = [script, "--reporter=default", "--reporter=json", &output];
    let status = Command::new("pnpm").args(args).status()?;
    if let Err(error) = keep(results.path(), script) {
        eprintln!("health: results of {script} not kept: {error}");
    }
    if !status.success() {
        return Err(format!("pnpm {script} failed ({status})").into());
    }
    Ok(())
}

pub(super) fn command(files: &[String]) -> Result<()> {
    if files.is_empty() {
        return Err("cargo xtask health tests <vitest-json-file>...".into());
    }
    for file in files {
        let path = Path::new(file);
        let suite = path.file_stem().and_then(|stem| stem.to_str());
        keep(path, suite.ok_or("Invalid file name")?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(stamp: u64, tree: Option<&str>, tests: &[(&str, bool, f64)]) -> Run {
        Run {
            suite: "s".to_owned(),
            tree: tree.map(str::to_owned),
            stamp,
            tests: tests
                .iter()
                .map(|(name, passed, ms)| {
                    let outcome = Outcome {
                        passed: *passed,
                        ms: *ms,
                    };
                    ((*name).to_owned(), outcome)
                })
                .collect(),
        }
    }

    #[test]
    fn a_test_that_fails_then_passes_on_one_tree_is_flaky() {
        let runs = [
            run(1, Some("t"), &[("a", false, 1.0), ("b", true, 1.0)]),
            run(2, Some("t"), &[("a", true, 1.0), ("b", true, 1.0)]),
        ];
        assert_eq!(fail_then_pass(&runs), ["flaky: a failed, then passed"]);
    }

    #[test]
    fn across_trees_or_on_a_dirty_tree_it_may_be_a_fix() {
        let moved = [
            run(1, Some("t"), &[("a", false, 1.0)]),
            run(2, Some("u"), &[("a", true, 1.0)]),
        ];
        assert_eq!(
            fail_then_pass(&moved),
            ["fixed or flaky: a failed, then passed"]
        );
        let dirty = [
            run(1, None, &[("a", false, 1.0)]),
            run(2, None, &[("a", true, 1.0)]),
        ];
        assert_eq!(
            fail_then_pass(&dirty),
            ["fixed or flaky: a failed, then passed"]
        );
    }

    #[test]
    fn a_test_still_failing_is_not_flagged() {
        let runs = [
            run(1, Some("t"), &[("a", true, 1.0)]),
            run(2, Some("t"), &[("a", false, 1.0)]),
        ];
        assert!(fail_then_pass(&runs).is_empty());
    }

    #[test]
    fn slower_is_against_the_median_and_needs_both_bars() {
        let runs = [
            run(1, None, &[("slow", true, 800.0), ("quick", true, 10.0)]),
            run(2, None, &[("slow", true, 900.0), ("quick", true, 10.0)]),
            run(3, None, &[("slow", true, 60_000.0), ("quick", true, 10.0)]),
            run(4, None, &[("slow", true, 2_000.0), ("quick", true, 300.0)]),
        ];
        assert_eq!(slower(&runs), ["slower: slow, 900 -> 2000 ms"]);
    }

    #[test]
    fn a_failed_run_never_sets_the_baseline() {
        let runs = [
            run(1, None, &[("a", false, 1.0)]),
            run(2, None, &[("a", true, 90_000.0)]),
        ];
        assert!(slower(&runs).is_empty());
    }

    #[test]
    fn reads_vitest_json_and_keeps_only_names_timings_and_outcomes() {
        let text = r#"{"numTotalTests":4,"startTime":1793000000000,"testResults":[
            {"name":"/repo/tests/a.test.ts","status":"failed","assertionResults":[
              {"fullName":"group adds","status":"passed","duration":12.5,"failureMessages":[]},
              {"fullName":"group fails","status":"failed","duration":3,"failureMessages":["token abc"]},
              {"fullName":"group later","status":"pending","failureMessages":[]},
              {"fullName":"group never","status":"todo"}]}]}"#;
        let run = parse(text, "test", Some("t".to_owned()), "/repo").unwrap();
        assert_eq!(run.stamp, 1_793_000_000_000);
        let names: Vec<&String> = run.tests.keys().collect();
        assert_eq!(
            names,
            [
                "tests/a.test.ts > group adds",
                "tests/a.test.ts > group fails"
            ]
        );
        assert!(!run.tests["tests/a.test.ts > group fails"].passed);
        assert_eq!(run.tests["tests/a.test.ts > group adds"].ms, 12.5);
        assert!(!serde_json::to_string(&run).unwrap().contains("abc"));
    }

    #[test]
    fn history_keeps_the_newest_runs_of_each_suite_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        for stamp in 0..LOOK_BACK as u64 + 2 {
            let body = serde_json::to_vec(&run(stamp, None, &[])).unwrap();
            std::fs::write(dir.path().join(format!("{stamp}-s.json")), body).unwrap();
        }
        let suites = history(dir.path()).unwrap();
        assert_eq!(suites["s"].len(), LOOK_BACK);
        assert_eq!(suites["s"][0].stamp, 2);
        assert_eq!(suites["s"].last().unwrap().stamp, LOOK_BACK as u64 + 1);
    }
}
