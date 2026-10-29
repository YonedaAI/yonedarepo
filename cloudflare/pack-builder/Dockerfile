# The PackBuilder image: `yoneda-pack-builder` (backend/crates/yoneda-pack-builder, its own
# workspace and lockfile) and stock Git, which builds a repository's clone packs. Built from
# the repository root (wrangler image_build_context ".."). It runs as an unprivileged user on
# port 8080, holds no credentials and has no internet: its Worker reaches it, and it reaches
# the repository's mirror and the platform only at http://mirror.internal and
# http://platform.internal, which the Worker answers (pack-builder.ts).
FROM rust:1.99.1-trixie@sha256:e259494b14672950a909b4c54527e19d29cae6ebf980672114c8bb85e5594e4a AS build
WORKDIR /source
COPY backend/crates/yoneda-pack-builder ./
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target \
    cargo test --locked && cargo build --locked --release && cp target/release/yoneda-pack-builder /yoneda-pack-builder

FROM debian:trixie-slim@sha256:89c1ea91e897f0fe0a3731595330bc45b8bdef4047464a07116f891a94054b31
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin builder \
    && mkdir -p /work && chown builder /work
COPY --from=build /yoneda-pack-builder /usr/local/bin/yoneda-pack-builder
USER builder
WORKDIR /work
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/yoneda-pack-builder"]
