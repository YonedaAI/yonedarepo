//! `--json` results of the server-side reads: log, grep, search, blame, diff and symbols.
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
    /// Where the query matched in `text`: `[start, end)` in UTF-16 code units.
    #[serde(default)]
    pub ranges: Vec<[u32; 2]>,
}

/// A file with matches.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GrepFile {
    pub path: String,
    /// Why it ranks where it does: `word` (a whole-word match), `path` (the path matched),
    /// or `substring` (only inside words). Files are listed in that order, then by hits.
    #[serde(default, rename = "match")]
    pub matched: Option<String>,
    /// Matches in the file, of which at most 20 lines are listed.
    #[serde(default)]
    pub hits: Option<u64>,
    /// The matching lines (empty: the path itself matched).
    pub lines: Vec<GrepLine>,
}

/// `grep`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Grep {
    pub results: Vec<GrepFile>,
}

/// A group of records the search found: every match counted (`capped` once the platform
/// stopped counting), the best listed.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SearchGroup<T> {
    pub count: u64,
    pub capped: bool,
    pub results: Vec<T>,
}

/// A commit whose message, recorder, touched paths or id matched.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CommitHit {
    pub commit: String,
    /// The message's first line.
    pub subject: String,
    /// Who recorded (pushed) it.
    pub principal: String,
    pub recorded_at: i64,
    /// Where the words appeared: id, subject, message, author, paths.
    pub matched: Vec<String>,
    /// Paths it touched, the matching ones first (at most 5).
    pub paths: Vec<String>,
}

/// A session record whose summary or declared reads matched.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SessionHit {
    pub id: i64,
    pub commit: String,
    pub cli: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub summary: String,
    pub at: i64,
    /// Where the words appeared: summary, reads.
    pub matched: Vec<String>,
    /// The commit's declared reads, the matching ones first (at most 5).
    pub reads: Vec<String>,
}

/// A change request whose title or description matched.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChangeHit {
    pub number: u64,
    pub title: String,
    pub status: String,
    pub branch: String,
    pub base: String,
    pub author: String,
    pub updated_at: i64,
    /// Where the words appeared: title, body.
    pub matched: Vec<String>,
}

/// `search`: one query across code, memories, commits, sessions and changes. A group not
/// asked for (or, for a path-restricted token, memories, sessions and changes) is null.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Search {
    pub query: String,
    pub groups: Vec<String>,
    /// Files whose content or path matched (empty when code was not asked for).
    pub code: Vec<GrepFile>,
    /// The platform's matching memories, unchanged.
    pub memories: Option<Vec<Value>>,
    pub commits: Option<SearchGroup<CommitHit>>,
    pub sessions: Option<SearchGroup<SessionHit>>,
    pub changes: Option<SearchGroup<ChangeHit>>,
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
    Search => "search",
    Blame => "blame",
    Diff => "diff",
    Symbols => "symbols",
}
