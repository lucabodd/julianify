import type { LoginRateLimiter, SessionStore } from './auth.js';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { MusicLibrary } from './library.js';
import type { Storage } from './storage.js';

export interface AppContext {
  config: Config;
  db: Database;
  storage: Storage;
  sessions: SessionStore;
  loginLimiter: LoginRateLimiter;
  library: MusicLibrary | null;
  version: string;
}
