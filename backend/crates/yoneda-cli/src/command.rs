//! What the command line asks for: the parsed commands and the usage text.

pub const USAGE: &str = "\
usage: yoneda <command> [options]

account
  login [--origin <url>] [--with-token] [--no-browser]   device login (or a token on stdin)
  logout [--origin <url>]
  repo create <name> | repo list | repo delete <id> --confirm <name>
  repo import <dir> [--name <name>] [--batch-files <n>]  files at HEAD (or a plain dir)
  setup claude|codex|gemini                              MCP config for a coding agent

repository (default: this clone's yoneda remote; or --repo <id> [--origin <url>])
  land [--branch <b>]                 land the branch's head on main
  review approve|reject <sha> [-m <reason>]
  policy show | policy set '<json>'
  token create <name> [--scopes read,write] [--paths a/,b/] | token list | token revoke <name>
  log [path] [--ref <b>] [--limit <n>] [--at <version>]
  grep <query> [--path <p>] [-i] [--at <version>]
  blame <path> [--ref <b>]
  diff [<base>] [<head>] [--path <p>] [--at <version>]
  symbols <path> [--at <version>]
  check run <name> [--commit <sha>] | check status [<run-id>] [--commit <sha>]
  conflicts                           the last refused landing's conflicting paths

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
    },
    List,
    Delete {
        id: String,
        confirm: String,
    },
    Import {
        dir: String,
        name: Option<String>,
        batch_files: usize,
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

/// A coding agent `yoneda setup` configures.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Agent {
    Claude,
    Codex,
    Gemini,
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
    Setup {
        agent: Agent,
        origin: Option<String>,
    },
    Land {
        target: Target,
        branch: Option<String>,
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
}
