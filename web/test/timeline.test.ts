import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SyncMap, Timeline, type TickLookupBar } from '../src/player/timeline';

const BAR = 3840; // 4/4 a 960 tick per quarto

/** Battute 0..3 con ritornello su 1-2 (ordine: 0 1 2 1 2 3), tempo 120 poi 60 dalla battuta 3. */
function lookup(): TickLookupBar[] {
  const order = [0, 1, 2, 1, 2, 3];
  return order.map((index, i) => ({
    start: i * BAR,
    end: (i + 1) * BAR,
    masterBar: { index },
    tempoChanges: [{ tick: i * BAR, tempo: index === 3 ? 60 : 120 }],
  }));
}

describe('Timeline', () => {
  const timeline = Timeline.fromTickLookup(lookup(), 120);

  it('numera le ripetizioni', () => {
    assert.deepEqual(
      timeline.bars.map((b) => `${b.barIndex}:${b.occurrence}`),
      ['0:0', '1:0', '2:0', '1:1', '2:1', '3:0'],
    );
  });

  it('converte tick e millisecondi', () => {
    assert.equal(timeline.tickToMs(BAR), 2000); // una battuta a 120 bpm = 2 s
    assert.equal(timeline.tickToMs(5 * BAR), 10000);
    assert.equal(timeline.tickToMs(5 * BAR + BAR / 2), 12000); // a 60 bpm mezza battuta = 2 s
    assert.equal(timeline.durationMs, 14000);
    assert.equal(timeline.msToTick(12000), 5 * BAR + BAR / 2);
    assert.equal(timeline.msToTick(3000), 1.5 * BAR);
  });

  it('trova battute e occorrenze', () => {
    assert.equal(timeline.barAtTick(3.5 * BAR)?.occurrence, 1);
    assert.equal(timeline.tickOf(2, 1, 0.5), 4.5 * BAR);
    assert.equal(timeline.find(3, 1), undefined);
  });
});

describe('SyncMap', () => {
  const timeline = Timeline.fromTickLookup(lookup(), 120);

  it('senza sync point usa il tempo dello spartito', () => {
    const map = new SyncMap(timeline, []);
    assert.equal(map.tickToAudio(BAR), 2000);
  });

  it('con un solo sync point applica solo lo scostamento', () => {
    const map = new SyncMap(timeline, [{ barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 1500 }]);
    assert.equal(map.tickToAudio(0), 1500);
    assert.equal(map.tickToAudio(BAR), 3500);
    assert.equal(map.audioToTick(3500), BAR);
  });

  it('interpola ed estrapola tra più sync point', () => {
    const map = new SyncMap(timeline, [
      { barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 1000 },
      // la registrazione è più lenta: la battuta 1 inizia dopo 2.5 s invece di 2
      { barIndex: 1, barOccurence: 0, barPosition: 0, millisecondOffset: 3500 },
      { barIndex: 1, barOccurence: 1, barPosition: 0, millisecondOffset: 8500 },
    ]);
    assert.equal(map.anchors.length, 3);
    assert.equal(map.tickToAudio(0.5 * BAR), 2250);
    assert.equal(map.tickToAudio(2 * BAR), 6000);
    // dopo l'ultimo sync point continua con il rapporto dell'ultimo tratto (1.25)
    assert.equal(map.tickToAudio(4 * BAR), 8500 + 2500);
    // prima del primo sync point estrapola con il primo tratto
    assert.equal(map.audioToTick(0), -0.4 * BAR);
    assert.ok(Math.abs(map.segmentBpm(0)! - 96) < 1e-9);
  });

  it('scarta i sync point incoerenti', () => {
    const map = new SyncMap(timeline, [
      { barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: 1000 },
      { barIndex: 2, barOccurence: 0, barPosition: 0, millisecondOffset: 500 }, // tempo che torna indietro
      { barIndex: 9, barOccurence: 0, barPosition: 0, millisecondOffset: 9000 }, // battuta inesistente
      { barIndex: 3, barOccurence: 0, barPosition: 0, millisecondOffset: 11000 },
    ]);
    assert.deepEqual([...map.invalid].sort(), [1, 2]);
    assert.equal(map.validPoints().length, 2);
  });
});
