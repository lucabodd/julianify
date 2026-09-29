import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  AUDIO_VARIANTS,
  isAudioVariant,
  type AudioVariant,
  type AutoSyncJobParams,
  type AutoSyncRequest,
  type AutoSyncResult,
  type StemsJobResult,
} from '../../../shared/types.js';
import type { UserRow } from '../auth.js';
import { audioFilePath, getAudioRow, getOwnedAudio, getVisibleScore, syncOwner, touchScore, type AudioRow } from '../content.js';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, body, finiteNumber, integer, notFound, parseId, requireUser } from '../http.js';
import { WorkerFailure, type JobRow } from '../jobs.js';

const MAX_NOTES = 200_000;
const MAX_TARGETS = 20_000;
const MAX_ANCHORS = 10_000;
const MAX_ACTIVE_JOBS_PER_USER = 5;

function requireFeature(ctx: AppContext, feature: 'stems' | 'autosync'): void {
  const info = ctx.jobs.info;
  if (info[feature]) return;
  const what = feature === 'stems' ? 'La separazione degli strumenti' : 'La sincronizzazione automatica';
  const why = info.status === 'detecting' ? 'il worker è ancora in fase di avvio, riprova tra poco' : (info.message ?? 'worker Python non installato');
  throw new HttpError(503, `${what} non è disponibile: ${why}`);
}

function checkQuota(ctx: AppContext, user: UserRow): void {
  if (ctx.jobs.activeCount(user.id) >= MAX_ACTIVE_JOBS_PER_USER) {
    throw new HttpError(429, 'Hai già troppi lavori in coda: attendi che finiscano');
  }
}

function numberArray(value: unknown, field: string, min: number, max: number, length?: number): number[] {
  if (!Array.isArray(value)) throw badRequest(`${field} non valido`);
  if (length !== undefined && value.length !== length) throw badRequest(`${field} non valido`);
  return value.map((v) => finiteNumber(v, field, min, max));
}

export function sanitizeAutoSyncRequest(data: Record<string, unknown>): AutoSyncRequest {
  if (!Array.isArray(data.notes) || data.notes.length === 0 || data.notes.length > MAX_NOTES) {
    throw badRequest('Note dello spartito mancanti o troppe');
  }
  const notes = data.notes.map((n) => {
    const [start, duration, pitch, velocity] = numberArray(n, 'notes', 0, 86_400, 4);
    if (duration <= 0 || pitch > 127 || velocity < 1 || velocity > 127) throw badRequest('Nota non valida');
    return [start, duration, Math.round(pitch), velocity] as [number, number, number, number];
  });
  if (!Array.isArray(data.targets) || data.targets.length === 0 || data.targets.length > MAX_TARGETS) {
    throw badRequest('Punti da sincronizzare mancanti o troppi');
  }
  const targets = numberArray(data.targets, 'targets', 0, 86_400);
  if (targets.some((t, i) => i > 0 && t < targets[i - 1])) throw badRequest('I punti devono essere in ordine');
  if (!Array.isArray(data.points) || data.points.length !== targets.length) throw badRequest('points non valido');
  const points = data.points.map((p) => {
    const [barIndex, occurrence, position] = numberArray(p, 'points', 0, 100_000, 3);
    if (position >= 1) throw badRequest('Posizione non valida');
    return [integer(barIndex, 'barIndex', 0, 100_000), integer(occurrence, 'occurrence', 0, 10_000), position] as [number, number, number];
  });
  const anchorsRaw = data.anchors ?? [];
  if (!Array.isArray(anchorsRaw) || anchorsRaw.length > MAX_ANCHORS) throw badRequest('anchors non valido');
  const anchors = anchorsRaw.map((a) => numberArray(a, 'anchors', 0, 86_400_000, 2) as [number, number]);
  const fromOrder = integer(data.fromOrder, 'fromOrder', 0, 1_000_000);
  const toOrder = integer(data.toOrder, 'toOrder', fromOrder, 1_000_000);
  if (data.granularity !== 'bar' && data.granularity !== 'beat') throw badRequest('granularity non valido');
  const analyze = data.analyzeAudioId;
  return {
    notes,
    targets,
    points,
    anchors,
    scoreDuration: finiteNumber(data.scoreDuration, 'scoreDuration', 0.1, 86_400),
    fromOrder,
    toOrder,
    granularity: data.granularity,
    analyzeAudioId: analyze === undefined || analyze === null ? null : integer(analyze, 'analyzeAudioId', 1, Number.MAX_SAFE_INTEGER),
  };
}

function sanitizeAutoSyncResult(output: unknown, count: number): AutoSyncResult {
  const r = (output ?? {}) as Record<string, unknown>;
  const times = Array.isArray(r.times) ? r.times : [];
  if (times.length !== count || times.some((t) => typeof t !== 'number' || !Number.isFinite(t))) {
    throw new WorkerFailure('Risultato dell\'allineamento non valido');
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    times: times as number[],
    confidence: (Array.isArray(r.confidence) ? r.confidence : []).map((c) => (typeof c === 'number' ? c : null)),
    quality: typeof r.quality === 'number' && Number.isFinite(r.quality) ? r.quality : null,
    suspicious: (Array.isArray(r.suspicious) ? r.suspicious : []).filter((i): i is number => Number.isInteger(i)),
    refined: num(r.refined),
    tuningCents: num(r.tuningCents),
    transposition: num(r.transposition),
    anchorsUsed: num(r.anchorsUsed),
    audioStartMs: num(r.audioStartMs),
    audioEndMs: num(r.audioEndMs),
    audioDurationMs: num(r.audioDurationMs),
  };
}

/** Sposta le versioni prodotte dal worker tra le tracce della partitura. */
async function saveVariants(
  ctx: AppContext,
  parentId: number,
  variants: AudioVariant[],
  output: unknown,
  workDir: string,
): Promise<StemsJobResult> {
  const parent = getAudioRow(ctx, parentId);
  if (!parent) throw new WorkerFailure('La traccia originale è stata eliminata');
  const durationMs = Math.round(Number((output as { durationMs?: unknown })?.durationMs)) || null;
  const moved: string[] = [];
  try {
    const audioIds: number[] = [];
    for (const variant of variants) {
      const source = path.join(workDir, `${variant}.flac`);
      const { size } = await fsp.stat(source);
      const fileName = `${crypto.randomUUID()}.flac`;
      await fsp.rename(source, path.join(ctx.storage.paths.audioDir, fileName));
      moved.push(fileName);
      // una versione identica creata nel frattempo viene sostituita
      const old = ctx.db.get<AudioRow>('SELECT * FROM audio_tracks WHERE parent_id = ? AND variant = ?', parent.id, variant);
      const { lastInsertRowid } = ctx.db.run(
        `INSERT INTO audio_tracks (score_id, owner_id, name, source, file_name, mime, file_size, duration_ms, parent_id, variant)
         VALUES (?, ?, ?, 'upload', ?, 'audio/flac', ?, ?, ?, ?)`,
        parent.score_id,
        parent.owner_id,
        `${parent.name} · ${AUDIO_VARIANTS[variant].label}`.slice(0, 200),
        fileName,
        size,
        durationMs,
        parent.id,
        variant,
      );
      if (old) {
        ctx.db.run('DELETE FROM audio_tracks WHERE id = ?', old.id);
        await ctx.storage.remove(ctx.storage.paths.audioDir, old.file_name);
        await fsp.rm(ctx.storage.peaksFile(old.id), { force: true });
      }
      audioIds.push(lastInsertRowid);
    }
    touchScore(ctx, parent.score_id);
    return { audioIds };
  } catch (err) {
    for (const fileName of moved) {
      if (!ctx.db.get('SELECT id FROM audio_tracks WHERE file_name = ?', fileName)) {
        await ctx.storage.remove(ctx.storage.paths.audioDir, fileName);
      }
    }
    throw err;
  }
}

function visibleJob(ctx: AppContext, user: UserRow, id: number): JobRow {
  const row = ctx.jobs.get(id);
  if (!row || (row.user_id !== user.id && user.is_admin !== 1)) throw notFound('Lavoro non trovato');
  return row;
}

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Separazione degli strumenti: crea le versioni richieste della registrazione.
  app.post('/api/audio/:id/stems', async (request, reply) => {
    const user = requireUser(request);
    const { audio, score } = getOwnedAudio(ctx, user, parseId((request.params as { id: string }).id));
    requireFeature(ctx, 'stems');
    if (audio.parent_id !== null) throw badRequest('Scegli la registrazione originale, non una versione già separata');
    const data = body(request);
    if (!Array.isArray(data.variants) || data.variants.length === 0) throw badRequest('Scegli almeno una versione');
    const variants = [...new Set(data.variants)];
    if (!variants.every(isAudioVariant)) throw badRequest('Versione non valida');
    const existing = new Set(
      ctx.db.all<{ variant: string }>('SELECT variant FROM audio_tracks WHERE parent_id = ?', audio.id).map((r) => r.variant),
    );
    const duplicate = variants.find((v) => existing.has(v));
    if (duplicate) throw new HttpError(409, `La versione «${AUDIO_VARIANTS[duplicate].label}» esiste già`);
    if (ctx.jobs.hasActive('stems', audio.id)) throw new HttpError(409, 'Separazione già in corso per questa traccia');
    checkQuota(ctx, user);
    const input = await audioFilePath(ctx, audio);
    const job = ctx.jobs.enqueue({
      kind: 'stems',
      userId: user.id,
      scoreId: score.id,
      audioId: audio.id,
      params: { variants },
      command: (workDir) => ({
        command: 'stems',
        params: {
          input,
          outputs: variants.map((v) => ({ path: path.join(workDir, `${v}.flac`), stems: AUDIO_VARIANTS[v].stems })),
        },
      }),
      finish: (output, workDir) => saveVariants(ctx, audio.id, variants, output, workDir),
    });
    reply.status(202);
    return { job };
  });

  // Sincronizzazione automatica: il client manda le note (in secondi al tempo
  // scritto) e i punti da collocare; il risultato va applicato dal client.
  app.post('/api/audio/:id/autosync', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    const user = requireUser(request);
    const { audio, score } = getOwnedAudio(ctx, user, parseId((request.params as { id: string }).id));
    requireFeature(ctx, 'autosync');
    const req = sanitizeAutoSyncRequest(body(request));
    const owner = syncOwner(ctx, audio);
    let analyzed = owner;
    if (req.analyzeAudioId !== null && req.analyzeAudioId !== undefined) {
      const other = getAudioRow(ctx, req.analyzeAudioId);
      if (!other || (other.id !== owner.id && other.parent_id !== owner.id)) {
        throw badRequest('La traccia da analizzare deve essere la registrazione o una sua versione separata');
      }
      analyzed = other;
    }
    if (ctx.jobs.hasActive('autosync', owner.id)) throw new HttpError(409, 'Sincronizzazione già in corso per questa traccia');
    checkQuota(ctx, user);
    const input = await audioFilePath(ctx, analyzed);
    const params: AutoSyncJobParams = {
      points: req.points,
      scoreDuration: req.scoreDuration,
      fromOrder: req.fromOrder,
      toOrder: req.toOrder,
      granularity: req.granularity,
      analyzeAudioId: analyzed.id === owner.id ? null : analyzed.id,
      noteCount: req.notes.length,
      anchorCount: req.anchors.length,
    };
    const job = ctx.jobs.enqueue({
      kind: 'autosync',
      userId: user.id,
      scoreId: score.id,
      audioId: owner.id,
      params,
      command: () => ({
        command: 'autosync',
        params: {
          audio: input,
          notes: req.notes,
          targets: req.targets,
          scoreDuration: req.scoreDuration,
          anchors: req.anchors,
        },
      }),
      finish: (output) => sanitizeAutoSyncResult(output, req.targets.length),
    });
    reply.status(202);
    return { job };
  });

  app.get('/api/jobs/:id', async (request) => {
    const user = requireUser(request);
    return { job: ctx.jobs.toJob(visibleJob(ctx, user, parseId((request.params as { id: string }).id))) };
  });

  /** Lavori recenti dell'utente su uno spartito (in corso e conclusi da poco). */
  app.get('/api/scores/:id/jobs', async (request) => {
    const user = requireUser(request);
    const score = getVisibleScore(ctx, user, parseId((request.params as { id: string }).id));
    const rows = ctx.db.all<JobRow>(
      `SELECT * FROM jobs WHERE score_id = ? AND user_id = ?
       AND (status IN ('queued', 'running') OR finished_at > ?)
       ORDER BY id DESC LIMIT 20`,
      score.id,
      user.id,
      new Date(Date.now() - 86_400_000).toISOString(),
    );
    return { jobs: rows.map((r) => ctx.jobs.toJob(r)) };
  });

  /** Annulla un lavoro in corso, oppure toglie dall'elenco uno concluso. */
  app.delete('/api/jobs/:id', async (request) => {
    const user = requireUser(request);
    const row = visibleJob(ctx, user, parseId((request.params as { id: string }).id));
    if (row.status === 'queued' || row.status === 'running') {
      ctx.jobs.cancel(row.id);
    } else {
      ctx.db.run('DELETE FROM jobs WHERE id = ?', row.id);
    }
    return { ok: true };
  });
}
