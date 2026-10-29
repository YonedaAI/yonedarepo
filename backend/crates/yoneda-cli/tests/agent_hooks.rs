//! The Claude Code plugin's hook script (`plugins/yoneda/hooks/yoneda-hook.sh`) driving the
//! built `yoneda` binary, as Claude Code runs it: hook JSON on stdin, in a clone. Reads join
//! `.git/yoneda/reads` only in a clone with a YonedaRepo remote; a plain `git push` to a
//! smart-HTTP remote is denied while reads are recorded (not `yoneda push`, not through a
//! `yoneda::` remote); without the CLI on PATH the script does nothing. At the turn's end
//! the session record carries the transcript (Claude Code's JSON lines, or opencode's
//! messages) with the context packet the session started with, posted to a stand-in
//! platform that records each request. No platform needed.
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
    hook_with(event, input, with_cli, &[])
}

fn hook_with(
    event: &str,
    input: &Value,
    with_cli: bool,
    env: &[(&str, &str)],
) -> TestResult<String> {
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
        .envs(env.iter().copied())
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

/// Each request a stand-in platform received: its request line and JSON body.
type Seen = std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>;

/// A stand-in platform: answers every request with `{"session":1}` and keeps each one's
/// method, path and JSON body.
fn fake_platform() -> TestResult<(String, Seen)> {
    use std::io::{BufRead, BufReader, Read};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let origin = format!(
        "http://{}",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let kept = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(&stream);
            let mut request = String::new();
            let mut length = 0;
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok_and(|n| n > 0) {
                if line.trim().is_empty() {
                    break;
                }
                if request.is_empty() {
                    request = line.trim().to_owned();
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap_or(0);
                }
                line.clear();
            }
            let mut body = vec![0; length];
            let _ = reader.read_exact(&mut body);
            let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if let Ok(mut seen) = kept.lock() {
                seen.push((request, body));
            }
            let reply = "{\"session\":1}";
            let _ = (&stream).write_all(
                format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).as_bytes(),
            );
        }
    });
    Ok((origin, seen))
}

/// The JSON body of the session record posted for `commit`.
fn posted_record(seen: &std::sync::Mutex<Vec<(String, Value)>>, commit: &str) -> TestResult<Value> {
    let seen = seen.lock().map_err(|e| e.to_string())?;
    seen.iter()
        .find(|(request, _)| {
            request.starts_with(&format!(
                "POST /api/v1/repos/{REPO}/commits/{commit}/sessions"
            ))
        })
        .map(|(_, body)| body.clone())
        .ok_or_else(|| {
            format!(
                "no record posted: {:?}",
                seen.iter().map(|(r, _)| r).collect::<Vec<_>>()
            )
        })
}

#[test]
fn the_turn_end_hooks_upload_the_transcript_and_the_context_it_started_with() -> TestResult {
    let root = tempfile::tempdir().map_err(|e| e.to_string())?;
    let (origin, seen) = fake_platform()?;
    let dir = clone_with(
        root.path(),
        "clone",
        Some(&format!("yoneda::{origin}/{REPO}")),
    )?;
    let cwd = dir.to_string_lossy().into_owned();
    let home = root.path().join("home");
    let home = home.to_string_lossy();
    let env_file = root.path().join("claude.env");
    let env_file = env_file.to_string_lossy();
    let env = [
        ("YONEDA_TOKEN", "test-token"),
        ("HOME", &*home),
        ("XDG_CONFIG_HOME", &*home),
        ("CLAUDE_ENV_FILE", &*env_file),
    ];

    // Claude Code: the session starts with the repository's context, pushes, and ends a turn.
    let start: Value = serde_json::from_str(&hook_with(
        "claude-start",
        &json!({ "cwd": cwd, "session_id": "s2", "hook_event_name": "SessionStart" }),
        true,
        &env,
    )?)
    .map_err(|e| format!("start output: {e}"))?;
    let context = start["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .ok_or("no context")?
        .to_owned();
    let commit = "c".repeat(40);
    std::fs::create_dir_all(dir.join(".git/yoneda")).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join(".git/yoneda/pushed"),
        format!(
            "{commit} - claude-code:s2\n{} - opencode:ses_9\n",
            "d".repeat(40)
        ),
    )
    .map_err(|e| e.to_string())?;
    let jsonl = [
        json!({"type":"user","message":{"role":"user","content":"Add a parser"}}),
        json!({"type":"assistant","message":{"model":"claude-sonnet-5-5","content":[
            {"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/a.rs"}}]}}),
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"fn a() {}"}]}}),
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"Added the parser."}]}}),
    ]
    .map(|l| l.to_string())
    .join("\n");
    let transcript_path = root.path().join("s2.jsonl");
    std::fs::write(&transcript_path, jsonl).map_err(|e| e.to_string())?;
    hook_with(
        "claude-stop",
        &json!({ "cwd": cwd, "session_id": "s2", "transcript_path": transcript_path }),
        true,
        &env,
    )?;
    let record = posted_record(&seen, &commit)?;
    check(
        record["summary"] == "Added the parser." && record["session_id"] == "claude-code:s2",
        &record.to_string(),
    )?;
    check(
        record["transcript"]["context"] == context.as_str(),
        &record.to_string(),
    )?;
    check(
        record["transcript"]["turns"]
            == json!([
                {"kind": "prompt", "text": "Add a parser"},
                {"kind": "tool", "name": "Read", "subject": "src/a.rs", "input": "file_path: src/a.rs", "output": "fn a() {}"},
                {"kind": "reply", "text": "Added the parser."}
            ]),
        &record["transcript"].to_string(),
    )?;

    // opencode: its plugin passes the session's messages at the run's end.
    let stop = json!({ "sessionID": "ses_9", "cwd": cwd, "model": "zai-coding-plan/glm-5.3",
    "summary": "Added jitter.", "prompts": ["Add jitter"], "messages": [
        {"type": "user", "text": "Add jitter"},
        {"type": "assistant", "content": [
            {"type": "tool", "id": "c1", "name": "edit", "state": {"status": "completed",
                "input": {"path": "src/retry.ts"}, "content": [{"type": "text", "text": "Edited."}]}},
            {"type": "text", "text": "Added jitter."}]}
    ]});
    hook_with("opencode-stop", &stop, true, &env)?;
    let record = posted_record(&seen, &"d".repeat(40))?;
    check(
        record["session_id"] == "opencode:ses_9",
        &record.to_string(),
    )?;
    check(
        record["transcript"]["turns"]
            == json!([
                {"kind": "prompt", "text": "Add jitter"},
                {"kind": "tool", "name": "edit", "subject": "src/retry.ts", "input": "path: src/retry.ts", "output": "Edited."},
                {"kind": "reply", "text": "Added jitter."}
            ]),
        &record["transcript"].to_string(),
    )?;
    // No opencode-start ran for this session: no context packet was recorded.
    check(
        record["transcript"]["context"].is_null(),
        &record.to_string(),
    )
}
