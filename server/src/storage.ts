import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DataPaths } from './config.js';
import { HttpError } from './http.js';

export class Storage {
  constructor(readonly paths: DataPaths) {}

  async init(): Promise<void> {
    for (const dir of [this.paths.scoresDir, this.paths.audioDir, this.paths.peaksDir, this.paths.tmpDir]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    // Pulisce upload interrotti e cartelle di lavori rimasti a metà.
    for (const entry of await fsp.readdir(this.paths.tmpDir)) {
      await fsp.rm(path.join(this.paths.tmpDir, entry), { force: true, recursive: true });
    }
  }

  /**
   * Salva lo stream di un upload in `dir` con un nome casuale e l'estensione indicata.
   * Se lo stream viene troncato (file troppo grande) il file viene scartato.
   */
  async saveUpload(stream: Readable & { truncated?: boolean }, dir: string, ext: string): Promise<{ fileName: string; size: number }> {
    const fileName = `${crypto.randomUUID()}.${ext}`;
    const tmp = path.join(this.paths.tmpDir, fileName);
    try {
      await pipeline(stream, fs.createWriteStream(tmp, { flags: 'wx' }));
      if (stream.truncated) throw new HttpError(413, 'File troppo grande');
      const { size } = await fsp.stat(tmp);
      if (size === 0) throw new HttpError(400, 'File vuoto');
      await fsp.rename(tmp, path.join(dir, fileName));
      return { fileName, size };
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async remove(dir: string, fileName: string | null | undefined): Promise<void> {
    if (!fileName || fileName.includes('/') || fileName.includes('\\')) return;
    await fsp.rm(path.join(dir, fileName), { force: true });
  }

  peaksFile(audioId: number): string {
    return path.join(this.paths.peaksDir, `${audioId}.json`);
  }
}
