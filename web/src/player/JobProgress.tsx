import type { Job } from '../../../shared/types';

function remaining(job: Job): string | null {
  if (job.status !== 'running' || !job.startedAt || job.progress < 0.05) return null;
  const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
  const left = (elapsed * (1 - job.progress)) / job.progress;
  if (!Number.isFinite(left) || left < 5) return null;
  return left < 90 ? `ancora ${Math.round(left / 5) * 5} s circa` : `ancora ${Math.round(left / 60)} min circa`;
}

/** Avanzamento di un lavoro del worker, con stima del tempo rimanente. */
export function JobProgress({ job, onCancel }: { job: Job; onCancel?: () => void }) {
  const queued = job.status === 'queued';
  const eta = remaining(job);
  const label = queued
    ? job.queuePosition
      ? `In coda: ${job.queuePosition} ${job.queuePosition === 1 ? 'lavoro' : 'lavori'} prima di questo`
      : 'In coda…'
    : (job.message ?? 'In corso…');
  return (
    <div className="job-progress" role="status">
      <div className="job-progress-row">
        <span className="spinner" aria-hidden />
        <span className="small">{label}</span>
        <span className="spacer" />
        {!queued && (
          <span className="small muted">
            {Math.round(job.progress * 100)}%{eta ? ` · ${eta}` : ''}
          </span>
        )}
        {onCancel && (
          <button className="link small" onClick={onCancel}>
            Annulla
          </button>
        )}
      </div>
      <progress value={queued ? undefined : job.progress} max={1} />
    </div>
  );
}
