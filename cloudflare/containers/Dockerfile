# The CheckContainer image: `yoneda-runtime check-server` plus the toolchains platform checks
# run with (sh, git, Python, Node and npm with the workspace's TypeScript under /opt/yoneda, and Rust).
# Agents run in AgentSandbox (cloudflare/sandbox/Dockerfile), not here.
FROM node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS node
FROM rust:1.99.1-trixie@sha256:e259494b14672950a909b4c54527e19d29cae6ebf980672114c8bb85e5594e4a AS build
COPY --from=node /usr/local/bin/ /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
RUN npm install -g pnpm@12.14.0
WORKDIR /opt/yoneda
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json
RUN pnpm install --frozen-lockfile --filter yonedarepo
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
COPY xtask ./xtask
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target cargo test --locked -p yoneda-runtime && cargo build --locked --release -p yoneda-runtime && cp target/release/yoneda-runtime /yoneda-runtime

FROM rust:1.99.1-trixie@sha256:e259494b14672950a909b4c54527e19d29cae6ebf980672114c8bb85e5594e4a
COPY --from=node /usr/local/bin/ /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home agent && mkdir -p /home/agent/.cargo && chmod 700 /root
COPY --from=build /yoneda-runtime /usr/local/bin/yoneda-runtime
COPY --from=build /opt/yoneda/node_modules /opt/yoneda/node_modules
COPY --chmod=755 cloudflare/containers/start-runtime.sh /usr/local/bin/start-runtime
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start-runtime"]
