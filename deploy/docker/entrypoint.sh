#!/bin/sh
# Avvio del container: sistema i permessi della cartella dati (spesso creata da Docker
# come root) e poi esegue l'app come utente non privilegiato "node".
set -e
DATA_DIR="${JULIANIFY_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %U "$DATA_DIR")" != "node" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
