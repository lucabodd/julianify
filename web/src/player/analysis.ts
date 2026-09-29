// Modello di analisi dello spartito: unisce le note dell'utente (sigle, tonalità,
// sezioni) con l'armatura di chiave e calcola i gradi funzionali di ogni accordo.
import type * as alphaTab from '@coderline/alphatab';
import type { Annotation } from '../../../shared/types';
import {
  analyzeProgression,
  keyUsesFlats,
  parseChord,
  parseKey,
  type ChordAnalysis,
  type KeyInfo,
  type ParsedChord,
} from './harmony';
import { comparePositions, keyAtBar, type ScorePosition } from './scoreTools';

export interface AnalyzedChord {
  annotation: Annotation;
  parsed: ParsedChord | null;
  key: KeyInfo;
  analysis: ChordAnalysis | null;
  /** Grado mostrato: quello scritto a mano dall'utente o quello calcolato. */
  roman: string | null;
}

export interface AnalysisModel {
  chords: AnalyzedChord[];
  keyAt: (pos: ScorePosition) => KeyInfo;
  chordAt: (pos: ScorePosition) => AnalyzedChord | null;
  flatsAt: (pos: ScorePosition) => boolean;
}

const DEFAULT_KEY: KeyInfo = { tonic: 0, mode: 'major' };

function lastAtOrBefore<T>(list: T[], pos: ScorePosition, positionOf: (item: T) => ScorePosition): T | null {
  let lo = 0;
  let hi = list.length - 1;
  let found: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = list[mid];
    if (comparePositions(positionOf(item), pos) <= 1e-9) {
      found = item;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function buildAnalysis(score: alphaTab.model.Score | null, annotations: Annotation[]): AnalysisModel {
  const sorted = [...annotations].sort((a, b) => comparePositions(a, b) || a.id - b.id);
  const keys = sorted.filter((a) => a.kind === 'key' && parseKey(a.text));
  const keyAt = (pos: ScorePosition): KeyInfo => {
    const k = lastAtOrBefore(keys, pos, (a) => a);
    if (k) return parseKey(k.text)!;
    return score ? keyAtBar(score, Math.min(pos.barIndex, score.masterBars.length - 1)) : DEFAULT_KEY;
  };

  const chordAnnotations = sorted.filter((a) => a.kind === 'chord');
  const items = chordAnnotations.map((a) => ({ symbol: a.text, key: keyAt(a) }));
  const analyses = analyzeProgression(items);
  const chords: AnalyzedChord[] = chordAnnotations.map((annotation, i) => ({
    annotation,
    parsed: parseChord(annotation.text),
    key: items[i].key,
    analysis: analyses[i],
    roman: annotation.analysis?.trim() || analyses[i]?.roman || null,
  }));

  return {
    chords,
    keyAt,
    chordAt: (pos) => lastAtOrBefore(chords, pos, (c) => c.annotation),
    flatsAt: (pos) => keyUsesFlats(keyAt(pos)),
  };
}
