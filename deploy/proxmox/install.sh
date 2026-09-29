#!/usr/bin/env bash
# Installa (o aggiorna) Julianify come servizio systemd su Debian/Ubuntu:
# un container LXC di Proxmox, una VM o qualsiasi server.
#
# Uso, come root, da una copia del repository:
#   ./deploy/proxmox/install.sh
# Variabili facoltative:
#   ADMIN_USER / ADMIN_PASSWORD  crea l'amministratore (solo se non esiste ancora)
#   MUSIC_DIR                    libreria musicale (default: /mnt/music se esiste)
#   PORT                         porta HTTP (default 8080)
#   NODE_MAJOR                   versione di Node.js da installare (default 24)
#
# Rilanciarlo da una versione più recente del codice aggiorna l'app senza toccare i dati.
set -euo pipefail

APP_DIR=/opt/julianify
DATA_DIR=/var/lib/julianify
CONF_DIR=/etc/julianify
ENV_FILE=$CONF_DIR/julianify.env
SERVICE_FILE=/etc/systemd/system/julianify.service
NODE_MAJOR=${NODE_MAJOR:-24}
PORT=${PORT:-8080}
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

log() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Esegui lo script come root." >&2
  exit 1
fi
if [ ! -f "$SRC_DIR/package.json" ] || ! grep -q '"name": "julianify"' "$SRC_DIR/package.json"; then
  echo "Non trovo il codice di Julianify in $SRC_DIR" >&2
  exit 1
fi

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}

log "Pacchetti di sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils tar >/dev/null

if ! node_ok; then
  log "Installo Node.js ${NODE_MAJOR} (binari ufficiali da nodejs.org)"
  case "$(dpkg --print-architecture)" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *) echo "Architettura non supportata: $(dpkg --print-architecture)" >&2; exit 1 ;;
  esac
  BASE_URL="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  SUMS=$(curl -fsSL "$BASE_URL/SHASUMS256.txt")
  TARBALL=$(printf '%s\n' "$SUMS" | awk -v suffix="-linux-${NODE_ARCH}.tar.xz" 'index($2, suffix) && $2 ~ /^node-v/ {print $2; exit}')
  if [ -z "$TARBALL" ]; then
    echo "Impossibile trovare il pacchetto di Node.js ${NODE_MAJOR}" >&2
    exit 1
  fi
  TMP=$(mktemp -d)
  curl -fsSLo "$TMP/$TARBALL" "$BASE_URL/$TARBALL"
  (cd "$TMP" && printf '%s\n' "$SUMS" | grep " $TARBALL\$" | sha256sum -c - >/dev/null)
  tar -xJf "$TMP/$TARBALL" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
  rm -rf "$TMP"
fi
log "Node.js $(node --version)"

if ! id julianify >/dev/null 2>&1; then
  log "Creo l'utente di sistema julianify"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin julianify
fi
mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR"
chown julianify:julianify "$DATA_DIR"
chmod 750 "$DATA_DIR"

log "Copio l'applicazione in $APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  tar -C "$SRC_DIR" --exclude=./node_modules --exclude=./dist --exclude=./data --exclude=./.git \
    --exclude=./web/public/font --exclude=./web/public/soundfont -cf - . | tar -C "$APP_DIR" -xf -
fi

log "Compilo (npm ci + build)"
cd "$APP_DIR"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
npm prune --omit=dev --no-audit --no-fund --loglevel=error

if [ ! -f "$ENV_FILE" ]; then
  log "Creo la configurazione $ENV_FILE"
  MUSIC_DIR=${MUSIC_DIR:-}
  if [ -z "$MUSIC_DIR" ] && [ -d /mnt/music ]; then MUSIC_DIR=/mnt/music; fi
  cat >"$ENV_FILE" <<CONF
# Configurazione di Julianify (dopo una modifica: systemctl restart julianify)
JULIANIFY_HOST=0.0.0.0
JULIANIFY_PORT=$PORT
JULIANIFY_DATA_DIR=$DATA_DIR
# Libreria musicale in sola lettura da cui scegliere le tracce audio (vuoto = disattivata)
JULIANIFY_MUSIC_DIR=$MUSIC_DIR
# Dimensione massima dei file caricati (MB)
JULIANIFY_MAX_UPLOAD_MB=300
# Durata delle sessioni (giorni)
JULIANIFY_SESSION_DAYS=30
# Dietro un reverse proxy HTTPS (Nginx Proxy Manager, Caddy, Traefik...):
JULIANIFY_TRUST_PROXY=false
JULIANIFY_COOKIE_SECURE=false
JULIANIFY_LOG_LEVEL=info
CONF
  chmod 640 "$ENV_FILE"
  chown root:julianify "$ENV_FILE"
fi

log "Installo il comando julianify-user"
cat >/usr/local/bin/julianify-user <<'WRAP'
#!/bin/sh
# Gestione utenti di Julianify: julianify-user list | add <nome> [--admin] | passwd <nome> | ...
set -a
. /etc/julianify/julianify.env
set +a
exec runuser -u julianify -- /usr/local/bin/node --disable-warning=ExperimentalWarning /opt/julianify/dist/server/src/cli.js "$@"
WRAP
chmod 755 /usr/local/bin/julianify-user
# node può trovarsi altrove se era già installato
sed -i "s#/usr/local/bin/node#$(command -v node)#" /usr/local/bin/julianify-user

log "Installo il servizio systemd"
cat >"$SERVICE_FILE" <<UNIT
[Unit]
Description=Julianify - spartiti sincronizzati con la traccia audio
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=julianify
Group=julianify
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning $APP_DIR/dist/server/src/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

if [ -n "${ADMIN_USER:-}" ]; then
  if julianify-user list 2>/dev/null | grep -q "^${ADMIN_USER}\b"; then
    log "L'utente ${ADMIN_USER} esiste già"
  elif [ -n "${ADMIN_PASSWORD:-}" ]; then
    log "Creo l'amministratore ${ADMIN_USER}"
    JULIANIFY_PASSWORD="$ADMIN_PASSWORD" julianify-user add "$ADMIN_USER" --admin
  elif [ -t 0 ]; then
    log "Creo l'amministratore ${ADMIN_USER} (scegli la password)"
    julianify-user add "$ADMIN_USER" --admin
  fi
fi

systemctl enable --now julianify >/dev/null 2>&1 || true
systemctl restart julianify
sleep 2
if systemctl is-active --quiet julianify; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  log "Julianify è attivo: http://${IP:-localhost}:$PORT"
  if ! julianify-user list 2>/dev/null | grep -q .; then
    echo "Nessun utente ancora: crea il tuo account con   julianify-user add <nome> --admin"
  fi
else
  echo "Il servizio non è partito: controlla con   journalctl -u julianify -e" >&2
  exit 1
fi
