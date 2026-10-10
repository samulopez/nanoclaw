FROM ghcr.io/onecli/onecli@sha256:8d4a3300e915259a2fcff13614ecd7394bfd35c75d6a64d69f28a28dd23f30fe
COPY --chown=node:node scripts/onecli-codex-workspace-patch.mjs scripts/onecli-codex-workspace-check.mjs /tmp/
RUN node /tmp/onecli-codex-workspace-patch.mjs '/app/apps/web/.next/server/chunks/[root-of-the-server]__e964b775._.js' \
    && node /tmp/onecli-codex-workspace-check.mjs '/app/apps/web/.next/server/chunks/[root-of-the-server]__e964b775._.js' \
    && rm /tmp/onecli-codex-workspace-patch.mjs /tmp/onecli-codex-workspace-check.mjs
LABEL dev.nanoclaw.onecli-codex-workspace-patch="1"
