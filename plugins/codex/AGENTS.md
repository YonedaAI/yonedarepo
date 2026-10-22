## YonedaRepo

This repository's Git remote is YonedaRepo (`yoneda::https://…`). Use the `yoneda` skill. In short:

- Commit small and often. Land with `git push origin main`: the server merges disjoint concurrent changes. On a conflict, `git pull`, resolve, commit, push again.
- Never force-push `main`. Use a feature branch and `yoneda land --branch <b>` when the change needs review or checks.
- Prefer `yoneda grep <query>`, `yoneda symbols <path>`, `yoneda blame <path>` and `yoneda log [path]` (each with `--at <version>` for an earlier landed version) over reading many files.
- Tokens come from `YONEDA_TOKEN` or `yoneda login`. Never put them in commands or files.
