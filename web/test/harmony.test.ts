import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeProgression,
  chordSuffix,
  describeVoicing,
  detectChords,
  estimateKeys,
  formatKey,
  formatKeyItalian,
  keyFromSignature,
  noteFunction,
  parseChord,
  parseKey,
  romanNumeral,
  type KeyInfo,
} from '../src/player/harmony';

const C_MAJOR: KeyInfo = { tonic: 0, mode: 'major' };
const A_MINOR: KeyInfo = { tonic: 9, mode: 'minor' };

const midi = (...notes: number[]) => notes.map((n) => ({ midi: n, weight: 1 }));
const best = (...notes: number[]) => detectChords(midi(...notes))[0]?.symbol;

function analyze(key: KeyInfo, ...symbols: string[]) {
  return analyzeProgression(symbols.map((symbol) => ({ symbol, key })));
}
const romans = (key: KeyInfo, ...symbols: string[]) => analyze(key, ...symbols).map((a) => a?.roman ?? null);

describe('tonalità', () => {
  it('legge sigle, nomi italiani e modi', () => {
    assert.deepEqual(parseKey('Am'), A_MINOR);
    assert.deepEqual(parseKey('A minor'), A_MINOR);
    assert.deepEqual(parseKey('La minore'), A_MINOR);
    assert.deepEqual(parseKey('C'), C_MAJOR);
    assert.deepEqual(parseKey('Mi♭ maggiore'), { tonic: 3, mode: 'major' });
    assert.deepEqual(parseKey('D dorian'), { tonic: 2, mode: 'dorian' });
    assert.deepEqual(parseKey('Sol misolidio'), { tonic: 7, mode: 'mixolydian' });
    assert.deepEqual(parseKey('F lydian'), { tonic: 5, mode: 'lydian' });
    assert.equal(parseKey('H7'), null);
  });

  it('formatta', () => {
    assert.equal(formatKey(A_MINOR), 'Am');
    assert.equal(formatKey({ tonic: 3, mode: 'major' }), 'Eb');
    assert.equal(formatKey({ tonic: 2, mode: 'dorian' }), 'D dor');
    assert.equal(formatKeyItalian({ tonic: 6, mode: 'minor' }), 'Fa♯ minore');
    assert.equal(formatKeyItalian({ tonic: 7, mode: 'mixolydian' }), 'Sol misolidio');
  });

  it("ricava la tonalità dall'armatura", () => {
    assert.deepEqual(keyFromSignature(0, false), C_MAJOR);
    assert.deepEqual(keyFromSignature(0, true), A_MINOR);
    assert.deepEqual(keyFromSignature(1, true), { tonic: 4, mode: 'minor' });
    assert.deepEqual(keyFromSignature(-3, false), { tonic: 3, mode: 'major' });
  });
});

describe('parseChord', () => {
  it('riconosce qualità, settime e tensioni', () => {
    const am7 = parseChord('Am7')!;
    assert.equal(am7.third, 'm');
    assert.equal(am7.seventh, 'b7');
    assert.equal(parseChord('Cmaj7')!.seventh, 'M7');
    assert.equal(parseChord('CΔ7')!.seventh, 'M7');
    assert.equal(parseChord('F-7')!.third, 'm');
    const bo = parseChord('Bø')!;
    assert.deepEqual([bo.third, bo.fifth, bo.seventh], ['m', 'b5', 'b7']);
    assert.equal(parseChord('E°7')!.seventh, 'bb7');
    assert.equal(parseChord('G/B')!.bass, 11);
    assert.equal(parseChord('E5')!.third, null);
    assert.equal(parseChord('D9sus4')!.third, 'sus4');
    assert.deepEqual([...parseChord('C7(b9,#9)')!.tensions].sort(), ['#9', 'b9']);
    assert.equal(parseChord('G7alt')!.alt, true);
    assert.equal(parseChord('Cm(maj7)')!.seventh, 'M7');
    assert.equal(parseChord('Cm(maj7)')!.third, 'm');
    const c69 = parseChord('C6/9')!;
    assert.equal(c69.sixth, true);
    assert.ok(c69.tensions.has('9'));
    assert.deepEqual([...parseChord('A13')!.tensions].sort(), ['13', '9']);
    assert.ok(parseChord('Bbmaj7#11')!.tensions.has('#11'));
    assert.equal(parseChord('xyz'), null);
  });

  it('mette tra parentesi le tensioni dopo un numero', () => {
    const shape = parseChord('C6')!;
    shape.tensions.add('11');
    assert.equal(chordSuffix(shape), '6(11)');
    const minor = parseChord('Em')!;
    minor.tensions.add('b13');
    assert.equal(chordSuffix(minor), 'm(b13)');
  });

  it('ricostruisce il suffisso', () => {
    for (const s of ['m7', 'maj7', '7', 'm7b5', 'dim7', '9', '13', 'maj9', 'm9', 'm11', '7alt', '7b9', '9sus4', 'maj7#11', 'm(maj7)', '6/9', '7#5']) {
      assert.equal(chordSuffix(parseChord(`C${s}`)!), s, s);
    }
  });
});

describe('analisi funzionale', () => {
  it('ii-V-I diatonico', () => {
    const [ii, v, i] = analyze(C_MAJOR, 'Dm7', 'G7', 'Cmaj7');
    assert.equal(ii!.roman, 'ii7');
    assert.equal(ii!.iiV, 'iiV');
    assert.equal(ii!.scale, 'dorica');
    assert.equal(v!.roman, 'V7');
    assert.equal(v!.resolution, 'fifth');
    assert.equal(v!.func, 'D');
    assert.equal(i!.roman, 'Imaj7');
    assert.equal(i!.category, 'diatonic');
  });

  it('dominanti secondarie', () => {
    assert.deepEqual(romans(C_MAJOR, 'Cmaj7', 'A7', 'Dm7', 'G7', 'C'), ['Imaj7', 'V7/ii', 'ii7', 'V7', 'I']);
    assert.deepEqual(romans(C_MAJOR, 'D7', 'G7', 'C'), ['V7/V', 'V7', 'I']);
    assert.deepEqual(romans(C_MAJOR, 'E7b9', 'Am7'), ['V7♭9/vi', 'vi7']);
    assert.equal(analyze(C_MAJOR, 'A7', 'Dm7')[0]!.scale, 'misolidia ♭9 ♭13 (frigia dominante)');
  });

  it('sostituti di tritono e ii-SubV', () => {
    const [ii, sub, i] = analyze(C_MAJOR, 'Dm7', 'Db7', 'Cmaj7');
    assert.equal(sub!.roman, 'SubV7');
    assert.equal(sub!.category, 'substitute');
    assert.equal(sub!.resolution, 'halfstep');
    assert.equal(sub!.scale, 'lidia dominante (lidia ♭7)');
    assert.equal(ii!.iiV, 'iiSubV');
    assert.equal(i!.roman, 'Imaj7');
    assert.deepEqual(romans(C_MAJOR, 'Ab7', 'G7'), ['SubV7/V', 'V7']);
  });

  it('ii correlati e interscambio modale', () => {
    const [iiRel, vRel, target] = analyze(C_MAJOR, 'Bbm7', 'Eb7', 'Abmaj7');
    assert.equal(iiRel!.roman, 'ii7/♭VI');
    assert.equal(iiRel!.category, 'related-ii');
    assert.equal(vRel!.roman, 'V7/♭VI');
    assert.equal(target!.roman, '♭VImaj7');
    assert.equal(target!.category, 'interchange');
    assert.equal(target!.scale, 'lidia');
  });

  it('backdoor', () => {
    const [iv, bVII, i] = analyze(C_MAJOR, 'Fm7', 'Bb7', 'Cmaj7');
    assert.equal(iv!.roman, 'iv7');
    assert.equal(iv!.category, 'interchange');
    assert.equal(iv!.iiV, 'iiV');
    assert.equal(bVII!.roman, '♭VII7');
    assert.equal(bVII!.category, 'backdoor');
    assert.equal(i!.roman, 'Imaj7');
  });

  it('ii-V-i minore', () => {
    const [ii, v, i] = analyze(A_MINOR, 'Bm7b5', 'E7b9', 'Am7');
    assert.equal(ii!.roman, 'iiø7');
    assert.equal(ii!.iiV, 'iiV');
    assert.equal(v!.roman, 'V7♭9');
    assert.equal(i!.roman, 'i7');
    assert.deepEqual(romans(A_MINOR, 'F', 'G', 'Am'), ['♭VI', '♭VII', 'i']);
    assert.deepEqual(romans(A_MINOR, 'C', 'Dm'), ['♭III', 'iv']);
  });

  it('diminuiti di passaggio', () => {
    const [, dim] = analyze(C_MAJOR, 'Cmaj7', 'C#dim7', 'Dm7');
    assert.equal(dim!.roman, 'vii°7/ii');
    assert.equal(dim!.category, 'passing');
    assert.equal(dim!.scale, 'diminuita (tono-semitono)');
    assert.equal(romans(C_MAJOR, 'Cdim7', 'C')[0], 'ct°7');
  });

  it('modi', () => {
    const dorian: KeyInfo = { tonic: 2, mode: 'dorian' };
    const [i, iv] = analyze(dorian, 'Dm7', 'G7');
    assert.equal(i!.roman, 'i7');
    assert.equal(i!.scale, 'dorica');
    assert.equal(iv!.roman, 'IV7');
    assert.equal(iv!.category, 'diatonic');
    const mixo: KeyInfo = { tonic: 7, mode: 'mixolydian' };
    assert.equal(analyze(mixo, 'F', 'G')[0]!.roman, '♭VII');
    assert.equal(analyze(mixo, 'F', 'G')[0]!.category, 'diatonic');
  });

  it('colori jazz: lidio, alterato, sospeso', () => {
    const lyd = analyze(C_MAJOR, 'Cmaj7#11')[0]!;
    assert.equal(lyd.roman, 'Imaj7♯11');
    assert.equal(lyd.scale, 'lidia');
    // la #11 è un colore della tonica, non un prestito
    assert.equal(lyd.category, 'diatonic');
    assert.equal(lyd.func, 'T');
    assert.equal(analyze(C_MAJOR, 'G7b9')[0]!.category, 'diatonic');
    const alt = analyze(C_MAJOR, 'G7alt', 'Cmaj7')[0]!;
    assert.equal(alt.roman, 'V7alt');
    assert.equal(alt.scale, 'alterata (superlocria)');
    assert.equal(analyze(C_MAJOR, 'G13b9', 'C')[0]!.scale, 'diminuita (semitono-tono)');
    assert.equal(analyze(C_MAJOR, 'G9sus4', 'C')[0]!.roman, 'V9sus4');
  });

  it('rivolti e accordi ibridi', () => {
    assert.equal(romanNumeral('C/E', C_MAJOR), 'I6');
    assert.equal(romanNumeral('C/G', C_MAJOR), 'I64');
    assert.equal(romanNumeral('G7/B', C_MAJOR, 'C'), 'V65');
    assert.equal(romanNumeral('G7/F', C_MAJOR, 'C/E'), 'V42');
    assert.equal(romanNumeral('D7/F#', C_MAJOR, 'G'), 'V65/V');
    assert.equal(romanNumeral('F/G', C_MAJOR), 'IV/V');
  });
});

describe('riconoscimento accordi', () => {
  it('triadi, settime e bicordi', () => {
    assert.equal(best(45, 52, 57, 60, 64), 'Am');
    assert.equal(best(43, 47, 50, 55, 59, 65), 'G7');
    assert.equal(best(48, 52, 55, 59), 'Cmaj7');
    assert.equal(best(40, 47, 52), 'E5');
    assert.equal(best(47, 55, 62, 67), 'G/B');
    assert.equal(detectChords(midi(46, 53, 58, 62), true)[0].symbol, 'Bb');
  });

  it('voicing jazz', () => {
    assert.equal(best(48, 52, 58, 62), 'C9'); // C E Bb D (senza quinta)
    assert.equal(best(48, 58, 64, 69), 'C13'); // C Bb E A
    assert.equal(best(43, 47, 53, 56), 'G7b9'); // G B F Ab
    assert.equal(best(43, 47, 53, 56, 58, 63), 'G7alt'); // G B F Ab Bb Eb
    assert.equal(best(40, 45, 50, 55), 'Em11'); // quarte sovrapposte (voicing "So What")
    assert.equal(best(41, 45, 48, 52, 59), 'Fmaj7#11');
    assert.equal(best(48, 51, 55, 59), 'Cm(maj7)');
    assert.equal(best(50, 54, 57, 60, 64), 'D9');
    assert.equal(best(47, 50, 53, 57), 'Bm7b5');
  });
});

describe('funzione delle note', () => {
  it('su un accordo di dominante', () => {
    const g7 = parseChord('G7')!;
    const f = (pc: number) => noteFunction(pc, g7);
    assert.deepEqual(f(5), { label: '♭7', kind: 'chord' });
    assert.deepEqual(f(8), { label: '♭9', kind: 'tension' });
    assert.deepEqual(f(9), { label: '9', kind: 'tension' });
    assert.deepEqual(f(0), { label: '11', kind: 'avoid' });
    assert.deepEqual(f(1), { label: '♯11', kind: 'tension' });
    assert.deepEqual(f(4), { label: '13', kind: 'tension' });
    assert.deepEqual(f(3), { label: '♭13', kind: 'tension' });
    assert.deepEqual(f(10), { label: '♯9', kind: 'tension' });
  });

  it('su maj7 e minore', () => {
    const cmaj7 = parseChord('Cmaj7')!;
    assert.deepEqual(noteFunction(5, cmaj7), { label: '11', kind: 'avoid' });
    assert.deepEqual(noteFunction(6, cmaj7), { label: '♯11', kind: 'tension' });
    assert.equal(noteFunction(10, cmaj7).kind, 'outside');
    const dm7 = parseChord('Dm7')!;
    assert.deepEqual(noteFunction(7, dm7), { label: '11', kind: 'tension' });
    assert.deepEqual(noteFunction(5, dm7), { label: '♭3', kind: 'chord' });
  });

  it('descrive il voicing', () => {
    assert.equal(describeVoicing([48, 52, 58, 62], parseChord('C9')!, true), 'C (1) · E (3) · B♭ (♭7) · D (9)');
  });
});

describe('stima della tonalità', () => {
  it('da un istogramma', () => {
    const h = new Array(12).fill(0);
    for (const [pc, w] of [[9, 10], [11, 3], [0, 6], [2, 4], [4, 8], [5, 3], [7, 3]] as const) h[pc] = w;
    const [top] = estimateKeys(h);
    assert.deepEqual({ tonic: top.tonic, mode: top.mode }, A_MINOR);
  });
});
