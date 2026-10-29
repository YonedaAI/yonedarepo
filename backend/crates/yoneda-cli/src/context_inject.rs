//! Continuous context for a coding session: when it reads a file, the memories and
//! contracts anchored there, and for each new prompt, whatever is relevant to its words
//! (memories, contracts, recent sessions, open changes), each only once per session. One
//! platform read ranks them (`GET /context/relevant` with the session id, which leaves out
//! what this session was already shown and reports the bytes injected so far); the text is
//! capped at `PER_INJECTION` bytes and `PER_SESSION` bytes after the start, and each
//! injection is recorded (`POST /context/deliveries`) so the session page can show it.
//! A prompt never leaves the machine whole: only its words (3-32 letters or digits) are
//! sent, and the delivery keeps the prompt's SHA-256.
use crate::api::{Api, encode};
use crate::command::Target;
use crate::error::{Error, Result};
use crate::session_cmd::{Here, relative};
use crate::target;
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

pub const PER_INJECTION: usize = 1536;
pub const PER_SESSION: usize = 12 * 1024;
/// Smaller than this left in the session's budget: inject nothing.
const MIN_BUDGET: usize = 160;
const MAX_ITEMS: usize = 10;
const MAX_READ_PATHS: usize = 20;
const MAX_WORDS: usize = 16;
const LINE_BYTES: usize = 360;
/// A tool call waits at most this long for each platform call.
const TIMEOUT: Duration = Duration::from_secs(3);

/// What prompted an injection.
pub enum Trigger<'a> {
    /// Files the agent read (absolute, or relative to the hook's directory).
    Read(&'a [String]),
    Prompt(&'a str),
}

/// The words of a prompt that are sent as the query: 3-32 letters or digits, distinct.
pub fn prompt_words(prompt: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in prompt.split(|c: char| !c.is_alphanumeric()) {
        let word = word.to_lowercase();
        if (3..=32).contains(&word.chars().count()) && !out.contains(&word) {
            out.push(word);
        }
        if out.len() == MAX_WORDS {
            break;
        }
    }
    out
}

fn line(text: &str, max: usize) -> String {
    let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::agent_hook::truncate(&folded, max)
}

fn short(sha: &Value) -> String {
    sha.as_str()
        .map_or_else(|| "-".into(), |s| s.chars().take(7).collect())
}

/// One item as one line of context.
pub fn item_line(item: &Value) -> String {
    let text = item["text"].as_str().unwrap_or_default();
    let body = match item["type"].as_str().unwrap_or_default() {
        "memory" => {
            let memory = &item["memory"];
            let mut kind = memory["kind"].as_str().unwrap_or("memory").to_owned();
            if item["stale"] == true {
                kind.push_str(", the code changed since: verify");
            }
            let at = crate::memory_cmd::anchors(memory);
            let at = if at.is_empty() {
                String::new()
            } else {
                format!(" ({at})")
            };
            format!("[{kind}] {}{at} #{}", line(text, LINE_BYTES), item["id"])
        }
        "contract" => format!(
            "contract {} `{}`: {}",
            item["contract"]["path"].as_str().unwrap_or("?"),
            item["contract"]["symbol_path"].as_str().unwrap_or("?"),
            line(text, LINE_BYTES)
        ),
        "session" => format!(
            "earlier session ({}) on {}: {}",
            item["session"]["cli"].as_str().unwrap_or("?"),
            short(&item["session"]["commit"]),
            line(text, LINE_BYTES)
        ),
        _ => format!(
            "open change #{} on {}: {}",
            item["id"],
            item["change"]["branch"].as_str().unwrap_or("?"),
            line(text, LINE_BYTES)
        ),
    };
    format!("- {body}\n")
}

/// `items` under `heading` in at most `budget` bytes (whole lines only), and the items
/// that made it in; `None` when none fits.
pub fn render(heading: &str, items: &[Value], budget: usize) -> Option<(String, Vec<Value>)> {
    let mut text = format!("{heading}\n");
    let mut shown = Vec::new();
    for item in items {
        let next = item_line(item);
        if text.len() + next.len() > budget {
            continue;
        }
        text.push_str(&next);
        shown.push(json!({ "type": item["type"], "id": item["id"] }));
    }
    (!shown.is_empty()).then_some((text, shown))
}

/// How much of the session's budget is left after `delivered` bytes.
pub fn budget(delivered: u64) -> usize {
    PER_INJECTION.min(PER_SESSION.saturating_sub(delivered as usize))
}

async fn timed<T>(
    what: &str,
    call: impl std::future::Future<Output = std::result::Result<T, crate::api::Failure>>,
) -> Result<T> {
    tokio::time::timeout(TIMEOUT, call)
        .await
        .map_err(|_| Error::new(format!("{what}: the platform did not answer within 3 s")))?
        .map_err(Into::into)
}

/// Records that `session` was shown `items` (`bytes` of text).
pub async fn record(
    api: &Api,
    session: &str,
    trigger: &str,
    subject: Option<&str>,
    items: &[Value],
    bytes: usize,
) -> Result<()> {
    let body = json!({ "session_id": session, "trigger": trigger, "subject": subject,
                       "items": items, "bytes": bytes });
    timed(
        "recording the delivered context",
        api.post("/context/deliveries", &body),
    )
    .await
    .map(|_| ())
}

/// The context to add for `trigger` in the clone `at` (entered at `cwd`), not shown to
/// `session` yet; recorded as delivered. `None` when there is nothing new or no room.
pub async fn inject(
    at: &Here,
    cwd: &Path,
    session: &str,
    trigger: Trigger<'_>,
) -> Result<Option<String>> {
    let (query, kind, subject, heading) = match trigger {
        Trigger::Read(paths) => {
            let mut files: Vec<String> = paths
                .iter()
                .filter_map(|p| relative(&at.top, cwd, p))
                .filter(|p| !p.contains(','))
                .collect();
            files.dedup();
            files.truncate(MAX_READ_PATHS);
            let Some(first) = files.first().cloned() else {
                return Ok(None);
            };
            let heading = format!(
                "YonedaRepo memory on {first}{} (shown once per session):",
                if files.len() > 1 {
                    " and the other files read"
                } else {
                    ""
                }
            );
            let query = format!("paths={}&types=memory,contract", encode(&files.join(",")));
            (query, "read", Some(first), heading)
        }
        Trigger::Prompt(prompt) => {
            let words = prompt_words(prompt);
            if words.is_empty() {
                return Ok(None);
            }
            let query = format!("query={}", encode(&words.join(" ")));
            let digest = yoneda_core::digest(prompt.as_bytes());
            let heading = "YonedaRepo context for this prompt (shown once per session):".to_owned();
            (query, "prompt", Some(digest), heading)
        }
    };
    std::env::set_current_dir(cwd).map_err(|e| Error::new(format!("entering the clone: {e}")))?;
    let api = target::resolve(&Target::default())?.api;
    let read = timed(
        "reading the relevant context",
        api.get(&format!(
            "/context/relevant?{query}&limit={MAX_ITEMS}&session_id={}",
            encode(session)
        )),
    )
    .await?;
    let room = budget(read["delivered"]["bytes"].as_u64().unwrap_or(0));
    if room < MIN_BUDGET {
        return Ok(None);
    }
    let items = read["items"].as_array().cloned().unwrap_or_default();
    let Some((text, shown)) = render(&heading, &items, room) else {
        return Ok(None);
    };
    // Shown even when the record fails: it only dedupes later injections.
    if let Err(e) = record(&api, session, kind, subject.as_deref(), &shown, text.len()).await {
        eprintln!("yoneda hook: {e}");
    }
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory(id: u64, text: &str, stale: bool) -> Value {
        json!({"type": "memory", "id": id, "stale": stale, "text": text,
               "memory": {"kind": "gotcha", "anchors": [{"path": "src/net.rs", "symbol_path": "retry"}]}})
    }

    #[test]
    fn renders_whole_lines_within_the_budget_and_names_what_it_showed() {
        let items = [
            memory(1, "retry() must stay idempotent.", false),
            memory(2, &"long ".repeat(200), true),
            json!({"type": "contract", "id": 7, "text": "Retries with backoff.",
                   "contract": {"path": "src/net.rs", "symbol_path": "retry"}}),
        ];
        let (text, shown) = render("Heading:", &items, PER_INJECTION).unwrap();
        assert!(text.starts_with(
            "Heading:\n- [gotcha] retry() must stay idempotent. (src/net.rs#retry) #1\n"
        ));
        assert!(text.contains("[gotcha, the code changed since: verify]"));
        assert!(text.contains("- contract src/net.rs `retry`: Retries with backoff.\n"));
        assert!(text.len() <= PER_INJECTION);
        assert_eq!(shown.len(), 3);
        // A small budget keeps the lines that fit, whole.
        let (small, kept) = render("H:", &items, 120).unwrap();
        assert!(small.len() <= 120);
        assert_eq!(
            kept,
            [
                json!({"type":"memory","id":1}),
                json!({"type":"contract","id":7})
            ]
        );
        assert!(render("H:", &items, 10).is_none());
        assert!(render("H:", &[], 1000).is_none());
    }

    #[test]
    fn caps_each_injection_and_the_session() {
        assert_eq!(budget(0), PER_INJECTION);
        assert_eq!(budget((PER_SESSION - 1000) as u64), 1000);
        assert_eq!(budget(PER_SESSION as u64 + 5), 0);
    }

    #[test]
    fn sends_a_prompt_as_its_words_only() {
        let key = ["sk-ant-", "api03-"].concat() + &"Ab1".repeat(31);
        let words = prompt_words(&format!("Fix the retry budget in net.rs, key {key} ok"));
        // The credential's long body is never a word; its short prefix parts may be.
        assert_eq!(
            words,
            [
                "fix", "the", "retry", "budget", "net", "key", "ant", "api03"
            ]
        );
        assert!(prompt_words("a b c").is_empty());
        assert_eq!(prompt_words(&"word ".repeat(3)).len(), 1);
    }
}
