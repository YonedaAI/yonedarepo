//! What the command line asks for: the parsed commands and the usage text.
mod account;
mod usage;
pub use account::{OrgCommand, RepoCommand, SshKeyCommand, TokenCommand};
pub use usage::USAGE;

#[derive(Debug, PartialEq, Eq)]
pub enum SyncMode {
    /// Push the pending commits to this checkout's offline branch.
    Push,
    /// Push, then land the series on the base branch.
    Land,
    /// Commit through a remote MCP contribution attempt, then submit it.
    Attempt { id: String, mcp_url: Option<String> },
}

/// Which repository a command addresses (`None`: from the current clone).
#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct Target {
    pub origin: Option<String>,
    pub repo: Option<String>,
}

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

#[derive(Debug, PartialEq, Eq)]
pub enum ReadsCommand {
    Add { paths: Vec<String> },
    List,
    Clear,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionCommand {
    Record {
        commit: Option<String>,
        cli: String,
        summary: String,
        model: Option<String>,
        transcript_ref: Option<String>,
        /// The coding session's id (default: from the environment).
        session_id: Option<String>,
        /// A transcript file to upload: Claude Code's JSON lines, opencode's messages, or a
        /// YonedaRepo transcript (`agent_transcript::from_file`).
        transcript: Option<String>,
    },
    List {
        commit: Option<String>,
    },
}

/// `yoneda release …`: releases of existing tags, with downloadable assets.
#[derive(Debug, PartialEq, Eq)]
pub enum ReleaseCommand {
    Create {
        tag: String,
        title: Option<String>,
        notes: Option<String>,
        asset: Option<String>,
    },
    List,
    Show {
        tag: String,
    },
}

/// `yoneda memory …`: the repository's memories (decisions, constraints, gotchas, how-tos).
#[derive(Debug, PartialEq, Eq)]
pub enum MemoryCommand {
    Add {
        kind: String,
        text: String,
        /// `path`, `path#symbol` or `dir/`.
        anchors: Vec<String>,
        supersedes: Option<u64>,
        commit: Option<String>,
    },
    List {
        path: Option<String>,
        kind: Option<String>,
        status: Option<String>,
        json: bool,
    },
    Show {
        id: u64,
        json: bool,
    },
    Retire {
        id: u64,
        reason: Option<String>,
    },
}

/// `yoneda change …`: change requests (a branch proposed for landing on main).
#[derive(Debug, PartialEq, Eq)]
pub enum ChangeCommand {
    Create {
        branch: Option<String>,
        title: Option<String>,
        body: Option<String>,
        /// The branch to land on (the platform defaults to main).
        base: Option<String>,
        /// In a fork: open the change on the parent, proposing this fork's branch.
        to_parent: bool,
    },
    List {
        status: Option<String>,
    },
    Show {
        number: u64,
    },
    Comment {
        number: u64,
        body: Option<String>,
        anchor: Option<Anchor>,
        resolve: bool,
    },
    Land {
        number: u64,
    },
    /// Close an open change without landing it (its author, the owner or a lander).
    Close {
        number: u64,
    },
    /// Reopen a closed change whose branch still exists with no other open change.
    Reopen {
        number: u64,
    },
    /// A closed change and its comments (its author or the owner).
    Delete {
        number: u64,
    },
}

/// A diff line a comment is anchored to (`side` is `old` or `new`).
#[derive(Debug, PartialEq, Eq)]
pub struct Anchor {
    pub path: String,
    pub line: u64,
    pub side: String,
}

/// The agent hook a `yoneda hook <event>` call serves.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum HookEvent {
    /// Claude Code SessionStart: the repository's context, and the session id exported.
    ClaudeStart,
    /// Claude Code PostToolUse on Read/Grep: records the files read, and adds the memories
    /// and contracts on them that this session has not been shown yet.
    ClaudeRead,
    /// Claude Code UserPromptSubmit: adds what is relevant to the prompt, not shown yet.
    ClaudePrompt,
    /// Claude Code PostToolUse on the git_memory_add MCP tool: notes the session added one.
    ClaudeMemory,
    /// Claude Code PreToolUse on Bash: sends `git push` with recorded reads to `yoneda push`.
    ClaudeBash,
    /// Claude Code Stop: posts a session record for each commit pushed this turn.
    ClaudeStop,
    /// The opencode plugin's events (`opencode-start|read|shell|stop`).
    Opencode(OpencodeEvent),
}

/// An opencode plugin event (`opencode_hook`).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum OpencodeEvent {
    Start,
    Read,
    Prompt,
    Memory,
    Shell,
    Stop,
}

/// A coding agent `yoneda setup` configures.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Agent {
    Claude,
    Codex,
    Gemini,
    Opencode,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    Login {
        origin: Option<String>,
        with_token: bool,
        browser: bool,
    },
    Logout {
        origin: Option<String>,
    },
    Repo {
        origin: Option<String>,
        command: RepoCommand,
    },
    Org {
        origin: Option<String>,
        command: OrgCommand,
    },
    SshKey {
        origin: Option<String>,
        command: SshKeyCommand,
    },
    Setup {
        agent: Agent,
        origin: Option<String>,
    },
    Land {
        target: Target,
        branch: Option<String>,
    },
    Rebase {
        target: Target,
        branch: String,
        onto: Option<String>,
    },
    Review {
        target: Target,
        approve: bool,
        commit: String,
        reason: Option<String>,
    },
    Policy {
        target: Target,
        set: Option<String>,
    },
    Token {
        target: Target,
        command: TokenCommand,
    },
    Read {
        target: Target,
        command: ReadCommand,
    },
    Check {
        target: Target,
        command: CheckCommand,
    },
    Conflicts,
    Clone {
        repo: String,
        dir: Option<String>,
        origin: Option<String>,
    },
    Status {
        brief: bool,
    },
    Sync(SyncMode),
    Pull,
    Reads(ReadsCommand),
    /// `git push` with the recorded reads declared; the arguments go to Git unchanged.
    Push(Vec<String>),
    Session {
        target: Target,
        command: SessionCommand,
    },
    Change {
        target: Target,
        command: ChangeCommand,
    },
    Release {
        target: Target,
        command: ReleaseCommand,
    },
    Memory {
        target: Target,
        command: MemoryCommand,
    },
    Hook(HookEvent),
    /// `yoneda context`: what a coding session starting here should know.
    Context {
        max_bytes: usize,
    },
}
