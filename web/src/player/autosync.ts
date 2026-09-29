// Sincronizzazione automatica: dalle note dello spartito (in ordine di
// esecuzione, al tempo scritto) ai dati per il worker di allineamento, e dal
// risultato del worker ai sync point.
import type * as alphaTab from '@coderline/alphatab';
import type { AutoSyncGranularity, AutoSyncJobParams, AutoSyncRequest, FlatSyncPoint } from '../../../shared/types';
import { isPercussionTrack } from './scoreTools';
import { TICKS_PER_QUARTER, type SyncMap, type Timeline } from './timeline';

type Score = alphaTab.model.Score;
type Note = alphaTab.model.Note;

export interface AutoSyncOptions {
  granularity: AutoSyncGranularity;
  /**
   * Prima e ultima battuta (ordine di esecuzione) di cui calcolare i sync point.
   * L'allineamento usa comunque tutto lo spartito: è il modo più robusto per
   * collocare anche un tratto in mezzo al brano.
   */
  fromOrder: number;
  toOrder: number;
  /** Sync point esistenti da rispettare come ancore. */
  anchors?: SyncMap | null;
}


const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Tick aggiuntivi delle note legate alla nota indicata. */
function tiedTicks(note: Note): number {
  let extra = 0;
  let current: Note | null = note;
  for (let guard = 0; guard < 32 && current?.tieDestination; guard++) {
    current = current.tieDestination;
    extra += current.beat.playbackDuration;
  }
  return extra;
}

/** Movimenti effettivi della battuta (le battute incomplete, es. in levare, ne hanno meno). */
function beatDivisions(masterBar: alphaTab.model.MasterBar | undefined, barTicks: number): number {
  if (!masterBar) return 1;
  const num = masterBar.timeSignatureNumerator;
  const den = masterBar.timeSignatureDenominator;
  const compound = den >= 8 && num > 3 && num % 3 === 0;
  const beatTicks = ((TICKS_PER_QUARTER * 4) / den) * (compound ? 3 : 1);
  return Math.max(1, Math.round(barTicks / beatTicks));
}

/** Dati per il worker: note di tutto il brano e punti del tratto scelto, in secondi al tempo scritto. */
export function buildAutoSyncRequest(score: Score, timeline: Timeline, options: AutoSyncOptions): AutoSyncRequest {
  const bars = timeline.bars;
  if (bars.length === 0) throw new Error('Spartito vuoto');
  const fromOrder = Math.min(Math.max(0, options.fromOrder), bars.length - 1);
  const toOrder = Math.min(Math.max(fromOrder, options.toOrder), bars.length - 1);
  const originMs = bars[0].startMs;
  const seconds = (tick: number) => (timeline.tickToMs(tick) - originMs) / 1000;
  const scoreDuration = (bars[bars.length - 1].endMs - originMs) / 1000;

  const notes: AutoSyncRequest['notes'] = [];
  const tracks = score.tracks.filter((t) => !isPercussionTrack(t));
  for (let order = 0; order < bars.length; order++) {
    const played = bars[order];
    for (const track of tracks) {
      for (const staff of track.staves) {
        if (staff.isPercussion) continue;
        const bar = staff.bars[played.barIndex];
        if (!bar) continue;
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            if (beat.isRest || beat.notes.length === 0) continue;
            const startTick = played.startTick + beat.playbackStart;
            const start = seconds(startTick);
            for (const note of beat.notes) {
              if (note.isDead || note.isTieDestination || note.isPercussion) continue;
              const end = Math.min(seconds(startTick + beat.playbackDuration + tiedTicks(note)), scoreDuration);
              if (end <= start) continue;
              notes.push([round3(start), round3(end - start), note.realValue, note.isGhost ? 45 : 90]);
            }
          }
        }
      }
    }
  }

  const points: AutoSyncRequest['points'] = [];
  const targets: number[] = [];
  for (let order = fromOrder; order <= toOrder; order++) {
    const played = bars[order];
    const barTicks = played.endTick - played.startTick;
    const divisions = options.granularity === 'beat' ? beatDivisions(score.masterBars[played.barIndex], barTicks) : 1;
    for (let k = 0; k < divisions; k++) {
      const position = k / divisions;
      points.push([played.barIndex, played.occurrence, position]);
      targets.push(round3(seconds(played.startTick + position * barTicks)));
    }
  }
  // la fine del tratto è l'inizio della battuta successiva, se esiste
  const after = bars[toOrder + 1];
  if (after) {
    points.push([after.barIndex, after.occurrence, 0]);
    targets.push(round3(seconds(after.startTick)));
  }

  const anchors: AutoSyncRequest['anchors'] = (options.anchors?.anchors ?? []).map((anchor) => [
    Math.round(anchor.audioMs),
    round3((anchor.synthMs - originMs) / 1000),
  ]);

  return {
    notes,
    targets,
    points,
    scoreDuration: round3(scoreDuration),
    anchors,
    fromOrder,
    toOrder,
    granularity: options.granularity,
  };
}

/**
 * Sync point risultanti: quelli già presenti fuori dal tratto allineato restano,
 * quelli dentro vengono sostituiti dai punti calcolati.
 */
export function mergeAutoSync(
  existing: FlatSyncPoint[],
  timeline: Timeline,
  plan: Pick<AutoSyncJobParams, 'points' | 'fromOrder' | 'toOrder'>,
  times: number[],
): FlatSyncPoint[] {
  const end = plan.points[plan.points.length - 1];
  const endOrder = end ? timeline.find(end[0], end[1])?.order : undefined;
  const kept = existing.filter((p) => {
    const bar = timeline.find(p.barIndex, p.barOccurence);
    if (!bar) return false;
    if (bar.order >= plan.fromOrder && bar.order <= plan.toOrder) return false;
    return !(endOrder !== undefined && bar.order === endOrder && endOrder > plan.toOrder && p.barPosition === 0);
  });
  const computed: FlatSyncPoint[] = [];
  let previous = -Infinity;
  plan.points.forEach(([barIndex, occurrence, position], i) => {
    const ms = Math.round(times[i]);
    if (!Number.isFinite(ms) || ms <= previous) return;
    previous = ms;
    computed.push({ barIndex, barOccurence: occurrence, barPosition: position, millisecondOffset: ms });
  });
  const order = (p: FlatSyncPoint) => (timeline.find(p.barIndex, p.barOccurence)?.order ?? 0) + p.barPosition;
  return [...kept, ...computed].sort((a, b) => order(a) - order(b));
}

/** Chiave di un punto (battuta, ripetizione, posizione) per confronti e insiemi. */
export function pointKey(barIndex: number, occurrence: number, position: number): string {
  return `${barIndex}:${occurrence}:${position.toFixed(4)}`;
}
