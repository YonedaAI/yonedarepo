## YonedaRepo

This repository's Git remote is YonedaRepo (`yoneda::https://…` or the platform's smart HTTP). The yoneda plugin gives each session the repository's context when it starts: memories other sessions left, what recent coding sessions did, open change requests, the landing rules and contracts on the files you are changing. When you read a file it adds the memories and contracts on it you have not seen, and for each new prompt what is relevant to it. Read it before you start. In short:

- Commit small and often. Land with `git push origin main`: the server merges disjoint concurrent changes, and the files you read are declared with the push. On a refusal (a conflict, or a file you read changed meanwhile), `git pull --rebase`, re-check the named paths, then push again.
- Never force-push `main`. Use a feature branch and `yoneda change create` when the change needs review or checks.
- Prefer `yoneda grep <query>`, `yoneda symbols <path>`, `yoneda blame <path>` and `yoneda log [path]` over reading many files; `yoneda context` shows the session-start context again.
- Push your commits before you finish: the session's summary is recorded on each commit it pushed.
- Leave what the code does not say (a decision, a constraint, a non-obvious fix) for later sessions: `yoneda memory add <decision|constraint|gotcha|howto> -m <text> --anchors <files>`, or the MCP tool `git_memory_add`.
- Tokens come from `YONEDA_TOKEN` or `yoneda login`. Never put them in commands or files.

## Install (opencode 2)

1. Install the `yoneda` CLI (and its `git-remote-yoneda` helper) on PATH, then `yoneda login`.
2. `yoneda setup opencode` copies `yoneda/index.ts` to `~/.config/opencode/plugins/yoneda/` and adds the YonedaRepo MCP server to `~/.config/opencode/opencode.json` (the bearer is read from `YONEDA_TOKEN` when opencode connects; no token is written). `opencode.jsonc` here is the same configuration to copy by hand; a project can instead keep the plugin in `.opencode/plugins/yoneda/`.
3. `export YONEDA_TOKEN=…`, then start opencode in a clone. opencode's own model choice applies (GLM through `zai-coding-plan/glm-5.3` by default here; `opencode auth login` stores its key).

`YONEDA_HOOK_LOG=<file>` makes the plugin append every hook call to that file as a JSON line: what opencode passed and what the hook answered (for a session start, the context it got).
