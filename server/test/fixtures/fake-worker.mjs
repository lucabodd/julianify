#!/usr/bin/env node
// Finto worker Python per i test: stesso protocollo di `python -m julianify_worker <comando>`
// (parametri JSON su stdin, un messaggio JSON per riga su stdout).
import fs from 'node:fs';

const command = process.argv[4];
const raw = fs.readFileSync(0, 'utf8');
const params = raw.trim() ? JSON.parse(raw) : {};
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (command === 'info') {
  send({
    type: 'result',
    result: { worker: 'test', threads: 2, device: 'cpu', features: { stems: { ok: true }, autosync: { ok: true } }, models: { htdemucs_6s: true } },
  });
} else if (command === 'stems') {
  // la versione "senza voce" simula un lavoro lungo, da annullare
  if (params.outputs.some((o) => o.path.endsWith('no_vocals.flac'))) {
    for (let i = 0; i < 600; i++) {
      send({ type: 'progress', progress: i / 600, message: 'Separazione degli strumenti…' });
      await sleep(100);
    }
  }
  for (const [i, output] of params.outputs.entries()) {
    send({ type: 'progress', progress: (i + 1) / params.outputs.length, message: 'Separazione degli strumenti…' });
    fs.writeFileSync(output.path, `fLaC finto: ${output.stems.join('+')}`);
  }
  send({ type: 'result', result: { durationMs: 12345.6, outputs: params.outputs.map((o) => ({ path: o.path, frames: 100 })) } });
} else if (command === 'autosync') {
  if (params.notes.some((n) => n[2] === 0)) {
    send({ type: 'error', error: 'Errore simulato' });
    process.exit(2);
  }
  send({
    type: 'result',
    result: {
      times: params.targets.map((t) => t * 1000 + 500),
      confidence: params.targets.map(() => 0.9),
      suspicious: [],
      refined: params.targets.length,
      tuningCents: 0,
      transposition: 0,
      anchorsUsed: params.anchors.length,
      audioStartMs: 500,
      audioEndMs: 9000,
      audioDurationMs: 10000,
    },
  });
} else {
  send({ type: 'error', error: `Comando sconosciuto: ${command}` });
  process.exit(2);
}
