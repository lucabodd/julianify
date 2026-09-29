import fsp from 'node:fs/promises';
import path from 'node:path';
import { isAudioVariant, type AudioTrack, type FlatSyncPoint, type ScoreDetail, type ScoreSummary } from '../../shared/types.js';
import type { UserRow } from './auth.js';
import type { AppContext } from './context.js';
import { HttpError, forbidden, notFound } from './http.js';

export interface ScoreRow {
  id: number;
  owner_id: number;
  title: string;
  artist: string | null;
  album: string | null;
  original_filename: string;
  format: string;
  file_name: string;
  file_size: number;
  shared: number;
  created_at: string;
  updated_at: string;
  owner_name?: string;
  audio_count?: number;
}

export interface AudioRow {
  id: number;
  score_id: number;
  owner_id: number;
  name: string;
  source: 'upload' | 'library';
  file_name: string | null;
  library_path: string | null;
  mime: string | null;
  file_size: number | null;
  duration_ms: number | null;
  sync_points: string;
  has_peaks: number;
  parent_id: number | null;
  variant: string | null;
  created_at: string;
  updated_at: string;
}

const SCORE_SELECT = `
  SELECT s.*, u.username AS owner_name,
    (SELECT COUNT(*) FROM audio_tracks a WHERE a.score_id = s.id AND a.parent_id IS NULL) AS audio_count
  FROM scores s JOIN users u ON u.id = s.owner_id`;

export function toScoreSummary(row: ScoreRow, user: UserRow): ScoreSummary {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    format: row.format,
    originalFilename: row.original_filename,
    fileSize: row.file_size,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? '',
    isOwner: row.owner_id === user.id,
    shared: row.shared === 1,
    audioCount: row.audio_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseSyncPoints(json: string): FlatSyncPoint[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * @param syncSource riga da cui leggere i sync point: per le versioni separate
 *   è la registrazione originale, con cui li condividono.
 */
export function toAudioTrack(row: AudioRow, syncSource: AudioRow = row): AudioTrack {
  return {
    id: row.id,
    scoreId: row.score_id,
    name: row.name,
    source: row.source,
    libraryPath: row.library_path,
    mime: row.mime,
    fileSize: row.file_size,
    durationMs: row.duration_ms,
    syncPoints: parseSyncPoints(syncSource.sync_points),
    hasPeaks: row.has_peaks === 1,
    parentId: row.parent_id,
    variant: isAudioVariant(row.variant) ? row.variant : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listVisibleScores(ctx: AppContext, user: UserRow): ScoreSummary[] {
  const rows = ctx.db.all<ScoreRow>(
    `${SCORE_SELECT} WHERE s.owner_id = ? OR s.shared = 1 ORDER BY s.updated_at DESC`,
    user.id,
  );
  return rows.map((r) => toScoreSummary(r, user));
}

/** Spartito visibile all'utente (proprio o condiviso), altrimenti 404. */
export function getVisibleScore(ctx: AppContext, user: UserRow, scoreId: number): ScoreRow {
  const row = ctx.db.get<ScoreRow>(`${SCORE_SELECT} WHERE s.id = ?`, scoreId);
  if (!row || (row.owner_id !== user.id && row.shared !== 1)) throw notFound('Spartito non trovato');
  return row;
}

/** Spartito di proprietà dell'utente, altrimenti 403/404. */
export function getOwnedScore(ctx: AppContext, user: UserRow, scoreId: number): ScoreRow {
  const row = getVisibleScore(ctx, user, scoreId);
  if (row.owner_id !== user.id) throw forbidden('Solo il proprietario può modificare questo spartito');
  return row;
}

export function getScoreDetail(ctx: AppContext, user: UserRow, scoreId: number): ScoreDetail {
  const row = getVisibleScore(ctx, user, scoreId);
  const audio = ctx.db.all<AudioRow>('SELECT * FROM audio_tracks WHERE score_id = ? ORDER BY created_at, id', scoreId);
  const byId = new Map(audio.map((a) => [a.id, a]));
  return {
    ...toScoreSummary(row, user),
    audioTracks: audio.map((a) => toAudioTrack(a, (a.parent_id !== null && byId.get(a.parent_id)) || a)),
  };
}

export function getAudioRow(ctx: AppContext, audioId: number): AudioRow | undefined {
  return ctx.db.get<AudioRow>('SELECT * FROM audio_tracks WHERE id = ?', audioId);
}

/** Traccia che custodisce i sync point: l'originale per le versioni separate. */
export function syncOwner(ctx: AppContext, audio: AudioRow): AudioRow {
  return (audio.parent_id !== null && getAudioRow(ctx, audio.parent_id)) || audio;
}

export function audioTrackOf(ctx: AppContext, audio: AudioRow): AudioTrack {
  return toAudioTrack(audio, syncOwner(ctx, audio));
}

/** Percorso del file audio sul disco (caricato o nella libreria musicale). */
export async function audioFilePath(ctx: AppContext, audio: AudioRow): Promise<string> {
  if (audio.source === 'upload' && audio.file_name) return path.join(ctx.storage.paths.audioDir, audio.file_name);
  if (!ctx.library || !audio.library_path) throw new HttpError(404, 'Libreria musicale non disponibile');
  return (await ctx.library.statAudio(audio.library_path)).full;
}

export function getVisibleAudio(ctx: AppContext, user: UserRow, audioId: number): { audio: AudioRow; score: ScoreRow } {
  const audio = ctx.db.get<AudioRow>('SELECT * FROM audio_tracks WHERE id = ?', audioId);
  if (!audio) throw notFound('Traccia audio non trovata');
  const score = getVisibleScore(ctx, user, audio.score_id);
  return { audio, score };
}

export function getOwnedAudio(ctx: AppContext, user: UserRow, audioId: number): { audio: AudioRow; score: ScoreRow } {
  const result = getVisibleAudio(ctx, user, audioId);
  if (result.score.owner_id !== user.id) throw forbidden('Solo il proprietario può modificare questa traccia');
  return result;
}

export function touchScore(ctx: AppContext, scoreId: number): void {
  ctx.db.run('UPDATE scores SET updated_at = ? WHERE id = ?', new Date().toISOString(), scoreId);
}

export async function deleteAudioFiles(ctx: AppContext, audio: AudioRow): Promise<void> {
  if (audio.source === 'upload') await ctx.storage.remove(ctx.storage.paths.audioDir, audio.file_name);
  await fsp.rm(ctx.storage.peaksFile(audio.id), { force: true });
}

/** Elimina una traccia, le sue versioni separate e i relativi file. */
export async function deleteAudio(ctx: AppContext, audio: AudioRow): Promise<void> {
  const variants = ctx.db.all<AudioRow>('SELECT * FROM audio_tracks WHERE parent_id = ?', audio.id);
  const all = [audio, ...variants];
  ctx.jobs.cancelForAudio(all.map((a) => a.id));
  ctx.db.run('DELETE FROM audio_tracks WHERE id = ?', audio.id);
  for (const a of all) await deleteAudioFiles(ctx, a);
  const ids = all.map((a) => a.id);
  ctx.db.run(
    `UPDATE score_prefs SET prefs = json_remove(prefs, '$.audioId')
     WHERE score_id = ? AND json_extract(prefs, '$.audioId') IN (${ids.map(() => '?').join(', ')})`,
    audio.score_id,
    ...ids,
  );
}

export async function deleteScore(ctx: AppContext, score: ScoreRow): Promise<void> {
  const audio = ctx.db.all<AudioRow>('SELECT * FROM audio_tracks WHERE score_id = ?', score.id);
  ctx.jobs.cancelForAudio(audio.map((a) => a.id));
  ctx.db.run('DELETE FROM scores WHERE id = ?', score.id);
  await ctx.storage.remove(ctx.storage.paths.scoresDir, score.file_name);
  for (const a of audio) await deleteAudioFiles(ctx, a);
}

/** Elimina un utente con tutti i suoi spartiti e file. */
export async function deleteUserWithContent(ctx: AppContext, userId: number): Promise<void> {
  const scores = ctx.db.all<ScoreRow>('SELECT * FROM scores WHERE owner_id = ?', userId);
  for (const s of scores) await deleteScore(ctx, s);
  ctx.db.run('DELETE FROM users WHERE id = ?', userId);
}
