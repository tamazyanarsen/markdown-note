# syntax=docker/dockerfile:1

# Две цели:
#   runner   — само приложение, тонкий образ на базе next standalone;
#   migrator — одноразовый контейнер, который прогоняет миграции и выходит.
#
# Миграции вынесены в отдельную цель намеренно: drizzle-kit — devDependency,
# и тащить его в рантайм-образ незачем.

ARG NODE_VERSION=24-alpine

# --- Зависимости -------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Сборка ------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- Миграции ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS migrator
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src/db/schema.ts ./src/db/schema.ts
CMD ["npx", "drizzle-kit", "migrate"]

# --- Рантайм -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Приложению не нужен root.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
