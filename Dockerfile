# syntax=docker/dockerfile:1

# ---- deps: full install (dev deps included) for the Next.js build -------------------
FROM node:22-alpine AS deps
WORKDIR /app
# Build deps for better-sqlite3 native binding (Alpine musl)
RUN apk add --no-cache python3 make g++ libc-dev
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: next build -------------------------------------------------------------
FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && rm -rf .next/cache

# ---- prod-deps: runtime node_modules only --------------------------------------------
# `tsx` stays: server.ts and src/lib are TypeScript with "@/..." path aliases and are
# executed directly (package.json "start"). It is a regular dependency, not a dev one.
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc-dev
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime -------------------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
# su-exec: drop from root to `node` in the entrypoint after fixing /app/data ownership.
RUN apk add --no-cache su-exec
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
# Runtime sources: the custom server + the TS it imports (run through tsx), Next config,
# tsconfig (tsx reads the "@/" paths from it), the library import script and its seed TSVs.
COPY package.json package-lock.json tsconfig.json next.config.ts server.ts ./
COPY src ./src
COPY scripts ./scripts
COPY quizzes/library-seed ./quizzes/library-seed
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV ATENU_DB_PATH=/app/data/atenu.db
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
