## YonedaRepo

This repository's Git remote is YonedaRepo (`yoneda::https://…`). Use the `yoneda` skill. In short:

- Commit small and often. Land with `git push origin main`: the server merges disjoint concurrent changes. On a conflict, `git pull`, resolve, commit, push again.
- Never force-push `main`. Use a feature branch and `yoneda land --branch <b>` when the change needs review or checks.
- Prefer `yoneda grep`, `yoneda symbols`, `yoneda blame` and `yoneda log --at <version>` over reading many files.
- Tokens come from `YONEDA_TOKEN` or `yoneda login`. Never put them in commands or files.
