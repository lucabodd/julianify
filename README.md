# Julianify

Lettore di spartiti e tablature per musicisti, da ospitare in casa (LAN), che
**sincronizza lo spartito con la registrazione originale**: apri una tab Guitar Pro
o un MusicXML di MuseScore, scegli la traccia audio dell'artista e segui il cursore
sulle note mentre ascolti. Lo spartito non suona: a suonare è la registrazione.

Pensato per studiare: **loop A‑B**, **rallentamento senza cambiare intonazione**,
**allenatore di velocità** e un **livello di analisi armonica avanzata** (gradi
funzionali in stile jazz, ii‑V, sostituti di tritono, interscambio modale, scale
consigliate, funzione di ogni nota della melodia sull'accordo).

## Funzionalità

- **Formati**: Guitar Pro 3/4/5 (`.gp3` `.gp4` `.gp5`), Guitar Pro 6 (`.gpx`),
  Guitar Pro 7/8 (`.gp`), MusicXML (`.musicxml` `.xml` `.mxl`, es. esportati da
  MuseScore), Capella (`.capx`). Rendering con [alphaTab](https://alphatab.net):
  pentagramma e/o tablatura, più tracce insieme, zoom, impaginazione a pagina o su
  una riga.
- **Tracce audio**: caricate dal browser (mp3, m4a/aac, ogg/opus, flac, wav, webm)
  oppure **scelte dalla libreria musicale di casa** (es. `/mnt/data/music`) senza
  copiarle. Ogni spartito può avere più registrazioni (studio, live…), ciascuna con i
  suoi sync point.
- **Sync point** (battuta ↔ istante della registrazione, anche al secondo giro di un
  ritornello):
  - *tap* durante l'ascolto (ogni battuta, ogni 2/4 battute o ogni movimento per i
    brani rubato), anche con l'audio rallentato per essere più precisi;
  - assegnazione manuale del punto selezionato all'istante corrente;
  - forma d'onda con i marcatori trascinabili e la griglia delle battute;
  - tabella con il tempo reale della registrazione tra un punto e l'altro (utile per
    scovare un tap sbagliato), spostamenti fini ±10 ms, annulla;
  - compensazione della latenza audio (cuffie Bluetooth);
  - con i file **Guitar Pro 8** che contengono già la traccia audio sincronizzata
    (funzione *Audio Track* di GP8) un clic importa audio e sync point.
- **Studio**: loop A‑B trascinando sullo spartito o con i tasti `[` `]`, loop
  salvati (con la velocità), pausa tra le ripetizioni, velocità dal 25% al 150% con
  tono invariato, allenatore di velocità (+X% ogni N giri fino all'obiettivo).
- **Analisi armonica** (note personali, per utente):
  - sigle, sezioni, cambi di tonalità/modo e appunti liberi posizionati sul beat;
  - gradi romani calcolati in base al contesto: dominanti secondarie (`V7/ii`),
    sostituti di tritono (`SubV7`), ii correlati (`ii7/♭VI`), dominante backdoor
    (`♭VII7`), diminuiti di passaggio (`vii°7/ii`, `ct°7`), interscambio modale
    (`iv7`, `♭VImaj7` con il modo di provenienza), rivolti (`V65`, `I64`) e accordi
    ibridi (`IV/V`); convenzione Berklee (gradi rispetto alla scala maggiore);
  - colori per categoria, parentesi sotto le coppie ii‑V (tratteggiate per ii‑SubV)
    e frecce di risoluzione;
  - scala consigliata per ogni accordo (dorica, misolidia, alterata, lidia
    dominante, locria ♮2, diminuita…) e funzione (T/SD/D);
  - vocabolario esteso: `13`, `7alt`, `maj7♯11`, `9sus4`, `m(maj7)`, `6/9`,
    slash chord…;
  - intervallo di ogni nota della melodia rispetto all'accordo attivo (`9`, `♯11`,
    `♭13`… con colori per note dell'accordo, tensioni, note da evitare, cromatismi);
  - suggerimenti della sigla dalle note effettivamente suonate (tutte le tracce,
    basso compreso) e descrizione del voicing (`E (3) · B♭ (♭7) · D (9)…`);
  - import delle sigle già presenti nel file, riconoscimento automatico degli
    accordi, stima della tonalità (tutto il brano o il loop).
- **Utenti**: accesso con utente e password; l'amministratore abilita/disabilita gli
  account. Gli spartiti sono privati o condivisi; note e loop restano personali.

## Installazione su Proxmox

Servono circa 1 GB di RAM e qualche GB di disco (per gli spartiti e gli audio
caricati). Node.js ≥ 22.13 (lo script installa la 24 LTS).

### Opzione A — container LXC creato in automatico (consigliata)

Sull'**host Proxmox**, come root, da una copia di questo repository:

```bash
git clone https://github.com/lucabodd/julianify.git && cd julianify
CTID=120 MUSIC_DIR=/mnt/data/music ADMIN_USER=luca ./deploy/proxmox/create-lxc.sh
```

Lo script crea un container Debian non privilegiato (`nesting=1`, avvio automatico),
monta la libreria musicale dell'host in `/mnt/music` **in sola lettura**, installa
Node.js e l'app come servizio systemd e ti chiede la password dell'amministratore.
Alla fine stampa l'indirizzo, es. `http://192.168.1.50:8080`.

Variabili utili: `IP=192.168.1.50/24 GW=192.168.1.1` (IP statico, predefinito
DHCP), `BRIDGE`, `STORAGE`, `DISK_GB`, `MEMORY`, `CORES`, `CT_HOSTNAME`.

> In un container non privilegiato i file dell'host sono visti come utente
> `nobody`: la libreria musicale deve essere leggibile da tutti (permessi 644 per i
> file, 755 per le cartelle). Se non lo è, l'app parte comunque e lo segnala nel
> log (`journalctl -u julianify`).

### Opzione B — in un container o VM già esistente (Debian/Ubuntu)

```bash
git clone https://github.com/lucabodd/julianify.git && cd julianify
sudo ADMIN_USER=luca ./deploy/proxmox/install.sh
```

Per usare la libreria musicale, rendila visibile nel container (es. sull'host
`pct set <CTID> -mp0 /mnt/data/music,mp=/mnt/music,ro=1`) e imposta
`JULIANIFY_MUSIC_DIR=/mnt/music` in `/etc/julianify/julianify.env`.

### Opzione C — Docker

In una VM o in un LXC con Docker:

```bash
echo "JULIANIFY_ADMIN_PASSWORD=una-password-robusta" > .env
docker compose up -d --build
```

`docker-compose.yml` monta `./data` per i dati e `/mnt/data/music` in sola lettura:
modifica i percorsi se servono. Gestione utenti:
`docker compose exec -u node julianify node dist/server/src/cli.js list`.

### Aggiornare

Scarica la nuova versione (`git pull`) e rilancia lo stesso `install.sh` (oppure,
dall'host, copia il codice nel container e rilancialo): ricompila e riavvia senza
toccare i dati. Con Docker: `docker compose up -d --build`.

## Configurazione

Nel servizio systemd le variabili stanno in `/etc/julianify/julianify.env` (dopo le
modifiche: `systemctl restart julianify`).

| Variabile | Predefinito | Descrizione |
| --- | --- | --- |
| `JULIANIFY_PORT` / `JULIANIFY_HOST` | `8080` / `0.0.0.0` | indirizzo di ascolto |
| `JULIANIFY_DATA_DIR` | `./data` | database SQLite e file caricati |
| `JULIANIFY_MUSIC_DIR` | *(vuoto)* | libreria musicale in sola lettura |
| `JULIANIFY_MAX_UPLOAD_MB` | `300` | dimensione massima di un file caricato |
| `JULIANIFY_SESSION_DAYS` | `30` | durata dell'accesso |
| `JULIANIFY_TRUST_PROXY` | `false` | `true` dietro un reverse proxy |
| `JULIANIFY_COOKIE_SECURE` | `false` | `true` se servito in HTTPS |
| `JULIANIFY_ADMIN_USER` / `_PASSWORD` | – | al primo avvio crea l'amministratore se non ci sono utenti |
| `JULIANIFY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

**HTTPS / reverse proxy** (Nginx Proxy Manager, Caddy, Traefik…): inoltra verso
`http://<ip>:8080`, imposta `JULIANIFY_TRUST_PROXY=true` e
`JULIANIFY_COOKIE_SECURE=true`, e alza il limite di upload del proxy (in Nginx
`client_max_body_size 300m;`).

## Utenti

- Dalla pagina **Utenti** (solo amministratori): crea, abilita/disabilita,
  promuovi ad amministratore, reimposta la password, elimina.
- Da terminale nel container: `julianify-user list`,
  `julianify-user add mario`, `julianify-user passwd luca`,
  `julianify-user disable mario`, `julianify-user promote mario`,
  `julianify-user delete mario`.

## Come si usa

1. **Libreria** → *Carica spartito* (o trascina i file nella pagina). Titolo e artista
   vengono letti dal file.
2. Nel player, **Aggiungi traccia audio**: carica un file oppure scegli dalla
   libreria musicale (la ricerca parte dal titolo del brano).
3. Pannello **Sync**:
   - *Avvia tap*, fai partire l'audio e premi `T` su ogni attacco di battuta. Per un
     brano a tempo costante bastano due punti (inizio e fine); per un'esecuzione
     rubato (tipica in chitarra sola) usa un tap per battuta o per movimento.
   - In modalità sync un clic sullo spartito seleziona il punto senza spostare
     l'audio: porta l'audio sull'attacco (forma d'onda) e premi `S`.
   - Trascina i marcatori verdi sulla forma d'onda per le correzioni fini.
4. **Loop**: trascina sullo spartito da una nota all'altra, rallenta con `−`, salva
   il loop e, se vuoi, attiva l'allenatore di velocità.
5. **Analisi**: *Importa le sigle dal file* oppure *Rileva* gli accordi dalle note,
   poi correggi; imposta la tonalità (o il modo) dove cambia. Clicca un punto dello
   spartito e premi `A` per una sigla (con i suggerimenti dalle note e il voicing) o
   `N` per un appunto. Attiva *Intervalli della melodia* per vedere su quali
   tensioni lavora una linea.

### Scorciatoie da tastiera

| Tasto | Azione |
| --- | --- |
| `Spazio` | play / pausa |
| `Esc` | torna all'inizio (del loop) |
| `←` `→` | battuta precedente / successiva |
| `[` `]` | inizio (A) e fine (B) del loop sul movimento corrente |
| `L` / `X` | attiva-disattiva / cancella il loop |
| `−` `+` `0` | velocità −5%, +5%, 100% |
| `T` / `Z` / `S` | tap / annulla / assegna (pannello Sync) |
| `A` / `N` | nuova sigla / nuovo appunto sul punto selezionato |
| `W` | mostra la forma d'onda |

### File di esempio

In `samples/` ci sono una progressione jazz in Guitar Pro 3 (ii‑V‑I, dominante
secondaria, SubV, backdoor, con ritornello) e un lead sheet MusicXML, utili per
provare subito l'analisi. `scripts/make-demo.py` genera anche un audio di prova
sintetico (volutamente più veloce e con un'introduzione, per esercitarsi con il
tap): `pip install pyguitarpro && python3 scripts/make-demo.py /tmp/demo`.

## Backup

Tutto ciò che conta sta nella cartella dati (`/var/lib/julianify`, o `./data` con
Docker): il database `julianify.db` e le cartelle `scores/`, `audio/`, `peaks/`. Il
backup del container con Proxmox (vzdump) la include; per una copia a caldo del
database: `sqlite3 julianify.db ".backup copia.db"`. I file della libreria musicale
non vengono mai modificati.

## Sviluppo

```bash
npm install
JULIANIFY_ADMIN_USER=luca JULIANIFY_ADMIN_PASSWORD=password123 npm run dev
# frontend su http://localhost:5173 (inoltra /api al server su :8080)
npm test          # test del server e dell'analisi armonica
npm run typecheck
npm run build && npm start
```

Struttura: `server/` (Fastify + SQLite nativo di Node), `web/` (React + Vite +
alphaTab + wavesurfer.js), `shared/` (tipi comuni), `deploy/` (Proxmox, Docker).

Note tecniche:

- alphaTab lavora in modalità *media esterno*: legge la posizione dall'elemento
  `<audio>` e usa i sync point (mappatura lineare a tratti, come Guitar Pro 8) per
  sapere quale beat corrisponde a ogni istante;
- il rallentamento usa il time-stretch nativo del browser (`preservesPitch`);
- la forma d'onda viene calcolata una volta dal browser e salvata sul server.

## Licenze di terze parti

[alphaTab](https://github.com/CoderLine/alphaTab) (MPL‑2.0), font Bravura (SIL OFL
1.1), [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) (BSD‑3‑Clause),
React (MIT), Fastify (MIT).
