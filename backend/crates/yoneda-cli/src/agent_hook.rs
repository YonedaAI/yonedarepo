//! Agent hook entry points (`yoneda hook <event>`, the hook's JSON on stdin), wired by the
//! Claude Code plugin (`plugins/yoneda/hooks/hooks.json`) and the opencode plugin
//! (`plugins/opencode`, events in `opencode_hook`). They act only in a clone with a platform
//! remote, and never fail the session: a problem is reported on stderr.
//! - `claude-start` (SessionStart): the repository's context (`yoneda context`) as the
//!   session's additional context (kept for its transcript), and
//!   `YONEDA_SESSION_ID=claude-code:<id>` exported to the session's shell
//!   (`CLAUDE_ENV_FILE`), so its pushes are noted as its own.
//! - `claude-read` (PostToolUse on Read and Grep): the files the agent read (Grep: the
//!   files that matched) join this session's declared reads, and the memories and
//!   contracts anchored there that the session has not been shown come back as additional
//!   context (`context_inject`: capped per injection and per session, recorded).
//! - `claude-prompt` (UserPromptSubmit): what is relevant to the prompt's words and not
//!   shown yet, the same way.
//! - `claude-memory` (PostToolUse on the git_memory_add MCP tool): notes that the session
//!   added a memory.
//! - `claude-bash` (PreToolUse on Bash): a plain `git push` to a smart-HTTP remote while
//!   reads are recorded is denied with the `yoneda push` that declares them. A `yoneda::`
//!   remote needs nothing: its helper declares them.
//! - `claude-stop` (Stop): a session record for each commit this session pushed, summarised
//!   by the transcript's last assistant message (truncated), with the transcript itself
//!   (fitted to the upload bounds; the platform redacts credentials) and the context packet.
//!   When the session added a memory since the last turn ended, that summary is also
//!   offered as a draft memory, for a person to publish or discard; nothing is generated.
use crate::agent_transcript::{claude_turns, document, transcript};
use crate::command::{HookEvent, Target};
use crate::context_inject::{self, Trigger};
use crate::error::{Context, Result};
use crate::session_cmd::{Here, here, record_body, relative};
use crate::session_files::SessionFiles;
use crate::{context_cmd, opencode_hook, target};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub use crate::agent_transcript::truncate;

const SUMMARY_BYTES: usize = 4096;
/// A memory's text limit (the platform's `MAX_TEXT`).
const MEMORY_BYTES: usize = 2048;

pub async fn run(event: HookEvent) -> Result<()> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("reading the hook input")?;
    let hook: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let outcome = match event {
        HookEvent::ClaudeStart => start(&hook).await,
        HookEvent::ClaudeRead => read(&hook).await,
        HookEvent::ClaudePrompt => prompt(&hook).await,
        HookEvent::ClaudeMemory => memory_added(&hook),
        HookEvent::ClaudeBash => bash(&hook).map(|deny| {
            if let Some(reason) = deny {
                println!("{}", denial(&reason));
            }
        }),
        HookEvent::ClaudeStop => claude_stop(&hook).await,
        HookEvent::Opencode(event) => opencode_hook::run(event, &hook).await,
    };
    if let Err(e) = outcome {
        eprintln!("yoneda hook: {e}");
    }
    Ok(())
}

/// The clone at `cwd` (default: the current directory), when it has a platform remote.
pub fn clone_in(cwd: Option<&str>) -> Option<(Here, PathBuf)> {
    let cwd = cwd
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let at = here(&cwd).ok()?;
    (!at.platform_urls().is_empty()).then_some((at, cwd))
}

fn clone_at(hook: &Value) -> Option<(Here, PathBuf)> {
    clone_in(hook["cwd"].as_str())
}

/// The context text for `session` starting in the clone at `cwd`, kept for its transcript;
/// the items it carries are recorded as delivered, so later injections skip them.
pub async fn context_at(at: &Here, cwd: &Path, session: &str) -> Result<String> {
    std::env::set_current_dir(cwd).context("entering the clone")?;
    let packet = context_cmd::for_hook(context_cmd::DEFAULT_BYTES).await;
    SessionFiles::new(&at.git_dir).save_context(session, &packet.text)?;
    if !packet.items.is_empty() {
        let recorded = async {
            let api = target::resolve(&Target::default())?.api;
            context_inject::record(
                &api,
                session,
                "start",
                None,
                &packet.items,
                packet.text.len(),
            )
            .await
        };
        if let Err(e) = recorded.await {
            eprintln!("yoneda hook: {e}");
        }
    }
    Ok(packet.text)
}

/// The Claude Code session a hook runs for (`claude-code:<id>`).
fn claude_session(hook: &Value) -> String {
    let id: String = hook["session_id"]
        .as_str()
        .unwrap_or("unknown")
        .split_whitespace()
        .collect();
    format!("claude-code:{id}")
}

async fn start(hook: &Value) -> Result<()> {
    let Some((at, cwd)) = clone_at(hook) else {
        return Ok(());
    };
    if let (Some(id), Ok(file)) = (
        hook["session_id"].as_str(),
        std::env::var("CLAUDE_ENV_FILE"),
    ) {
        let id = id.split_whitespace().collect::<String>();
        let mut env = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .context("opening CLAUDE_ENV_FILE")?;
        writeln!(env, "export YONEDA_SESSION_ID='claude-code:{id}'")
            .context("writing CLAUDE_ENV_FILE")?;
    }
    let text = context_at(&at, &cwd, &claude_session(hook)).await?;
    println!(
        "{}",
        json!({ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": text } })
    );
    Ok(())
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

/// Records `paths` (absolute, or relative to `cwd`) as read in the clone `at`.
pub fn record_reads(at: &Here, cwd: &Path, paths: &[String]) -> Result<usize> {
    let entries: Vec<String> = paths
        .iter()
        .filter_map(|p| relative(&at.top, cwd, p))
        .collect();
    SessionFiles::new(&at.git_dir).add_reads(&entries)
}

/// Prints `text` as additional context for the hook `event`.
fn add_context(event: &str, text: &str) {
    println!(
        "{}",
        json!({ "hookSpecificOutput": { "hookEventName": event, "additionalContext": text } })
    );
}

async fn read(hook: &Value) -> Result<()> {
    let Some((at, cwd)) = clone_at(hook) else {
        return Ok(());
    };
    let paths = paths_read(hook);
    record_reads(&at, &cwd, &paths)?;
    let session = claude_session(hook);
    if let Some(text) = context_inject::inject(&at, &cwd, &session, Trigger::Read(&paths)).await? {
        add_context("PostToolUse", &text);
    }
    Ok(())
}

async fn prompt(hook: &Value) -> Result<()> {
    let Some((at, cwd)) = clone_at(hook) else {
        return Ok(());
    };
    let prompt = hook["prompt"].as_str().unwrap_or_default();
    let session = claude_session(hook);
    if let Some(text) = context_inject::inject(&at, &cwd, &session, Trigger::Prompt(prompt)).await?
    {
        add_context("UserPromptSubmit", &text);
    }
    Ok(())
}

fn memory_added(hook: &Value) -> Result<()> {
    let Some((at, _)) = clone_at(hook) else {
        return Ok(());
    };
    SessionFiles::new(&at.git_dir).note_memory_added(&claude_session(hook))
}

/// When `session` added a memory since its last turn ended, offers `summary` (the agent's
/// own last message) as a draft memory a person can publish or discard. Returns whether one
/// was posted.
pub async fn offer_draft(at: &Here, cwd: &Path, session: &str, summary: &str) -> Result<bool> {
    let files = SessionFiles::new(&at.git_dir);
    if summary.trim().is_empty() || !files.take_memory_added(session)? {
        return Ok(false);
    }
    std::env::set_current_dir(cwd).context("entering the clone")?;
    let api = target::resolve(&Target::default())?.api;
    let body = json!({ "kind": "decision", "draft": true, "session_id": session,
                       "text": truncate(summary.trim(), MEMORY_BYTES - 3) });
    match api.post("/memories", &body).await {
        Ok(_) => Ok(true),
        Err(f) => {
            eprintln!("yoneda hook: the session summary was not offered as a draft memory: {f}");
            Ok(false)
        }
    }
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

/// Why `command`, run in the clone `at`, must not run as written (`None`: let it run).
pub fn push_refusal(at: &Here, command: &str) -> Result<Option<String>> {
    if !runs_git_push(command) || command.contains("yoneda.reads") {
        return Ok(None);
    }
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

fn bash(hook: &Value) -> Result<Option<String>> {
    let command = hook["tool_input"]["command"].as_str().unwrap_or_default();
    let Some((at, _)) = clone_at(hook) else {
        return Ok(None);
    };
    push_refusal(&at, command)
}

fn denial(reason: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse",
            "permissionDecision": "deny", "permissionDecisionReason": reason } })
}

/// What a session's records say about it.
pub struct Record<'a> {
    pub cli: &'a str,
    pub model: Option<&'a str>,
    pub summary: &'a str,
    pub prompts: &'a [String],
    pub session: &'a str,
    /// The transcript to upload with each record (`agent_transcript::document`).
    pub transcript: Option<&'a Value>,
}

/// Posts a session record for each commit `record.session` pushed from the clone `at` (and
/// for pushes no session claimed). A commit stays noted until its record is posted or
/// refused for good: a failure before posting, a network, conflict, rate or server failure,
/// or this process being killed, leaves it for the next turn's end. Returns how many records
/// were posted.
pub async fn record_pushed(at: &Here, cwd: &Path, record: &Record<'_>) -> Result<usize> {
    let files = SessionFiles::new(&at.git_dir);
    let pushed = files.pending_pushed(Some(record.session))?;
    if pushed.is_empty() {
        return Ok(0);
    }
    let (posted, done) = post_records(cwd, record, &pushed).await?;
    files.forget_pushed(&done)?;
    Ok(posted)
}

/// Posts `record` on each of `pushed`: how many were posted, and the commits done with
/// (posted, or refused for a reason a retry would not change).
async fn post_records(
    cwd: &Path,
    record: &Record<'_>,
    pushed: &[crate::session_files::Pushed],
) -> Result<(usize, Vec<String>)> {
    let summary = truncate(record.summary, SUMMARY_BYTES - 3);
    let prompts = (!record.prompts.is_empty())
        .then(|| yoneda_core::digest(record.prompts.join("\n").as_bytes()));
    std::env::set_current_dir(cwd).context("entering the clone")?;
    let api = target::resolve(&Target::default())?.api;
    let mut done = Vec::new();
    let mut posted = 0;
    for push in pushed {
        let mut body = record_body(
            record.cli,
            record.model,
            &summary,
            prompts.as_deref(),
            Some(record.session),
            push.reads.as_deref(),
            Some(record.session),
        );
        if let Some(transcript) = record.transcript {
            body["transcript"] = transcript.clone();
        }
        match api
            .post(&format!("/commits/{}/sessions", push.commit), &body)
            .await
        {
            Ok(_) => {
                posted += 1;
                done.push(push.commit.clone());
            }
            Err(f) => {
                eprintln!(
                    "yoneda hook: session record for {} not posted: {f}",
                    push.commit
                );
                if !(matches!(f.status, 0 | 409 | 429) || f.status >= 500) {
                    done.push(push.commit.clone());
                }
            }
        }
    }
    Ok((posted, done))
}

async fn claude_stop(hook: &Value) -> Result<()> {
    let Some((at, cwd)) = clone_at(hook) else {
        return Ok(());
    };
    let lines = hook["transcript_path"]
        .as_str()
        .and_then(|path| std::fs::read_to_string(Path::new(path)).ok())
        .unwrap_or_default();
    let seen = transcript(&lines);
    let session = claude_session(hook);
    let context = SessionFiles::new(&at.git_dir).context(&session);
    let uploaded = document(context, claude_turns(&lines));
    let record = Record {
        cli: "claude-code",
        model: seen.model.as_deref(),
        summary: seen.last_text.as_deref().unwrap_or("Claude Code session"),
        prompts: &seen.prompts,
        session: &session,
        transcript: uploaded.as_ref(),
    };
    let recorded = record_pushed(&at, &cwd, &record).await;
    let offered = offer_draft(
        &at,
        &cwd,
        &session,
        seen.last_text.as_deref().unwrap_or_default(),
    )
    .await;
    recorded?;
    offered.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn a_record_pass_that_fails_before_posting_keeps_the_pushes() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let git = crate::git::Git::new(dir.path());
        git.run(&["init", "-q"])?;
        git.run(&[
            "remote",
            "add",
            "origin",
            "yoneda::https://api.example.invalid/r1",
        ])?;
        let at = here(dir.path())?;
        let files = SessionFiles::new(&at.git_dir);
        files.note_pushed(&["c1".to_owned()], &[], Some("opencode:s1"))?;
        let record = Record {
            cli: "opencode",
            model: None,
            summary: "Added clamp.",
            prompts: &[],
            session: "opencode:s1",
            transcript: None,
        };
        // The clone cannot be entered: nothing is posted, and nothing may be forgotten.
        let gone = dir.path().join("gone");
        assert!(record_pushed(&at, &gone, &record).await.is_err());
        let kept = files.pending_pushed(Some("opencode:s1"))?;
        assert_eq!(
            kept.iter().map(|p| p.commit.as_str()).collect::<Vec<_>>(),
            ["c1"]
        );
        Ok(())
    }

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
}
