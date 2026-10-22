# The sandbox-cli-v1 agent image (AgentSandbox, wrangler.staging-agents.jsonc `images.agent`),
# after Cloudflare's "Build a coding agent runner": git, Node.js, a pinned Claude Code and the
# `yoneda` CLI with its Git remote helper, so `git clone yoneda::<platform>/<repo>` and
# `git push` work on a real disk. Everything the agent needs is installed here: at run time the
# sandbox reaches only the model endpoint and its project repository. The Durable Object uses
# only the native container exec API, so no sandbox-shim (it serves @cloudflare/sandbox classes).
FROM rust:1.99.1-trixie@sha256:e259494b14672950a909b4c54527e19d29cae6ebf980672114c8bb85e5594e4a AS cli
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
COPY xtask ./xtask
# `yoneda setup` embeds the agent plugin files.
COPY plugins ./plugins
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target \
    cargo build --locked --release -p yoneda-cli \
    && cp target/release/yoneda target/release/git-remote-yoneda /usr/local/bin/

FROM node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
# Pinned: Claude Code's flags and stream-json events can change between releases.
RUN npm install --global @anthropic-ai/claude-code@2.1.306
COPY --from=cli /usr/local/bin/yoneda /usr/local/bin/git-remote-yoneda /usr/local/bin/
WORKDIR /workspace
# Keep the container running between commands.
CMD ["sleep", "infinity"]
