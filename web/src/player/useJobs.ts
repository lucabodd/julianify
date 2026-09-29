import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioVariant, AutoSyncRequest, Job, JobStatus } from '../../../shared/types';
import { api } from '../api';
import { notifyError } from '../components/toast';

const ACTIVE: ReadonlySet<JobStatus> = new Set(['queued', 'running']);

export const isJobActive = (job: Job): boolean => ACTIVE.has(job.status);

export interface JobsState {
  /** Lavori recenti dell'utente su questo spartito (più recenti prima). */
  jobs: Job[];
  startStems: (audioId: number, variants: AudioVariant[]) => Promise<Job | null>;
  startAutoSync: (audioId: number, request: AutoSyncRequest) => Promise<Job | null>;
  cancel: (id: number) => Promise<void>;
  /** Toglie un lavoro concluso dall'elenco. */
  dismiss: (id: number) => Promise<void>;
}

/**
 * Lavori del worker (separazione strumenti, sincronizzazione automatica) sullo
 * spartito: li carica, ne segue l'avanzamento finché sono attivi e avvisa
 * quando uno termina.
 */
export function useJobs(scoreId: number, onFinished: (job: Job) => void): JobsState {
  const [jobs, setJobs] = useState<Job[]>([]);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const statuses = useRef(new Map<number, JobStatus>());

  const dismiss = useCallback(async (id: number) => {
    setJobs((list) => list.filter((j) => j.id !== id));
    await api.deleteJob(id).catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    const list = await api.listScoreJobs(scoreId).catch(() => null);
    if (!list) return;
    const ended: Job[] = [];
    for (const job of list) {
      const before = statuses.current.get(job.id);
      statuses.current.set(job.id, job.status);
      if (before && ACTIVE.has(before) && !ACTIVE.has(job.status)) ended.push(job);
    }
    // separazioni riuscite e lavori annullati non hanno altro da mostrare
    const hidden = new Set(
      list.filter((j) => j.status === 'canceled' || (j.kind === 'stems' && j.status === 'done')).map((j) => j.id),
    );
    setJobs(list.filter((j) => !hidden.has(j.id)));
    for (const job of ended) finished.current(job);
    for (const id of hidden) void api.deleteJob(id).catch(() => undefined);
  }, [scoreId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = jobs.some(isJobActive);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const track = useCallback((job: Job) => {
    statuses.current.set(job.id, job.status);
    setJobs((list) => [job, ...list.filter((j) => j.id !== job.id)]);
    return job;
  }, []);

  const startStems = useCallback(
    (audioId: number, variants: AudioVariant[]) =>
      api.startStems(audioId, variants).then(track, (err) => {
        notifyError(err);
        return null;
      }),
    [track],
  );

  const startAutoSync = useCallback(
    (audioId: number, request: AutoSyncRequest) =>
      api.startAutoSync(audioId, request).then(track, (err) => {
        notifyError(err);
        return null;
      }),
    [track],
  );

  const cancel = useCallback(
    async (id: number) => {
      try {
        await api.deleteJob(id);
        await refresh();
      } catch (err) {
        notifyError(err);
      }
    },
    [refresh],
  );

  return { jobs, startStems, startAutoSync, cancel, dismiss };
}
