import type { FastifyInstance } from 'fastify';
import type { Annotation, AnnotationKind, SavedLoop } from '../../../shared/types.js';
import { getVisibleScore } from '../content.js';
import type { AppContext } from '../context.js';
import {
  badRequest,
  body,
  finiteNumber,
  integer,
  notFound,
  optionalString,
  parseId,
  requireUser,
  requiredString,
} from '../http.js';

const KINDS: AnnotationKind[] = ['chord', 'section', 'key', 'note'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

interface AnnotationRow {
  id: number;
  score_id: number;
  user_id: number;
  bar_index: number;
  position: number;
  kind: AnnotationKind;
  text: string;
  analysis: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

interface LoopRow {
  id: number;
  score_id: number;
  user_id: number;
  name: string;
  start_tick: number;
  end_tick: number;
  start_bar: number;
  end_bar: number;
  speed: number;
  created_at: string;
}

function toAnnotation(row: AnnotationRow): Annotation {
  return {
    id: row.id,
    scoreId: row.score_id,
    barIndex: row.bar_index,
    position: row.position,
    kind: row.kind,
    text: row.text,
    analysis: row.analysis,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLoop(row: LoopRow): SavedLoop {
  return {
    id: row.id,
    scoreId: row.score_id,
    name: row.name,
    startTick: row.start_tick,
    endTick: row.end_tick,
    startBar: row.start_bar,
    endBar: row.end_bar,
    speed: row.speed,
    createdAt: row.created_at,
  };
}

function parseColor(value: unknown): string | null | undefined {
  const color = optionalString(value, 'color', 7);
  if (color && !COLOR_RE.test(color)) throw badRequest('Colore non valido');
  return color;
}

function parseKind(value: unknown): AnnotationKind {
  if (!KINDS.includes(value as AnnotationKind)) throw badRequest('Tipo di nota non valido');
  return value as AnnotationKind;
}

/** Note di analisi armonica e loop salvati: sono personali (per utente e spartito). */
export function registerNotesRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/scores/:id/annotations', async (request) => {
    const user = requireUser(request);
    const score = getVisibleScore(ctx, user, parseId((request.params as { id: string }).id));
    const rows = ctx.db.all<AnnotationRow>(
      'SELECT * FROM annotations WHERE score_id = ? AND user_id = ? ORDER BY bar_index, position, id',
      score.id,
      user.id,
    );
    return { annotations: rows.map(toAnnotation) };
  });

  app.post('/api/scores/:id/annotations', async (request) => {
    const user = requireUser(request);
    const score = getVisibleScore(ctx, user, parseId((request.params as { id: string }).id));
    const data = body(request);
    const { lastInsertRowid } = ctx.db.run(
      `INSERT INTO annotations (score_id, user_id, bar_index, position, kind, text, analysis, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      score.id,
      user.id,
      integer(data.barIndex, 'barIndex', 0, 100_000),
      finiteNumber(data.position ?? 0, 'position', 0, 1),
      parseKind(data.kind),
      requiredString(data.text, 'text', 2000),
      optionalString(data.analysis, 'analysis', 100) ?? null,
      parseColor(data.color) ?? null,
    );
    return { annotation: toAnnotation(ctx.db.get<AnnotationRow>('SELECT * FROM annotations WHERE id = ?', lastInsertRowid)!) };
  });

  app.patch('/api/annotations/:id', async (request) => {
    const user = requireUser(request);
    const id = parseId((request.params as { id: string }).id);
    const row = ctx.db.get<AnnotationRow>('SELECT * FROM annotations WHERE id = ? AND user_id = ?', id, user.id);
    if (!row) throw notFound('Nota non trovata');
    const data = body(request);
    const text = data.text === undefined ? row.text : requiredString(data.text, 'text', 2000);
    const analysis = optionalString(data.analysis, 'analysis', 100);
    const color = parseColor(data.color);
    ctx.db.run(
      `UPDATE annotations SET bar_index = ?, position = ?, kind = ?, text = ?, analysis = ?, color = ?, updated_at = ?
       WHERE id = ?`,
      data.barIndex === undefined ? row.bar_index : integer(data.barIndex, 'barIndex', 0, 100_000),
      data.position === undefined ? row.position : finiteNumber(data.position, 'position', 0, 1),
      data.kind === undefined ? row.kind : parseKind(data.kind),
      text,
      analysis === undefined ? row.analysis : analysis,
      color === undefined ? row.color : color,
      new Date().toISOString(),
      id,
    );
    return { annotation: toAnnotation(ctx.db.get<AnnotationRow>('SELECT * FROM annotations WHERE id = ?', id)!) };
  });

  app.delete('/api/annotations/:id', async (request) => {
    const user = requireUser(request);
    const id = parseId((request.params as { id: string }).id);
    const { changes } = ctx.db.run('DELETE FROM annotations WHERE id = ? AND user_id = ?', id, user.id);
    if (changes === 0) throw notFound('Nota non trovata');
    return { ok: true };
  });

  app.get('/api/scores/:id/loops', async (request) => {
    const user = requireUser(request);
    const score = getVisibleScore(ctx, user, parseId((request.params as { id: string }).id));
    const rows = ctx.db.all<LoopRow>(
      'SELECT * FROM loops WHERE score_id = ? AND user_id = ? ORDER BY start_tick, id',
      score.id,
      user.id,
    );
    return { loops: rows.map(toLoop) };
  });

  app.post('/api/scores/:id/loops', async (request) => {
    const user = requireUser(request);
    const score = getVisibleScore(ctx, user, parseId((request.params as { id: string }).id));
    const data = body(request);
    const startTick = integer(data.startTick, 'startTick', 0);
    const endTick = integer(data.endTick, 'endTick', 1);
    if (endTick <= startTick) throw badRequest('La fine del loop deve seguire l\'inizio');
    const { lastInsertRowid } = ctx.db.run(
      `INSERT INTO loops (score_id, user_id, name, start_tick, end_tick, start_bar, end_bar, speed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      score.id,
      user.id,
      requiredString(data.name, 'name', 100),
      startTick,
      endTick,
      integer(data.startBar, 'startBar', 0),
      integer(data.endBar, 'endBar', 0),
      finiteNumber(data.speed ?? 1, 'speed', 0.1, 4),
    );
    return { loop: toLoop(ctx.db.get<LoopRow>('SELECT * FROM loops WHERE id = ?', lastInsertRowid)!) };
  });

  app.patch('/api/loops/:id', async (request) => {
    const user = requireUser(request);
    const id = parseId((request.params as { id: string }).id);
    const row = ctx.db.get<LoopRow>('SELECT * FROM loops WHERE id = ? AND user_id = ?', id, user.id);
    if (!row) throw notFound('Loop non trovato');
    const data = body(request);
    const startTick = data.startTick === undefined ? row.start_tick : integer(data.startTick, 'startTick', 0);
    const endTick = data.endTick === undefined ? row.end_tick : integer(data.endTick, 'endTick', 1);
    if (endTick <= startTick) throw badRequest('La fine del loop deve seguire l\'inizio');
    ctx.db.run(
      `UPDATE loops SET name = ?, start_tick = ?, end_tick = ?, start_bar = ?, end_bar = ?, speed = ? WHERE id = ?`,
      data.name === undefined ? row.name : requiredString(data.name, 'name', 100),
      startTick,
      endTick,
      data.startBar === undefined ? row.start_bar : integer(data.startBar, 'startBar', 0),
      data.endBar === undefined ? row.end_bar : integer(data.endBar, 'endBar', 0),
      data.speed === undefined ? row.speed : finiteNumber(data.speed, 'speed', 0.1, 4),
      id,
    );
    return { loop: toLoop(ctx.db.get<LoopRow>('SELECT * FROM loops WHERE id = ?', id)!) };
  });

  app.delete('/api/loops/:id', async (request) => {
    const user = requireUser(request);
    const id = parseId((request.params as { id: string }).id);
    const { changes } = ctx.db.run('DELETE FROM loops WHERE id = ? AND user_id = ?', id, user.id);
    if (changes === 0) throw notFound('Loop non trovato');
    return { ok: true };
  });
}
