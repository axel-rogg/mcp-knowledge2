# syntax=docker/dockerfile:1.7
# Multi-stage build for mcp-knowledge2

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG BUILD_SHA=dev
ENV BUILD_SHA=${BUILD_SHA}

# postgresql-client provides `pg_dump` for the daily encrypted-backup cron
# (src/crons/backup.ts spawns it). Without this the cron silently fails.
RUN apk add --no-cache postgresql17-client

RUN addgroup -S app && adduser -S app -G app
COPY --from=deps  --chown=app:app /app/node_modules                 ./node_modules
COPY --from=build --chown=app:app /app/dist                          ./dist
# Migrations + migrate.ts run via `npm run db:migrate` (Fly release_command
# or Cloud Run Job). Both files are read at runtime, so they must be in the
# runtime image, not just the build stage.
COPY --from=build --chown=app:app /app/scripts                       ./scripts
COPY --from=build --chown=app:app /app/drizzle/migrations            ./drizzle/migrations
COPY --chown=app:app package.json ./
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q --spider http://localhost:8080/health || exit 1
CMD ["node", "--enable-source-maps", "dist/server.js"]
