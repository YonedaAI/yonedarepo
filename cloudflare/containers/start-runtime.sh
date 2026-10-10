#!/bin/sh
set -eu
# Cloudflare mounts this ephemeral CA only at runtime, after image construction.
containers_ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$containers_ca" ]; then
  cp "$containers_ca" /usr/local/share/ca-certificates/cloudflare-containers.crt
  update-ca-certificates
  export NODE_EXTRA_CA_CERTS="$containers_ca"
fi
exec /usr/local/bin/yoneda-runtime "$@"
