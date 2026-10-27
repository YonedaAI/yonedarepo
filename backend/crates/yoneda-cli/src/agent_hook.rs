//! Agent hook entry points (`yoneda hook <event>`, the hook's JSON on stdin), wired by the
//! Claude Code plugin (`plugins/yoneda/hooks/hooks.json`). They act only in a clone with a
//! platform remote, and never fail the session: a problem is reported on stderr.
//! - `claude-read` (PostToolUse on Read and Grep): the files the agent read (Grep: the
//!   files that matched) join this session's declared reads.
//! - `claude-bash` (PreToolUse on Bash): a plain `git push` to a smart-HTTP remote while
//!   reads are recorded is denied with the `yoneda push` that declares them. A `yoneda::`
//!   remote needs nothing: its helper declares them.
//! - `claude-stop` (Stop): a session record for each commit pushed this turn, summarised by
//!   the transcript's last assistant message (truncated; the transcript is not uploaded).
use crate::command::{HookEvent, Target};
use crate::error::{Context, Result};
use crate::session_cmd::{Here, here, record_body, relative};
use crate::session_files::SessionFiles;
use crate::target;
use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};

const SUMMARY_BYTES: usize = 4096;

pub async fn run(event: HookEvent) -> Result<()> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("reading the hook input")?;
    let hook: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let outcome = match event {
        HookEvent::ClaudeRead => read(&hook),
        HookEvent::ClaudeBash => bash(&hook).map(|deny| {
            if let Some(reason) = deny {
                println!("{}", denial(&reason));
            }
        }),
        HookEvent::ClaudeStop => stop(&hook).await,
    };
    if let Err(e) = outcome {
        eprintln!("yoneda hook: {e}");
    }
    Ok(())
}

/// The clone the hook runs in, when it has a platform remote.
fn clone_at(hook: &Value) -> Option<(Here, PathBuf)> {
    let cwd = hook["cwd"]
        .as_str()
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let at = here(&cwd).ok()?;
    (!at.platform_urls().is_empty()).then_some((at, cwd))
}

/// The paths a Read or Grep call read.
pub fn paths_read(hook: &Value) -> Vec<String> {
    let strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect()
    };
    match hook["tool_name"].as_str() {
        Some("Read") => hook["tool_input"]["file_path"]
            .as_str()
            .map(|p| vec![p.to_owned()])
            .unwrap_or_default(),
        Some("Grep") => strings(&hook["tool_response"]["filenames"]),
        _ => Vec::new(),
    }
}

fn read(hook: &Value) -> Result<()> {
    let Some((at, cwd)) = clone_at(hook) else {
        return Ok(());
    };
    let entries: Vec<String> = paths_read(hook)
        .iter()
        .filter_map(|p| relative(&at.top, &cwd, p))
        .collect();
    SessionFiles::new(&at.git_dir).add_reads(&entries)?;
    Ok(())
}

/// Whether a shell command runs `git push` (`git [-C dir] [-c k=v] push`).
pub fn runs_git_push(command: &str) -> bool {
    command
        .split([';', '&', '|', '\n', '(', ')'])
        .any(|segment| {
            // The command word: past `VAR=value` assignments.
            let mut words = segment
                .split_whitespace()
                .skip_while(|w| w.contains('=') && !w.starts_with('-'));
            if words.next() != Some("git") {
                return false;
            }
            while let Some(next) = words.next() {
                match next {
                    "-C" | "-c" => {
                        words.next();
                    }
                    flag if flag.starts_with('-') => {}
                    verb => return verb == "push",
                }
            }
            false
        })
}

/// Why a Bash call must not run as written (`None`: let it run).
fn bash(hook: &Value) -> Result<Option<String>> {
    let command = hook["tool_input"]["command"].as_str().unwrap_or_default();
    if !runs_git_push(command) || command.contains("yoneda.reads") {
        return Ok(None);
    }
    let Some((at, _)) = clone_at(hook) else {
        return Ok(None);
    };
    // Through a `yoneda::` remote the helper declares the reads itself.
    if at.platform_urls().iter().all(|u| u.starts_with("yoneda:")) {
        return Ok(None);
    }
    let reads = SessionFiles::new(&at.git_dir).reads()?;
    if reads.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "This session read {} file(s) that the push must declare, so landing can refuse it if one changed meanwhile. Run the same push as `yoneda push <the same git push arguments>` (it adds -o yoneda.reads=… and clears them after), or `yoneda reads clear` first to push without declaring them.",
        reads.len()
    )))
}

fn denial(reason: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse",
            "permissionDecision": "deny", "permissionDecisionReason": reason } })
}

/// What a Claude Code transcript (JSON lines) says about the turn: the model, the last
/// assistant text, and the person's prompts.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Transcript {
    pub model: Option<String>,
    pub last_text: Option<String>,
    pub prompts: Vec<String>,
}

fn texts(content: &Value) -> Vec<String> {
    match content {
        Value::String(text) => vec![text.clone()],
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

pub fn transcript(lines: &str) -> Transcript {
    let mut out = Transcript::default();
    for line in lines.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let message = &entry["message"];
        match entry["type"].as_str() {
            Some("assistant") => {
                if let Some(model) = message["model"].as_str() {
                    out.model = Some(model.to_owned());
                }
                let text = texts(&message["content"]).join("\n");
                if !text.trim().is_empty() {
                    out.last_text = Some(text);
                }
            }
            // Tool results come back as user messages without text parts.
            Some("user") => out.prompts.extend(texts(&message["content"])),
            _ => {}
        }
    }
    out
}

/// `text` cut to at most `max` bytes on a character boundary.
pub fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.len() <= max {
        return text.to_owned();
    }
    let cut = (0..max)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    format!("{}…", &text[..cut])
}

async fn stop(hook: &Value) -> Result<()> {
    let Some((at, cwd)) = clone_at(hook) else {
        return Ok(());
    };
    let files = SessionFiles::new(&at.git_dir);
    let pushed = files.take_pushed()?;
    if pushed.is_empty() {
        return Ok(());
    }
    let seen = match hook["transcript_path"].as_str() {
        Some(path) => transcript(&std::fs::read_to_string(Path::new(path)).unwrap_or_default()),
        None => Transcript::default(),
    };
    let summary = truncate(
        seen.last_text.as_deref().unwrap_or("Claude Code session"),
        SUMMARY_BYTES - 3,
    );
    let prompts =
        (!seen.prompts.is_empty()).then(|| yoneda_core::digest(seen.prompts.join("\n").as_bytes()));
    let transcript_ref = hook["session_id"]
        .as_str()
        .map(|id| format!("claude-code:{id}"));
    std::env::set_current_dir(&cwd).context("entering the clone")?;
    let api = target::resolve(&Target::default())?.api;
    let mut retry = Vec::new();
    for (commit, reads) in pushed {
        let body = record_body(
            "claude-code",
            seen.model.as_deref(),
            &summary,
            prompts.as_deref(),
            transcript_ref.as_deref(),
            (reads.len() == 64).then_some(reads.as_str()),
        );
        match api
            .post(&format!("/commits/{commit}/sessions"), &body)
            .await
        {
            Ok(_) => {}
            Err(f) => {
                eprintln!("yoneda hook: session record for {commit} not posted: {f}");
                // A network or server failure is retried at the next turn's end.
                if f.status == 0 || f.status >= 500 {
                    retry.push((commit, reads));
                }
            }
        }
    }
    for (commit, digest) in retry {
        files.note_pushed_digest(&commit, &digest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_git_push_in_shell_commands() {
        for yes in [
            "git push",
            "git push origin main",
            "cd w && git -C . push --force",
            "git -c http.extraHeader=x push",
            "make test; git push -u origin feature",
            "GIT_TRACE=1 git push",
        ] {
            assert!(runs_git_push(yes), "{yes}");
        }
        for no in [
            "git status",
            "echo git push",
            "yoneda push origin main",
            "git log --grep push",
            "git commit -m 'push it'",
        ] {
            assert!(!runs_git_push(no), "{no}");
        }
    }

    #[test]
    fn reads_the_paths_a_tool_call_read() {
        let read = json!({"tool_name":"Read","tool_input":{"file_path":"/w/src/a.rs"}});
        assert_eq!(paths_read(&read), ["/w/src/a.rs"]);
        let grep = json!({"tool_name":"Grep","tool_input":{"pattern":"x"},
                          "tool_response":{"mode":"files_with_matches","filenames":["src/a.rs","b.rs"]}});
        assert_eq!(paths_read(&grep), ["src/a.rs", "b.rs"]);
        assert!(paths_read(&json!({"tool_name":"Glob"})).is_empty());
    }

    #[test]
    fn summarises_a_turn_from_its_transcript() {
        let lines = [
            json!({"type":"user","message":{"role":"user","content":"Fix the parser"}}),
            json!({"type":"assistant","message":{"model":"claude-sonnet-5-5","content":[
                {"type":"text","text":"Looking."},{"type":"tool_use","name":"Read"}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}),
            json!({"type":"assistant","message":{"model":"claude-sonnet-5-5","content":[
                {"type":"text","text":"Fixed the parser and pushed."}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}),
        ]
        .map(|l| l.to_string())
        .join("\n");
        let seen = transcript(&format!("{lines}\nnot json\n"));
        assert_eq!(seen.model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(
            seen.last_text.as_deref(),
            Some("Fixed the parser and pushed.")
        );
        assert_eq!(seen.prompts, ["Fix the parser"]);
        assert_eq!(truncate("ééé", 3), "é…");
        assert_eq!(truncate(" short ", 10), "short");
    }
}
