# syntax=docker/dockerfile:1
# AI GitHub Maintainer — orchestrator image.
# The OpenCode server is NOT part of this image: it runs separately on the host.

ARG NODE_IMAGE=node:22.22.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Toolchain only needed if better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# npm 9/10 crash on this dependency tree (arborist "edgesOut" bug); pin npm 11.
RUN npm install -g npm@11.21.1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
# git: repository and worktree management. tini: proper signal handling as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8787 \
    CONFIG_PATH=/config/repositories.yaml
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/database/migrations ./src/database/migrations
# Runs as the image's "node" user (uid 1000) so files in bind mounts belong to the host user.
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
