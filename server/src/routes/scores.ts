import type { FastifyInstance } from 'fastify';
import { isScoreFile, type ScorePrefs } from '../../../shared/types.js';
import { deleteScore, getOwnedScore, getScoreDetail, getVisibleScore, listVisibleScores } from '../content.js';
import type { AppContext } from '../context.js';
import { badRequest, body, optionalString, parseId, requireUser } from '../http.js';
import { readSingleFileUpload } from '../upload.js';

const FORMAT_ERROR = 'Formato non supportato: usa Guitar Pro (.gp3, .gp4, .gp5, .gpx, .gp), MusicXML (.xml, .musicxml, .mxl) o Capella (.capx)';

function formatFromExt(ext: string): string {
  if (ext === 'xml' || ext === 'musicxml') return 'musicxml';
  return ext;
}

function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Senza titolo';
}

function sanitizePrefs(input: Record<string, unknown>): ScorePrefs {
  const prefs: ScorePrefs = {};
  if (input.audioId === null || (typeof input.audioId === 'number' && Number.isInteger(input.audioId))) {
    prefs.audioId = input.audioId as number | null;
  }
  if (typeof input.speed === 'number' && input.speed >= 0.1 && input.speed <= 4) prefs.speed = input.speed;
  if (typeof input.volume === 'number' && input.volume >= 0 && input.volume <= 1) prefs.volume = input.volume;
  if (Array.isArray(input.trackIndexes) && input.trackIndexes.every((t) => Number.isInteger(t) && t >= 0)) {
    prefs.trackIndexes = (input.trackIndexes as number[]).slice(0, 64);
  }
  if (typeof input.zoom === 'number' && input.zoom >= 0.25 && input.zoom <= 4) prefs.zoom = input.zoom;
  if (input.layout === 'page' || input.layout === 'horizontal') prefs.layout = input.layout;
  if (['default', 'tab', 'score', 'mixed'].includes(input.staveProfile as string)) {
    prefs.staveProfile = input.staveProfile as ScorePrefs['staveProfile'];
  }
  for (const key of ['showWaveform', 'showAnnotations', 'showAnalysis'] as const) {
    if (typeof input[key] === 'boolean') prefs[key] = input[key] as boolean;
  }
  return prefs;
}

export function registerScoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/scores', async (request) => {
    const user = requireUser(request);
    return { scores: listVisibleScores(ctx, user) };
  });

  app.post('/api/scores', async (request) => {
    const user = requireUser(request);
    const { fields, file } = await readSingleFileUpload(ctx, request, ctx.storage.paths.scoresDir, isScoreFile, FORMAT_ERROR);
    const title = fields.title?.trim().slice(0, 200) || titleFromFilename(file.originalName);
    const { lastInsertRowid } = ctx.db.run(
      `INSERT INTO scores (owner_id, title, artist, album, original_filename, format, file_name, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id,
      title,
      fields.artist?.trim().slice(0, 200) || null,
      fields.album?.trim().slice(0, 200) || null,
      file.originalName.slice(0, 255),
      formatFromExt(file.ext),
      file.fileName,
      file.size,
    );
    return { score: getScoreDetail(ctx, user, lastInsertRowid) };
  });

  app.get('/api/scores/:id', async (request) => {
    const user = requireUser(request);
    const id = parseId((request.params as { id: string }).id);
    return { score: getScoreDetail(ctx, user, id) };
  });

  app.get('/api/scores/:id/file', async (request, reply) => {
    const user = requireUser(request);
    const score = getVisibleScore(ctx, user, parseId((request.params as { id: string }).id));
    reply.header('Cache-Control', 'private, no-cache');
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(score.original_filename)}`);
    reply.type('application/octet-stream');
    return reply.sendFile(score.file_name, ctx.storage.paths.scoresDir);
  });

  app.patch('/api/scores/:id', async (request) => {
    const user = requireUser(request);
    const score = getOwnedScore(ctx, user, parseId((request.params as { id: string }).id));
    const data = body(request);
    const title = optionalString(data.title, 'title', 200);
    const artist = optionalString(data.artist, 'artist', 200);
    const album = optionalString(data.album, 'album', 200);
    if (title === null) throw badRequest('Il titolo non può essere vuoto');
    ctx.db.run(
      `UPDATE scores SET title = COALESCE(?, title), artist = ?, album = ?, shared = ?, updated_at = ? WHERE id = ?`,
      title ?? null,
      artist === undefined ? score.artist : artist,
      album === undefined ? score.album : album,
      typeof data.shared === 'boolean' ? (data.shared ? 1 : 0) : score.shared,
      new Date().toISOString(),
      score.id,
    );
    return { score: getScoreDetail(ctx, user, score.id) };
  });

  // Sostituisce il file dello spartito (es. versione corretta) mantenendo audio, sync, note e loop.
  app.put('/api/scores/:id/file', async (request) => {
    const user = requireUser(request);
    const score = getOwnedScore(ctx, user, parseId((request.params as { id: string }).id));
    const { file } = await readSingleFileUpload(ctx, request, ctx.storage.paths.scoresDir, isScoreFile, FORMAT_ERROR);
    ctx.db.run(
      `UPDATE scores SET original_filename = ?, format = ?, file_name = ?, file_size = ?, updated_at = ? WHERE id = ?`,
      file.originalName.slice(0, 255),
      formatFromExt(file.ext),
      file.fileName,
      file.size,
      new Date().toISOString(),
      score.id,
    );
    await ctx.storage.remove(ctx.storage.paths.scoresDir, score.file_name);
    return { score: getScoreDetail(ctx, user, score.id) };
  });

  app.delete('/api/scores/:id', async (request) => {
    const user = requireUser(request);
    const score = getOwnedScore(ctx, user, parseId((request.params as { id: string }).id));
    await deleteScore(ctx, score);
    return { ok: true };
  });

  app.get('/api/scores/:id/prefs', async (request) => {
    const user = requireUser(request);
    const score = getVisibleScore(ctx, user, parseId((request.params as { id: string }).id));
    const row = ctx.db.get<{ prefs: string }>('SELECT prefs FROM score_prefs WHERE user_id = ? AND score_id = ?', user.id, score.id);
    let prefs: ScorePrefs = {};
    try {
      prefs = row ? sanitizePrefs(JSON.parse(row.prefs)) : {};
    } catch {
      prefs = {};
    }
    return { prefs };
  });

  app.put('/api/scores/:id/prefs', async (request) => {
    const user = requireUser(request);
    const score = getVisibleScore(ctx, user, parseId((request.params as { id: string }).id));
    const prefs = sanitizePrefs(body(request));
    ctx.db.run(
      `INSERT INTO score_prefs (user_id, score_id, prefs) VALUES (?, ?, ?)
       ON CONFLICT (user_id, score_id) DO UPDATE SET prefs = excluded.prefs`,
      user.id,
      score.id,
      JSON.stringify(prefs),
    );
    return { prefs };
  });
}
