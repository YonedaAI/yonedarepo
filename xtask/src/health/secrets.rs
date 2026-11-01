//! `gitleaks` over a commit range, with the rules of `.gitleaks.toml`. CI logs are public, so
//! this reads gitleaks' report and prints a rule, a place and a short commit: the typed
//! `Finding` drops the secret, the author and the email before anything can print them.
//! A range, not the whole history: old commits hold known false hits (docs/code-health.md).
use crate::process::Result;
use serde::Deserialize;
use std::path::Path;
use std::process::Command;

const CONFIG: &str = ".gitleaks.toml";
/// What a branch with no base is compared with.
const DEFAULT_BASE: &str = "origin/main";

#[derive(Debug, Deserialize)]
pub(super) struct Finding {
    #[serde(rename = "RuleID")]
    rule: String,
    #[serde(rename = "File")]
    file: String,
    #[serde(rename = "StartLine")]
    line: u64,
    #[serde(rename = "Commit")]
    commit: String,
}

impl Finding {
    fn line(&self) -> String {
        let commit = self.commit.get(..12).unwrap_or(&self.commit);
        format!("{}: {}:{} in {commit}", self.rule, self.file, self.line)
    }
}

/// The findings in `range` of the repository at `root`. A failing gitleaks is an error, never
/// a clean result, and so is a range git can't resolve: gitleaks alone reports that as clean.
pub(super) fn scan(root: &Path, range: &str, config: &Path) -> Result<Vec<Finding>> {
    let commits = Command::new("git")
        .current_dir(root)
        .args(["rev-list", "--count", range])
        .output()?;
    if !commits.status.success() {
        return Err(format!("Secret scan: git can't resolve {range}").into());
    }
    let report = tempfile::NamedTempFile::new()?;
    let output = Command::new("gitleaks")
        .current_dir(root)
        .args(["git", "--redact", "--no-banner", "--exit-code", "0"])
        .args(["--report-format", "json"])
        .arg("--report-path")
        .arg(report.path())
        .arg("--config")
        .arg(config)
        .args(["--log-opts", range])
        .output()
        .map_err(|error| format!("gitleaks: {error}: install it (docs/code-health.md)"))?;
    if !output.status.success() {
        return Err(format!("gitleaks failed on {range} ({})", output.status).into());
    }
    let text = std::fs::read_to_string(report.path())?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_str(&text)?)
}

fn found_after(root: &Path, commit: &str) -> Result<Vec<String>> {
    let range = format!("{commit}..HEAD");
    let findings = scan(root, &range, &root.join(CONFIG))?;
    Ok(findings.iter().map(Finding::line).collect())
}

/// What this branch adds to main, printable.
pub(super) fn unpushed(root: &Path) -> Result<Vec<String>> {
    found_after(root, DEFAULT_BASE)
}

/// The gate: every commit after `commit`, else everything this branch adds to main.
pub(crate) fn check(commit: Option<&str>) -> Result<()> {
    let root = std::env::current_dir()?;
    let commit = commit.unwrap_or(DEFAULT_BASE);
    let range = format!("{commit}..HEAD");
    let lines = found_after(&root, commit)?;
    if lines.is_empty() {
        println!("secrets: none in {range}");
        return Ok(());
    }
    Err(format!(
        "Secret scan: {} finding(s) in {range}, values hidden:\n  {}",
        lines.len(),
        lines.join("\n  ")
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO_CONFIG: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../.gitleaks.toml");
    /// A token of GitHub's shape, built here so that this file holds none.
    fn planted() -> String {
        ["ghp", "_", &"a1B2c3D4e5F6".repeat(3)].concat()
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(dir)
            .args([
                "-c",
                "user.name=Someone",
                "-c",
                "user.email=someone@corp.test",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    /// A repository with one clean commit; `commit` adds a file to it.
    fn repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join("readme"), "clean\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-qm", "first"]);
        let first = git(dir.path(), &["rev-parse", "HEAD"]);
        (dir, first)
    }

    fn commit(dir: &Path, path: &str, text: &str) {
        let path = dir.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "more"]);
    }

    fn scan_after(dir: &Path, base: &str) -> Vec<Finding> {
        scan(dir, &format!("{base}..HEAD"), Path::new(REPO_CONFIG)).unwrap()
    }

    #[test]
    fn a_planted_secret_fails_and_nothing_printed_shows_it() {
        let (dir, first) = repo();
        let secret = planted();
        commit(dir.path(), "src/config.txt", &format!("key: {secret}\n"));
        let found = scan_after(dir.path(), &first);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].rule, "github-pat");
        let line = found[0].line();
        assert!(
            line.starts_with("github-pat: src/config.txt:1 in "),
            "{line}"
        );
        for hidden in [secret.as_str(), "someone@corp.test", "Someone"] {
            assert!(!line.contains(hidden), "{line}");
        }
    }

    #[test]
    fn a_real_token_format_fails_in_a_test_file_too() {
        let (dir, first) = repo();
        let text = format!("const key = '{}';\n", planted());
        commit(dir.path(), "tests/workers/a.test.ts", &text);
        assert_eq!(scan_after(dir.path(), &first).len(), 1);
    }

    #[test]
    fn known_fixture_shapes_pass_and_the_same_outside_tests_fails() {
        let (dir, first) = repo();
        let line = "{\"client_secret\":\"Zk3Q9xLm2Vb7Tn4Rp8Wd6Yh1\"}\n";
        commit(dir.path(), "tests/workers/a.test.ts", line);
        assert!(scan_after(dir.path(), &first).is_empty());
        commit(dir.path(), "src/app.ts", line);
        assert_eq!(scan_after(dir.path(), &first).len(), 1);
    }

    #[test]
    fn an_empty_range_is_clean_and_a_broken_range_is_an_error() {
        let (dir, first) = repo();
        assert!(scan_after(dir.path(), &first).is_empty());
        let broken = scan(dir.path(), "nothing..HEAD", Path::new(REPO_CONFIG));
        assert!(broken.is_err());
    }
}
