# =============================================================================
# PSP Workshop LATAM - Backstage + AWS GenAI plugin
# =============================================================================
# Builds a Backstage image with the AWS GenAI plugin already installed,
# configured and wired to Amazon Bedrock.
#
# This Dockerfile is executed by the `psp-backstage-build` CodeBuild project, so
# that the participant needs neither Node, Yarn nor Docker on their machine. It
# is a plain Dockerfile, with nothing CodeBuild specific: any CI system that
# runs `docker build` produces the same image, which lets you take this setup to
# your own company environment.
#
# To follow a build:
#   aws logs tail /aws/codebuild/psp-backstage-build --follow --region us-east-1
#
# STEPS (the same ones from the official plugin docs, automated)
#   1. Backstage scaffold with @backstage/create-app (legacy template)
#   2. yarn install to generate the lockfile
#   3. Install the 3 GenAI plugin packages
#   4. Pin a transitive dependency (LangChain) - see add-genai-resolutions.js
#   5. Patch the 3 files the official docs ask you to edit by hand
#   6. Type-check + backend build
#   7. Slim final image, production dependencies only
#
# Official docs: https://github.com/awslabs/backstage-plugins-for-aws/tree/main/plugins/genai
# =============================================================================

# -----------------------------------------------------------------------------
# STAGE 1 - build
# -----------------------------------------------------------------------------
# Node 22: the current Backstage scaffold declares "engines": { "node": "22 || 24" }.
# Node 20 fails the engine check; the `latest` tag would break reproducibility.
FROM public.ecr.aws/docker/library/node:22-bookworm AS build

# Toolchain to compile native modules (better-sqlite3, ssh2, tree-sitter...).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 g++ build-essential git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NODE_OPTIONS=--max-old-space-size=4096

WORKDIR /build

# --- STEP 1: scaffold --------------------------------------------------------
# BACKSTAGE_APP_NAME makes create-app run WITHOUT an interactive prompt (the
# name prompt is skipped when the variable exists), which is required in
# CodeBuild.
#
# `--legacy` is ESSENTIAL: the default create-app template uses the new frontend
# system (createApp({features})), and the @aws/genai-plugin-for-backstage
# package exports a page component (AgentChatPage) for the OLD system
# (AppRouter + FlatRoutes). Without --legacy there is nowhere to register the
# route.
#
# The version is pinned on purpose: a workshop must produce the same result
# months later.
ENV BACKSTAGE_APP_NAME=psp-backstage
RUN set -eu; \
    mkdir -p backstage; \
    timeout 600 npx --yes @backstage/create-app@0.9.0 \
      --path backstage --skip-install --legacy < /dev/null; \
    test -f backstage/package.json || { echo "FAILED: scaffold did not produce package.json"; exit 1; }; \
    echo "OK: Backstage scaffold created."

WORKDIR /build/backstage

# Enables the yarn 4 declared in "packageManager" by the scaffold.
RUN corepack enable && yarn --version

# --- STEP 4 (before the install): pin a transitive dependency ---------------
# Must come BEFORE any install so the lockfile is born correct.
COPY build-assets/add-genai-resolutions.js /tmp/add-genai-resolutions.js
RUN node /tmp/add-genai-resolutions.js /build/backstage

# --- STEPS 2 and 3: lockfile + plugin packages -------------------------------
# CodeBuild sets CI=true, and yarn 4 turns on `enableImmutableInstalls` when
# CI=true. The steps that NEED to write the lockfile turn the flag off
# explicitly; the gate that follows turns it back on via --immutable and proves
# the lockfile is complete and deterministic.
RUN set -eu; \
    YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install; \
    test -f yarn.lock || { echo "FAILED: yarn install did not produce yarn.lock"; exit 1; }; \
    echo "OK: yarn.lock generated."

RUN set -eu; \
    YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn workspace backend add \
      @aws/genai-plugin-for-backstage-backend@0.7.1 \
      @aws/genai-plugin-langgraph-agent-for-backstage@0.7.2 \
      @backstage/plugin-kubernetes-backend; \
    YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn workspace app add \
      @aws/genai-plugin-for-backstage@0.5.0 \
      @backstage/plugin-kubernetes \
      @roadiehq/backstage-plugin-argo-cd; \
    echo "OK: GenAI plugin packages installed."

RUN set -eu; \
    timeout 900 yarn install --immutable; \
    echo "OK: --immutable gate passed (lockfile complete)."

# --- STEP 5: patches on the scaffold files -----------------------------------
# Registers the backend plugins, creates the /assistant/:agentName route and
# adds the menu item. The script is idempotent.
COPY build-assets/apply-genai-patches.js /tmp/apply-genai-patches.js
RUN node /tmp/apply-genai-patches.js /build/backstage

# --- Plugin configuration ----------------------------------------------------
COPY build-assets/app-config.genai.yaml ./app-config.genai.yaml
COPY build-assets/app-config.workshop.yaml ./app-config.workshop.yaml

# --- STEP 6: type-check + build ---------------------------------------------
RUN set -eu; yarn tsc; echo "OK: yarn tsc with no errors."
RUN set -eu; yarn build:backend; \
    test -f packages/backend/dist/bundle.tar.gz || { echo "FAILED: bundle not generated"; exit 1; }; \
    echo "OK: backend packaged."

# -----------------------------------------------------------------------------
# STAGE 2 - runtime
# -----------------------------------------------------------------------------
# Final image: installs ONLY the production dependencies from the skeleton
# (the official Backstage Dockerfile pattern), then extracts the compiled
# bundle.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 g++ build-essential ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NODE_OPTIONS=--no-node-snapshot

WORKDIR /app

# Yarn toolchain + manifests. Separate layer because it rarely changes.
COPY --from=build /build/backstage/.yarn ./.yarn
COPY --from=build /build/backstage/.yarnrc.yml /build/backstage/backstage.json ./
COPY --from=build /build/backstage/yarn.lock /build/backstage/package.json ./
COPY --from=build /build/backstage/packages/backend/dist/skeleton.tar.gz ./

RUN set -eu; \
    tar xzf skeleton.tar.gz && rm skeleton.tar.gz; \
    corepack enable; \
    yarn workspaces focus --all --production; \
    yarn cache clean

# Compiled code + configuration + example catalog.
COPY --from=build /build/backstage/packages/backend/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz
COPY --from=build /build/backstage/app-config.yaml ./app-config.yaml
COPY --from=build /build/backstage/app-config.genai.yaml ./app-config.genai.yaml
COPY --from=build /build/backstage/app-config.workshop.yaml ./app-config.workshop.yaml
COPY --from=build /build/backstage/examples ./examples

# Backstage listens on 7007 (frontend and backend served by the same process,
# via app-backend).
EXPOSE 7007

# The model is NOT baked into the image: it comes from app-config.genai.yaml
# (genai.agents.general.langgraph.bedrock.modelId). Switching models is a
# configuration change + restart, never an image rebuild.
CMD ["node", "packages/backend", \
     "--config", "app-config.yaml", \
     "--config", "app-config.genai.yaml", \
     "--config", "app-config.workshop.yaml"]
