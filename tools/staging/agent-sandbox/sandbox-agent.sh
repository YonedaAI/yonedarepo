#!/bin/sh
# Agent half of the sandbox (no capabilities): refuses to start unless /work is the top level
# of a clone whose only remote is $SANDBOX_EXPECTED_ORIGIN and egress reaches nothing but the
# proxy's allowlist (egress-check.mjs), imports the model credential the
# kit writes on stdin (if any) into this container's throwaway opencode store, starts the
# gateway shim for Claude Code and Codex (if asked), and runs the command in /work with PWD=/work: opencode takes its project directory from $PWD, not from
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
node /opt/yoneda/egress-check.mjs || fail "egress reaches more than the proxy's allowlist"
if [ "${SANDBOX_CREDENTIAL:-}" = stdin ]; then
  opencode auth import --standalone >/dev/null 2>&1 || fail "opencode auth import failed"
fi
# Claude Code and Codex reach the model through the loopback shim alone (gateway-shim.mjs); the
# gateway's token stays with it, and no variable of it reaches the agent.
if [ -n "${SANDBOX_GATEWAY_URL:-}" ]; then
  NODE_USE_ENV_PROXY=1 node /opt/yoneda/gateway-shim.mjs &
  tries=0
  until node -e "require('net').connect(8719,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; do
    tries=$((tries + 1))
    [ "$tries" -lt 50 ] || fail "the gateway shim did not start"
  done
  unset SANDBOX_GATEWAY_URL SANDBOX_GATEWAY_TOKEN SANDBOX_GATEWAY_MODEL SANDBOX_GATEWAY_PROVIDER
fi
unset SANDBOX_CREDENTIAL SANDBOX_EXPECTED_ORIGIN
exec "$@" </dev/null
