# The SshGateway image: `yoneda-ssh-gateway` alone (backend/crates/yoneda-ssh-gateway, its own
# workspace and lockfile). Built from the repository root (wrangler image_build_context "..").
# No shell, Git or toolchain at run time; it runs as an unprivileged user on port 2222 (SSH)
# and 8080 (health), and reaches nothing but http://platform.internal (platform-ssh-gateway.ts).
FROM rust:1.99.1-trixie@sha256:e259494b14672950a909b4c54527e19d29cae6ebf980672114c8bb85e5594e4a AS build
WORKDIR /source
COPY backend/crates/yoneda-ssh-gateway ./
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target \
    cargo test --locked && cargo build --locked --release && cp target/release/yoneda-ssh-gateway /yoneda-ssh-gateway

FROM debian:trixie-slim@sha256:89c1ea91e897f0fe0a3731595330bc45b8bdef4047464a07116f891a94054b31
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin gateway
COPY --from=build /yoneda-ssh-gateway /usr/local/bin/yoneda-ssh-gateway
USER gateway
EXPOSE 2222 8080
ENTRYPOINT ["/usr/local/bin/yoneda-ssh-gateway"]
