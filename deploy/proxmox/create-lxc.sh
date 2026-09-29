#!/usr/bin/env bash
# Da eseguire sull'HOST Proxmox (come root), da una copia del repository:
#   ./deploy/proxmox/create-lxc.sh
#
# Crea un container LXC Debian non privilegiato, monta in sola lettura la libreria
# musicale dell'host e installa Julianify come servizio. Tutto è configurabile con
# variabili d'ambiente, per esempio:
#   CTID=120 IP=192.168.1.50/24 GW=192.168.1.1 MUSIC_DIR=/mnt/data/music \
#   ADMIN_USER=luca ./deploy/proxmox/create-lxc.sh
set -euo pipefail

CTID=${CTID:-$(pvesh get /cluster/nextid)}
CT_HOSTNAME=${CT_HOSTNAME:-julianify}
STORAGE=${STORAGE:-local-lvm}          # dove creare il disco del container
TEMPLATE_STORAGE=${TEMPLATE_STORAGE:-local}
BRIDGE=${BRIDGE:-vmbr0}
IP=${IP:-dhcp}                          # es. 192.168.1.50/24 (con GW) oppure dhcp
GW=${GW:-}
DISK_GB=${DISK_GB:-8}                   # spartiti e audio caricati stanno qui
MEMORY=${MEMORY:-1024}
CORES=${CORES:-2}
MUSIC_DIR=${MUSIC_DIR:-/mnt/data/music} # libreria musicale sull'host (facoltativa)
ADMIN_USER=${ADMIN_USER:-}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-}      # se vuota la password viene chiesta durante l'installazione
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

log() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }

command -v pct >/dev/null || { echo "Questo script va eseguito sull'host Proxmox VE." >&2; exit 1; }
if pct status "$CTID" >/dev/null 2>&1; then
  echo "Il container $CTID esiste già: scegli un altro CTID oppure usa install.sh dentro il container." >&2
  exit 1
fi

log "Cerco il template Debian"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep -E '^debian-1[2-9]-standard_.*_amd64' | sort -V | tail -1)
[ -n "$TEMPLATE" ] || { echo "Nessun template Debian disponibile" >&2; exit 1; }
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  log "Scarico $TEMPLATE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

NET="name=eth0,bridge=$BRIDGE,ip=$IP"
if [ "$IP" != "dhcp" ] && [ -n "$GW" ]; then NET="$NET,gw=$GW"; fi

log "Creo il container $CTID ($CT_HOSTNAME)"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" --memory "$MEMORY" --swap 512 \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "$NET" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 --ostype debian

if [ -n "$MUSIC_DIR" ] && [ -d "$MUSIC_DIR" ]; then
  log "Monto $MUSIC_DIR in /mnt/music (sola lettura)"
  pct set "$CTID" -mp0 "$MUSIC_DIR,mp=/mnt/music,ro=1"
else
  log "Libreria musicale non trovata ($MUSIC_DIR): la salto"
fi

pct start "$CTID"
log "Attendo la rete del container"
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1'; then break; fi
  sleep 2
done

log "Copio il codice nel container"
TMP=$(mktemp /tmp/julianify-src.XXXXXX.tar.gz)
tar -C "$REPO_DIR" --exclude=./node_modules --exclude=./dist --exclude=./data --exclude=./.git \
  --exclude=./web/public/font --exclude=./web/public/soundfont -czf "$TMP" .
pct push "$CTID" "$TMP" /root/julianify-src.tar.gz
rm -f "$TMP"
pct exec "$CTID" -- sh -c 'rm -rf /root/julianify-src && mkdir -p /root/julianify-src && tar -xzf /root/julianify-src.tar.gz -C /root/julianify-src && rm /root/julianify-src.tar.gz'

log "Installo Julianify nel container"
pct exec "$CTID" -- env ADMIN_USER="$ADMIN_USER" ADMIN_PASSWORD="$ADMIN_PASSWORD" bash /root/julianify-src/deploy/proxmox/install.sh

IP_CT=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
log "Fatto! Apri http://${IP_CT}:8080"
if [ -z "$ADMIN_USER" ]; then
  echo "Crea il tuo account con:   pct exec $CTID -- julianify-user add <nome> --admin"
fi
