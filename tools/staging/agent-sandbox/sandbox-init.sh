#!/bin/sh
# Root half of the agent sandbox: egress rules, then sandbox-agent as the unprivileged `agent`
# user with no capabilities and no way to gain any. Outbound, the container reaches DNS, the
# public internet (the model provider, a hosted platform) and, on the Docker host, only
# $SANDBOX_HOST_PORT (a platform the host serves, such as wrangler dev). Every private,
# link-local and shared range is refused: the host's other services (an opencode server, SSH
# agents), the LAN and cloud metadata. Docker cannot narrow the public internet to named hosts.
set -eu
fail() {
  echo "sandbox: $*" >&2
  exit 97
}
[ "$(id -u)" = 0 ] || fail "sandbox-init must start as root"
v6=/proc/sys/net/ipv6/conf/all/disable_ipv6
[ ! -e "$v6" ] || [ "$(cat "$v6")" = 1 ] || fail "IPv6 must be disabled (docker run --sysctl net.ipv6.conf.all.disable_ipv6=1)"

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
awk '/^nameserver/ && $2 !~ /:/ { print $2 }' /etc/resolv.conf | while read -r ns; do
  iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
done
if [ -n "${SANDBOX_HOST_PORT:-}" ]; then
  host=$(getent ahostsv4 host.docker.internal | awk 'NR == 1 { print $1 }')
  [ -n "$host" ] || fail "host.docker.internal does not resolve"
  iptables -A OUTPUT -d "$host" -p tcp --dport "$SANDBOX_HOST_PORT" -j ACCEPT
fi
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/3; do
  iptables -A OUTPUT -d "$net" -j REJECT
done
unset SANDBOX_HOST_PORT

exec setpriv --reuid=agent --regid=agent --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
  env HOME=/home/agent USER=agent LOGNAME=agent /usr/local/bin/sandbox-agent "$@"
