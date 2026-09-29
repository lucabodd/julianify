import fs from 'node:fs';
import path from 'node:path';

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Variabile ${name} non valida: ${value}`);
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'si', 'sì'].includes(value.toLowerCase());
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Cartella con la build del frontend (index.html + assets). */
  webDir: string;
  /** Cartella (sola lettura) con la libreria musicale da cui scegliere le tracce audio. */
  musicDir: string | null;
  maxUploadMb: number;
  sessionDays: number;
  /** Cookie `Secure`: da attivare se l'app è servita in HTTPS (es. dietro reverse proxy). */
  cookieSecure: boolean;
  /** Fidarsi degli header X-Forwarded-* (reverse proxy davanti all'app). */
  trustProxy: boolean;
  adminUser: string | null;
  adminPassword: string | null;
  logLevel: string;
}

function defaultWebDir(): string {
  const candidates = [
    // build: dist/server/src/config.js -> dist/web
    path.join(import.meta.dirname, '../../web'),
    // sviluppo con tsx dopo `npm run build:web`
    path.resolve('dist/web'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? candidates[0];
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const musicDir = process.env.JULIANIFY_MUSIC_DIR;
  const config: Config = {
    host: envString('JULIANIFY_HOST', '0.0.0.0'),
    port: envInt('JULIANIFY_PORT', 8080),
    dataDir: envString('JULIANIFY_DATA_DIR', './data'),
    webDir: envString('JULIANIFY_WEB_DIR', defaultWebDir()),
    musicDir: musicDir ? musicDir : null,
    maxUploadMb: envInt('JULIANIFY_MAX_UPLOAD_MB', 300),
    sessionDays: envInt('JULIANIFY_SESSION_DAYS', 30),
    cookieSecure: envBool('JULIANIFY_COOKIE_SECURE', false),
    trustProxy: envBool('JULIANIFY_TRUST_PROXY', false),
    adminUser: process.env.JULIANIFY_ADMIN_USER || null,
    adminPassword: process.env.JULIANIFY_ADMIN_PASSWORD || null,
    logLevel: envString('JULIANIFY_LOG_LEVEL', 'info'),
    ...overrides,
  };
  config.dataDir = path.resolve(config.dataDir);
  config.webDir = path.resolve(config.webDir);
  config.musicDir = config.musicDir ? path.resolve(config.musicDir) : null;
  return config;
}

export interface DataPaths {
  dbFile: string;
  scoresDir: string;
  audioDir: string;
  peaksDir: string;
  tmpDir: string;
}

export function dataPaths(config: Config): DataPaths {
  return {
    dbFile: path.join(config.dataDir, 'julianify.db'),
    scoresDir: path.join(config.dataDir, 'scores'),
    audioDir: path.join(config.dataDir, 'audio'),
    peaksDir: path.join(config.dataDir, 'peaks'),
    tmpDir: path.join(config.dataDir, 'tmp'),
  };
}
