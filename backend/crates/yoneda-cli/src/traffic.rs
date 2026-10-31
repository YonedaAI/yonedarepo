//! Traffic warnings as lines of context: which open Landings are changing what this session is
//! working on (`repo_store/traffic`). An answer without any, from a platform that has not
//! heard of them, adds nothing. Each line remembers its Landing and file, so a session hears of
//! each once.
use serde_json::{Value, json};

pub const TITLE: &str = "Traffic: open Landings on what you are working on";
const READ_HEADING: &str = "CTC traffic on the files you read:";
const TITLE_BYTES: usize = 80;

fn line(warning: &Value) -> String {
    let title = warning["title"].as_str().unwrap_or_default();
    let title = crate::agent_hook::truncate(title, TITLE_BYTES);
    let who = format!(
        "Landing {} (\"{title}\", branch {})",
        warning["landing"],
        warning["branch"].as_str().unwrap_or("?")
    );
    let path = warning["path"].as_str().unwrap_or("?");
    let symbols: Vec<String> = (warning["symbols"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .map(|s| format!("`{s}`"))
        .collect();
    match (warning["overlap"].as_str(), symbols.as_slice()) {
        (Some("read"), _) => {
            format!("- {who} read {path}: changing it sends that Landing around")
        }
        (_, []) => format!("- {who} is changing {path}"),
        (_, named) => format!("- {who} is changing {} in {path}", named.join(", ")),
    }
}

/// One line each with the item a session records for it, then a count of the rest.
pub fn entries(traffic: &Value) -> Vec<(String, Value)> {
    let warnings = traffic["warnings"].as_array().map_or(&[][..], Vec::as_slice);
    let mut lines: Vec<(String, Value)> = warnings
        .iter()
        .map(|w| {
            let told = json!({ "type": "traffic", "id": w["landing"], "path": w["path"] });
            (line(w), told)
        })
        .collect();
    if let (Some(last), Some(more)) = (
        lines.last().map(|(_, told)| told.clone()),
        traffic["more"].as_u64().filter(|more| *more > 0),
    ) {
        lines.push((format!("- and {more} more on these files"), last));
    }
    lines
}

/// The warnings as a block of at most `budget` bytes (whole lines only), and what they told.
pub fn block(traffic: &Value, budget: usize) -> Option<(String, Vec<Value>)> {
    let mut text = format!("{READ_HEADING}\n");
    let mut told = Vec::new();
    for (entry, item) in entries(traffic) {
        if text.len() + entry.len() + 1 > budget {
            continue;
        }
        text.push_str(&entry);
        text.push('\n');
        if !told.contains(&item) {
            told.push(item);
        }
    }
    (!told.is_empty()).then_some((text, told))
}
