#!/bin/sh
# Root half of the agent sandbox: egress rules, then sandbox-agent as the unprivileged `agent`
# user with no capabilities and no way to gain any. The container sits on an internal Docker
# network with no route out; outbound it reaches only Docker's DNS (on loopback) and the
# egress proxy ($SANDBOX_EGRESS_PROXY, `egress-proxy.mjs`), which forwards to the allowlisted
# hosts alone (the model provider's API and the platform). Everything else is refused here
# too, so a tool that ignores the proxy settings reaches nothing.
set -eu
fail() {
  echo "sandbox: $*" >&2
  exit 97
}
[ "$(id -u)" = 0 ] || fail "sandbox-init must start as root"
v6=/proc/sys/net/ipv6/conf/all/disable_ipv6
[ ! -e "$v6" ] || [ "$(cat "$v6")" = 1 ] || fail "IPv6 must be disabled (docker run --sysctl net.ipv6.conf.all.disable_ipv6=1)"

proxy=${SANDBOX_EGRESS_PROXY:-}
case "$proxy" in
*:*) ;;
*) fail "SANDBOX_EGRESS_PROXY must be host:port" ;;
esac
address=$(getent ahostsv4 "${proxy%:*}" | awk 'NR == 1 { print $1 }')
[ -n "$address" ] || fail "the egress proxy ${proxy%:*} does not resolve"

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d "$address" -p tcp --dport "${proxy##*:}" -j ACCEPT
iptables -A OUTPUT -j REJECT

exec setpriv --reuid=agent --regid=agent --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
  env HOME=/home/agent USER=agent LOGNAME=agent /usr/local/bin/sandbox-agent "$@"
