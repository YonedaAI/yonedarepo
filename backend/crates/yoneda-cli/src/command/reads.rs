//! The server-side reads: log, grep, search, blame, diff and symbols.

#[derive(Debug, PartialEq, Eq)]
pub enum ReadCommand {
    Log {
        path: Option<String>,
        branch: Option<String>,
        limit: Option<u64>,
        at: Option<u64>,
    },
    Grep {
        query: String,
        path: Option<String>,
        ignore_case: bool,
        /// Whole words only (identifier boundaries).
        word: bool,
        at: Option<u64>,
    },
    /// One query across code, memories, commits, sessions and changes (`groups`: some).
    Search {
        query: String,
        groups: Option<Vec<String>>,
        path: Option<String>,
        branch: Option<String>,
        limit: Option<u64>,
        word: bool,
        at: Option<u64>,
    },
    Blame {
        path: String,
        branch: Option<String>,
        at: Option<u64>,
    },
    Diff {
        base: Option<String>,
        head: Option<String>,
        path: Option<String>,
        at: Option<u64>,
    },
    Symbols {
        path: String,
        at: Option<u64>,
    },
}
