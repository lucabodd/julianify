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

export interface AudioTrack {
  id: number;
  scoreId: number;
  name: string;
  source: AudioSource;
  libraryPath: string | null;
  mime: string | null;
  fileSize: number | null;
  durationMs: number | null;
  syncPoints: FlatSyncPoint[];
  hasPeaks: boolean;
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

export interface ServerInfo {
  version: string;
  musicLibrary: boolean;
  maxUploadMb: number;
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
