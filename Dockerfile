FROM node:20-slim AS base
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libdrm2 \
  libgbm1 \
  libnss3 \
  libxss1 \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV KERY_DOCKER=1

WORKDIR /app

# Install dependencies (all workspace package.json files; no source yet)
# Skip lifecycle scripts: root postinstall runs build:libs before COPY of TS sources.
COPY package.json package-lock.json* ./
COPY packages/engine/package.json packages/engine/
COPY packages/db/package.json packages/db/
COPY packages/client/package.json packages/client/
COPY packages/mcp/package.json packages/mcp/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

RUN npm install --ignore-scripts --workspaces --include-workspace-root
RUN npx playwright install ffmpeg

# Copy source
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

# Build
RUN npm run build --workspace=packages/engine
RUN npm run build --workspace=packages/db
RUN npm run build --workspace=apps/api
RUN npm run build --workspace=apps/worker
RUN npm run build --workspace=@kery/web

# Default: run migrations then start API (overridden by worker service in docker-compose)
COPY packages/db/migrations packages/db/migrations
CMD ["sh", "-c", "node packages/db/dist/migrate.js && node apps/api/dist/server.js"]
