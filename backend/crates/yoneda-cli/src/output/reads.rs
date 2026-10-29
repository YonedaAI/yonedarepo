//! `--json` results of the server-side reads: log, grep, blame, diff and symbols.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A commit in the log.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LogEntry {
    pub commit: String,
    /// The log version it landed at, if it landed.
    pub version: Option<u64>,
    /// The whole message (the human mode prints its first line).
    pub message: String,
}

/// `log`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Log {
    pub commits: Vec<LogEntry>,
}

/// A matching line.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GrepLine {
    pub line: Option<u64>,
    pub text: Option<String>,
}

/// A file with matches.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GrepFile {
    pub path: String,
    /// The matching lines (empty: the path itself matched).
    pub lines: Vec<GrepLine>,
}

/// `grep`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Grep {
    pub results: Vec<GrepFile>,
}

/// `blame`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Blame {
    /// The platform's blame of the file, unchanged.
    pub blame: Value,
}

/// A changed file.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DiffEntry {
    pub path: String,
    /// `A`, `M`, `D`, ... as the platform names the change.
    pub status: String,
    /// The unified diff, when the platform made one.
    pub patch: Option<String>,
}

/// `diff`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Diff {
    pub changes: Vec<DiffEntry>,
}

/// `symbols`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Symbols {
    /// The platform's symbol outline of the file, unchanged.
    pub symbols: Value,
}

super::report! {
    Log => "log",
    Grep => "grep",
    Blame => "blame",
    Diff => "diff",
    Symbols => "symbols",
}
