FROM oven/bun:1.3.14-debian AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN bun install --frozen-lockfile
ARG OCPP_VERSION=1.18.4-railway.037ba0eef4
ENV OCPP_CHANNEL=beta OCPP_VERSION=$OCPP_VERSION
RUN bun run packages/cli/script/build.ts --target=ocpp-linux-x64-baseline --skip-install

FROM tailscale/tailscale:stable AS tailscale
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client procps ripgrep tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /src/packages/cli/dist/cli-linux-x64-baseline/bin/ocpp /usr/local/bin/ocpp
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
RUN npm install -g @openai/codex@0.159.2 @anthropic-ai/claude-code@2.1.286 && npm cache clean --force
ENV HOME=/data/home \
    XDG_DATA_HOME=/data/home/.local/share \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_CACHE_HOME=/data/home/.cache \
    XDG_STATE_HOME=/data/home/.local/state \
    CODEX_HOME=/data/home/.codex \
    CLAUDE_CONFIG_DIR=/data/home/.claude \
    OCPP_CONFIG_DIR=/data/home/.config/ocpp \
    TAILSCALE_SOCKET=/run/tailscale/tailscaled.sock \
    PORT=8080
WORKDIR /opt/control
COPY packages/containers/railway/control.ts packages/containers/railway/dashboard.html ./
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "control.ts"]
