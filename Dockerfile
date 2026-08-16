# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

# Pin pnpm to the version package.json declares. This used to be an unpinned
# `npm install -g pnpm`, which resolved to whatever was latest that day — so the
# image silently changed pnpm major versions between builds, and the `--legacy`
# flag below (added for a pnpm 10 that happened to be latest at the time) stopped
# existing the moment the resolution moved. The build failed on
# `Unknown option: 'legacy'`.
RUN npm install -g pnpm@9.15.0

# Copy workspace config and package files first for better caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY shared/content/package.json shared/content/

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Copy all source files
COPY . .

# Build shared packages
RUN pnpm --filter "./shared/*" build

# Build mcp-service
RUN pnpm build

# Prepare production directory with only production dependencies
RUN pnpm deploy --filter @distribute/mcp-service --prod /prod

# Copy built files to production directory
RUN cp -r /app/dist /prod/dist

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

# Copy production directory from builder
COPY --from=builder /prod .

# Force IPv4 first. This dates from Neon and outlives it: the gateway is now a
# neighbour on the compose network, and resolving it v6-first buys nothing.
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

CMD ["node", "dist/index.js"]
