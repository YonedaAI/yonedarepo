//! Shared source-command modes and repository selection.
#[derive(Debug, PartialEq, Eq)]
pub enum SyncMode {
    /// Push the pending commits to this checkout's offline branch.
    Push,
    /// Push, then land the series on the base branch.
    Land,
}

/// What `yoneda clone` brings.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum CloneMode {
    /// A lazy `yoneda::` clone: commits and trees; blobs when Git needs them.
    Lazy,
    /// Every object of the history (`--full`).
    Full,
    /// A lazy clone checked out only under these directories (`--sparse a,b`).
    Sparse(Vec<String>),
    /// An offline checkout synced through the API (`--offline`).
    Offline,
}

/// Which repository a command addresses (`None`: from the current clone).
#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct Target {
    pub origin: Option<String>,
    pub repo: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CheckCommand {
    Run {
        name: String,
        commit: Option<String>,
    },
    Status {
        run: Option<String>,
        commit: Option<String>,
    },
}
