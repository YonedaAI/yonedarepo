//! opencode's side of the agent hooks (`yoneda hook opencode-<event>`), called by the
//! opencode plugin (`plugins/opencode/index.ts`) with a JSON payload it assembles from
//! opencode 2's plugin events. Same behaviour as the Claude Code hooks:
//! - `opencode-start` `{sessionID, cwd}`: prints the repository's context, which the plugin
//!   adds to the session's system prompt.
//! - `opencode-read` `{tool, input, result, cwd}` (tool `execute.after`): a read tool's
//!   file, or the files a search tool's output names, join the declared reads.
//! - `opencode-shell` `{tool, input, cwd}` (tool `execute.before`): prints why a plain
//!   `git push` must go through `yoneda push`; the plugin then refuses the call.
//! - `opencode-stop` `{sessionID, cwd, model, summary, prompts}` (the session's run ended):
//!   a session record for each commit the session pushed. opencode runs every shell
//!   command with `OPENCODE_SESSION_ID`, so its pushes are noted under
//!   `opencode:<sessionID>`.
use crate::agent_hook::{self, Record};
use crate::command::OpencodeEvent;
use crate::error::Result;
use serde_json::Value;

/// Lines of a search tool's output examined for file names.
const SEARCH_LINES: usize = 500;

pub async fn run(event: OpencodeEvent, hook: &Value) -> Result<()> {
    let cwd = hook["cwd"].as_str();
    let Some((at, cwd)) = agent_hook::clone_in(cwd) else {
        return Ok(());
    };
    match event {
        OpencodeEvent::Start => {
            println!("{}", agent_hook::context_at(&cwd).await?);
        }
        OpencodeEvent::Read => {
            let read = paths_read(hook, &|p| cwd.join(p).is_file());
            agent_hook::record_reads(&at, &cwd, &read)?;
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
            let record = Record {
                cli: "opencode",
                model: hook["model"].as_str().filter(|m| !m.is_empty()),
                summary: hook["summary"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("opencode session"),
                prompts: &prompts,
                session: &session,
            };
            let posted = agent_hook::record_pushed(&at, &cwd, &record).await?;
            if posted > 0 {
                eprintln!("yoneda: recorded {session} on {posted} pushed commit(s)");
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
}
