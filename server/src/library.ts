import fsp from 'node:fs/promises';
import path from 'node:path';
import { isAudioFile, type LibraryEntry } from '../../shared/types.js';
import { HttpError } from './http.js';

const INDEX_TTL_MS = 10 * 60 * 1000;
const MAX_INDEXED_FILES = 300_000;
const MAX_RESULTS = 200;

const collator = new Intl.Collator('it', { numeric: true, sensitivity: 'base' });

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Accesso in sola lettura alla libreria musicale configurata con JULIANIFY_MUSIC_DIR
 * (es. /mnt/data/music): navigazione per cartelle, ricerca per nome e risoluzione
 * sicura dei percorsi relativi.
 */
export class MusicLibrary {
  private index: { files: string[]; normalized: string[]; builtAt: number } | null = null;
  private building: Promise<void> | null = null;

  constructor(readonly root: string) {}

  /** Converte un percorso relativo in assoluto, impedendo di uscire dalla radice. */
  resolve(relPath: string): string {
    const cleaned = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(this.root, cleaned);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new HttpError(400, 'Percorso non valido');
    }
    const segments = cleaned.split('/').filter(Boolean);
    if (segments.some((s) => s.startsWith('.'))) throw new HttpError(400, 'Percorso non valido');
    return full;
  }

  relative(full: string): string {
    return path.relative(this.root, full).split(path.sep).join('/');
  }

  async browse(relPath: string): Promise<{ path: string; entries: LibraryEntry[] }> {
    const dir = this.resolve(relPath);
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      throw new HttpError(404, 'Cartella non trovata');
    }
    const entries: LibraryEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      let isDir = d.isDirectory();
      let isFile = d.isFile();
      if (d.isSymbolicLink()) {
        const stat = await fsp.stat(full).catch(() => null);
        isDir = !!stat?.isDirectory();
        isFile = !!stat?.isFile();
      }
      if (isDir) entries.push({ name: d.name, path: this.relative(full), type: 'dir' });
      else if (isFile && isAudioFile(d.name)) {
        const stat = await fsp.stat(full).catch(() => null);
        entries.push({ name: d.name, path: this.relative(full), type: 'file', size: stat?.size });
      }
    }
    entries.sort((a, b) => (a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'dir' ? -1 : 1));
    return { path: this.relative(dir), entries };
  }

  async search(query: string): Promise<{ entries: LibraryEntry[]; truncated: boolean }> {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { entries: [], truncated: false };
    const index = await this.getIndex();
    const entries: LibraryEntry[] = [];
    let truncated = false;
    for (let i = 0; i < index.files.length; i++) {
      const haystack = index.normalized[i];
      if (tokens.every((t) => haystack.includes(t))) {
        if (entries.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
        const rel = index.files[i];
        entries.push({ name: rel.slice(rel.lastIndexOf('/') + 1), path: rel, type: 'file' });
      }
    }
    return { entries, truncated };
  }

  /** Verifica che il percorso indichi un file audio esistente e ne restituisce le info. */
  async statAudio(relPath: string): Promise<{ full: string; rel: string; size: number }> {
    const full = this.resolve(relPath);
    if (!isAudioFile(full)) throw new HttpError(400, 'Formato audio non supportato');
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(404, 'File audio non trovato nella libreria');
    return { full, rel: this.relative(full), size: stat.size };
  }

  private async getIndex(): Promise<{ files: string[]; normalized: string[] }> {
    const stale = !this.index || Date.now() - this.index.builtAt > INDEX_TTL_MS;
    if (stale) {
      this.building ??= this.buildIndex().finally(() => {
        this.building = null;
      });
      // Se esiste già un indice (anche vecchio) lo usiamo subito e aggiorniamo in background.
      if (!this.index) await this.building;
    }
    return this.index ?? { files: [], normalized: [] };
  }

  private async buildIndex(): Promise<void> {
    const files: string[] = [];
    const stack = [this.root];
    const visited = new Set<string>();
    while (stack.length > 0 && files.length < MAX_INDEXED_FILES) {
      const dir = stack.pop()!;
      const real = await fsp.realpath(dir).catch(() => null);
      if (!real || visited.has(real)) continue;
      visited.add(real);
      const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory() || (d.isSymbolicLink() && (await fsp.stat(full).catch(() => null))?.isDirectory())) {
          stack.push(full);
        } else if (isAudioFile(d.name)) {
          files.push(this.relative(full));
        }
      }
    }
    files.sort(collator.compare);
    this.index = { files, normalized: files.map(normalize), builtAt: Date.now() };
  }
}
