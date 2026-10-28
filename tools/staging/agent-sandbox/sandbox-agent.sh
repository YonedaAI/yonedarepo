#!/bin/sh
# Agent half of the sandbox (no capabilities): refuses to start unless /work is the top level
# of a clone whose only remote is $SANDBOX_EXPECTED_ORIGIN, imports the model credential the
# kit writes on stdin (if any) into this container's throwaway opencode store, and runs the
# command in /work with PWD=/work: opencode takes its project directory from $PWD, not from
# the process's working directory.
set -eu
fail() {
  echo "sandbox guard: $*" >&2
  exit 97
}
cd /work
export PWD=/work
top=$(git rev-parse --show-toplevel 2>/dev/null) || fail "/work is not a Git clone"
[ "$top" = /work ] || fail "/work is inside $top, not the top level of a clone"
[ "$(git remote)" = origin ] || fail "the clone's remotes are not exactly origin: $(git remote | tr '\n' ' ')"
origin=$(git remote get-url origin)
[ "$origin" = "${SANDBOX_EXPECTED_ORIGIN:-}" ] || fail "origin is $origin, expected ${SANDBOX_EXPECTED_ORIGIN:-(unset)}"
if [ "${SANDBOX_CREDENTIAL:-}" = stdin ]; then
  opencode auth import --standalone >/dev/null 2>&1 || fail "opencode auth import failed"
fi
unset SANDBOX_CREDENTIAL SANDBOX_EXPECTED_ORIGIN
exec "$@" </dev/null
