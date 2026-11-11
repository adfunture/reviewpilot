# ReviewPilot – ein Image für Web (API + Dashboard) und Worker
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Dashboard (statischer Export)
COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN npm ci --prefix apps/web --no-audit --no-fund
COPY apps/web apps/web
# API
COPY apps/api/package.json apps/api/package-lock.json apps/api/
RUN npm ci --prefix apps/api --no-audit --no-fund
COPY apps/api apps/api
RUN npm run build --prefix apps/web && npm run build --prefix apps/api && npm prune --omit=dev --prefix apps/api

FROM node:22-bookworm-slim
WORKDIR /app/apps/api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 1001 app
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1
COPY --from=build --chown=app /app/apps/api/package.json ./
COPY --from=build --chown=app /app/apps/api/node_modules ./node_modules
COPY --from=build --chown=app /app/apps/api/dist ./dist
COPY --from=build --chown=app /app/apps/api/public ./public
COPY --from=build --chown=app /app/apps/api/prisma ./prisma
USER app
EXPOSE 8080
# Web: node dist/server.js · Worker: node dist/worker.js (Startbefehl pro Railway-Service)
CMD ["node", "dist/server.js"]
