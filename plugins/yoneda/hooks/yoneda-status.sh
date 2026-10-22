#!/bin/sh
# SessionStart hook: in a Git checkout with a yoneda:: remote, print `yoneda status --brief`
# so the session starts knowing its base version and pending commits. Anywhere else it
# prints nothing. It always exits 0: a status check must never block a session.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
git remote -v 2>/dev/null | grep -q 'yoneda::' || exit 0
if ! command -v yoneda >/dev/null 2>&1; then
  echo "This repository uses a yoneda:: remote, but the yoneda CLI (and its git-remote-yoneda helper) is not on PATH. The repository's Connect panel in /source shows how to install it."
  exit 0
fi
yoneda status --brief 2>&1 || true
exit 0
