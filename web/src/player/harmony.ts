// Analisi armonica avanzata (orientata al jazz): parsing di sigle estese e alterate,
// riconoscimento accordi dalle note, gradi romani funzionali in base al contesto
// (dominanti secondarie, sostituti di tritono, ii-V, backdoor, diminuiti di passaggio,
// interscambio modale), scale consigliate, funzione delle note sull'accordo e stima
// della tonalità (profili di Krumhansl-Kessler). Nessuna dipendenza esterna.
//
// Convenzione dei gradi: "stile Berklee", sempre rispetto alla scala maggiore della
// tonica (in La minore: i, ♭III, iv, V, ♭VI, ♭VII), come nella didattica jazz.

export type Mode = 'major' | 'minor' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'locrian';

export interface KeyInfo {
  tonic: number; // pitch class 0-11
  mode: Mode;
}

export const MODES: Mode[] = ['major', 'minor', 'dorian', 'mixolydian', 'lydian', 'phrygian', 'locrian'];

const MODE_STEPS: Record<Mode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};
/** Distanza della tonica del modo dalla tonica della scala maggiore "madre". */
const MODE_OFFSET: Record<Mode, number> = { major: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, minor: 9, locrian: 11 };

export const MODE_LABELS: Record<Mode, string> = {
  major: 'maggiore',
  minor: 'minore',
  dorian: 'dorico',
  phrygian: 'frigio',
  lydian: 'lidio',
  mixolydian: 'misolidio',
  locrian: 'locrio',
};
const MODE_SHORT: Record<Mode, string> = {
  major: '',
  minor: 'm',
  dorian: ' dor',
  phrygian: ' frig',
  lydian: ' lid',
  mixolydian: ' mixo',
  locrian: ' locr',
};
const MODE_ALIASES: Array<[RegExp, Mode]> = [
  [/^(m|-)$/, 'minor'],
  [/^M$/, 'major'],
  [/^(maj|major|maggiore|magg|ionian|ionico)$/i, 'major'],
  [/^(min|minor|minore|aeolian|eolio)$/i, 'minor'],
  [/^(dor|dorian|dorico)$/i, 'dorian'],
  [/^(phr|phryg|frig|phrygian|frigio)$/i, 'phrygian'],
  [/^(lyd|lid|lydian|lidio)$/i, 'lydian'],
  [/^(mix|mixo|misol|mixolydian|misolidio)$/i, 'mixolydian'],
  [/^(loc|locr|locrian|locrio)$/i, 'locrian'],
];

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const ITALIAN_NAMES: Record<string, string> = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function mod12(n: number): number {
  return ((n % 12) + 12) % 12;
}

export function parsePitchClass(name: string): number | null {
  const m = /^([A-Ga-g])([#♯b♭]*)$/.exec(name.trim());
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const acc of m[2]) pc += acc === '#' || acc === '♯' ? 1 : -1;
  return mod12(pc);
}

export function pitchName(pc: number, flats: boolean): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)];
}

/** Rende le alterazioni con i simboli musicali (b → ♭, # → ♯). */
export function prettyAccidentals(text: string): string {
  return text.replace(/([A-G])b/g, '$1♭').replace(/#/g, '♯').replace(/(^|[^A-Za-z])b(?=\d)/g, '$1♭');
}

function parentMajorName(key: KeyInfo): string {
  return MAJOR_KEY_NAMES[mod12(key.tonic - MODE_OFFSET[key.mode])];
}

/** Tonalità che si scrivono con i bemolle (per scegliere i nomi delle note). */
export function keyUsesFlats(key: KeyInfo | null): boolean {
  if (!key) return false;
  const parent = parentMajorName(key);
  return parent === 'F' || parent.includes('b');
}

export function keyTonicName(key: KeyInfo): string {
  if (key.mode === 'major') return MAJOR_KEY_NAMES[key.tonic];
  return pitchName(key.tonic, keyUsesFlats(key));
}

/** Nome breve della tonalità, es. "Am", "Eb", "D dor". */
export function formatKey(key: KeyInfo): string {
  return `${keyTonicName(key)}${MODE_SHORT[key.mode]}`;
}

/** Nome esteso in italiano, es. "La minore", "Re dorico". */
export function formatKeyItalian(key: KeyInfo): string {
  const name = keyTonicName(key);
  const accidental = name.slice(1).replace('b', '♭').replace('#', '♯');
  return `${ITALIAN_NAMES[name[0]]}${accidental} ${MODE_LABELS[key.mode]}`;
}

/** Legge "Am", "A minor", "La minore", "C", "Eb maggiore", "D dorian", "Sol misolidio"... */
export function parseKey(text: string): KeyInfo | null {
  const t = text.trim().replace(/\s+/g, ' ');
  let tonic: number | null = null;
  let rest = '';
  const italian = /^(do|re|mi|fa|sol|la|si)\s*([#♯b♭]?)\s*(.*)$/i.exec(t);
  if (italian) {
    const letter = Object.entries(ITALIAN_NAMES).find(([, v]) => v.toLowerCase() === italian[1].toLowerCase())![0];
    tonic = parsePitchClass(letter + (italian[2] ?? ''));
    rest = italian[3];
  } else {
    const m = /^([A-G][#♯b♭]?)\s*(.*)$/.exec(t);
    if (!m) return null;
    tonic = parsePitchClass(m[1]);
    rest = m[2];
  }
  if (tonic === null) return null;
  if (rest === '') return { tonic, mode: 'major' };
  for (const [re, mode] of MODE_ALIASES) if (re.test(rest.trim())) return { tonic, mode };
  return null;
}

/** Tonalità dall'armatura di chiave di alphaTab (-7..7 alterazioni, 0 maggiore / 1 minore). */
export function keyFromSignature(accidentals: number, minor: boolean): KeyInfo {
  const majorTonic = mod12(accidentals * 7);
  return minor ? { tonic: mod12(majorTonic - 3), mode: 'minor' } : { tonic: majorTonic, mode: 'major' };
}

// ---------------------------------------------------------------------------
// Struttura degli accordi

export type Third = 'M' | 'm' | 'sus4' | 'sus2' | null;
export type Fifth = 'P' | 'b5' | '#5' | null;
export type Seventh = 'b7' | 'M7' | 'bb7' | null;
export type Tension = 'b9' | '9' | '#9' | '11' | '#11' | 'b13' | '13';

const TENSION_ORDER: Tension[] = ['b9', '9', '#9', '11', '#11', 'b13', '13'];
const TENSION_INTERVAL: Record<Tension, number> = { b9: 1, '9': 2, '#9': 3, '11': 5, '#11': 6, b13: 8, '13': 9 };
const ALTERED: Tension[] = ['b9', '#9', '#11', 'b13'];

export interface ChordShape {
  third: Third;
  fifth: Fifth;
  seventh: Seventh;
  sixth: boolean;
  tensions: Set<Tension>;
  alt: boolean;
}

export interface ParsedChord extends ChordShape {
  root: number;
  bass: number | null;
  symbol: string;
}

/** Intervalli (in semitoni dalla fondamentale) delle note dell'accordo. */
export function chordIntervals(shape: ChordShape): Set<number> {
  const set = new Set<number>([0]);
  if (shape.third === 'M') set.add(4);
  else if (shape.third === 'm') set.add(3);
  else if (shape.third === 'sus4') set.add(5);
  else if (shape.third === 'sus2') set.add(2);
  if (shape.fifth === 'P') set.add(7);
  else if (shape.fifth === 'b5') set.add(6);
  else if (shape.fifth === '#5') set.add(8);
  if (shape.seventh === 'b7') set.add(10);
  else if (shape.seventh === 'M7') set.add(11);
  else if (shape.seventh === 'bb7') set.add(9);
  if (shape.sixth) set.add(9);
  for (const t of shape.tensions) set.add(TENSION_INTERVAL[t]);
  return set;
}

function isDominantShape(c: ChordShape): boolean {
  return c.seventh === 'b7' && (c.third === 'M' || c.third === 'sus4');
}

function isMinorShape(c: ChordShape): boolean {
  return c.third === 'm' && c.fifth !== 'b5';
}

function isHalfDim(c: ChordShape): boolean {
  return c.third === 'm' && c.fifth === 'b5' && c.seventh === 'b7';
}

function isDim(c: ChordShape): boolean {
  return c.third === 'm' && c.fifth === 'b5' && c.seventh !== 'b7';
}

/**
 * Interpreta una sigla: "Am7", "F#m7b5", "Bø", "E°7", "G/B", "Bbmaj7#11", "C7(b9,#9)",
 * "G7alt", "D9sus4", "C6/9", "Cm(maj7)", "A13", "Ebmaj9", "F-7", "CΔ7"...
 */
export function parseChord(symbol: string): ParsedChord | null {
  const m = /^\s*([A-G][#♯b♭]?)((?:[^/]|\/9)*?)(?:\/([A-G][#♯b♭]?))?\s*$/.exec(symbol);
  if (!m) return null;
  const root = parsePitchClass(m[1]);
  if (root === null) return null;
  const bass = m[3] ? parsePitchClass(m[3]) : null;
  let s = m[2]
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .replace(/Δ/g, 'maj')
    .replace(/[−–]/g, '-')
    .replace(/[\s(),]/g, '');

  const shape: ChordShape = { third: 'M', fifth: 'P', seventh: null, sixth: false, tensions: new Set(), alt: false };
  const take = (re: RegExp): RegExpExecArray | null => {
    const r = re.exec(s);
    if (r) s = s.slice(r[0].length);
    return r;
  };

  if (take(/^(ø7?|m7b5|min7b5|mi7b5|-7b5)/)) {
    shape.third = 'm';
    shape.fifth = 'b5';
    shape.seventh = 'b7';
  } else if (take(/^(dim7|°7|o7)/)) {
    shape.third = 'm';
    shape.fifth = 'b5';
    shape.seventh = 'bb7';
  } else if (take(/^(dim|°|o(?!\d))/)) {
    shape.third = 'm';
    shape.fifth = 'b5';
  } else if (take(/^(aug|\+(?![0-9]))/)) {
    shape.fifth = '#5';
  } else if (take(/^(min|mi(?!n)|m(?!aj|a\d)|-(?=\d|$|m|M|maj))/)) {
    shape.third = 'm';
  } else if (/^5$/.test(s)) {
    shape.third = null;
    s = '';
  }

  let guard = 0;
  while (s.length > 0 && guard++ < 20) {
    let r: RegExpExecArray | null;
    if ((r = take(/^(maj|ma|M)(7|9|11|13)?/))) {
      shape.seventh = 'M7';
      const ext = r[2];
      if (ext === '9' || ext === '11' || ext === '13') shape.tensions.add('9');
      if (ext === '13') shape.tensions.add('13');
      if (ext === '11') shape.tensions.add(shape.third === 'm' ? '11' : '#11');
    } else if ((r = take(/^(6\/9|69)/))) {
      shape.sixth = true;
      shape.tensions.add('9');
    } else if (take(/^6/)) {
      shape.sixth = true;
    } else if ((r = take(/^add(b9|#9|9|2|#11|11|4|b13|13)/))) {
      const map: Record<string, Tension> = { b9: 'b9', '#9': '#9', '9': '9', '2': '9', '#11': '#11', '11': '11', '4': '11', b13: 'b13', '13': '13' };
      shape.tensions.add(map[r[1]]);
    } else if (take(/^sus2/)) {
      shape.third = 'sus2';
    } else if (take(/^sus4?/)) {
      shape.third = 'sus4';
    } else if (take(/^alt/)) {
      shape.alt = true;
      shape.seventh ??= 'b7';
      for (const t of ['b9', '#9', 'b13'] as Tension[]) shape.tensions.add(t);
    } else if ((r = take(/^(b|-)(5|9|13)/))) {
      if (r[2] === '5') shape.fifth = 'b5';
      else shape.tensions.add(r[2] === '9' ? 'b9' : 'b13');
      if (r[2] !== '5' && !shape.seventh && shape.third !== 'm') shape.seventh = 'b7';
    } else if ((r = take(/^(#|\+)(5|9|11)/))) {
      if (r[2] === '5') shape.fifth = '#5';
      else shape.tensions.add(r[2] === '9' ? '#9' : '#11');
      if (r[2] === '9' && !shape.seventh) shape.seventh = 'b7';
    } else if ((r = take(/^(13|11|9|7)/))) {
      if (shape.fifth === 'b5' && shape.third === 'm' && !shape.seventh && r[1] === '7') shape.seventh = 'bb7';
      else shape.seventh ??= 'b7';
      if (r[1] === '9' || r[1] === '11' || r[1] === '13') shape.tensions.add('9');
      if (r[1] === '11') shape.tensions.add('11');
      if (r[1] === '13') shape.tensions.add('13');
    } else if (take(/^no3/)) {
      shape.third = null;
    } else if (take(/^no5/)) {
      shape.fifth = null;
    } else {
      s = s.slice(1); // carattere non riconosciuto: ignorato
    }
  }
  if (shape.third === null && shape.fifth === null) shape.fifth = 'P';
  return { ...shape, root, bass, symbol: symbol.trim() };
}

/**
 * Aggiunge le tensioni a un suffisso: le alterazioni seguono direttamente una settima
 * ("7b9", "maj7#11"), altrimenti vanno tra parentesi ("6(11)", "m(b13)", "dim(9)").
 */
function withTensions(base: string, tensions: Tension[]): string {
  if (tensions.length === 0) return base;
  const hasSeventh = /7|9|11|13/.test(base);
  if (hasSeventh && tensions.every((t) => !/^\d/.test(t))) return base + tensions.join('');
  return `${base}(${tensions.join(',')})`;
}

/** Suffisso della sigla (senza fondamentale) per una struttura d'accordo. */
export function chordSuffix(c: ChordShape): string {
  const t = c.tensions;
  const list = (skip: Tension[]) => TENSION_ORDER.filter((x) => t.has(x) && !skip.includes(x));

  if (c.third === 'm' && c.fifth === 'b5') {
    if (c.seventh === 'bb7') return withTensions('dim7', list([]));
    if (c.seventh === 'b7') return withTensions(t.has('11') ? 'm11b5' : t.has('9') ? 'm9b5' : 'm7b5', list(['9', '11']));
    return withTensions('dim', list([]));
  }
  if (c.third === 'm') {
    if (c.seventh === 'M7') return withTensions(`m(maj${t.has('9') ? '9' : '7'})`, list(['9']));
    if (c.seventh === 'b7') {
      const base = t.has('13') ? 'm13' : t.has('11') ? 'm11' : t.has('9') ? 'm9' : 'm7';
      const skip: Tension[] = base === 'm13' ? ['9', '11', '13'] : base === 'm11' ? ['9', '11'] : base === 'm9' ? ['9'] : [];
      return withTensions(base, list(skip));
    }
    if (c.sixth) return withTensions(t.has('9') ? 'm6/9' : 'm6', list(['9']));
    if (t.has('9')) return withTensions('madd9', list(['9']));
    return withTensions('m', list([]));
  }
  if (c.fifth === '#5' && c.third === 'M') {
    if (c.seventh === 'b7') return withTensions(`${t.has('9') ? '9' : '7'}#5`, list(['9']));
    if (c.seventh === 'M7') return withTensions('maj7#5', list([]));
    return withTensions('aug', list([]));
  }
  const sus = c.third === 'sus4' ? 'sus4' : c.third === 'sus2' ? 'sus2' : '';
  if (c.seventh === 'M7') {
    const base = t.has('13') ? 'maj13' : t.has('9') ? 'maj9' : 'maj7';
    return withTensions(base + sus, list(base === 'maj13' ? ['9', '13'] : base === 'maj9' ? ['9'] : []));
  }
  if (c.seventh === 'b7') {
    const altered = ALTERED.filter((x) => t.has(x));
    const hasFlatOrSharp9 = t.has('b9') || t.has('#9');
    if ((c.alt || (hasFlatOrSharp9 && t.has('b13'))) && !t.has('9') && !t.has('13') && c.third !== 'sus4') {
      return '7alt';
    }
    const base = t.has('13') ? '13' : t.has('9') ? '9' : '7';
    const skip: Tension[] = base === '13' ? ['9', '13'] : base === '9' ? ['9'] : [];
    const fifth = c.fifth === 'b5' ? 'b5' : '';
    const eleven = t.has('11') && c.third !== 'sus4' ? '(11)' : '';
    const rest = altered.filter((x) => !skip.includes(x)).join('');
    return `${base}${sus}${fifth}${rest}${eleven}`;
  }
  if (c.third === null) return c.fifth === 'P' && t.size === 0 && !c.sixth ? '5' : withTensions('5', list([]));
  if (c.sixth) return withTensions(`${t.has('9') ? '6/9' : '6'}${sus}`, list(['9']));
  if (t.has('9') && c.third === 'M') return withTensions('add9', list(['9']));
  if (c.fifth === 'b5') return withTensions(`(b5)${sus}`, list([]));
  return withTensions(sus, list([]));
}

// ---------------------------------------------------------------------------
// Riconoscimento accordi dalle note

export interface PitchWeight {
  /** Nota MIDI. */
  midi: number;
  /** Durata (tick o qualsiasi unità coerente). */
  weight: number;
}

export interface DetectedChord {
  symbol: string;
  score: number;
}

function shapeFromIntervals(iv: Set<number>): { shape: ChordShape; penalty: number } {
  let penalty = 0;
  const shape: ChordShape = { third: null, fifth: null, seventh: null, sixth: false, tensions: new Set(), alt: false };
  if (iv.has(4)) shape.third = 'M';
  else if (iv.has(3)) shape.third = 'm';
  else if (iv.has(5)) shape.third = 'sus4';
  else if (iv.has(2)) shape.third = 'sus2';

  if (iv.has(7)) shape.fifth = 'P';
  else if (shape.third === 'm' && iv.has(6)) shape.fifth = 'b5';
  else if (shape.third === 'M' && iv.has(8) && !iv.has(10)) shape.fifth = '#5';

  if (iv.has(10)) shape.seventh = 'b7';
  else if (iv.has(11)) shape.seventh = 'M7';
  else if (shape.fifth === 'b5' && iv.has(9)) shape.seventh = 'bb7';
  if (iv.has(10) && iv.has(11)) penalty += 1.2;

  const used = chordIntervals(shape);
  for (const i of iv) {
    if (used.has(i)) continue;
    switch (i) {
      case 1:
        shape.tensions.add('b9');
        if (shape.third === 'm' || shape.seventh === 'M7') penalty += 0.8;
        break;
      case 2:
        shape.tensions.add('9');
        break;
      case 3:
        if (shape.third === 'M') shape.tensions.add('#9');
        else penalty += 1.2;
        break;
      case 4:
        penalty += 1.5; // terza maggiore su accordo minore/sospeso
        break;
      case 5:
        shape.tensions.add('11');
        if (shape.third === 'M') penalty += 0.5;
        break;
      case 6:
        shape.tensions.add('#11');
        break;
      case 8:
        shape.tensions.add('b13');
        if (shape.third === 'M' && shape.seventh === 'M7') penalty += 0.6;
        break;
      case 9:
        if (shape.seventh) shape.tensions.add('13');
        else shape.sixth = true;
        break;
      case 11:
        penalty += 0.8;
        break;
      default:
        penalty += 1;
    }
  }
  return { shape, penalty };
}

/**
 * Propone le sigle più plausibili per un insieme di note (es. quelle suonate in un
 * movimento o in mezza battuta, anche da più strumenti). La nota più grave conta come basso.
 */
export function detectChords(notes: PitchWeight[], flats = false, max = 5): DetectedChord[] {
  if (notes.length === 0) return [];
  const weights = new Array<number>(12).fill(0);
  let bassMidi = Infinity;
  for (const n of notes) {
    weights[mod12(n.midi)] += n.weight;
    if (n.midi < bassMidi) bassMidi = n.midi;
  }
  const maxWeight = Math.max(...weights);
  if (maxWeight <= 0) return [];
  const norm = weights.map((w) => w / maxWeight);
  const present = norm.map((w, pc) => ({ pc, w })).filter((x) => x.w >= 0.1);
  const bass = mod12(bassMidi);

  const candidates: DetectedChord[] = [];
  for (const { pc: root, w: rootWeight } of present) {
    const iv = new Set(present.map((p) => mod12(p.pc - root)));
    const { shape, penalty } = shapeFromIntervals(iv);
    const dominant = shape.third === 'M' && shape.seventh === 'b7';
    let score = rootWeight * 0.4 - penalty;
    if (root === bass) score += 0.8;
    if (shape.third === 'M' || shape.third === 'm') score += 1;
    else if (shape.third) score += 0.3;
    else score -= 0.4;
    if (shape.fifth === 'P') score += 0.5;
    else if (shape.fifth) score += 0.2;
    if (shape.seventh) score += 0.6;
    // Le dominanti sono gli accordi che "portano" le tensioni alterate.
    for (const t of shape.tensions) score -= ALTERED.includes(t) ? (dominant ? 0.2 : 0.45) : 0.3;
    if (shape.sixth) score -= 0.2;
    // Minore con ♭13 e senza quinta: quasi sempre è un accordo maggiore in primo rivolto.
    if (shape.third === 'm' && shape.fifth === null && shape.tensions.has('b13')) score -= 1;
    const bassInterval = mod12(bass - root);
    if (root !== bass) {
      if (!chordIntervals({ ...shape, tensions: new Set() }).has(bassInterval)) score -= 0.5;
      else if (bassInterval === 11) score -= 0.5; // settima maggiore al basso: raro
    }
    if (present.length === 1) {
      shape.third = null;
      shape.fifth = null;
    }
    const suffix = present.length === 1 ? '' : chordSuffix(shape);
    const symbol = pitchName(root, flats) + suffix + (root !== bass ? `/${pitchName(bass, flats)}` : '');
    candidates.push({ symbol, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const result: DetectedChord[] = [];
  for (const c of candidates) {
    if (result.length >= max) break;
    if (result.length > 0 && c.score < result[0].score - 3) break;
    if (!result.some((r) => r.symbol === c.symbol)) result.push(c);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Funzione delle note sull'accordo (per analizzare le linee melodiche)

export type NoteFunctionKind = 'root' | 'chord' | 'tension' | 'avoid' | 'outside';

export interface NoteFunction {
  label: string;
  kind: NoteFunctionKind;
}

/** Intervallo di una nota rispetto all'accordo: "1", "3", "♭7", "9", "♯11", "♭13"... */
export function noteFunction(pc: number, chord: ParsedChord): NoteFunction {
  const i = mod12(pc - chord.root);
  const minor = chord.third === 'm';
  const dominant = chord.third === 'M' && chord.seventh === 'b7';
  switch (i) {
    case 0:
      return { label: '1', kind: 'root' };
    case 1:
      return { label: '♭9', kind: dominant ? 'tension' : 'avoid' };
    case 2:
      return { label: chord.third === 'sus2' ? '2' : '9', kind: chord.third === 'sus2' ? 'chord' : 'tension' };
    case 3:
      return minor ? { label: '♭3', kind: 'chord' } : { label: '♯9', kind: dominant ? 'tension' : 'outside' };
    case 4:
      return chord.third === 'M' ? { label: '3', kind: 'chord' } : { label: '3', kind: 'outside' };
    case 5:
      if (chord.third === 'sus4') return { label: '4', kind: 'chord' };
      return { label: '11', kind: minor ? 'tension' : 'avoid' };
    case 6:
      if (chord.fifth === 'b5') return { label: '♭5', kind: 'chord' };
      return { label: '♯11', kind: minor ? 'outside' : 'tension' };
    case 7:
      return { label: '5', kind: chord.fifth === 'P' || chord.fifth === null ? 'chord' : 'outside' };
    case 8:
      if (chord.fifth === '#5') return { label: '♯5', kind: 'chord' };
      return { label: '♭13', kind: dominant || minor ? 'tension' : 'avoid' };
    case 9:
      if (chord.seventh === 'bb7') return { label: '°7', kind: 'chord' };
      if (chord.sixth) return { label: '6', kind: 'chord' };
      return { label: '13', kind: isHalfDim(chord) ? 'avoid' : 'tension' };
    case 10:
      return { label: '♭7', kind: chord.seventh === 'b7' ? 'chord' : minor || chord.seventh === null ? 'tension' : 'outside' };
    default:
      return { label: '7', kind: chord.seventh === 'M7' ? 'chord' : 'outside' };
  }
}

/** Descrizione del voicing dal basso verso l'alto, es. "C (1) · E (3) · B♭ (♭7) · D (9)". */
export function describeVoicing(midis: number[], chord: ParsedChord, flats: boolean): string {
  const sorted = [...new Set(midis)].sort((a, b) => a - b);
  return sorted
    .map((m) => `${prettyAccidentals(pitchName(m, flats))} (${noteFunction(m, chord).label})`)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Analisi funzionale

export type HarmonicCategory =
  | 'diatonic'
  | 'secondary'
  | 'substitute'
  | 'related-ii'
  | 'backdoor'
  | 'interchange'
  | 'passing'
  | 'chromatic';

export const CATEGORY_LABELS: Record<HarmonicCategory, string> = {
  diatonic: 'diatonico',
  secondary: 'dominante secondaria',
  substitute: 'sostituto di tritono',
  'related-ii': 'ii correlato',
  backdoor: 'dominante backdoor',
  interchange: 'interscambio modale',
  passing: 'diminuito di passaggio',
  chromatic: 'cromatico',
};

export type HarmonicFunction = 'T' | 'SD' | 'D' | null;

export interface ChordAnalysis {
  roman: string;
  category: HarmonicCategory;
  func: HarmonicFunction;
  /** Scala consigliata per improvvisare/analizzare le linee. */
  scale: string | null;
  /** Modo da cui è preso in prestito (interscambio modale). */
  borrowedFrom?: Mode;
  /** Risoluzione verso l'accordo successivo: per quinta discendente o per semitono. */
  resolution: 'fifth' | 'halfstep' | null;
  /** Questo accordo apre una coppia ii-V (o ii-SubV) con il successivo. */
  iiV: 'iiV' | 'iiSubV' | null;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
/** Semitoni dalla tonica → [grado, alterazione] rispetto alla scala maggiore. */
const DEGREES: Array<[number, string]> = [
  [0, ''], [1, '♭'], [1, ''], [2, '♭'], [2, ''], [3, ''], [3, '♯'], [4, ''], [5, '♭'], [5, ''], [6, '♭'], [6, ''],
];

interface DiatonicChord {
  semis: number;
  third: Third;
  fifth: Fifth;
  seventh: Seventh;
}

function diatonicChords(mode: Mode): DiatonicChord[] {
  const steps = MODE_STEPS[mode];
  const chords = steps.map((root, d) => {
    const iv = (k: number) => mod12(steps[(d + k) % 7] - root);
    const third = iv(2) === 4 ? 'M' : 'm';
    const fifth = iv(4) === 7 ? 'P' : iv(4) === 6 ? 'b5' : '#5';
    const seventh = iv(6) === 10 ? 'b7' : iv(6) === 11 ? 'M7' : 'bb7';
    return { semis: root, third, fifth, seventh } as DiatonicChord;
  });
  if (mode === 'minor') {
    // Dalla minore armonica: V, V7, vii° e vii°7.
    chords.push({ semis: 7, third: 'M', fifth: 'P', seventh: 'b7' });
    chords.push({ semis: 11, third: 'm', fifth: 'b5', seventh: 'bb7' });
  }
  return chords;
}

function modeScale(key: KeyInfo, mode: Mode): number[] {
  const steps = [...MODE_STEPS[mode]];
  // In minore sono comuni anche il VI e il VII alzati (minore melodica/armonica).
  if (mode === 'minor') steps.push(9, 11);
  return steps.map((s) => mod12(s + key.tonic));
}

function fitsDiatonic(chord: ParsedChord, key: KeyInfo, mode: Mode = key.mode): boolean {
  const semis = mod12(chord.root - key.tonic);
  const scale = modeScale(key, mode);
  const inScale = (interval: number) => scale.includes(mod12(chord.root + interval));
  if (chord.sixth && !inScale(9)) return false;
  const dominant = chord.third === 'M' && chord.seventh === 'b7';
  const majorType = chord.third === 'M' && chord.seventh !== 'b7';
  for (const t of chord.tensions) {
    // Tensioni "disponibili" per convenzione jazz: le alterazioni sulle dominanti e
    // la #11 sugli accordi maggiori sono colori, non cambiano la funzione.
    if (dominant && ALTERED.includes(t)) continue;
    if (majorType && t === '#11') continue;
    if (!inScale(TENSION_INTERVAL[t])) return false;
  }
  return diatonicChords(mode).some((d) => {
    if (d.semis !== semis) return false;
    if ((chord.third === 'M' || chord.third === 'm') && chord.third !== d.third) return false;
    if (chord.third === 'sus4' && !inScale(5)) return false;
    if (chord.third === 'sus2' && !inScale(2)) return false;
    if (chord.fifth !== null && chord.fifth !== d.fifth) return false;
    if (chord.seventh !== null && chord.seventh !== d.seventh) return false;
    return true;
  });
}

function degreeNumeral(semis: number, lower: boolean, preferFlatFive = false): string {
  let [step, acc] = DEGREES[mod12(semis)];
  if (semis === 6 && preferFlatFive) {
    step = 4;
    acc = '♭';
  }
  const n = ROMAN[step];
  return acc + (lower ? n.toLowerCase() : n);
}

function isLowerCase(c: ChordShape): boolean {
  return c.third === 'm';
}

/** Suffisso dei gradi romani: ii7, V13, Imaj7, viiø7, vii°7, V7alt, I6/9... */
function romanSuffix(c: ChordShape): string {
  if (c.third === 'm' && c.fifth === 'b5') return c.seventh === 'bb7' ? '°7' : c.seventh === 'b7' ? 'ø7' : '°';
  let aug = c.fifth === '#5' && c.third === 'M' ? '+' : '';
  const t = c.tensions;
  let core = '';
  if (c.seventh === 'M7') core = c.third === 'm' ? '(maj7)' : t.has('13') ? 'maj13' : t.has('9') ? 'maj9' : 'maj7';
  else if (c.seventh === 'b7') {
    const altered = (t.has('b9') || t.has('#9')) && t.has('b13') && !t.has('9') && !t.has('13');
    if (altered || c.alt) return `${aug}7alt`;
    core = t.has('13') ? '13' : t.has('11') && c.third === 'm' ? '11' : t.has('9') ? '9' : '7';
  } else if (c.sixth) core = t.has('9') ? '69' : '6';
  else if (t.has('9')) core = 'add9';
  const sus = c.third === 'sus4' ? 'sus4' : c.third === 'sus2' ? 'sus2' : '';
  const shownTensions: Tension[] =
    core === '13' || core === 'maj13' ? ['9', '13'] : core === '9' || core === 'maj9' || core === 'add9' || core === '69' ? ['9'] : core === '11' ? ['9', '11'] : [];
  const extra = ALTERED.filter((x) => t.has(x) && !shownTensions.includes(x))
    .map((x) => prettyAccidentals(x))
    .join('');
  if (c.third === null) core = core || '5';
  aug = aug && core === '' ? '+' : aug;
  return `${aug}${core}${sus}${extra}`;
}

function inversionFigure(chord: ParsedChord): { figure: string; slash: number | null } {
  if (chord.bass === null || chord.bass === chord.root) return { figure: '', slash: null };
  const interval = mod12(chord.bass - chord.root);
  const tones = chordIntervals({ ...chord, tensions: new Set() });
  if (!tones.has(interval)) return { figure: '', slash: chord.bass };
  const seventh = chord.seventh !== null;
  if (interval === 3 || interval === 4) return { figure: seventh ? '65' : '6', slash: null };
  if (interval === 6 || interval === 7 || interval === 8) return { figure: seventh ? '43' : '64', slash: null };
  if (interval === 9 && chord.seventh === 'bb7') return { figure: '42', slash: null };
  if (interval === 10 || interval === 11) return { figure: '42', slash: null };
  return { figure: '', slash: chord.bass };
}

function withInversion(numeral: string, suffix: string, chord: ParsedChord, key: KeyInfo): string {
  const { figure, slash } = inversionFigure(chord);
  if (figure) {
    // Nei rivolti di settima le cifre sostituiscono il "7".
    const s = chord.seventh && /7$/.test(suffix) && !/maj7$/.test(suffix) ? suffix.slice(0, -1) : suffix;
    return `${numeral}${s}${figure}`;
  }
  if (slash !== null) return `${numeral}${suffix}/${degreeNumeral(mod12(slash - key.tonic), false)}`;
  return `${numeral}${suffix}`;
}

function diatonicFunction(semis: number, key: KeyInfo): HarmonicFunction {
  const major = key.mode === 'major' || key.mode === 'lydian' || key.mode === 'mixolydian';
  if (semis === 0) return 'T';
  if (major) {
    if (semis === 4 || semis === 9) return 'T';
    if (semis === 2 || semis === 5 || semis === 6) return 'SD';
    if (semis === 7 || semis === 11) return 'D';
    if (semis === 10) return 'SD';
    return null;
  }
  if (semis === 3) return 'T';
  if (semis === 2 || semis === 5 || semis === 8 || semis === 10 || semis === 1) return 'SD';
  if (semis === 7 || semis === 11) return 'D';
  return null;
}

function scaleFor(chord: ParsedChord, analysis: Omit<ChordAnalysis, 'scale'>, key: KeyInfo, nextIsMinor: boolean): string | null {
  const t = chord.tensions;
  const semis = mod12(chord.root - key.tonic);
  if (chord.third === 'm' && chord.fifth === 'b5') {
    if (chord.seventh === 'bb7' || analysis.category === 'passing') return 'diminuita (tono-semitono)';
    return t.has('9') || key.mode !== 'major' ? 'locria ♮2' : 'locria';
  }
  if (chord.fifth === '#5' && chord.third === 'M') {
    if (chord.seventh === 'M7') return 'lidia aumentata';
    return 'esatonale (tono intero)';
  }
  if (chord.third === 'sus4' && chord.seventh === 'b7') return t.has('b9') ? 'frigia (sus♭9)' : 'misolidia';
  if (chord.third === 'm') {
    if (chord.seventh === 'M7') return 'minore melodica';
    if (chord.sixth) return 'dorica / minore melodica';
    if (semis === 0) return key.mode === 'dorian' ? 'dorica' : key.mode === 'phrygian' ? 'frigia' : key.mode === 'minor' ? 'eolia (o dorica)' : 'dorica';
    if (analysis.category === 'diatonic' && key.mode === 'major') {
      if (semis === 4) return 'frigia';
      if (semis === 9) return 'eolia';
    }
    return 'dorica';
  }
  if (chord.third === 'M' && chord.seventh === 'M7') {
    if (t.has('#11')) return 'lidia';
    return semis === 0 && (key.mode === 'major' || key.mode === 'lydian') ? (key.mode === 'lydian' ? 'lidia' : 'ionica (o lidia)') : 'lidia';
  }
  if (chord.third === 'M' && chord.seventh === 'b7') {
    if (chord.alt || ((t.has('b9') || t.has('#9')) && t.has('b13'))) return 'alterata (superlocria)';
    if (t.has('b9') && t.has('13')) return 'diminuita (semitono-tono)';
    if (t.has('#11') && !t.has('b9') && !t.has('#9')) return 'lidia dominante (lidia ♭7)';
    if (t.has('b9') || t.has('b13')) return 'misolidia ♭9 ♭13 (frigia dominante)';
    if (t.has('#9')) return 'alterata o blues';
    if (analysis.category === 'substitute' || analysis.category === 'backdoor') return 'lidia dominante (lidia ♭7)';
    if (analysis.resolution === 'fifth') return nextIsMinor ? 'misolidia ♭9 ♭13 (frigia dominante)' : 'misolidia';
    if (analysis.category === 'chromatic' || analysis.category === 'interchange') return 'lidia dominante (lidia ♭7)';
    if (semis === 0) return 'misolidia (o blues)';
    return 'misolidia';
  }
  if (chord.third === 'M') {
    if (chord.sixth || t.has('9')) return 'pentatonica maggiore / ionica';
    if (semis === 5 || analysis.category === 'interchange') return 'lidia';
    return semis === 0 ? 'ionica' : 'ionica / lidia';
  }
  return null;
}

export interface ProgressionItem {
  symbol: string;
  key: KeyInfo;
}

/**
 * Analizza una successione di accordi (in ordine di tempo), ciascuno con la propria
 * tonalità di riferimento. Restituisce un'analisi per accordo (null se la sigla non
 * è leggibile).
 */
export function analyzeProgression(items: ProgressionItem[]): Array<ChordAnalysis | null> {
  const parsed = items.map((it) => parseChord(it.symbol));
  const results: Array<ChordAnalysis | null> = parsed.map(() => null);
  const firstPass: Array<Omit<ChordAnalysis, 'scale'> | null> = parsed.map(() => null);

  const targetNumeral = (next: ParsedChord, key: KeyInfo): string =>
    degreeNumeral(mod12(next.root - key.tonic), isLowerCase(next) || isHalfDim(next) || isDim(next));

  for (let i = 0; i < parsed.length; i++) {
    const chord = parsed[i];
    if (!chord) continue;
    const key = items[i].key;
    const next = parsed[i + 1] ?? null;
    const nextKey = items[i + 1]?.key ?? key;
    const semis = mod12(chord.root - key.tonic);
    const lower = isLowerCase(chord);
    const suffix = romanSuffix(chord);
    const toNext = next ? mod12(next.root - chord.root) : null;
    const nextIsTonic = !!next && mod12(next.root - key.tonic) === 0 && !isDominantShape(next);
    const diatonic = fitsDiatonic(chord, key);
    const dominant = isDominantShape(chord);

    let analysis: Omit<ChordAnalysis, 'scale'> | null = null;

    if (dominant && next && toNext === 5) {
      const isPlainV = semis === 7 && nextIsTonic;
      const base = inversionFigure(chord).slash === null ? withInversion('V', suffix, chord, key) : `V${suffix}`;
      analysis = {
        roman: isPlainV ? base : `${base}/${targetNumeral(next, nextKey)}`,
        category: isPlainV ? 'diatonic' : 'secondary',
        func: 'D',
        resolution: 'fifth',
        iiV: null,
      };
    } else if (dominant && next && toNext === 11) {
      analysis = {
        roman: `SubV${suffix}` + (nextIsTonic ? '' : `/${targetNumeral(next, nextKey)}`),
        category: 'substitute',
        func: 'D',
        resolution: 'halfstep',
        iiV: null,
      };
    } else if (dominant && semis === 10 && nextIsTonic && (key.mode === 'major' || key.mode === 'lydian')) {
      analysis = { roman: withInversion('♭VII', suffix, chord, key), category: 'backdoor', func: 'D', resolution: null, iiV: null };
    } else if (isDim(chord) && next && toNext === 1) {
      const figure = chord.seventh === 'bb7' ? '°7' : '°';
      analysis = {
        roman: `vii${figure}` + (mod12(next.root - key.tonic) === 0 ? '' : `/${targetNumeral(next, nextKey)}`),
        category: diatonic ? 'diatonic' : 'passing',
        func: 'D',
        resolution: 'halfstep',
        iiV: null,
      };
    } else if (isDim(chord) && next && toNext === 0) {
      analysis = { roman: `ct${chord.seventh === 'bb7' ? '°7' : '°'}`, category: 'passing', func: null, resolution: null, iiV: null };
    }

    if (!analysis) {
      const numeral = degreeNumeral(semis, lower || isHalfDim(chord) || isDim(chord), dominant);
      let category: HarmonicCategory = diatonic ? 'diatonic' : 'chromatic';
      let borrowedFrom: Mode | undefined;
      if (!diatonic) {
        const parallel: Mode[] = key.mode === 'major' || key.mode === 'lydian' || key.mode === 'mixolydian'
          ? ['minor', 'dorian', 'mixolydian', 'phrygian', 'lydian']
          : ['major', 'dorian', 'phrygian', 'lydian', 'mixolydian'];
        borrowedFrom = parallel.find((m) => m !== key.mode && fitsDiatonic(chord, key, m));
        if (borrowedFrom) category = 'interchange';
        if (isDim(chord)) category = 'passing';
      }
      analysis = {
        roman: withInversion(numeral, suffix, chord, key),
        category,
        func: category === 'diatonic' ? diatonicFunction(semis, key) : category === 'interchange' ? 'SD' : null,
        resolution: null,
        iiV: null,
        ...(borrowedFrom ? { borrowedFrom } : {}),
      };
    }

    firstPass[i] = analysis;
  }

  // ii correlati: accordo minore (o semidiminuito) seguito dal suo V (o SubV).
  for (let i = 0; i < parsed.length; i++) {
    const chord = parsed[i];
    const next = parsed[i + 1];
    const analysis = firstPass[i];
    if (!chord || !next || !analysis) continue;
    if (!(isMinorShape(chord) || isHalfDim(chord)) || chord.seventh === 'M7' || !isDominantShape(next)) continue;
    const toNext = mod12(next.root - chord.root);
    if (toNext !== 5 && toNext !== 11) continue;
    analysis.iiV = toNext === 5 ? 'iiV' : 'iiSubV';
    const key = items[i].key;
    const target = parsed[i + 2];
    const resolved = firstPass[i + 1]?.resolution === (toNext === 5 ? 'fifth' : 'halfstep');
    // Un ii fuori tonalità il cui V risolve davvero viene letto come "ii del bersaglio";
    // altrimenti (es. iv7 → ♭VII7 → I, il ii-V "backdoor") resta il suo grado.
    if (!fitsDiatonic(chord, key) && resolved && target) {
      analysis.roman = `${withInversion('ii', romanSuffix(chord), chord, key)}/${targetNumeral(target, items[i + 2].key)}`;
      analysis.category = 'related-ii';
      analysis.func = 'SD';
      delete analysis.borrowedFrom;
    }
  }

  for (let i = 0; i < parsed.length; i++) {
    const chord = parsed[i];
    const analysis = firstPass[i];
    if (!chord || !analysis) continue;
    const nextIsMinor = parsed[i + 1]?.third === 'm';
    results[i] = { ...analysis, scale: scaleFor(chord, analysis, items[i].key, nextIsMinor) };
  }
  return results;
}

/** Analisi di un singolo accordo (senza contesto). */
export function romanNumeral(symbol: string, key: KeyInfo, next?: string): string | null {
  const items: ProgressionItem[] = [{ symbol, key }];
  if (next) items.push({ symbol: next, key });
  return analyzeProgression(items)[0]?.roman ?? null;
}

// ---------------------------------------------------------------------------
// Stima della tonalità

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Stima le tonalità più probabili da un istogramma di durate per classe di altezza. */
export function estimateKeys(histogram: number[], max = 3): Array<KeyInfo & { score: number }> {
  if (histogram.every((v) => v === 0)) return [];
  const results: Array<KeyInfo & { score: number }> = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = histogram.map((_, i) => histogram[mod12(i + tonic)]);
    results.push({ tonic, mode: 'major', score: correlation(rotated, KK_MAJOR) });
    results.push({ tonic, mode: 'minor', score: correlation(rotated, KK_MINOR) });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, max);
}
