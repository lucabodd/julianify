// Tipi condivisi tra server e client (API JSON).

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  isAdmin: boolean;
  isEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ScoreSummary {
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  format: string;
  originalFilename: string;
  fileSize: number;
  ownerId: number;
  ownerName: string;
  isOwner: boolean;
  shared: boolean;
  audioCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreDetail extends ScoreSummary {
  audioTracks: AudioTrack[];
}

/**
 * Sync point nello stesso formato di alphaTab (`FlatSyncPoint`): la battuta
 * `barIndex` (0-based), alla sua ripetizione `barOccurence` (0 = prima volta),
 * nella posizione relativa `barPosition` (0..1) coincide con `millisecondOffset`
 * millisecondi della traccia audio.
 */
export interface FlatSyncPoint {
  barIndex: number;
  barOccurence: number;
  barPosition: number;
  millisecondOffset: number;
}

export type AudioSource = 'upload' | 'library';

/** Versioni di una registrazione ottenute separando gli strumenti (Demucs). */
export type AudioVariant =
  | 'no_guitar'
  | 'no_vocals_guitar'
  | 'guitar'
  | 'bass'
  | 'rhythm'
  | 'no_bass'
  | 'no_drums'
  | 'no_piano'
  | 'no_vocals';

export interface AudioVariantInfo {
  label: string;
  description: string;
  /** Strumenti del modello htdemucs_6s da sommare. */
  stems: string[];
}

export const AUDIO_VARIANTS: Record<AudioVariant, AudioVariantInfo> = {
  no_guitar: {
    label: 'Senza chitarra',
    description: 'La base per suonare al posto del chitarrista',
    stems: ['drums', 'bass', 'other', 'vocals', 'piano'],
  },
  no_vocals_guitar: {
    label: 'Senza voce e chitarra',
    description: 'La band da sola, per cantare e suonare insieme',
    stems: ['drums', 'bass', 'other', 'piano'],
  },
  guitar: { label: 'Solo chitarra', description: 'Per ascoltare e trascrivere la parte', stems: ['guitar'] },
  bass: { label: 'Solo basso', description: 'Le fondamentali: utile per l\'analisi armonica', stems: ['bass'] },
  rhythm: { label: 'Basso e batteria', description: 'La sezione ritmica', stems: ['drums', 'bass'] },
  no_bass: { label: 'Senza basso', description: '', stems: ['drums', 'other', 'vocals', 'guitar', 'piano'] },
  no_drums: { label: 'Senza batteria', description: '', stems: ['bass', 'other', 'vocals', 'guitar', 'piano'] },
  no_piano: { label: 'Senza pianoforte', description: '', stems: ['drums', 'bass', 'other', 'vocals', 'guitar'] },
  no_vocals: { label: 'Senza voce', description: '', stems: ['drums', 'bass', 'other', 'guitar', 'piano'] },
};

export const AUDIO_VARIANT_ORDER = Object.keys(AUDIO_VARIANTS) as AudioVariant[];

export function isAudioVariant(value: unknown): value is AudioVariant {
  return typeof value === 'string' && Object.hasOwn(AUDIO_VARIANTS, value);
}

export interface AudioTrack {
  id: number;
  scoreId: number;
  name: string;
  source: AudioSource;
  libraryPath: string | null;
  mime: string | null;
  fileSize: number | null;
  durationMs: number | null;
  /** Per le versioni separate sono quelli della registrazione originale (condivisi). */
  syncPoints: FlatSyncPoint[];
  hasPeaks: boolean;
  /** Registrazione originale da cui è stata ricavata questa versione. */
  parentId: number | null;
  variant: AudioVariant | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaveformPeaks {
  duration: number;
  peaks: number[];
}

export type AnnotationKind = 'chord' | 'section' | 'key' | 'note';

export interface Annotation {
  id: number;
  scoreId: number;
  barIndex: number;
  /** Posizione relativa all'interno della battuta (0..1). */
  position: number;
  kind: AnnotationKind;
  text: string;
  /** Analisi armonica manuale (es. "V7/V"); se assente viene calcolata dalla tonalità. */
  analysis: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationInput {
  barIndex: number;
  position: number;
  kind: AnnotationKind;
  text: string;
  analysis?: string | null;
  color?: string | null;
}

export interface SavedLoop {
  id: number;
  scoreId: number;
  name: string;
  startTick: number;
  endTick: number;
  startBar: number;
  endBar: number;
  speed: number;
  createdAt: string;
}

export interface SavedLoopInput {
  name: string;
  startTick: number;
  endTick: number;
  startBar: number;
  endBar: number;
  speed: number;
}

export interface ScorePrefs {
  audioId?: number | null;
  speed?: number;
  volume?: number;
  trackIndexes?: number[];
  zoom?: number;
  layout?: 'page' | 'horizontal';
  staveProfile?: 'default' | 'tab' | 'score' | 'mixed';
  showWaveform?: boolean;
  showAnnotations?: boolean;
  showAnalysis?: boolean;
}

export interface LibraryEntry {
  name: string;
  /** Percorso relativo alla radice della libreria musicale. */
  path: string;
  type: 'dir' | 'file';
  size?: number;
}

export interface LibraryListing {
  enabled: boolean;
  path: string;
  entries: LibraryEntry[];
  truncated?: boolean;
}

export interface WorkerInfo {
  /** Il worker Python viene interrogato all'avvio del server. */
  status: 'detecting' | 'ready' | 'unavailable' | 'disabled';
  stems: boolean;
  autosync: boolean;
  /** Perché non è disponibile (o avvisi, es. modello non ancora scaricato). */
  message: string | null;
  device: string | null;
  threads: number | null;
}

export interface ServerInfo {
  version: string;
  musicLibrary: boolean;
  maxUploadMb: number;
  worker: WorkerInfo;
}

export type JobKind = 'stems' | 'autosync';
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';

export interface Job<P = unknown, R = unknown> {
  id: number;
  kind: JobKind;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  message: string | null;
  error: string | null;
  scoreId: number | null;
  audioId: number | null;
  params: P;
  result: R | null;
  /** Lavori davanti a questo nella coda (solo se in attesa). */
  queuePosition: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StemsJobParams {
  variants: AudioVariant[];
}

export interface StemsJobResult {
  audioIds: number[];
}

export type AutoSyncGranularity = 'bar' | 'beat';

/** Richiesta di sincronizzazione automatica preparata dal client. */
export interface AutoSyncRequest {
  /** Note dello spartito: [inizio s, durata s, altezza MIDI, velocity], al tempo scritto. */
  notes: Array<[number, number, number, number]>;
  /** Istanti dello spartito (s) da collocare nella registrazione. */
  targets: number[];
  /** Punti corrispondenti a `targets`: [battuta, ripetizione, posizione 0..1). */
  points: Array<[number, number, number]>;
  scoreDuration: number;
  /** Sync point già noti: [ms nella registrazione, s nello spartito]. */
  anchors: Array<[number, number]>;
  fromOrder: number;
  toOrder: number;
  granularity: AutoSyncGranularity;
  /** Traccia da analizzare al posto di quella sincronizzata (es. la chitarra isolata). */
  analyzeAudioId?: number | null;
}

export type AutoSyncJobParams = Omit<AutoSyncRequest, 'notes' | 'targets' | 'anchors'> & {
  noteCount: number;
  anchorCount: number;
};

export interface AutoSyncResult {
  /** Istanti (ms) nella registrazione, uno per punto. */
  times: number[];
  /** Somiglianza tra audio e spartito attorno a ogni punto (0..1). */
  confidence: Array<number | null>;
  /** Somiglianza media: sotto 0,7 circa l'allineamento è poco affidabile. */
  quality: number | null;
  /** Indici dei punti probabilmente da controllare. */
  suspicious: number[];
  /** Punti agganciati a un attacco della registrazione. */
  refined: number;
  tuningCents: number;
  transposition: number;
  anchorsUsed: number;
  audioStartMs: number;
  audioEndMs: number;
  audioDurationMs: number;
}

export const SCORE_EXTENSIONS = ['gp3', 'gp4', 'gp5', 'gpx', 'gp', 'xml', 'musicxml', 'mxl', 'capx'] as const;
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'mp4', 'ogg', 'oga', 'opus', 'flac', 'wav', 'webm'] as const;

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isScoreFile(name: string): boolean {
  return (SCORE_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

export function isAudioFile(name: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}
