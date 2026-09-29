import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { LoginRateLimiter, SESSION_COOKIE, SessionStore } from './auth.js';
import { dataPaths, type Config } from './config.js';
import type { AppContext } from './context.js';
import { Database } from './db.js';
import { HttpError } from './http.js';
import { MusicLibrary } from './library.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerNotesRoutes } from './routes/notes.js';
import { registerScoreRoutes } from './routes/scores.js';
import { registerUserRoutes } from './routes/users.js';
import { Storage } from './storage.js';

/** Richieste API accessibili senza sessione. */
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout']);
/** Header obbligatorio per le richieste che modificano dati (protezione CSRF). */
export const CSRF_HEADER = 'x-julianify';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function readVersion(): string {
  for (const candidate of ['../../../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, candidate), 'utf8'));
      if (pkg.name === 'julianify') return String(pkg.version);
    } catch {
      // prova il prossimo
    }
  }
  return 'dev';
}

export async function buildApp(config: Config, options: { logger?: boolean } = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const paths = dataPaths(config);
  const db = new Database(paths.dbFile);
  const storage = new Storage(paths);
  await storage.init();

  let library: MusicLibrary | null = null;
  if (config.musicDir) {
    let problem: string | null = null;
    try {
      if (!fs.statSync(config.musicDir).isDirectory()) problem = 'non è una cartella';
      else fs.accessSync(config.musicDir, fs.constants.R_OK | fs.constants.X_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      problem =
        code === 'ENOENT'
          ? 'non trovata'
          : code === 'EACCES'
            ? "non leggibile dall'utente del servizio (permessi? in un LXC non privilegiato i file devono essere leggibili da tutti)"
            : String(code ?? err);
    }
    if (problem) console.warn(`[julianify] Libreria musicale disattivata: ${config.musicDir} ${problem}`);
    else library = new MusicLibrary(config.musicDir);
  }

  const ctx: AppContext = {
    config,
    db,
    storage,
    sessions: new SessionStore(db, config.sessionDays),
    loginLimiter: new LoginRateLimiter(),
    library,
    version: readVersion(),
  };

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 20 },
  });

  const webIndex = path.join(config.webDir, 'index.html');
  const serveWeb = fs.existsSync(webIndex);
  if (!serveWeb) app.log.warn(`Frontend non trovato in ${config.webDir}: esegui "npm run build"`);
  await app.register(fastifyStatic, {
    root: serveWeb ? config.webDir : paths.tmpDir,
    serve: serveWeb,
    index: 'index.html',
    setHeaders(reply, filePath) {
      // Le risorse audio/spartiti impostano da sé la cache; qui solo i file del frontend.
      if (!filePath.startsWith(config.webDir)) return;
      const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
      reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers[CSRF_HEADER] !== '1') {
      throw new HttpError(403, 'Richiesta rifiutata (header di sicurezza mancante)');
    }
    request.user = ctx.sessions.resolve(request.cookies[SESSION_COOKIE]);
    if (!request.user && !PUBLIC_API.has(url)) throw new HttpError(401, 'Accesso richiesto');
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) {
      reply.header('Content-Security-Policy', CSP);
      reply.header('X-Frame-Options', 'DENY');
    }
    return payload;
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      reply.status(500).send({ error: 'Errore interno del server' });
    } else {
      const message =
        error.code === 'FST_REQ_FILE_TOO_LARGE' || status === 413
          ? `File troppo grande (massimo ${config.maxUploadMb} MB)`
          : error.message;
      reply.status(status).send({ error: message });
    }
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.status(404).send({ error: 'Risorsa non trovata' });
    } else if (serveWeb && request.method === 'GET') {
      // Il frontend usa il routing con hash: qualsiasi altro percorso torna all'app.
      reply.header('Cache-Control', 'no-cache');
      reply.sendFile('index.html');
    } else {
      reply.status(404).send('Not found');
    }
  });

  registerAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerScoreRoutes(app, ctx);
  registerAudioRoutes(app, ctx);
  registerNotesRoutes(app, ctx);
  registerLibraryRoutes(app, ctx);

  const purgeTimer = setInterval(() => ctx.sessions.purgeExpired(), 6 * 3600 * 1000);
  purgeTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
    db.close();
  });

  return { app, ctx };
}
