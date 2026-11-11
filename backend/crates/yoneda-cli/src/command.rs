//! What the command line asks for: the parsed commands and the usage text.
mod account;
mod reads;
mod source;
mod usage;
pub use account::{OrgCommand, RepoCommand, Shell, SshKeyCommand, TokenCommand};
pub use reads::ReadCommand;
pub use source::{CheckCommand, CloneMode, SyncMode, Target};
pub use usage::USAGE;

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

/// `yoneda memory …`: the repository's memories (decisions, constraints, gotchas, how-tos, …).
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
    },
    Show {
        id: u64,
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
    /// The change's commits, the sessions behind them, what those were shown, their checks.
    Route {
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
    /// Claude Code PostToolUse on Read/Grep: records the files read, adds what is unseen on them.
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
    Version,
    /// Prints the completion script for a shell.
    Completion(Shell),
    Login {
        origin: Option<String>,
        with_token: bool,
        browser: bool,
        agent: Option<String>,
    },
    Logout {
        origin: Option<String>,
        agent: Option<String>,
    },
    /// Prints the credential the CLI sends, on stdout for a script; to a terminal with `show`.
    AuthToken {
        origin: Option<String>,
        show: bool,
    },
    Repo {
        origin: Option<String>,
        command: RepoCommand,
    },
    Org {
        origin: Option<String>,
        command: OrgCommand,
    },
    /// One query across the account's repositories (`search --all`).
    SearchAll {
        origin: Option<String>,
        query: String,
        groups: Option<Vec<String>>,
        limit: Option<u64>,
        word: bool,
        /// A page's `next`: where the page after it starts.
        after: Option<String>,
    },
    SshKey {
        origin: Option<String>,
        command: SshKeyCommand,
    },
    SshSetup {
        origin: Option<String>,
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
        mode: CloneMode,
    },
    /// Narrows (or widens) a lazy clone to these directories; `add`: to these as well.
    Sparse {
        dirs: Vec<String>,
        add: bool,
    },
    Status {
        brief: bool,
    },
    Sync(SyncMode),
    Pull,
    Reads(ReadsCommand),
    /// `git push` with the recorded reads declared; the arguments go to Git unchanged.
    Push(Vec<String>),
    /// The clone's local repository service (`yoneda-local`); the arguments go to it unchanged.
    Local(Vec<String>),
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
    /// `yoneda flight-plan`: the goal this work sets out to reach, filed before it starts.
    FlightPlan {
        target: Target,
        goal: String,
        scope: Option<String>,
        /// Default: the clone's current branch.
        branch: Option<String>,
        change: Option<u64>,
        /// Default: from the environment.
        session_id: Option<String>,
    },
    Hook(HookEvent),
    /// `yoneda context`: what a coding session starting here should know.
    Context {
        max_bytes: usize,
    },
}
