import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { User } from '../../shared/types.js';
import type { Database } from './db.js';

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAXMEM = 128 * 1024 * 1024;

export const SESSION_COOKIE = 'julianify_session';
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Hash fittizio usato quando l'utente non esiste, per non rivelarlo dai tempi di risposta.
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('julianify-dummy-password');
  await verifyPassword(password, await dummyHash);
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `La password deve avere almeno ${MIN_PASSWORD_LENGTH} caratteri`;
  }
  if (password.length > 256) return 'Password troppo lunga';
  return null;
}

export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{2,40}$/.test(username)) {
    return 'Nome utente non valido (2-40 caratteri: lettere, numeri, . _ -)';
  }
  return null;
}

export interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  password_hash: string;
  is_admin: number;
  is_enabled: number;
  created_at: string;
  last_login_at: string | null;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly sessionDays: number,
  ) {}

  create(userId: number, userAgent: string | undefined, ip: string | undefined): { token: string; expires: Date } {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + this.sessionDays * 24 * 3600 * 1000);
    this.db.run(
      'INSERT INTO sessions (id, user_id, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
      hashToken(token),
      userId,
      expires.toISOString(),
      new Date().toISOString(),
      (userAgent ?? '').slice(0, 300),
      ip ?? null,
    );
    return { token, expires };
  }

  /** Restituisce l'utente della sessione se valida (e l'utente è abilitato). */
  resolve(token: string | undefined): UserRow | null {
    if (!token) return null;
    const id = hashToken(token);
    const row = this.db.get<UserRow & { expires_at: string; last_seen_at: string | null }>(
      `SELECT u.*, s.expires_at, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      id,
    );
    if (!row) return null;
    const now = Date.now();
    if (Date.parse(row.expires_at) <= now || row.is_enabled !== 1) {
      this.db.run('DELETE FROM sessions WHERE id = ?', id);
      return null;
    }
    // Aggiorna "ultimo accesso" al massimo una volta ogni 10 minuti.
    if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > 10 * 60 * 1000) {
      this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', new Date(now).toISOString(), id);
    }
    return row;
  }

  destroy(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM sessions WHERE id = ?', hashToken(token));
  }

  destroyAllForUser(userId: number, exceptToken?: string): void {
    if (exceptToken) {
      this.db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, hashToken(exceptToken));
    } else {
      this.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
    }
  }

  purgeExpired(): void {
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
  }
}

/**
 * Limita i tentativi di login falliti per IP (finestra scorrevole in memoria).
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(key: string): number[] {
    const now = Date.now();
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(Date.now());
    this.failures.set(key, list);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export async function createUser(
  db: Database,
  input: { username: string; password: string; displayName?: string | null; isAdmin?: boolean },
): Promise<User> {
  const usernameError = validateUsername(input.username);
  if (usernameError) throw new Error(usernameError);
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new Error(passwordError);
  if (db.get('SELECT id FROM users WHERE username = ?', input.username)) {
    throw new Error(`L'utente "${input.username}" esiste già`);
  }
  const hash = await hashPassword(input.password);
  const { lastInsertRowid } = db.run(
    'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)',
    input.username,
    input.displayName?.trim() || null,
    hash,
    input.isAdmin ? 1 : 0,
  );
  return toUser(db.get<UserRow>('SELECT * FROM users WHERE id = ?', lastInsertRowid)!);
}

export async function setUserPassword(db: Database, userId: number, password: string): Promise<void> {
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(passwordError);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), userId);
}
