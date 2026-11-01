//! What the Wasm leaves in the logs: the same JSON lines as `cloudflare/worker/log.ts`, with
//! `event` first. Durable Object commands log only what the adapter cannot see: a statement that
//! failed inside the authority, and a panic, which `rustCall` and the object's caller see only as
//! a trap. A healthy command writes nothing.
use std::cell::RefCell;
use std::panic::PanicHookInfo;
use worker::{Request, console_error, event};

thread_local! {
    /// The request whose command runs now: set just before the synchronous work a panic can
    /// come from, so concurrent requests to one object cannot be confused for each other.
    static REQUEST_ID: RefCell<String> = const { RefCell::new(String::new()) };
}

const REQUEST_ID_HEADER: &str = "x-request-id";
const ID_LIMIT: usize = 64;

fn valid_id(id: &str) -> bool {
    id.len() <= ID_LIMIT
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Names the request about to run (the adapter sends the id while REQUEST_IDS is on).
pub(crate) fn serving(request: &Request) {
    let id = request.headers().get(REQUEST_ID_HEADER).ok().flatten();
    let id = id.filter(|id| valid_id(id)).unwrap_or_default();
    REQUEST_ID.with(|current| *current.borrow_mut() = id);
}

fn current_id() -> String {
    REQUEST_ID.with(|current| current.borrow().clone())
}

/// One log line, with `event` first as readers expect. `fields` are JSON strings' keys and
/// values, already chosen by the caller.
fn line(event: &str, request_id: &str, fields: &[(&str, &str)]) -> String {
    let quoted = |text: &str| serde_json::Value::from(text).to_string();
    let mut out = format!(r#"{{"event":{},"level":"error""#, quoted(event));
    if !request_id.is_empty() {
        out.push_str(&format!(r#","request_id":{}"#, quoted(request_id)));
    }
    for (key, value) in fields {
        out.push_str(&format!(",{}:{}", quoted(key), quoted(value)));
    }
    out.push('}');
    out
}

/// Logs a command's failure when it is the authority's fault. A refusal is the command's answer
/// and writes nothing; the statement's text stays out, as it can quote a value.
pub(crate) fn command_failed(e: &yoneda_core::Error) {
    if e.code == "DATABASE" {
        console_error!(
            "{}",
            line("repo.command_failed", &current_id(), &[("code", &e.code)])
        );
    }
}

/// The source position, without the build machine's paths.
fn position(file: &str, at: u32) -> String {
    let parts: Vec<&str> = file.rsplit('/').take(3).collect();
    let short: Vec<&str> = parts.into_iter().rev().collect();
    format!("{}:{at}", short.join("/"))
}

/// A panic's message only when it is a literal in the source: a formatted one can quote its
/// input, and a slice's panic quotes the text it was cutting.
fn panic_line(file: &str, at: u32, literal: Option<&str>, request_id: &str) -> String {
    let at = position(file, at);
    let message = literal.unwrap_or("formatted message withheld");
    line(
        "wasm.panic",
        request_id,
        &[("path", &at), ("message", message)],
    )
}

fn on_panic(info: &PanicHookInfo<'_>) {
    let (file, at) = info
        .location()
        .map_or(("unknown", 0), |l| (l.file(), l.line()));
    let literal = info.payload().downcast_ref::<&'static str>().copied();
    console_error!("{}", panic_line(file, at, literal, &current_id()));
}

/// Runs when an instance starts, so a fresh one after a trap has the hook too.
#[event(start)]
fn start() {
    std::panic::set_hook(Box::new(on_panic));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_names_its_place_and_only_a_literal_message() {
        let line = panic_line(
            "/Users/someone/.cargo/registry/src/index/serde_json-1.0/src/de.rs",
            7,
            Some("boom"),
            "8f1c2d3e4a5b6c7d-SJC",
        );
        assert_eq!(
            line,
            r#"{"event":"wasm.panic","level":"error","request_id":"8f1c2d3e4a5b6c7d-SJC","path":"serde_json-1.0/src/de.rs:7","message":"boom"}"#
        );
        let quoted = panic_line("src/lib.rs", 1, None, "");
        assert!(quoted.contains("formatted message withheld"), "{quoted}");
        assert!(!quoted.contains("request_id"), "{quoted}");
    }

    #[test]
    fn an_id_that_is_not_one_is_not_kept() {
        assert!(valid_id("8f1c2d3e4a5b6c7d-SJC"));
        assert!(!valid_id("a\"b"));
        assert!(!valid_id(&"a".repeat(65)));
    }
}
