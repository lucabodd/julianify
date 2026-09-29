import type { FastifyRequest } from 'fastify';
import { fileExtension } from '../../shared/types.js';
import type { AppContext } from './context.js';
import { HttpError, badRequest } from './http.js';

export interface UploadedFile {
  fileName: string;
  size: number;
  originalName: string;
  ext: string;
  mimetype: string;
}

/**
 * Legge una richiesta multipart con un solo file (campo "file") e campi testuali.
 * Il file viene salvato in `dir`; in caso di errore non resta nulla su disco.
 */
export async function readSingleFileUpload(
  ctx: AppContext,
  request: FastifyRequest,
  dir: string,
  isAllowed: (fileName: string) => boolean,
  formatError: string,
): Promise<{ fields: Record<string, string>; file: UploadedFile }> {
  if (!request.isMultipart()) throw badRequest('Richiesta multipart attesa');
  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;
  try {
    for await (const part of request.parts({ limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024, files: 1 } })) {
      if (part.type === 'file') {
        const originalName = (part.filename ?? '').split(/[\\/]/).pop() ?? '';
        if (part.fieldname !== 'file' || !originalName || !isAllowed(originalName)) {
          part.file.resume();
          throw badRequest(formatError);
        }
        const ext = fileExtension(originalName);
        const saved = await ctx.storage.saveUpload(part.file, dir, ext);
        file = { ...saved, originalName, ext, mimetype: part.mimetype };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    if (file) await ctx.storage.remove(dir, file.fileName);
    if (err instanceof HttpError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
      throw new HttpError(413, `File troppo grande (massimo ${ctx.config.maxUploadMb} MB)`);
    }
    throw err;
  }
  if (!file) throw badRequest('Nessun file ricevuto');
  return { fields, file };
}
