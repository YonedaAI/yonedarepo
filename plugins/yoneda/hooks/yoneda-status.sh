#!/bin/sh
# SessionStart hook: in a Git checkout with a YonedaRepo remote (yoneda:: or the platform's
# smart HTTP), `yoneda hook claude-start` (hook JSON on stdin) gives the session the
# repository's context: the local status line, landing rules, what recent coding sessions
# did, open change requests and contracts on the files being changed (capped at 6 KiB),
# keeps that context for the session's transcript, and exports YONEDA_SESSION_ID so this
# session's pushes get its session record. Anywhere else it prints nothing. It always exits 0: a status check must never block a session.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { cat >/dev/null; exit 0; }
if ! command -v yoneda >/dev/null 2>&1; then
  cat >/dev/null
  if git remote -v 2>/dev/null | grep -q 'yoneda::'; then
    echo "This repository uses a yoneda:: remote, but the yoneda CLI (and its git-remote-yoneda helper) is not on PATH. Install it: curl -fsSL https://yonedarepo.com/install.sh | sh"
  fi
  exit 0
fi
yoneda hook claude-start || true
exit 0
