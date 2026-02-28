# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

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
RUN pnpm deploy --prod /prod

# Copy built files to production directory
RUN cp -r /app/dist /prod/dist

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

# Copy production directory from builder
COPY --from=builder /prod .

# Force IPv4 first to avoid IPv6 connection issues with Neon
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

CMD ["node", "dist/index.js"]
