//! `--json`: a command's result as one versioned JSON document on stdout,
//! `{ "schema": "yoneda.cli.<command>.v1", "data": ... }`, instead of its human text.
//! Each result is a Rust type (`Report`) whose JSON Schema is committed as
//! `schemas/v1/<command>.schema.json` (`cargo xtask contracts` writes them; a test fails
//! while one is stale). A failure under `--json` prints `yoneda.cli.error.v1` with a
//! stable code. Without `--json` nothing changes: commands print their text with
//! `human!`, which is silent under `--json`.
//!
//! `help`, `push` (Git's own output) and `hook` (the agent's hook protocol) have no
//! `--json` form; `push` and `hook` pass `--json` on untouched.
mod account;
mod error;
mod local;
mod reads;
mod repo;
pub mod schema;

pub use account::*;
pub use error::{ErrorCode, ErrorReport, platform as error_code};
pub use local::*;
pub use reads::*;
pub use repo::*;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

static JSON: AtomicBool = AtomicBool::new(false);

/// The schema id of `command`'s output.
pub fn schema_id(command: &str) -> String {
    format!("yoneda.cli.{command}.v1")
}

/// A command's result as `--json` prints it.
pub trait Report: Serialize + schemars::JsonSchema {
    /// The command's name in its schema id and file (`repo-list`, `change-show`, ...).
    const COMMAND: &'static str;
}

/// Whether `argv` asks for JSON: `--json` anywhere, except where the arguments belong to
/// another program (`push` passes them to Git, `hook` reads the agent's protocol).
pub fn requested(argv: &[String]) -> bool {
    !matches!(argv.first().map(String::as_str), Some("push" | "hook"))
        && argv.iter().any(|a| a == "--json")
}

/// Sets the output mode for this process (once, before the command runs).
pub fn set_json(on: bool) {
    JSON.store(on, Ordering::Relaxed);
}

/// Whether this process prints JSON instead of human text.
pub fn json() -> bool {
    JSON.load(Ordering::Relaxed)
}

/// The `--json` document for `report`.
pub fn document<R: Report>(report: &R) -> String {
    #[derive(Serialize)]
    struct Envelope<'a, T> {
        schema: String,
        data: &'a T,
    }
    let envelope = Envelope {
        schema: schema_id(R::COMMAND),
        data: report,
    };
    // Plain data with string keys: serializing it cannot fail.
    serde_json::to_string_pretty(&envelope).unwrap_or_default()
}

/// Prints `report` as the command's JSON document (nothing in human mode, where the
/// command has printed its text already).
pub fn emit<R: Report>(report: &R) {
    if json() {
        println!("{}", document(report));
    }
}

/// `println!` for a command's human text: silent under `--json`.
#[macro_export]
macro_rules! human {
    ($($arg:tt)*) => {
        if !$crate::output::json() {
            println!($($arg)*);
        }
    };
}

/// Text the person must see to finish the command (a login code): stdout, or stderr
/// under `--json` so stdout stays one document.
#[macro_export]
macro_rules! note {
    ($($arg:tt)*) => {
        if $crate::output::json() {
            eprintln!($($arg)*);
        } else {
            println!($($arg)*);
        }
    };
}

/// Declares `$type` as the `--json` result of `$command`.
macro_rules! report {
    ($($type:ty => $command:literal),* $(,)?) => {
        $(impl $crate::output::Report for $type {
            const COMMAND: &'static str = $command;
        })*
    };
}
use report;

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn json_is_requested_anywhere_except_where_arguments_belong_to_another_program() {
        assert!(requested(&argv("repo list --json")));
        assert!(requested(&argv("--json")));
        assert!(!requested(&argv("repo list")));
        assert!(!requested(&argv("push --json origin main")));
        assert!(!requested(&argv("hook claude-stop --json")));
    }

    #[test]
    fn a_document_is_the_versioned_envelope() {
        let doc = document(&ReadsClear { cleared: 2 });
        let value: serde_json::Value = serde_json::from_str(&doc).unwrap_or_default();
        assert_eq!(
            value,
            serde_json::json!({ "schema": "yoneda.cli.reads-clear.v1", "data": { "cleared": 2 } })
        );
    }
}
