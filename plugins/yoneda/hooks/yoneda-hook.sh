#!/bin/sh
# Agent hooks for declared reads and session records: hands the hook's JSON (stdin) to
# `yoneda hook <event>`, which acts only in a clone with a YonedaRepo remote:
#   claude-read  (PostToolUse Read|Grep)  the files read join .git/yoneda/reads, and the
#                                         memories and contracts on them not shown yet are
#                                         added as context
#   claude-prompt (UserPromptSubmit)      what is relevant to the prompt, not shown yet
#   claude-memory (PostToolUse git_memory_add)  notes that the session added a memory
#   claude-bash  (PreToolUse Bash)        a plain git push to a smart-HTTP remote while reads
#                                         are recorded is denied in favour of `yoneda push`
#   claude-stop  (Stop)                   a session record for each commit this session pushed,
#                                         with the session's transcript and starting context,
#                                         and its summary as a draft memory if it added one
# (claude-start, the session's context, runs from yoneda-status.sh.)
# Without the yoneda CLI on PATH it does nothing. It always exits 0: a hook never blocks
# the session on its own failure (a denial is a JSON decision on stdout, not an exit code).
if ! command -v yoneda >/dev/null 2>&1; then
  cat >/dev/null
  exit 0
fi
yoneda hook "$1" || true
exit 0
