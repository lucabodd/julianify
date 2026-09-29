import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';

interface Part {
  name: string;
  value?: string;
  filename?: string;
  content?: Buffer;
  type?: string;
}

function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----julianify${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) header += `; filename="${part.filename}"\r\nContent-Type: ${part.type ?? 'application/octet-stream'}`;
    chunks.push(Buffer.from(`${header}\r\n\r\n`));
    chunks.push(part.content ?? Buffer.from(part.value ?? ''));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-julianify': '1' },
  };
}

describe('API Julianify', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let tmp: string;
  let musicDir: string;
  const cookies: Record<string, string> = {};

  async function login(username: string, password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-julianify': '1' },
      payload: { username, password },
    });
    assert.equal(res.statusCode, 200, res.body);
    const cookie = res.cookies.find((c) => c.name === 'julianify_session');
    assert.ok(cookie, 'cookie di sessione mancante');
    assert.equal(cookie.httpOnly, true);
    return `julianify_session=${cookie.value}`;
  }

  function as(user: string, extra: Record<string, string> = {}) {
    return { cookie: cookies[user], 'x-julianify': '1', ...extra };
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'julianify-test-'));
    musicDir = path.join(tmp, 'music');
    fs.mkdirSync(path.join(musicDir, 'Artista', 'Album'), { recursive: true });
    fs.writeFileSync(path.join(musicDir, 'Artista', 'Album', '01 - Canzone Già Nota.mp3'), Buffer.alloc(4096, 1));
    fs.writeFileSync(path.join(musicDir, 'Artista', 'Album', 'cover.jpg'), Buffer.alloc(10));
    fs.writeFileSync(path.join(tmp, 'segreto.mp3'), Buffer.alloc(10));
    const config = loadConfig({ dataDir: path.join(tmp, 'data'), musicDir, webDir: path.join(tmp, 'noweb') });
    ({ app, ctx } = await buildApp(config, { logger: false }));
    await createUser(ctx.db, { username: 'luca', password: 'password-luca', isAdmin: true });
    await createUser(ctx.db, { username: 'mario', password: 'password-mario' });
    cookies.luca = await login('luca', 'password-luca');
    cookies.mario = await login('mario', 'password-mario');
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rifiuta le richieste senza sessione', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scores' });
    assert.equal(res.statusCode, 401);
  });

  it('rifiuta credenziali errate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-julianify': '1' },
      payload: { username: 'luca', password: 'sbagliata' },
    });
    assert.equal(res.statusCode, 401);
  });

  it("richiede l'header anti-CSRF sulle modifiche", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scores/1/loops',
      headers: { cookie: cookies.luca },
      payload: {},
    });
    assert.equal(res.statusCode, 403);
  });

  it("restituisce l'utente corrente", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as('luca') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.username, 'luca');
    assert.equal(res.json().user.isAdmin, true);
  });

  let scoreId = 0;
  let audioId = 0;

  it('carica uno spartito e lo elenca', async () => {
    const form = multipart([
      { name: 'title', value: 'Canzone di prova' },
      { name: 'artist', value: 'Artista' },
      { name: 'file', filename: 'prova.gp3', content: Buffer.from('FICHIER GUITAR PRO v3.00 finto') },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/scores', headers: { ...form.headers, cookie: cookies.luca }, payload: form.payload });
    assert.equal(res.statusCode, 200, res.body);
    const score = res.json().score;
    assert.equal(score.title, 'Canzone di prova');
    assert.equal(score.format, 'gp3');
    assert.equal(score.isOwner, true);
    scoreId = score.id;

    const list = await app.inject({ method: 'GET', url: '/api/scores', headers: as('luca') });
    assert.equal(list.json().scores.length, 1);

    const file = await app.inject({ method: 'GET', url: `/api/scores/${scoreId}/file`, headers: as('luca') });
    assert.equal(file.statusCode, 200);
    assert.equal(file.body, 'FICHIER GUITAR PRO v3.00 finto');
  });

  it('rifiuta formati non supportati', async () => {
    const form = multipart([{ name: 'file', filename: 'virus.exe', content: Buffer.from('MZ') }]);
    const res = await app.inject({ method: 'POST', url: '/api/scores', headers: { ...form.headers, cookie: cookies.luca }, payload: form.payload });
    assert.equal(res.statusCode, 400);
    assert.equal(fs.readdirSync(ctx.storage.paths.tmpDir).length, 0);
  });

  it('nasconde gli spartiti privati agli altri utenti', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/scores/${scoreId}`, headers: as('mario') });
    assert.equal(res.statusCode, 404);
    const list = await app.inject({ method: 'GET', url: '/api/scores', headers: as('mario') });
    assert.equal(list.json().scores.length, 0);
  });

  it('carica una traccia audio e la serve con richieste Range', async () => {
    const audio = Buffer.alloc(10_000);
    for (let i = 0; i < audio.length; i++) audio[i] = i % 256;
    const form = multipart([{ name: 'file', filename: 'Originale.mp3', content: audio, type: 'audio/mpeg' }]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/scores/${scoreId}/audio`,
      headers: { ...form.headers, cookie: cookies.luca },
      payload: form.payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    audioId = res.json().audio.id;
    assert.equal(res.json().audio.name, 'Originale');

    const partial = await app.inject({
      method: 'GET',
      url: `/api/audio/${audioId}/stream`,
      headers: { ...as('luca'), range: 'bytes=100-199' },
    });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.rawPayload.length, 100);
    assert.equal(partial.rawPayload[0], 100);
    assert.match(String(partial.headers['content-range']), /bytes 100-199\/10000/);
  });

  it('salva e valida i sync point', async () => {
    const syncPoints = [
      { barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 1500 },
      { barIndex: 8, barOccurence: 1, barPosition: 0.5, millisecondOffset: 20500.25 },
    ];
    const res = await app.inject({ method: 'PATCH', url: `/api/audio/${audioId}`, headers: as('luca'), payload: { syncPoints } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().audio.syncPoints, syncPoints);

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/audio/${audioId}`,
      headers: as('luca'),
      payload: { syncPoints: [{ barIndex: -1, barOccurence: 0, barPosition: 0, millisecondOffset: 0 }] },
    });
    assert.equal(bad.statusCode, 400);
  });

  it('memorizza i picchi della forma d\'onda', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/api/audio/${audioId}/peaks`,
      headers: as('luca'),
      payload: { duration: 12.5, peaks: [0, 0.5, -0.25, 1] },
    });
    assert.equal(put.statusCode, 200, put.body);
    const get = await app.inject({ method: 'GET', url: `/api/audio/${audioId}/peaks`, headers: as('luca') });
    assert.deepEqual(get.json(), { duration: 12.5, peaks: [0, 0.5, -0.25, 1] });
  });

  it('gestisce note e loop per utente', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/scores/${scoreId}/annotations`,
      headers: as('luca'),
      payload: { barIndex: 3, position: 0.5, kind: 'chord', text: 'Am7', color: '#ff0000' },
    });
    assert.equal(created.statusCode, 200, created.body);
    const annotation = created.json().annotation;
    assert.equal(annotation.text, 'Am7');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/annotations/${annotation.id}`,
      headers: as('luca'),
      payload: { analysis: 'ii7' },
    });
    assert.equal(updated.json().annotation.analysis, 'ii7');
    assert.equal(updated.json().annotation.text, 'Am7');

    const loop = await app.inject({
      method: 'POST',
      url: `/api/scores/${scoreId}/loops`,
      headers: as('luca'),
      payload: { name: 'Assolo', startTick: 3840, endTick: 7680, startBar: 1, endBar: 2, speed: 0.75 },
    });
    assert.equal(loop.statusCode, 200, loop.body);

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/scores/${scoreId}/loops`,
      headers: as('luca'),
      payload: { name: 'Rotto', startTick: 100, endTick: 50, startBar: 0, endBar: 0 },
    });
    assert.equal(invalid.statusCode, 400);

    // Mario non vede lo spartito (privato) e non può toccare la nota di Luca.
    const foreign = await app.inject({ method: 'DELETE', url: `/api/annotations/${annotation.id}`, headers: as('mario') });
    assert.equal(foreign.statusCode, 404);
  });

  it('condivide uno spartito in sola lettura', async () => {
    const shared = await app.inject({ method: 'PATCH', url: `/api/scores/${scoreId}`, headers: as('luca'), payload: { shared: true } });
    assert.equal(shared.json().score.shared, true);

    const detail = await app.inject({ method: 'GET', url: `/api/scores/${scoreId}`, headers: as('mario') });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().score.isOwner, false);
    assert.equal(detail.json().score.audioTracks.length, 1);

    const del = await app.inject({ method: 'DELETE', url: `/api/scores/${scoreId}`, headers: as('mario') });
    assert.equal(del.statusCode, 403);
    const sync = await app.inject({ method: 'PATCH', url: `/api/audio/${audioId}`, headers: as('mario'), payload: { syncPoints: [] } });
    assert.equal(sync.statusCode, 403);

    // Le note di Mario sono sue e non si mescolano con quelle di Luca.
    await app.inject({
      method: 'POST',
      url: `/api/scores/${scoreId}/annotations`,
      headers: as('mario'),
      payload: { barIndex: 0, position: 0, kind: 'note', text: 'Attenzione al bending' },
    });
    const marioNotes = await app.inject({ method: 'GET', url: `/api/scores/${scoreId}/annotations`, headers: as('mario') });
    assert.equal(marioNotes.json().annotations.length, 1);
    const lucaNotes = await app.inject({ method: 'GET', url: `/api/scores/${scoreId}/annotations`, headers: as('luca') });
    assert.equal(lucaNotes.json().annotations.length, 1);
    assert.equal(lucaNotes.json().annotations[0].text, 'Am7');
  });

  it('salva le preferenze per spartito', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/api/scores/${scoreId}/prefs`,
      headers: as('mario'),
      payload: { speed: 0.8, audioId, trackIndexes: [0, 2], unknown: 'x', zoom: 99 },
    });
    assert.deepEqual(put.json().prefs, { speed: 0.8, audioId, trackIndexes: [0, 2] });
    const get = await app.inject({ method: 'GET', url: `/api/scores/${scoreId}/prefs`, headers: as('mario') });
    assert.deepEqual(get.json().prefs, { speed: 0.8, audioId, trackIndexes: [0, 2] });
  });

  it('naviga e cerca nella libreria musicale senza uscire dalla radice', async () => {
    const root = await app.inject({ method: 'GET', url: '/api/library/browse', headers: as('luca') });
    assert.equal(root.statusCode, 200);
    assert.deepEqual(root.json().entries.map((e: { name: string }) => e.name), ['Artista']);

    const album = await app.inject({ method: 'GET', url: '/api/library/browse?path=Artista/Album', headers: as('luca') });
    assert.deepEqual(album.json().entries.map((e: { name: string }) => e.name), ['01 - Canzone Già Nota.mp3']);

    const escape = await app.inject({ method: 'GET', url: '/api/library/browse?path=../', headers: as('luca') });
    assert.equal(escape.statusCode, 400);
    const escapeStream = await app.inject({ method: 'GET', url: '/api/library/stream?path=../segreto.mp3', headers: as('luca') });
    assert.equal(escapeStream.statusCode, 400);

    const search = await app.inject({ method: 'GET', url: '/api/library/search?q=canzone%20gia', headers: as('luca') });
    assert.equal(search.json().entries.length, 1);

    const link = await app.inject({
      method: 'POST',
      url: `/api/scores/${scoreId}/audio/library`,
      headers: as('luca'),
      payload: { path: 'Artista/Album/01 - Canzone Già Nota.mp3' },
    });
    assert.equal(link.statusCode, 200, link.body);
    assert.equal(link.json().audio.source, 'library');
    const stream = await app.inject({ method: 'GET', url: `/api/audio/${link.json().audio.id}/stream`, headers: as('luca') });
    assert.equal(stream.statusCode, 200);
    assert.equal(stream.rawPayload.length, 4096);
  });

  it('protegge la gestione utenti', async () => {
    const forbidden = await app.inject({ method: 'GET', url: '/api/users', headers: as('mario') });
    assert.equal(forbidden.statusCode, 403);

    const selfDelete = await app.inject({ method: 'DELETE', url: '/api/users/1', headers: as('luca') });
    assert.equal(selfDelete.statusCode, 400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: as('luca'),
      payload: { username: 'ospite', password: 'corta' },
    });
    assert.equal(created.statusCode, 400);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: as('luca'),
      payload: { username: 'ospite', password: 'password-ospite' },
    });
    assert.equal(ok.statusCode, 200);

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${ok.json().user.id}`,
      headers: as('luca'),
      payload: { isEnabled: false },
    });
    assert.equal(disable.json().user.isEnabled, false);
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-julianify': '1' },
      payload: { username: 'ospite', password: 'password-ospite' },
    });
    assert.equal(blocked.statusCode, 401);
  });

  it('elimina spartito e file associati', async () => {
    const before = fs.readdirSync(ctx.storage.paths.audioDir).length;
    assert.equal(before, 1);
    const res = await app.inject({ method: 'DELETE', url: `/api/scores/${scoreId}`, headers: as('luca') });
    assert.equal(res.statusCode, 200);
    assert.equal(fs.readdirSync(ctx.storage.paths.audioDir).length, 0);
    assert.equal(fs.readdirSync(ctx.storage.paths.scoresDir).length, 0);
    assert.equal(fs.readdirSync(ctx.storage.paths.peaksDir).length, 0);
    // I file della libreria musicale non vengono mai toccati.
    assert.ok(fs.existsSync(path.join(musicDir, 'Artista', 'Album', '01 - Canzone Già Nota.mp3')));
  });

  it('esegue il logout', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: as('mario') });
    assert.equal(res.statusCode, 200);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as('mario') });
    assert.equal(me.statusCode, 401);
  });
});
