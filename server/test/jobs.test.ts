import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { AudioTrack, Job } from '../../shared/types.js';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';

const FAKE_WORKER = path.join(import.meta.dirname, 'fixtures', 'fake-worker.mjs');

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const boundary = `----julianify${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-julianify': '1' } };
}

describe('Lavori del worker (separazione e sincronizzazione)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let tmp: string;
  const cookies: Record<string, string> = {};
  let scoreId = 0;
  let audioId = 0;
  let variantIds: number[] = [];

  const as = (user: string) => ({ cookie: cookies[user], 'x-julianify': '1' });

  async function waitJob(id: number, until: (job: Job) => boolean = (j) => !['queued', 'running'].includes(j.status)): Promise<Job> {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: as('luca') });
      assert.equal(res.statusCode, 200, res.body);
      const job = res.json().job as Job;
      if (until(job)) return job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`il lavoro ${id} non è terminato`);
  }

  async function tracks(): Promise<AudioTrack[]> {
    const res = await app.inject({ method: 'GET', url: `/api/scores/${scoreId}`, headers: as('luca') });
    return res.json().score.audioTracks;
  }

  const autosyncBody = (extra: Record<string, unknown> = {}) => ({
    notes: [
      [0, 1, 60, 90],
      [1, 1, 64, 90],
      [2.4, 1.2, 67, 90],
    ],
    targets: [0, 2.4],
    points: [
      [0, 0, 0],
      [1, 0, 0],
    ],
    scoreDuration: 4.8,
    anchors: [],
    fromOrder: 0,
    toOrder: 1,
    granularity: 'bar',
    ...extra,
  });

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'julianify-jobs-'));
    const config = loadConfig({ dataDir: path.join(tmp, 'data'), webDir: path.join(tmp, 'noweb'), musicDir: null, workerPython: FAKE_WORKER });
    ({ app, ctx } = await buildApp(config, { logger: false, detectWorker: false }));
    await ctx.jobs.detect();
    await createUser(ctx.db, { username: 'luca', password: 'password-luca' });
    await createUser(ctx.db, { username: 'mario', password: 'password-mario' });
    for (const user of ['luca', 'mario']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-julianify': '1' },
        payload: { username: user, password: `password-${user}` },
      });
      cookies[user] = `julianify_session=${res.cookies.find((c) => c.name === 'julianify_session')!.value}`;
    }
    const score = multipart({ title: 'Brano' }, { name: 'brano.gp3', content: Buffer.from('FICHIER GUITAR PRO v3.00') });
    const s = await app.inject({ method: 'POST', url: '/api/scores', headers: { ...score.headers, cookie: cookies.luca }, payload: score.payload });
    scoreId = s.json().score.id;
    const audio = multipart({}, { name: 'Registrazione.mp3', content: Buffer.alloc(2048, 7) });
    const a = await app.inject({
      method: 'POST',
      url: `/api/scores/${scoreId}/audio`,
      headers: { ...audio.headers, cookie: cookies.luca },
      payload: audio.payload,
    });
    audioId = a.json().audio.id;
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rileva il worker e ne espone le funzioni', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/info', headers: as('luca') });
    assert.equal(res.json().worker.status, 'ready');
    assert.equal(res.json().worker.stems, true);
    assert.equal(res.json().worker.autosync, true);
    assert.equal(res.json().worker.threads, 2);
  });

  it('separa gli strumenti e crea le versioni della registrazione', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/audio/${audioId}/stems`,
      headers: as('luca'),
      payload: { variants: ['no_guitar', 'guitar'] },
    });
    assert.equal(res.statusCode, 202, res.body);
    const job = await waitJob(res.json().job.id);
    assert.equal(job.status, 'done', job.error ?? '');
    assert.equal(job.progress, 1);
    variantIds = (job.result as { audioIds: number[] }).audioIds;
    assert.equal(variantIds.length, 2);

    const list = await tracks();
    assert.equal(list.length, 3);
    const noGuitar = list.find((t) => t.variant === 'no_guitar')!;
    assert.equal(noGuitar.parentId, audioId);
    assert.equal(noGuitar.name, 'Registrazione · Senza chitarra');
    assert.equal(noGuitar.mime, 'audio/flac');
    assert.equal(noGuitar.durationMs, 12346);
    const stream = await app.inject({ method: 'GET', url: `/api/audio/${noGuitar.id}/stream`, headers: as('luca') });
    assert.equal(stream.body, 'fLaC finto: drums+bass+other+vocals+piano');
    // le versioni non contano come tracce a sé nell'elenco degli spartiti
    const scores = await app.inject({ method: 'GET', url: '/api/scores', headers: as('luca') });
    assert.equal(scores.json().scores[0].audioCount, 1);
    // la cartella di lavoro temporanea è stata rimossa
    assert.deepEqual(fs.readdirSync(ctx.storage.paths.tmpDir), []);
  });

  it('condivide i sync point tra originale e versioni', async () => {
    const syncPoints = [
      { barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 250 },
      { barIndex: 4, barOccurence: 0, barPosition: 0, millisecondOffset: 9000 },
    ];
    const patch = await app.inject({ method: 'PATCH', url: `/api/audio/${variantIds[0]}`, headers: as('luca'), payload: { syncPoints } });
    assert.equal(patch.statusCode, 200, patch.body);
    assert.deepEqual(patch.json().audio.syncPoints, syncPoints);
    for (const track of await tracks()) assert.deepEqual(track.syncPoints, syncPoints, track.name);
  });

  it('rifiuta separazioni non valide', async () => {
    const post = (id: number, variants: unknown, user = 'luca') =>
      app.inject({ method: 'POST', url: `/api/audio/${id}/stems`, headers: as(user), payload: { variants } });
    assert.equal((await post(audioId, ['guitar'])).statusCode, 409);
    assert.equal((await post(variantIds[0], ['bass'])).statusCode, 400);
    assert.equal((await post(audioId, ['kazoo'])).statusCode, 400);
    assert.equal((await post(audioId, [])).statusCode, 400);
    assert.equal((await post(audioId, ['bass'], 'mario')).statusCode, 404);
  });

  it('sincronizza automaticamente e conserva i punti con il lavoro', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/audio/${audioId}/autosync`,
      headers: as('luca'),
      payload: autosyncBody({ analyzeAudioId: variantIds[1] }),
    });
    assert.equal(res.statusCode, 202, res.body);
    const job = await waitJob(res.json().job.id);
    assert.equal(job.status, 'done', job.error ?? '');
    const params = job.params as { points: number[][]; noteCount: number; analyzeAudioId: number };
    assert.deepEqual(params.points, [
      [0, 0, 0],
      [1, 0, 0],
    ]);
    assert.equal(params.noteCount, 3);
    assert.equal(params.analyzeAudioId, variantIds[1]);
    assert.deepEqual((job.result as { times: number[] }).times, [500, 2900]);
  });

  it('valida le richieste di sincronizzazione', async () => {
    const post = (payload: unknown, id = audioId) =>
      app.inject({ method: 'POST', url: `/api/audio/${id}/autosync`, headers: as('luca'), payload: payload as object });
    assert.equal((await post(autosyncBody({ points: [[0, 0, 0]] }))).statusCode, 400);
    assert.equal((await post(autosyncBody({ targets: [2.4, 0] }))).statusCode, 400);
    assert.equal((await post(autosyncBody({ notes: [[0, -1, 60, 90]] }))).statusCode, 400);
    assert.equal((await post(autosyncBody({ granularity: 'sedicesimi' }))).statusCode, 400);
    assert.equal((await post(autosyncBody({ analyzeAudioId: 99_999 }))).statusCode, 400);
  });

  it('riporta gli errori del worker', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/audio/${audioId}/autosync`,
      headers: as('luca'),
      payload: autosyncBody({ notes: [[0, 1, 0, 90]] }),
    });
    const job = await waitJob(res.json().job.id);
    assert.equal(job.status, 'error');
    assert.equal(job.error, 'Errore simulato');
  });

  it('annulla un lavoro in corso', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/audio/${audioId}/stems`,
      headers: as('luca'),
      payload: { variants: ['no_vocals'] },
    });
    const id = res.json().job.id;
    await waitJob(id, (j) => j.status === 'running');
    const again = await app.inject({ method: 'POST', url: `/api/audio/${audioId}/stems`, headers: as('luca'), payload: { variants: ['bass'] } });
    assert.equal(again.statusCode, 409);
    const del = await app.inject({ method: 'DELETE', url: `/api/jobs/${id}`, headers: as('luca') });
    assert.equal(del.statusCode, 200);
    const job = await waitJob(id);
    assert.equal(job.status, 'canceled');
    assert.equal((await tracks()).length, 3);
    await ctx.jobs.idle();
    assert.deepEqual(fs.readdirSync(ctx.storage.paths.tmpDir), []);
  });

  it('elenca i lavori recenti dello spartito', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/scores/${scoreId}/jobs`, headers: as('luca') });
    const kinds = res.json().jobs.map((j: Job) => `${j.kind}:${j.status}`);
    assert.deepEqual(kinds, ['stems:canceled', 'autosync:error', 'autosync:done', 'stems:done']);
    const other = await app.inject({ method: 'GET', url: `/api/jobs/${res.json().jobs[0].id}`, headers: as('mario') });
    assert.equal(other.statusCode, 404);
  });

  it('risponde 503 se il worker non è disponibile', async () => {
    const saved = ctx.jobs.info;
    ctx.jobs.info = { ...saved, status: 'disabled', stems: false, autosync: false, message: 'Worker Python non installato' };
    try {
      const res = await app.inject({ method: 'POST', url: `/api/audio/${audioId}/stems`, headers: as('luca'), payload: { variants: ['bass'] } });
      assert.equal(res.statusCode, 503);
      assert.match(res.json().error, /non installato/);
    } finally {
      ctx.jobs.info = saved;
    }
  });

  it("elimina le versioni insieme all'originale", async () => {
    assert.equal(fs.readdirSync(ctx.storage.paths.audioDir).length, 3);
    const res = await app.inject({ method: 'DELETE', url: `/api/audio/${audioId}`, headers: as('luca') });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await tracks(), []);
    assert.deepEqual(fs.readdirSync(ctx.storage.paths.audioDir), []);
  });
});
