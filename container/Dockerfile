# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The BuildKit frontend above is pinned by digest, so a build fetches it by
# content address and never asks Docker Hub to resolve the `1.7` tag first. The
# tag lookup is the HEAD request that returned 500 and took two registry-skills
# legs down on 2026-09-07 with the code untouched. Resolved with
# `crane digest docker/dockerfile:1.7` (docker buildx imagetools inspect agrees).
# Bump the tag and digest together.
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin versions for reproducibility. Bump deliberately — unpinned installs mean
# every rebuild silently picks up the latest and can break in lockstep across
# all users. The global Node CLIs (claude-code, agent-browser) are
# pinned in cli-tools.json so a skill can add one with a json-merge; Bun (the
# runtime) is pinned here because it installs from a different source.
ARG BUN_VERSION=1.4.0
# GitHub CLI — pinned release tarball (not in default Debian apt). Bump deliberately.
ARG GH_VERSION=2.93.0
# Go toolchain for Go-based agent repos (e.g. la-quiniela). Versions track that
# repo's contract: GO_VERSION = go.mod's `go` directive, GOLANGCILINT_VERSION =
# the Makefile's pinned linter (the Makefile self-fetches it via `go run @ver`,
# so we only pre-warm the module/build cache here — no system binary needed).
# gofumpt is the one tool `make fmt` expects on PATH; the repo doesn't pin it,
# so we pin a current stable. Bump these alongside the repo, deliberately.
ARG GO_VERSION=1.26.4
ARG GOLANGCILINT_VERSION=v2.12.2
ARG GOFUMPT_VERSION=v0.10.0

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libnss3-tools \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        jq \
        make \
        ripgrep \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# ---- GitHub CLI (gh) ---------------------------------------------------------
# Agents use `gh` (and git) for all GitHub I/O; outbound HTTPS is injected with
# credentials by the OneCLI proxy at runtime. Pinned tarball, multi-arch.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gharch=amd64 ;; \
      arm64) gharch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gharch}.tar.gz" -o /tmp/gh.tar.gz; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gharch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${gharch}"; \
    gh --version

# gh refuses to talk to the API without a token configured. The real token is
# injected by the OneCLI proxy at the HTTPS boundary (per host pattern), so a
# non-secret placeholder here is enough to get gh to make the request — the
# proxy replaces the Authorization header. Mirrors add-vercel's `--token placeholder`.
ENV GH_TOKEN=placeholder

# The env var above only reaches tools whose process env the provider forwards.
# Codex runs its shells with a strict env allowlist (CODEX_ENV_ALLOWLIST in
# container/agent-runner/src/providers/codex-app-server.ts) that deliberately
# drops credential-shaped names, so under codex `gh` saw no token at all and
# every gh call died with "please run gh auth login". Configure the same
# placeholder in gh's own config file so authentication is provider-independent,
# and route git's GitHub credentials through gh so plain `git fetch`/`push`
# authenticate too (they otherwise prompt for a username and fail on a private
# repo). Both carry only the placeholder; the proxy still owns the real token.
#
# Written to gh's default HOME-relative location rather than pointed at with
# GH_CONFIG_DIR: an env var would be filtered by that same allowlist, whereas
# HOME is always forwarded. Nothing mounts over /home/node/.config.
RUN mkdir -p /home/node/.config/gh \
    && printf 'github.com:\n    users:\n        placeholder:\n            oauth_token: placeholder\n    oauth_token: placeholder\n    user: placeholder\n    git_protocol: https\n' > /home/node/.config/gh/hosts.yml \
    && chown -R node:node /home/node/.config \
    && chmod 600 /home/node/.config/gh/hosts.yml
# NOTE: deliberately NO git credential helper here. Plain git over HTTPS must
# keep sending NO Authorization header — that is what lets the OneCLI proxy set
# its own (`Basic {value}` for github.com). A helper that supplies the
# placeholder turns "header absent" into "header present and wrong", and the
# gateway does not appear to overwrite an existing one: git then fails with
# "Invalid username or token" instead of authenticating.

# ---- Go toolchain ------------------------------------------------------------
# Go-based agent repos build/test/lint via their Makefile, which needs a real Go
# toolchain (absent from node:slim). Installed from the official multi-arch
# tarball, pinned to the repo's go.mod version.
#
# GOPATH/GOCACHE live under a single world-writable /go so the unprivileged
# `node` user can extend them at runtime AND reuse what we pre-warm here. We
# pre-warm the pinned golangci-lint (module download + compile) and install
# gofumpt, so the agent doesn't re-download/recompile the toolchain on every
# scheduled run (containers are --rm; per-user $HOME caches don't survive).
ENV GOPATH=/go \
    GOCACHE=/go/cache \
    GOMODCACHE=/go/pkg/mod \
    PATH=/usr/local/go/bin:/usr/local/bin:$PATH
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) goarch=amd64 ;; \
      arm64) goarch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" -o /tmp/go.tar.gz; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm -f /tmp/go.tar.gz; \
    # symlink into /usr/local/bin (on the default profile PATH) so `go`/`gofmt` \
    # resolve even under a login shell that resets PATH from /etc/profile \
    ln -sf /usr/local/go/bin/go /usr/local/bin/go; \
    ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt; \
    go version; \
    # gofumpt on PATH for `make fmt` \
    GOBIN=/usr/local/bin go install "mvdan.cc/gofumpt@${GOFUMPT_VERSION}"; \
    gofumpt --version; \
    # pre-warm pinned golangci-lint (the Makefile invokes it via `go run @ver`) \
    go run "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${GOLANGCILINT_VERSION}" --version; \
    # let the runtime `node` user read + extend the shared caches \
    chmod -R a+rwX /go

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.34.5
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# The npm bundled with node:22-slim (10.9.8) vendors tar <7.5.19, which
# carries a fixable critical (GHSA-23hp-3jrh-7fpw) that the publish gate
# refuses to ship. Patch-level bump only. Drop this once the base image
# ships npm >= 10.9.9.
ARG NPM_VERSION=10.9.9
RUN npm install -g npm@${NPM_VERSION}

# Global Node CLIs the agent invokes at runtime live in cli-tools.json so a
# skill can add one with a json-merge instead of editing this Dockerfile.
# install-cli-tools.sh installs each via pnpm (pinned), writing the per-tool
# only-built-dependencies opt-ins it reads from the manifest.
COPY cli-tools.json install-cli-tools.sh /tmp/
RUN --mount=type=cache,target=/root/.cache/pnpm \
    sh /tmp/install-cli-tools.sh /tmp/cli-tools.json

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

# Drop setuid-root from the binaries Debian ships (mount, su, passwd, ...). The
# agent runs unprivileged and needs none of them.
RUN find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true

USER node
WORKDIR /workspace/group

# Only applies to a bare `docker run` — the host spawn overrides ENTRYPOINT and
# passes --init instead (see hardeningArgs in src/container-runner.ts).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

# ---- Provenance labels -------------------------------------------------------
# LAST on purpose. An ARG invalidates every layer below it, so declaring these
# up with the other build-args would make an otherwise-cached rebuild redo
# `bun install` and the pnpm global CLIs on every existing install, for two
# pieces of metadata. Labels have no filesystem effect, so they cost nothing here.
#
# Which lockfile the baked /app/node_modules came from: /app/src is mounted from
# the host checkout at every spawn, so an image and a checkout whose lockfiles
# disagree fail as a missing module inside a `--rm` container with no logs.
# container/pull.sh checks this before retagging. build.sh passes it; a bare
# `docker build` leaves it empty, which the pull path treats as unverifiable.
#
# image-source defaults to `local` so anything built from this file is honest
# unless its builder says otherwise — the retag cannot forge it after the fact.
ARG AGENT_RUNNER_LOCK_SHA256=
LABEL dev.nanoclaw.agent-runner-lock-sha256="${AGENT_RUNNER_LOCK_SHA256}"
ARG IMAGE_SOURCE=local
LABEL dev.nanoclaw.image-source="${IMAGE_SOURCE}"
