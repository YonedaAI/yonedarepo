//! The `yoneda` usage text.

pub const USAGE: &str = "\
usage: yoneda <command> [options]

clone (a yoneda:: Git remote; lazy: commits and trees now, each file's contents when Git
first needs it)
  clone <repo-id> [dir] [--origin <url>]    lazy clone (git clone yoneda::<origin>/<repo-id>)
  clone <repo-id> [dir] --full              every object (or git clone -c yoneda.lazy=false)
  clone <repo-id> [dir] --sparse <dir,...>  only these directories (and the top's files)
  sparse [--add] <dir>...                   this clone: check out only these directories (--add:
                                            these too)

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
  change close <n>                    close a change without landing it (the branch stays)
  change reopen <n>                   reopen a closed change
  change delete <n>                   delete a closed change and its comments (author or owner)
  release create <tag> [--title <t>] [-m <notes>] [--asset <file>]   publish a tag's release
  release list | release show <tag>   releases; a release's notes and assets (with sha256)
  memory add <decision|constraint|gotcha|howto> -m <text> [--anchors <path|path#symbol|dir/>,…]
             [--supersedes <id>] [--commit <sha>]   leave a memory for later sessions, shown
                                      when they read the anchored files (session: $YONEDA_SESSION_ID)
  memory list [--path <p>] [--kind <k>] [--status current|stale|draft|retired|…]
  memory show <id> | memory retire <id> [-m <reason>]
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
                 [--transcript <file>] uploads it (Claude Code JSONL, opencode messages or
                                      {context, turns}); readers see it, credentials redacted
  session list [<sha>]                the coding sessions recorded for a commit (default HEAD)
  context [--max-bytes <n>]           what a new coding session here should know: recent
                                      sessions, open changes, landing rules, contracts, memories

declared reads (closure coverage: landing refuses a push whose reads changed meanwhile)
  reads add <path>... | reads list | reads clear    this session's reads ($GIT_DIR/yoneda/reads)
  push [<git push args>]              git push -o yoneda.reads=<recorded reads>, then clear them
  hook claude-start|claude-read|claude-prompt|claude-memory|claude-bash|claude-stop
  hook opencode-start|opencode-read|opencode-prompt|opencode-memory|opencode-shell|opencode-stop
                                      agent hook entry points (JSON on stdin; plugins/)

offline checkouts (kept for existing scripts)
  clone <repo-id> [dir] --offline [--origin <url>]
  status [--brief] | sync [--land | --attempt <id> [--mcp-url <url>]] | pull

--json (any command but help, push and hook): one JSON document on stdout, schema
yoneda.cli.<command>.v1 (schemas/v1), or yoneda.cli.error.v1 with a stable code.

Git: git clone yoneda::https://api.yonedarepo.com/<repo-id> (lazy), then fetch, pull and push.
The token comes from YONEDA_TOKEN when set, else from `yoneda login`.";
