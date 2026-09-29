# syntax=docker/dockerfile:1
#
# Immagini:
#   docker build .                 completa, con il worker Python (separazione degli
#                                  strumenti e sincronizzazione automatica), ~2,5 GB
#   docker build --target slim .   solo l'app, senza worker

# --- build del frontend e del server -----------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# --- immagine senza worker ----------------------------------------------------
FROM node:24-bookworm-slim AS slim
ENV NODE_ENV=production \
    JULIANIFY_DATA_DIR=/data \
    JULIANIFY_PORT=8080 \
    JULIANIFY_HOST=0.0.0.0 \
    JULIANIFY_WORKER_DIR=/app/worker
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

# --- ambiente Python del worker e modello Demucs -------------------------------
# Stessa base dell'immagine finale, così il venv punta allo stesso interprete.
FROM node:24-bookworm-slim AS worker
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/worker
COPY worker/requirements.txt ./
RUN python3 -m venv .venv \
  && .venv/bin/pip install --no-cache-dir --upgrade pip \
  && .venv/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
  && .venv/bin/pip install --no-cache-dir -r requirements.txt
COPY worker/julianify_worker ./julianify_worker
ENV HF_HOME=/opt/julianify-models/huggingface \
    NUMBA_CACHE_DIR=/tmp/numba \
    MPLCONFIGDIR=/tmp/matplotlib
RUN .venv/bin/python -m julianify_worker download-models </dev/null >/dev/null

# --- immagine completa (predefinita) -------------------------------------------
FROM slim AS full
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=worker /app/worker /app/worker
COPY --from=worker /opt/julianify-models /opt/julianify-models
ENV HF_HOME=/opt/julianify-models/huggingface
