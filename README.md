# Julianify

Lettore di spartiti e tablature per musicisti, da ospitare in casa (LAN), che
**sincronizza lo spartito con la registrazione originale**: apri una tab Guitar Pro
o un MusicXML di MuseScore, scegli la traccia audio dell'artista e segui il cursore
sulle note mentre ascolti. Lo spartito non suona: a suonare è la registrazione.

Pensato per studiare: **loop A‑B**, **rallentamento senza cambiare intonazione**,
**allenatore di velocità** e un **livello di analisi armonica avanzata** (gradi
funzionali in stile jazz, ii‑V, sostituti di tritono, interscambio modale, scale
consigliate, funzione di ogni nota della melodia sull'accordo).

Con il worker Python (installato di default) lo spartito si **sincronizza da solo**
con la registrazione, e la registrazione si può **separare negli strumenti**: una
base **senza chitarra** su cui suonare, la **chitarra isolata** per trascrivere, il
basso da solo per l'analisi.

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
- **Sincronizzazione automatica**: confronta le note dello spartito con la
  registrazione (feature chroma e attacchi, DTW multi‑scala con
  [Sync Toolbox](https://github.com/meinardmueller/synctoolbox)) e mette un sync
  point per battuta o per movimento, poi aggancia ogni punto all'attacco reale della
  nota. Regge rubato, ritornelli, registrazioni accordate un po' calanti o crescenti,
  capotasto/trasposizioni e rumore prima della musica; segnala i punti da
  ricontrollare. Si può limitare a un tratto e usare come riferimento i sync point già
  inseriti (utile se lo spartito copre solo una parte del brano). Sui test con
  esecuzioni rubato l'errore tipico è di pochi millisecondi (un tap umano sbaglia di
  30‑50 ms); un brano di 5 minuti richiede 20‑40 secondi.
- **Separazione degli strumenti** con [Demucs](https://github.com/adefossez/demucs)
  (modello a 6 sorgenti: batteria, basso, chitarra, piano, voce, altro): crea le
  versioni *senza chitarra* (per suonare al posto del chitarrista), *solo chitarra*,
  *solo basso*, *basso e batteria*, *senza basso/batteria/piano/voce*. Le versioni
  condividono i sync point dell'originale e nel player si passa dall'una all'altra
  (pulsanti nella barra o tasto `V`) **senza perdere il punto** e senza fermare la
  riproduzione, anche dentro un loop rallentato.
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

Senza worker bastano 1 GB di RAM e qualche GB di disco. Con il worker Python
(default) servono **4 GB di RAM** (Demucs ne usa circa 2 durante la separazione),
**16 GB di disco** (PyTorch CPU e dipendenze circa 2,5 GB, più le versioni separate
in FLAC, circa 30‑40 MB per versione di un brano di 5 minuti) e più core possibile:
con 4 core la separazione impiega circa metà della durata del brano. Node.js ≥ 22.13
(lo script installa la 24 LTS), Python ≥ 3.10 (Debian 12 o successivo) e ffmpeg.

### Opzione A — container LXC creato in automatico (consigliata)

Sull'**host Proxmox**, come root, da una copia di questo repository:

```bash
git clone https://github.com/lucabodd/julianify.git && cd julianify
CTID=120 MUSIC_DIR=/mnt/data/music ADMIN_USER=luca ./deploy/proxmox/create-lxc.sh
```

Lo script crea un container Debian non privilegiato (`nesting=1`, avvio automatico,
4 core, 4 GB di RAM, 16 GB di disco), monta la libreria musicale dell'host in
`/mnt/music` **in sola lettura**, installa Node.js, l'app come servizio systemd e il
worker Python (PyTorch CPU, Demucs, Sync Toolbox, ffmpeg e il modello, circa 80 MB),
e ti chiede la password dell'amministratore. Alla fine stampa l'indirizzo, es.
`http://192.168.1.50:8080`.

Variabili utili: `IP=192.168.1.50/24 GW=192.168.1.1` (IP statico, predefinito
DHCP), `BRIDGE`, `STORAGE`, `DISK_GB`, `MEMORY`, `CORES`, `CT_HOSTNAME`,
`WITH_WORKER=0` (senza separazione e sincronizzazione automatica: 2 core, 1 GB,
8 GB).

> In un container non privilegiato i file dell'host sono visti come utente
> `nobody`: la libreria musicale deve essere leggibile da tutti (permessi 644 per i
> file, 755 per le cartelle). Se non lo è, l'app parte comunque e lo segnala nel
> log (`journalctl -u julianify`).

### Opzione B — in un container o VM già esistente (Debian/Ubuntu)

```bash
git clone https://github.com/lucabodd/julianify.git && cd julianify
sudo ADMIN_USER=luca ./deploy/proxmox/install.sh
```

Il worker Python viene installato in `/opt/julianify/worker/.venv` (con
`WITH_WORKER=0` lo salta); il modello Demucs va in `/var/lib/julianify/models`. Se il
container ha meno di 4 GB di RAM lo script lo segnala: sull'host
`pct set <CTID> --memory 4096`.

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
modifica i percorsi se servono. L'immagine predefinita include il worker Python e il
modello (circa 2,5 GB); per quella leggera senza worker aggiungi `target: slim` sotto
`build:`. Gestione utenti:
`docker compose exec -u node julianify node dist/server/src/cli.js list`.

### Aggiornare

Scarica la nuova versione (`git pull`) e rilancia lo stesso `install.sh` (oppure,
dall'host, copia il codice nel container e rilancialo): ricompila e riavvia senza
toccare i dati; l'ambiente Python del worker viene aggiornato, non reinstallato da
zero. Per aggiungere il worker a un'installazione fatta senza: rilancia
`install.sh` (il default è `WITH_WORKER=1`). Con Docker: `docker compose up -d --build`.

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
| `JULIANIFY_WORKER` | `true` | `false` disattiva il worker Python anche se installato |
| `JULIANIFY_WORKER_PYTHON` | `worker/.venv/bin/python` | interprete del worker (rilevato da solo) |
| `JULIANIFY_WORKER_THREADS` | tutte le CPU | thread usati da separazione e allineamento |
| `JULIANIFY_WORKER_TIMEOUT_MIN` | `120` | durata massima di un lavoro |

Lo stato del worker (attivo, thread, eventuali problemi) si vede nella pagina
**Utenti**. I lavori pesanti vengono eseguiti uno alla volta, in coda; si possono
annullare e, se la pagina viene chiusa, continuano sul server.

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
   - *Sincronizza automaticamente*: dopo qualche decina di secondi compare il
     riepilogo (punti calcolati, eventuali punti da controllare, accordatura e
     trasposizione della registrazione); *Applica* sostituisce i sync point e si può
     annullare con `Z`. I punti dubbi sono segnati con `?` nella tabella. Se la
     registrazione ha un'introduzione che lo spartito non contiene, o lo spartito
     copre solo una parte del brano, metti prima un sync point sulla prima (e
     sull'ultima) battuta trascritta e spunta *Rispetta i sync point già inseriti*.
     Se lo spartito contiene solo la chitarra e hai creato la versione *Solo
     chitarra*, puoi analizzare quella.
   - *Avvia tap*, fai partire l'audio e premi `T` su ogni attacco di battuta. Per un
     brano a tempo costante bastano due punti (inizio e fine); per un'esecuzione
     rubato (tipica in chitarra sola) usa un tap per battuta o per movimento.
   - In modalità sync un clic sullo spartito seleziona il punto senza spostare
     l'audio: porta l'audio sull'attacco (forma d'onda) e premi `S`.
   - Trascina i marcatori verdi sulla forma d'onda per le correzioni fini.
4. **Tracce audio** (icona a ingranaggio accanto alla traccia) → icona *Separa gli
   strumenti* sulla registrazione: scegli le versioni (di default *Senza chitarra* e
   *Solo chitarra*) e avvia; l'avanzamento si vede nella finestra e in alto nel
   player. Quando sono pronte compaiono nella barra di trasporto: `V` passa
   dall'una all'altra mentre suona.
5. **Loop**: trascina sullo spartito da una nota all'altra, rallenta con `−`, salva
   il loop e, se vuoi, attiva l'allenatore di velocità.
6. **Analisi**: *Importa le sigle dal file* oppure *Rileva* gli accordi dalle note,
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
| `V` | versione successiva della registrazione (originale, senza chitarra…) |

### File di esempio

In `samples/` ci sono una progressione jazz in Guitar Pro 3 (ii‑V‑I, dominante
secondaria, SubV, backdoor, con ritornello) e un lead sheet MusicXML, utili per
provare subito l'analisi. `scripts/make-demo.py` genera anche un audio di prova
sintetico (volutamente più veloce e con un'introduzione, per esercitarsi con il
tap): `pip install pyguitarpro && python3 scripts/make-demo.py /tmp/demo`.

## Backup

Tutto ciò che conta sta nella cartella dati (`/var/lib/julianify`, o `./data` con
Docker): il database `julianify.db` e le cartelle `scores/`, `audio/` (comprese le
versioni separate), `peaks/`; `models/` e `cache/` si possono escludere, vengono
riscaricate o ricreate. Il
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

Worker Python (facoltativo in sviluppo; il server lo trova in `worker/.venv`):

```bash
python3 -m venv worker/.venv
worker/.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
worker/.venv/bin/pip install -r worker/requirements.txt
cd worker && .venv/bin/python -m unittest discover -s tests
```

Struttura: `server/` (Fastify + SQLite nativo di Node), `web/` (React + Vite +
alphaTab + wavesurfer.js), `shared/` (tipi comuni), `worker/` (Python: Demucs, Sync
Toolbox), `deploy/` (Proxmox, Docker).

Note tecniche:

- alphaTab lavora in modalità *media esterno*: legge la posizione dall'elemento
  `<audio>` e usa i sync point (mappatura lineare a tratti, come Guitar Pro 8) per
  sapere quale beat corrisponde a ogni istante;
- il rallentamento usa il time-stretch nativo del browser (`preservesPitch`);
- la forma d'onda viene calcolata una volta dal browser e salvata sul server;
- il worker Python è un processo figlio avviato per ogni lavoro
  (`python -m julianify_worker <comando>`, parametri JSON su stdin, avanzamento e
  risultato come righe JSON su stdout); la coda e lo stato dei lavori stanno nella
  tabella `jobs`;
- l'allineamento: le note dello spartito (tutte le tracce non percussive, al tempo
  scritto e con i ritornelli srotolati) diventano feature chroma e DLNCO come quelle
  della registrazione; MrMsDTW le allinea, i punti vengono proiettati sul percorso e
  poi agganciati all'inizio dell'attacco più vicino (flusso spettrale), leggermente
  in anticipo così un loop che parte lì non taglia la nota;
- la separazione elabora il brano a blocchi di un minuto con dissolvenza incrociata
  (memoria limitata anche per brani lunghi) e scrive le versioni in FLAC con la
  stessa durata, campione per campione, dell'originale.

## Licenze di terze parti

[alphaTab](https://github.com/CoderLine/alphaTab) (MPL‑2.0), font Bravura (SIL OFL
1.1), [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) (BSD‑3‑Clause),
React (MIT), Fastify (MIT). Worker: [Demucs](https://github.com/adefossez/demucs)
e i suoi modelli (MIT), [Sync Toolbox](https://github.com/meinardmueller/synctoolbox)
(MIT; Müller, Özer, Krause, Prätzlich, Driedger, *JOSS* 2021),
[PyTorch](https://pytorch.org) (BSD), [librosa](https://librosa.org) (ISC),
[FFmpeg](https://ffmpeg.org) (LGPL/GPL).
