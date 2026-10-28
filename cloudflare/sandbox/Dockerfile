# The sandbox-cli-v1 agent image (AgentSandbox, wrangler.dev-agents.jsonc `images.agent`),
# after Cloudflare's "Build a coding agent runner": git, Node.js, the pinned stock coding CLIs
# (Claude Code, Codex CLI, opencode and MiMo Code; sandbox-cli.ts runs one per agent) and the
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

# MiMo Code's npm launcher downloads its binary on first start and its releases publish no
# checksum. The binary is fetched here instead, checked against the hash pinned below, so
# nothing downloads in the offline sandbox. curl retries: the host is slow to connect.
FROM rust:1.99.1-trixie@sha256:e259494b14672950a909b4c54527e19d29cae6ebf980672114c8bb85e5594e4a AS mimo
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) target=linux-x64 sum=3793d8b08ae7c1c6cee707645da1b1c827e0f13faa5d40d076f08ea4ee1d9a5e ;; \
        arm64) target=linux-arm64 sum=220c621eb61a175ba0bc8e9c45c217abfed8dace1f17111c3717bceb95ad2ab3 ;; \
        *) echo "No MiMo Code build for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --retry 5 --retry-all-errors --connect-timeout 60 -o /tmp/mimo.tar.gz \
        "https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode/releases/v0.1.16/mimocode-$target.tar.gz" \
    && echo "$sum  /tmp/mimo.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/mimo.tar.gz --no-same-owner -C /opt mimo

FROM node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
# Pinned: Claude Code's flags and stream-json events can change between releases.
RUN npm install --global @anthropic-ai/claude-code@2.1.306
# The other stock CLIs, pinned for the same reason: Codex CLI (OpenAI Responses API only), and
# opencode and its fork MiMo Code (any connection, through bundled AI SDK providers). Their
# update checks, analytics and model-catalog fetches are off at run time (sandbox-cli.ts).
# npm runs no install scripts here; opencode's launcher finds its platform package itself, and
# MiMo Code's finds the binary the `mimo` stage checked.
RUN npm install --global @openai/codex@0.164.0 opencode-ai@1.19.4 @mimo-ai/cli@0.1.16 \
    && npm cache clean --force
COPY --from=mimo /opt/mimo /usr/local/lib/node_modules/@mimo-ai/cli/vendor/mimo
RUN codex --version && opencode --version && mimo --version
COPY --from=cli /usr/local/bin/yoneda /usr/local/bin/git-remote-yoneda /usr/local/bin/
WORKDIR /workspace
# Keep the container running between commands.
CMD ["sleep", "infinity"]
