import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerInfo } from '../../../shared/types.js';
import { SESSION_COOKIE, burnPasswordCheck, setUserPassword, toUser, verifyPassword, type UserRow } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, body, requireUser } from '../http.js';

export function sessionCookieOptions(ctx: AppContext, request: FastifyRequest) {
  const secure = ctx.config.cookieSecure || (ctx.config.trustProxy && request.protocol === 'https');
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = body(request);
    const username = typeof data.username === 'string' ? data.username.trim() : '';
    const password = typeof data.password === 'string' ? data.password : '';
    if (!username || !password) throw badRequest('Inserisci nome utente e password');

    const limiterKey = request.ip;
    if (ctx.loginLimiter.isBlocked(limiterKey)) {
      throw new HttpError(429, 'Troppi tentativi falliti: riprova tra qualche minuto');
    }

    const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    const valid = row ? await verifyPassword(password, row.password_hash) : (await burnPasswordCheck(password), false);
    if (!row || !valid || row.is_enabled !== 1) {
      ctx.loginLimiter.fail(limiterKey);
      throw new HttpError(401, row && valid ? 'Utente disabilitato' : 'Credenziali non valide');
    }
    ctx.loginLimiter.reset(limiterKey);

    const { token, expires } = ctx.sessions.create(row.id, request.headers['user-agent'], request.ip);
    ctx.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), row.id);
    reply.setCookie(SESSION_COOKIE, token, { ...sessionCookieOptions(ctx, request), expires });
    return { user: toUser({ ...row, last_login_at: new Date().toISOString() }) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    ctx.sessions.destroy(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(ctx, request));
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    return { user: toUser(requireUser(request)) };
  });

  app.post('/api/auth/password', async (request) => {
    const user = requireUser(request);
    const data = body(request);
    const current = typeof data.currentPassword === 'string' ? data.currentPassword : '';
    const next = typeof data.newPassword === 'string' ? data.newPassword : '';
    if (!(await verifyPassword(current, user.password_hash))) throw badRequest('La password attuale non è corretta');
    try {
      await setUserPassword(ctx.db, user.id, next);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    // Chiude le altre sessioni aperte con la vecchia password.
    ctx.sessions.destroyAllForUser(user.id, request.cookies[SESSION_COOKIE]);
    return { ok: true };
  });

  app.get('/api/info', async (request): Promise<ServerInfo> => {
    requireUser(request);
    return {
      version: ctx.version,
      musicLibrary: ctx.library !== null,
      maxUploadMb: ctx.config.maxUploadMb,
      worker: ctx.jobs.info,
    };
  });
}
