FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/logs.db \
    LOG_LEVEL=info \
    BODY_LIMIT_BYTES=1048576

RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun

EXPOSE 3000

CMD ["bun", "run", "start"]
