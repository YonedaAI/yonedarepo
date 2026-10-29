//! opencode's side of the agent hooks (`yoneda hook opencode-<event>`), called by the
//! opencode plugin (`plugins/opencode/index.ts`) with a JSON payload it assembles from
//! opencode 2's plugin events. Same behaviour as the Claude Code hooks:
//! - `opencode-start` `{sessionID, cwd}`: prints the repository's context, which the plugin
//!   adds to the session's system prompt, and keeps it for the session's transcript.
//! - `opencode-read` `{tool, input, result, sessionID, cwd}` (tool `execute.after`): a read
//!   tool's file, or the files a search tool's output names, join the declared reads; it
//!   prints the memories and contracts anchored there that the session has not been shown
//!   (`context_inject`), which the plugin adds to the session's next model call.
//! - `opencode-prompt` `{sessionID, cwd, prompt}` (a new user prompt, seen by the plugin's
//!   context hook): prints what is relevant to the prompt's words and not shown yet.
//! - `opencode-memory` `{sessionID, cwd}` (tool `execute.after` of git_memory_add): notes
//!   that the session added a memory.
//! - `opencode-shell` `{tool, input, cwd}` (tool `execute.before`): prints why a plain
//!   `git push` must go through `yoneda push`; the plugin then refuses the call.
//! - `opencode-stop` `{sessionID, cwd, model, summary, prompts, messages}` (the session's run
//!   ended): a session record for each commit the session pushed, with the transcript made
//!   from the session's messages and its context packet, and the summary offered as a draft
//!   memory when the session added one. opencode runs every shell command with
//!   `OPENCODE_SESSION_ID`, so its pushes are noted under `opencode:<sessionID>`.
use crate::agent_hook::{self, Record};
use crate::agent_transcript::{document, render_input, subject};
use crate::command::OpencodeEvent;
use crate::context_inject::{self, Trigger};
use crate::error::Result;
use crate::session_files::SessionFiles;
use serde_json::{Value, json};
use yoneda_core::transcript::Turn;

/// Lines of a search tool's output examined for file names.
const SEARCH_LINES: usize = 500;

pub async fn run(event: OpencodeEvent, hook: &Value) -> Result<()> {
    let cwd = hook["cwd"].as_str();
    let Some((at, cwd)) = agent_hook::clone_in(cwd) else {
        return Ok(());
    };
    match event {
        OpencodeEvent::Start => {
            let session = format!("opencode:{}", session_id(hook));
            println!("{}", agent_hook::context_at(&at, &cwd, &session).await?);
        }
        OpencodeEvent::Read => {
            let read = paths_read(hook, &|p| cwd.join(p).is_file());
            agent_hook::record_reads(&at, &cwd, &read)?;
            let session = format!("opencode:{}", session_id(hook));
            if let Some(text) =
                context_inject::inject(&at, &cwd, &session, Trigger::Read(&read)).await?
            {
                println!("{text}");
            }
        }
        OpencodeEvent::Prompt => {
            let session = format!("opencode:{}", session_id(hook));
            let prompt = hook["prompt"].as_str().unwrap_or_default();
            if let Some(text) =
                context_inject::inject(&at, &cwd, &session, Trigger::Prompt(prompt)).await?
            {
                println!("{text}");
            }
        }
        OpencodeEvent::Memory => {
            let session = format!("opencode:{}", session_id(hook));
            SessionFiles::new(&at.git_dir).note_memory_added(&session)?;
        }
        OpencodeEvent::Shell => {
            let workdir = hook["input"]["workdir"]
                .as_str()
                .map_or_else(|| cwd.clone(), |w| cwd.join(w));
            let command = shell_command(hook).unwrap_or_default();
            let at = agent_hook::clone_in(workdir.to_str()).map_or(at, |(here, _)| here);
            if let Some(reason) = agent_hook::push_refusal(&at, &command)? {
                println!("{reason}");
            }
        }
        OpencodeEvent::Stop => {
            let session = format!("opencode:{}", session_id(hook));
            let prompts: Vec<String> = hook["prompts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect();
            let context = SessionFiles::new(&at.git_dir).context(&session);
            let transcript = document(context, transcript_turns(&hook["messages"]));
            let record = Record {
                cli: "opencode",
                model: hook["model"].as_str().filter(|m| !m.is_empty()),
                summary: hook["summary"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("opencode session"),
                prompts: &prompts,
                session: &session,
                transcript: transcript.as_ref(),
            };
            let posted = agent_hook::record_pushed(&at, &cwd, &record).await;
            let summary = hook["summary"].as_str().unwrap_or_default();
            let offered = agent_hook::offer_draft(&at, &cwd, &session, summary).await;
            let posted = posted?;
            if posted > 0 {
                eprintln!("yoneda: recorded {session} on {posted} pushed commit(s)");
            }
            if offered? {
                eprintln!("yoneda: offered {session}'s summary as a draft memory");
            }
        }
    }
    Ok(())
}

fn session_id(hook: &Value) -> String {
    hook["sessionID"]
        .as_str()
        .map(|id| id.split_whitespace().collect())
        .filter(|id: &String| !id.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

/// The command of a shell tool call (opencode 2 names the tool `shell`; 1.x `bash`).
pub fn shell_command(hook: &Value) -> Option<String> {
    matches!(hook["tool"].as_str(), Some("shell" | "bash"))
        .then(|| hook["input"]["command"].as_str().map(str::to_owned))
        .flatten()
}

/// The texts of a tool result: its `output`, and its `content` text parts.
fn result_texts(result: &Value) -> Vec<&str> {
    let mut texts: Vec<&str> = result["output"].as_str().into_iter().collect();
    texts.extend(
        result["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p["text"].as_str()),
    );
    if let Some(text) = result.as_str() {
        texts.push(text);
    }
    texts
}

/// A tool call's output: its result texts, and its error's message when it failed.
fn tool_output(state: &Value) -> Option<String> {
    let mut texts = result_texts(state);
    texts.extend(
        state["error"]["message"]
            .as_str()
            .or_else(|| state["error"].as_str()),
    );
    let text = texts.join("\n");
    (!text.is_empty()).then_some(text)
}

/// The turns of an opencode session from its messages (opencode 2's session messages, as
/// the plugin's `session.context` returns them): the person's prompts, the assistant's
/// replies and tool calls, and shell commands the person ran. Reasoning is left out.
pub fn transcript_turns(messages: &Value) -> Vec<Turn> {
    let mut turns = Vec::new();
    for raw in messages.as_array().into_iter().flatten() {
        let message = if raw["info"].is_object() {
            &raw["info"]
        } else {
            raw
        };
        match message["type"].as_str() {
            Some("user") => {
                if let Some(text) = message["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    turns.push(Turn::Prompt {
                        text: text.to_owned(),
                    });
                }
            }
            Some("assistant") => {
                for part in message["content"].as_array().into_iter().flatten() {
                    match part["type"].as_str() {
                        Some("text") => {
                            if let Some(text) =
                                part["text"].as_str().filter(|t| !t.trim().is_empty())
                            {
                                turns.push(Turn::Reply {
                                    text: text.to_owned(),
                                });
                            }
                        }
                        Some("tool") => {
                            let state = &part["state"];
                            turns.push(Turn::Tool {
                                name: part["name"].as_str().unwrap_or("tool").to_owned(),
                                subject: subject(&state["input"]),
                                input: render_input(&state["input"]),
                                output: tool_output(state),
                                error: state["status"] == "error",
                            });
                        }
                        _ => {}
                    }
                }
            }
            Some("shell") => {
                let input = json!({ "command": message["command"] });
                let output = result_texts(&message["output"]).join("\n");
                turns.push(Turn::Tool {
                    name: "shell".into(),
                    subject: subject(&input),
                    input: render_input(&input),
                    output: (!output.is_empty()).then_some(output),
                    error: message["exit"].as_i64().is_some_and(|code| code != 0),
                });
            }
            _ => {}
        }
    }
    turns
}

/// The files a tool call read: a read tool's path argument; for a search tool, each output
/// line's leading `path` (before `:`) that `exists` says is a file.
pub fn paths_read(hook: &Value, exists: &dyn Fn(&str) -> bool) -> Vec<String> {
    let input = &hook["input"];
    match hook["tool"].as_str() {
        Some("read" | "view") => ["path", "filePath", "file_path"]
            .iter()
            .find_map(|k| input[k].as_str())
            .map(|p| vec![p.to_owned()])
            .unwrap_or_default(),
        Some("grep" | "search" | "glob") => {
            let mut found = Vec::new();
            for text in result_texts(&hook["result"]) {
                for line in text.lines().take(SEARCH_LINES) {
                    let candidate = line.split(':').next().unwrap_or_default().trim();
                    if !candidate.is_empty()
                        && !found.iter().any(|f| f == candidate)
                        && exists(candidate)
                    {
                        found.push(candidate.to_owned());
                    }
                }
            }
            found
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_what_opencode_tools_read() {
        let none = |_: &str| false;
        let read = json!({"tool":"read","input":{"path":"src/a.rs","offset":1,"limit":200}});
        assert_eq!(paths_read(&read, &none), ["src/a.rs"]);
        let v1 = json!({"tool":"read","input":{"filePath":"/w/b.rs"}});
        assert_eq!(paths_read(&v1, &none), ["/w/b.rs"]);
        let real = |p: &str| ["src/a.rs", "src/b.rs"].contains(&p);
        let grep = json!({"tool":"grep","input":{"pattern":"retry"},
            "result":{"content":[{"type":"text","text":"Found 3 matches\nsrc/a.rs:\n  12: retry()\nsrc/b.rs:4: retry\nsrc/a.rs:20: again"}]}});
        assert_eq!(paths_read(&grep, &real), ["src/a.rs", "src/b.rs"]);
        let glob = json!({"tool":"glob","result":{"output":"src/b.rs\nmissing.rs"}});
        assert_eq!(paths_read(&glob, &real), ["src/b.rs"]);
        assert!(paths_read(&json!({"tool":"edit","input":{"path":"x"}}), &real).is_empty());
        assert!(paths_read(&Value::Null, &real).is_empty());
    }

    #[test]
    fn finds_the_shell_command_and_the_session() {
        let v2 = json!({"tool":"shell","input":{"command":"git push origin main","workdir":"."}});
        assert_eq!(shell_command(&v2).as_deref(), Some("git push origin main"));
        let v1 = json!({"tool":"bash","input":{"command":"ls"}});
        assert_eq!(shell_command(&v1).as_deref(), Some("ls"));
        assert_eq!(
            shell_command(&json!({"tool":"read","input":{"command":"x"}})),
            None
        );
        assert_eq!(session_id(&json!({"sessionID":"ses_1"})), "ses_1");
        assert_eq!(session_id(&json!({"sessionID":"a b"})), "ab");
        assert_eq!(session_id(&json!({})), "unknown");
    }

    #[test]
    fn turns_opencode_messages_into_prompts_tool_calls_and_replies() {
        use yoneda_core::transcript::Turn;
        // opencode 2's session messages (Session.Message.*), one wrapped in `info`.
        let messages = json!([
            {"type":"user","text":"Add jitter"},
            {"type":"assistant","model":{"providerID":"zai-coding-plan","id":"glm-5.3"},"content":[
                {"type":"reasoning","text":"hm"},
                {"type":"text","text":"Reading the retry code."},
                {"type":"tool","id":"c1","name":"read","state":{"status":"completed",
                    "input":{"path":"src/retry.ts"},"content":[{"type":"text","text":"export function retry() {}"}]}},
                {"type":"tool","id":"c2","name":"shell","state":{"status":"error",
                    "input":{"command":"npm test"},"error":{"message":"exit 1"}}}]},
            {"info":{"type":"assistant","content":[{"type":"text","text":"Added jitter and pushed."}]}},
            {"type":"shell","command":"git status","output":"clean"},
            {"type":"agent-switched","agent":"build"}
        ]);
        assert_eq!(
            transcript_turns(&messages),
            [
                Turn::Prompt {
                    text: "Add jitter".into()
                },
                Turn::Reply {
                    text: "Reading the retry code.".into()
                },
                Turn::Tool {
                    name: "read".into(),
                    subject: Some("src/retry.ts".into()),
                    input: Some("path: src/retry.ts".into()),
                    output: Some("export function retry() {}".into()),
                    error: false,
                },
                Turn::Tool {
                    name: "shell".into(),
                    subject: Some("npm test".into()),
                    input: Some("command: npm test".into()),
                    output: Some("exit 1".into()),
                    error: true,
                },
                Turn::Reply {
                    text: "Added jitter and pushed.".into()
                },
                Turn::Tool {
                    name: "shell".into(),
                    subject: Some("git status".into()),
                    input: Some("command: git status".into()),
                    output: Some("clean".into()),
                    error: false,
                },
            ]
        );
        assert!(transcript_turns(&Value::Null).is_empty());
    }
}
