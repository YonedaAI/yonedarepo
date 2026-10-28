//! What a coding session's own record says about a turn, for its session record: Claude
//! Code's transcript (JSON lines), and the text helpers the hooks share.
use serde_json::Value;

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
}
