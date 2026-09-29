import { useMemo } from 'react';
import type * as alphaTab from '@coderline/alphatab';
import type { Annotation } from '../../../shared/types';
import type { AnalysisModel, AnalyzedChord } from './analysis';
import type { PlayerController } from './controller';
import { formatKey, noteFunction, parseKey, prettyAccidentals } from './harmony';
import type { ScorePosition } from './scoreTools';

export interface LayerOptions {
  chords: boolean;
  analysis: boolean;
  sections: boolean;
  intervals: boolean;
  intervalTrack: number | null;
}

/** Spazio (px) da riservare sopra e sotto ogni sistema per i livelli attivi. */
export function layerPadding(layers: LayerOptions): { top: number; bottom: number } {
  return {
    top: 10 + (layers.sections ? 20 : 0) + (layers.chords ? 22 : 0),
    bottom: 8 + (layers.analysis ? 22 : 0) + (layers.intervals ? 18 : 0),
  };
}

interface Label {
  key: string;
  x: number;
  y: number;
  text: string;
  className: string;
  title?: string;
  annotation?: Annotation;
}

interface Shape {
  key: string;
  d: string;
  className: string;
  marker?: boolean;
}

interface LayerProps {
  controller: PlayerController;
  renderVersion: number;
  annotations: Annotation[];
  model: AnalysisModel;
  layers: LayerOptions;
  selection: ScorePosition | null;
  onSelectAnnotation: (annotation: Annotation) => void;
}

const CHAR_W = 7.2;

type Lookup = alphaTab.rendering.BoundsLookup;
type MasterBarBounds = alphaTab.rendering.MasterBarBounds;

function locate(lookup: Lookup, score: alphaTab.model.Score, pos: ScorePosition): { x: number; mbb: MasterBarBounds } | null {
  const mbb = lookup.findMasterBarByIndex(pos.barIndex);
  if (!mbb) return null;
  const masterBar = score.masterBars[pos.barIndex];
  const duration = masterBar ? masterBar.calculateDuration() : 1;
  const tick = pos.position * duration;
  const barStartX = mbb.visualBounds.x;
  const barEndX = mbb.visualBounds.x + mbb.visualBounds.w;
  const beats = (mbb.bars[0]?.beats ?? [])
    .map((b) => ({ start: b.beat.playbackStart, x: b.onNotesX }))
    .sort((a, b) => a.start - b.start)
    .filter((b, i, arr) => i === 0 || b.start !== arr[i - 1].start);
  if (beats.length === 0) return { x: barStartX + pos.position * mbb.visualBounds.w, mbb };
  let prev = { start: 0, x: Math.min(beats[0].x, barStartX + 8) };
  if (beats[0].start === 0) prev = beats[0];
  let next: { start: number; x: number } | null = null;
  for (const b of beats) {
    if (b.start <= tick) prev = b;
    else {
      next = b;
      break;
    }
  }
  const end = next ?? { start: duration, x: barEndX - 6 };
  const span = end.start - prev.start;
  const x = span > 0 ? prev.x + ((tick - prev.start) / span) * (end.x - prev.x) : prev.x;
  return { x, mbb };
}

const CATEGORY_TITLES: Record<string, string> = {
  diatonic: 'Diatonico',
  secondary: 'Dominante secondaria',
  substitute: 'Sostituto di tritono',
  'related-ii': 'ii correlato',
  backdoor: 'Dominante backdoor',
  interchange: 'Interscambio modale',
  passing: 'Diminuito di passaggio',
  chromatic: 'Cromatico',
};

function chordTitle(c: AnalyzedChord): string {
  const parts = [c.annotation.text];
  if (c.roman) parts.push(`${c.roman} in ${formatKey(c.key)}`);
  if (c.analysis) {
    parts.push(CATEGORY_TITLES[c.analysis.category] ?? '');
    if (c.analysis.scale) parts.push(`Scala: ${c.analysis.scale}`);
  }
  return parts.filter(Boolean).join(' — ');
}

/**
 * Livello sovrapposto allo spartito con sigle, sezioni, tonalità e note (sopra ogni
 * sistema), gradi romani con parentesi ii-V e frecce di risoluzione (sotto) e,
 * se attivo, l'intervallo di ogni nota della melodia rispetto all'accordo.
 */
export function AnnotationLayer({ controller, renderVersion, annotations, model, layers, selection, onSelectAnnotation }: LayerProps) {
  const { labels, shapes, marker } = useMemo(() => {
    const labels: Label[] = [];
    const shapes: Shape[] = [];
    let marker: { x: number; y: number; h: number } | null = null;
    const lookup = controller.api.boundsLookup;
    const score = controller.score;
    if (!lookup || !score || renderVersion === 0) return { labels, shapes, marker };

    const pad = layerPadding(layers);
    const sectionRow = (sysY: number) => sysY - pad.top + 3;
    const chordRow = (sysY: number) => sysY - (layers.chords ? 22 : 0) - 2;
    const romanRow = (sysY: number, sysH: number) => sysY + sysH + 4;
    const intervalRow = (sysY: number, sysH: number) => sysY + sysH + 4 + (layers.analysis ? 22 : 0);

    // Sezioni, tonalità e appunti (riga superiore).
    if (layers.sections) {
      for (const a of annotations) {
        if (a.kind === 'chord') continue;
        const loc = locate(lookup, score, a);
        if (!loc?.mbb.staffSystemBounds) continue;
        const sys = loc.mbb.staffSystemBounds.visualBounds;
        let text = a.text;
        let className = `ann ann-${a.kind}`;
        if (a.kind === 'key') {
          const key = parseKey(a.text);
          text = key ? `⚷ ${formatKey(key)}` : a.text;
        } else if (a.kind === 'note') {
          text = `✎ ${a.text.length > 28 ? `${a.text.slice(0, 27)}…` : a.text}`;
          className += ' ann-note';
        }
        labels.push({ key: `a${a.id}`, x: loc.x, y: sectionRow(sys.y), text, className, title: a.text, annotation: a });
      }
    }

    // Sigle e gradi.
    const placed: Array<{ chord: AnalyzedChord; x: number; sysIndex: number; sysY: number; sysH: number; sysRight: number; romanW: number }> = [];
    for (const chord of model.chords) {
      const loc = locate(lookup, score, chord.annotation);
      if (!loc?.mbb.staffSystemBounds) continue;
      const sysBounds = loc.mbb.staffSystemBounds;
      const sys = sysBounds.visualBounds;
      const category = chord.analysis?.category ?? 'none';
      if (layers.chords) {
        labels.push({
          key: `c${chord.annotation.id}`,
          x: loc.x,
          y: chordRow(sys.y),
          text: prettyAccidentals(chord.annotation.text),
          className: 'ann ann-chord',
          title: chordTitle(chord),
          annotation: chord.annotation,
        });
      }
      if (layers.analysis && chord.roman) {
        labels.push({
          key: `r${chord.annotation.id}`,
          x: loc.x,
          y: romanRow(sys.y, sys.h),
          text: chord.roman,
          className: `ann ann-roman cat-${chord.annotation.analysis ? 'manual' : category}`,
          title: chordTitle(chord),
          annotation: chord.annotation,
        });
      }
      placed.push({
        chord,
        x: loc.x,
        sysIndex: sysBounds.index,
        sysY: sys.y,
        sysH: sys.h,
        sysRight: sys.x + sys.w,
        romanW: (chord.roman?.length ?? 0) * CHAR_W,
      });
    }

    // Parentesi ii-V e frecce di risoluzione sotto i gradi.
    if (layers.analysis) {
      for (let i = 0; i < placed.length; i++) {
        const a = placed[i];
        const b = placed[i + 1];
        const analysis = a.chord.analysis;
        if (!analysis) continue;
        const y = romanRow(a.sysY, a.sysH) + 17;
        if (analysis.iiV && b && b.sysIndex === a.sysIndex) {
          const x2 = b.x + Math.max(b.romanW, 14);
          shapes.push({
            key: `b${a.chord.annotation.id}`,
            d: `M ${a.x} ${y - 3} V ${y} H ${x2} V ${y - 3}`,
            className: analysis.iiV === 'iiSubV' ? 'ann-bracket dashed' : 'ann-bracket',
          });
        }
        if (analysis.resolution) {
          const ay = romanRow(a.sysY, a.sysH) + 8;
          const x1 = a.x + a.romanW + 2;
          const sameSystem = b && b.sysIndex === a.sysIndex;
          const x2 = sameSystem ? b.x - 3 : Math.min(a.sysRight, x1 + 16);
          if (x2 > x1 + 4) {
            shapes.push({
              key: `r${a.chord.annotation.id}`,
              d: `M ${x1} ${ay} C ${x1 + (x2 - x1) * 0.35} ${ay - 7}, ${x2 - (x2 - x1) * 0.35} ${ay - 7}, ${x2} ${ay}`,
              className: analysis.resolution === 'halfstep' ? 'ann-arrow dashed' : 'ann-arrow',
              marker: true,
            });
          }
        }
      }
    }

    // Intervalli della melodia rispetto all'accordo attivo.
    if (layers.intervals && layers.intervalTrack !== null && model.chords.length > 0) {
      for (const system of lookup.staffSystems) {
        const sys = system.visualBounds;
        for (const mbb of system.bars) {
          // Con il layout nel worker i BarBounds non hanno "bar": si risale dai beat.
          const barBounds = mbb.bars.find((b) => {
            const staff = b.beats[0]?.beat.voice.bar.staff;
            return staff?.track.index === layers.intervalTrack && staff.index === 0;
          });
          if (!barBounds) continue;
          const masterBar = score.masterBars[mbb.index];
          const duration = masterBar?.calculateDuration() ?? 1;
          let lastX = -Infinity;
          for (const bb of barBounds.beats) {
            const beat = bb.beat;
            if (beat.isRest || beat.notes.length === 0) continue;
            const pitches = beat.notes.filter((n) => !n.isDead).map((n) => n.realValue);
            if (pitches.length === 0) continue;
            const pos = { barIndex: mbb.index, position: beat.playbackStart / duration };
            const chord = model.chordAt(pos);
            if (!chord?.parsed) continue;
            const top = Math.max(...pitches);
            const fn = noteFunction(top, chord.parsed);
            if (bb.onNotesX - lastX < 12) continue; // evita sovrapposizioni con note molto fitte
            lastX = bb.onNotesX;
            const all = [...new Set(pitches)]
              .sort((x, y) => y - x)
              .map((p) => noteFunction(p, chord.parsed!).label)
              .join(' ');
            labels.push({
              key: `i${mbb.index}-${beat.id}`,
              x: bb.onNotesX,
              y: intervalRow(sys.y, sys.h),
              text: fn.label,
              className: `ann ann-interval fn-${fn.kind}`,
              title: `${prettyAccidentals(chord.annotation.text)}: ${all}`,
            });
          }
        }
      }
    }

    if (selection) {
      const loc = locate(lookup, score, selection);
      if (loc?.mbb.staffSystemBounds) {
        const sys = loc.mbb.staffSystemBounds.visualBounds;
        marker = { x: loc.x, y: sys.y - 4, h: sys.h + 8 };
      }
    }

    // Evita che le etichette sulla stessa riga si sovrappongano.
    const rows = new Map<number, Label[]>();
    for (const l of labels) {
      if (l.className.includes('ann-interval')) continue;
      const row = rows.get(Math.round(l.y)) ?? [];
      row.push(l);
      rows.set(Math.round(l.y), row);
    }
    for (const row of rows.values()) {
      row.sort((a, b) => a.x - b.x);
      let right = -Infinity;
      for (const l of row) {
        if (l.x < right + 4) l.x = right + 4;
        right = l.x + l.text.length * CHAR_W;
      }
    }

    return { labels, shapes, marker };
  }, [controller, renderVersion, annotations, model, layers, selection]);

  return (
    <div className="ann-layer" aria-hidden={labels.length === 0}>
      <svg className="ann-svg">
        <defs>
          <marker id="ann-arrowhead" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" className="ann-arrowhead" />
          </marker>
        </defs>
        {shapes.map((s) => (
          <path key={s.key} d={s.d} className={s.className} markerEnd={s.marker ? 'url(#ann-arrowhead)' : undefined} />
        ))}
      </svg>
      {marker && <div className="selection-marker" style={{ left: marker.x, top: marker.y, height: marker.h }} />}
      {labels.map((l) =>
        l.annotation ? (
          <button
            key={l.key}
            type="button"
            className={l.className}
            style={{ left: l.x, top: l.y }}
            title={l.title}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelectAnnotation(l.annotation!);
            }}
          >
            {l.text}
          </button>
        ) : (
          <span key={l.key} className={l.className} style={{ left: l.x, top: l.y }} title={l.title}>
            {l.text}
          </span>
        ),
      )}
    </div>
  );
}
