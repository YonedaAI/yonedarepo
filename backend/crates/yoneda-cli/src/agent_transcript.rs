//! What a coding session's own record says about a turn, for its session record: Claude
//! Code's transcript (JSON lines) summarised and turned into the transcript the record
//! uploads (prompts, tool calls with their input and output, replies; thinking is left
//! out), and the text helpers the hooks share.
use crate::error::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use yoneda_core::transcript::{self, Turn, UPLOAD};

/// The input fields that name what a tool call acted on, in order of preference.
const SUBJECT_KEYS: [&str; 10] = [
    "file_path",
    "path",
    "filePath",
    "notebook_path",
    "command",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
];

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

/// The text of a tool result's content: a string, or its text parts (an image as `[image]`).
fn result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| match p["type"].as_str() {
                Some("text") => p["text"].as_str().map(str::to_owned),
                Some("image") => Some("[image]".into()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// What a tool call acted on (a file, a command, a pattern): the first line of the first
/// of `SUBJECT_KEYS` its input has.
pub fn subject(input: &Value) -> Option<String> {
    SUBJECT_KEYS
        .iter()
        .find_map(|k| input[k].as_str())
        .map(|s| s.lines().next().unwrap_or_default().trim())
        .filter(|s| !s.is_empty())
        .map(|s| truncate(s, 200))
}

/// A tool call's input as readable text: one `name: value` line per field, a multi-line
/// value on the lines after its name (so file contents keep their real line breaks).
pub fn render_input(input: &Value) -> Option<String> {
    let text = match input {
        Value::Null => return None,
        Value::String(text) => text.clone(),
        Value::Object(fields) => fields
            .iter()
            .map(|(name, value)| match value {
                Value::String(text) if text.contains('\n') => format!("{name}:\n{text}"),
                Value::String(text) => format!("{name}: {text}"),
                other => format!("{name}: {other}"),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    };
    (!text.is_empty()).then_some(text)
}

/// The turns of a Claude Code transcript (JSON lines): the person's prompts, the
/// assistant's replies and tool calls, each call with its result. Meta entries (command
/// caveats) and subagent sidechains are left out.
pub fn claude_turns(lines: &str) -> Vec<Turn> {
    let mut turns = Vec::new();
    let mut calls: HashMap<String, usize> = HashMap::new();
    for line in lines.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry["isMeta"] == true || entry["isSidechain"] == true {
            continue;
        }
        let content = &entry["message"]["content"];
        let parts = content.as_array().into_iter().flatten();
        match entry["type"].as_str() {
            Some("user") => {
                let text = texts(content).join("\n");
                if !text.trim().is_empty() {
                    turns.push(Turn::Prompt { text });
                }
                for part in parts.filter(|p| p["type"] == "tool_result") {
                    let at = part["tool_use_id"].as_str().and_then(|id| calls.get(id));
                    if let Some(Turn::Tool { output, error, .. }) =
                        at.and_then(|i| turns.get_mut(*i))
                    {
                        *output = Some(result_text(&part["content"]));
                        *error = part["is_error"] == true;
                    }
                }
            }
            Some("assistant") => {
                if let Some(text) = content.as_str().filter(|t| !t.trim().is_empty()) {
                    turns.push(Turn::Reply {
                        text: text.to_owned(),
                    });
                }
                for part in parts {
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
                        Some("tool_use") => {
                            if let Some(id) = part["id"].as_str() {
                                calls.insert(id.to_owned(), turns.len());
                            }
                            turns.push(Turn::Tool {
                                name: part["name"].as_str().unwrap_or("tool").to_owned(),
                                subject: subject(&part["input"]),
                                input: render_input(&part["input"]),
                                output: None,
                                error: false,
                            });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    turns
}

/// The transcript a session record uploads: the context packet the session started with
/// and its turns, fitted to the upload bounds. `None` when there is neither.
pub fn document(context: Option<String>, turns: Vec<Turn>) -> Option<Value> {
    if context.is_none() && turns.is_empty() {
        return None;
    }
    let mut fitted = transcript::Transcript { context, turns };
    fitted.fit(&UPLOAD);
    serde_json::to_value(&fitted).ok()
}

/// The transcript in a file given to `yoneda session record --transcript`: a YonedaRepo
/// transcript (`{context?, turns}`), opencode's session messages (a JSON array), or
/// Claude Code's transcript (JSON lines).
pub fn from_file(path: &str) -> Result<Option<Value>> {
    let text = std::fs::read_to_string(path).context(format!("reading {path}"))?;
    match serde_json::from_str::<Value>(&text) {
        Ok(value @ Value::Object(_)) => {
            let given = transcript::Transcript::parse(&value)
                .map_err(|e| crate::error::Error::usage(e.message))?;
            Ok(document(given.context, given.turns))
        }
        Ok(messages @ Value::Array(_)) => Ok(document(
            None,
            crate::opencode_hook::transcript_turns(&messages),
        )),
        _ => Ok(document(None, claude_turns(&text))),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn turns_a_claude_code_transcript_into_prompts_tool_calls_and_replies() {
        let lines = [
            json!({"type":"user","isMeta":true,"message":{"content":"<local-command-caveat>"}}),
            json!({"type":"user","message":{"role":"user","content":"Fix the parser"}}),
            json!({"type":"assistant","message":{"model":"claude-sonnet-5-5","content":[
                {"type":"thinking","thinking":"hidden"},
                {"type":"text","text":"Looking."},
                {"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/w/src/p.rs","limit":50}}]}}),
            json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"t2","name":"Bash","input":{"command":"cargo test\n  --lib","description":"Run tests"}}]}}),
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"t1","content":"fn parse() {}"}]}}),
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"1 failed"}]}]}}),
            json!({"type":"user","isSidechain":true,"message":{"content":"a subagent's prompt"}}),
            json!({"type":"summary","summary":"x"}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"Fixed and pushed."}]}}),
        ]
        .map(|l| l.to_string())
        .join("\n");
        let turns = claude_turns(&format!("{lines}\nnot json\n"));
        assert_eq!(
            turns,
            [
                Turn::Prompt {
                    text: "Fix the parser".into()
                },
                Turn::Reply {
                    text: "Looking.".into()
                },
                Turn::Tool {
                    name: "Read".into(),
                    subject: Some("/w/src/p.rs".into()),
                    input: Some("file_path: /w/src/p.rs\nlimit: 50".into()),
                    output: Some("fn parse() {}".into()),
                    error: false,
                },
                Turn::Tool {
                    name: "Bash".into(),
                    subject: Some("cargo test".into()),
                    input: Some("command:\ncargo test\n  --lib\ndescription: Run tests".into()),
                    output: Some("1 failed".into()),
                    error: true,
                },
                Turn::Reply {
                    text: "Fixed and pushed.".into()
                },
            ]
        );
        // The upload: the context packet and the turns, fitted; nothing at all, none.
        let doc = document(Some("Repo context".into()), turns).unwrap();
        assert_eq!(doc["context"], "Repo context");
        assert_eq!(doc["turns"][2]["kind"], "tool");
        assert!(document(None, Vec::new()).is_none());
        let big = vec![Turn::Prompt {
            text: "x".repeat(200_000),
        }];
        let fitted = document(None, big).unwrap();
        assert!(fitted["turns"][0]["text"].as_str().unwrap().len() < 70_000);
    }
}
