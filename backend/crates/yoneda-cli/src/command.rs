//! What the command line asks for: the parsed commands and the usage text.

pub const USAGE: &str = "\
usage: yoneda <command> [options]

account
  login [--origin <url>] [--with-token] [--no-browser]   device login (or a token on stdin)
  logout [--origin <url>]
  repo create <name> [--owner <org>] [--public] | repo list | repo delete <id> --confirm <name>
  repo visibility <id> public|private   public: anyone reads (no sign-in), only members write
  repo import <dir> [--name <name>] [--batch-files <n>]  files at HEAD (or a plain dir)
  repo fork <id> [--name <name>] [--owner <org>]         a fork on your account or org (needs read)
  setup claude|codex|gemini|opencode                     a coding agent's skill or plugin and MCP config
  ssh-key add [--title <t>] <file.pub|->  | ssh-key list | ssh-key rm <id>   keys for Git over SSH

organizations (owners manage members and teams; a repository grants a team by
`team:<org>/<team>` as a member)
  org list | org create <name> | org show <org> | org repos <org>
  org delete <org> --confirm <org>   (owners; only once it owns no repositories; the name
                                      is retired for good)
  org member add <org> <account> [--role owner|member] | org member remove <org> <account>
  org team create|delete <org> <team>
  org team add|remove <org> <team> <account>

repository (default: this clone's yoneda remote; or --repo <id> [--origin <url>])
  land [--branch <b>]                 land the branch's head on main
  rebase <branch> [--onto <b>]        replay the branch onto main's head (or <b>'s) on the server
  review approve|reject <sha> [-m <reason>]
  change create [<branch>] [--title <t>] [-m <body>] [--base <b>]   open a change request on main or <b>
  change create [<branch>] --to-parent ...  in a fork: propose the branch to the parent's main
  change list [--status open|landed|closed|all]
  change show <n>                     a change: gates, reviews, comments and files
  change comment <n> -m <text> [--path <p> --line <n> --side old|new] [--resolve]
  change land <n>                     land the change's head on its base
  release create <tag> [--title <t>] [-m <notes>] [--asset <file>]   publish a tag's release
  release list | release show <tag>   releases; a release's notes and assets (with sha256)
  policy show | policy set '<json>'
  token create <name> [--scopes read,write] [--paths a/,b/] | token list | token revoke <name>
  log [path] [--ref <b>] [--limit <n>] [--at <version>]
  grep <query> [--path <p>] [-i] [--at <version>]
  blame <path> [--ref <b>] [--at <version>]
  diff [<base>] [<head>] [--path <p>] [--at <version>]
  symbols <path> [--at <version>]
  check run <name> [--commit <sha>] | check status [<run-id>] [--commit <sha>]
  conflicts                           the last refused landing's conflicting paths
  status [--brief]                    one line, no network: commits not on the platform yet
  session record [<sha>] --cli <c> --summary <text> [--model <m>] [--transcript-ref <r>]
                 [--session-id <id>]  (default id: $YONEDA_SESSION_ID or opencode's session)
  session list [<sha>]                the coding sessions recorded for a commit (default HEAD)
  context [--max-bytes <n>] [--json]  what a new coding session here should know: recent
                                      sessions, open changes, landing rules, contracts

declared reads (closure coverage: landing refuses a push whose reads changed meanwhile)
  reads add <path>... | reads list | reads clear    this session's reads ($GIT_DIR/yoneda/reads)
  push [<git push args>]              git push -o yoneda.reads=<recorded reads>, then clear them
  hook claude-start|claude-read|claude-bash|claude-stop    agent hook entry points (JSON on
  hook opencode-start|opencode-read|opencode-shell|opencode-stop      stdin; plugins/)

offline checkouts (`yoneda clone`, kept for existing scripts)
  clone <repo-id> [dir] [--origin <url>]
  status [--brief] | sync [--land | --attempt <id> [--mcp-url <url>]] | pull

Git: git clone yoneda::https://api.yonedarepo.com/<repo-id>, then fetch, pull and push.
The token comes from YONEDA_TOKEN when set, else from `yoneda login`.";

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
pub enum RepoCommand {
    Create {
        name: String,
        /// An organization to own it (the caller must be one of its owners).
        owner: Option<String>,
        /// Anyone reads it, signed in or not (default: owner and members only).
        public: bool,
    },
    List,
    /// Makes repository `id` public or private (its owner only).
    Visibility {
        id: String,
        public: bool,
    },
    Delete {
        id: String,
        confirm: String,
    },
    Import {
        dir: String,
        name: Option<String>,
        batch_files: usize,
    },
    /// A fork of repository `id`, owned by the caller's account or organization `owner`.
    Fork {
        id: String,
        name: Option<String>,
        /// An organization to own it (the caller must be one of its owners).
        owner: Option<String>,
    },
}

/// `yoneda org …`: organizations, their members and teams.
#[derive(Debug, PartialEq, Eq)]
pub enum OrgCommand {
    List,
    Create {
        name: String,
    },
    Show {
        org: String,
    },
    Repos {
        org: String,
    },
    Delete {
        org: String,
        confirm: String,
    },
    MemberAdd {
        org: String,
        account: String,
        role: String,
    },
    MemberRemove {
        org: String,
        account: String,
    },
    TeamCreate {
        org: String,
        team: String,
    },
    TeamDelete {
        org: String,
        team: String,
    },
    TeamAdd {
        org: String,
        team: String,
        account: String,
    },
    TeamRemove {
        org: String,
        team: String,
        account: String,
    },
}

/// `yoneda ssh-key …`: the account's SSH public keys (Git over SSH).
#[derive(Debug, PartialEq, Eq)]
pub enum SshKeyCommand {
    /// A public key read from `source` (a path, or `-` for stdin).
    Add {
        source: String,
        title: Option<String>,
    },
    List,
    Remove {
        id: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenCommand {
    Create {
        name: String,
        scopes: Vec<String>,
        paths: Option<Vec<String>>,
    },
    List,
    Revoke {
        name: String,
    },
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
    /// Claude Code PostToolUse on Read/Grep: records the files read.
    ClaudeRead,
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
    Hook(HookEvent),
    /// `yoneda context`: what a coding session starting here should know.
    Context {
        max_bytes: usize,
        json: bool,
    },
}
