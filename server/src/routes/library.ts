import type { FastifyInstance } from 'fastify';
import type { LibraryListing } from '../../../shared/types.js';
import type { AppContext } from '../context.js';
import { HttpError, requireUser } from '../http.js';

export function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/library/browse', async (request): Promise<LibraryListing> => {
    requireUser(request);
    if (!ctx.library) return { enabled: false, path: '', entries: [] };
    const { path = '' } = request.query as { path?: string };
    const result = await ctx.library.browse(path);
    return { enabled: true, ...result };
  });

  app.get('/api/library/search', async (request): Promise<LibraryListing> => {
    requireUser(request);
    if (!ctx.library) return { enabled: false, path: '', entries: [] };
    const { q = '' } = request.query as { q?: string };
    const result = await ctx.library.search(String(q).slice(0, 200));
    return { enabled: true, path: '', ...result };
  });

  // Anteprima di un file della libreria prima di associarlo a uno spartito.
  app.get('/api/library/stream', async (request, reply) => {
    requireUser(request);
    if (!ctx.library) throw new HttpError(404, 'Libreria musicale non configurata');
    const { path = '' } = request.query as { path?: string };
    const info = await ctx.library.statAudio(path);
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    return reply.sendFile(info.rel, ctx.library.root);
  });
}
