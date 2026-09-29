// Linea temporale dello spartito in ordine di esecuzione (ritornelli espansi) e
// mappa tra tempo dello spartito e tempo della traccia audio tramite sync point.
// La mappatura replica quella di alphaTab: lineare a tratti tra i sync point,
// estrapolata prima del primo e dopo l'ultimo con il rapporto del tratto vicino.
import type { FlatSyncPoint } from '../../../shared/types';

export const TICKS_PER_QUARTER = 960;

export interface TempoPoint {
  tick: number;
  bpm: number;
}

export interface PlaybackBar {
  /** Posizione nell'ordine di esecuzione. */
  order: number;
  /** Indice della battuta nello spartito (0-based). */
  barIndex: number;
  /** Quante volte la battuta è già stata suonata prima di questa (0 = prima volta). */
  occurrence: number;
  startTick: number;
  endTick: number;
  /** Tempo "di spartito" (al 100%, senza sync) in millisecondi. */
  startMs: number;
  endMs: number;
  tempo: TempoPoint[];
}

export interface TickLookupBar {
  start: number;
  end: number;
  masterBar: { index: number };
  tempoChanges: Array<{ tick: number; tempo: number }>;
}

export function ticksToMs(ticks: number, bpm: number): number {
  return (ticks * 60000) / (Math.max(bpm, 1) * TICKS_PER_QUARTER);
}

function msToTicks(ms: number, bpm: number): number {
  return (ms * Math.max(bpm, 1) * TICKS_PER_QUARTER) / 60000;
}

export class Timeline {
  readonly bars: PlaybackBar[];
  private readonly byBar = new Map<number, PlaybackBar[]>();

  constructor(bars: PlaybackBar[]) {
    this.bars = bars;
    for (const bar of bars) {
      const list = this.byBar.get(bar.barIndex) ?? [];
      list.push(bar);
      this.byBar.set(bar.barIndex, list);
    }
  }

  /** Costruisce la timeline dalla tabella dei tick generata da alphaTab (`api.tickCache.masterBars`). */
  static fromTickLookup(masterBars: TickLookupBar[], initialBpm: number): Timeline {
    const bars: PlaybackBar[] = [];
    const occurrences = new Map<number, number>();
    let ms = 0;
    let bpm = initialBpm;
    for (const [order, mb] of masterBars.entries()) {
      const barIndex = mb.masterBar.index;
      const occurrence = occurrences.get(barIndex) ?? 0;
      occurrences.set(barIndex, occurrence + 1);
      const tempo: TempoPoint[] = [];
      const startMs = ms;
      let tick = mb.start;
      for (const change of mb.tempoChanges) {
        if (change.tick > tick) {
          ms += ticksToMs(change.tick - tick, bpm);
          tick = change.tick;
        }
        bpm = change.tempo;
        tempo.push({ tick: change.tick, bpm });
      }
      if (tempo.length === 0 || tempo[0].tick > mb.start) tempo.unshift({ tick: mb.start, bpm: tempo[0]?.bpm ?? bpm });
      ms += ticksToMs(mb.end - tick, bpm);
      bars.push({ order, barIndex, occurrence, startTick: mb.start, endTick: mb.end, startMs, endMs: ms, tempo });
    }
    return new Timeline(bars);
  }

  get endTick(): number {
    return this.bars.length > 0 ? this.bars[this.bars.length - 1].endTick : 0;
  }

  get durationMs(): number {
    return this.bars.length > 0 ? this.bars[this.bars.length - 1].endMs : 0;
  }

  occurrencesOf(barIndex: number): PlaybackBar[] {
    return this.byBar.get(barIndex) ?? [];
  }

  find(barIndex: number, occurrence: number): PlaybackBar | undefined {
    return this.byBar.get(barIndex)?.[occurrence];
  }

  /** Battuta in esecuzione al tick indicato (limitata agli estremi). */
  barAtTick(tick: number): PlaybackBar | null {
    const bars = this.bars;
    if (bars.length === 0) return null;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].startTick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return bars[lo];
  }

  barAtMs(ms: number): PlaybackBar | null {
    const bars = this.bars;
    if (bars.length === 0) return null;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].startMs <= ms) lo = mid;
      else hi = mid - 1;
    }
    return bars[lo];
  }

  tickToMs(tick: number): number {
    const bar = this.barAtTick(tick);
    if (!bar) return 0;
    if (tick <= bar.startTick) return bar.startMs - ticksToMs(bar.startTick - tick, bar.tempo[0].bpm);
    let ms = bar.startMs;
    let pos = bar.startTick;
    for (let i = 0; i < bar.tempo.length; i++) {
      const next = i + 1 < bar.tempo.length ? bar.tempo[i + 1].tick : Infinity;
      const segmentEnd = Math.min(next, tick);
      if (segmentEnd > pos) {
        ms += ticksToMs(segmentEnd - pos, bar.tempo[i].bpm);
        pos = segmentEnd;
      }
      if (pos >= tick) break;
    }
    return ms;
  }

  msToTick(ms: number): number {
    const bar = this.barAtMs(ms);
    if (!bar) return 0;
    if (ms <= bar.startMs) return bar.startTick - msToTicks(bar.startMs - ms, bar.tempo[0].bpm);
    let t = bar.startMs;
    for (let i = 0; i < bar.tempo.length; i++) {
      const from = Math.max(bar.tempo[i].tick, bar.startTick);
      const to = i + 1 < bar.tempo.length ? bar.tempo[i + 1].tick : Infinity;
      const segMs = to === Infinity ? Infinity : ticksToMs(to - from, bar.tempo[i].bpm);
      if (ms <= t + segMs) return from + msToTicks(ms - t, bar.tempo[i].bpm);
      t += segMs;
    }
    return bar.endTick;
  }

  /** Tick assoluto di un punto (battuta, ripetizione, posizione relativa). */
  tickOf(barIndex: number, occurrence: number, position: number): number | null {
    const bar = this.find(barIndex, occurrence);
    if (!bar) return null;
    return bar.startTick + position * (bar.endTick - bar.startTick);
  }

  /** Bpm dello spartito all'inizio della battuta. */
  bpmAt(tick: number): number {
    const bar = this.barAtTick(tick);
    if (!bar) return 120;
    let bpm = bar.tempo[0].bpm;
    for (const t of bar.tempo) if (t.tick <= tick) bpm = t.bpm;
    return bpm;
  }
}

export interface SyncAnchor {
  /** Indice nell'array originale dei sync point. */
  index: number;
  point: FlatSyncPoint;
  bar: PlaybackBar;
  tick: number;
  synthMs: number;
  audioMs: number;
}

export class SyncMap {
  /** Sync point validi, ordinati nell'ordine di esecuzione. */
  readonly anchors: SyncAnchor[] = [];
  /** Indici dei sync point scartati (battuta inesistente o tempi non crescenti). */
  readonly invalid = new Set<number>();

  constructor(
    readonly timeline: Timeline,
    readonly points: FlatSyncPoint[],
  ) {
    const resolved: SyncAnchor[] = [];
    points.forEach((point, index) => {
      const bar = timeline.find(point.barIndex, point.barOccurence);
      if (!bar) {
        this.invalid.add(index);
        return;
      }
      const tick = bar.startTick + point.barPosition * (bar.endTick - bar.startTick);
      resolved.push({ index, point, bar, tick, synthMs: timeline.tickToMs(tick), audioMs: point.millisecondOffset });
    });
    resolved.sort((a, b) => a.synthMs - b.synthMs || a.index - b.index);
    for (const anchor of resolved) {
      const last = this.anchors[this.anchors.length - 1];
      if (last && (anchor.synthMs <= last.synthMs || anchor.audioMs <= last.audioMs)) {
        this.invalid.add(anchor.index);
        continue;
      }
      this.anchors.push(anchor);
    }
  }

  /** Sync point utilizzabili da passare ad alphaTab. */
  validPoints(): FlatSyncPoint[] {
    return this.anchors.map((a) => a.point);
  }

  private segment(key: 'synthMs' | 'audioMs', value: number): [SyncAnchor, SyncAnchor] | null {
    const a = this.anchors;
    if (a.length < 2) return null;
    let i = 0;
    while (i + 2 < a.length && a[i + 1][key] <= value) i++;
    return [a[i], a[i + 1]];
  }

  synthToAudio(synthMs: number): number {
    const a = this.anchors;
    if (a.length === 0) return synthMs;
    if (a.length === 1) return a[0].audioMs + (synthMs - a[0].synthMs);
    const [p, q] = this.segment('synthMs', synthMs)!;
    return p.audioMs + ((synthMs - p.synthMs) * (q.audioMs - p.audioMs)) / (q.synthMs - p.synthMs);
  }

  audioToSynth(audioMs: number): number {
    const a = this.anchors;
    if (a.length === 0) return audioMs;
    if (a.length === 1) return a[0].synthMs + (audioMs - a[0].audioMs);
    const [p, q] = this.segment('audioMs', audioMs)!;
    return p.synthMs + ((audioMs - p.audioMs) * (q.synthMs - p.synthMs)) / (q.audioMs - p.audioMs);
  }

  tickToAudio(tick: number): number {
    return this.synthToAudio(this.timeline.tickToMs(tick));
  }

  audioToTick(audioMs: number): number {
    return this.timeline.msToTick(this.audioToSynth(audioMs));
  }

  /**
   * Tempo effettivo della registrazione (bpm) nel tratto che inizia dal sync point `i`
   * (in `anchors`): utile per scovare tap sbagliati.
   */
  segmentBpm(i: number): number | null {
    const a = this.anchors;
    const p = a[i];
    const q = a[i + 1] ?? a[i - 1];
    if (!p || !q || q === p) return null;
    const [from, to] = q.synthMs > p.synthMs ? [p, q] : [q, p];
    const ratio = (to.synthMs - from.synthMs) / (to.audioMs - from.audioMs);
    return this.timeline.bpmAt(p.tick) * ratio;
  }
}
