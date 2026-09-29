import type { FastifyInstance } from 'fastify';
import { createUser, setUserPassword, toUser, type UserRow } from '../auth.js';
import { deleteUserWithContent } from '../content.js';
import type { AppContext } from '../context.js';
import { badRequest, body, notFound, optionalString, parseId, requireAdmin } from '../http.js';

function countOtherActiveAdmins(ctx: AppContext, userId: number): number {
  return ctx.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_enabled = 1 AND id <> ?',
    userId,
  )!.n;
}

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/users', async (request) => {
    requireAdmin(request);
    const rows = ctx.db.all<UserRow>('SELECT * FROM users ORDER BY username COLLATE NOCASE');
    return { users: rows.map(toUser) };
  });

  app.post('/api/users', async (request) => {
    requireAdmin(request);
    const data = body(request);
    try {
      const user = await createUser(ctx.db, {
        username: String(data.username ?? '').trim(),
        password: String(data.password ?? ''),
        displayName: optionalString(data.displayName, 'displayName', 80) ?? null,
        isAdmin: data.isAdmin === true,
      });
      return { user };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  app.patch('/api/users/:id', async (request) => {
    const admin = requireAdmin(request);
    const id = parseId((request.params as { id: string }).id);
    const target = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!target) throw notFound('Utente non trovato');
    const data = body(request);

    const displayName = optionalString(data.displayName, 'displayName', 80);
    if (displayName !== undefined) ctx.db.run('UPDATE users SET display_name = ? WHERE id = ?', displayName, id);

    const losingAdmin =
      (data.isAdmin === false && target.is_admin === 1) || (data.isEnabled === false && target.is_admin === 1);
    if (losingAdmin && countOtherActiveAdmins(ctx, id) === 0) {
      throw badRequest('Deve rimanere almeno un amministratore attivo');
    }
    if (id === admin.id && (data.isEnabled === false || data.isAdmin === false)) {
      throw badRequest('Non puoi disabilitare o declassare il tuo stesso account');
    }
    if (typeof data.isAdmin === 'boolean') ctx.db.run('UPDATE users SET is_admin = ? WHERE id = ?', data.isAdmin ? 1 : 0, id);
    if (typeof data.isEnabled === 'boolean') {
      ctx.db.run('UPDATE users SET is_enabled = ? WHERE id = ?', data.isEnabled ? 1 : 0, id);
      if (!data.isEnabled) ctx.sessions.destroyAllForUser(id);
    }
    if (data.password !== undefined) {
      try {
        await setUserPassword(ctx.db, id, String(data.password));
      } catch (err) {
        throw badRequest((err as Error).message);
      }
      if (id !== admin.id) ctx.sessions.destroyAllForUser(id);
    }
    return { user: toUser(ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!) };
  });

  app.delete('/api/users/:id', async (request) => {
    const admin = requireAdmin(request);
    const id = parseId((request.params as { id: string }).id);
    if (id === admin.id) throw badRequest('Non puoi eliminare il tuo stesso account');
    const target = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!target) throw notFound('Utente non trovato');
    if (target.is_admin === 1 && countOtherActiveAdmins(ctx, id) === 0) {
      throw badRequest('Deve rimanere almeno un amministratore attivo');
    }
    await deleteUserWithContent(ctx, id);
    return { ok: true };
  });
}
