# The SshGateway image: `yoneda-ssh-gateway` (backend/crates/yoneda-ssh-gateway, its own
# workspace and lockfile) and cloudflared, which the gateway runs beside itself on the Cloudflare
# Tunnel front door. Built from the repository root (wrangler image_build_context "..").
# No Git or toolchain at run time; it runs as an unprivileged user on port 2222 (SSH) and 8080
# (health), and reaches the platform only at http://platform.internal (platform-ssh-gateway.ts).
FROM cloudflare/cloudflared:2026.10.4@sha256:c6c7ae1d5dfdcb094ad344ed68ccffc26635c9c6be80965664c33baf064b0515 AS cloudflared
FROM rust:1.99.1-trixie@sha256:e259494b14672950a909b4c54527e19d29cae6ebf980672114c8bb85e5594e4a AS build
WORKDIR /source
COPY backend/crates/yoneda-ssh-gateway ./
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target \
    cargo test --locked && cargo build --locked --release && cp target/release/yoneda-ssh-gateway /yoneda-ssh-gateway

FROM debian:trixie-slim@sha256:89c1ea91e897f0fe0a3731595330bc45b8bdef4047464a07116f891a94054b31
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin gateway
COPY --from=build /yoneda-ssh-gateway /usr/local/bin/yoneda-ssh-gateway
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
USER gateway
EXPOSE 2222 8080
ENTRYPOINT ["/usr/local/bin/yoneda-ssh-gateway"]
