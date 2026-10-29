# The managed agents' harness image (cloudflare/managed, HarnessContainer): Node, Git, ripgrep,
# this checkout's `yoneda` CLI and git-remote-yoneda (the lazy clone), and the three stock CLI
# agents a run may drive, each pinned: Claude Code, Codex and opencode. runner.mjs serves the
# managed Worker on :8080 and runs one review per container, as the unprivileged `agent` user.
# The container has no internet: the Worker's outbound handlers are its only way out, and they
# hold every credential (the CLIs get placeholders).
# Build context: the repository root (its .dockerignore keeps target/, .git and .local out).
FROM node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS node
FROM rust:1.99.1-trixie@sha256:e259494b14672950a909b4c54527e19d29cae6ebf980672114c8bb85e5594e4a AS build
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
COPY xtask ./xtask
# What the CLI embeds (`yoneda setup` and its MCP help).
COPY plugins ./plugins
COPY docs/remote-mcp.md ./docs/
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target cargo build --locked --release -p yoneda-cli \
    && cp target/release/yoneda target/release/git-remote-yoneda /usr/local/bin/
# opencode's own Linux build (glibc), pinned by each release asset's digest.
ARG TARGETARCH
ADD --checksum=sha256:1f1ce0fc07b9245a815ffa9d652dbb80e6b0f07e5bf74ea87d2b1c0339fbac52 https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-linux-arm64.tar.gz /opencode-arm64.tar.gz
ADD --checksum=sha256:6d597970a8cc448f1b9a9f645532584b339dd3ab9583bb5f063f13d83e54768f https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-linux-x64.tar.gz /opencode-amd64.tar.gz
RUN mkdir /opencode && tar -xzf "/opencode-${TARGETARCH}.tar.gz" -C /opencode \
    && find /opencode -type f -name opencode -exec install -m 755 {} /usr/local/bin/opencode \;

FROM node
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && usermod --login agent --home /home/agent --move-home node && groupmod --new-name agent node \
    && npm install -g @anthropic-ai/claude-code@2.1.312 @openai/codex@0.165.0 \
    && npm cache clean --force
COPY --from=build /usr/local/bin/yoneda /usr/local/bin/git-remote-yoneda /usr/local/bin/opencode /usr/local/bin/
COPY cloudflare/containers/harness/runner.mjs cloudflare/containers/harness/commands.mjs /opt/yoneda/harness/
LABEL yoneda.managed-harness="1"
RUN mkdir -p /work && chown agent:agent /work
USER agent
WORKDIR /work
EXPOSE 8080
ENTRYPOINT ["node", "/opt/yoneda/harness/runner.mjs"]
