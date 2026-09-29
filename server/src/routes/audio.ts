import fsp from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { isAudioFile, type FlatSyncPoint } from '../../../shared/types.js';
import {
  audioTrackOf,
  deleteAudio,
  getOwnedAudio,
  getOwnedScore,
  getVisibleAudio,
  syncOwner,
  toAudioTrack,
  touchScore,
  type AudioRow,
} from '../content.js';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, body, finiteNumber, integer, optionalString, parseId, requireUser } from '../http.js';
import { readSingleFileUpload } from '../upload.js';

const MAX_SYNC_POINTS = 10_000;
const MAX_PEAKS = 2_000_000;

function trackNameFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim().slice(0, 200) || 'Traccia audio';
}

export function sanitizeSyncPoints(value: unknown): FlatSyncPoint[] {
  if (!Array.isArray(value)) throw badRequest('Sync point non validi');
  if (value.length > MAX_SYNC_POINTS) throw badRequest('Troppi sync point');
  return value.map((p) => {
    if (!p || typeof p !== 'object') throw badRequest('Sync point non valido');
    const point = p as Record<string, unknown>;
    return {
      barIndex: integer(point.barIndex, 'barIndex', 0, 100_000),
      barOccurence: integer(point.barOccurence, 'barOccurence', 0, 10_000),
      barPosition: finiteNumber(point.barPosition, 'barPosition', 0, 1),
      millisecondOffset: Math.round(finiteNumber(point.millisecondOffset, 'millisecondOffset', -600_000, 86_400_000) * 1000) / 1000,
    };
  });
}

function getAudio(ctx: AppContext, id: number): AudioRow {
  return ctx.db.get<AudioRow>('SELECT * FROM audio_tracks WHERE id = ?', id)!;
}

export function registerAudioRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/scores/:id/audio', async (request) => {
    const user = requireUser(request);
    const score = getOwnedScore(ctx, user, parseId((request.params as { id: string }).id));
    const { fields, file } = await readSingleFileUpload(
      ctx,
      request,
      ctx.storage.paths.audioDir,
      isAudioFile,
      'Formato audio non supportato: usa mp3, m4a/aac, ogg/opus, flac, wav o webm',
    );
    const { lastInsertRowid } = ctx.db.run(
      `INSERT INTO audio_tracks (score_id, owner_id, name, source, file_name, mime, file_size)
       VALUES (?, ?, ?, 'upload', ?, ?, ?)`,
      score.id,
      user.id,
      fields.name?.trim().slice(0, 200) || trackNameFromFilename(file.originalName),
      file.fileName,
      file.mimetype || null,
      file.size,
    );
    touchScore(ctx, score.id);
    return { audio: toAudioTrack(getAudio(ctx, lastInsertRowid)) };
  });

  app.post('/api/scores/:id/audio/library', async (request) => {
    const user = requireUser(request);
    const score = getOwnedScore(ctx, user, parseId((request.params as { id: string }).id));
    if (!ctx.library) throw badRequest('Libreria musicale non configurata (JULIANIFY_MUSIC_DIR)');
    const data = body(request);
    if (typeof data.path !== 'string' || !data.path) throw badRequest('Percorso mancante');
    const info = await ctx.library.statAudio(data.path);
    const fileName = info.rel.slice(info.rel.lastIndexOf('/') + 1);
    const { lastInsertRowid } = ctx.db.run(
      `INSERT INTO audio_tracks (score_id, owner_id, name, source, library_path, file_size)
       VALUES (?, ?, ?, 'library', ?, ?)`,
      score.id,
      user.id,
      optionalString(data.name, 'name', 200) || trackNameFromFilename(fileName),
      info.rel,
      info.size,
    );
    touchScore(ctx, score.id);
    return { audio: toAudioTrack(getAudio(ctx, lastInsertRowid)) };
  });

  app.get('/api/audio/:id/stream', async (request, reply) => {
    const user = requireUser(request);
    const { audio } = getVisibleAudio(ctx, user, parseId((request.params as { id: string }).id));
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    if (audio.source === 'upload' && audio.file_name) {
      return reply.sendFile(audio.file_name, ctx.storage.paths.audioDir);
    }
    if (!ctx.library || !audio.library_path) throw new HttpError(404, 'Libreria musicale non disponibile');
    const info = await ctx.library.statAudio(audio.library_path);
    return reply.sendFile(info.rel, ctx.library.root);
  });

  app.patch('/api/audio/:id', async (request) => {
    const user = requireUser(request);
    const { audio, score } = getOwnedAudio(ctx, user, parseId((request.params as { id: string }).id));
    const data = body(request);
    const name = optionalString(data.name, 'name', 200);
    if (name === null) throw badRequest('Il nome non può essere vuoto');
    const syncPoints = data.syncPoints === undefined ? undefined : sanitizeSyncPoints(data.syncPoints);
    const durationMs =
      data.durationMs === undefined ? undefined : Math.round(finiteNumber(data.durationMs, 'durationMs', 0, 86_400_000));
    const now = new Date().toISOString();
    ctx.db.run(
      'UPDATE audio_tracks SET name = ?, duration_ms = ?, updated_at = ? WHERE id = ?',
      name ?? audio.name,
      durationMs ?? audio.duration_ms,
      now,
      audio.id,
    );
    if (syncPoints) {
      // le versioni separate condividono i sync point della registrazione originale
      ctx.db.run('UPDATE audio_tracks SET sync_points = ?, updated_at = ? WHERE id = ?', JSON.stringify(syncPoints), now, syncOwner(ctx, audio).id);
      touchScore(ctx, score.id);
    }
    return { audio: audioTrackOf(ctx, getAudio(ctx, audio.id)) };
  });

  app.delete('/api/audio/:id', async (request) => {
    const user = requireUser(request);
    const { audio, score } = getOwnedAudio(ctx, user, parseId((request.params as { id: string }).id));
    await deleteAudio(ctx, audio);
    touchScore(ctx, score.id);
    return { ok: true };
  });

  // Picchi della forma d'onda calcolati dal browser e memorizzati per le aperture successive.
  app.get('/api/audio/:id/peaks', async (request, reply) => {
    const user = requireUser(request);
    const { audio } = getVisibleAudio(ctx, user, parseId((request.params as { id: string }).id));
    if (audio.has_peaks !== 1) throw new HttpError(404, 'Forma d\'onda non ancora calcolata');
    const json = await fsp.readFile(ctx.storage.peaksFile(audio.id), 'utf8').catch(() => null);
    if (!json) throw new HttpError(404, 'Forma d\'onda non ancora calcolata');
    reply.type('application/json');
    return json;
  });

  app.put('/api/audio/:id/peaks', { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const user = requireUser(request);
    const { audio } = getOwnedAudio(ctx, user, parseId((request.params as { id: string }).id));
    const data = body(request);
    const duration = finiteNumber(data.duration, 'duration', 0, 86_400);
    if (!Array.isArray(data.peaks) || data.peaks.length === 0 || data.peaks.length > MAX_PEAKS) {
      throw badRequest('Picchi non validi');
    }
    const peaks = (data.peaks as unknown[]).map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0));
    await fsp.writeFile(ctx.storage.peaksFile(audio.id), JSON.stringify({ duration, peaks }));
    ctx.db.run('UPDATE audio_tracks SET has_peaks = 1, duration_ms = COALESCE(duration_ms, ?) WHERE id = ?', Math.round(duration * 1000), audio.id);
    return { ok: true };
  });
}
