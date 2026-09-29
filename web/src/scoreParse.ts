export interface ParsedScoreInfo {
  title: string;
  artist: string;
  album: string;
  tracks: string[];
  bars: number;
  tempo: number;
}

/** Legge un file di spartito nel browser con alphaTab per validarlo ed estrarre i metadati. */
export async function parseScoreFile(file: File): Promise<ParsedScoreInfo> {
  const alphaTab = await import('@coderline/alphatab');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const settings = new alphaTab.Settings();
  let score;
  try {
    score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  } catch {
    throw new Error(`"${file.name}" non è uno spartito leggibile (Guitar Pro, MusicXML o Capella)`);
  }
  return {
    title: score.title?.trim() ?? '',
    artist: score.artist?.trim() ?? '',
    album: score.album?.trim() ?? '',
    tracks: score.tracks.map((t) => t.name || t.shortName || `Traccia ${t.index + 1}`),
    bars: score.masterBars.length,
    tempo: score.tempo,
  };
}
