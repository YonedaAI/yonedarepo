#!/bin/sh
# Root half of the agent sandbox: egress rules, then sandbox-agent as the unprivileged `agent`
# user with no capabilities and no way to gain any. The container sits on an internal Docker
# network with no route out; outbound it reaches only loopback (Docker's DNS among it) and the
# egress proxy ($SANDBOX_EGRESS_PROXY, `egress-proxy.mjs`, an IPv4 address:port, so no client
# needs DNS to find it), which forwards to the allowlisted hosts alone (the model provider's
# API and the platform). Everything else is refused here too, so a tool that ignores the
# proxy settings reaches nothing.
set -eu
fail() {
  echo "sandbox: $*" >&2
  exit 97
}
[ "$(id -u)" = 0 ] || fail "sandbox-init must start as root"
v6=/proc/sys/net/ipv6/conf/all/disable_ipv6
[ ! -e "$v6" ] || [ "$(cat "$v6")" = 1 ] || fail "IPv6 must be disabled (docker run --sysctl net.ipv6.conf.all.disable_ipv6=1)"

proxy=${SANDBOX_EGRESS_PROXY:-}
address=${proxy%:*}
case "$proxy" in
*[!0-9.:]* | *:*:* | :* | *: | *.*.*.*.*) fail "SANDBOX_EGRESS_PROXY must be an IPv4 address:port, not '$proxy'" ;;
*.*.*.*:*) ;;
*) fail "SANDBOX_EGRESS_PROXY must be an IPv4 address:port, not '$proxy'" ;;
esac

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d "$address" -p tcp --dport "${proxy##*:}" -j ACCEPT
iptables -A OUTPUT -j REJECT

# Start the credential holder before dropping to agent. A different UID prevents /proc
# credential reads and signals; no provider secret ever enters the agent's initial env.
if [ -n "${SANDBOX_GATEWAY_URL:-}" ]; then
  NODE_USE_ENV_PROXY=1 setpriv --reuid=model-shim --regid=model-shim --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
    env HOME=/nonexistent USER=model-shim LOGNAME=model-shim node /opt/yoneda/gateway-shim.mjs &
  tries=0
  until node -e "require('net').connect(8719,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; do
    tries=$((tries + 1))
    [ "$tries" -lt 50 ] || fail "the model shim did not start"
  done
  unset SANDBOX_GATEWAY_URL SANDBOX_GATEWAY_TOKEN SANDBOX_GATEWAY_MODEL SANDBOX_GATEWAY_PROVIDER
fi

exec setpriv --reuid=agent --regid=agent --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
  env HOME=/home/agent USER=agent LOGNAME=agent /usr/local/bin/sandbox-agent "$@"
