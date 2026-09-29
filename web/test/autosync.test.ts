import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as alphaTab from '@coderline/alphatab';
import type { FlatSyncPoint } from '../../shared/types';
import { buildAutoSyncRequest, mergeAutoSync } from '../src/player/autosync';
import { SyncMap, Timeline, type TickLookupBar } from '../src/player/timeline';

/** Spartito di esempio (12 battute, ritornello sulle battute 5-8, 100 bpm) e sua timeline. */
function load() {
  const settings = new alphaTab.Settings();
  const file = path.join(import.meta.dirname, '../../samples/progressione-jazz.gp3');
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(file)), settings);
  const midi = new alphaTab.midi.MidiFile();
  const generator = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(midi));
  generator.generate();
  const timeline = Timeline.fromTickLookup(generator.tickLookup.masterBars as unknown as TickLookupBar[], score.tempo);
  return { score, timeline };
}

describe('Sincronizzazione automatica: dati per il worker', () => {
  const { score, timeline } = load();
  const all = { fromOrder: 0, toOrder: timeline.bars.length - 1 };

  it("prepara note e punti di tutto il brano nell'ordine di esecuzione", () => {
    const request = buildAutoSyncRequest(score, timeline, { granularity: 'bar', ...all });
    assert.equal(timeline.bars.length, 16);
    assert.equal(request.targets.length, 16);
    assert.deepEqual(request.points[4], [4, 0, 0]);
    assert.deepEqual(request.points[8], [4, 1, 0]); // battuta 5, seconda volta
    assert.equal(request.targets[1], 2.4); // 4/4 a 100 bpm
    assert.equal(request.scoreDuration, 38.4);
    assert.equal(request.notes.length, 160); // 16 battute × (8 note di chitarra + 2 di basso)
    assert.ok(request.notes.every(([start, duration, pitch]) => start >= 0 && duration > 0 && start + duration <= 38.4 + 1e-9 && pitch > 20));
    assert.deepEqual(request.anchors, []);
  });

  it('un punto per movimento', () => {
    const request = buildAutoSyncRequest(score, timeline, { granularity: 'beat', ...all });
    assert.equal(request.targets.length, 64);
    assert.deepEqual(request.points[1], [0, 0, 0.25]);
    assert.equal(request.targets[1], 0.6);
  });

  it('per un tratto calcola solo i suoi punti (più la battuta successiva) ma allinea tutto il brano', () => {
    const request = buildAutoSyncRequest(score, timeline, { granularity: 'bar', fromOrder: 8, toOrder: 11 });
    assert.equal(request.points.length, 5);
    assert.deepEqual(request.points[0], [4, 1, 0]);
    assert.deepEqual(request.points[4], [8, 0, 0]);
    assert.deepEqual(request.targets, [19.2, 21.6, 24, 26.4, 28.8]);
    assert.equal(request.scoreDuration, 38.4);
    assert.equal(request.notes.length, 160);
  });

  it('usa i sync point esistenti come ancore', () => {
    const points: FlatSyncPoint[] = [
      { barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 1500 },
      { barIndex: 4, barOccurence: 1, barPosition: 0, millisecondOffset: 21000 },
      { barIndex: 11, barOccurence: 0, barPosition: 0, millisecondOffset: 37000 },
    ];
    const map = new SyncMap(timeline, points);
    const request = buildAutoSyncRequest(score, timeline, { granularity: 'bar', fromOrder: 8, toOrder: 11, anchors: map });
    assert.deepEqual(request.anchors, [
      [1500, 0],
      [21000, 19.2],
      [37000, 36],
    ]);
  });

  it('unisce il risultato ai sync point esistenti', () => {
    const existing: FlatSyncPoint[] = [
      { barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 1000 },
      { barIndex: 4, barOccurence: 1, barPosition: 0, millisecondOffset: 20000 }, // dentro il tratto: sostituito
      { barIndex: 8, barOccurence: 0, barPosition: 0, millisecondOffset: 30000 }, // fine del tratto: sostituito
      { barIndex: 8, barOccurence: 0, barPosition: 0.5, millisecondOffset: 31000 }, // resta
    ];
    const request = buildAutoSyncRequest(score, timeline, { granularity: 'bar', fromOrder: 8, toOrder: 11 });
    const merged = mergeAutoSync(existing, timeline, request, [20500, 23000, 22990, 25500, 28000]);
    assert.deepEqual(
      merged.map((p) => [p.barIndex, p.barOccurence, p.barPosition, p.millisecondOffset]),
      [
        [0, 0, 0, 1000],
        [4, 1, 0, 20500],
        [5, 1, 0, 23000],
        // [6, 1, 0, 22990] scartato: tornerebbe indietro nel tempo
        [7, 1, 0, 25500],
        [8, 0, 0, 28000],
        [8, 0, 0.5, 31000],
      ],
    );
  });
});
