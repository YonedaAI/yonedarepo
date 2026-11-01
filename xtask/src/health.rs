//! `cargo xtask health`: enforce, then track. The gates (`lines`, `migrations`, `secrets`,
//! `size`) fail on a breach and run in `cargo xtask check` and CI. With no subcommand, every
//! gate and report runs, dated values go to `.local/health/` and what moved is printed
//! (`report.rs`). The current values and what each one means are in `docs/code-health.md`.
mod deps;
mod evidence;
mod lines;
mod live;
mod migrations;
mod report;
mod secrets;
mod size;
mod test_history;
mod values;

use crate::process::Result;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) use lines::check as check_lines;
pub(crate) use migrations::check as check_migrations;
pub(crate) use secrets::check as check_secrets;
pub(crate) use size::check as check_size;
pub(crate) use test_history::run_suite;

pub(crate) fn execute(args: &[String]) -> Result<()> {
    match args.get(1).map(String::as_str) {
        Some("lines") => lines::command(args),
        Some("migrations") => migrations::command(args),
        Some("secrets") => secrets::check(base(args)),
        Some("size") => size::check(),
        Some("tests") => test_history::command(&args[2..]),
        None | Some("--doc") => report::run(args.iter().any(|arg| arg == "--doc")),
        Some(other) => Err(format!(
            "Unknown health command {other}: lines|migrations|secrets|size|tests, or none for the report"
        )
        .into()),
    }
}

/// The commit `--base` names. A new branch has none (GitHub's all-zero `before`, a manual run's
/// empty value), and then a check has nothing to compare with.
fn base(args: &[String]) -> Option<&str> {
    let at = args.iter().position(|arg| arg == "--base")?;
    let value = args.get(at + 1)?.as_str();
    (!value.is_empty() && !value.bytes().all(|byte| byte == b'0')).then_some(value)
}

/// `path` as `commit` has it, `None` where it doesn't exist there. A commit we can't read is an
/// error: a base that quietly compares with nothing would pass everything.
fn file_at(root: &Path, commit: &str, path: &str) -> Result<Option<String>> {
    let git = |args: &[&str]| Command::new("git").current_dir(root).args(args).output();
    let known = git(&["cat-file", "-e", &format!("{commit}^{{commit}}")])?;
    if !known.status.success() {
        return Err(format!("Unknown base commit {commit}").into());
    }
    let shown = git(&["show", &format!("{commit}:{path}")])?;
    Ok(shown
        .status
        .success()
        .then(|| String::from_utf8_lossy(&shown.stdout).into_owned()))
}

/// The main checkout's `.local`, which every worktree shares: evidence and tracked values stay
/// in one place however many worktrees run the command.
fn local_dir() -> Result<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()?;
    if !output.status.success() {
        return Err("git rev-parse failed".into());
    }
    let common = PathBuf::from(String::from_utf8(output.stdout)?.trim());
    let main = common.parent().ok_or("No main checkout")?;
    Ok(main.join(".local"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn a_new_branch_has_no_base() {
        let zero = "0".repeat(40);
        assert_eq!(base(&args(&["health", "--base", "abc"])), Some("abc"));
        assert_eq!(base(&args(&["health", "--base", ""])), None);
        assert_eq!(base(&args(&["health", "--base", &zero])), None);
        assert_eq!(base(&args(&["health"])), None);
    }

    #[test]
    fn an_unknown_base_is_an_error_not_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .current_dir(dir.path())
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        };
        git(&["init", "-q"]);
        std::fs::write(dir.path().join("kept"), "text").unwrap();
        git(&["add", "kept"]);
        git(&["commit", "-qm", "one"]);
        assert_eq!(
            file_at(dir.path(), "HEAD", "kept").unwrap().as_deref(),
            Some("text")
        );
        assert_eq!(file_at(dir.path(), "HEAD", "gone").unwrap(), None);
        assert!(file_at(dir.path(), &"a".repeat(40), "kept").is_err());
    }
}
