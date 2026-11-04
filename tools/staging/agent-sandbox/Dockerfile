# The sandbox every kit item 29 agent runs in (tools/staging/agent-sandbox.mjs): opencode, Claude
# Code, Codex, Git, Node, and this checkout's `yoneda` CLI and opencode plugin, but nothing of the host. The run
# mounts only the agent's clone at /work, starts as root just long enough for sandbox-init to
# install the egress rules, and then is the unprivileged `agent` user without capabilities.
# The same image runs the egress proxy, the agents' only way out (egress-proxy.mjs).
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
# opencode's own Linux build (glibc), pinned by the release asset's digest.
ADD --checksum=sha256:1f1ce0fc07b9245a815ffa9d652dbb80e6b0f07e5bf74ea87d2b1c0339fbac52 https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-linux-arm64.tar.gz /opencode.tar.gz
RUN mkdir /opencode && tar -xzf /opencode.tar.gz -C /opencode && find /opencode -type f -name opencode -exec install -m 755 {} /usr/local/bin/opencode \;

FROM node
# The base image's uid 1000 user (`node`) becomes `agent`. ripgrep is what opencode's grep and
# glob tools run; without it they try to download it, the sandbox refuses, and every call fails.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates iptables ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && usermod --login agent --home /home/agent --move-home node && groupmod --new-name agent node \
    && useradd --uid 1001 --user-group --no-create-home --shell /usr/sbin/nologin model-shim
# Claude Code and Codex, pinned, for the runs that compare stock agents. npm's optional platform
# packages bring each CLI's own Linux build; no postinstall reaches the network afterwards.
RUN npm install -g --no-fund --no-audit @anthropic-ai/claude-code@2.1.316 @openai/codex@0.166.0 \
    && claude --version && codex --version
COPY --from=build /usr/local/bin/yoneda /usr/local/bin/git-remote-yoneda /usr/local/bin/opencode /usr/local/bin/
COPY plugins/opencode/yoneda /opt/yoneda/plugin
COPY plugins/yoneda /opt/yoneda/claude-plugin
# The scripted stand-ins for opencode (tests/agents/e2e.mjs --fake-agents, --memory-stub), in
# their source layout.
COPY tests/agents/fake-opencode.mjs tests/agents/fake-memory-agent.mjs /opt/yoneda/fake/tests/agents/
COPY tools/staging/opencode-fake.mjs /opt/yoneda/fake/tools/staging/
# The egress proxy (run as its own container from this image) and the agent's egress check.
COPY tools/staging/agent-sandbox/egress-proxy.mjs tools/staging/agent-sandbox/egress-check.mjs /opt/yoneda/
COPY tools/staging/agent-sandbox/gateway-shim.mjs tools/staging/agent-sandbox/gateway-limits.mjs tools/staging/agent-sandbox/codex-run.mjs /opt/yoneda/
COPY --chmod=755 tools/staging/agent-sandbox/sandbox-init.sh /usr/local/sbin/sandbox-init
COPY --chmod=755 tools/staging/agent-sandbox/sandbox-agent.sh /usr/local/bin/sandbox-agent
LABEL yoneda.agent-sandbox="1"
WORKDIR /work
ENTRYPOINT ["/usr/local/sbin/sandbox-init"]
