// Avvia in sviluppo il server (con ricarica automatica) e Vite in parallelo.
// Il frontend è su http://localhost:5173 e inoltra /api al server su :8080.
import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  JULIANIFY_DATA_DIR: process.env.JULIANIFY_DATA_DIR ?? './data',
  JULIANIFY_HOST: process.env.JULIANIFY_HOST ?? '127.0.0.1',
  JULIANIFY_LOG_LEVEL: process.env.JULIANIFY_LOG_LEVEL ?? 'warn',
};

const children = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit', env, shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit', env, shell: process.platform === 'win32' }),
];

let exiting = false;
const stop = (code = 0) => {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};

for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
