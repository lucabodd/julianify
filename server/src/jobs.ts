// Coda dei lavori pesanti affidati al worker Python (separazione degli
// strumenti, sincronizzazione automatica). Un lavoro alla volta: sono lavori
// che usano tutta la CPU. Stato e avanzamento stanno nella tabella `jobs`, così
// il client li segue con semplici richieste GET anche dopo un ricaricamento.
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { Job, JobKind, JobStatus, WorkerInfo } from '../../shared/types.js';
import type { Config, DataPaths } from './config.js';
import type { Database } from './db.js';

export interface JobRow {
  id: number;
  kind: JobKind;
  user_id: number;
  score_id: number | null;
  audio_id: number | null;
  status: JobStatus;
  progress: number;
  message: string | null;
  params: string;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobSpec {
  kind: JobKind;
  userId: number;
  scoreId: number | null;
  audioId: number | null;
  /** Parametri salvati con il lavoro e restituiti al client. */
  params: unknown;
  /** Comando del worker e relativi parametri; `workDir` è una cartella riservata al lavoro. */
  command(workDir: string): { command: string; params: unknown };
  /** Elabora l'esito del worker; il valore restituito diventa il risultato del lavoro. */
  finish(output: unknown, workDir: string): Promise<unknown> | unknown;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

interface ExecOptions {
  timeoutMs?: number;
  onSpawn?: (child: ChildProcess) => void;
  onProgress?: (progress: number, message: string | null) => void;
}

/** Il worker ha segnalato un errore o si è interrotto. */
export class WorkerFailure extends Error {}

const KEEP_FINISHED_DAYS = 30;
const PROGRESS_WRITE_MS = 1000;
const KILL_GRACE_MS = 10_000;

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function terminate(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS).unref();
}

export class JobRunner {
  info: WorkerInfo;
  private readonly queue: Array<{ id: number; spec: JobSpec }> = [];
  private running: { id: number; spec: JobSpec; child: ChildProcess | null; canceled: boolean; done: Promise<void> } | null = null;
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly paths: DataPaths,
    private readonly log: Logger,
  ) {
    this.info = config.workerPython
      ? { status: 'detecting', stems: false, autosync: false, message: 'Verifica del worker in corso…', device: null, threads: null }
      : {
          status: 'disabled',
          stems: false,
          autosync: false,
          message: 'Worker Python non installato: separazione degli strumenti e sincronizzazione automatica non disponibili.',
          device: null,
          threads: null,
        };
    const now = new Date().toISOString();
    db.run(
      `UPDATE jobs SET status = 'error', error = 'Interrotto dal riavvio del server', finished_at = ?
       WHERE status IN ('queued', 'running')`,
      now,
    );
    db.run('DELETE FROM jobs WHERE finished_at < ?', new Date(Date.now() - KEEP_FINISHED_DAYS * 86_400_000).toISOString());
  }

  /** Variabili d'ambiente del worker: modelli e cache nella cartella dati. */
  private env(): NodeJS.ProcessEnv {
    const env = process.env;
    return {
      ...env,
      PYTHONUNBUFFERED: '1',
      HF_HOME: env.HF_HOME || path.join(this.paths.modelsDir, 'huggingface'),
      HF_HUB_DISABLE_TELEMETRY: '1',
      TORCH_HOME: env.TORCH_HOME || path.join(this.paths.modelsDir, 'torch'),
      NUMBA_CACHE_DIR: env.NUMBA_CACHE_DIR || path.join(this.paths.cacheDir, 'numba'),
      MPLCONFIGDIR: env.MPLCONFIGDIR || path.join(this.paths.cacheDir, 'matplotlib'),
    };
  }

  /** Esegue un comando del worker e restituisce il suo risultato. */
  exec(command: string, params: unknown, options: ExecOptions = {}): Promise<unknown> {
    const python = this.config.workerPython;
    if (!python) return Promise.reject(new WorkerFailure('Worker Python non configurato'));
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'julianify_worker', command], {
        cwd: this.config.workerDir,
        env: this.env(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      options.onSpawn?.(child);
      const stderr: string[] = [];
      let result: unknown;
      let hasResult = false;
      let failure: string | null = null;
      let spawnError: Error | null = null;

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let message: { type?: string; progress?: unknown; message?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type === 'progress') {
          const value = Number(message.progress);
          options.onProgress?.(Number.isFinite(value) ? value : 0, typeof message.message === 'string' ? message.message : null);
        } else if (message.type === 'result') {
          result = message.result;
          hasResult = true;
        } else if (message.type === 'error') {
          failure = String(message.error ?? 'Errore del worker');
        }
      });
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        stderr.push(line);
        if (stderr.length > 50) stderr.shift();
      });

      const timer = options.timeoutMs
        ? setTimeout(() => {
            failure = 'Tempo massimo superato';
            terminate(child);
          }, options.timeoutMs)
        : null;
      timer?.unref();

      child.on('error', (err) => {
        spawnError = err;
      });
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (spawnError) {
          reject(new WorkerFailure(`Impossibile avviare il worker (${python}): ${spawnError.message}`));
        } else if (hasResult && code === 0) {
          resolve(result);
        } else {
          if (!failure && stderr.length > 0) this.log.warn(`[worker ${command}] ${stderr.slice(-15).join('\n')}`);
          reject(new WorkerFailure(failure ?? (signal ? `Worker interrotto (${signal})` : `Il worker è terminato con codice ${code}`)));
        }
      });
      child.stdin.on('error', () => {
        // il worker può chiudersi prima di leggere i parametri: l'errore arriva da 'close'
      });
      child.stdin.end(JSON.stringify(params ?? {}));
    });
  }

  /** Interroga il worker per sapere quali funzioni sono disponibili. */
  async detect(): Promise<void> {
    if (!this.config.workerPython) return;
    try {
      const info = (await this.exec('info', {}, { timeoutMs: 180_000 })) as {
        features?: Record<string, { ok?: boolean; error?: string }>;
        models?: Record<string, boolean>;
        device?: string;
        threads?: number;
      };
      const stems = info.features?.stems?.ok === true;
      const autosync = info.features?.autosync?.ok === true;
      const problems = Object.values(info.features ?? {})
        .filter((f) => f.ok !== true && f.error)
        .map((f) => f.error);
      if (stems && info.models && Object.values(info.models).some((ready) => !ready)) {
        problems.push('Il modello Demucs verrà scaricato al primo utilizzo (serve Internet, circa 80 MB).');
      }
      this.info = {
        status: stems || autosync ? 'ready' : 'unavailable',
        stems,
        autosync,
        message: problems.length > 0 ? problems.join(' ') : null,
        device: info.device ?? null,
        threads: typeof info.threads === 'number' ? info.threads : null,
      };
      this.log.info(
        `Worker Python: ${[stems && 'separazione strumenti', autosync && 'sincronizzazione automatica'].filter(Boolean).join(', ') || 'nessuna funzione disponibile'}` +
          (this.info.message ? ` (${this.info.message})` : ''),
      );
    } catch (err) {
      this.info = {
        status: 'unavailable',
        stems: false,
        autosync: false,
        message: `Worker Python non avviabile: ${(err as Error).message}`,
        device: null,
        threads: null,
      };
      this.log.warn(this.info.message!);
    }
  }

  toJob(row: JobRow): Job {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      progress: row.progress,
      message: row.message,
      error: row.error,
      scoreId: row.score_id,
      audioId: row.audio_id,
      params: parseJson(row.params),
      result: parseJson(row.result),
      queuePosition: this.queuePosition(row.id),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  get(id: number): JobRow | undefined {
    return this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
  }

  /** Lavori davanti a quello indicato (0 = sarà il prossimo); null se non è in coda. */
  queuePosition(id: number): number | null {
    const index = this.queue.findIndex((q) => q.id === id);
    return index < 0 ? null : index + (this.running ? 1 : 0);
  }

  /** C'è già un lavoro di questo tipo in coda o in corso per la traccia? */
  hasActive(kind: JobKind, audioId: number): boolean {
    return [...this.queue, ...(this.running ? [this.running] : [])].some((q) => q.spec.kind === kind && q.spec.audioId === audioId);
  }

  activeCount(userId: number): number {
    return [...this.queue, ...(this.running ? [this.running] : [])].filter((q) => q.spec.userId === userId).length;
  }

  enqueue(spec: JobSpec): Job {
    if (this.closed) throw new Error('Server in arresto');
    const { lastInsertRowid: id } = this.db.run(
      'INSERT INTO jobs (kind, user_id, score_id, audio_id, params) VALUES (?, ?, ?, ?, ?)',
      spec.kind,
      spec.userId,
      spec.scoreId,
      spec.audioId,
      JSON.stringify(spec.params ?? {}),
    );
    this.queue.push({ id, spec });
    const job = this.toJob(this.get(id)!);
    queueMicrotask(() => this.pump());
    return job;
  }

  private pump(): void {
    if (this.running || this.closed) return;
    const next = this.queue.shift();
    if (!next) return;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    const state = { id: next.id, spec: next.spec, child: null as ChildProcess | null, canceled: false, done };
    this.running = state;
    void this.execute(state).finally(() => {
      this.running = null;
      finished();
      this.pump();
    });
  }

  private async execute(state: { id: number; spec: JobSpec; child: ChildProcess | null; canceled: boolean }): Promise<void> {
    const { id, spec } = state;
    const workDir = path.join(this.paths.tmpDir, `job-${id}`);
    const started = Date.now();
    try {
      await fsp.mkdir(workDir, { recursive: true });
      this.db.run(
        "UPDATE jobs SET status = 'running', started_at = ?, progress = 0, message = 'Avvio…' WHERE id = ?",
        new Date().toISOString(),
        id,
      );
      const { command, params } = spec.command(workDir);
      let lastWrite = 0;
      const output = await this.exec(command, params, {
        timeoutMs: this.config.workerTimeoutMin * 60_000,
        onSpawn: (child) => {
          state.child = child;
        },
        onProgress: (progress, message) => {
          const now = Date.now();
          if (now - lastWrite < PROGRESS_WRITE_MS) return;
          lastWrite = now;
          this.db.run('UPDATE jobs SET progress = ?, message = ? WHERE id = ?', progress, message, id);
        },
      });
      if (state.canceled) throw new WorkerFailure('Annullato');
      const result = await spec.finish(output, workDir);
      this.db.run(
        "UPDATE jobs SET status = 'done', progress = 1, message = NULL, result = ?, finished_at = ? WHERE id = ?",
        JSON.stringify(result ?? null),
        new Date().toISOString(),
        id,
      );
      this.log.info(`Lavoro ${id} (${spec.kind}) completato in ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (err) {
      const message = err instanceof WorkerFailure ? err.message : `Errore interno: ${(err as Error).message}`;
      this.db.run(
        'UPDATE jobs SET status = ?, error = ?, message = NULL, finished_at = ? WHERE id = ?',
        state.canceled ? 'canceled' : 'error',
        state.canceled ? null : message,
        new Date().toISOString(),
        id,
      );
      if (!state.canceled) this.log.warn(`Lavoro ${id} (${spec.kind}) non riuscito: ${message}`);
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  /** Annulla un lavoro in coda o in corso. */
  cancel(id: number): boolean {
    const index = this.queue.findIndex((q) => q.id === id);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.db.run("UPDATE jobs SET status = 'canceled', finished_at = ? WHERE id = ?", new Date().toISOString(), id);
      return true;
    }
    if (this.running?.id === id) {
      this.running.canceled = true;
      terminate(this.running.child);
      return true;
    }
    return false;
  }

  /** Annulla i lavori che riguardano le tracce indicate (es. prima di eliminarle). */
  cancelForAudio(audioIds: number[]): void {
    const ids = new Set(audioIds);
    for (const q of [...this.queue, ...(this.running ? [this.running] : [])]) {
      if (q.spec.audioId !== null && ids.has(q.spec.audioId)) this.cancel(q.id);
    }
  }

  /** Attende la fine del lavoro in corso (senza avviarne altri). */
  async idle(): Promise<void> {
    while (this.running) await this.running.done;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const q of this.queue.splice(0)) {
      this.db.run("UPDATE jobs SET status = 'canceled', finished_at = ? WHERE id = ?", new Date().toISOString(), q.id);
    }
    if (this.running) {
      this.running.canceled = true;
      terminate(this.running.child);
      await this.running.done;
    }
  }
}
