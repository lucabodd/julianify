# syntax=docker/dockerfile:1

# --- build del frontend e del server -----------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# --- immagine finale ----------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    JULIANIFY_DATA_DIR=/data \
    JULIANIFY_PORT=8080 \
    JULIANIFY_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY deploy/docker/entrypoint.sh /usr/local/bin/julianify-entrypoint
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.JULIANIFY_PORT || 8080) + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["julianify-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/src/index.js"]
