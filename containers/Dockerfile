FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node
FROM rust:1.94.0-bookworm@sha256:365468470075493dc4583f47387001854321c5a8583ea9604b297e67f01c5a4f AS build
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY xtask ./xtask
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target cargo test --locked -p yoneda-runtime -- --test-threads=1 && cargo build --locked --release -p yoneda-runtime && cp target/release/yoneda-runtime /yoneda-runtime

FROM rust:1.94.0-bookworm@sha256:365468470075493dc4583f47387001854321c5a8583ea9604b297e67f01c5a4f
COPY --from=node /usr/local/bin/ /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.16.0 @openai/codex@0.161.0 @anthropic-ai/claude-code@2.1.293 \
    && useradd --uid 1000 --create-home agent && mkdir -p /work /home/agent/.cargo && chmod 700 /root
COPY --from=build /yoneda-runtime /usr/local/bin/yoneda-runtime
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/yoneda-runtime"]
