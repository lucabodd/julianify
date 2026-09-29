// Funzioni di supporto sul modello dati di alphaTab (solo tipi: nessun import a runtime).
import type * as alphaTab from '@coderline/alphatab';
import { keyFromSignature, type KeyInfo, type PitchWeight } from './harmony';

type Score = alphaTab.model.Score;
type Beat = alphaTab.model.Beat;

export interface ScorePosition {
  barIndex: number;
  /** Posizione relativa nella battuta (0..1). */
  position: number;
}

export function barDuration(score: Score, barIndex: number): number {
  return score.masterBars[barIndex]?.calculateDuration() ?? 3840;
}

export function beatPosition(beat: Beat): ScorePosition {
  const barIndex = beat.voice.bar.index;
  const duration = beat.voice.bar.masterBar.calculateDuration();
  return { barIndex, position: duration > 0 ? Math.min(1, Math.max(0, beat.playbackStart / duration)) : 0 };
}

export function comparePositions(a: ScorePosition, b: ScorePosition): number {
  return a.barIndex - b.barIndex || a.position - b.position;
}

/** Etichetta leggibile: "Batt. 12", "Batt. 12 · 3° mov.". */
export function positionLabel(score: Score | null, pos: ScorePosition): string {
  let label = `Batt. ${pos.barIndex + 1}`;
  if (score && pos.position > 0.001) {
    const mb = score.masterBars[pos.barIndex];
    if (mb) {
      const beats = beatsPerBar(mb);
      const beat = pos.position * beats;
      label += Math.abs(beat - Math.round(beat)) < 0.02 ? ` · ${Math.round(beat) + 1}° mov.` : ` · ${(beat + 1).toFixed(1)}`;
    }
  }
  return label;
}

/** Numero di movimenti per battuta (i tempi composti contano a gruppi di tre). */
export function beatsPerBar(masterBar: alphaTab.model.MasterBar): number {
  const num = masterBar.timeSignatureNumerator;
  const den = masterBar.timeSignatureDenominator;
  if (den >= 8 && num > 3 && num % 3 === 0) return num / 3;
  return num;
}

function isPercussionTrack(track: alphaTab.model.Track): boolean {
  return track.isPercussion || track.staves.every((s) => s.isPercussion);
}

/**
 * Note suonate (da tutte le tracce non percussive) nella battuta indicata tra le
 * posizioni relative `from` e `to`, pesate per la durata effettiva nella finestra.
 */
export function collectNotes(score: Score, barIndex: number, from: number, to: number, trackIndexes?: number[]): PitchWeight[] {
  const duration = barDuration(score, barIndex);
  const start = from * duration;
  const end = Math.max(start + 1, to * duration);
  const result: PitchWeight[] = [];
  for (const track of score.tracks) {
    if (isPercussionTrack(track)) continue;
    if (trackIndexes && !trackIndexes.includes(track.index)) continue;
    for (const staff of track.staves) {
      const bar = staff.bars[barIndex];
      if (!bar) continue;
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          if (beat.isRest || beat.notes.length === 0) continue;
          const bs = beat.playbackStart;
          const be = bs + beat.playbackDuration;
          const overlap = Math.min(be, end) - Math.max(bs, start);
          if (overlap <= 0) continue;
          for (const note of beat.notes) {
            if (note.isDead) continue;
            result.push({ midi: note.realValue, weight: overlap });
          }
        }
      }
    }
  }
  return result;
}

/** Note (MIDI) di un singolo beat, per descriverne il voicing. */
export function beatNotes(beat: Beat): number[] {
  return beat.notes.filter((n) => !n.isDead).map((n) => n.realValue);
}

/** Tonalità indicata dall'armatura di chiave (prima traccia non percussiva). */
export function keyAtBar(score: Score, barIndex: number): KeyInfo {
  const track = score.tracks.find((t) => !isPercussionTrack(t)) ?? score.tracks[0];
  const bar = track?.staves[0]?.bars[barIndex];
  const signature = bar ? Number(bar.keySignature) : 0;
  const minor = bar ? Number(bar.keySignatureType) === 1 : false;
  return keyFromSignature(signature, minor);
}

/** Istogramma delle durate per classe di altezza (per stimare la tonalità). */
export function pitchHistogram(score: Score, fromBar = 0, toBar = score.masterBars.length - 1): number[] {
  const histogram = new Array<number>(12).fill(0);
  for (let barIndex = fromBar; barIndex <= toBar; barIndex++) {
    for (const n of collectNotes(score, barIndex, 0, 1)) histogram[((n.midi % 12) + 12) % 12] += n.weight;
  }
  return histogram;
}

export interface ScoreChordName extends ScorePosition {
  name: string;
}

/** Sigle già presenti nello spartito (diagrammi/sigle di Guitar Pro, <harmony> di MusicXML). */
export function scoreChordNames(score: Score): ScoreChordName[] {
  const seen = new Map<string, ScoreChordName>();
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            const name = beat.chord?.name?.trim();
            if (!name) continue;
            const pos = beatPosition(beat);
            const key = `${pos.barIndex}:${pos.position.toFixed(4)}`;
            if (!seen.has(key)) seen.set(key, { ...pos, name });
          }
        }
      }
    }
  }
  return [...seen.values()].sort(comparePositions);
}

/**
 * Posizioni candidate per il riconoscimento automatico degli accordi: una per
 * battuta, due per battuta o una per movimento.
 */
export function detectionSlots(score: Score, granularity: 'bar' | 'half' | 'beat', fromBar = 0, toBar = score.masterBars.length - 1): Array<ScorePosition & { to: number }> {
  const slots: Array<ScorePosition & { to: number }> = [];
  for (let barIndex = fromBar; barIndex <= toBar; barIndex++) {
    const mb = score.masterBars[barIndex];
    if (!mb) continue;
    const parts = granularity === 'bar' ? 1 : granularity === 'half' ? (beatsPerBar(mb) % 2 === 0 ? 2 : 1) : beatsPerBar(mb);
    for (let i = 0; i < parts; i++) slots.push({ barIndex, position: i / parts, to: (i + 1) / parts });
  }
  return slots;
}
