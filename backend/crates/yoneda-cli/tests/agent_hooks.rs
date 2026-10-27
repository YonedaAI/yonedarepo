//! The Claude Code plugin's hook script (`plugins/yoneda/hooks/yoneda-hook.sh`) driving the
//! built `yoneda` binary, as Claude Code runs it: hook JSON on stdin, in a clone. Reads join
//! `.git/yoneda/reads` only in a clone with a YonedaRepo remote; a plain `git push` to a
//! smart-HTTP remote is denied while reads are recorded (not `yoneda push`, not through a
//! `yoneda::` remote); without the CLI on PATH the script does nothing. No platform needed.
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

type TestResult<T = ()> = Result<T, String>;

const REPO: &str = "r0123456789abcdef0123";

fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/yoneda/hooks/yoneda-hook.sh")
}

fn git(dir: &Path, args: &[&str]) -> TestResult {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    out.status
        .success()
        .then_some(())
        .ok_or_else(|| String::from_utf8_lossy(&out.stderr).into_owned())
}

/// A clone whose `origin` is `remote`, holding `src/a.rs` and `docs/`.
fn clone_with(root: &Path, name: &str, remote: Option<&str>) -> TestResult<PathBuf> {
    let dir = root.join(name);
    std::fs::create_dir_all(dir.join("src")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir.join("docs")).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("src/a.rs"), "fn a() {}\n").map_err(|e| e.to_string())?;
    git(&dir, &["init", "-q"])?;
    if let Some(url) = remote {
        git(&dir, &["remote", "add", "origin", url])?;
    }
    Ok(dir)
}

/// Runs the hook script for `event` with `input`; `with_cli`: the built `yoneda` on PATH.
fn hook(event: &str, input: &Value, with_cli: bool) -> TestResult<String> {
    let bin = Path::new(env!("CARGO_BIN_EXE_yoneda"))
        .parent()
        .ok_or("binary directory")?
        .to_owned();
    let path = if with_cli {
        format!("{}:/usr/bin:/bin", bin.display())
    } else {
        "/usr/bin:/bin".into()
    };
    let mut child = Command::new("sh")
        .arg(script())
        .arg(event)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("stdin")?
        .write_all(input.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "{event} exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn reads(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join(".git/yoneda/reads"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn check(condition: bool, what: &str) -> TestResult {
    condition.then_some(()).ok_or_else(|| what.to_owned())
}

#[test]
fn the_plugin_hooks_record_reads_and_steer_pushes() -> TestResult {
    let root = tempfile::tempdir().map_err(|e| e.to_string())?;
    let https = format!("https://api.dev.yonedarepo.com/git/{REPO}.git");
    let dir = clone_with(root.path(), "smart", Some(&https))?;
    let cwd = dir.to_string_lossy().into_owned();

    let read = json!({ "cwd": cwd, "tool_name": "Read", "hook_event_name": "PostToolUse",
        "tool_input": { "file_path": dir.join("src/a.rs") }, "tool_response": {} });
    hook("claude-read", &read, true)?;
    let grep = json!({ "cwd": dir.join("src"), "tool_name": "Grep",
        "tool_input": { "pattern": "fn" },
        "tool_response": { "mode": "files_with_matches", "filenames": ["a.rs", "../docs", "/etc/hosts"] } });
    hook("claude-read", &grep, true)?;
    hook("claude-read", &read, true)?;
    check(
        reads(&dir) == ["src/a.rs", "docs/"],
        &format!("reads: {:?}", reads(&dir)),
    )?;

    let bash = |command: &str| {
        json!({ "cwd": cwd, "tool_name": "Bash",
        "tool_input": { "command": command } })
    };
    let denied: Value =
        serde_json::from_str(&hook("claude-bash", &bash("git push origin main"), true)?)
            .map_err(|e| format!("deny output: {e}"))?;
    check(
        denied["hookSpecificOutput"]["permissionDecision"] == "deny"
            && denied["hookSpecificOutput"]["permissionDecisionReason"]
                .as_str()
                .is_some_and(|r| r.contains("yoneda push") && r.contains("2 file(s)")),
        &denied.to_string(),
    )?;
    for allowed in [
        "yoneda push origin main",
        "git status",
        "git push -o yoneda.reads=a origin main",
    ] {
        check(
            hook("claude-bash", &bash(allowed), true)?.trim().is_empty(),
            allowed,
        )?;
    }
    // A turn that pushed nothing posts nothing (and needs no network).
    let stop = json!({ "cwd": cwd, "session_id": "s1", "transcript_path": root.path().join("none.jsonl") });
    check(hook("claude-stop", &stop, true)?.trim().is_empty(), "stop")?;

    // Through a yoneda:: remote the helper declares the reads: git push goes ahead.
    let helper = clone_with(
        root.path(),
        "helper",
        Some(&format!("yoneda::https://api.dev.yonedarepo.com/{REPO}")),
    )?;
    let helper_cwd = helper.to_string_lossy().into_owned();
    hook(
        "claude-read",
        &json!({ "cwd": helper_cwd, "tool_name": "Read",
        "tool_input": { "file_path": "src/a.rs" } }),
        true,
    )?;
    check(reads(&helper) == ["src/a.rs"], "helper clone reads")?;
    let push =
        json!({ "cwd": helper_cwd, "tool_name": "Bash", "tool_input": { "command": "git push" } });
    check(
        hook("claude-bash", &push, true)?.trim().is_empty(),
        "helper push allowed",
    )?;

    // Elsewhere nothing is recorded: another remote, or no yoneda CLI.
    let other = clone_with(root.path(), "github", Some("https://github.com/a/b.git"))?;
    let other_read =
        json!({ "cwd": other, "tool_name": "Read", "tool_input": { "file_path": "src/a.rs" } });
    hook("claude-read", &other_read, true)?;
    check(
        !other.join(".git/yoneda").exists(),
        "no reads outside the platform",
    )?;
    let bare = clone_with(root.path(), "no-cli", Some(&https))?;
    hook(
        "claude-read",
        &json!({ "cwd": bare, "tool_name": "Read", "tool_input": { "file_path": "src/a.rs" } }),
        false,
    )?;
    check(reads(&bare).is_empty(), "no CLI, no reads")
}
