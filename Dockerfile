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

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
COPY packages/engine/package.json packages/engine/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm install --workspaces --include-workspace-root 2>/dev/null || npm install

# Copy source
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

# Build
RUN npm run build --workspace=packages/engine 2>/dev/null || true
RUN npm run build --workspace=packages/db 2>/dev/null || true
RUN npm run build --workspace=apps/api 2>/dev/null || true

# Run migrations then start
COPY packages/db/migrations packages/db/migrations
CMD ["sh", "-c", "node --loader ts-node/esm packages/db/src/migrate.ts && node --loader tsx apps/api/src/server.ts"]
